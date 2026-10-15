import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'annotation.dart';
import 'bundle.dart';
import 'client.dart';
import 'config.dart';
import 'controller.dart';
import 'events.dart';
import 'identity.dart';
import 'ids.dart';
import 'logs.dart';
import 'note_book.dart';
import 'storage.dart';
import 'storage_memory.dart';

/// What the overlay does for the runtime: it knows the app's widgets and draws over them.
abstract interface class NotatoHost {
  /// The widget a selector (`ProductCard > Text#price`), a `GlobalKey` or a `BuildContext` names, inspected. Throws a
  /// [NotatoException] when there is none.
  Future<Picked> resolve(Object target);

  /// The screenshots for a note: the screen with the widget outlined and numbered, and a crop of it.
  Future<({Shot? full, Shot? crop})> capture(Picked picked, int pin, String id);

  /// Opens the composer on a widget, as a tap would.
  void select(Picked picked);

  /// The screen the person is on, as notes are filed under it.
  String route();

  /// The device and window the note is made on.
  DeviceInfo device();

  /// Shows a short message over the app.
  void toast(String message);

  /// Offers a file to the share sheet. False when nothing was shared.
  Future<bool> share(String path);
}

/// What became of one attempt to send a note.
sealed class SendOutcome {
  const SendOutcome();
}

/// The server has it.
class Sent extends SendOutcome {
  const Sent();
}

/// The server will never take it as it is: marked failed, kept, and the notes after it still go.
class Refused extends SendOutcome {
  const Refused(this.reason);
  final String reason;
}

/// Not now: no connection, or the server answered and did not take it. It and the notes after it wait.
class Held extends SendOutcome {
  const Held(this.error);
  final NotatoException error;
}

/// Nothing was sent: no server, or it was sent, refused or deleted already, or is on its way.
class Skipped extends SendOutcome {
  const Skipped();
}

/// How long the server's changes are gathered before they are applied together: about a frame.
const _batch = Duration(milliseconds: 16);

/// How old the server's word on screenshots may be before it is asked again, and how long a screenshot waits for it.
const _policyFresh = Duration(seconds: 5);
const _policyWait = Duration(milliseconds: 1500);

/// Capture-only: the pause before notes that could not go are tried again, doubled each time, up to the longest.
const _firstResend = Duration(seconds: 3);
const _longestResend = Duration(seconds: 60);

/// What a capture-only app is told when it tries to read or change a note it sent.
const _onTheBoard = 'This app can only send notes: read, reply to and change them on the Notato board.';

/// A change the server's events bring: a note as it is now, or the id of one it deleted.
typedef _Change = ({Map<String, Object?>? annotation, String? deleted});

/// A reason as the end of a sentence.
String _sentence(String reason) => reason.endsWith('.') ? reason : '$reason.';

/// What to tell the person who just made the note, or null when it went.
String? _problemOf(SendOutcome outcome) => switch (outcome) {
  Refused(:final reason) => 'The server refused it: $reason',
  Held(:final error) when error.status == null => "Saved. It's sent when the server can be reached.",
  Held(:final error) => 'Saved on this device, not sent: ${error.message}',
  _ => null,
};

/// The one [NotatoController]: [notato] to the app, [runtime] to the overlay, which also configures it, makes notes
/// through it, and draws its state.
final runtime = NotatoRuntime();

/// Notato's state and everything it does, for the app ([NotatoController]) and for its own overlay.
class NotatoRuntime extends ChangeNotifier implements NotatoController {
  NotatoConfig? _config;
  NotatoStorage _storage = MemoryStorage();
  Map<String, Object?> _settings = {};
  final _notes = NoteBook();

  /// Screenshots of the notes not sent yet, kept in memory as well as in [_storage].
  final _assets = <String, List<int>>{};

  /// Notes on their way to the server now, and what will come of it.
  final _inflight = <String, Future<SendOutcome>>{};

  /// The server's changes not applied yet: those that come within a frame are applied together.
  final _incoming = <_Change>[];
  Timer? _applyTimer;

  /// While the server's list is being read: the changes that came meanwhile, applied again over it.
  List<_Change>? _listing;

  /// The agent's annotate requests waiting to be answered: one at a time, since two at once would photograph each
  /// other's outlines. (A queue and a runner, not a chain of futures: the runtime outlives the zone it started in.)
  final _relays = <Future<void> Function()>[];
  var _relaying = false;

  /// Deleted here while a copy was on its way: the server's word of them is not taken back in.
  final _deletedHere = <String>{};
  NotatoClient? _client;
  EventFollower? _follower;
  NotatoHost? _host;
  final _logs = <Map<String, Object?>>[];
  final _network = <Map<String, Object?>>[];
  VoidCallback? _releaseLogs;

  /// Moves on each time Notato stops or reconnects: work begun under an older one is dropped when it lands.
  var _generation = 0;
  http.Client Function()? _httpClient;
  Future<void>? _opening;
  NotatoStorageFactory? _storageFactory;

  bool _enabled = false;
  bool _toolbarVisible = true;
  bool _annotating = false;
  NotatoConnection _connection = NotatoConnection.disabled;
  String? _connectionDetail;
  String? _problem;
  List<String> _agents = const [];

  /// What the server said it allows (`/config`), asked as Notato connects and again before a screenshot. Null until it
  /// answers, and then no screenshot is taken.
  ({bool screenshots, bool derived, bool captureOnly})? _policy;

  /// When the server was last asked, whether it answered or not.
  DateTime? _askedAt;
  ({int generation, Future<void> done})? _asking;

  /// Capture-only: the next try at the notes that could not go, while one is planned, and how long it waits.
  Timer? _resend;
  var _resendWait = _firstResend;
  bool get derivedScreenshots => hasServer && (_policy?.derived ?? false);

