import 'storage_memory.dart';
import 'storage_web.dart' if (dart.library.io) 'storage_io.dart' as platform;

/// A note this device knows: made here and not sent yet (test mode keeps every note this way).
class LocalNote {
  const LocalNote(this.annotation, {this.failed, this.waiting});
  final Map<String, Object?> annotation;

  /// The server refused it for good (malformed, too large): kept to read or delete, never sent again.
  final String? failed;

  /// The server will not take it yet (an unknown project, a token that may not write): sent again later.
  final String? waiting;

  Map<String, Object?> toJson() => {'annotation': annotation, 'failed': ?failed, 'waiting': ?waiting};

  static LocalNote? fromJson(Object? json) {
    if (json is! Map || json['annotation'] is! Map) return null;
    return LocalNote(
      (json['annotation'] as Map).cast<String, Object?>(),
      failed: json['failed'] as String?,
      waiting: json['waiting'] as String?,
    );
  }
}

/// What a device keeps between launches: its notes, their screenshots, the person's choices, and packages to share.
abstract class NotatoStorage {
  bool get persistent;
  List<LocalNote> loadNotes();
  void saveNotes(List<LocalNote> notes);
  List<int>? loadAsset(String id);
  void saveAsset(String id, List<int> bytes);
  void deleteAsset(String id);
  Map<String, Object?> loadSettings();
  void saveSettings(Map<String, Object?> settings);

  /// Writes a package to share, returning its path, or null where there are no files (the web).
  String? writeShare(String name, List<int> bytes);
}

/// Opens where a project's notes are kept: a `Notato(storage:)` option.
typedef NotatoStorageFactory = Future<NotatoStorage> Function(String project);

/// The app's support folder, under `notato/<project>`, where there is one; memory on the web, or when the folder cannot
/// be made or found within a few seconds.
Future<NotatoStorage> openStorage(String project) async {
  final opened = await platform.openStorage(project).timeout(const Duration(seconds: 5), onTimeout: () => null);
  return opened ?? MemoryStorage();
}

/// Ids that may name a file: the schema's SafeId, so one from the server (`../..`) can never leave the folder.
final safeId = RegExp(r'^[A-Za-z0-9_-]{1,128}$');

/// A project's folder: its id when that is a safe name (every id the server takes is), else one made from its bytes.
String projectFolder(String project) {
  if (RegExp(r'^[A-Za-z0-9_.@-]+$').hasMatch(project) && project != '.' && project != '..') return project;
  return 'p-${project.codeUnits.map((c) => c.toRadixString(16)).join()}';
}
