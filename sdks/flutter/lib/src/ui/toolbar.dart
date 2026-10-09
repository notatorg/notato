import 'package:flutter/material.dart';

import '../config.dart';
import 'motion.dart';
import 'parts.dart';
import 'theme.dart';

/// The toolbar's height, and the folded button's size.
const toolbarHeight = 54.0;

/// How far the toolbar keeps from the screen's edges.
const _margin = 12.0;

/// The toolbar: grip, Annotate with the count of notes on this screen, ⋯ and the chevron that folds it into a round
/// button with the potato. The whole bar drags; where it is left is kept. Folding, it shrinks towards the edge it is
/// held to; hidden ([shown] false), it fades away and comes back where it was.
class Toolbar extends StatefulWidget {
  const Toolbar({
    super.key,
    required this.shown,
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

  final bool shown;
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
  final _bar = GlobalKey();

  /// Faded away entirely: nothing of it is built until it is shown again.
  late var _gone = !widget.shown;

  String _count(int n) => n > 99 ? '99+' : '$n';

  @override
  void didUpdateWidget(Toolbar old) {
    super.didUpdateWidget(old);
    if (widget.shown) _gone = false;
  }

  /// Where it was let go of, as a fraction of the room it has across and down.
  void _drop(Size room, double fx, double fy) {
    final bar = (_bar.currentContext?.findRenderObject() as RenderBox?)?.size ?? Size.zero;
    final spanX = room.width - bar.width;
    final spanY = room.height - bar.height;
    final x = spanX <= 0 ? 0.0 : ((fx * spanX + _drag.dx) / spanX).clamp(0.0, 1.0);
    final y = spanY <= 0 ? 0.0 : ((fy * spanY + _drag.dy) / spanY).clamp(0.0, 1.0);
    // The new place is drawn in the same frame the drag is let go of: it never jumps back first.
    setState(() => _drag = Offset.zero);
    widget.onMoved(x, y);
  }

  @override
  Widget build(BuildContext context) {
    if (_gone) return const SizedBox.shrink();
    final corner = widget.corner;
    final fx =
        widget.place.x ?? (corner == NotatoPosition.bottomRight || corner == NotatoPosition.topRight ? 1.0 : 0.0);
    final fy =
        widget.place.y ?? (corner == NotatoPosition.bottomRight || corner == NotatoPosition.bottomLeft ? 1.0 : 0.0);
    final heldRight = fx > 0.5;
    final still = reducedMotion(context);

    final bar = AnimatedContainer(
      duration: enter,
      curve: enterCurve,
      height: toolbarHeight,
      decoration: BoxDecoration(
        color: Bar.bar,
        borderRadius: BorderRadius.circular(widget.folded ? toolbarHeight / 2 : 16),
        border: Border.all(color: Bar.line),
        boxShadow: const [BoxShadow(color: Color(0x730F1114), blurRadius: 14, offset: Offset(0, 10))],
      ),
      // Folding and unfolding, the bar's width follows its contents, held to its edge.
      child: AnimatedSize(
        duration: enter,
        curve: enterCurve,
        alignment: heldRight ? Alignment.centerRight : Alignment.centerLeft,
        child: AnimatedSwitcher(
          duration: const Duration(milliseconds: 160),
          layoutBuilder: (current, _) => current ?? const SizedBox.shrink(),
          child: widget.folded
              ? KeyedSubtree(key: const ValueKey('folded'), child: _folded())
              : KeyedSubtree(key: const ValueKey('open'), child: _open(heldRight)),
        ),
      ),
    );

    // Placed by alignment in the room it has: the same point of the bar stays put however wide it grows.
    return Positioned(
      left: _margin,
      right: _margin,
      top: widget.insets.top + 8,
      bottom: widget.insets.bottom + 8,
      child: LayoutBuilder(
        builder: (context, room) => Align(
          alignment: Alignment(fx * 2 - 1, fy * 2 - 1),
          child: IgnorePointer(
            ignoring: !widget.shown,
            child: ExcludeSemantics(
              excluding: !widget.shown,
              child: AnimatedOpacity(
                opacity: widget.shown ? 1 : 0,
                duration: widget.shown ? enter : leave,
                curve: widget.shown ? enterCurve : leaveCurve,
                onEnd: () {
                  if (!widget.shown && mounted) setState(() => _gone = true);
                },
                child: AnimatedScale(
                  scale: widget.shown || still ? 1 : 0.92,
                  duration: widget.shown ? enter : leave,
                  curve: widget.shown ? enterCurve : leaveCurve,
                  child: Transform.translate(
                    offset: _drag,
                    child: GestureDetector(
                      onPanUpdate: (d) => setState(() => _drag += d.delta),
                      onPanEnd: (_) => _drop(room.biggest, fx, fy),
                      child: KeyedSubtree(key: _bar, child: bar),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
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
