import 'package:flutter/material.dart';

/// A small app for the tests: a list of product cards, each with a name and an Add button.
class ProductCard extends StatelessWidget {
  const ProductCard({super.key, required this.name});
  final String name;

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(name, style: const TextStyle(fontSize: 18)),
          ElevatedButton(key: const ValueKey('add-to-basket'), onPressed: () {}, child: const Text('Add to basket')),
        ],
      ),
    ),
  );
}

class ProductList extends StatelessWidget {
  const ProductList({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
    body: ListView(children: const [ProductCard(name: 'Maris Piper')]),
  );
}

/// The line `text` is written on in this file, for checking what a note says.
int lineOf(String text, String source) => source.split('\n').indexWhere((l) => l.contains(text)) + 1;
