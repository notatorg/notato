import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/cupertino.dart' show DefaultCupertinoLocalizations;
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:http/http.dart' as http;
import 'package:share_plus/share_plus.dart';

import 'annotation.dart';
import 'capture.dart';
import 'client.dart';
import 'config.dart';
import 'controller.dart';
import 'identity.dart';
import 'ids.dart';
import 'note_book.dart';
import 'platform.dart';
import 'runtime.dart';
import 'selectors.dart';
import 'serial.dart';
import 'storage.dart';
import 'tree.dart';
import 'ui/composer.dart';
import 'ui/parts.dart';
import 'ui/pin_layout.dart';
import 'ui/sheets.dart';
import 'ui/theme.dart';
import 'ui/toolbar.dart';

/// Knows the screen the person is on by its route's name, for notes to be filed under. Add [Notato.navigatorObserver]
/// to your app's `navigatorObservers`.
class NotatoRouteObserver extends NavigatorObserver {
  /// The navigator's routes, bottom first.
  final _routes = <Route<dynamic>>[];

  /// The name of the topmost route that has one, or null. A dialog or an unnamed page over a named screen keeps that
  /// screen's name.
  String? get current {
    for (final route in _routes.reversed) {
      final name = route.settings.name;
      if (name != null) return name;
    }
    return null;
  }

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    // A navigator that went away (the app built a new one) says nothing of its routes: they are gone from it.
    _routes
      ..removeWhere((r) => !r.isActive)
      ..add(route);
  }

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) => _routes.remove(route);

  @override
  void didRemove(Route<dynamic> route, Route<dynamic>? previousRoute) => _routes.remove(route);

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) {
    final at = oldRoute == null ? -1 : _routes.indexOf(oldRoute);
    if (newRoute == null) {
      if (at >= 0) _routes.removeAt(at);
    } else if (at >= 0) {
      _routes[at] = newRoute;
    } else {
      _routes.add(newRoute);
    }
  }
}

/// Notato for Flutter: wrap your app in it. People tap Annotate, then any widget, and write what should change; the
/// note reaches your coding agent with a screenshot, the widget and the file and line it is written at. In a release
/// build it is your app and nothing else, unless [enabled] says otherwise.
class Notato extends StatefulWidget {
  /// Notato around [child], your app, for [project] on the server.
  const Notato({
    super.key,
    required this.project,
    required this.child,
    this.mode = NotatoMode.dev,
    this.server,
    this.token,
    this.appName,
    this.appVersion,
    this.author,
    this.route,
    this.enabled,
    this.showToolbar = true,
    this.toolbarPosition = NotatoPosition.bottomRight,
    this.screenshots = true,
    this.maskInputs,
    this.rememberRuntimeState = true,
    this.captureLogs = true,
    this.logLimit = 50,
    this.maxScreenshotScale = 2,
    this.storage,
    this.httpClient,
  });

  /// The project the notes belong to on the server. Letters, digits and `. _ - @`, not only dots.
  final String project;

  /// Your app.
  final Widget child;

  /// `dev` (default): notes go live to `notato dev` and your agent. `test`: notes stay on the device until packaged as a
  /// zip. `agent`: like dev, and the app also takes `notato_annotate` requests from the agent.
  final NotatoMode mode;

  /// The Notato server. Default `http://localhost:4747` in dev and agent mode (the iOS simulator and desktop apps reach
  /// it as it is; for the Android emulator, forward it first: `adb reverse tcp:4747 tcp:4747`), and none in test mode,
  /// where a server set here gets the packages. An empty string for none in any mode.
  final String? server;

  /// A project token (`notato_…`), for a shared server (`notato serve`).
  final String? token;

  /// The app's name, recorded on every note. Default: `Flutter app`.
  final String? appName;

  /// The app's version, recorded on every note.
  final String? appVersion;

  /// The name on this person's notes. They can change it in the toolbar's settings.
  final String? author;

