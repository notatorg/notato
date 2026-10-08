import 'package:flutter_test/flutter_test.dart';
import 'package:notato/src/selectors.dart';

class _El implements Candidate {
  _El(this.tag, {this.role, this.testId, this.label, this.text, this.path = const []});
  @override
  final String tag;
  @override
  final String? role;
  @override
  final String? testId;
  @override
  final String? label;
  @override
  final String? text;
  @override
  final List<String> path;
}

final screen = [
  _El('Text', text: 'Spud Shop', path: ['ShopScreen']),
  _El('Text', text: 'Maris Piper', path: ['ShopScreen', 'ProductCard']),
  _El('ElevatedButton', role: 'button', testId: 'add-to-basket', path: ['ShopScreen', 'ProductCard']),
  _El('Text', text: 'King Edward', path: ['ShopScreen', 'ProductCard']),
  _El(
    'ElevatedButton',
    role: 'button',
    testId: 'add-to-basket',
    label: 'Add King Edward',
    path: ['ShopScreen', 'ProductCard'],
  ),
  _El('TextField', role: 'textbox', label: 'Card number', path: ['CheckoutScreen']),
];

void main() {
  test('reads every part the mobile SDKs write', () {
    final s = parseSelector('ProductCard > button#add-to-basket[label="Add \\"King\\""]:text("King"):nth(2)');
    expect(
      [s.ancestors, s.type, s.id, s.label, s.text, s.nth],
      [
        ['ProductCard'],
        'button',
        'add-to-basket',
        'Add "King"',
        'King',
        2,
      ],
    );
    final nth = parseSelector('#add-to-basket:nth(3)');
    expect([nth.id, nth.nth], ['add-to-basket', 3]);
    expect(parseSelector("*:text('basket')").type, isNull);
    expect(() => parseSelector(''), throwsA(isA<SelectorException>()));
    expect(() => parseSelector('Text:text("open'), throwsA(isA<SelectorException>()));
    expect(() => parseSelector('Text:hover'), throwsA(isA<SelectorException>()));
  });

  test('finds by type, role, key, label and text, in painting order', () {
    expect(query(screen, '#add-to-basket'), hasLength(2));
    expect(query(screen, 'button'), hasLength(2));
    expect(query(screen, '[label="Card number"]').single.tag, 'TextField');
    expect(query(screen, ':text("king")').map((c) => c.text ?? c.label), ['King Edward', 'Add King Edward']);
    expect(query(screen, 'Text:nth(2)').single.text, 'Maris Piper');
    expect(query(screen, 'Text:nth(9)'), isEmpty);
  });

  test('narrows by the widgets around it, and ignores a name the app does not have', () {
    expect(query(screen, 'ProductCard > Text'), hasLength(2));
    expect(query(screen, 'Basket > #add-to-basket'), hasLength(2));
  });

  test('makes a selector that finds the same element again', () {
    final selector = selectorToFind({'selector': 'ProductCard > Text', 'text': 'King Edward'});
    expect(selector, 'ProductCard > Text:text("King Edward")');
    expect(query(screen, selector).single.text, 'King Edward');
    expect(
      selectorToFind({'selector': 'ProductCard > ElevatedButton#add', 'testId': 'add', 'text': 'x'}),
      'ProductCard > ElevatedButton#add',
    );
  });

  test('an index finds the same elements, in the same order, as a look at every one', () {
    final index = indexOf(screen);
    for (final selector in [
      '#add-to-basket',
      'button',
      'Text',
      'ProductCard',
      ":text('King')",
      'ProductCard > button#add-to-basket:nth(2)',
      'ElevatedButton[label="Add King Edward"]',
      '#nothing',
      'Image',
    ]) {
      expect(query(screen, selector, index: index), query(screen, selector), reason: selector);
    }
  });
}
