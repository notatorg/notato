import 'dart:convert';

import 'package:archive/archive.dart';

import 'ids.dart';

/// A test-mode package: the notes as `annotations.json` (the schema's Bundle) and their screenshots under `shots/`, the
/// zip every SDK writes and `notato_import_bundle` reads.
({List<int> zip, Map<String, Object?> bundle, String name}) writeBundle(
  List<Map<String, Object?>> notes, {
  required String project,
  String? author,
  String? appName,
  String? appVersion,
  DateTime? now,
  required List<int>? Function(String id) assetOf,
}) {
  final at = now ?? DateTime.now();
  final id = ulid(at);
  final archive = Archive();
  String pad(int n) => n.toString().padLeft(2, '0');
  final annotations = <Map<String, Object?>>[];
  for (var i = 0; i < notes.length; i++) {
    final a = notes[i];
    final n = pad(i + 1);
    final placed = {...a, 'bundleId': id};
    final shots = a['screenshots'];
    if (shots is Map) {
      final full = shots['full'] is Map ? (shots['full'] as Map).cast<String, Object?>() : null;
      final crop = shots['crop'] is Map ? (shots['crop'] as Map).cast<String, Object?>() : null;
      final fullBytes = full == null ? null : assetOf(full['id'] as String);
      final cropBytes = crop == null ? null : assetOf(crop['id'] as String);
      if (full != null && fullBytes != null) {
        final fullRef = {...full, 'path': 'shots/$n-full.png'};
        archive.addFile(ArchiveFile.bytes(fullRef['path'] as String, fullBytes)..compression = CompressionType.none);
        Map<String, Object?>? cropRef;
        if (crop != null && cropBytes != null) {
          cropRef = {...crop, 'path': 'shots/$n-crop.png'};
          archive.addFile(ArchiveFile.bytes(cropRef['path'] as String, cropBytes)..compression = CompressionType.none);
        }
        placed['screenshots'] = {'full': fullRef, 'crop': ?cropRef};
      } else {
        placed.remove('screenshots');
      }
    }
    annotations.add(placed);
  }
  final bundle = <String, Object?>{
    'id': id,
    'projectId': project,
    'createdAt': at.toUtc().toIso8601String(),
    'author': {'name': ?author},
    'appName': ?appName,
    'appVersion': ?appVersion,
    'annotations': annotations,
    'schemaVersion': 1,
  };
  archive.addFile(ArchiveFile.string('annotations.json', const JsonEncoder.withIndent('  ').convert(bundle)));
  final feedback = StringBuffer('# Feedback on ${appName ?? project}\n\n');
  for (final a in annotations) {
    final pin = ((a['context'] as Map?)?['screenshot'] as Map?)?['pin'];
    final target = (((a['target'] as Map?)?['identity'] as List?)?.firstOrNull as Map?)?['selector'] ?? '';
    feedback.writeln('- **#${pin ?? '?'}** ${a['comment']} (`$target` on ${a['route']})');
  }
  archive.addFile(ArchiveFile.string('feedback.md', feedback.toString()));
  return (zip: ZipEncoder().encode(archive), bundle: bundle, name: 'notato-$project-$id.zip');
}
