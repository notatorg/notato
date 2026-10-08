import 'package:flutter/foundation.dart';

/// Keeps the app's last messages, in the web SDK's shape (`context.console`): Flutter's errors (`FlutterError.onError`),
/// uncaught ones (`PlatformDispatcher.onError`), and what it prints with `debugPrint`. Each still goes where it went.
/// Returns a function that puts them back.
VoidCallback captureLogs(int Function() limit, List<Map<String, Object?>> into) {
  void add(String level, String message) {
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
