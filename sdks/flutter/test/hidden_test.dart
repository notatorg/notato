import 'package:flutter_test/flutter_test.dart';
import 'package:notato/src/config.dart';
import 'package:notato/src/controller.dart';
import 'package:notato/src/hidden.dart';
import 'package:notato/src/runtime.dart';
import 'package:notato/src/storage_memory.dart';

import 'annotation_test.dart' show note;

void main() {
  test('hiding keeps feedback, survives restart and reveals reopened tasks and questions', () async {
    final storage = MemoryStorage();
    final config = NotatoConfig(project: 'shop', enabled: false);
    final runtime = NotatoRuntime();
    await runtime.configure(config, storage: (_) async => storage);
    final notes = List.generate(
      2001,
      (i) => NoteRecord({...note(), 'id': 'note-$i', 'route': i.isEven ? '/one' : '/two', 'status': 'resolved'}),
    );
    runtime.debugSetRecords(notes);
    runtime.hideAnnotation(notes[0].id);
    expect(runtime.hiddenCount, 1);
    runtime.hideCompleted();
    expect(runtime.hiddenCount, 2001);
    expect(runtime.notes.length, 2001);
    expect(runtime.notesOn('/one'), isEmpty);
    expect(runtime.pinsOn('/two'), isEmpty);

    final reload = NotatoRuntime();
    await reload.configure(config, storage: (_) async => storage);
    reload.debugSetRecords(notes);
    expect(reload.visibleCount, 0);
    final updated = [
      NoteRecord({...notes[0].annotation, 'status': 'open'}),
      NoteRecord({...notes[1].annotation, 'status': 'awaiting_response'}),
      ...notes.skip(2),
    ];
    reload.debugSetRecords(updated);
    expect(reload.notesOn('/one').length, 1);
    expect(reload.notesOn('/two').length, 1);
    reload.hideAnnotation(updated[0].id);
    expect(reload.visibleCount, 2);
    reload.restoreHidden();
    expect(reload.visibleCount, 2001);
    expect(reload.hiddenCount, 0);
    runtime.dispose();
    reload.dispose();
  });

  test('preferences are private to each connection and person without storing credentials', () {
    final hidden = HiddenAnnotations();
    final parts = ['https://stub.test', 'shop', 'dev', 'credential', 'Alice'];
    hidden.select(parts, null);
    final a = {...note(), 'status': 'reverted'};
    expect(hidden.hide([a]), isTrue);
    final saved = hidden.encoded;
    expect(saved, isNot(contains('credential')));
    for (var i = 0; i < parts.length; i++) {
      hidden.select([for (var j = 0; j < parts.length; j++) i == j ? 'other' : parts[j]], saved);
      expect(hidden.contains(a), isFalse);
    }
    hidden.select(parts, saved);
    expect(hidden.contains(a), isTrue);
  });
}
