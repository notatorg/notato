import 'package:flutter/material.dart';

import '../config.dart';
import 'parts.dart';
import 'theme.dart';

const toolbarHeight = 54.0;
const _margin = 12.0;

/// The toolbar: grip, Annotate with the count of notes on this screen, ⋯ and the chevron that folds it into a round
/// button with the potato. The whole bar drags; where it is left is kept.
class Toolbar extends StatefulWidget {
  const Toolbar({
    super.key,
    required this.room,
    required this.insets,
    required this.place,
    required this.corner,
    required this.folded,
    required this.annotating,
    required this.count,
    this.problem,
    this.problemLabel,
    required this.onAnnotate,
    required this.onMenu,
    required this.onFold,
    required this.onMoved,
  });

  final Size room;
  final EdgeInsets insets;
  final ({double? x, double? y}) place;
  final NotatoPosition corner;
  final bool folded;
  final bool annotating;
  final int count;

  /// A dot on ⋯ (or the folded button) while connecting, or when the server cannot be reached.
  final Color? problem;
  final String? problemLabel;
  final VoidCallback onAnnotate;
  final VoidCallback onMenu;
  final ValueChanged<bool> onFold;
  final void Function(double x, double y) onMoved;

  @override
  State<Toolbar> createState() => _ToolbarState();
}

class _ToolbarState extends State<Toolbar> {
  Offset _drag = Offset.zero;
  double _openWidth = 252;
  final _measure = GlobalKey();

  String _count(int n) => n > 99 ? '99+' : '$n';

