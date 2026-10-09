import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/material.dart';

import 'icons.dart';
import 'motion.dart';
import 'theme.dart';

/// The icons' PNGs, decoded the first time each is drawn.
final _decoded = <String, Uint8List>{};
Uint8List _bytes(String name, String data) => _decoded[name] ??= base64Decode(data);

/// One of Notato's icons, tinted.
class NotatoIcon extends StatelessWidget {
  const NotatoIcon(this.name, {super.key, this.size = 20, required this.color});
  final String name;
  final double size;
  final Color color;

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: Image.memory(
      _bytes(name, notatoIcons[name]!),
      width: size,
      height: size,
      color: color,
      colorBlendMode: BlendMode.srcIn,
      gaplessPlayback: true,
    ),
  );
}

/// The Notato potato, tilted as on the web toolbar.
class Potato extends StatelessWidget {
  const Potato({super.key, required this.size});
  final double size;

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: Transform.rotate(
      angle: -8 * math.pi / 180,
      child: Image.memory(_bytes('potato', notatoPotato), width: size, height: size, gaplessPlayback: true),
    ),
  );
}

/// A floating bottom sheet, 8 points off the screen's edges, with a grabber, over a scrim. It slides up as it opens and
/// down as it closes ([child] null), and takes another sheet's height smoothly, the one fading into the other. Pulled
/// down far enough by its grabber, or with the scrim tapped, it closes; let go of sooner, it springs back.
class BottomSheetFrame extends StatefulWidget {
  const BottomSheetFrame({super.key, required this.close, required this.child});
  final VoidCallback close;

  /// The sheet, keyed by which it is (another key fades into it), or null for none.
  final Widget? child;

  @override
  State<BottomSheetFrame> createState() => _BottomSheetFrameState();
}

