import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:notato/notato.dart';
import 'package:notato/src/environment.dart';
import 'package:notato/src/runtime.dart';

import 'harness.dart';
import 'shop.dart';

/// The shop in Notato, as the app's code configures it: no server unless [server] says one.
Widget shop({
  bool? enabled,
  String server = '',
  String? token,
  NotatoStorage? storage,
  http.Client Function()? client,
}) => Notato(
  project: 'shop',
  enabled: enabled,
  server: server,
  token: token,
  captureLogs: false,
  storage: (_) async => storage ?? MemoryStorage(),
  httpClient: client ?? FakeServer().client,
  child: const MaterialApp(home: ProductList()),
);

/// What the build these tests run in declares, if anything:
/// `flutter test --dart-define=NOTATO_ENABLED=false test/environment_test.dart`.
const declaredEnabled = String.fromEnvironment('NOTATO_ENABLED');
const declaredServer = String.fromEnvironment('NOTATO_SERVER');

void main() {
  tearDown(() => debugDeclarations = null);

  test('reads NOTATO_ENABLED as on or off in any case, and anything else as not declared', () {
    for (final on in ['true', 'TRUE', ' 1 ', 'yes', 'On']) {
      expect(parseDeclarations(enabled: on).enabled, isTrue, reason: on);
    }
    for (final off in ['false', 'False', '0', 'NO', ' off\n']) {
      expect(parseDeclarations(enabled: off).enabled, isFalse, reason: off);
    }
    for (final junk in [null, '', '  ', 'maybe', '2', 'enabled', 'o n']) {
      expect(parseDeclarations(enabled: junk).enabled, isNull, reason: junk);
    }
  });

  test('takes NOTATO_SERVER when it is not blank, trimmed', () {
    expect(parseDeclarations(server: ' http://localhost:4792 ').server, 'http://localhost:4792');
    for (final blank in [null, '', '   ']) {
      expect(parseDeclarations(server: blank).server, isNull, reason: blank);
    }
  });

  testWidgets('NOTATO_ENABLED wins over the enabled option, and the app can still switch Notato at runtime', (
    tester,
  ) async {
    debugDeclarations = parseDeclarations(enabled: 'false');
    await tester.pumpWidget(shop(enabled: true));
    await settle(tester);
    expect(notato.isEnabled, isFalse);
    expect(find.text('Annotate'), findsNothing);
    notato.enable();
    await settle(tester);
    expect(find.text('Annotate'), findsOneWidget);
    await unmount(tester);

    debugDeclarations = parseDeclarations(enabled: 'on');
    await tester.pumpWidget(shop(enabled: false));
    await settle(tester);
    expect(notato.isEnabled, isTrue);
    expect(find.text('Annotate'), findsOneWidget);
    await unmount(tester);
  });

  testWidgets('NOTATO_ENABLED wins over the choice remembered from an earlier launch, which is still remembered', (
    tester,
  ) async {
    final storage = MemoryStorage();
    debugDeclarations = parseDeclarations();
    await tester.pumpWidget(shop(storage: storage));
    await settle(tester);
    notato.disable();
    await unmount(tester);
    // A launch that declares nothing keeps the choice.
    await tester.pumpWidget(shop(storage: storage));
    await settle(tester);
    expect(notato.isEnabled, isFalse);
    await unmount(tester);

    debugDeclarations = parseDeclarations(enabled: 'true');
    await tester.pumpWidget(shop(storage: storage));
    await settle(tester);
    expect(notato.isEnabled, isTrue);
    notato.disable();
    await settle(tester);
    expect(notato.isEnabled, isFalse);
    expect(storage.loadSettings()['enabled'], isFalse);
    // Forgetting the runtime choices goes back to what the build declares.
    notato.resetRuntimeState();
    await settle(tester);
    expect(notato.isEnabled, isTrue);
    expect(find.text('Annotate'), findsOneWidget);
    await unmount(tester);
  });

  testWidgets('NOTATO_SERVER wins over the configured server and gets its token; a server typed in does not', (
    tester,
  ) async {
    final requests = <(String, String?)>[];
    final events = StreamController<List<int>>.broadcast();
    http.Client client() => MockClient.streaming((request, _) async {
      requests.add((request.url.origin, request.headers['authorization']));
      return http.StreamedResponse(events.stream, 200, headers: {'content-type': 'text/event-stream'});
    });
    debugDeclarations = parseDeclarations(server: ' http://localhost:4792/ ');
    await tester.pumpWidget(shop(server: 'http://localhost:4799', token: 'notato_t', client: client));
    await settle(tester);
    expect(runtime.server, 'http://localhost:4792');
    expect(requests, isNotEmpty);
    expect(requests, everyElement(('http://localhost:4792', 'Bearer notato_t')));

    requests.clear();
    expect(runtime.saveSettings(name: '', screenshots: true, server: 'http://localhost:4793'), isNull);
    await settle(tester);
    expect(requests, [('http://localhost:4793', null)]);
    await unmount(tester);
    await events.close();
  });

  testWidgets('blank declarations count as none: the options stand', (tester) async {
    debugDeclarations = parseDeclarations(enabled: '  ', server: '');
    await tester.pumpWidget(shop(enabled: false, server: 'http://localhost:4799'));
    await settle(tester);
    expect(notato.isEnabled, isFalse);
    expect(runtime.server, 'http://localhost:4799');
    await unmount(tester);
  });

  testWidgets(
    "the build's own NOTATO_ENABLED (${declaredEnabled == '' ? 'not declared' : declaredEnabled}) and NOTATO_SERVER "
    "(${declaredServer == '' ? 'not declared' : declaredServer}) reach Notato",
    (tester) async {
      final declared = parseDeclarations(enabled: declaredEnabled, server: declaredServer);
      expect(declarations, declared);
      await tester.pumpWidget(shop());
      await settle(tester);
      // On by default in a debug build, with no server unless the build declares one.
      final on = declared.enabled ?? true;
      expect(notato.isEnabled, on);
      expect(find.text('Annotate'), on ? findsOneWidget : findsNothing);
      expect(runtime.server, declared.server?.replaceAll(RegExp(r'/+$'), ''));
      await unmount(tester);
    },
  );
}