  /// The screen the person is on: notes are filed under it and its pins shown on it. Default: the route name
  /// [navigatorObserver] saw last, when it is in your app's `navigatorObservers`.
  final String? Function()? route;

  /// Whether Notato is on at launch. Default: debug builds. The app can switch it at runtime ([notato]). Picking a
  /// widget needs a debug build either way.
  final bool? enabled;

  /// Show the toolbar at launch. The app can show or hide it at runtime.
  final bool showToolbar;

  /// The corner the toolbar starts in. People can drag it; where they leave it is remembered.
  final NotatoPosition toolbarPosition;

  /// Take screenshots. A server with screenshots off drops them either way.
  final bool screenshots;

  /// Cover text fields in screenshots and leave their values out of notes. Default: on in test and agent mode. Password
  /// fields always are; `NotatoMask(private: false)` opts a field out.
  final bool? maskInputs;

  /// Keep runtime choices (on or off, toolbar, name, a server typed in, the toolbar's place) across launches.
  final bool rememberRuntimeState;

  /// Attach the app's recent errors and `debugPrint` messages to each note.
  final bool captureLogs;

  /// How many of the app's recent messages each note keeps, at most.
  final int logLimit;

  /// Pixels per point screenshots are kept at, at most. Phones are 2x to 3.5x; 2x is plenty.
  final double maxScreenshotScale;

  /// Where notes not sent yet, test-mode notes, their screenshots and people's choices are kept. Default: files in the
  /// app's support folder (memory on the web). `(_) async => MemoryStorage()` keeps them for this run only.
  final NotatoStorageFactory? storage;

  /// For tests: makes the HTTP clients the SDK uses.
  @visibleForTesting
  final http.Client Function()? httpClient;

  /// Add to `MaterialApp(navigatorObservers: [Notato.navigatorObserver])` for notes to know the screen by its route.
  static final navigatorObserver = NotatoRouteObserver();

  @override
  State<Notato> createState() => _NotatoState();
}

/// A widget picked to annotate, outlined and photographed, while its note is written.
class _Selection {
  _Selection(this.picked, this.pin, this.id, this.shots);
  final Picked picked;
  final int pin;
  final String id;
  final ({Shot? full, Shot? crop}) shots;
}

/// A pin as it is drawn: its note and number, and where its widget is now, or was (detached) when it cannot be found.
class _Pin {
  const _Pin(this.record, this.number, this.rect, this.detached);
  final NoteRecord record;
  final int number;
  final Rect rect;
  final bool detached;
}

/// The most pins drawn on one screen: the newest. The Notes list has every one.
const maxPins = 150;

/// The overlay: Notato's host, its pins, toolbar, composer and sheets, drawn over the app without ever rebuilding it.
class _NotatoState extends State<Notato> with WidgetsBindingObserver implements NotatoHost {
  final _appKey = GlobalKey();
  final _shotKey = GlobalKey();
  final _rootKey = GlobalKey();
  late final OverlayEntry _ui = OverlayEntry(builder: _buildUi);

  Sheet? _sheet;
  _Selection? _selection;

  /// While a screenshot is taken: the outline, the covers, and nothing else of Notato's.
  ({Rect rect, int pin, List<Rect> covers})? _capturing;

  /// Screenshots are taken one at a time (two notes at once: a relayed request and a tap), and the covers come off only
  /// after the last: one finishing first must not uncover what the other is photographing.
  late final _oneAtATime = Serial(() {
    if (mounted) setState(() => _capturing = null);
  });
  String? _toast;
  Timer? _toastTimer;
  List<_Pin> _pins = const [];
  Timer? _pinTimer;

  /// A frame was drawn since the pins were last placed: something on screen may have moved. An app at rest draws no
  /// frames, so its pins are not looked for again until it does.
  var _drawn = true;
  var _watchingFrames = false;
  ScreenNotes? _placedFor;

  /// The screen the overlay was last drawn for. Moving to another that redraws nothing of Notato's (one with no pins,
  /// say) is noticed by looking twice a second, and drawn then.
  String? _drawnRoute;
  Timer? _routeTimer;

