import 'package:flutter/foundation.dart';

/// What the build declares (`flutter run --dart-define=NOTATO_ENABLED=true`): whether Notato is on, and its server.
/// Null for what it does not declare.
typedef Declarations = ({bool? enabled, String? server});

/// `NOTATO_ENABLED` and `NOTATO_SERVER` as the build gives them. Enabled is on for `true`, `1`, `yes` or `on` and off
/// for `false`, `0`, `no` or `off`, in any case; the server is anything not blank. Anything else counts as not declared.
Declarations parseDeclarations({String? enabled, String? server}) {
  final address = server?.trim() ?? '';
  return (
    enabled: switch (enabled?.trim().toLowerCase()) {
      'true' || '1' || 'yes' || 'on' => true,
      'false' || '0' || 'no' || 'off' => false,
      _ => null,
    },
    server: address.isEmpty ? null : address,
  );
}

/// Whether the build's `NOTATO_ENABLED` is read: always in a debug build (where tests stand in their own), and in
/// another only when it declares it. A constant, so a release build that does not declare it decides whether Notato is
/// there exactly as before, from the `enabled` option alone, and compiles Notato away when it is not.
const readsEnabled = kDebugMode || bool.hasEnvironment('NOTATO_ENABLED');

/// Whether the build's `NOTATO_SERVER` is read, as [readsEnabled].
const readsServer = kDebugMode || bool.hasEnvironment('NOTATO_SERVER');

/// For tests: what the build is taken to declare, in place of its own `--dart-define`s.
@visibleForTesting
Declarations? debugDeclarations;

/// What the build declares. Read only behind [readsEnabled] and [readsServer].
Declarations get declarations => debugDeclarations ?? _declared;

final _declared = parseDeclarations(
  enabled: const String.fromEnvironment('NOTATO_ENABLED'),
  server: const String.fromEnvironment('NOTATO_SERVER'),
);
