import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:notato/notato.dart';
import 'package:notato/src/config.dart';
import 'package:notato/src/logs.dart';
import 'package:notato/src/runtime.dart';

import 'harness.dart';

void main() {
  testWidgets('takes no screenshot until the server has said it takes them', (tester) async {
    final server = FakeServer()..configOffline = true;
    await tester.pumpWidget(app(server, screenshots: true));
    await settle(tester);
    final made = await drive(tester, notato.annotate('#add-to-basket', 'No answer yet'));
    await settle(tester);
    expect(made['screenshots'], isNull);
    expect(runtime.serverScreenshots, isFalse);
    await unmount(tester);
  });

  testWidgets("asks test mode's server too, and leaves screenshots out of a package once it has them off", (
    tester,
  ) async {
    final server = FakeServer();
    await tester.pumpWidget(app(server, mode: NotatoMode.test, serverUrl: 'http://localhost:4799', screenshots: true));
    await settle(tester);
    final first = await drive(tester, notato.annotate('#add-to-basket', 'With a screenshot'));
    await settle(tester);
    expect(first['screenshots'], isNotNull);
    expect(server.calls, contains('GET /config'));

    // The operator turns them off: the package asks again, and follows what it says.
    server.screenshotsOff = true;
    final package = await drive(tester, notato.packageNotes(upload: false));
    final names = ZipDecoder().decodeBytes(package.zip).files.map((f) => f.name).toList();
    expect(names, containsAll(['annotations.json', 'feedback.md']));
    expect(names.where((n) => n.startsWith('shots/')), isEmpty);
    expect(runtime.serverScreenshots, isFalse);
    await unmount(tester);
  });

  testWidgets('a capture-only token sends notes without following the project, and changes none', (tester) async {
    final server = FakeServer()..captureOnly = true;
    await tester.pumpWidget(app(server));
    await settle(tester);
    expect(server.calls, isNot(contains('GET /projects/shop/events')));
    expect(runtime.captureOnly, isTrue);
    expect(notato.connection, NotatoConnection.connected);

    final made = await drive(tester, notato.annotate('#add-to-basket', 'Sent, never read back', screenshot: false));
    await settle(tester);
    final id = made['id'] as String;
    expect(server.sent.single['id'], id);
    expect(notato.pendingCount, 0);
    expect(server.calls, isNot(contains('GET /projects/shop/annotations')));

    // Reading or changing what it sent is the board's.
    for (final change in [() => runtime.reply(id, 'More'), () => runtime.delete(id), () => runtime.cancelRevert(id)]) {
      Object? error;
      try {
        await change();
      } catch (e) {
        error = e;
      }
      expect(error, isA<NotatoException>());
    }
    expect(server.calls.where((c) => !c.endsWith('/config')), ['POST /projects/shop/annotations']);
    expect(notato.notes, hasLength(1));
    await unmount(tester);
  });

  testWidgets('a capture-only token tries the notes that could not go again, and takes a 409 as sent', (tester) async {
    final server = FakeServer()
      ..captureOnly = true
      ..notesOffline = true;
    await tester.pumpWidget(app(server));
    await settle(tester);
    await drive(tester, notato.annotate('#add-to-basket', 'Kept', screenshot: false));
    await settle(tester);
    expect(notato.pendingCount, 1);
    expect(notato.connection, NotatoConnection.offline);

    server.notesOffline = false;
    runtime.retryConnection();
    await settle(tester);
    expect(notato.pendingCount, 0);
    expect(notato.connection, NotatoConnection.connected);

    // The answer to an earlier send was lost: the server says it has the id, and it is there.
    server
      ..failWith = 409
      ..failMessage = 'annotation id already exists';
    await drive(tester, notato.annotate('#add-to-basket', 'Landed before', screenshot: false));
    await settle(tester);
    expect(notato.pendingCount, 0);
    expect(notato.notes.last.failed, isNull);
    await unmount(tester);
  });

  testWidgets('finds a capture-only token out when the server could not be asked first and refuses the stream', (
    tester,
  ) async {
    final server = FakeServer()
      ..captureOnly = true
      ..configOffline = true;
    await tester.pumpWidget(app(server));
    await settle(tester);
    expect(notato.connection, NotatoConnection.refused);

    server.configOffline = false;
    // The stream is tried again 10 seconds after a refusal, and the server asked again with it.
    await tester.pump(const Duration(seconds: 11));
    await settle(tester);
    expect(runtime.captureOnly, isTrue);
    expect(notato.connection, NotatoConnection.connected);
    await unmount(tester);
  });

  testWidgets('a recorded request keeps neither its query nor a user name and password', (tester) async {
    final server = FakeServer();
    await tester.pumpWidget(app(server));
    await settle(tester);
    notato.recordRequest(
      method: 'get',
      url: 'https://dom:hunter2@api.example.com/orders?key=abc#top',
      status: 200,
      duration: const Duration(milliseconds: 12),
    );
    final made = await drive(tester, notato.annotate('#add-to-basket', 'Slow list', screenshot: false));
    final network = ((made['context'] as Map)['network'] as List).single as Map;
    expect(network['url'], 'https://api.example.com/orders');
    await unmount(tester);
  });

  test('a token goes from a profile or release build only when the app says so, and never a device token', () {
    NotatoConfig resolve(String token, String server, {bool allow = false, bool debugBuild = false}) =>
        NotatoConfig.resolve(
          project: 'shop',
          server: server,
          token: token,
          allowTokenInRelease: allow,
          debugBuild: debugBuild,
        );
    const shared = 'https://notato.example.com';
    const tunnel = 'https://abc123-4747.uks1.devtunnels.ms';

    expect(resolve('notato_app', shared).token, isNull);
    expect(resolve('notato_app', shared).tokenWithheld, contains('allowTokenInRelease'));
    expect(resolve('notato_capture', shared, allow: true).token, 'notato_capture');
    expect(resolve('notato_device_abc', shared, allow: true).token, isNull);
    expect(resolve('notato_app', tunnel, allow: true).token, isNull);
    // A debug build is the developer's own: the device token is what reaches the tunnel.
    expect(resolve('notato_device_abc', tunnel, debugBuild: true).token, 'notato_device_abc');
  });

  test('captured messages are kept without the credentials in them', () {
    expect(
      redact('GET /me: Authorization: Bearer xyz-789 was refused'),
      'GET /me: Authorization: Bearer [redacted] was refused',
    );
    final printed = redact(
      '{url: /orders, Cookie: sid=s3cr3t, X-Api-Key: k-123}; {password: hunter2, access_token: r-456}',
    );
    for (final secret in ['s3cr3t', 'k-123', 'hunter2', 'r-456']) {
      expect(printed, isNot(contains(secret)));
    }
    expect(printed, startsWith('{url: /orders, '));
  });
}