class _BottomSheetFrameState extends State<BottomSheetFrame> with TickerProviderStateMixin {
  late final _shown = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 300),
    reverseDuration: leave,
  );
  late final _slide = CurvedAnimation(parent: _shown, curve: enterCurve, reverseCurve: leaveCurve);

  /// How far the grabber has pulled it down.
  late final _pull = AnimationController.unbounded(vsync: this);

  /// The sheet shown, kept while it slides away.
  Widget? _last;

  @override
  void initState() {
    super.initState();
    _last = widget.child;
    if (_last != null) _shown.forward();
    _shown.addStatusListener((status) {
      if (status != AnimationStatus.dismissed || widget.child != null || !mounted) return;
      _pull.value = 0;
      setState(() => _last = null);
    });
  }

  @override
  void didUpdateWidget(BottomSheetFrame old) {
    super.didUpdateWidget(old);
    if (widget.child != null) {
      _last = widget.child;
      _shown.forward();
    } else {
      _shown.reverse();
    }
  }

  @override
  void dispose() {
    _slide.dispose();
    _shown.dispose();
    _pull.dispose();
    super.dispose();
  }

  void _let(DragEndDetails d) {
    if (_pull.value > 90 || (d.primaryVelocity ?? 0) > 900) {
      widget.close();
    } else {
      _pull.animateTo(0, duration: const Duration(milliseconds: 220), curve: enterCurve);
    }
  }

  @override
  Widget build(BuildContext context) {
    final last = _last;
    if (last == null) return const SizedBox.shrink();
    final p = Palette.of(context);
    final media = MediaQuery.of(context);
    final still = reducedMotion(context);
    // All the way off the screen: its own height, the gap under it, the keyboard, and its shadow.
    final below = 8 + media.viewInsets.bottom + 24;
    final sheet = ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 480),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: p.background,
          borderRadius: BorderRadius.circular(34),
          boxShadow: const [BoxShadow(color: Color(0x40000000), blurRadius: 20, offset: Offset(0, -6))],
        ),
        child: Padding(
          padding: EdgeInsets.fromLTRB(18, 0, 18, media.viewInsets.bottom > 0 ? 16 : 24),
          child: DefaultTextStyle(
            style: TextStyle(color: p.text, fontSize: 15),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onVerticalDragStart: (_) => _pull.stop(),
                  onVerticalDragUpdate: (d) => _pull.value = (_pull.value + d.delta.dy).clamp(0, 600),
                  onVerticalDragEnd: _let,
                  child: Padding(
                    padding: const EdgeInsets.only(top: 10, bottom: 10),
                    child: Center(
                      child: Container(
                        width: 36,
                        height: 5,
                        decoration: BoxDecoration(color: p.line, borderRadius: BorderRadius.circular(3)),
                      ),
                    ),
                  ),
                ),
                Flexible(
                  child: AnimatedSize(
                    duration: enter,
                    curve: enterCurve,
                    alignment: Alignment.topCenter,
                    child: AnimatedSwitcher(
                      duration: const Duration(milliseconds: 200),
                      reverseDuration: const Duration(milliseconds: 90),
                      layoutBuilder: (current, previous) =>
                          Stack(alignment: Alignment.topCenter, children: [...previous, ?current]),
                      child: last,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    final leaving = widget.child == null;
    return ExcludeFocus(
      excluding: leaving,
      child: IgnorePointer(
        ignoring: leaving,
        child: Stack(
          children: [
            Positioned.fill(
              child: FadeTransition(
                opacity: _shown,
                child: Semantics(
                  label: 'Close',
                  button: true,
                  child: GestureDetector(
                    onTap: widget.close,
                    child: const ColoredBox(color: Brand.scrim),
                  ),
                ),
              ),
            ),
            Positioned(
              left: 8,
              right: 8,
              bottom: 8 + media.viewInsets.bottom,
              top: media.padding.top + 8,
              child: Align(
                alignment: Alignment.bottomCenter,
                child: AnimatedBuilder(
                  animation: Listenable.merge([_slide, _pull]),
                  builder: (context, sheet) {
                    final away = 1 - _slide.value;
                    if (still) {
                      return Opacity(
                        opacity: _slide.value,
                        child: Transform.translate(offset: Offset(0, _pull.value), child: sheet),
                      );
                    }
                    return Transform.translate(
                      offset: Offset(0, _pull.value + below * away),
                      child: FractionalTranslation(translation: Offset(0, away), child: sheet),
                    );
                  },
                  child: sheet,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A sheet's first line: the potato, a back button or the note's pin; the title and a line under it; then a pill or
/// close.
class SheetHeader extends StatelessWidget {
  const SheetHeader({super.key, required this.title, this.subtitle, required this.leading, this.trailing});
  final String title;
  final String? subtitle;
  final Widget leading;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 2, 2, 6),
      child: Row(
        children: [
          leading,
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Semantics(
                  header: true,
                  child: Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700, letterSpacing: -0.4, color: p.text),
                  ),
                ),
                if (subtitle != null)
                  Text(
                    subtitle!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 12, color: p.muted),
                  ),
              ],
            ),
          ),
          if (trailing != null) ...[const SizedBox(width: 8), trailing!],
        ],
      ),
    );
  }
}

/// Back to the sheet this one was opened from (38 points), or close (30). Soft circles.
class HeaderButton extends StatelessWidget {
  const HeaderButton.back({super.key, required this.onPressed, this.label}) : back = true;
  const HeaderButton.close({super.key, required this.onPressed, this.label}) : back = false;
  final bool back;
  final VoidCallback onPressed;
  final String? label;

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final size = back ? 38.0 : 30.0;
    return Semantics(
      button: true,
      label: label ?? (back ? 'Back' : 'Close'),
      excludeSemantics: true,
      child: Material(
        color: p.soft,
        shape: const CircleBorder(),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onPressed,
          child: SizedBox(
            width: size,
            height: size,
            child: Center(
              child: NotatoIcon(back ? 'chevronLeft' : 'close', size: back ? 18 : 14, color: back ? p.text : p.muted),
            ),
          ),
        ),
      ),
    );
  }
}

