/// Who annotates, and where the notes go: the same three modes as every Notato SDK.
enum NotatoMode {
  /// The developer, live to a local `notato dev` server that your coding agent reads over MCP.
  dev,

  /// A tester. Notes are kept on the device and packaged as a zip, and uploaded when a server is set.
  test,

  /// An AI agent driving the app. Like dev, and the app also takes `notato_annotate` requests.
  agent,
}

/// The corner the toolbar starts in.
enum NotatoPosition {
  /// The bottom right corner, the default.
  bottomRight,

  /// The bottom left corner.
  bottomLeft,

  /// The top right corner, under the status bar.
  topRight,

  /// The top left corner, under the status bar.
  topLeft,
}

/// Where `notato dev` listens: the server in dev and agent mode unless the app says otherwise.
const defaultServer = 'http://localhost:4747';

/// The configuration with its defaults filled in.
class NotatoConfig {
  const NotatoConfig({
    required this.project,
    this.mode = NotatoMode.dev,
    this.server,
    this.token,
    this.appName = 'Flutter app',
    this.appVersion,
    this.author,
    this.enabled = true,
    this.showToolbar = true,
    this.toolbarPosition = NotatoPosition.bottomRight,
    this.screenshots = true,
    this.maskInputs = false,
    this.rememberRuntimeState = true,
    this.captureLogs = true,
    this.logLimit = 50,
    this.maxScreenshotScale = 2,
  });

  final String project;
  final NotatoMode mode;

  /// The server notes go to, or none.
  final String? server;
  final String? token;
  final String appName;
  final String? appVersion;
  final String? author;
  final bool enabled;
  final bool showToolbar;
  final NotatoPosition toolbarPosition;
  final bool screenshots;
  final bool maskInputs;
  final bool rememberRuntimeState;
  final bool captureLogs;
  final int logLimit;
  final double maxScreenshotScale;

  /// The `Notato` widget's options with their defaults filled in. `server`: null for the mode's default (localhost in
  /// dev and agent mode, none in test mode), empty for none.
  static NotatoConfig resolve({
    required String project,
    NotatoMode mode = NotatoMode.dev,
    String? server,
    String? token,
    String? appName,
    String? appVersion,
    String? author,
    bool enabled = true,
    bool showToolbar = true,
    NotatoPosition toolbarPosition = NotatoPosition.bottomRight,
    bool screenshots = true,
    bool? maskInputs,
    bool rememberRuntimeState = true,
    bool captureLogs = true,
    int logLimit = 50,
    double maxScreenshotScale = 2,
  }) {
    final trimmed = server?.trim().replaceAll(RegExp(r'/+$'), '');
    return NotatoConfig(
      project: project,
      mode: mode,
      server: trimmed == null
          ? (mode == NotatoMode.test ? null : defaultServer)
          : trimmed.isEmpty
          ? null
          : trimmed,
      token: token == null || token.isEmpty ? null : token,
      appName: appName == null || appName.trim().isEmpty ? 'Flutter app' : appName.trim(),
      appVersion: appVersion,
      author: author,
      enabled: enabled,
      showToolbar: showToolbar,
      toolbarPosition: toolbarPosition,
      screenshots: screenshots,
      maskInputs: maskInputs ?? mode != NotatoMode.dev,
      rememberRuntimeState: rememberRuntimeState,
      captureLogs: captureLogs,
      logLimit: logLimit.clamp(0, 1000),
      maxScreenshotScale: maxScreenshotScale,
    );
  }

  /// Why it cannot be used, or null. As the server checks a project id, so it is always a safe folder name.
  String? get problem {
    if (project.isEmpty) return "Notato needs a project: Notato(project: 'shop', …).";
    if (!RegExp(r'^(?!\.+$)[A-Za-z0-9_.@-]{1,128}$').hasMatch(project)) {
      return 'Notato\'s project "$project" may only use letters, digits and . _ - @ (at most 128), and not only dots.';
    }
    final s = server;
    if (s != null && !RegExp(r'^https?://[^/\s]+', caseSensitive: false).hasMatch(s)) {
      return 'Notato\'s server "$s" is not an http(s) address.';
    }
    if (maxScreenshotScale < 1 || maxScreenshotScale > 4) return "Notato's maxScreenshotScale must be between 1 and 4.";
    return null;
  }

  /// The same project and server: a change of anything else does not need a new connection.
  bool sameConnection(NotatoConfig other) =>
      project == other.project && mode == other.mode && server == other.server && token == other.token;
}

/// The server as people know it: `localhost:4747`.
String hostOf(String server) => server.replaceFirst(RegExp(r'^https?://', caseSensitive: false), '').split('/').first;
