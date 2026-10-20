import 'package:flutter/foundation.dart';

/// `Bearer …` and `Basic …` credentials written into a message.
final _scheme = RegExp(r'\b(Bearer|Basic)\s+[\w.~+/=-]+', caseSensitive: false);

/// A cookie or API key header's value, to the end of it.
final _header = RegExp(r'''\b(cookie|set-cookie|x-api-key)(["']?\s*[:=]\s*)[^\n"'}]+''', caseSensitive: false);

/// A password or token as a printed map or a form writes it: `password: hunter2`, `access_token=…`.
final _field = RegExp(
  r'''\b(password|passwd|secret|(?:access_|refresh_|id_)?token)(["']?\s*[:=]\s*)[^\s"',;}&]+''',
  caseSensitive: false,
);

/// A message with the credentials in it blanked out: they would go to the server and the agent with the note.
@visibleForTesting
String redact(String message) => message
    .replaceAllMapped(_scheme, (m) => '${m[1]} [redacted]')
    .replaceAllMapped(_header, (m) => '${m[1]}${m[2]}[redacted]')
    .replaceAllMapped(_field, (m) => '${m[1]}${m[2]}[redacted]');

/// Keeps the app's last messages, in the web SDK's shape (`context.console`): Flutter's errors (`FlutterError.onError`),
/// uncaught ones (`PlatformDispatcher.onError`), and what it prints with `debugPrint`. Each still goes where it went,
/// as it was; the copy kept has its credentials blanked out. Returns a function that puts them back.
VoidCallback captureLogs(int Function() limit, List<Map<String, Object?>> into) {
  void add(String level, String raw) {
    final message = redact(raw);
    final text = message.length > 1000 ? '${message.substring(0, 999)}…' : message;
    into.add({'level': level, 'message': text, 'at': DateTime.now().toUtc().toIso8601String()});
    final over = into.length - limit();
    if (over > 0) into.removeRange(0, over);
  }

  final onError = FlutterError.onError;
  final onPlatformError = PlatformDispatcher.instance.onError;
  final print = debugPrint;
  void flutterError(FlutterErrorDetails details) {
    add('error', details.exceptionAsString());
    (onError ?? FlutterError.presentError)(details);
  }

  bool platformError(Object error, StackTrace stack) {
    add('error', '$error');
    return onPlatformError?.call(error, stack) ?? false;
  }

  void printed(String? message, {int? wrapWidth}) {
    if (message != null) add('log', message);
    print(message, wrapWidth: wrapWidth);
  }

  FlutterError.onError = flutterError;
  PlatformDispatcher.instance.onError = platformError;
  debugPrint = printed;
  return () {
    // Only what is still ours: something set after us stays.
    if (FlutterError.onError == flutterError) FlutterError.onError = onError;
    if (PlatformDispatcher.instance.onError == platformError) PlatformDispatcher.instance.onError = onPlatformError;
    if (debugPrint == printed) debugPrint = print;
  };
}