  /// Decided once: a release build that changed its mind later would put the app in another place in the tree, and
  /// Flutter would build it again from scratch.
  late final bool _available = kDebugMode || (widget.enabled ?? false);

  NotatoConfig get _config => NotatoConfig.resolve(
    project: widget.project,
    mode: widget.mode,
    server: widget.server,
    token: widget.token,
    appName: widget.appName,
    appVersion: widget.appVersion,
    author: widget.author,
    enabled: widget.enabled ?? kDebugMode,
    showToolbar: widget.showToolbar,
    toolbarPosition: widget.toolbarPosition,
    screenshots: widget.screenshots,
    maskInputs: widget.maskInputs,
    rememberRuntimeState: widget.rememberRuntimeState,
    captureLogs: widget.captureLogs,
    logLimit: widget.logLimit,
    maxScreenshotScale: widget.maxScreenshotScale,
  );

  @override
  void initState() {
    super.initState();
    if (!_available) return;
    WidgetsBinding.instance.addObserver(this);
    runtime.addListener(_changed);
    runtime.attachHost(this);
    unawaited(runtime.configure(_config, httpClient: widget.httpClient, storage: widget.storage));
    _routeTimer = Timer.periodic(const Duration(milliseconds: 500), (_) {
      if (mounted && runtime.isEnabled && _drawnRoute != null && route() != _drawnRoute) _changed();
    });
  }

  @override
  void didUpdateWidget(Notato old) {
    super.didUpdateWidget(old);
    if (_available) unawaited(runtime.configure(_config, httpClient: widget.httpClient, storage: widget.storage));
  }

  @override
  void dispose() {
    if (_available) {
      WidgetsBinding.instance.removeObserver(this);
      runtime.removeListener(_changed);
      // Nothing, when another Notato has taken this one's place already.
      runtime.detach(this);
      _ui
        ..remove()
        ..dispose();
    }
    _toastTimer?.cancel();
    _pinTimer?.cancel();
    _routeTimer?.cancel();
    super.dispose();
  }

  void _changed() {
    if (!mounted) return;
    // Annotating stopped from code: the selection goes with it.
    if (!runtime.isAnnotating) _selection = null;
    setState(() {});
    _schedulePins();
  }

  @override
  void setState(VoidCallback fn) {
    super.setState(fn);
    if (_ui.mounted) _ui.markNeedsBuild();
  }

  // ---- the host the runtime works through --------------------------------------------------------------------------

  Element? get _appElement => _appKey.currentContext as Element?;
  RenderBox? get _appBox => _appKey.currentContext?.findRenderObject() as RenderBox?;

  @override
  String route() => routeName(widget.route?.call() ?? Notato.navigatorObserver.current ?? '/');

  @override
  DeviceInfo device() {
    final view = View.of(context);
    final size = view.physicalSize / view.devicePixelRatio;
    return DeviceInfo(
      os: platformName(),
      osVersion: platformVersion(),
      width: size.width,
      height: size.height,
      pixelRatio: view.devicePixelRatio,
      dart: dartVersion(),
    );
  }

  @override
  void toast(String message) {
    _toastTimer?.cancel();
    setState(() => _toast = message);
    _toastTimer = Timer(const Duration(milliseconds: 3200), () {
      if (mounted) setState(() => _toast = null);
    });
  }

  Rect get _screen {
    final box = _appBox;
    return box == null || !box.hasSize ? Rect.zero : box.localToGlobal(Offset.zero) & box.size;
  }

