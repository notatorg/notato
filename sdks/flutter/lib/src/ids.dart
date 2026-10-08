import 'dart:math';

const _crockford = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
final _random = Random.secure();

/// A ULID: 26 characters that sort by time, as every Notato SDK makes an annotation's id.
String ulid([DateTime? now]) {
  var time = (now ?? DateTime.now()).millisecondsSinceEpoch;
  final out = StringBuffer();
  final head = List<String>.filled(10, '0');
  for (var i = 9; i >= 0; i--) {
    head[i] = _crockford[time % 32];
    time ~/= 32;
  }
  out.writeAll(head);
  for (var i = 0; i < 16; i++) {
    out.write(_crockford[_random.nextInt(32)]);
  }
  return out.toString();
}