/// How a sheet's button looks: plain, the accent (the action the sheet is for), red words, or red.
enum ButtonKind { plain, primary, danger, destructive }

/// A sheet's buttons: as wide as they can be.
class SheetButton extends StatelessWidget {
  const SheetButton(this.title, {super.key, this.kind = ButtonKind.plain, required this.onPressed});
  final String title;
  final ButtonKind kind;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final fill = switch (kind) {
      ButtonKind.primary => Brand.accent,
      ButtonKind.destructive => Brand.danger,
      _ => p.soft,
    };
    final ink = switch (kind) {
      ButtonKind.plain => p.text,
      ButtonKind.danger => Brand.danger,
      _ => Colors.white,
    };
    return Opacity(
      opacity: onPressed == null ? 0.45 : 1,
      child: Material(
        color: fill,
        borderRadius: BorderRadius.circular(14),
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: onPressed,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 50),
            child: Center(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 14),
                child: Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 15,
                    fontWeight: kind == ButtonKind.plain || kind == ButtonKind.danger
                        ? FontWeight.w600
                        : FontWeight.w700,
                    color: ink,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A note's pin: its number on its status's colour, ringed amber while it is not sent.
class PinDot extends StatelessWidget {
  const PinDot({super.key, required this.number, required this.status, this.pending = false, this.size = 24});
  final int number;
  final String status;
  final bool pending;
  final double size;

  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    alignment: Alignment.center,
    decoration: BoxDecoration(
      color: statusColor(status),
      shape: BoxShape.circle,
      border: Border.all(color: pending ? Brand.connecting : Colors.white, width: 2),
      boxShadow: const [BoxShadow(color: Color(0x4D141820), blurRadius: 3, offset: Offset(0, 2))],
    ),
    child: Text(
      number > 0 ? '$number' : '',
      style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w800),
    ),
  );
}

/// A sheet's 40-point tile: an icon, or a note's pin as the screen shows it.
class SheetTile extends StatelessWidget {
  const SheetTile.icon(this.icon, {super.key, this.style = TileStyle.plain, this.size = 40}) : pin = null;
  const SheetTile.pin(PinDot this.pin, {super.key, this.size = 40}) : icon = null, style = TileStyle.plain;
  final String? icon;
  final PinDot? pin;
  final TileStyle style;
  final double size;

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    return ExcludeSemantics(
      child: Container(
        width: size,
        height: size,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: style == TileStyle.primary ? Brand.accent : p.soft,
          borderRadius: BorderRadius.circular(12),
        ),
        child:
            pin ??
            NotatoIcon(
              icon!,
              color: switch (style) {
                TileStyle.primary => Colors.white,
                TileStyle.danger => Brand.danger,
                TileStyle.plain => p.text,
              },
            ),
      ),
    );
  }
}

/// How a tile's icon is drawn: plain, on the accent, or red.
enum TileStyle { plain, primary, danger }

/// A row of a sheet, as the menu's: a tile, a title with a line under it, and a chevron when it opens another sheet.
class MenuRow extends StatelessWidget {
  const MenuRow({
    super.key,
    required this.tile,
    required this.title,
    required this.detail,
    this.danger = false,
    this.titleLines = 1,
    this.opens = false,
    this.separated = false,
    required this.onTap,
  });
  final Widget tile;
  final String title;
  final String detail;
  final bool danger;
  final int titleLines;
  final bool opens;
  final bool separated;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final row = Material(
      type: MaterialType.transparency,
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 58),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 7, horizontal: 4),
            child: Row(
              children: [
                tile,
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        title,
                        maxLines: titleLines,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 15.5,
                          fontWeight: FontWeight.w600,
                          color: danger ? Brand.danger : p.text,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        detail,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 12.5, color: p.muted),
                      ),
                    ],
                  ),
                ),
                if (opens) Text('›', style: TextStyle(fontSize: 18, color: p.muted)),
              ],
            ),
          ),
        ),
      ),
    );
    if (!separated) return row;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 4, bottom: 4),
          child: Container(height: 1, color: p.line),
        ),
        row,
      ],
    );
  }
}

