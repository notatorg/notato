import 'storage_memory.dart';
import 'storage_web.dart' if (dart.library.io) 'storage_io.dart' as platform;

/// A note this device keeps: made here and not sent yet (test mode keeps every note this way).
class LocalNote {
  /// A note to keep, with why it has not gone, if the server said.
  const LocalNote(this.annotation, {this.failed, this.waiting});

  /// The note, as the server would keep it.
  final Map<String, Object?> annotation;

  /// The server refused it for good (malformed, too large): kept to read or delete, never sent again.
  final String? failed;

  /// The server will not take it yet (an unknown project, a token that may not write): sent again later.
  final String? waiting;

  /// The note as JSON, for a storage that writes it out.
  Map<String, Object?> toJson() => {'annotation': annotation, 'failed': ?failed, 'waiting': ?waiting};

  /// A note [toJson] wrote, or null when [json] is not one.
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
/// Every call is synchronous and made on the UI thread, so keep each one quick: the default storage writes its JSON
/// files a moment later, off the UI thread.
abstract interface class NotatoStorage {
  /// The notes kept: those not sent yet, and in test mode every one made here.
  List<LocalNote> loadNotes();

  /// Keeps these notes in place of those kept before.
  void saveNotes(List<LocalNote> notes);

  /// A screenshot's PNG, by its id, or null when it is not kept.
  List<int>? loadAsset(String id);

  /// Keeps a screenshot's PNG under its id.
  void saveAsset(String id, List<int> bytes);

  /// Forgets a screenshot, once its note is on the server or deleted.
  void deleteAsset(String id);

  /// The person's choices: on or off, the toolbar and where it was left, a name, a server typed in.
  Map<String, Object?> loadSettings();

  /// Keeps the person's choices in place of those kept before.
  void saveSettings(Map<String, Object?> settings);

  /// Writes a package to share, returning its path, or null where there are no files (the web).
  String? writeShare(String name, List<int> bytes);
}

/// Opens where a project's notes are kept: a `Notato(storage:)` option.
typedef NotatoStorageFactory = Future<NotatoStorage> Function(String project);

/// The default storage: the app's support folder, under `notato/<project>`, where there is one; memory on the web, or
/// when the folder cannot be made or found within a few seconds.
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
