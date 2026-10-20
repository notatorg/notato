import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:notato/src/controller.dart';
import 'package:notato/src/runtime.dart';
import 'package:notato/src/ui/sheets.dart';

import 'annotation_test.dart' show note;
import 'harness.dart';

void main() {
  testWidgets('options keep the reply draft and show its privacy before sending', (tester) async {
    final server = FakeServer();
    final record = NoteRecord({...note(), 'status': 'resolved', 'thread': <Object?>[]});
    await tester.pumpWidget(
      app(
        server,
        home: Scaffold(
          body: Padding(
            padding: const EdgeInsets.all(20),
            child: SizedBox(
              height: 360,
              width: 350,
              child: NoteCard(
                runtime: runtime,
                record: record,
                number: 1,
                fromList: false,
                open: (_) {},
                toast: (_) {},
              ),
            ),
          ),
        ),
      ),
    );
    await settle(tester);
    expect(find.text('Revert this change…'), findsNothing);
    expect(find.text('Hide from agent'), findsNothing);
    await tester.enterText(find.byKey(const ValueKey('NotatoReply')), 'Keep this draft');
    await tester.tap(find.byKey(const ValueKey('NotatoMoreOptions')));
    await tester.pump();
    expect(find.text('Revert this change…'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.ensureVisible(find.byKey(const ValueKey('NotatoAside')));
    await tester.tap(find.byKey(const ValueKey('NotatoAside')));
    await tester.pump();
    expect(find.text('Next reply hidden from agent'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('NotatoMoreOptions')));
    await tester.pump();
    expect(find.text('Revert this change…'), findsNothing);
    expect(find.text('Keep this draft'), findsOneWidget);
    expect(find.text('Next reply hidden from agent'), findsOneWidget);
    await unmount(tester);
  });

  for (final intent in ['question', 'approve']) {
    testWidgets('a resolved $intent has no revert action', (tester) async {
      final record = NoteRecord({...note(), 'status': 'resolved', 'intent': intent, 'thread': <Object?>[]});
      await tester.pumpWidget(
        app(
          FakeServer(),
          home: Scaffold(
            body: NoteCard(runtime: runtime, record: record, number: 1, fromList: false, open: (_) {}, toast: (_) {}),
          ),
        ),
      );
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('NotatoMoreOptions')));
      await tester.pump();
      expect(find.text('Revert this change…'), findsNothing);
      expect(find.text('resolved'), findsOneWidget);
      await unmount(tester);
    });
  }
}
