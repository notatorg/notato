import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:notato/notato.dart';
import 'package:notato/src/identity.dart';
import 'package:notato/src/selectors.dart';
import 'package:notato/src/tree.dart';

import 'shop.dart';

void main() {
  testWidgets('a tap finds the widget you wrote, your widgets around it, and the line it is written on', (
    tester,
  ) async {
    final root = GlobalKey();
    await tester.pumpWidget(
      MaterialApp(
        home: KeyedSubtree(key: root, child: const ProductList()),
      ),
    );
    final box = tester.renderObject<RenderBox>(find.byKey(root));
    final picked = pickAt(box, tester.getCenter(find.text('Add to basket')), stop: root.currentContext! as Element);
    expect(picked, isNotNull);
    final identity = picked!.identity;
    final source = File('test/shop.dart').readAsStringSync();
    final line = lineOf("const Text('Add to basket')", source);

    expect(identity['selector'], 'ProductCard > ElevatedButton#add-to-basket > Text');
    expect(identity['tag'], 'Text');
    expect(identity['text'], 'Add to basket');
    expect(identity['testId'], 'add-to-basket');
    expect(identity['role'], 'button');
    expect(identity['source'], {
      'file': File('test/shop.dart').absolute.path,
      'line': line,
      'col': source.split('\n')[line - 1].indexOf("const Text('Add to basket')") + 7,
    });
    expect(identity['component'], {
      'name': 'ProductCard',
      'source':
          '${File('test/shop.dart').absolute.path}:$line:${source.split('\n')[line - 1].indexOf("const Text('Add to basket')") + 7}',
      'path': ['ProductList', 'ProductCard'],
    });
    expect(picked.rect, tester.getRect(find.text('Add to basket')));
  });

  testWidgets('a tap on a card names the card, and says what is written in it', (tester) async {
    final root = GlobalKey();
    await tester.pumpWidget(
      MaterialApp(
        home: KeyedSubtree(key: root, child: const ProductList()),
      ),
    );
    final box = tester.renderObject<RenderBox>(find.byKey(root));
    final corner = tester.getTopLeft(find.byType(Card)) + const Offset(8, 8);
    final identity = pickAt(box, corner, stop: root.currentContext! as Element)!.identity;
    expect(identity['tag'], 'Card');
    expect(identity['text'], 'Maris Piper Add to basket');
    expect((identity['component'] as Map)['name'], 'ProductCard');
  });

  testWidgets('says nothing of a private widget\'s key, and takes only keys a selector can name', (tester) async {
    final root = GlobalKey();
    await tester.pumpWidget(
      MaterialApp(
        home: KeyedSubtree(
          key: root,
          child: Column(
            children: [
              const NotatoMask(child: Text('alice@example.com', key: ValueKey('alice@example.com'))),
              Text('Contact', key: ValueKey(_Contact('Alice'))),
              const Text('Answer', key: ValueKey(42)),
              const Text('Home', key: ValueKey(_Tab.home)),
              const Text('Sentence', key: ValueKey('add to basket')),
              Text('Long', key: ValueKey('x' * 101)),
              Semantics(label: r'C:\temp "x"', child: const Text('Path')),
            ],
          ),
        ),
      ),
    );
    final stop = root.currentContext! as Element;
    final box = tester.renderObject<RenderBox>(find.byKey(root));
    Map<String, Object?> identityOf(String text) =>
        pickAt(box, tester.getCenter(find.text(text)), stop: stop)!.identity;

    final secret = identityOf('alice@example.com');
    expect(secret['testId'], isNull);
    expect(secret['selector'], 'Text');
    expect('$secret', isNot(contains('alice')));
    expect(identityOf('Contact')['testId'], isNull);
    expect(identityOf('Answer')['testId'], '42');
    expect(identityOf('Answer')['selector'], 'Text#42');
    expect(identityOf('Home')['testId'], '_Tab.home');
    expect(identityOf('Sentence')['testId'], isNull);
    expect(identityOf('Long')['testId'], isNull);
    // Every selector reads back.
    for (final text in ['Contact', 'Answer', 'Home', 'Sentence', 'Long']) {
      parseSelector(identityOf(text)['selector']! as String);
    }
    // A label's backslashes and quotes are escaped, so it reads back as it was.
    final path = identityOf('Path');
    expect(path['selector'], r'Text[label="C:\\temp \"x\""]');
    expect(parseSelector(path['selector']! as String).label, r'C:\temp "x"');
    // Nor can a selector find the private one by its key.
    expect(query(elementsUnder(stop), '#alice@example.com'), isEmpty);
  });

  test('knows code that is not the app', () {
    expect(isLibraryFile('/Users/me/flutter/packages/flutter/lib/src/material/card.dart'), isTrue);
    expect(isLibraryFile('/Users/me/.pub-cache/hosted/pub.dev/go_router-14.0.0/lib/src/router.dart'), isTrue);
    expect(isLibraryFile('/Users/me/shop/lib/screens/product.dart'), isFalse);
  });
}

class _Contact {
  const _Contact(this.name);
  final String name;
  @override
  String toString() => 'Contact($name)';
}

enum _Tab { home }