  @override
  Widget build(BuildContext context) {
    final width = widget.folded ? toolbarHeight : _openWidth;
    final top = widget.insets.top + 8;
    final spanX = (widget.room.width - width - _margin * 2).clamp(0.0, double.infinity);
    final spanY = (widget.room.height - top - widget.insets.bottom - 8 - toolbarHeight).clamp(0.0, double.infinity);
    final corner = widget.corner;
    final fx =
        widget.place.x ?? (corner == NotatoPosition.bottomRight || corner == NotatoPosition.topRight ? 1.0 : 0.0);
    final fy =
        widget.place.y ?? (corner == NotatoPosition.bottomRight || corner == NotatoPosition.bottomLeft ? 1.0 : 0.0);
    final left = _margin + fx * spanX;
    final y = top + fy * spanY;
    final heldRight = fx > 0.5;

    // After the open bar is laid out, keep its width: it places the bar and the folded button on the same edge.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final box = _measure.currentContext?.findRenderObject() as RenderBox?;
      if (box != null && box.hasSize && (box.size.width - _openWidth).abs() > 1 && mounted) {
        setState(() => _openWidth = box.size.width);
      }
    });

    final bar = AnimatedContainer(
      duration: const Duration(milliseconds: 160),
      height: toolbarHeight,
      decoration: BoxDecoration(
        color: Bar.bar,
        borderRadius: BorderRadius.circular(widget.folded ? toolbarHeight / 2 : 16),
        border: Border.all(color: Bar.line),
        boxShadow: const [BoxShadow(color: Color(0x730F1114), blurRadius: 14, offset: Offset(0, 10))],
      ),
      child: widget.folded ? _folded() : _open(heldRight),
    );

    return Positioned(
      left: left + _drag.dx,
      top: y + _drag.dy,
      child: GestureDetector(
        onPanUpdate: (d) => setState(() => _drag += d.delta),
        onPanEnd: (_) {
          final x = spanX == 0 ? 0.0 : ((left + _drag.dx - _margin) / spanX).clamp(0.0, 1.0);
          final yy = spanY == 0 ? 0.0 : ((y + _drag.dy - top) / spanY).clamp(0.0, 1.0);
          setState(() => _drag = Offset.zero);
          widget.onMoved(x, yy);
        },
        child: bar,
      ),
    );
  }

  Widget _folded() => Semantics(
    button: true,
    label: 'Show the Notato toolbar',
    value: widget.count > 0 ? '${widget.count} on this screen' : null,
    child: GestureDetector(
      onTap: () => widget.onFold(false),
      child: SizedBox(
        width: toolbarHeight - 2,
        height: toolbarHeight - 2,
        child: Stack(
          clipBehavior: Clip.none,
          alignment: Alignment.center,
          children: [
            const Potato(size: 40),
            if (widget.count > 0)
              Positioned(
                top: -8,
                right: -8,
                child: Container(
                  padding: const EdgeInsets.all(2),
                  decoration: BoxDecoration(color: Bar.bar, borderRadius: BorderRadius.circular(999)),
                  child: Container(
                    constraints: const BoxConstraints(minWidth: 18),
                    height: 18,
                    padding: const EdgeInsets.symmetric(horizontal: 5),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(color: Bar.accent, borderRadius: BorderRadius.circular(9)),
                    child: Text(
                      _count(widget.count),
                      style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w800, color: Bar.onAccent),
                    ),
                  ),
                ),
              ),
            if (widget.problem != null)
              Positioned(
                left: -2,
                bottom: -2,
                child: Container(
                  padding: const EdgeInsets.all(2),
                  decoration: const BoxDecoration(color: Bar.bar, shape: BoxShape.circle),
                  child: Container(
                    width: 10,
                    height: 10,
                    decoration: BoxDecoration(color: widget.problem, shape: BoxShape.circle),
                  ),
                ),
              ),
          ],
        ),
      ),
    ),
  );

  Widget _barButton({required Widget child, required VoidCallback onTap, bool active = false, double? width}) =>
      Material(
        color: active ? Bar.accent : Colors.transparent,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          highlightColor: Bar.pressed,
          splashColor: Colors.transparent,
          onTap: onTap,
          child: SizedBox(
            height: 44,
            width: width,
            child: Center(child: child),
          ),
        ),
      );

  Widget _open(bool heldRight) {
    final on = widget.annotating;
    return Padding(
      key: _measure,
      padding: const EdgeInsets.all(4),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const SizedBox(
            width: 20,
            height: 44,
            child: Center(child: NotatoIcon('grip', size: 14, color: Bar.muted)),
          ),
          const SizedBox(width: 2),
          Semantics(
            button: true,
            selected: on,
            label: 'Annotate',
            value: '${widget.count} on this screen',
            excludeSemantics: true,
            child: _barButton(
              active: on,
              onTap: widget.onAnnotate,
              child: Padding(
                padding: const EdgeInsets.only(left: 12, right: 10),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    NotatoIcon('crosshair', size: 18, color: on ? Bar.onAccent : Bar.text),
                    const SizedBox(width: 8),
                    Text(
                      'Annotate',
                      style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: on ? Bar.onAccent : Bar.text),
                    ),
                    const SizedBox(width: 8),
                    Container(
                      constraints: const BoxConstraints(minWidth: 22),
                      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
                      decoration: BoxDecoration(
                        color: on ? Bar.onAccent.withValues(alpha: 0.16) : Bar.pressed,
                        borderRadius: BorderRadius.circular(999),
                      ),
                      child: Text(
                        _count(widget.count),
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          fontSize: 12.5,
                          fontWeight: FontWeight.w700,
                          fontFeatures: const [FontFeature.tabularFigures()],
                          color: on ? Bar.onAccent : Bar.text,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(width: 2),
          Semantics(
            button: true,
            label: 'Notato menu',
            value: widget.problem == null ? null : widget.problemLabel,
            excludeSemantics: true,
            child: _barButton(
              width: 44,
              onTap: widget.onMenu,
              child: Stack(
                clipBehavior: Clip.none,
                children: [
                  const NotatoIcon('more', size: 18, color: Bar.text),
                  if (widget.problem != null)
                    Positioned(
                      top: -5,
                      right: -5,
                      child: Container(
                        width: 8,
                        height: 8,
                        decoration: BoxDecoration(
                          color: widget.problem,
                          shape: BoxShape.circle,
                          border: Border.all(color: Bar.bar, width: 1.5),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
          const SizedBox(width: 2),
          Semantics(
            button: true,
            label: 'Collapse the toolbar',
            excludeSemantics: true,
            child: _barButton(
              width: 28,
              onTap: () => widget.onFold(true),
              child: NotatoIcon(heldRight ? 'chevronRight' : 'chevronLeft', size: 16, color: Bar.muted),
            ),
          ),
        ],
      ),
    );
  }
}

/// The hint at the top while annotating.
class HintBar extends StatelessWidget {
  const HintBar({super.key, required this.done});
  final VoidCallback done;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.fromLTRB(16, 6, 6, 6),
    decoration: BoxDecoration(
      color: Bar.bar,
      borderRadius: BorderRadius.circular(999),
      border: Border.all(color: Bar.line),
      boxShadow: const [BoxShadow(color: Color(0x47000000), blurRadius: 12, offset: Offset(0, 4))],
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        const Flexible(
          child: Text(
            'Tap what you want to comment on',
            style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: Bar.text),
          ),
        ),
        const SizedBox(width: 12),
        Material(
          color: Bar.accent,
          shape: const StadiumBorder(),
          child: InkWell(
            customBorder: const StadiumBorder(),
            onTap: done,
            child: const Padding(
              padding: EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              child: Text(
                'Done',
                style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: Bar.onAccent),
              ),
            ),
          ),
        ),
      ],
    ),
  );
}
