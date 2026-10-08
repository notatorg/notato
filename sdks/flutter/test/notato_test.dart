import 'dart:async';
import 'dart:convert';

import 'package:archive/archive.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:notato/notato.dart';
import 'package:notato/src/capture.dart';
import 'package:notato/src/selectors.dart';
import 'package:notato/src/serial.dart';
import 'package:notato/src/tree.dart';
import 'package:notato/src/ui/sheets.dart';

import 'helpers.dart';
import 'shop.dart';

/// A Notato server for the widget: takes notes, lists what it has, and streams events the test sends.
class FakeServer {
  final sent = <Map<String, Object?>>[];
  final files = <String>[];
  final calls = <String>[];
  final relayed = <Map<String, Object?>>[];
  final bundles = <List<int>>[];
  final events = StreamController<String>.broadcast();
  int? failWith;
  String failMessage = 'nope';
  var offline = false;

  /// Notes cannot be sent (the rest still answers).
  var notesOffline = false;

  /// Notes are taken, and answered with something that is not a note.
  var garble = false;

  /// While set, a note sent waits for it before it is taken.
  Completer<void>? hold;

  http.Client client() => MockClient.streaming((request, bodyStream) async {
    final body = await bodyStream.toBytes();
    final path = request.url.path;
    calls.add('${request.method} $path');
    if (offline) throw const SocketExceptionLike('connection refused');
    if (path.endsWith('/events')) {
      return http.StreamedResponse(events.stream.map(utf8.encode), 200, headers: {'content-type': 'text/event-stream'});
    }
    http.Response response;
    if (request.method == 'POST' && path.endsWith('/annotations')) {
      if (notesOffline) throw const SocketExceptionLike('connection refused');
      await hold?.future;
      if (garble) {
        response = http.Response('{"seq":1,"annotation":"not a note"}', 201);
      } else if (failWith != null) {
        response = http.Response(jsonEncode({'error': failMessage}), failWith!);
      } else {
        final text = latin1.decode(body);
        final start = text.indexOf('name="annotation"');
        final json = text.substring(text.indexOf('\r\n\r\n', start) + 4, text.indexOf('\r\n--', start));
        final annotation = (jsonDecode(utf8.decode(latin1.encode(json))) as Map).cast<String, Object?>();
        sent.add(annotation);
        files.addAll(RegExp(r'name="(asset:[^"]+)"').allMatches(text).map((m) => m.group(1)!));
        response = http.Response(jsonEncode({'seq': sent.length, 'annotation': annotation}), 201);
      }
    } else if (request.method == 'GET' && path.endsWith('/annotations')) {
      response = http.Response(
        jsonEncode({
          'items': [
            for (final (i, a) in sent.indexed) {'seq': i + 1, 'annotation': a},
          ],
        }),
        200,
      );
    } else if (path == '/config') {
      response = http.Response('{"screenshots":true}', 200);
    } else if (path.startsWith('/relay/')) {
      relayed.add((jsonDecode(utf8.decode(body)) as Map).cast<String, Object?>());
      response = http.Response('{}', 200);
    } else if (path.endsWith('/bundles')) {
      bundles.add(body);
      response = http.Response('{"bundleId":"b1","imported":1}', 201);
    } else {
      response = http.Response('{"error":"not here"}', 404);
    }
    return http.StreamedResponse(Stream.value(response.bodyBytes), response.statusCode);
  });

  void send(String event, Object data) => events.add('event: $event\ndata: ${jsonEncode(data)}\n\n');
  void hello() => send('hello', {
    'projectId': 'shop',
    'agent': {
      'connected': true,
      'names': ['Claude'],
    },
  });
}

class SocketExceptionLike implements Exception {
  const SocketExceptionLike(this.message);
  final String message;
  @override
  String toString() => message;
}

Widget app(
  FakeServer server, {
  NotatoMode mode = NotatoMode.dev,
  String? serverUrl,
  bool screenshots = false,
  Widget? home,
  String Function()? route,
}) => Notato(
  project: 'shop',
  appName: 'Spud Shop',
  mode: mode,
  server: serverUrl,
  route: route ?? () => 'catalogue',
  screenshots: screenshots,
  captureLogs: false,
  storage: (_) async => MemoryStorage(),
  httpClient: server.client,
  child: MaterialApp(home: home ?? const ProductList()),
);

