import 'dart:ui';

/// Where pins go: each at its element's top right, and moved aside when another pin is there already (several notes on
/// one element, or on elements next to each other). The Swift SDK's PinLayout.
const _clearance = 20.0;
const _step = 22.0;
const _margin = 2.0;
const _sideways = 8;
const _rows = 4;

final _offsets = [0.0, for (var i = 1; i <= _sideways; i++) -i * _step, for (var i = 1; i <= _sideways; i++) i * _step];

/// The top left of each pin, in order: the first to claim a place keeps it. [top] keeps them below the status bar.
List<Offset> placePins(List<Rect> rects, double width, {double top = 50}) {
  final placed = <Offset>[];
  final maxX = width - 26 > _margin ? width - 26 : _margin;
  for (final r in rects) {
    final first = Offset((r.right - 12).clamp(_margin, maxX), r.top - 12 > top ? r.top - 12 : top);
    placed.add(_free(first, maxX, placed) ?? first);
  }
  return placed;
}

Offset? _free(Offset first, double maxX, List<Offset> placed) {
  for (var row = 0; row < _rows; row++) {
    for (final offset in _offsets) {
      final spot = Offset(first.dx + offset, first.dy + row * _step);
      if (spot.dx < _margin || spot.dx > maxX) continue;
      if (!placed.any((p) => (p.dx - spot.dx).abs() < _clearance && (p.dy - spot.dy).abs() < _clearance)) return spot;
    }
  }
  return null;
}