  // ---- what the app and the overlay read ------------------------------------------------------------------------

  /// The configuration the `Notato` widget gave, with its defaults filled in.
  NotatoConfig? get configuration => _config;
  @override
  bool get isEnabled => _enabled;
  @override
  bool get isToolbarVisible => _toolbarVisible;
  @override
  bool get isAnnotating => _annotating;
  @override
  NotatoConnection get connection => _connection;

  /// The last connection problem, fit to show to a person.
  String? get connectionDetail => _connectionDetail;

  /// Why Notato cannot start (a bad project id, say).
  String? get problem => _problem;
  @override
  List<NoteRecord> get notes => _notes.all;

  /// The note with this id, if Notato knows it.
  NoteRecord? note(String id) => _notes[id];
  @override
  int get pendingCount => _notes.pendingCount;
  @override
  List<String> get agents => _agents;

  /// Whether the server takes screenshots: false when it has them off, or has not said yet. One that does not wins over
  /// the app and the person.
  bool get serverScreenshots => _policy?.screenshots ?? server == null;

  /// Whether the server takes new notes from this app and nothing else (a capture-only token).
  bool get captureOnly => server != null && (_policy?.captureOnly ?? false);
  @override
  NotatoMode get mode => _config?.mode ?? NotatoMode.dev;

  /// The server: one typed into settings, else the configuration's.
  String? get server => _settings['server'] as String? ?? _config?.server;

  /// Whether notes go live to a server (not in test mode, which only uploads packages).
  bool get hasServer => server != null && mode != NotatoMode.test;

  /// The name on this person's notes: one typed into settings, else the configuration's.
  String? get authorName => _settings['author'] as String? ?? _config?.author;

  /// Whether the person wants screenshots taken.
  bool get screenshotsWanted => _settings['screenshots'] as bool? ?? _config?.screenshots ?? true;

  /// Whether screenshots are taken: the person wants them and, when there is a server (test mode's too), it has said it
  /// takes them. With no server at all, they stay on the device and the person decides.
  bool get screenshotsOn => screenshotsWanted && (server == null || (_policy?.screenshots ?? false));

  /// Whether a screenshot may be taken now ([screenshotsOn]). An answer from the server older than a few seconds is
  /// asked for again first, waiting a moment at most: a slow server must not hold up the note.
  Future<bool> screenshotsAllowed() async {
    final client = _client;
    final asked = _askedAt;
    if (screenshotsWanted &&
        server != null &&
        client != null &&
        (asked == null || DateTime.now().difference(asked) > _policyFresh)) {
      await _askServer(client).timeout(_policyWait, onTimeout: () {});
    }
    return screenshotsOn;
  }

  /// Whether text fields are covered in screenshots and their values left out of notes.
  bool get maskInputs => _config?.maskInputs ?? false;

  /// Whether pins are drawn over the app.
  bool get pinsVisible => _settings['pinsVisible'] as bool? ?? true;

  /// The server as people know it: `localhost:4747`.
  String? get serverHost => server == null ? null : hostOf(server!);

  /// Where the person left the toolbar, as fractions of the room it moves in, and whether it is folded.
  ({double? x, double? y, bool folded}) get toolbar => (
    x: (_settings['toolbarX'] as num?)?.toDouble(),
    y: (_settings['toolbarY'] as num?)?.toDouble(),
    folded: _settings['folded'] as bool? ?? false,
  );

  Map<String, Object?> get _me => {'kind': 'human', 'name': ?authorName};

  // ---- set-up ----------------------------------------------------------------------------------------------------

  /// Called by the `Notato` widget: starts Notato, or restarts it when the project or server changed.
  Future<void> configure(NotatoConfig config, {http.Client Function()? httpClient, NotatoStorageFactory? storage}) {
    final before = _config;
    _config = config;
    _httpClient = httpClient;
    _storageFactory = storage;
    if (before != null && before.sameConnection(config) && _opening != null) {
      notifyListeners();
      return _opening!;
    }
    return _opening = _open(config);
  }

  Future<void> _open(NotatoConfig config) async {
    _stop();
    _problem = config.problem;
    if (_problem != null) {
      debugPrint('[notato] $_problem Notato stays off.');
      notifyListeners();
      return;
    }
    if (config.tokenWithheld != null) debugPrint('[notato] ${config.tokenWithheld}');
    final generation = _generation;
    final storage = await _openStorage(config.project);
    // Stopped, or started again for another project or server, meanwhile. (A rebuild that gave the same connection
    // again replaced the configuration, and this goes on with the new one.)
    if (generation != _generation) return;
    final current = _config!;
    _storage = storage;
    _settings = current.rememberRuntimeState ? {..._storage.loadSettings()} : {};
    _notes.replaceAll(const []);
    _assets.clear();
    _toolbarVisible = _settings['toolbarVisible'] as bool? ?? current.showToolbar;
    // A NOTATO_ENABLED the build declares decides, over the choice remembered from an earlier launch. A choice made
    // from now on is still remembered, for a launch that declares nothing.
    final remembered = current.enabledDeclared ? null : _settings['enabled'] as bool?;
    _setEnabled(remembered ?? current.enabled, remember: false);
  }

  /// The app's storage, or memory for this run when the app's own `storage` fails.
  Future<NotatoStorage> _openStorage(String project) async {
    try {
      return await (_storageFactory ?? openStorage)(project);
    } catch (error) {
      debugPrint('[notato] Could not open the storage, so notes are kept in memory for this run: $error');
      return MemoryStorage();
    }
  }

  /// The overlay, while it is mounted: the one attached last is the one Notato works through.
  // ignore: use_setters_to_change_properties
  void attachHost(NotatoHost host) => _host = host;

