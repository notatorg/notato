import 'package:flutter/material.dart';

import '../annotation.dart';
import 'parts.dart';
import 'theme.dart';

/// What a person wrote.
typedef Draft = ({String comment, String? intent, String? severity, bool peopleOnly});

/// The note being written: a floating card, away from what it is about.
class Composer extends StatefulWidget {
  const Composer({
    super.key,
    required this.title,
    this.subtitle,
    required this.screenshotsOff,
    required this.canParent,
    required this.onParent,
    required this.onCancel,
    required this.onSend,
  });
  final String title;
  final String? subtitle;
  final bool screenshotsOff;
  final bool canParent;
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

  static const _intents = {'fix': 'Fix', 'change': 'Change', 'question': 'Question', 'approve': 'Approve'};
  static const _severities = {'blocker': 'Blocker', 'major': 'Major', 'minor': 'Minor', 'nit': 'Nit'};

  @override
  void initState() {
    super.initState();
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
                  if (widget.canParent) ...[
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
                                  const Text('Parent', style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600)),
                                ],
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                  const SizedBox(width: 8),
                  HeaderButton.close(onPressed: widget.onCancel, label: 'Cancel'),
                ],
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
              Chips(options: _intents, value: _intent, onChanged: (v) => setState(() => _intent = v)),
              const SizedBox(height: 8),
              Chips(options: _severities, value: _severity, onChanged: (v) => setState(() => _severity = v)),
              const SizedBox(height: 12),
              FlagToggle(
                key: const ValueKey('NotatoPeopleOnly'),
                title: PeopleOnlyCopy.title,
                hint: PeopleOnlyCopy.hint,
                value: _peopleOnly,
                onChanged: (v) => setState(() => _peopleOnly = v),
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
