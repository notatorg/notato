import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:notato/notato.dart';
import 'package:notato/src/runtime.dart';
import 'package:notato/src/ui/sheets.dart';

import 'harness.dart';

void main() {
  test('numbers pins per screen and keeps up with ten thousand notes', () {
    final controller = NotatoRuntime();
    final records = [
      for (var i = 0; i < 10000; i++)
        NoteRecord({
          'id': 'n${i.toString().padLeft(5, '0')}',
          'route': '/screen-${i % 50}',
          'createdAt': DateTime.utc(2026, 10, 8).add(Duration(seconds: i)).toIso8601String(),
        }),
    ];
    // The records as the server's list would leave them.
    controller.debugSetRecords(records);
    final watch = Stopwatch()..start();
    final here = controller.notesOn('/screen-7');
    expect(here, hasLength(200));
    expect([for (final n in here) n.number], [for (var i = 1; i <= 200; i++) i]);
    expect(controller.nextPin('screen-7'), 201);
    expect(watch.elapsedMilliseconds, lessThan(500));
  });

  test('pins only the notes made in a Flutter app; the others keep their numbers in the list', () {
    final controller = NotatoRuntime();
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

  testWidgets("notices a move to another screen when nothing of Notato's is redrawn", (tester) async {
    var screen = 'catalogue';
    await tester.pumpWidget(app(FakeServer(), route: () => screen));
    await settle(tester);
    // A note on the basket screen, as the server's list would leave it (it says nothing to the overlay).
    runtime.debugSetRecords([
      const NoteRecord({
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
    await unmount(tester);
  });

  testWidgets('the Notes list has every note on the screen, newest first', (tester) async {
    await tester.pumpWidget(app(FakeServer()));
    await settle(tester);
    runtime.debugSetRecords([
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
    await unmount(tester);
  });
}
