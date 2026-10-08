import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:notato/notato.dart';
import 'package:notato/src/runtime.dart';

import 'harness.dart';

void main() {
  testWidgets('sends a note with its screenshots, and lets go of them once the server has it', (tester) async {
    final server = FakeServer();
    await tester.pumpWidget(app(server, screenshots: true));
    await settle(tester);
    server.hello();
    await settle(tester);
    final made = await drive(tester, notato.annotate('#add-to-basket', 'With pictures'));
    await settle(tester);
    final id = made['id'] as String;
    expect(server.files, ['asset:$id-full', 'asset:$id-crop']);
    expect((server.sent.single['screenshots'] as Map).keys, ['full', 'crop']);
    expect(notato.pendingCount, 0);
    await unmount(tester);
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
    runtime.retryConnection();
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
    await unmount(tester);
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
    await unmount(tester);
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
    await unmount(tester);
  });

  testWidgets("applies a burst of the server's changes together", (tester) async {
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
    await unmount(tester);
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
      await drive(tester, runtime.delete(id));
      runtime.saveSettings(name: '', screenshots: true, server: 'http://localhost:4798');
      server.hold!.complete();
      await drive(tester, making);
      await settle(tester);
      expect(server.calls, contains('DELETE /annotations/$id'));
      await unmount(tester);
    },
  );
}
