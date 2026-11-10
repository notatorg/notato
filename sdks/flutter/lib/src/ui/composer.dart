import 'package:flutter/material.dart';

import '../annotation.dart';
import 'motion.dart';
import 'parts.dart';
import 'theme.dart';

/// What a person wrote.
typedef Draft = ({String comment, String? intent, String? severity, bool peopleOnly, String visibility});

/// The note being written: a floating card, away from what it is about.
class Composer extends StatefulWidget {
  const Composer({
    super.key,
    required this.title,
    this.subtitle,
    this.sharedByDefault = false,
    required this.screenshotsOff,
    required this.onParent,
    required this.onCancel,
    required this.onSend,
  });
  final String title;
  final String? subtitle;
  final bool sharedByDefault;
  final bool screenshotsOff;

  /// Selects the widget around this one.
  final VoidCallback onParent;
  final VoidCallback onCancel;
  final ValueChanged<Draft> onSend;

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  final _text = TextEditingController();
  final _focus = FocusNode(debugLabel: 'Notato note');
  String? _intent;
  String? _severity;
  var _peopleOnly = false;
  var _shared = false;

  /// Whether the visibility switches are showing. They start hidden each time the composer opens.
  var _visibilityOpen = false;

  static const _intents = {'fix': 'Fix', 'change': 'Change', 'question': 'Question', 'approve': 'Approve'};
  static const _severities = {'blocker': 'Blocker', 'major': 'Major', 'minor': 'Minor', 'nit': 'Nit'};

