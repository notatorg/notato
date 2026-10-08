import 'package:flutter/foundation.dart';

import 'annotation.dart';
import 'config.dart';
import 'runtime.dart';

/// How Notato stands with its server.
enum NotatoConnection {
  /// Notato is switched off.
  disabled,

  /// No server: notes stay on the device (test mode) until packaged.
  local,

  /// Opening the connection to the server, or opening it again.
  connecting,

  /// Connected: notes go to the server as they are made, and its changes arrive live.
  connected,

  /// The server cannot be reached. Notes are kept and sent when it can.
  offline,

  /// The server refused this app (a missing or wrong token, a project the token cannot use).
  refused,
}

/// A note Notato knows of: from the server, or made here and not sent yet.
@immutable
class NoteRecord {
  /// A note, as the JSON the server keeps it in.
  const NoteRecord(this.annotation, {this.pending = false, this.failed, this.waiting, this.mine = false});

  /// The note as the server keeps it: the schema's Annotation.
  final Map<String, Object?> annotation;

  /// Made here and not yet taken by the server (or, in test mode, not yet packaged).
  final bool pending;

  /// Why the server refused it for good: it stays on the device, marked failed, and is not sent again.
  final String? failed;

  /// Why it has not been sent yet, when the server said (a project it does not know, a token it does not take).
  final String? waiting;

  /// Made on this device.
  final bool mine;

  /// The note's id: a ULID.
  String get id => annotation['id'] as String;

  /// The screen it was made on, always with its leading slash.
  String get route => routeName(annotation['route'] as String?);

  /// Where the note stands: `open`, `acknowledged`, `resolved`, `revert_requested`…
  String get status => annotation['status'] as String? ?? 'open';

  /// When it was made, as an ISO 8601 date.
  String get createdAt => annotation['createdAt'] as String? ?? '';

  /// Kept between people: the agent never sees it.
  bool get peopleOnly => annotation['peopleOnly'] == true;

  /// The same note with some of it changed. Whether it was made here stays.
  NoteRecord copyWith({Map<String, Object?>? annotation, bool? pending, String? failed, String? waiting}) => NoteRecord(
    annotation ?? this.annotation,
    pending: pending ?? this.pending,
    failed: failed ?? this.failed,
    waiting: waiting ?? this.waiting,
    mine: mine,
  );
}

/// Notato at runtime: there is one per app, [notato]. The `Notato` widget configures it; the app can switch it on and
/// off, show the toolbar, select a widget or annotate one from code, and listen to it for its state.
///
/// ```dart
/// ListenableBuilder(
///   listenable: notato,
///   builder: (context, _) => Switch(value: notato.isEnabled, onChanged: notato.setEnabled),
/// )
/// ```
abstract interface class NotatoController implements Listenable {
  /// Whether Notato is on: the toolbar and pins are drawn, and notes go to the server.
  bool get isEnabled;

  /// Whether the toolbar is shown. Hidden, Notato is still on, and the app can drive it from code.
  bool get isToolbarVisible;

  /// Whether the next tap selects what is under it.
  bool get isAnnotating;

  /// The mode Notato was started in.
  NotatoMode get mode;

  /// How Notato stands with its server.
  NotatoConnection get connection;

  /// The agents connected to the project, by name.
  List<String> get agents;

  /// The notes Notato knows of for this project, from the server and from this device, in the order it came to know
  /// them. A new list each time they change.
  List<NoteRecord> get notes;

  /// Notes made on this device that have not reached the server yet.
  int get pendingCount;

  /// Switches Notato on. Remembered across launches unless `rememberRuntimeState` is off, and it wins over the
  /// `enabled` option until [resetRuntimeState].
  void enable();

  /// Switches Notato off: removes the overlay and closes the connection. Remembered like [enable].
  void disable();

  /// Switches Notato on or off, as [enable] and [disable] do.
  void setEnabled(bool on);

  /// Forgets the choices made at runtime (on or off, the toolbar, a name, a server typed in) and goes back to the
  /// `Notato` widget's options.
  void resetRuntimeState();

  /// Shows the toolbar.
  void showToolbar();

  /// Hides the toolbar. Notato stays on: the app can still drive it from code, and bring the toolbar back.
  void hideToolbar();

  /// The next tap selects what is under it, as the toolbar's Annotate does.
  void startAnnotating();

  /// Stops annotating, and closes a note being written.
  void stopAnnotating();

  /// Selects a widget as if it had been tapped, and opens the note for it. [target] is a selector (`'#save'`,
  /// `'ProductCard > Text'`), a `GlobalKey`, or a widget's `BuildContext`. Throws a `NotatoException` when Notato is off
  /// or nothing matches.
  Future<void> select(Object target);

  /// Makes a note with no UI, as a person or (with [agentName]) an agent: finds the widget, takes the screenshot, and
  /// files it. [target] is what [select] takes. [peopleOnly] keeps a person's note from the agent. Returns the note, and
  /// throws a `NotatoException` when Notato is off or nothing matches.
  Future<Map<String, Object?>> annotate(
    Object target,
    String comment, {
    String? intent,
    String? severity,
    String? agentName,
    List<Map<String, Object?>>? steps,
    bool screenshot = true,
    bool peopleOnly = false,
  });

  /// Test mode: packages this device's notes as a bundle zip (`feedback.md`, `annotations.json`, `shots/`), the format
  /// `notato_import_bundle` reads, and uploads it when a server is set and [upload] is on. Returns the zip, its file
  /// name, where it was written (null where there are no files, as on the web), and whether it was uploaded.
  Future<({List<int> zip, String name, String? path, bool uploaded})> packageNotes({bool upload = true});

  /// Adds an HTTP request to the `network` context of the notes made after it. The last 50 are kept; a URL's query and
  /// fragment are left out.
  void recordRequest({
    required String method,
    required String url,
    required int status,
    required Duration duration,
    DateTime? at,
  });
}

/// Notato at runtime, for the app to switch on and off, show, and annotate from code. Listen to it for its state.
final NotatoController notato = runtime;
