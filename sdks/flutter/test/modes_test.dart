import 'dart:convert';

import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:notato/notato.dart';
import 'package:notato/src/runtime.dart';

import 'harness.dart';
import 'helpers.dart';

void main() {
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

    await drive(tester, runtime.setPeopleOnly(made['id'] as String, true));
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

    runtime.clearLocal();
    expect(notato.notes, isEmpty);
    await unmount(tester);
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
    await settle(tester);
    expect(server.sent.single['author'], {'kind': 'agent', 'name': 'Claude'});
    expect(server.relayed.single, {'ok': true, 'annotationId': server.sent.single['id']});

    server.send('annotate-request', {
      'requestId': 'q2',
      'args': {'target': '#missing', 'comment': 'x'},
    });
    await settle(tester);
    expect(server.relayed.last, {'ok': false, 'error': 'Nothing on this screen matches "#missing".'});
    await unmount(tester);
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
    await settle(tester);
    // One after the other: the second was numbered after the first was made.
    expect([for (final a in server.sent) ((a['context'] as Map)['screenshot'] as Map)['pin']], [1, 2]);
    expect(server.relayed.map((r) => r['ok']), [true, true]);

    server.notesOffline = true;
    server.send('annotate-request', {
      'requestId': 'q3',
      'args': {'target': '#add-to-basket', 'comment': 'Not sent'},
    });
    await settle(tester);
    expect(server.relayed.last, {
      'ok': false,
      'error':
          'The note was made on the device but not sent: the server could not be reached. '
          'It is sent again on the next connection.',
    });
    expect(notato.pendingCount, 1);
    await unmount(tester);
  });
}
