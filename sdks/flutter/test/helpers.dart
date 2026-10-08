import 'dart:convert';
import 'dart:io';

/// The repository, found from where the tests run: the first folder up with packages/schema, which the contract needs.
Directory repository() {
  var dir = Directory.current.absolute;
  while (!Directory('${dir.path}/packages/schema').existsSync()) {
    final parent = dir.parent;
    if (parent.path == dir.path) throw StateError('no repository above ${Directory.current.path}');
    dir = parent;
  }
  return dir;
}

String? _bun() {
  final home = Platform.environment['HOME'];
  for (final candidate in [if (home != null) '$home/.bun/bin/bun', '/opt/homebrew/bin/bun', '/usr/local/bin/bun']) {
    if (File(candidate).existsSync()) return candidate;
  }
  return null;
}

/// Runs the server's own Zod schema over JSON this SDK wrote. Null when bun is not installed.
Future<({bool ok, String output})?> validate(String kind, Object json) async {
  final bun = _bun();
  if (bun == null) return null;
  final file = File('${Directory.systemTemp.path}/notato-${DateTime.now().microsecondsSinceEpoch}.json')
    ..writeAsStringSync(jsonEncode(json));
  try {
    final result = await Process.run(bun, [
      'sdks/flutter/scripts/validate.ts',
      kind,
      file.path,
    ], workingDirectory: repository().path);
    return (ok: result.exitCode == 0, output: '${result.stdout}${result.stderr}');
  } finally {
    file.deleteSync();
  }
}