  /// Called when a `Notato` widget goes away: stops Notato, unless another has attached since. (A `Notato` that takes
  /// the place of another is mounted before the old one is disposed.) The next to mount starts it afresh.
  void detach(NotatoHost host) {
    if (!identical(_host, host)) return;
    _stop();
    _host = null;
    _opening = null;
  }

  void _stop() {
    _generation++;
    _follower?.cancel();
    _follower = null;
    _cancelResend();
    _dropIncoming();
    _releaseLogs?.call();
    _releaseLogs = null;
    _enabled = false;
    _annotating = false;
    _connection = NotatoConnection.disabled;
    _connectionDetail = null;
    _agents = const [];
  }

  void _saveSettings() {
    if (_config?.rememberRuntimeState ?? false) {
      try {
        _storage.saveSettings(_settings);
      } catch (_) {
        // a full disk: the choice holds for this run
      }
    }
  }

  // ---- on and off ------------------------------------------------------------------------------------------------

  @override
  void enable() => _setEnabled(true, remember: true);

  @override
  void disable() => _setEnabled(false, remember: true);

  @override
  void setEnabled(bool on) => _setEnabled(on, remember: true);

  void _setEnabled(bool on, {required bool remember}) {
    final config = _config;
    if (config == null || (on && _problem != null)) return;
    if (remember) {
      _settings['enabled'] = on;
      _saveSettings();
    }
    if (on == _enabled) {
      notifyListeners();
      return;
    }
    if (!on) {
      _stop();
      notifyListeners();
      return;
    }
    _enabled = true;
    if (config.captureLogs && _releaseLogs == null) _releaseLogs = captureLogs(() => config.logLimit, _logs);
    _loadLocal();
    _restartSync();
    notifyListeners();
  }

  @override
  void resetRuntimeState() {
    final config = _config;
    if (config == null) return;
    final serverChanged = _settings['server'] != null;
    _settings = {};
    _saveSettings();
    _toolbarVisible = config.showToolbar;
    if (serverChanged) _notes.replaceAll(notes.where((r) => r.pending).toList());
    if (config.enabled != _enabled) {
      _setEnabled(config.enabled, remember: false);
    } else if (_enabled && serverChanged) {
      _restartSync();
    }
    notifyListeners();
  }

  @override
  void showToolbar() => _setToolbar(true);

  @override
  void hideToolbar() => _setToolbar(false);

  void _setToolbar(bool visible) {
    _toolbarVisible = visible;
    _settings['toolbarVisible'] = visible;
    if (!visible) _annotating = false;
    _saveSettings();
    notifyListeners();
  }

  @override
  void startAnnotating() {
    if (!_enabled) return;
    _annotating = true;
    notifyListeners();
  }

  @override
  void stopAnnotating() {
    if (!_annotating) return;
    _annotating = false;
    notifyListeners();
  }

  /// Shows or hides the pins (the menu's Hide pins).
  void togglePins() {
    _settings['pinsVisible'] = !pinsVisible;
    _saveSettings();
    notifyListeners();
  }

  /// Where the toolbar was left, as fractions of the room it can move in.
  void placeToolbar(double x, double y) {
    _settings['toolbarX'] = x.clamp(0.0, 1.0);
    _settings['toolbarY'] = y.clamp(0.0, 1.0);
    _saveSettings();
    notifyListeners();
  }

  /// Folds the toolbar into its round button, or opens it again.
  void setFolded(bool folded) {
    _settings['folded'] = folded;
    _saveSettings();
    notifyListeners();
  }

  // ---- notes on the device -----------------------------------------------------------------------------------------

  void _loadLocal() {
    List<LocalNote> saved;
    try {
      saved = _storage.loadNotes();
    } catch (_) {
      saved = const [];
    }
    final known = {for (final r in notes) r.id};
    _notes.replaceAll([
      ...notes,
      for (final n in saved)
        if (n.annotation['id'] is String && !known.contains(n.annotation['id']))
          NoteRecord(n.annotation, pending: true, mine: true, failed: n.failed, waiting: n.waiting),
    ]);
  }

  /// Writes the notes not on the server yet, so they survive a restart.
  void _persist() {
    try {
      _storage.saveNotes([
        for (final r in notes)
          if (r.pending) LocalNote(r.annotation, failed: r.failed, waiting: r.waiting),
      ]);
    } catch (_) {
      // a full disk: they are kept in memory for this run
    }
  }

  static List<String> _shotIds(Map<String, Object?> a) {
    final shots = a['screenshots'];
    if (shots is! Map) return const [];
    return [
      for (final key in const ['full', 'crop']) ?((shots[key] as Map?)?['id'] as String?),
    ];
  }

  List<Shot> _assetsOf(Map<String, Object?> a) {
    final out = <Shot>[];
    final shots = a['screenshots'] as Map?;
    for (final key in const ['full', 'crop']) {
      final ref = shots?[key] as Map?;
      final id = ref?['id'] as String?;
      if (id == null) continue;
      final bytes = _assets[id] ?? _storage.loadAsset(id);
      if (bytes != null) out.add(Shot(id: id, bytes: bytes, width: ref!['w'] as int, height: ref['h'] as int));
    }
    return out;
  }

  void _dropAssets(Map<String, Object?> a) {
    for (final id in _shotIds(a)) {
      _assets.remove(id);
      try {
        _storage.deleteAsset(id);
      } catch (_) {
        // already gone
      }
    }
  }

  /// Test mode: forget the notes kept on this device.
  void clearLocal() {
    for (final r in notes) {
      if (r.pending) _dropAssets(r.annotation);
    }
    _notes.replaceAll(notes.where((r) => !r.pending).toList());
    _persist();
    notifyListeners();
  }

