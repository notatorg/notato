import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:notato/notato.dart';
import 'package:notato/src/storage_io.dart';

void main() {
  late Directory dir;
  setUp(() => dir = Directory.systemTemp.createTempSync('notato-storage'));
  tearDown(() => dir.deleteSync(recursive: true));

  const note = LocalNote({'id': 'a', 'comment': 'Kept'});

  test('writes notes once a burst of changes is over, off the UI thread, whole, then moved into place', () async {
    final storage = FileStorage(dir);
    final file = File('${dir.path}/notes.json');
    for (var i = 0; i < 20; i++) {
      storage.saveNotes([note]);
    }
    // Nothing on the disk yet, and what was saved is what a load reads.
    expect(file.existsSync(), isFalse);
    expect(storage.loadNotes().single.annotation['id'], 'a');
    await debugStorageSettled();
    expect(jsonDecode(file.readAsStringSync()), [
      {
        'annotation': {'id': 'a', 'comment': 'Kept'},
      },
    ]);
    expect(File('${dir.path}/notes.json.tmp').existsSync(), isFalse);
  });

  test('reads the notes a write left beside the file when it stopped before moving them in', () {
    File('${dir.path}/notes.json.tmp').writeAsStringSync(jsonEncode([note.toJson()]));
    expect(FileStorage(dir).loadNotes().single.annotation['comment'], 'Kept');
  });
}
