import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:notato/notato.dart';
import 'package:notato/src/selectors.dart';
import 'package:notato/src/tree.dart';

import 'harness.dart';
import 'helpers.dart';

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
    await unmount(tester);
  });

  testWidgets('Parent selects the widget around the one tapped', (tester) async {
    await tester.pumpWidget(app(FakeServer()));
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
    await unmount(tester);
  });

  testWidgets('long-pressing in a Notato text field shows the text menu on iOS', (tester) async {
    await tester.pumpWidget(app(FakeServer()));
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
    await unmount(tester);
  }, variant: TargetPlatformVariant.only(TargetPlatform.iOS));
}