  // ---- making a note -----------------------------------------------------------------------------------------------

  /// The notes on a screen, oldest first, numbered as their pins are.
  ScreenNotes notesOn(String route) => _notes.notesOn(route);

  /// The notes on a screen that get a pin here: those made in a Flutter app.
  ScreenNotes pinsOn(String route) => _notes.pinsOn(route);

  /// The number the next note on this screen gets: one more than the notes already on it.
  int nextPin(String route) => notesOn(route).length + 1;

  /// For tests: the notes as if they had come from the server.
  @visibleForTesting
  void debugSetRecords(List<NoteRecord> records) => _notes.replaceAll(records);

  /// Files a note on a widget the overlay picked, with the screenshots it took: kept on the device first, then sent
  /// when there is a server. Returns the note, and what to tell the person when it did not go.
  Future<({Map<String, Object?> annotation, String? problem})> createNote(
    Picked picked, {
    required String comment,
    String? intent,
    String? severity,
    bool peopleOnly = false,
    String? agentName,
    List<Map<String, Object?>>? steps,
    required String id,
    required int pin,
    Shot? full,
    Shot? crop,
  }) async {
    final config = _config;
    final host = _host;
    if (config == null || host == null) throw const NotatoException('Notato is not running.');
    final keepFull = screenshotsOn ? full : null;
    final keepCrop = keepFull == null ? null : crop;
    final annotation = buildAnnotation(
      id: id,
      project: config.project,
      mode: config.mode.name,
      appName: config.appName,
      appVersion: config.appVersion,
      route: routeName(host.route()),
      author: authorName,
      agentName: agentName,
      identity: picked.identity,
      rect: (x: picked.rect.left, y: picked.rect.top, w: picked.rect.width, h: picked.rect.height),
      comment: comment,
      intent: intent,
      severity: severity,
      peopleOnly: peopleOnly,
      steps: steps,
      pin: pin,
      full: keepFull,
      crop: keepCrop,
      device: host.device(),
      console: config.captureLogs ? [..._logs] : null,
      network: [..._network],
    );
    for (final shot in [?keepFull, ?keepCrop]) {
      _assets[shot.id] = shot.bytes;
      try {
        _storage.saveAsset(shot.id, shot.bytes);
      } catch (_) {
        // kept in memory
      }
    }
    _notes.edit((notes) => notes.put(NoteRecord(annotation, pending: true, mine: true)));
    _persist();
    notifyListeners();
    final outcome = await send(id);
    return (annotation: _notes[id]?.annotation ?? annotation, problem: _problemOf(outcome));
  }

  NotatoHost _requireHost() {
    final host = _host;
    if (!_enabled || host == null) throw const NotatoException('Notato is off, or the Notato widget is not mounted.');
    return host;
  }

  @override
  Future<void> select(Object target) async {
    final host = _requireHost();
    host.select(await host.resolve(target));
  }

  @override
  Future<Map<String, Object?>> annotate(
    Object target,
    String comment, {
    String? intent,
    String? severity,
    String? agentName,
    List<Map<String, Object?>>? steps,
    bool screenshot = true,
    bool peopleOnly = false,
  }) async {
    final host = _requireHost();
    if (comment.trim().isEmpty) throw const NotatoException('A note needs a comment.');
    final picked = await host.resolve(target);
    final pin = nextPin(host.route());
    final id = ulid();
    final shots = screenshot && await screenshotsAllowed()
        ? await host.capture(picked, pin, id)
        : (full: null, crop: null);
    final made = await createNote(
      picked,
      comment: comment,
      intent: intent,
      severity: severity,
      peopleOnly: peopleOnly,
      agentName: agentName,
      steps: steps,
      id: id,
      pin: pin,
      full: shots.full,
      crop: shots.crop,
    );
    return made.annotation;
  }

  @override
  void recordRequest({
    required String method,
    required String url,
    required int status,
    required Duration duration,
    DateTime? at,
  }) {
    _network.add({
      'method': method.toUpperCase(),
      // Without its query string, or a user name and password in front of the host.
      'url': url
          .replaceFirst(RegExp(r'[?#].*$'), '')
          .replaceFirstMapped(RegExp(r'^([a-zA-Z][a-zA-Z\d+.-]*://)[^/]*@'), (m) => m[1]!),
      'status': status,
      'durationMs': duration.inMilliseconds,
      'at': (at ?? DateTime.now()).toUtc().toIso8601String(),
    });
    if (_network.length > 50) _network.removeRange(0, _network.length - 50);
  }

  // ---- sending -----------------------------------------------------------------------------------------------------

  /// A client for a server. The token goes only to the server the app was configured with, in code or by the build's
  /// `NOTATO_SERVER` (whoever builds the app chose that server as they chose the token): one typed into the settings (a
  /// typo, someone else's) never gets it.
  NotatoClient _clientFor(String server) => NotatoClient(
    server: server,
    project: _config!.project,
    token: server == _config!.server ? _config!.token : null,
    newClient: _httpClient,
  );

  /// Sends one note now, unless it has gone already. One on its way gives what comes of that send.
  Future<SendOutcome> send(String id) {
    final going = _inflight[id];
    if (going != null) return going;
    final client = _client;
    final record = _notes[id];
    if (!hasServer || client == null || record == null || !record.pending || record.failed != null) {
      return Future.value(const Skipped());
    }
    return _inflight[id] = _sendOnce(record, client);
  }

  /// Sends a note, and forgets it was on its way once that is done.
  Future<SendOutcome> _sendOnce(NoteRecord record, NotatoClient client) async {
    try {
      return await _sendNow(record, client);
    } finally {
      // The future taken out is this one, finishing now: nothing to wait for.
      unawaited(_inflight.remove(record.id));
    }
  }

