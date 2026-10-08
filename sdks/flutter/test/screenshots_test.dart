import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:notato/notato.dart';
import 'package:notato/src/capture.dart';
import 'package:notato/src/serial.dart';
import 'package:notato/src/tree.dart';

import 'harness.dart';
import 'shop.dart';

void main() {
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

  testWidgets('keeps private text out of notes and covers it, fields too in test mode', (tester) async {
    final secret = GlobalKey();
    await tester.pumpWidget(
      app(
        FakeServer(),
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
    await unmount(tester);
  });

  testWidgets('photographs two notes made at once, covered, and takes the covers off after', (tester) async {
    await tester.pumpWidget(
      app(
        FakeServer(),
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
    await unmount(tester);
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
}
