import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:notato/src/annotation.dart';
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

  testWidgets('a reply with images says how many are attached', (tester) async {
    Map<String, Object?> image(String id) => {'id': id, 'mime': 'image/png', 'w': 10, 'h': 10, 'name': '$id.png'};
    final record = NoteRecord({
      ...note(),
      'status': 'open',
      'thread': [
        {
          'id': 'r1',
          'author': {'kind': 'agent', 'name': 'Claude'},
          'body': 'One',
          'createdAt': '2026-01-01T00:00:00Z',
        },
        {
          'id': 'r2',
          'author': {'kind': 'agent', 'name': 'Claude'},
          'body': 'Two',
          'createdAt': '2026-01-01T00:00:01Z',
          'images': [image('a')],
        },
        {
          'id': 'r3',
          'author': {'kind': 'human', 'name': 'Ann'},
          'body': 'Three',
          'createdAt': '2026-01-01T00:00:02Z',
          'images': [image('b'), image('c'), image('d')],
        },
      ],
    });
    await tester.pumpWidget(
      app(
        FakeServer(),
        home: Scaffold(
          body: NoteCard(runtime: runtime, record: record, number: 1, fromList: false, open: (_) {}, toast: (_) {}),
        ),
      ),
    );
    await settle(tester);
    expect(find.text('1 image attached'), findsOneWidget);
    expect(find.text('3 images attached'), findsOneWidget);
    expect(replyImages((record.annotation['thread'] as List)[2] as Map<String, Object?>), hasLength(3));
    await unmount(tester);
  });

  testWidgets('settings has a hide done switch, and restore only when notes are hidden one at a time', (tester) async {
    await tester.pumpWidget(
      app(
        FakeServer(),
        home: Scaffold(
          body: SettingsSheet(runtime: runtime, open: (_) {}, toast: (_) {}),
        ),
      ),
    );
    await settle(tester);
    expect(find.text('Hide done annotations'), findsOneWidget);
    expect(find.textContaining('including ones finished later'), findsOneWidget);
    expect(find.textContaining('Hide completed'), findsNothing);
    expect(find.byKey(const ValueKey('NotatoRestoreHidden')), findsNothing);
    expect(runtime.hideDone, isFalse);
    await tester.tap(find.byKey(const ValueKey('NotatoHideDone')));
    await tester.pump();
    expect(runtime.hideDone, isTrue);
    expect(tester.widget<Switch>(find.byType(Switch).last).value, isTrue);
    runtime.setHideDone(false);
    await unmount(tester);
  });
}