  Future<SendOutcome> _sendNow(NoteRecord record, NotatoClient client) async {
    final id = record.id;
    final generation = _generation;
    try {
      final stored = await client.send(record.annotation, _assetsOf(record.annotation));
      if (_deletedHere.contains(id)) {
        // Deleted here while it was on its way: delete it there too, even when Notato restarted meanwhile.
        _dropAssets(record.annotation);
        await client.delete(id).catchError((_) {});
        return const Skipped();
      }
      if (generation != _generation) return const Skipped();
      _dropAssets(record.annotation);
      final annotation = (stored['annotation'] as Map?)?.cast<String, Object?>() ?? record.annotation;
      // The server's events may have brought a newer copy while the answer was on its way: that one stays.
      _notes.update(id, (r) => r.pending ? NoteRecord(annotation, mine: r.mine) : r);
      _sentState(null);
      _persist();
      notifyListeners();
      return const Sent();
    } on NotatoException catch (error) {
      if (error.status == 409 && captureOnly && generation == _generation) {
        // A capture-only token is told only that the server has this id: the answer to an earlier send was lost on its
        // way. It is there.
        _dropAssets(record.annotation);
        _notes.update(id, (r) => r.pending ? NoteRecord(r.annotation, mine: r.mine) : r);
        _sentState(null);
        _persist();
        notifyListeners();
        return const Sent();
      }
      if (error.refusesNote) {
        _notes.update(id, (r) => r.copyWith(failed: error.message));
        debugPrint('[notato] The server refused a note: ${error.message}');
        _persist();
        notifyListeners();
        return Refused(error.message);
      }
      return _hold(id, error, generation);
    } catch (error) {
      // Anything else (an answer that is not a note, say): kept, like a note the server could not be reached for.
      return _hold(id, NotatoException('$error'), generation);
    }
  }

  /// A note that did not go now: it and the notes after it wait, with the server's reason when it gave one.
  Held _hold(String id, NotatoException error, int generation) {
    _notes.update(
      id,
      (r) =>
          NoteRecord(r.annotation, pending: true, mine: r.mine, waiting: error.status == null ? null : error.message),
    );
    if (generation == _generation) {
      // With no stream to say when the server is back, a capture-only app tries again in a while.
      _sentState(error);
      _planResend();
    }
    _persist();
    notifyListeners();
    return Held(error);
  }

  /// Sends every note waiting to go, oldest first. A refused note is passed over (it is marked failed) and the rest
  /// still go; anything else that stops one stops there, with it and everything after it still queued. Returns why.
  Future<NotatoException?> flush() async {
    for (final r in [...notes]) {
      if (!r.pending || r.failed != null) continue;
      final outcome = await send(r.id);
      if (outcome is Held) return outcome.error;
    }
    return null;
  }

  // ---- the server: live updates over server-sent events ------------------------------------------------------------

  /// Opens a fresh connection to the server, or says there is none. What the server allows is asked first, whenever
  /// there is a server (test mode's too): it says whether screenshots may be taken, and whether this app may do more
  /// than send notes.
  void _restartSync() {
    _generation++;
    _follower?.cancel();
    _follower = null;
    _cancelResend();
    _dropIncoming();
    _agents = const [];
    _policy = null;
    _askedAt = null;
    final s = server;
    final client = _client = s == null ? null : _clientFor(s);
    if (!_enabled || client == null || !hasServer) {
      _connection = NotatoConnection.local;
      _connectionDetail = mode == NotatoMode.test ? null : 'No server is set: notes stay on this device.';
      if (_enabled && client != null) unawaited(_askServer(client));
      return;
    }
    final generation = _generation;
    _connection = NotatoConnection.connecting;
    unawaited(
      _askServer(client).then((_) {
        if (generation == _generation) _connect(client, generation);
      }),
    );
  }

  /// Follows the server's events; or, for a capture-only token, which may not, only sends the notes. A server that
  /// could not be asked first, and then refuses the stream, is asked again: the token may be capture-only.
  void _connect(NotatoClient client, int generation) {
    if (captureOnly) {
      _sendOnly(generation);
      return;
    }
    _follower = client.follow(
      (event) {
        if (generation == _generation) unawaited(_handle(event, client, generation));
      },
      (state, detail) {
        if (generation != _generation) return;
        if (state == StreamState.refused) {
          unawaited(
            _askServer(client).then((_) {
              if (generation != _generation || !captureOnly) return;
              _follower?.cancel();
              _follower = null;
              _sendOnly(generation);
            }),
          );
        }
        _connection = switch (state) {
          StreamState.connecting => NotatoConnection.connecting,
          StreamState.connected => NotatoConnection.connected,
          StreamState.offline => NotatoConnection.offline,
          StreamState.refused => NotatoConnection.refused,
        };
        _connectionDetail = detail;
        if (state != StreamState.connecting) _agents = const [];
        notifyListeners();
      },
      agent: mode == NotatoMode.agent,
    );
  }

  /// Asks the server what it allows (`/config`). An answer that does not come leaves the last one standing: none, at
  /// first, and then no screenshots are taken. One question at a time per connection.
  Future<void> _askServer(NotatoClient client) {
    final asking = _asking;
    if (asking != null && asking.generation == _generation) return asking.done;
    final generation = _generation;
    final done = _ask(client, generation);
    _asking = (generation: generation, done: done);
    return done;
  }

  Future<void> _ask(NotatoClient client, int generation) async {
    try {
      final config = await client.capabilities();
      if (generation != _generation) return;
      _policy = (
        screenshots: config['screenshots'] == true,
        derived: config['derivedScreenshots'] == true,
        captureOnly: config['captureOnly'] == true,
      );
      notifyListeners();
    } catch (_) {
      // no answer: the last one stands
    } finally {
      if (generation == _generation) _askedAt = DateTime.now();
      if (_asking?.generation == generation) _asking = null;
    }
  }

