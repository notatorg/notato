import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

import 'storage.dart';

/// Notes, screenshots and choices under the app's support folder, so test-mode notes and unsent ones survive a restart.
Future<NotatoStorage?> openStorage(String project) async {
  try {
    final base = await getApplicationSupportDirectory();
    final root = Directory('${base.path}/notato/${projectFolder(project)}');
    Directory('${root.path}/shots').createSync(recursive: true);
    return FileStorage(root);
  } catch (_) {
    return null;
  }
}

/// How long a file waits to be written after a change: a burst of changes is one write.
const writeDelay = Duration(milliseconds: 300);

/// A project's notes, screenshots and choices as files in a folder: `notes.json`, `settings.json` and `shots/`.
class FileStorage implements NotatoStorage {
  FileStorage(this.root);
  final Directory root;

  File _file(String name) => File('${root.path}/$name');
  File? _shot(String id) => safeId.hasMatch(id) ? File('${root.path}/shots/$id.png') : null;
  _Writer _writer(String name) => _Writer.of(_file(name));

  Object? _readJson(String name) {
    final writer = _writer(name);
    if (writer.has) return writer.value;
    for (final f in [_file(name), _file('$name.tmp')]) {
      try {
        // A write that stopped after the file was written beside the old one, before it was moved over it, leaves it.
        if (f.existsSync()) return jsonDecode(f.readAsStringSync());
      } catch (_) {
        // half a file: the next one, or nothing
      }
    }
    return null;
  }

  @override
  List<LocalNote> loadNotes() {
    final json = _readJson('notes.json');
    return json is List ? json.map(LocalNote.fromJson).whereType<LocalNote>().toList() : [];
  }

  @override
  void saveNotes(List<LocalNote> notes) => _writer('notes.json').save([for (final n in notes) n.toJson()]);

  @override
  List<int>? loadAsset(String id) {
    final f = _shot(id);
    return f != null && f.existsSync() ? f.readAsBytesSync() : null;
  }

  @override
  void saveAsset(String id, List<int> bytes) => _shot(id)?.writeAsBytesSync(bytes, flush: true);

  @override
  void deleteAsset(String id) {
    final f = _shot(id);
    if (f != null && f.existsSync()) f.deleteSync();
  }

  @override
  Map<String, Object?> loadSettings() {
    final json = _readJson('settings.json');
    return json is Map ? json.cast<String, Object?>() : {};
  }

  @override
  void saveSettings(Map<String, Object?> settings) => _writer('settings.json').save({...settings});

  @override
  String? writeShare(String name, List<int> bytes) {
    final f = File('${Directory.systemTemp.path}/$name');
    f.writeAsBytesSync(bytes, flush: true);
    return f.path;
  }
}

/// Writes one JSON file off the UI thread, once changes stop coming for a moment: whole, beside the file, then moved
/// over it, so a crash part way never leaves half a file. One per file, whoever opens it, and it keeps the last value
/// it was given: what is read is what was saved, written yet or not.
class _Writer {
  _Writer._(this.file);

  static final _all = <String, _Writer>{};
  static _Writer of(File file) => _all[file.path] ??= _Writer._(file);

  final File file;
  Object? _value;

  /// Something was saved through it: [value] is the file's content, whether or not it is on the disk yet.
  var has = false;
  Timer? _timer;
  var _writing = false;
  var _again = false;
  Completer<void>? _settled;

  Object? get value => _value;

  void save(Object? value) {
    _value = value;
    has = true;
    _timer ??= Timer(writeDelay, _write);
  }

  Future<void> _write() async {
    _timer = null;
    // One at a time: two at once would write the same file beside it. One saved meanwhile is written next.
    if (_writing) {
      _again = true;
      return;
    }
    _writing = true;
    try {
      do {
        _again = false;
        final text = jsonEncode(_value);
        try {
          final tmp = File('${file.path}.tmp');
          await tmp.writeAsString(text, flush: true);
          await tmp.rename(file.path);
        } catch (_) {
          // a full disk: kept in memory for this run
        }
      } while (_again);
    } finally {
      _writing = false;
      if (_timer == null) {
        _settled?.complete();
        _settled = null;
      }
    }
  }

  /// For tests: done when what was saved so far is on the disk.
  Future<void> get settled => _timer == null && !_writing ? Future.value() : (_settled ??= Completer<void>()).future;
}

/// For tests: done when everything saved so far through any [FileStorage] is on the disk.
Future<void> debugStorageSettled() => Future.wait([for (final w in _Writer._all.values) w.settled]);
