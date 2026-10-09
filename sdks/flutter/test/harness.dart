import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:notato/notato.dart';

import 'shop.dart';

/// A Notato server for the widget: takes notes, lists what it has, and streams events the test sends.
class FakeServer {
  final sent = <Map<String, Object?>>[];
  final files = <String>[];
  final calls = <String>[];
  final relayed = <Map<String, Object?>>[];
  final bundles = <List<int>>[];
  final events = StreamController<String>.broadcast();

  /// Notes are answered with this status and [failMessage] instead of being taken.
  int? failWith;
  String failMessage = 'nope';

  /// Nothing can be reached.
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
    if (offline) throw const Unreachable();
    if (path.endsWith('/events')) {
      return http.StreamedResponse(events.stream.map(utf8.encode), 200, headers: {'content-type': 'text/event-stream'});
    }
    http.Response response;
    if (request.method == 'POST' && path.endsWith('/annotations')) {
      if (notesOffline) throw const Unreachable();
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

  /// Sends an event down the stream the app follows.
  void send(String event, Object data) => events.add('event: $event\ndata: ${jsonEncode(data)}\n\n');

  /// What the server says first on the stream, with an agent connected.
  void hello() => send('hello', {
    'projectId': 'shop',
    'agent': {
      'connected': true,
      'names': ['Claude'],
    },
  });
}

/// What a client throws when the server cannot be reached.
class Unreachable implements Exception {
  const Unreachable();
  @override
  String toString() => 'connection refused';
}

/// The test app in Notato, talking to [server], on the `catalogue` screen unless [route] says another.
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
  StackTrace? stack;
  unawaited(
    future.then(
      (v) {
        value = v;
        done = true;
      },
      onError: (Object e, StackTrace s) {
        error = e;
        stack = s;
        done = true;
      },
    ),
  );
  for (var i = 0; i < 200 && !done; i++) {
    await tester.pump(const Duration(milliseconds: 16));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
  }
  if (!done) throw StateError('timed out');
  if (error != null) Error.throwWithStackTrace(error!, stack!);
  return value as T;
}

/// Lets Notato catch up: the frames its pieces take to come and go, and the timers and network calls they start.
Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 18; i++) {
    await tester.pump(const Duration(milliseconds: 20));
  }
}

/// Takes the app away at the end of a test, so Notato stops and the next test starts it afresh.
Future<void> unmount(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await settle(tester);
}