  @override
  Future<Picked> resolve(Object target) async {
    final root = _appElement;
    if (root == null) throw const NotatoException('The Notato widget is not laid out yet.');
    if (target is String) {
      List<TreeElement> found;
      try {
        found = query(elementsUnder(root, maskInputs: runtime.maskInputs), target);
      } on SelectorException catch (e) {
        throw NotatoException('Not a selector Notato reads: ${e.message}');
      }
      if (found.isEmpty) throw NotatoException('Nothing on this screen matches "$target".');
      // The first one on screen; else the first at all (scrolled away, say). Read again in full for the note.
      final screen = _screen;
      final match = found.firstWhere((e) => e.picked.rect.overlaps(screen), orElse: () => found.first).picked;
      final full = identify(match.element, match.box, stop: root, maskInputs: runtime.maskInputs);
      if (full == null) throw NotatoException('Nothing on this screen matches "$target".');
      return full;
    }
    final element = switch (target) {
      GlobalKey(:final currentContext) => currentContext as Element?,
      final Element element => element,
      _ => null,
    };
    final box = element?.renderObject;
    if (element == null || box is! RenderBox || !box.hasSize) {
      throw const NotatoException('That widget is not on screen.');
    }
    final picked = identify(element, box, stop: root, maskInputs: runtime.maskInputs);
    if (picked == null) throw const NotatoException('That widget is not one the app wrote: nothing to annotate.');
    return picked;
  }

  @override
  Future<({Shot? full, Shot? crop})> capture(Picked picked, int pin, String id) =>
      _oneAtATime.run(() => _photograph(picked, pin, id));

  /// The screenshots for a note: the widget on its own (masked), then the screen as the person saw it, outlined and
  /// numbered. The two pictures of the whole screen are let go of as soon as the PNGs are made.
  Future<({Shot? full, Shot? crop})> _photograph(Picked picked, int pin, String id) async {
    final boundary = _shotKey.currentContext?.findRenderObject();
    final app = _appBox;
    if (!mounted || !runtime.screenshotsOn || boundary is! RenderRepaintBoundary || app == null) {
      return (full: null, crop: null);
    }
    Rect local(Rect global) => boundary.globalToLocal(global.topLeft) & global.size;
    final rect = local(picked.rect);
    final covers = coversUnder(app, maskInputs: runtime.maskInputs).map(local).toList();
    final ratio = math.min(View.of(context).devicePixelRatio, runtime.configuration?.maxScreenshotScale ?? 2);
    ui.Image? plain;
    ui.Image? outlined;
    try {
      setState(() => _capturing = (rect: Rect.zero, pin: pin, covers: covers));
      await WidgetsBinding.instance.endOfFrame;
      plain = await grab(boundary, ratio);
      if (!mounted) return (full: null, crop: null);
      setState(() => _capturing = (rect: rect, pin: pin, covers: covers));
      await WidgetsBinding.instance.endOfFrame;
      outlined = await grab(boundary, ratio);
      final full = outlined == null ? null : await pngOf(outlined, '$id-full');
      Shot? crop;
      if (plain != null && full != null) {
        final area = Rect.fromLTRB(
          rect.left * ratio,
          rect.top * ratio,
          rect.right * ratio,
          rect.bottom * ratio,
        ).inflate(2 * ratio);
        crop = await pngOf(plain, '$id-crop', crop: area);
      }
      return (full: full, crop: crop);
    } finally {
      plain?.dispose();
      outlined?.dispose();
    }
  }

  @override
  void select(Picked picked) {
    runtime.startAnnotating();
    unawaited(_choose(picked));
  }

  @override
  Future<bool> share(String path) async {
    final box = _rootKey.currentContext?.findRenderObject() as RenderBox?;
    final origin = box == null || !box.hasSize
        ? null
        : Rect.fromCenter(center: box.size.center(Offset.zero), width: 1, height: 1);
    final result = await SharePlus.instance.share(
      ShareParams(
        files: [XFile(path, mimeType: 'application/zip')],
        title: 'Notato notes',
        sharePositionOrigin: origin,
      ),
    );
    return result.status == ShareResultStatus.success;
  }

  // ---- picking and writing a note ----------------------------------------------------------------------------------