/// Waits for something Notato does that needs frames (an outline drawn) and real time (a screenshot taken) both.
Future<T> drive<T>(WidgetTester tester, Future<T> future) async {
  var done = false;
  T? value;
  Object? error;
  future.then(
    (v) {
      value = v;
      done = true;
    },
    onError: (Object e) {
      error = e;
      done = true;
    },
  );
  for (var i = 0; i < 200 && !done; i++) {
    await tester.pump(const Duration(milliseconds: 16));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
  }
  if (!done) throw StateError('timed out');
  if (error != null) throw error!;
  return value as T;
}

Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 20));
  }
}

void main() {
  testWidgets('annotating a widget sends a note with the widget, its component and where it is written', (
    tester,
  ) async {
    final server = FakeServer();
    await tester.pumpWidget(app(server));
    await settle(tester);
    server.hello();
    await settle(tester);
    expect(notato.connection, NotatoConnection.connected);
    expect(notato.agents, ['Claude']);

    await tester.tap(find.text('Annotate'));
    await tester.pump();
    expect(find.text('Tap what you want to comment on'), findsOneWidget);

    await tester.tapAt(tester.getCenter(find.text('Add to basket')));
    await settle(tester);
    expect(find.text('ProductCard › Text'), findsOneWidget);
    // The keyboard opens for the note, without a tap on the field.
    expect(tester.testTextInput.isVisible, isTrue);

    await tester.enterText(find.byKey(const ValueKey('NotatoComment')), 'Is this per kilo?');
    await tester.tap(find.text('Question'));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('NotatoSend')));
    await settle(tester);

    expect(server.sent, hasLength(1));
    final note = server.sent.single;
    expect(note['route'], '/catalogue');
    expect(note['comment'], 'Is this per kilo?');
    expect(note['intent'], 'question');
    final identity = ((note['target'] as Map)['identity'] as List).single as Map;
    expect(identity['selector'], 'ProductCard > ElevatedButton#add-to-basket > Text');
    // Only the button has the key: `#add-to-basket` finds it once per card.
    final root = tester.element(find.byType(MaterialApp));
    expect(query(elementsUnder(root), '#add-to-basket').map((e) => e.tag), ['ElevatedButton']);
    expect((identity['component'] as Map)['path'], ['ProductList', 'ProductCard']);
    expect(find.text('Sent'), findsOneWidget);
    expect(notato.notes.single.pending, isFalse);
    final result = await tester.runAsync(() => validate('annotation', note));
    if (result != null) expect(result.ok, isTrue, reason: result.output);

    // The agent's reply arrives live, and the pin's card shows it.
    server.send('updated', {
      'annotation': {
        ...note,
        'status': 'acknowledged',
        'thread': [
          {
            'id': 'r1',
            'author': {'kind': 'agent', 'name': 'Claude'},
            'body': 'On it',
            'createdAt': '2026-10-08T10:00:00Z',
          },
        ],
      },
    });
    await settle(tester);
    expect(notato.notes.single.status, 'acknowledged');
    await tester.tap(find.bySemanticsLabel(RegExp('Note 1')));
    await settle(tester);
    expect(find.text('Note 1'), findsOneWidget);
    expect(find.textContaining('On it'), findsOneWidget);

    await tester.pumpWidget(const SizedBox());
    await settle(tester);
  });

  testWidgets('keeps a note made offline, and sends it when the server says hello', (tester) async {
    final server = FakeServer()..offline = true;
    await tester.pumpWidget(app(server));
    await settle(tester);
    final made = await drive(tester, notato.annotate('#add-to-basket', 'Offline note', screenshot: false));
    await settle(tester);
    expect(notato.notes.single.annotation['id'], made['id']);
    expect(notato.pendingCount, 1);
    server.offline = false;
    notato.retryConnection();
    await settle(tester);
    server.calls.clear();
    server.hello();
    await settle(tester);
    expect(server.sent.single['comment'], 'Offline note');
    expect(notato.pendingCount, 0);
    // Sent before the list was read, so the list has it.
    expect(server.calls.where((c) => c.endsWith('/annotations')), [
      'POST /projects/shop/annotations',
      'GET /projects/shop/annotations',
    ]);
    await tester.pumpWidget(const SizedBox());
    await settle(tester);
  });

  testWidgets('marks a note the server refuses for good as failed, and holds the queue for an unknown project', (
    tester,
  ) async {
    final server = FakeServer()..failWith = 413;
    await tester.pumpWidget(app(server));
    await settle(tester);
    server.hello();
    await settle(tester);
    await drive(tester, notato.annotate('#add-to-basket', 'Too big', screenshot: false));
    await settle(tester);
    expect(notato.notes.single.failed, 'nope');
    server
      ..failWith = 404
      ..failMessage = 'unknown project';
    await drive(tester, notato.annotate('#add-to-basket', 'Waits', screenshot: false));
    await settle(tester);
    expect(notato.notes.last.waiting, 'unknown project');
    expect(notato.pendingCount, 2);
    await tester.pumpWidget(const SizedBox());
    await settle(tester);
  });

  testWidgets('test mode keeps notes on the device, records People only in the thread, and packages a bundle', (
    tester,
  ) async {
    final server = FakeServer();
    await tester.pumpWidget(app(server, mode: NotatoMode.test, serverUrl: 'http://localhost:4799', screenshots: true));
    await settle(tester);
    expect(notato.connection, NotatoConnection.local);
    final made = await drive(tester, notato.annotate('#add-to-basket', 'Wrong colour', severity: 'major'));
    await settle(tester);
    expect(server.sent, isEmpty);
    expect(notato.pendingCount, 1);
    expect(made['mode'], 'test');

    await drive(tester, notato.setPeopleOnly(made['id'] as String, true));
    final kept = notato.notes.single.annotation;
    expect(kept['peopleOnly'], isTrue);
    expect((kept['thread'] as List).single, containsPair('body', "Made this people only: the agent won't see it."));

    final package = await drive(tester, notato.packageNotes());
    expect(package.uploaded, isTrue);
    expect(server.bundles, hasLength(1));
    final archive = ZipDecoder().decodeBytes(package.zip);
    expect(archive.files.map((f) => f.name), containsAll(['annotations.json', 'feedback.md', 'shots/01-full.png']));
    final bundle = jsonDecode(utf8.decode(archive.findFile('annotations.json')!.content as List<int>));
    expect(((bundle as Map)['annotations'] as List).single, containsPair('severity', 'major'));
    final result = await tester.runAsync(() => validate('bundle', bundle));
    if (result != null) expect(result.ok, isTrue, reason: result.output);

    notato.clearLocal();
    expect(notato.notes, isEmpty);
    await tester.pumpWidget(const SizedBox());
    await settle(tester);
  });

  testWidgets('agent mode files an annotate request as the agent, and reports what it found', (tester) async {
    final server = FakeServer();
    await tester.pumpWidget(app(server, mode: NotatoMode.agent));
    await settle(tester);
    expect(server.calls, contains('GET /projects/shop/events'));
    server.hello();
    await settle(tester);
    server.send('annotate-request', {
      'requestId': 'q1',
      'args': {'target': 'ProductCard > #add-to-basket', 'comment': 'Too small', 'author': 'Claude'},
    });
    await drive(tester, Future<void>.delayed(const Duration(milliseconds: 400)));
    expect(server.sent.single['author'], {'kind': 'agent', 'name': 'Claude'});
    expect(server.relayed.single, {'ok': true, 'annotationId': server.sent.single['id']});

    server.send('annotate-request', {
      'requestId': 'q2',
      'args': {'target': '#missing', 'comment': 'x'},
    });
    await drive(tester, Future<void>.delayed(const Duration(milliseconds: 400)));
    expect(server.relayed.last, {'ok': false, 'error': 'Nothing on this screen matches "#missing".'});
    await tester.pumpWidget(const SizedBox());
    await settle(tester);
  });

  testWidgets('keeps private text out of notes and covers it, fields too in test mode', (tester) async {
    final server = FakeServer();
    final secret = GlobalKey();
    await tester.pumpWidget(
      app(
        server,
        mode: NotatoMode.test,
        home: Scaffold(
          body: Column(
            children: [
              NotatoMask(child: Text('ada@example.com', key: secret)),
              const TextField(
                key: ValueKey('name'),
                decoration: InputDecoration(hintText: 'Name'),
              ),
              const NotatoMask(
                private: false,
                child: TextField(
                  key: ValueKey('search'),
                  decoration: InputDecoration(hintText: 'Search'),
                ),
              ),
              const TextField(key: ValueKey('password'), obscureText: true),
              const Text('Hello Ada', key: ValueKey('greeting')),
            ],
          ),
        ),
      ),
    );
    await settle(tester);
    await tester.enterText(find.byKey(const ValueKey('name')), 'Ada Lovelace');
    await tester.enterText(find.byKey(const ValueKey('search')), 'spuds');
    await tester.pump();

    final root = tester.element(find.byType(MaterialApp));
    final elements = elementsUnder(root, maskInputs: true);
    TreeElement byKey(String key) => elements.firstWhere((e) => e.testId == key);
    TreeElement byWidgetKey(Key key) => elements.firstWhere((e) => e.picked.element.widget.key == key);
    final email = byWidgetKey(secret);
    expect(email.text, isNull);
    expect(email.picked.private, isTrue);
    expect(byKey('greeting').text, 'Hello Ada');
    expect(byKey('name').text, isNull);
    expect(byKey('name').label, isNull);
    expect(byKey('search').text, 'spuds');
    // A password field is private: no text, and not its key either.
    final password = byWidgetKey(const ValueKey('password'));
    expect(password.text, isNull);
    expect(password.testId, isNull);
    expect(password.picked.identity['testId'], isNull);
    // A selector cannot find it by its text.
    Object? error;
    try {
      await drive(tester, notato.annotate(':text("ada@example.com")', 'x'));
    } catch (e) {
      error = e;
    }
    expect(error, isA<NotatoException>());

    final covers = coversUnder(tester.renderObject(find.byType(MaterialApp)), maskInputs: true);
    // The email, the name field and the password field; not the search field.
    expect(covers, hasLength(3));
    await tester.pumpWidget(const SizedBox());
    await settle(tester);
  });

  testWidgets('Parent selects the widget around the one tapped', (tester) async {
    final server = FakeServer();
    await tester.pumpWidget(app(server));
    await settle(tester);
    await tester.tap(find.text('Annotate'));
    await tester.pump();
    await tester.tapAt(tester.getCenter(find.text('Maris Piper')));
    await settle(tester);
    expect(find.text('ProductCard › Text'), findsOneWidget);
    await tester.tap(find.text('Parent'));
    await settle(tester);
    expect(find.text('ProductCard › Column'), findsOneWidget);
    await tester.tap(find.bySemanticsLabel('Cancel'));
    await settle(tester);
    expect(notato.isAnnotating, isFalse);
    await tester.pumpWidget(const SizedBox());
    await settle(tester);
  });

  testWidgets('switches off and on at runtime without rebuilding the app, and remembers the choice', (tester) async {
    final server = FakeServer();
    await tester.pumpWidget(app(server));
    await settle(tester);
    final element = tester.element(find.byType(ProductList));
    notato.disable();
    await settle(tester);
    expect(find.text('Annotate'), findsNothing);
    notato.enable();
    await settle(tester);
    expect(find.text('Annotate'), findsOneWidget);
    expect(tester.element(find.byType(ProductList)), same(element));
    notato.hideToolbar();
    await settle(tester);
    expect(find.text('Annotate'), findsNothing);
    notato.resetRuntimeState();
    await settle(tester);
    expect(find.text('Annotate'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await settle(tester);
  });

  testWidgets('takes nothing from the app when it is off', (tester) async {
    await tester.pumpWidget(
      Notato(
        project: 'shop',
        enabled: false,
        storage: (_) async => MemoryStorage(),
        child: const MaterialApp(home: ProductList()),
      ),
    );
    await settle(tester);
    expect(find.text('Annotate'), findsNothing);
    expect(find.byType(ProductCard), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await settle(tester);
  });

  testWidgets('photographs the app, and a part of it', (tester) async {
    final key = GlobalKey();
    await tester.pumpWidget(
      RepaintBoundary(
        key: key,
        child: const MaterialApp(home: ProductList()),
      ),
    );
    final boundary = tester.renderObject<RenderRepaintBoundary>(find.byKey(key));
    final image = await tester.runAsync(() => grab(boundary, 2));
    expect(image, isNotNull);
    final full = await tester.runAsync(() => pngOf(image!, 'full'));
    final crop = await tester.runAsync(() => pngOf(image!, 'crop', crop: const Rect.fromLTWH(10, 20, 100, 50)));
    expect([full!.width, full.height], [image!.width, image.height]);
    expect([crop!.width, crop.height], [100, 50]);
    // PNG files start with this signature.
    expect(full.bytes.take(4), [0x89, 0x50, 0x4E, 0x47]);
    image.dispose();
  });

  test('numbers pins per screen and keeps up with ten thousand notes', () {
    final controller = NotatoController();
    final records = [
      for (var i = 0; i < 10000; i++)
        NoteRecord({
          'id': 'n${i.toString().padLeft(5, '0')}',
          'route': '/screen-${i % 50}',
          'createdAt': DateTime.utc(2026, 10, 8).add(Duration(seconds: i)).toIso8601String(),
        }),
    ];
    // Test-only: the records as the server's list would leave them.
    controller.debugSetRecords(records);
    final watch = Stopwatch()..start();
    final here = controller.notesOn('/screen-7');
    expect(here, hasLength(200));
    expect([for (final n in here) n.number], [for (var i = 1; i <= 200; i++) i]);
    expect(controller.nextPin('screen-7'), 201);
    expect(watch.elapsedMilliseconds, lessThan(500));
  });

  testWidgets('a Notato that takes the place of another leaves Notato on', (tester) async {
    final server = FakeServer();
    await tester.pumpWidget(KeyedSubtree(key: const ValueKey(1), child: app(server)));
    await settle(tester);
    expect(notato.isEnabled, isTrue);
    // A new one, with the same options: Flutter mounts it before it disposes of the old one.
    await tester.pumpWidget(KeyedSubtree(key: const ValueKey(2), child: app(server)));
    await settle(tester);
    expect(notato.isEnabled, isTrue);
    expect(find.text('Annotate'), findsOneWidget);
    server.hello();
    await settle(tester);
    final made = await drive(tester, notato.annotate('#add-to-basket', 'After the remount', screenshot: false));
    await settle(tester);
    expect(server.sent.single['id'], made['id']);
    await tester.pumpWidget(const SizedBox());
    await settle(tester);
    expect(notato.isEnabled, isFalse);
  });

  testWidgets('photographs two notes made at once, covered, and takes the covers off after', (tester) async {
    final server = FakeServer();
    await tester.pumpWidget(
      app(
        server,
        mode: NotatoMode.test,
        screenshots: true,
        home: const Scaffold(
          body: Column(
            children: [
              NotatoMask(child: Text('ada@example.com')),
              Text('Hello Ada', key: ValueKey('greeting')),
            ],
          ),
        ),
      ),
    );
    await settle(tester);
    final covers = find.byWidgetPredicate(
      (w) =>
          w is DecoratedBox &&
          w.decoration is BoxDecoration &&
          (w.decoration as BoxDecoration).color == const Color(0xFF8B8F97),
    );
    var done = 0;
    for (final comment in ['One', 'Two']) {
      unawaited(notato.annotate('#greeting', comment).then((_) => done++));
    }
    final seen = <bool>[];
    for (var i = 0; i < 200 && done < 2; i++) {
      await tester.pump(const Duration(milliseconds: 16));
      seen.add(covers.evaluate().isNotEmpty);
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
    }
    expect(done, 2);
    expect(notato.notes.map((n) => n.annotation['screenshots']), everyElement(isNotNull));
    // On from the first screenshot to the last, without a gap, and off after.
    final first = seen.indexOf(true);
    final last = seen.lastIndexOf(true);
    expect(first, greaterThanOrEqualTo(0));
    expect(seen.sublist(first, last + 1), everyElement(isTrue));
    await settle(tester);
    expect(covers, findsNothing);
    await tester.pumpWidget(const SizedBox());
    await settle(tester);
  });

  testWidgets('answers the agent one request at a time, and says when a note is not filed', (tester) async {
    final server = FakeServer();
    await tester.pumpWidget(app(server, mode: NotatoMode.agent));
    await settle(tester);
    server.hello();
    await settle(tester);
    for (final id in ['q1', 'q2']) {
      server.send('annotate-request', {
        'requestId': id,
        'args': {'target': '#add-to-basket', 'comment': 'Request $id'},
      });
    }
    await drive(tester, Future<void>.delayed(const Duration(milliseconds: 600)));
    // One after the other: the second was numbered after the first was made.
    expect([for (final a in server.sent) ((a['context'] as Map)['screenshot'] as Map)['pin']], [1, 2]);
    expect(server.relayed.map((r) => r['ok']), [true, true]);

    server.notesOffline = true;
    server.send('annotate-request', {
      'requestId': 'q3',
      'args': {'target': '#add-to-basket', 'comment': 'Not sent'},
    });
    await drive(tester, Future<void>.delayed(const Duration(milliseconds: 400)));
    expect(server.relayed.last, {
      'ok': false,
      'error':
          'The note was made on the device but not sent: the server could not be reached. '
          'It is sent again on the next connection.',
    });
    expect(notato.pendingCount, 1);
    await tester.pumpWidget(const SizedBox());
    await settle(tester);
  });

  testWidgets('keeps a note the server answered with something that is not a note, to send again', (tester) async {
    final server = FakeServer()..garble = true;
    await tester.pumpWidget(app(server));
    await settle(tester);
    server.hello();
    await settle(tester);
    await drive(tester, notato.annotate('#add-to-basket', 'Garbled', screenshot: false));
    await settle(tester);
    expect(notato.notes.single.pending, isTrue);
    expect(notato.pendingCount, 1);
    await tester.pumpWidget(const SizedBox());
    await settle(tester);
  });

  testWidgets('applies a burst of the server\'s changes together', (tester) async {
    final server = FakeServer();
    await tester.pumpWidget(app(server));
    await settle(tester);
    server.hello();
    await settle(tester);
    final made = await drive(tester, notato.annotate('#add-to-basket', 'Note', screenshot: false));
    await settle(tester);
    var changes = 0;
    void count() => changes++;
    notato.addListener(count);
    for (var i = 0; i < 50; i++) {
      server.send('updated', {
        'annotation': {...made, 'status': 'acknowledged'},
      });
    }
    await settle(tester);
    notato.removeListener(count);
    expect(changes, 1);
    expect(notato.notes.single.status, 'acknowledged');
    await tester.pumpWidget(const SizedBox());
    await settle(tester);
  });

  testWidgets('notices a move to another screen when nothing of Notato\'s is redrawn', (tester) async {
    final server = FakeServer();
    var screen = 'catalogue';
    await tester.pumpWidget(app(server, route: () => screen));
    await settle(tester);
    // A note on the basket screen, as the server's list would leave it (it says nothing to the overlay).
    notato.debugSetRecords([
      NoteRecord({
        'id': 'b1',
        'route': '/basket',
        'createdAt': '2026-10-08T10:00:00Z',
        'status': 'open',
        'comment': 'On the basket',
        'environment': {'platform': 'flutter'},
        'target': {
          'rect': {'x': 0, 'y': 0, 'w': 10, 'h': 10},
          'identity': [
            {'selector': 'ProductCard > Text', 'text': 'Maris Piper'},
          ],
        },
      }),
    ]);
    await settle(tester);
    expect(find.bySemanticsLabel(RegExp('Note 1')), findsNothing);
    screen = 'basket';
    await tester.pump(const Duration(milliseconds: 600));
    await settle(tester);
    expect(find.bySemanticsLabel(RegExp('Note 1')), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await settle(tester);
  });

  testWidgets('the Notes list has every note on the screen, newest first', (tester) async {
    final server = FakeServer();
    await tester.pumpWidget(app(server));
    await settle(tester);
    notato.debugSetRecords([
      for (var i = 0; i < 80; i++)
        NoteRecord({
          'id': 'n${i.toString().padLeft(2, '0')}',
          'route': '/catalogue',
          'createdAt': DateTime.utc(2026, 10, 8, 10, 0, i).toIso8601String(),
          'status': 'open',
          'comment': 'Note $i',
          'environment': {'platform': 'web'},
        }),
    ]);
    await tester.tap(find.bySemanticsLabel('Notato menu'));
    await settle(tester);
    // Notes from the web have no pins here, and are in the list all the same.
    expect(find.text('No pins on this screen'), findsOneWidget);
    await tester.tap(find.text('Notes'));
    await settle(tester);
    expect(find.text('80 on this screen · 80 in all'), findsOneWidget);
    expect(tester.getTopLeft(find.text('Note 79')).dy, lessThan(tester.getTopLeft(find.text('Note 78')).dy));
    // Only the rows in sight are built; the oldest is there to scroll to.
    expect(find.text('Note 0'), findsNothing);
    await tester.scrollUntilVisible(
      find.text('Note 0'),
      400,
      scrollable: find.descendant(of: find.byType(NotesSheet), matching: find.byType(Scrollable)),
    );
    expect(find.text('Note 0'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await settle(tester);
  });

  testWidgets('long-pressing in a Notato text field shows the text menu on iOS', (tester) async {
    final server = FakeServer();
    await tester.pumpWidget(app(server));
    await settle(tester);
    await tester.tap(find.text('Annotate'));
    await tester.pump();
    await tester.tapAt(tester.getCenter(find.text('Add to basket')));
    await settle(tester);
    await tester.enterText(find.byKey(const ValueKey('NotatoComment')), 'Bigger, please');
    await tester.longPress(find.byKey(const ValueKey('NotatoComment')));
    await settle(tester);
    expect(tester.takeException(), isNull);
    expect(find.text('Select All').evaluate().isNotEmpty || find.text('Paste').evaluate().isNotEmpty, isTrue);
    await tester.pumpWidget(const SizedBox());
    await settle(tester);
  }, variant: TargetPlatformVariant.only(TargetPlatform.iOS));

  test('pins only the notes made in a Flutter app; the others keep their numbers in the list', () {
    final controller = NotatoController();
    NoteRecord note(String id, String platform, int second) => NoteRecord({
      'id': id,
      'route': '/catalogue',
      'createdAt': DateTime.utc(2026, 10, 8, 10, 0, second).toIso8601String(),
      'environment': {'platform': platform},
    });
    controller.debugSetRecords([note('a', 'flutter', 1), note('b', 'web', 2), note('c', 'flutter', 3)]);
    expect([for (final n in controller.notesOn('catalogue')) n.record.id], ['a', 'b', 'c']);
    expect([for (final n in controller.pinsOn('catalogue')) (n.number, n.record.id)], [(1, 'a'), (3, 'c')]);
    expect(controller.nextPin('catalogue'), 4);
  });

  test('runs tasks one at a time, and says when the last is done, even when one fails', () async {
    final log = <String>[];
    final serial = Serial(() => log.add('idle'));
    final gates = [Completer<void>(), Completer<void>(), Completer<void>()];
    Future<String> task(int i) async {
      log.add('start $i');
      await gates[i].future;
      log.add('end $i');
      if (i == 1) throw StateError('no');
      return '$i';
    }

    final results = [
      for (var i = 0; i < 3; i++) serial.run(() => task(i)).then((v) => v, onError: (Object _) => 'failed'),
    ];
    await pumpEventQueue();
    expect(log, ['start 0']);
    gates[1].complete();
    await pumpEventQueue();
    expect(log, ['start 0']);
    gates[0].complete();
    await pumpEventQueue();
    expect(log, ['start 0', 'end 0', 'start 1', 'end 1', 'start 2']);
    gates[2].complete();
    expect(await Future.wait(results), ['0', 'failed', '2']);
    expect(log.last, 'idle');
    expect(log.where((l) => l == 'idle'), hasLength(1));
  });

  testWidgets(
    'deletes on the server a note deleted here while it was on its way, even when Notato restarted meanwhile',
    (tester) async {
      final server = FakeServer()..hold = Completer<void>();
      await tester.pumpWidget(app(server));
      await settle(tester);
      server.hello();
      await settle(tester);
      final making = notato.annotate('#add-to-basket', 'Oops', screenshot: false);
      await settle(tester);
      final id = notato.notes.single.id;
      await drive(tester, notato.delete(id));
      notato.saveSettings(name: '', screenshots: true, server: 'http://localhost:4798');
      server.hold!.complete();
      await drive(tester, making);
      await settle(tester);
      expect(server.calls, contains('DELETE /annotations/$id'));
      await tester.pumpWidget(const SizedBox());
      await settle(tester);
    },
  );
}
