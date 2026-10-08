import 'dart:io';

/// `ios`, `android`, `macos`…
String platformName() => Platform.operatingSystem;

/// `26.5` from iOS's and macOS's `Version 26.5 (Build 23F77)`; Android's and others' as Dart gives it.
String platformVersion() {
  final raw = Platform.operatingSystemVersion;
  if (Platform.isIOS || Platform.isMacOS) return RegExp(r'\d+(\.\d+)+').firstMatch(raw)?.group(0) ?? raw;
  return raw;
}

String? dartVersion() => Platform.version.split(' ').first;