  Future<void> _choose(Picked picked, {_Selection? keep}) async {
    final pin = keep?.pin ?? runtime.nextPin(route());
    final id = keep?.id ?? ulid();
    final shots = await capture(picked, pin, id);
    if (!mounted) return;
    setState(() {
      _sheet = null;
      _selection = _Selection(picked, pin, id, shots);
    });
  }

  Future<void> _pickAt(Offset global) async {
    final root = _appElement;
    final box = _appBox;
    if (root == null || box == null) return;
    final picked = pickAt(box, global, stop: root, maskInputs: runtime.maskInputs);
    if (picked == null) {
      toast('Nothing to annotate there.');
      return;
    }
    await _choose(picked, keep: _selection);
  }

  Future<void> _parent() async {
    final selection = _selection;
    final root = _appElement;
    if (selection == null || root == null) return;
    final parent = parentOf(selection.picked, stop: root, maskInputs: runtime.maskInputs);
    if (parent == null) {
      toast('Nothing around this one to select.');
      return;
    }
    await _choose(parent, keep: selection);
  }

  void _cancel() {
    setState(() => _selection = null);
    runtime.stopAnnotating();
  }

  Future<void> _send(Draft draft) async {
    final chosen = _selection;
    if (chosen == null) return;
    setState(() => _selection = null);
    runtime.stopAnnotating();
    try {
      final made = await runtime.createNote(
        chosen.picked,
        comment: draft.comment,
        intent: draft.intent,
        severity: draft.severity,
        peopleOnly: draft.peopleOnly,
        id: chosen.id,
        pin: chosen.pin,
        full: chosen.shots.full,
        crop: chosen.shots.crop,
      );
      toast(made.problem ?? (runtime.hasServer ? 'Sent' : 'Saved on this device. Package it from the menu.'));
    } catch (e) {
      toast('Not saved: $e');
    }
  }

  void _startAnnotating() {
    setState(() => _sheet = null);
    if (!kDebugMode) {
      toast('Annotating needs a debug build of the app.');
      return;
    }
    runtime.startAnnotating();
  }

  void _open(Sheet? sheet) => setState(() => _sheet = sheet);

  @override
  Future<bool> didPopRoute() async {
    // Android's Back closes a sheet or the composer, or stops annotating, before it reaches the app.
    final sheet = _sheet;
    if (sheet != null) {
      _open(switch (sheet) {
        PinSheetKind(fromList: true) => const ListSheetKind(),
        ListSheetKind() || SettingsSheetKind() || ClearSheetKind() => const MenuSheetKind(),
        _ => null,
      });
      return true;
    }
    if (_selection != null || runtime.isAnnotating) {
      _cancel();
      return true;
    }
    return false;
  }

  // ---- pins: where their widgets are now, found again by their selectors twice a second ----------------------------

  void _schedulePins() {
    final wanted =
        runtime.isEnabled &&
        runtime.pinsVisible &&
        _selection == null &&
        !runtime.isAnnotating &&
        runtime.pinsOn(route()).isNotEmpty;
    if (!wanted) {
      _pinTimer?.cancel();
      _pinTimer = null;
      if (_pins.isNotEmpty) setState(() => _pins = const []);
      return;
    }
    if (_pinTimer != null) return;
    _drawn = true;
    _watchFrames();
    _placePins();
    _pinTimer = Timer.periodic(const Duration(milliseconds: 500), (_) => _placePins());
  }

  void _watchFrames() {
    if (_watchingFrames) return;
    _watchingFrames = true;
    void drawn(Duration _) {
      _watchingFrames = false;
      if (!mounted || _pinTimer == null) return;
      _drawn = true;
      _watchFrames();
    }

    WidgetsBinding.instance.addPostFrameCallback(drawn);
  }