  /// A capture-only token: the server takes new notes from this app and nothing else (no stream, no list), so there is
  /// nothing to wait for. The notes kept here go now, and are tried again in a while when they cannot.
  void _sendOnly(int generation) {
    _connection = NotatoConnection.connected;
    _connectionDetail = null;
    _agents = const [];
    notifyListeners();
    unawaited(_sendKept(generation));
  }

  /// Capture-only: sends the notes kept here, and says how that went.
  Future<void> _sendKept(int generation) async {
    final held = await flush();
    if (generation != _generation) return;
    _sentState(held);
    if (held != null) {
      _planResend();
    } else {
      _resendWait = _firstResend;
    }
    notifyListeners();
  }

  /// Capture-only: there is no stream to say how the connection stands, so the last note sent (or not) says it.
  void _sentState(NotatoException? held) {
    if (!captureOnly) return;
    _connection = held == null
        ? NotatoConnection.connected
        : held.permanent
        ? NotatoConnection.refused
        : NotatoConnection.offline;
    _connectionDetail = held?.message;
  }

  /// Capture-only: tries the notes kept here again in a while, waiting longer each time they cannot go.
  void _planResend() {
    if (_resend != null || !captureOnly || !hasServer) return;
    final generation = _generation;
    _resend = Timer(_resendWait, () {
      _resend = null;
      if (generation == _generation) unawaited(_sendKept(generation));
    });
    final doubled = _resendWait * 2;
    _resendWait = doubled > _longestResend ? _longestResend : doubled;
  }

  void _cancelResend() {
    _resend?.cancel();
    _resend = null;
    _resendWait = _firstResend;
  }

  /// Tries the server again now, instead of waiting out the pause between attempts (the menu's Retry).
  void retryConnection() {
    if (!_enabled || !hasServer) return;
    if (_follower != null) {
      _follower!.retry();
    } else if (captureOnly) {
      _cancelResend();
      unawaited(_sendKept(_generation));
    } else {
      _restartSync();
    }
  }

  Future<void> _handle(ServerEvent e, NotatoClient client, int generation) async {
    final data = e.data is Map ? (e.data as Map).cast<String, Object?>() : const <String, Object?>{};
    switch (e.event) {
      case 'hello':
        _connection = NotatoConnection.connected;
        _connectionDetail = null;
        _agents = _agentNames(data['agent']);
        notifyListeners();
        // Asked again on each connection: the server's settings may have changed while it was away.
        await _askServer(client);
        // The notes kept on the device go first, so the list read after them has them.
        final held = await flush();
        if (generation != _generation) return;
        await _reload(client, generation);
        if (held != null && held.status != null) _host?.toast('Notes not sent: ${held.message}');
      case 'agent':
        _agents = _agentNames(data);
        notifyListeners();
      case 'created' || 'updated' || 'replied':
        final annotation = data['annotation'];
        if (annotation is Map) _receive((annotation: annotation.cast<String, Object?>(), deleted: null));
      case 'deleted':
        final id = data['id'];
        if (id is String) _receive((annotation: null, deleted: id));
      case 'annotate-request':
        final requestId = data['requestId'];
        final args = data['args'];
        if (requestId is String && args is Map) {
          _relays.add(() => _answerRelay(requestId, args.cast<String, Object?>(), client));
          if (!_relaying) unawaited(_answerRelays());
        }
    }
  }

  /// The agents a `hello` or `agent` event says are connected: `{connected: true, names: […]}`.
  static List<String> _agentNames(Object? agent) => agent is Map && agent['connected'] == true
      ? ((agent['names'] as List?) ?? const []).whereType<String>().toList()
      : const [];

  Future<void> _answerRelays() async {
    _relaying = true;
    try {
      while (_relays.isNotEmpty) {
        await _relays.removeAt(0)();
      }
    } finally {
      _relaying = false;
    }
  }

  /// A change from the server's events: applied with the others that come within a frame.
  void _receive(_Change change) {
    _incoming.add(change);
    _listing?.add(change);
    _applyTimer ??= Timer(_batch, _applyIncoming);
  }

  /// Applies the server's changes that have come since the last frame, together: one copy of the list for them all.
  void _applyIncoming() {
    _applyTimer?.cancel();
    _applyTimer = null;
    if (_incoming.isEmpty) return;
    final changes = [..._incoming];
    _incoming.clear();
    if (_applyChanges(changes)) notifyListeners();
  }

  /// Forgets the server's changes not applied yet: they belong to a connection that is gone.
  void _dropIncoming() {
    _applyTimer?.cancel();
    _applyTimer = null;
    _incoming.clear();
    _listing = null;
  }

  /// Applies the server's changes in order. Whether a note changed.
  bool _applyChanges(List<_Change> changes) {
    var sent = false;
    final changed = _notes.edit((notes) {
      for (final change in changes) {
        final deleted = change.deleted;
        final annotation = change.annotation;
        if (deleted != null) {
          // Deleted there: forgotten here, unless it is a note of this device's that has not gone yet.
          if (notes[deleted]?.pending == false) notes.remove(deleted);
          _deletedHere.remove(deleted);
        } else if (annotation != null && _takeCopy(notes, annotation)) {
          sent = true;
        }
      }
    });
    if (sent) _persist();
    return changed;
  }

