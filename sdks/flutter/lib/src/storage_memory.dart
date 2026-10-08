import 'storage.dart';

/// Keeps everything in memory: gone when the app restarts.
class MemoryStorage implements NotatoStorage {
  var _notes = <LocalNote>[];
  var _settings = <String, Object?>{};
  final _assets = <String, List<int>>{};

  @override
  bool get persistent => false;
  @override
  List<LocalNote> loadNotes() => _notes;
  @override
  void saveNotes(List<LocalNote> notes) => _notes = notes;
  @override
  List<int>? loadAsset(String id) => _assets[id];
  @override
  void saveAsset(String id, List<int> bytes) => _assets[id] = bytes;
  @override
  void deleteAsset(String id) => _assets.remove(id);
  @override
  Map<String, Object?> loadSettings() => _settings;
  @override
  void saveSettings(Map<String, Object?> settings) => _settings = settings;
  @override
  String? writeShare(String name, List<int> bytes) => null;
}