  void _placePins() {
    final root = _appElement;
    if (!mounted || root == null) return;
    final here = runtime.pinsOn(route());
    // Nothing drawn, and the same screen with the same notes as the last time: the pins are where they were.
    if (!_drawn && identical(_placedFor, here)) return;
    _drawn = false;
    _placedFor = here;
    final shown = here.length > maxPins ? here.sublist(here.length - maxPins) : here;
    List<TreeElement>? elements;
    SelectorIndex<TreeElement>? index;
    final screen = _screen;
    final placed = <_Pin>[];
    for (final (:number, :record) in shown) {
      final a = record.annotation;
      final r = (a['target'] as Map?)?['rect'] as Map? ?? const {};
      double n(String k) => (r[k] as num?)?.toDouble() ?? 0;
      final stored = Rect.fromLTWH(n('x'), n('y'), n('w'), n('h'));
      final identity = ((a['target'] as Map?)?['identity'] as List?)?.firstOrNull;
      Rect? found;
      if (identity is Map) {
        try {
          elements ??= elementsUnder(root, maskInputs: runtime.maskInputs);
          index ??= indexOf(elements);
          final matches = query(elements, selectorToFind(identity.cast<String, Object?>()), index: index).take(12);
          // Of several alike (a list's rows), the one nearest where the note was made.
          double? best;
          for (final m in matches) {
            final rect = m.picked.rect;
            final d = (rect.topLeft - stored.topLeft).distance + (rect.width - stored.width).abs();
            if (best == null || d < best) {
              best = d;
              found = rect;
            }
          }
        } catch (_) {
          found = null;
        }
      }
      // A widget scrolled out of sight takes its pin with it.
      if (found != null && !found.overlaps(screen)) continue;
      placed.add(_Pin(record, number, found ?? stored, found == null));
    }
    // Only a change is drawn: setting the same pins again would draw a frame, and so look for them again.
    if (_samePins(placed, _pins)) return;
    setState(() => _pins = placed);
  }