  /// Reads every note of the project, then forgets those the server no longer has. Nothing is forgotten unless every
  /// page came: a list cut short would look like deletions. The changes that come while it is read are applied again
  /// over it, since the list may be older than they are.
  Future<void> _reload(NotatoClient client, int generation) async {
    _applyIncoming();
    final known = {
      for (final r in notes)
        if (!r.pending) r.id,
    };
    final meanwhile = <_Change>[];
    _listing = meanwhile;
    List<Map<String, Object?>> items;
    try {
      items = await client.list();
    } catch (_) {
      return;
    } finally {
      if (identical(_listing, meanwhile)) _listing = null;
    }
    if (generation != _generation) return;
    final byId = {for (final r in notes) r.id: r};
    final listed = <String>{};
    final added = <NoteRecord>[];
    for (final item in items) {
      final a = (item['annotation'] as Map?)?.cast<String, Object?>();
      final id = a?['id'];
      if (a == null || id is! String || a['projectId'] != _config?.project || _deletedHere.contains(id)) continue;
      listed.add(id);
      final existing = byId[id];
      if (existing != null) {
        if (existing.pending) _dropAssets(existing.annotation);
        byId[id] = NoteRecord(a, mine: existing.mine);
      } else {
        added.add(NoteRecord(a));
      }
    }
    // The server's: those it had before the load and lists no longer.
    final gone = known.difference(listed);
    _notes.replaceAll([
      for (final r in notes)
        if (!gone.contains(r.id) || r.pending) byId[r.id] ?? r,
      ...added,
    ]);
    // Every change not applied yet came while the list was read, so it is among these.
    _applyTimer?.cancel();
    _applyTimer = null;
    _incoming.clear();
    _applyChanges(meanwhile);
    _persist();
    notifyListeners();
  }

  /// A note from the server, into the notes: replaces the one Notato has, or joins them. True when it replaced one
  /// that was still on the device.
  bool _takeCopy(NoteEdit notes, Map<String, Object?> annotation) {
    final id = annotation['id'];
    if (id is! String || annotation['projectId'] != _config?.project || _deletedHere.contains(id)) return false;
    final existing = notes[id];
    if (existing != null && existing.pending) _dropAssets(existing.annotation);
    notes.put(NoteRecord(annotation, mine: existing?.mine ?? false));
    return existing?.pending ?? false;
  }

  /// The server's answer to something the person did: the changes before it first, then it.
  void _upsert(Map<String, Object?> annotation) {
    _applyIncoming();
    var sent = false;
    _notes.edit((notes) => sent = _takeCopy(notes, annotation));
    if (sent) _persist();
  }

  /// Agent mode: an agent asked, through `notato_annotate`, for something in this app to be annotated.
  Future<void> _answerRelay(String requestId, Map<String, Object?> args, NotatoClient client) async {
    Map<String, Object?> result;
    try {
      final steps = (args['steps'] as List?)?.whereType<Map>().map((m) => m.cast<String, Object?>()).toList();
      final annotation = await annotate(
        args['target'] as String? ?? '',
        args['comment'] as String? ?? '',
        intent: args['intent'] as String?,
        severity: args['severity'] as String?,
        steps: steps,
        agentName: args['author'] as String? ?? 'agent',
      );
      final record = _notes[annotation['id'] as String];
      // Made, but not on the server: reporting it filed would send the agent looking for a note the server does not
      // have.
      result = record != null && !record.pending
          ? {'ok': true, 'annotationId': annotation['id']}
          : {'ok': false, 'error': _notFiled(record)};
    } catch (error) {
      result = {'ok': false, 'error': '$error'};
    }
    try {
      await client.relayResult(requestId, result);
    } catch (error) {
      debugPrint('[notato] Could not report an annotate result: $error');
    }
  }

  /// Why a note made for the agent is not on the server, said to the agent.
  String _notFiled(NoteRecord? record) {
    if (record == null) return 'The note was made on the device, then deleted there before it was sent.';
    final failed = record.failed;
    if (failed != null) return 'The note was made on the device but the server did not take it: ${_sentence(failed)}';
    final waiting = record.waiting;
    if (waiting != null) {
      return 'The note was made on the device but the server did not take it: ${_sentence(waiting)} '
          'It is sent again on the next connection.';
    }
    return hasServer
        ? 'The note was made on the device but not sent: the server could not be reached. '
              'It is sent again on the next connection.'
        : 'The note was made on the device but not sent: no server is set.';
  }

  // ---- acting on a note, as the person -----------------------------------------------------------------------------

  NotatoClient _connected() {
    final client = _client;
    if (!hasServer || client == null) throw const NotatoException('Not connected to a Notato server.');
    if (captureOnly) throw const NotatoException(_onTheBoard);
    return client;
  }

  void _take(Map<String, Object?> stored) {
    final annotation = stored['annotation'];
    if (annotation is Map) _upsert(annotation.cast<String, Object?>());
    notifyListeners();
  }

  /// Replies on a note's thread. An aside is for the people on the thread: the agent never sees it.
  Future<void> reply(String id, String text, {bool aside = false}) async =>
      _take(await _connected().reply(id, text.trim(), _me, aside: aside));

  /// Turns People only on or off, as the person. The server does it (and records it in the thread) once it has the
  /// note; a note not sent yet is changed on the device, with the same entry in its thread.
  Future<void> setPeopleOnly(String id, bool on) async {
    final record = _notes[id];
    if (record == null) throw const NotatoException('That note is gone.');
    if (on == record.peopleOnly) return;
    if (!record.pending) {
      _take(await _connected().setPeopleOnly(id, on, _me));
      return;
    }
    // On its way now: the server's copy, when it lands, would replace this change.
    if (_inflight.containsKey(id)) throw const NotatoException('The note is being sent: try again in a moment.');
    _notes.update(id, (r) => r.copyWith(annotation: settingPeopleOnly(r.annotation, on, _me)));
    _persist();
    notifyListeners();
  }

