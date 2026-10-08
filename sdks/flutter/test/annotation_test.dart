import 'package:flutter_test/flutter_test.dart';
import 'package:notato/src/annotation.dart';
import 'package:notato/src/events.dart';
import 'package:notato/src/ids.dart';
import 'package:notato/src/version.dart';

import 'helpers.dart';

Map<String, Object?> note({Shot? full, Shot? crop}) => buildAnnotation(
  project: 'shop',
  appName: 'Spud Shop',
  appVersion: '1.0.0',
  route: 'checkout',
  author: 'Ada',
  identity: {
    'selector': 'ProductCard > ElevatedButton#add > Text',
    'tag': 'Text',
    'text': 'Add to basket',
    'source': {'file': '/repo/lib/product_card.dart', 'line': 24, 'col': 13},
    'component': {'name': 'ProductCard', 'source': '/repo/lib/product_card.dart:24:13'},
  },
  rect: (x: 16.004, y: 120.5, w: 132.27, h: 40),
  comment: '  Show the price  ',
  intent: 'change',
  severity: 'minor',
  pin: 4,
  full: full,
  crop: crop,
  device: const DeviceInfo(os: 'ios', osVersion: '26.3', width: 402, height: 874, pixelRatio: 3, dart: '3.13.5'),
);

void main() {
  test('builds a note the server takes, by its own schema', () async {
    final shot = Shot(id: '01ABC-full', bytes: const [1], width: 1206, height: 2622);
    final crop = Shot(id: '01ABC-crop', bytes: const [1], width: 400, height: 120);
    final annotation = note(full: shot, crop: crop);
    expect(annotation['url'], 'flutter://spud-shop/checkout');
    expect(annotation['comment'], 'Show the price');
    expect(annotation['environment'], containsPair('platform', 'flutter'));
    expect((annotation['environment'] as Map)['sdk'], {'name': notatoSdkName, 'version': notatoSdkVersion});
    expect((annotation['target'] as Map)['rect'], {'x': 16.0, 'y': 120.5, 'w': 132.27, 'h': 40.0});
    expect(annotation['screenshots'], {
      'full': {'id': '01ABC-full', 'mime': 'image/png', 'w': 1206, 'h': 2622},
      'crop': {'id': '01ABC-crop', 'mime': 'image/png', 'w': 400, 'h': 120},
    });
    expect((annotation['context'] as Map)['screenshot'], {'method': 'native', 'pin': 4});
    final result = await validate('annotation', annotation);
    if (result == null) return markTestSkipped('bun is not installed');
    expect(result.ok, isTrue, reason: result.output);
  });

  test('is still a note the server takes with no screenshots and nothing optional', () async {
    final annotation = buildAnnotation(
      project: 'shop',
      appName: 'Shop',
      route: '/',
      identity: {'selector': 'Text', 'tag': 'Text'},
      rect: (x: 0, y: 0, w: 10, h: 10),
      comment: 'Too tight',
      pin: 1,
      device: const DeviceInfo(os: 'android', osVersion: '16', width: 411, height: 914, pixelRatio: 2.625),
    );
    expect(annotation.containsKey('screenshots'), isFalse);
    expect(annotation['author'], {'kind': 'human'});
    final result = await validate('annotation', annotation);
    if (result != null) expect(result.ok, isTrue, reason: result.output);
  });

  test('makes ULIDs that sort by time', () {
    final a = ulid(DateTime.fromMillisecondsSinceEpoch(1700000000000));
    final b = ulid(DateTime.fromMillisecondsSinceEpoch(1700000000001));
    expect(a, matches(RegExp(r'^[0-9A-HJKMNP-TV-Z]{26}$')));
    expect(a.compareTo(b), lessThan(0));
  });

  test('reads the event stream as it arrives', () {
    final parser = EventParser();
    expect(parser.add('event: hello\ndata: {"agent":{"connected":true,"names":["Claude"]}}\n\n: ping\n\nevent: upd'), [
      isA<ServerEvent>().having((e) => e.event, 'event', 'hello').having((e) => (e.data! as Map)['agent'], 'agent', {
        'connected': true,
        'names': ['Claude'],
      }),
    ]);
    final rest = parser.add('ated\r\ndata: {"id":"a1"}\r\n\r\n');
    expect(rest.single.event, 'updated');
    expect(rest.single.data, {'id': 'a1'});
    expect(parser.add('data: plain\n\n').single.data, 'plain');
  });
}