  static bool _samePins(List<_Pin> a, List<_Pin> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      final x = a[i];
      final y = b[i];
      if (!identical(x.record, y.record) || x.number != y.number || x.rect != y.rect || x.detached != y.detached) {
        return false;
      }
    }
    return true;
  }

  // ---- what Notato draws -------------------------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    if (!_available) return widget.child;
    final capturing = _capturing;
    final selection = _selection;
    final boundary = _shotKey.currentContext?.findRenderObject() as RenderBox?;
    Rect local(Rect global) => boundary == null ? global : boundary.globalToLocal(global.topLeft) & global.size;
    final outline = capturing != null
        ? (capturing.rect == Rect.zero ? null : (rect: capturing.rect, pin: capturing.pin))
        : selection == null
        ? null
        : (rect: local(selection.picked.rect), pin: selection.pin);
    return Stack(
      key: _rootKey,
      textDirection: TextDirection.ltr,
      fit: StackFit.expand,
      children: [
        // What a screenshot shows: the app, the covers and the outline while a widget is being annotated. Never the
        // toolbar. The app's place in the tree never changes, so switching Notato on and off never rebuilds it.
        RepaintBoundary(
          key: _shotKey,
          child: Stack(
            textDirection: TextDirection.ltr,
            fit: StackFit.expand,
            children: [
              KeyedSubtree(key: _appKey, child: widget.child),
              for (final cover in capturing?.covers ?? const <Rect>[])
                Positioned.fromRect(
                  rect: cover,
                  child: IgnorePointer(
                    child: DecoratedBox(
                      decoration: BoxDecoration(color: const Color(0xFF8B8F97), borderRadius: BorderRadius.circular(4)),
                    ),
                  ),
                ),
              if (outline != null)
                Positioned.fromRect(
                  rect: outline.rect.inflate(2),
                  child: IgnorePointer(child: _Outline(pin: outline.pin)),
                ),
            ],
          ),
        ),
        // Notato's own interface, with what it needs whatever the app is (Material, Cupertino or neither). Always there,
        // and empty while Notato is off: an overlay entry belongs to one Overlay for good.
        Positioned.fill(
          child: MediaQuery.fromView(
            view: View.of(context),
            child: Localizations(
              locale: const Locale('en'),
              delegates: const [
                DefaultMaterialLocalizations.delegate,
                DefaultCupertinoLocalizations.delegate,
                DefaultWidgetsLocalizations.delegate,
              ],
              child: Theme(
                data: ThemeData(colorSchemeSeed: Brand.accent, useMaterial3: true),
                child: Directionality(
                  textDirection: TextDirection.ltr,
                  child: Material(
                    type: MaterialType.transparency,
                    child: Overlay(initialEntries: [_ui]),
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildUi(BuildContext context) {
    if (!runtime.isEnabled) return const SizedBox.shrink();
    final media = MediaQuery.of(context);
    final size = media.size;
    final rootBox = _rootKey.currentContext?.findRenderObject();
    Rect toLocal(Rect global) =>
        rootBox is RenderBox && rootBox.attached ? rootBox.globalToLocal(global.topLeft) & global.size : global;
    final hiding = _capturing != null;
    final selection = _selection;
    final screen = _drawnRoute = route();
    final here = runtime.notesOn(screen);
    final sheet = _sheet;
    final spots = placePins([for (final p in _pins) toLocal(p.rect)], size.width, top: media.padding.top + 4);
    final problem = switch (runtime.connection) {
      NotatoConnection.connecting => Brand.connecting,
      NotatoConnection.offline || NotatoConnection.refused => Brand.offline,
      _ => null,
    };
    final composerAtTop = selection != null && toLocal(selection.picked.rect).center.dy > size.height / 2;

    return Stack(
      children: [
        // Takes the taps that pick while annotating; Notato's own controls sit above it.
        if (runtime.isAnnotating && sheet == null)
          Positioned.fill(
            child: GestureDetector(
              key: const ValueKey('NotatoPicker'),
              behavior: HitTestBehavior.opaque,
              onTapUp: (d) => _pickAt(d.globalPosition),
            ),
          ),
        if (!hiding) ...[
          for (final (i, pin) in _pins.indexed)
            if (i < spots.length)
              Positioned(
                left: spots[i].dx,
                top: spots[i].dy,
                child: Opacity(
                  opacity: pin.detached ? 0.55 : 1,
                  child: Semantics(
                    button: true,
                    label: 'Note ${pin.number}, ${pin.record.status.replaceAll('_', ' ')}',
                    child: GestureDetector(
                      onTap: () => _open(PinSheetKind(pin.record.id)),
                      child: PinDot(number: pin.number, status: pin.record.status, pending: pin.record.pending),
                    ),
                  ),
                ),
              ),
          if (runtime.isAnnotating && selection == null && sheet == null)
            Positioned(
              top: media.padding.top + 4,
              left: 16,
              right: 16,
              child: Center(child: HintBar(done: _cancel)),
            ),
          if (runtime.isToolbarVisible && selection == null)
            Toolbar(
              room: size,
              insets: media.padding,
              place: (x: runtime.toolbar.x, y: runtime.toolbar.y),
              corner: runtime.configuration?.toolbarPosition ?? NotatoPosition.bottomRight,
              folded: runtime.toolbar.folded,
              annotating: runtime.isAnnotating,
              count: here.length,
              problem: problem,
              problemLabel: runtime.describeConnection(),
              onAnnotate: () => runtime.isAnnotating ? _cancel() : _startAnnotating(),
              onMenu: () => _open(const MenuSheetKind()),
              onFold: runtime.setFolded,
              onMoved: runtime.placeToolbar,
            ),
          if (selection != null)
            Positioned(
              left: 10,
              right: 10,
              top: composerAtTop ? media.padding.top + 8 : null,
              bottom: composerAtTop ? null : math.max(media.viewInsets.bottom, media.padding.bottom) + 10,
              child: Center(
                child: Composer(
                  key: ValueKey(selection.id),
                  title: _title(selection.picked),
                  subtitle: _subtitle(selection.picked),
                  screenshotsOff: !runtime.screenshotsOn,
                  onParent: _parent,
                  onCancel: _cancel,
                  onSend: _send,
                ),
              ),
            ),
          if (sheet != null)
            Positioned.fill(
              child: BottomSheetFrame(close: () => _open(null), child: _sheetFor(sheet, here)),
            ),
          if (_toast != null)
            Positioned(
              top: media.padding.top + 4,
              left: 16,
              right: 16,
              child: IgnorePointer(
                child: Center(
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
                    decoration: BoxDecoration(
                      color: Bar.bar,
                      borderRadius: BorderRadius.circular(999),
                      border: Border.all(color: Bar.line),
                      boxShadow: const [BoxShadow(color: Color(0x47000000), blurRadius: 12, offset: Offset(0, 4))],
                    ),
                    child: Text(
                      _toast!,
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: Bar.text),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ],
    );
  }

  Widget _sheetFor(Sheet sheet, ScreenNotes here) => switch (sheet) {
    MenuSheetKind() => MenuSheet(
      runtime: runtime,
      here: here.length,
      pins: runtime.pinsOn(_drawnRoute ?? route()).length,
      open: _open,
      annotate: _startAnnotating,
      packageAndShare: () => unawaited(runtime.packageAndShare().then(toast, onError: (Object e) => toast('$e'))),
    ),
    ListSheetKind() => NotesSheet(runtime: runtime, list: here, open: _open, annotate: _startAnnotating),
    SettingsSheetKind() => SettingsSheet(runtime: runtime, open: _open, toast: toast),
    ClearSheetKind() => ClearSheet(runtime: runtime, open: _open, toast: toast),
    PinSheetKind(:final id, :final fromList) => () {
      final record = runtime.note(id);
      if (record == null) {
        return const Padding(
          padding: EdgeInsets.all(20),
          child: Text('That note is gone.', style: TextStyle(color: Brand.danger)),
        );
      }
      final number = here.where((n) => n.record.id == id).firstOrNull?.number ?? 0;
      return NoteCard(
        key: ValueKey(id),
        runtime: runtime,
        record: record,
        number: number,
        fromList: fromList,
        open: _open,
        toast: toast,
      );
    }(),
  };

  /// What a selection is called in the composer: the widget class around it and the widget.
  String _title(Picked picked) {
    final component = (picked.identity['component'] as Map?)?['name'] as String?;
    final tag = picked.identity['tag'] as String? ?? '';
    return component == null || component == tag ? tag : '$component › $tag';
  }

  /// What the composer says under the title: the widget's key or text, and the file and line it is written at.
  String? _subtitle(Picked picked) {
    final id = picked.identity;
    final testId = id['testId'] as String?;
    final text = id['text'] as String?;
    final said = testId != null ? '#$testId' : (text != null ? '“${clip(text, 40)}”' : id['name'] as String?);
    final source = id['source'] as Map?;
    final where = source == null ? null : '${(source['file'] as String).split('/').last}:${source['line']}';
    final parts = [?said, ?where];
    return parts.isEmpty ? null : parts.join(' · ');
  }
}

/// The outline around the widget a note is about, with the note's number.
class _Outline extends StatelessWidget {
  const _Outline({required this.pin});
  final int pin;

  @override
  Widget build(BuildContext context) => Stack(
    clipBehavior: Clip.none,
    textDirection: TextDirection.ltr,
    children: [
      Positioned.fill(
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: Brand.selection.withValues(alpha: 0.08),
            border: Border.all(color: Brand.selection, width: 2),
            borderRadius: BorderRadius.circular(4),
          ),
        ),
      ),
      Positioned(
        top: -12,
        right: -12,
        child: Directionality(
          textDirection: TextDirection.ltr,
          child: Container(
            width: 24,
            height: 24,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: Brand.selection,
              shape: BoxShape.circle,
              border: Border.all(color: Colors.white, width: 2),
            ),
            child: Text(
              '$pin',
              style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w800),
            ),
          ),
        ),
      ),
    ],
  );
}
