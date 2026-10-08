import 'ids.dart';
import 'version.dart';

/// A screenshot, as its PNG bytes and the reference the note carries (the server stores it under its own hash).
class Shot {
  const Shot({required this.id, required this.bytes, required this.width, required this.height});
  final String id;
  final List<int> bytes;
  final int width;
  final int height;

  Map<String, Object?> get ref => {'id': id, 'mime': 'image/png', 'w': width, 'h': height};
}

/// The device a note is made on.
class DeviceInfo {
  const DeviceInfo({
    required this.os,
    required this.osVersion,
    required this.width,
    required this.height,
    required this.pixelRatio,
    this.dart,
  });
  final String os;
  final String osVersion;
  final double width;
  final double height;
  final double pixelRatio;
  final String? dart;
}

/// The platform this SDK's notes say they were made on (`environment.platform`), and the notes it pins.
const notatoPlatform = 'flutter';

double _round2(double n) => (n * 100).roundToDouble() / 100;

/// `flutter://spud-shop/checkout`: where a note was made, in the shape of a URL like every SDK's.
String appUrl(String appName, String route) {
  final app = Uri.encodeComponent(appName.toLowerCase().replaceAll(RegExp(r'\s+'), '-'));
  return 'flutter://$app${route.startsWith('/') ? route : '/$route'}';
}

/// A route as notes file it: `/` when the app does not say, and always with its leading slash.
String routeName(String? route) {
  final r = (route ?? '').trim();
  if (r.isEmpty) return '/';
  return r.startsWith('/') ? r : '/$r';
}

/// The words every Notato SDK uses for keeping things from the agent.
abstract final class PeopleOnlyCopy {
  static const title = 'People only';
  static const hint = "Keep this between people: the agent won't see it.";
  static const aside = 'Aside';
  static const asideHint = "Just for people: the agent won't see this reply.";
  static const on = "Made this people only: the agent won't see it.";
  static const off = 'Shared this with the agent.';
}

/// The thread's record of People only being turned on or off, as the server writes it.
Map<String, Object?> peopleOnlyChange(bool on, Map<String, Object?> author, [DateTime? now]) {
  final at = now ?? DateTime.now();
  return {
    'id': ulid(at),
    'author': author,
    'body': on ? PeopleOnlyCopy.on : PeopleOnlyCopy.off,
    'createdAt': at.toUtc().toIso8601String(),
    'automatic': true,
    'peopleOnly': on,
  };
}

/// A note not on the server yet, with People only turned on or off and the change recorded in its thread.
Map<String, Object?> settingPeopleOnly(
  Map<String, Object?> annotation,
  bool on,
  Map<String, Object?> author, [
  DateTime? now,
]) {
  if (on == (annotation['peopleOnly'] == true)) return annotation;
  final next = {...annotation};
  next['thread'] = [...(annotation['thread'] as List? ?? const []), peopleOnlyChange(on, author, now)];
  if (on) {
    next['peopleOnly'] = true;
  } else {
    next.remove('peopleOnly');
  }
  return next;
}

/// The annotation the server takes (`POST /projects/:id/annotations`), as @notato/schema describes it.
Map<String, Object?> buildAnnotation({
  required String project,
  String mode = 'dev',
  required String appName,
  String? appVersion,
  required String route,
  String? author,
  String? agentName,
  required Map<String, Object?> identity,
  required ({double x, double y, double w, double h}) rect,
  required String comment,
  String? intent,
  String? severity,
  bool peopleOnly = false,
  List<Map<String, Object?>>? steps,
  required int pin,
  Shot? full,
  Shot? crop,
  required DeviceInfo device,
  List<Map<String, Object?>>? console,
  List<Map<String, Object?>>? network,
  DateTime? now,
  String? id,
}) {
  return {
    'id': id ?? ulid(),
    'projectId': project,
    'bundleId': null,
    'author': agentName != null ? {'kind': 'agent', 'name': agentName} : {'kind': 'human', 'name': ?author},
    'mode': mode,
    'createdAt': (now ?? DateTime.now()).toUtc().toIso8601String(),
    'url': appUrl(appName, route),
    'route': route,
    'appName': appName,
    'appVersion': ?appVersion,
    'environment': {
      'userAgent': '$appName${appVersion == null ? '' : '/$appVersion'} (${device.os} ${device.osVersion}) Flutter',
      'viewport': {'w': _round2(device.width), 'h': _round2(device.height)},
      'dpr': device.pixelRatio,
      'platform': notatoPlatform,
      'sdk': {'name': notatoSdkName, 'version': notatoSdkVersion},
    },
    'target': {
      'kind': 'element',
      'identity': [identity],
      'rect': {'x': _round2(rect.x), 'y': _round2(rect.y), 'w': _round2(rect.w), 'h': _round2(rect.h)},
    },
    'comment': comment.trim(),
    'severity': ?severity,
    'intent': ?intent,
    if (full != null) 'screenshots': {'full': full.ref, if (crop != null) 'crop': crop.ref},
    if (steps != null && steps.isNotEmpty) 'steps': steps,
    'context': {
      'screenshot': {'method': 'native', 'pin': pin},
      'flutter': {'os': device.os, 'osVersion': device.osVersion, 'dart': ?device.dart},
      if (console != null && console.isNotEmpty) 'console': console,
      if (network != null && network.isNotEmpty) 'network': network,
    },
    'status': 'open',
    'thread': <Object?>[],
    // A person's note only: an agent's is never kept from the agent.
    if (peopleOnly && agentName == null) 'peopleOnly': true,
  };
}