  /// Asks the agent to undo a resolved note's change, with the person's reason.
  Future<void> requestRevert(String id, {String? reason}) async {
    final said = reason?.trim() ?? '';
    final note = said.isEmpty ? 'Please undo this change.' : said;
    _take(await _connected().setStatus(id, 'revert_requested', note, _me));
  }

  /// Takes a revert request back: the note is resolved again.
  Future<void> cancelRevert(String id) async =>
      _take(await _connected().setStatus(id, 'resolved', 'Revert request taken back.', _me));

  /// Deletes a note: on the server when it has it, and on the device.
  Future<void> delete(String id) async {
    final record = _notes[id];
    if (record != null && !record.pending && hasServer) await _connected().delete(id);
    if (record != null) {
      // A copy on its way now is deleted on the server when it lands; one not sent yet never goes.
      if (_inflight.containsKey(id)) _deletedHere.add(id);
      _dropAssets(record.annotation);
    }
    _notes.update(id, (_) => null);
    _persist();
    notifyListeners();
  }

  /// The settings sheet's Save. A server that is not http(s) is not taken. Returns what to tell the person, if anything.
  String? saveSettings({required String name, required bool screenshots, required String server}) {
    final trimmedName = name.trim();
    if (trimmedName.isEmpty) {
      _settings.remove('author');
    } else {
      _settings['author'] = trimmedName;
    }
    if (screenshots == (_config?.screenshots ?? true)) {
      _settings.remove('screenshots');
    } else {
      _settings['screenshots'] = screenshots;
    }
    final typed = server.trim().replaceAll(RegExp(r'/+$'), '');
    String? message;
    var changed = false;
    if (typed.isEmpty || typed == _config?.server) {
      changed = _settings.containsKey('server');
      _settings.remove('server');
    } else if (RegExp(r'^https?://[^/\s]+', caseSensitive: false).hasMatch(typed)) {
      changed = _settings['server'] != typed;
      _settings['server'] = typed;
    } else {
      message = '"$typed" is not an http(s) address; the server was not changed.';
    }
    _saveSettings();
    if (changed) {
      _notes.replaceAll(notes.where((r) => r.pending).toList());
      _restartSync();
    }
    notifyListeners();
    return message;
  }

  /// The connection in a few words, for the menu and the settings.
  String describeConnection() {
    final host = serverHost;
    return switch (_connection) {
      NotatoConnection.connected =>
        captureOnly
            ? 'Sending notes to ${host ?? 'the server'}; they are read on the board'
            : 'Connected to ${host ?? 'the server'}',
      NotatoConnection.connecting => 'Connecting to ${host ?? 'the server'}…',
      NotatoConnection.offline => _connectionDetail ?? 'Cannot reach ${host ?? 'the server'}',
      NotatoConnection.refused => _connectionDetail ?? '${host ?? 'The server'} refused this app',
      NotatoConnection.local =>
        mode == NotatoMode.test
            ? (host == null
                  ? 'Notes stay on this device until packaged'
                  : 'Notes stay on this device; a package is uploaded to $host')
            : _connectionDetail ?? 'No server',
      NotatoConnection.disabled => _problem ?? 'Off',
    };
  }

  // ---- test mode: a bundle zip -------------------------------------------------------------------------------------

  @override
  Future<({List<int> zip, String name, String? path, bool uploaded})> packageNotes({bool upload = true}) async {
    final packaged = await _package(upload: upload);
    return (zip: packaged.zip, name: packaged.name, path: packaged.path, uploaded: packaged.uploaded);
  }

  /// A package, and whether its screenshots are in it: with a server set, only when the server says it takes them. They
  /// may have been taken while it did, but a package is shared by hand, so it follows what the server says now. A
  /// capture-only token cannot upload it.
  Future<({List<int> zip, String name, String? path, bool uploaded, bool screenshots})> _package({
    required bool upload,
  }) async {
    final config = _config;
    if (config == null) throw const NotatoException('Notato has not been started.');
    final mine = notes.where((r) => r.pending || (mode == NotatoMode.test && r.mine)).toList();
    if (mine.isEmpty) throw const NotatoException('Nothing to package yet: make at least one note.');
    final client = _client;
    if (server != null && client != null) await _askServer(client).timeout(_policyWait, onTimeout: () {});
    final screenshots = server == null || (_policy?.screenshots ?? false);
    final written = writeBundle(
      [for (final r in mine) r.annotation],
      project: config.project,
      author: authorName,
      appName: config.appName,
      appVersion: config.appVersion,
      assetOf: (id) => screenshots ? _assets[id] ?? _storage.loadAsset(id) : null,
    );
    String? path;
    try {
      path = _storage.writeShare(written.name, written.zip);
    } catch (_) {
      path = null;
    }
    var uploaded = false;
    final s = server;
    if (upload && s != null && !captureOnly) {
      await _clientFor(s).uploadBundle(written.zip);
      uploaded = true;
    }
    return (zip: written.zip, name: written.name, path: path, uploaded: uploaded, screenshots: screenshots);
  }

  /// The menu's Package and share: the zip, uploaded when there is a server, and offered to the share sheet.
  Future<String> packageAndShare() async {
    final result = await _package(upload: true);
    final bare = result.screenshots ? '' : ', without screenshots (the server does not take them)';
    final path = result.path;
    final host = _host;
    if (path != null && host != null) {
      final shared = await host.share(path).catchError((_) => false);
      if (shared) return '${result.uploaded ? 'Packaged, uploaded and shared' : 'Packaged and shared'}$bare';
    }
    if (result.uploaded) return 'Packaged and uploaded to the server$bare';
    if (path != null) return 'Packaged: ${result.name}$bare';
    throw const NotatoException('There is nowhere to write a package here: set a server to upload it.');
  }
}
