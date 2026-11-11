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
    for (final r in notes) {
      runtime.hideAnnotation(r.id);
    }
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

  test('hide done hides every finished note, including ones finished later, and is remembered', () async {
    final storage = MemoryStorage();
    final config = NotatoConfig(project: 'shop', enabled: false);
    final runtime = NotatoRuntime();
    await runtime.configure(config, storage: (_) async => storage);
    NoteRecord at(String id, String status) => NoteRecord({...note(), 'id': id, 'route': '/one', 'status': status});
    final notes = [at('a', 'resolved'), at('b', 'reverted'), at('c', 'dismissed'), at('d', 'open')];
    runtime.debugSetRecords(notes);
    expect(runtime.hideDone, isFalse);
    expect(runtime.visibleCount, 4);

    runtime.setHideDone(true);
    expect([for (final n in runtime.notesOn('/one')) n.record.id], ['d']);
    expect(runtime.pinsOn('/one').single.number, 4);
    expect(runtime.visibleCount, 1);
    expect(runtime.hiddenCount, 0, reason: 'one at a time hiding is kept apart');
    expect(runtime.notes.length, 4, reason: 'the feedback itself is kept');

    // Finished after the switch went on: hidden too.
    final finishedLater = [...notes.take(3), at('d', 'resolved')];
    runtime.debugSetRecords(finishedLater);
    expect(runtime.notesOn('/one'), isEmpty);
    expect(runtime.visibleCount, 0);

    // Reopened: back by itself.
    final reopened = [at('a', 'open'), ...finishedLater.skip(1)];
    runtime.debugSetRecords(reopened);
    expect([for (final n in runtime.notesOn('/one')) n.record.id], ['a']);

    // Remembered across a restart.
    expect(storage.loadSettings()['hideDone'], isTrue);
    final reload = NotatoRuntime();
    await reload.configure(config, storage: (_) async => storage);
    reload.debugSetRecords(reopened);
    expect(reload.hideDone, isTrue);
    expect(reload.visibleCount, 1);

    // Off: every note again, apart from one hidden on its own.
    reload.hideAnnotation('b');
    reload.setHideDone(false);
    expect(reload.visibleCount, 3);
    expect([for (final n in reload.pinsOn('/one')) n.record.id], unorderedEquals(['a', 'c', 'd']));
    reload.restoreHidden();
    expect(reload.visibleCount, 4);
    expect(storage.loadSettings()['hideDone'], isFalse);
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