  @override
  void initState() {
    super.initState();
    _shared = widget.sharedByDefault;
    _text.addListener(() => setState(() {}));
    // Not `autofocus`: the app's own focus scope already has focus, and autofocus only takes it from nobody.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _focus.requestFocus();
    });
  }

  @override
  void dispose() {
    _text.dispose();
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final ready = _text.text.trim().isNotEmpty;
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 480),
      child: Container(
        padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
        decoration: BoxDecoration(
          color: p.background,
          borderRadius: BorderRadius.circular(28),
          boxShadow: const [BoxShadow(color: Color(0x40000000), blurRadius: 20, offset: Offset(0, 6))],
        ),
        child: DefaultTextStyle(
          style: TextStyle(color: p.text, fontSize: 15),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          widget.title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
                        ),
                        if (widget.subtitle != null)
                          Text(
                            widget.subtitle!,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 12, color: p.muted),
                          ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  Semantics(
                    button: true,
                    hint: 'Select the widget around this one',
                    child: Material(
                      color: p.soft,
                      shape: const StadiumBorder(),
                      child: InkWell(
                        customBorder: const StadiumBorder(),
                        onTap: widget.onParent,
                        child: SizedBox(
                          height: 30,
                          child: Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 11),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                NotatoIcon('up', size: 13, color: p.text),
                                const SizedBox(width: 4),
                                Text(
                                  'Parent',
                                  style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: p.text),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  HeaderButton.close(onPressed: widget.onCancel, label: 'Cancel'),
                ],
              ),
              const SizedBox(height: 12),
              Semantics(
                container: true,
                label: 'Feedback type',
                child: Chips(options: _intents, value: _intent, onChanged: (v) => setState(() => _intent = v)),
              ),
              const SizedBox(height: 12),
              TextField(
                key: const ValueKey('NotatoComment'),
                controller: _text,
                focusNode: _focus,
                minLines: 3,
                maxLines: 6,
                style: TextStyle(color: p.text, fontSize: 15),
                decoration: fieldDecoration(context, 'What should change?'),
              ),
              const SizedBox(height: 12),
              Semantics(
                container: true,
                label: 'Severity',
                child: Chips(
                  options: _severities,
                  value: _severity,
                  onChanged: (v) => setState(() => _severity = v),
                  // The severity's colours, the web composer's.
                  dots: const {
                    'blocker': Color(0xFFD6453D),
                    'major': Color(0xFFD99A1E),
                    'minor': Color(0xFF2F6FDE),
                    'nit': Color(0xFF9A9A9A),
                  },
                ),
              ),
              const SizedBox(height: 12),
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: VisibilityButton(
                  shared: _shared,
                  peopleOnly: _peopleOnly,
                  open: _visibilityOpen,
                  onPressed: () => setState(() => _visibilityOpen = !_visibilityOpen),
                ),
              ),
              // The two switches, under the button while it is open.
              AnimatedSize(
                duration: reducedMotion(context) ? Duration.zero : enter,
                curve: enterCurve,
                alignment: Alignment.topCenter,
                child: _visibilityOpen
                    ? Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            FlagToggle(
                              key: const ValueKey('NotatoShared'),
                              title: 'Share with project',
                              hint: 'Project members can see this feedback.',
                              value: _shared,
                              onChanged: (value) => setState(() => _shared = value),
                            ),
                            FlagToggle(
                              key: const ValueKey('NotatoPeopleOnly'),
                              title: PeopleOnlyCopy.title,
                              hint: PeopleOnlyCopy.hint,
                              value: _peopleOnly,
                              onChanged: (v) => setState(() => _peopleOnly = v),
                            ),
                          ],
                        ),
                      )
                    : const SizedBox(width: double.infinity),
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: Text(
                      widget.screenshotsOff
                          ? 'No screenshot: they are turned off.'
                          : 'Tap another element to change what this note is about.',
                      style: TextStyle(fontSize: 12, color: p.muted),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Opacity(
                    opacity: ready ? 1 : 0.45,
                    child: Material(
                      key: const ValueKey('NotatoSend'),
                      color: Brand.accent,
                      borderRadius: BorderRadius.circular(12),
                      child: InkWell(
                        borderRadius: BorderRadius.circular(12),
                        onTap: ready
                            ? () => widget.onSend((
                                comment: _text.text.trim(),
                                intent: _intent,
                                severity: _severity,
                                peopleOnly: _peopleOnly,
                                visibility: _shared ? 'shared' : 'personal',
                              ))
                            : null,
                        child: const Padding(
                          padding: EdgeInsets.symmetric(horizontal: 14, vertical: 9),
                          child: Text(
                            'Send',
                            style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: Colors.white),
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Who can see the note, in a few words, from its two switches: the web composer's labels.
String visibilityLabel({required bool shared, required bool peopleOnly}) => switch ((shared, peopleOnly)) {
  (false, false) => 'You and your agent',
  (true, false) => 'Shared with project',
  (false, true) => 'Only you',
  (true, true) => 'Project, not agent',
};

/// A capsule saying who can see the note. Tapped, it shows or hides the switches that choose that.
class VisibilityButton extends StatelessWidget {
  const VisibilityButton({
    super.key,
    required this.shared,
    required this.peopleOnly,
    required this.open,
    required this.onPressed,
  });
  final bool shared;
  final bool peopleOnly;

  /// Whether the switches are showing.
  final bool open;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final label = visibilityLabel(shared: shared, peopleOnly: peopleOnly);
    return Semantics(
      button: true,
      expanded: open,
      label: 'Visibility: $label',
      excludeSemantics: true,
      child: Material(
        color: open ? p.soft : Colors.transparent,
        shape: StadiumBorder(side: BorderSide(color: p.line)),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          key: const ValueKey('NotatoVisibility'),
          onTap: onPressed,
          customBorder: const StadiumBorder(),
          highlightColor: p.soft,
          splashFactory: NoSplash.splashFactory,
          child: SizedBox(
            height: 34,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  NotatoIcon(shared ? 'people' : 'lock', size: 14, color: p.muted),
                  const SizedBox(width: 6),
                  Text(
                    label,
                    style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: p.text),
                  ),
                  const SizedBox(width: 6),
                  AnimatedRotation(
                    turns: open ? 0.5 : 0,
                    duration: reducedMotion(context) ? Duration.zero : enter,
                    curve: enterCurve,
                    child: NotatoIcon('chevronDown', size: 12, color: p.muted),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
