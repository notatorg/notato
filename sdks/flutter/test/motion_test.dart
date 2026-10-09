import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:notato/notato.dart';

import 'harness.dart';
import 'shop.dart';

/// A list long enough to scroll.
class LongList extends StatelessWidget {
  const LongList({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
    body: ListView(children: [for (var i = 0; i < 30; i++) ProductCard(name: 'Spud $i')]),
  );
}

void main() {
  testWidgets('opens the composer before the screenshots are made, and the note waits for them', (tester) async {
    final server = FakeServer();
    await tester.pumpWidget(app(server, screenshots: true));
    await settle(tester);
    await tester.tap(find.text('Annotate'));
    await tester.pump();
    await tester.tapAt(tester.getCenter(find.text('Add to basket')));
    // Two frames, and no time for a picture to be made: the composer is open, and the toolbar stays drawn.
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const ValueKey('NotatoComment')), findsOneWidget);
    expect(find.text('Annotate'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 300));
    await tester.enterText(find.byKey(const ValueKey('NotatoComment')), 'Bigger, please');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('NotatoSend')));
    for (var i = 0; i < 100 && server.sent.isEmpty; i++) {
      await tester.pump(const Duration(milliseconds: 16));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
    }
    expect(server.sent, hasLength(1));
    expect(
      server.files,
      containsAll(['asset:${server.sent.single['id']}-full', 'asset:${server.sent.single['id']}-crop']),
    );
    await unmount(tester);
  });

  testWidgets('pins follow their widgets as the app scrolls, and cost nothing once it is still', (tester) async {
    await tester.pumpWidget(app(FakeServer(), home: const LongList()));
    await settle(tester);
    await drive(tester, notato.annotate('Text:text("Spud 3")', 'Rename it'));
    await settle(tester);
    final pin = find.bySemanticsLabel(RegExp('Note 1'));
    expect(pin, findsOneWidget);
    final before = tester.getTopLeft(pin);
    final card = tester.getTopLeft(find.text('Spud 3'));

    await tester.drag(find.byType(ListView), const Offset(0, -120), warnIfMissed: false);
    // A frame for the list to move, and one for its pin: no waiting for the next look at the screen.
    await tester.pump();
    await tester.pump();
    final moved = tester.getTopLeft(find.text('Spud 3')).dy - card.dy;
    expect(moved, lessThan(-50));
    expect(tester.getTopLeft(pin).dy - before.dy, moreOrLessEquals(moved, epsilon: 1));

    await settle(tester);
    await tester.pump(const Duration(milliseconds: 400));
    await settle(tester);
    expect(tester.binding.hasScheduledFrame, isFalse);
    await unmount(tester);
  });

  testWidgets('sheets slide away before they are gone', (tester) async {
    await tester.pumpWidget(app(FakeServer()));
    await settle(tester);
    await tester.tap(find.bySemanticsLabel('Notato menu'));
    await settle(tester);
    expect(find.text('Notes'), findsOneWidget);
    // The scrim, above the sheet.
    await tester.tapAt(const Offset(400, 10));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 60));
    // Still on its way out, and taking no taps.
    expect(find.text('Notes'), findsOneWidget);
    await settle(tester);
    expect(find.text('Notes'), findsNothing);
    await unmount(tester);
  });
}