/// A switch with a line under its name saying what it does. The whole row flips it.
class FlagToggle extends StatelessWidget {
  const FlagToggle({
    super.key,
    required this.title,
    required this.hint,
    required this.value,
    required this.onChanged,
    this.tile,
  });
  final String title;
  final String hint;
  final bool value;
  final ValueChanged<bool>? onChanged;
  final Widget? tile;

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    return MergeSemantics(
      child: InkWell(
        onTap: onChanged == null ? null : () => onChanged!(!value),
        borderRadius: BorderRadius.circular(14),
        child: Padding(
          padding: tile == null ? EdgeInsets.zero : const EdgeInsets.symmetric(vertical: 7, horizontal: 4),
          child: Row(
            children: [
              if (tile != null) ...[tile!, const SizedBox(width: 14)],
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      title,
                      style: TextStyle(fontSize: tile == null ? 15 : 15.5, fontWeight: FontWeight.w600, color: p.text),
                    ),
                    const SizedBox(height: 2),
                    Text(hint, style: TextStyle(fontSize: 12.5, color: p.muted)),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              Switch(
                value: value,
                onChanged: onChanged,
                activeTrackColor: Brand.accent,
                activeThumbColor: Colors.white,
                inactiveTrackColor: p.line,
                inactiveThumbColor: Colors.white,
                trackOutlineColor: const WidgetStatePropertyAll(Colors.transparent),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A label over a text field.
class FieldLabel extends StatelessWidget {
  const FieldLabel(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 4),
    child: Text(
      text,
      style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: Palette.of(context).muted),
    ),
  );
}

/// A text field's look in a sheet or card.
InputDecoration fieldDecoration(BuildContext context, String hint) {
  final p = Palette.of(context);
  return InputDecoration(
    hintText: hint,
    hintStyle: TextStyle(color: p.muted, fontSize: 15),
    filled: true,
    fillColor: p.soft,
    isDense: true,
    contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
    border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide.none),
  );
}

/// Chips that pick one value, or none.
class Chips extends StatelessWidget {
  const Chips({super.key, required this.options, required this.value, required this.onChanged});
  final Map<String, String> options;
  final String? value;
  final ValueChanged<String?> onChanged;

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          for (final MapEntry(:key, value: label) in options.entries)
            Padding(
              padding: const EdgeInsets.only(right: 6),
              child: Semantics(
                button: true,
                selected: value == key,
                child: GestureDetector(
                  onTap: () => onChanged(value == key ? null : key),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 6),
                    decoration: BoxDecoration(
                      color: value == key ? Brand.accent : Colors.transparent,
                      border: Border.all(color: value == key ? Brand.accent : p.line),
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Text(
                      label,
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                        color: value == key ? Colors.white : p.text,
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// A status, intent or severity on a note's card.
class Badge extends StatelessWidget {
  const Badge(this.text, {super.key, required this.color});
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
    decoration: BoxDecoration(color: color.withValues(alpha: 0.14), borderRadius: BorderRadius.circular(999)),
    child: Text(
      text.replaceAll('_', ' '),
      style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: color),
    ),
  );
}

/// As the web toolbar draws it: no fill, a hairline, small muted capitals.
class PeopleOnlyBadge extends StatelessWidget {
  const PeopleOnlyBadge({super.key});

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    return Container(
      key: const ValueKey('NotatoPeopleOnlyBadge'),
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        border: Border.all(color: p.line),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        'PEOPLE ONLY',
        semanticsLabel: 'People only',
        style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700, letterSpacing: 0.4, color: p.muted),
      ),
    );
  }
}
