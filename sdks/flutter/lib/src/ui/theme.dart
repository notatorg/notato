import 'package:flutter/widgets.dart';

/// Notato's colours: the web toolbar's, so the overlay reads as the same product as the board. The bar is always dark;
/// sheets and cards follow the app's light or dark.
abstract final class Bar {
  static const bar = Color(0xFF17181B);
  static const text = Color(0xFFECEDED);
  static const muted = Color(0xFF8B8F97);

  /// A pressed button on the bar, and the count's badge.
  static const pressed = Color(0xFF2A2C31);
  static const line = Color(0xFF33353A);
  static const accent = Color(0xFF45BFA8);
  static const onAccent = Color(0xFF0B1F1B);
}

abstract final class Brand {
  static const accent = Color(0xFF1F8A78);
  static const danger = Color(0xFFD6453D);
  static const selection = Color(0xFFE5484D);
  static const connected = Color(0xFF2E9A5B);
  static const connecting = Color(0xFFE9B44C);
  static const offline = Color(0xFFEF6B5E);
  static const scrim = Color(0x52121418);
}

/// The sheets' colours in light or dark.
class Palette {
  const Palette._({
    required this.background,
    required this.text,
    required this.muted,
    required this.line,
    required this.soft,
  });

  final Color background;
  final Color text;
  final Color muted;
  final Color line;

  /// Icon tiles and text fields.
  final Color soft;

  static const light = Palette._(
    background: Color(0xFFFFFFFF),
    text: Color(0xFF1D1F22),
    muted: Color(0xFF686C72),
    line: Color(0xFFE4E4DF),
    soft: Color(0xFFF2F2EF),
  );
  static const dark = Palette._(
    background: Color(0xFF1D1E21),
    text: Color(0xFFE6E7EA),
    muted: Color(0xFF8F939B),
    line: Color(0xFF2F3136),
    soft: Color(0xFF26272B),
  );

  static Palette of(BuildContext context) => MediaQuery.platformBrightnessOf(context) == Brightness.dark ? dark : light;
}

/// A pin's colour for its note's status.
Color statusColor(String status) => switch (status) {
  'acknowledged' => const Color(0xFFD99A1E),
  'resolved' => const Color(0xFF2E9A5B),
  'revert_requested' => const Color(0xFF8B5CF6),
  'variant_chosen' => const Color(0xFF0891B2),
  'reverted' => const Color(0xFF64748B),
  'dismissed' => const Color(0xFF9A9A9A),
  _ => Brand.accent,
};

/// At most [max] characters of [text], ending in an ellipsis when it was cut.
String clip(String text, int max) => text.length > max ? '${text.substring(0, max - 1)}…' : text;

/// "2h ago".
String? ago(String iso, [DateTime? now]) {
  final t = DateTime.tryParse(iso);
  if (t == null) return null;
  final s = (now ?? DateTime.now()).difference(t).inSeconds;
  if (s < 60) return 'just now';
  if (s < 3600) return '${s ~/ 60}m ago';
  if (s < 86400) return '${s ~/ 3600}h ago';
  return '${s ~/ 86400}d ago';
}
