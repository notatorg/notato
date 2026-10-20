import 'dart:convert';

import 'package:crypto/crypto.dart';

/// Device preferences only. Feedback and its copy on the server are never changed.
class HiddenAnnotations {
  String? _signature;
  String _key = '';
  Map<String, Object?> _groups = {};
  String? encoded;
  Set<String> ids = {};

  static bool isCompleted(Object? status) => const ['resolved', 'reverted', 'dismissed'].contains(status);

  void select(List<String?> parts, String? saved) {
    final signature = jsonEncode(parts);
    if (_signature == signature && encoded == saved) return;
    _signature = signature;
    encoded = saved;
    _key = sha256.convert(utf8.encode(signature)).toString();
    try {
      final value = jsonDecode(saved ?? '{}');
      _groups = value is Map ? value.cast<String, Object?>() : {};
    } catch (_) {
      _groups = {};
    }
    final values = _groups[_key];
    ids = values is List ? values.whereType<String>().toSet() : {};
  }

  bool contains(Map<String, Object?> a) => isCompleted(a['status']) && ids.contains(a['id']);

  bool hide(Iterable<Map<String, Object?>> annotations) {
    final next = {...ids};
    for (final a in annotations) {
      final id = a['id'];
      if (isCompleted(a['status']) && id is String) next.add(id);
    }
    if (next.length == ids.length) return false;
    ids = next;
    _save();
    return true;
  }

  void clear() {
    ids = {};
    _save();
  }

  void _save() {
    _groups[_key] = ids.toList();
    encoded = jsonEncode(_groups);
  }
}
