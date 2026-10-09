import 'package:flutter/widgets.dart';

/// How long Notato's pieces take to come in and go: quick, so they never hold the person up.
const enter = Duration(milliseconds: 240);
const leave = Duration(milliseconds: 180);

/// Coming in slows to a stop; going speeds away.
const enterCurve = Curves.easeOutCubic;
const leaveCurve = Curves.easeInCubic;

/// Whether the person asked for less motion (iOS's Reduce Motion, Android's Remove animations): pieces then fade in
/// place instead of sliding or growing.
bool reducedMotion(BuildContext context) =>
    (MediaQuery.maybeDisableAnimationsOf(context) ?? false) ||
    View.of(context).platformDispatcher.accessibilityFeatures.reduceMotion;

/// Shows [child] with an entrance, and keeps the last one on screen while it leaves once [child] is null. [builder]
/// draws it for how far it is in: 0 gone, 1 there.
class Presence extends StatefulWidget {
  const Presence({super.key, required this.child, required this.builder});

  /// What is shown, or null for nothing (what was there leaves first).
  final Widget? child;
  final Widget Function(BuildContext context, Animation<double> shown, Widget child) builder;

  @override
  State<Presence> createState() => _PresenceState();
}

class _PresenceState extends State<Presence> with SingleTickerProviderStateMixin {
  late final _controller = AnimationController(vsync: this, duration: enter, reverseDuration: leave);
  late final _curve = CurvedAnimation(parent: _controller, curve: enterCurve, reverseCurve: leaveCurve);
  Widget? _last;

  @override
  void initState() {
    super.initState();
    _last = widget.child;
    if (_last != null) _controller.forward();
    _controller.addStatusListener((status) {
      // Gone: what was shown is let go of, so nothing of it stays built.
      if (status == AnimationStatus.dismissed && widget.child == null && mounted) setState(() => _last = null);
    });
  }

  @override
  void didUpdateWidget(Presence old) {
    super.didUpdateWidget(old);
    if (widget.child != null) {
      _last = widget.child;
      _controller.forward();
    } else {
      _controller.reverse();
    }
  }

  @override
  void dispose() {
    _curve.dispose();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final last = _last;
    if (last == null) return const SizedBox.shrink();
    // Leaving, it takes no taps (what is under it is the app's again) and lets go of the keyboard.
    final leaving = widget.child == null;
    return ExcludeFocus(
      excluding: leaving,
      child: IgnorePointer(ignoring: leaving, child: widget.builder(context, _curve, last)),
    );
  }
}

/// A piece that fades in while it moves a little way into place from [from] (a fraction of its own size), and back.
Widget fadeSlide(BuildContext context, Animation<double> shown, Widget child, {Offset from = const Offset(0, 0.15)}) {
  final still = reducedMotion(context);
  return FadeTransition(
    opacity: shown,
    child: still
        ? child
        : AnimatedBuilder(
            animation: shown,
            builder: (context, child) => FractionalTranslation(translation: from * (1 - shown.value), child: child),
            child: child,
          ),
  );
}
