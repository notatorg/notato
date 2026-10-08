import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:notato/notato.dart';

import 'harness.dart';
import 'shop.dart';

void main() {
  testWidgets('switches off and on at runtime without rebuilding the app, and remembers the choice', (tester) async {
    await tester.pumpWidget(app(FakeServer()));
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
    await unmount(tester);
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
    await unmount(tester);
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
    await unmount(tester);
    expect(notato.isEnabled, isFalse);
  });

  testWidgets('starts when the app builds Notato again while its storage is still opening', (tester) async {
    final opened = Completer<NotatoStorage>();
    Widget notatoApp() => Notato(
      project: 'shop',
      server: '',
      storage: (_) => opened.future,
      child: const MaterialApp(home: ProductList()),
    );
    await tester.pumpWidget(notatoApp());
    // The same options again, as a parent that rebuilds gives them.
    await tester.pumpWidget(notatoApp());
    opened.complete(MemoryStorage());
    await settle(tester);
    expect(notato.isEnabled, isTrue);
    expect(find.text('Annotate'), findsOneWidget);
    await unmount(tester);
  });

  testWidgets("keeps notes in memory when the app's own storage cannot be opened", (tester) async {
    await tester.pumpWidget(
      Notato(
        project: 'shop',
        server: '',
        storage: (_) async => throw StateError('no disk'),
        child: const MaterialApp(home: ProductList()),
      ),
    );
    await settle(tester);
    expect(notato.isEnabled, isTrue);
    await unmount(tester);
  });

  testWidgets('files notes under the named screen on top, through a dialog or an unnamed page over it', (tester) async {
    final observer = NotatoRouteObserver();
    final navigator = GlobalKey<NavigatorState>();
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: navigator,
        navigatorObservers: [observer],
        initialRoute: '/shop',
        routes: {'/': (_) => const SizedBox(), '/shop': (_) => const ProductList(), '/basket': (_) => const SizedBox()},
      ),
    );
    expect(observer.current, '/shop');
    unawaited(navigator.currentState!.pushNamed('/basket'));
    await tester.pumpAndSettle();
    expect(observer.current, '/basket');
    unawaited(showDialog<void>(context: navigator.currentContext!, builder: (_) => const Text('Sure?')));
    await tester.pumpAndSettle();
    expect(observer.current, '/basket');
    navigator.currentState!
      ..pop()
      ..pop();
    await tester.pumpAndSettle();
    expect(observer.current, '/shop');
    unawaited(navigator.currentState!.push(MaterialPageRoute<void>(builder: (_) => const SizedBox())));
    await tester.pumpAndSettle();
    expect(observer.current, '/shop');
    unawaited(navigator.currentState!.pushNamed('/basket'));
    await tester.pumpAndSettle();
    navigator.currentState!.pop();
    await tester.pumpAndSettle();
    // Back on the unnamed page: the basket is gone, and the shop is the named screen under it.
    expect(observer.current, '/shop');
  });
}
