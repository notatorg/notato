import 'annotation.dart';
import 'controller.dart';

/// A screen's notes, numbered as their pins are.
typedef ScreenNotes = List<({int number, NoteRecord record})>;

/// Notes in the order they were made: oldest first, then by id.
int _madeOrder(NoteRecord a, NoteRecord b) {
  final byTime = a.createdAt.compareTo(b.createdAt);
  return byTime != 0 ? byTime : a.id.compareTo(b.id);
}

/// Every note Notato knows of, in the order it came to know them, found by id and by screen. The list is replaced whole
/// on each change (the app reads it), never changed in place.
class NoteBook {
  List<NoteRecord> _records = const [];

  /// Where each note is in [_records], by id.
  var _at = <String, int>{};

  /// How many notes are pending, kept as they change.
  var _pendingCount = 0;

  /// Each screen's notes, numbered: worked out when asked, and again only when one of them changed.
  final _screens = <String, ScreenNotes>{};
  final _pinned = Expando<ScreenNotes>('notato pins');

  /// Every note, in the order Notato came to know them.
  List<NoteRecord> get all => _records;

  /// Notes made here that the server does not have yet.
  int get pendingCount => _pendingCount;

  /// The note with this id.
  NoteRecord? operator [](String id) {
    final i = _at[id];
    return i == null ? null : _records[i];
  }

  /// Replaces every note at once (a load, another server): where each is, the count and the screens start again.
  void replaceAll(List<NoteRecord> next) {
    _records = next;
    _at = {for (final (i, r) in next.indexed) r.id: i};
    _pendingCount = next.where((r) => r.pending).length;
    _screens.clear();
  }

  /// Changes some notes in one go (see [NoteEdit]). Whether anything changed.
  bool edit(void Function(NoteEdit notes) apply) {
    final edit = NoteEdit._(this);
    apply(edit);
    return edit._finish();
  }

  /// Changes one note, or removes it when [change] gives nothing back.
  void update(String id, NoteRecord? Function(NoteRecord r) change) => edit((notes) {
    final r = notes[id];
    if (r == null) return;
    final updated = change(r);
    if (updated == null) {
      notes.remove(id);
    } else if (!identical(updated, r)) {
      notes.put(updated);
    }
  });

  /// The notes on a screen, oldest first, numbered as their pins are. Worked out the first time a screen is asked for,
  /// and again only after one of its notes changed.
  ScreenNotes notesOn(String route) {
    final key = routeName(route);
    return _screens[key] ??= () {
      final here = _records.where((r) => r.route == key).toList()..sort(_madeOrder);
      return here.isEmpty
          ? const <({int number, NoteRecord record})>[]
          : [for (final (i, r) in here.indexed) (number: i + 1, record: r)];
    }();
  }

  /// The notes on a screen that get a pin here: those made in a Flutter app. A note from another platform (the web's,
  /// iOS's) is in the Notes list with its number, without a pin: its selector names something else.
  ScreenNotes pinsOn(String route) {
    final here = notesOn(route);
    return _pinned[here] ??= () {
      final own = [
        for (final n in here)
          if ((n.record.annotation['environment'] as Map?)?['platform'] == notatoPlatform) n,
      ];
      return own.length == here.length ? here : own;
    }();
  }
}

/// Some notes changed in one go: one copy of the list however many change, the pending count kept as they do, and
/// only the screens they are on worked out again.
class NoteEdit {
  NoteEdit._(this._book);
  final NoteBook _book;
  List<NoteRecord>? _next;

  /// Removed in this change: left in the list until it is handed over, then taken out in one pass.
  final _gone = <String>{};
  final _touched = <String>{};

  List<NoteRecord> get _list => _next ??= List.of(_book._records);

  /// The note with this id, as this change leaves it so far.
  NoteRecord? operator [](String id) {
    final i = _book._at[id];
    return i == null || _gone.contains(id) ? null : (_next ?? _book._records)[i];
  }

  /// Replaces the note with its id, or adds it at the end.
  void put(NoteRecord record) {
    final list = _list;
    final i = _book._at[record.id];
    if (i != null) {
      final old = list[i];
      if (!_gone.remove(record.id)) {
        _touched.add(old.route);
        if (old.pending) _book._pendingCount--;
      }
      list[i] = record;
    } else {
      _book._at[record.id] = list.length;
      list.add(record);
    }
    _touched.add(record.route);
    if (record.pending) _book._pendingCount++;
  }

  /// Removes the note with this id, if there is one.
  void remove(String id) {
    final i = _book._at[id];
    if (i == null || _gone.contains(id)) return;
    final old = _list[i];
    _gone.add(id);
    _touched.add(old.route);
    if (old.pending) _book._pendingCount--;
  }

  /// Hands the changed list to the book. Whether anything changed.
  bool _finish() {
    final next = _next;
    if (next == null) return false;
    if (_gone.isEmpty) {
      _book._records = next;
    } else {
      _book._records = [
        for (final r in next)
          if (!_gone.contains(r.id)) r,
      ];
      _book._at = {for (final (i, r) in _book._records.indexed) r.id: i};
    }
    _touched.forEach(_book._screens.remove);
    return true;
  }
}
