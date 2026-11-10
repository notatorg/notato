import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:notato/src/annotation.dart';
import 'package:notato/src/ui/composer.dart';

/// The composer on its own, as the overlay draws it.
Widget composer({bool sharedByDefault = false, ValueChanged<Draft>? onSend}) => MaterialApp(
  home: Scaffold(
    body: Center(
      child: Composer(
        title: 'ProductCard',
        subtitle: 'example/lib/main.dart:95',
        sharedByDefault: sharedByDefault,
        screenshotsOff: false,
        onParent: () {},
        onCancel: () {},
        onSend: onSend ?? (_) {},
      ),
    ),
  ),
);

final _button = find.byKey(const ValueKey('NotatoVisibility'));
final _share = find.byKey(const ValueKey('NotatoShared'));
final _hide = find.byKey(const ValueKey('NotatoPeopleOnly'));

void main() {
  test('the visibility label names who can see the note, for each pair of switches', () {
    expect(visibilityLabel(shared: false, peopleOnly: false), 'You and your agent');
    expect(visibilityLabel(shared: true, peopleOnly: false), 'Shared with project');
    expect(visibilityLabel(shared: false, peopleOnly: true), 'Only you');
    expect(visibilityLabel(shared: true, peopleOnly: true), 'Project, not agent');
  });

  testWidgets('feedback type comes before the comment and severity after, with no headings', (tester) async {
    await tester.pumpWidget(composer());
    await tester.pumpAndSettle();
    final fix = tester.getTopLeft(find.text('Fix')).dy;
    final comment = tester.getTopLeft(find.byKey(const ValueKey('NotatoComment'))).dy;
    final blocker = tester.getTopLeft(find.text('Blocker')).dy;
    final visibility = tester.getTopLeft(_button).dy;
    expect(fix, lessThan(comment));
    expect(comment, lessThan(blocker));
    expect(blocker, lessThan(visibility));
    expect(find.text('Feedback type'), findsNothing);
    expect(find.text('Severity'), findsNothing);
    expect(find.text('Visibility'), findsNothing);
    // The groups keep their names for screen readers.
    expect(find.bySemanticsLabel('Feedback type'), findsOneWidget);
    expect(find.bySemanticsLabel('Severity'), findsOneWidget);
  });

  testWidgets('the visibility switches start hidden and show under the button when it is tapped', (tester) async {
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(composer());
    await tester.pumpAndSettle();
    expect(_share, findsNothing);
    expect(_hide, findsNothing);
    expect(find.text('You and your agent'), findsOneWidget);
    expect(
      tester.getSemantics(_button),
      isSemantics(label: 'Visibility: You and your agent', isButton: true, hasExpandedState: true, isExpanded: false),
    );

    await tester.tap(_button);
    await tester.pumpAndSettle();
    expect(find.text('Share with project'), findsOneWidget);
    expect(find.text(PeopleOnlyCopy.title), findsOneWidget);
    expect(tester.getTopLeft(_share).dy, greaterThan(tester.getBottomLeft(_button).dy));
    expect(tester.getTopLeft(_hide).dy, greaterThan(tester.getTopLeft(_share).dy));
    expect(
      tester.getSemantics(_button),
      isSemantics(label: 'Visibility: You and your agent', hasExpandedState: true, isExpanded: true),
    );

    await tester.tap(_button);
    await tester.pumpAndSettle();
    expect(_share, findsNothing);
    semantics.dispose();
  });

  testWidgets('the label follows the switches as they change, and the note is sent with them', (tester) async {
    Draft? sent;
    await tester.pumpWidget(composer(onSend: (draft) => sent = draft));
    await tester.pumpAndSettle();
    await tester.tap(_button);
    await tester.pumpAndSettle();

    await tester.tap(_share);
    await tester.pumpAndSettle();
    expect(find.text('Shared with project'), findsOneWidget);
    await tester.tap(_hide);
    await tester.pumpAndSettle();
    expect(find.text('Project, not agent'), findsOneWidget);
    await tester.tap(_share);
    await tester.pumpAndSettle();
    expect(find.text('Only you'), findsOneWidget);
    expect(find.bySemanticsLabel('Visibility: Only you'), findsOneWidget);

    await tester.enterText(find.byKey(const ValueKey('NotatoComment')), 'Bigger, please');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('NotatoSend')));
    expect(sent?.visibility, 'personal');
    expect(sent?.peopleOnly, isTrue);
  });

  testWidgets('a project shared by default says so, closed', (tester) async {
    await tester.pumpWidget(composer(sharedByDefault: true));
    await tester.pumpAndSettle();
    expect(find.text('Shared with project'), findsOneWidget);
    expect(_share, findsNothing);
  });

  testWidgets('the composer opens closed again after it was left open', (tester) async {
    await tester.pumpWidget(composer());
    await tester.pumpAndSettle();
    await tester.tap(_button);
    await tester.pumpAndSettle();
    expect(_share, findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(composer());
    await tester.pumpAndSettle();
    expect(_share, findsNothing);
  });
}
