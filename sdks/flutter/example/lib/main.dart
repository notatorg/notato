import 'package:flutter/material.dart';
import 'package:notato/notato.dart';

// Another server than the one on 4747, and another mode:
// flutter run --dart-define=NOTATO_SERVER=http://localhost:4799 --dart-define=NOTATO_MODE=test
const server = String.fromEnvironment('NOTATO_SERVER');
const mode = String.fromEnvironment('NOTATO_MODE', defaultValue: 'dev');

void main() {
  runApp(
    Notato(
      project: 'flutter-example',
      appName: 'Spud Shop',
      appVersion: '1.0.0',
      mode: NotatoMode.values.byName(mode),
      server: server.isEmpty ? null : server,
      child: const SpudShop(),
    ),
  );
}

class Product {
  const Product(this.id, this.name, this.price);
  final String id;
  final String name;
  final double price;
}

const products = [
  Product('maris', 'Maris Piper', 1.20),
  Product('king', 'King Edward', 1.45),
  Product('jersey', 'Jersey Royal', 3.10),
];

class SpudShop extends StatefulWidget {
  const SpudShop({super.key});

  @override
  State<SpudShop> createState() => _SpudShopState();
}

class _SpudShopState extends State<SpudShop> {
  final basket = <Product>[];

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Spud Shop',
    theme: ThemeData(colorSchemeSeed: const Color(0xFF2F6F4F), useMaterial3: true),
    // Notes are filed under the route they were made on.
    navigatorObservers: [Notato.navigatorObserver],
    initialRoute: '/shop',
    routes: {
      '/shop': (context) => ShopScreen(basket: basket, onAdd: (p) => setState(() => basket.add(p))),
      '/basket': (context) => BasketScreen(basket: basket),
    },
  );
}

class ShopScreen extends StatelessWidget {
  const ShopScreen({super.key, required this.basket, required this.onAdd});
  final List<Product> basket;
  final ValueChanged<Product> onAdd;

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('Spud Shop'),
      actions: [
        TextButton.icon(
          key: const ValueKey('open-basket'),
          onPressed: () => Navigator.pushNamed(context, '/basket'),
          icon: const Icon(Icons.shopping_basket_outlined),
          label: Text('${basket.length}'),
        ),
      ],
    ),
    body: ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 120),
      children: [
        for (final product in products) ProductCard(product: product, onAdd: () => onAdd(product)),
        const AccountCard(),
        const FeedbackCard(),
      ],
    ),
  );
}

/// What masking does: the email is private, the search field is fine to record, the password never is.
class AccountCard extends StatelessWidget {
  const AccountCard({super.key});

  @override
  Widget build(BuildContext context) => Card(
    margin: const EdgeInsets.only(bottom: 16),
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Your account', style: Theme.of(context).textTheme.titleLarge),
          const NotatoMask(child: Text('ada@example.com', key: ValueKey('email'))),
          const SizedBox(height: 8),
          const NotatoMask(
            private: false,
            child: TextField(
              key: ValueKey('search'),
              decoration: InputDecoration(hintText: 'Search potatoes'),
            ),
          ),
          const TextField(
            key: ValueKey('password'),
            obscureText: true,
            decoration: InputDecoration(hintText: 'Password'),
          ),
        ],
      ),
    ),
  );
}

/// The runtime API: on and off, the toolbar, and a note made from code.
class FeedbackCard extends StatefulWidget {
  const FeedbackCard({super.key});

  @override
  State<FeedbackCard> createState() => _FeedbackCardState();
}

class _FeedbackCardState extends State<FeedbackCard> {
  String _result = '';

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: ListenableBuilder(
        listenable: notato,
        builder: (context, _) => Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Feedback', style: Theme.of(context).textTheme.titleLarge),
            SwitchListTile(
              key: const ValueKey('notato-on'),
              contentPadding: EdgeInsets.zero,
              title: const Text('Notato on'),
              value: notato.isEnabled,
              onChanged: (on) => on ? notato.enable() : notato.disable(),
            ),
            SwitchListTile(
              key: const ValueKey('notato-toolbar'),
              contentPadding: EdgeInsets.zero,
              title: const Text('Toolbar'),
              value: notato.isToolbarVisible,
              onChanged: (on) => on ? notato.showToolbar() : notato.hideToolbar(),
            ),
            Text(
              '${notato.mode.name} mode · ${notato.connection.name} · '
              '${notato.notes.length} notes, ${notato.pendingCount} not sent',
            ),
            const SizedBox(height: 12),
            FilledButton(
              key: const ValueKey('annotate-from-code'),
              onPressed: () => notato
                  .annotate('ProductCard > Text:text("£1.45")', 'Price checked from code', intent: 'question')
                  .then((a) => setState(() => _result = 'Made ${(a['id'] as String).substring(20)}'))
                  .catchError((Object e) => setState(() => _result = '$e')),
              child: const Text('Annotate the price from code'),
            ),
            if (_result.isNotEmpty) Text(_result),
          ],
        ),
      ),
    ),
  );
}

class ProductCard extends StatelessWidget {
  const ProductCard({super.key, required this.product, required this.onAdd});
  final Product product;
  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) => Card(
    margin: const EdgeInsets.only(bottom: 16),
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(product.name, style: Theme.of(context).textTheme.titleLarge),
          Text('£${product.price.toStringAsFixed(2)}'),
          const SizedBox(height: 12),
          FilledButton(key: const ValueKey('add-to-basket'), onPressed: onAdd, child: const Text('Add to basket')),
        ],
      ),
    ),
  );
}

class BasketScreen extends StatelessWidget {
  const BasketScreen({super.key, required this.basket});
  final List<Product> basket;

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Basket')),
    body: basket.isEmpty
        ? const Center(child: Text('Your basket is empty'))
        : ListView(
            children: [
              for (final product in basket)
                ListTile(title: Text(product.name), trailing: Text('£${product.price.toStringAsFixed(2)}')),
            ],
          ),
  );
}
