import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

import 'identity.dart';
import 'mask.dart';
import 'selectors.dart';

/// A widget of the app on screen, as selectors see it: one written in the app's code, with what it paints.
class TreeElement implements Candidate {
  TreeElement(this.picked);
  final Picked picked;

  Map<String, Object?> get _id => picked.identity;
  @override
  String get tag => _id['tag'] as String? ?? '';
  @override
  String? get role => _id['role'] as String?;

  /// The widget's own key, not the one of a button it sits in: a selector's `#add:nth(2)` counts each keyed widget once.
  /// None for a private widget, whose identity has none either.
  @override
  String? get testId => picked.private ? null : ownTestId(picked.element.widget);
  @override
  String? get label => _id['name'] as String?;
  @override
  String? get text => picked.text;
  @override
  List<String> get path => ((_id['ancestors'] as List?) ?? const []).cast<String>();
}

/// A list read from its near end, which a walk down the tree shares between siblings instead of copying.
class _Link<T> {
  const _Link(this.head, this.rest, this.length);
  final T head;
  final _Link<T>? rest;
  final int length;

  Iterable<T> get items sync* {
    for (_Link<T>? at = this; at != null; at = at.rest) {
      yield at.head;
    }
  }
}

/// What the walk carries down to a widget: your widget classes above it (nearest first), the widgets between it and
/// the nearest of them, and the `NotatoMask`s around it.
typedef _Around = ({_Link<String>? components, _Link<Element>? within, Mark? mark});

/// Every widget written in the app under `root` that paints a box, in painting order, described for selectors. One walk
/// down the tree, carrying what is around each widget, so a screen of thousands is read in one pass rather than one
/// walk up to the root per widget. At most [limit] of them.
List<TreeElement> elementsUnder(Element root, {bool maskInputs = false, int limit = 5000}) {
  final out = <TreeElement>[];
  final stack = <(Element, _Around)>[];
  void push(Element parent, _Around around) {
    final children = <Element>[];
    parent.visitChildren(children.add);
    // Reversed, so the first child is taken first.
    for (final child in children.reversed) {
      stack.add((child, around));
    }
  }

  push(root, (components: null, within: null, mark: null));
  while (stack.isNotEmpty && out.length < limit) {
    final (element, around) = stack.removeLast();
    final mark = markBelow(element, around.mark);
    final box = element.renderObject;
    if (box is RenderBox && box.attached && box.hasSize && isLocal(element, exact: false)) {
      final components = around.components?.items.take(maxPath).toList() ?? const <String>[];
      out.add(
        TreeElement(
          describe(
            element,
            box,
            components: components,
            within: around.within?.items ?? const [],
            mark: mark,
            maskInputs: maskInputs,
          ),
        ),
      );
    }
    // What its children see: a widget class of yours starts a new scope; anything else is part of the current one.
    final _Around below;
    if (isAppComponent(element, exact: false)) {
      final name = typeName(element.widget);
      final top = around.components;
      below = (
        components: top != null && top.head == name ? top : _Link(name, top, (top?.length ?? 0) + 1),
        within: null,
        mark: mark,
      );
    } else {
      below = (
        components: around.components,
        within: _Link(element, around.within, (around.within?.length ?? 0) + 1),
        mark: mark,
      );
    }
    push(element, below);
  }
  return out;
}

/// What screenshots cover, in global coordinates: what is inside a private `NotatoMask`, password fields, and (with
/// [maskInputs]) text fields not marked `private: false`.
List<Rect> coversUnder(RenderObject root, {required bool maskInputs}) {
  final out = <Rect>[];
  void walk(RenderObject node, Mark? mark) {
    var here = mark;
    if (node is RenderNotatoMask) {
      if (node.isPrivate) {
        here = Mark.private;
      } else {
        here ??= Mark.shown;
      }
    }
    if (node is RenderBox && node.attached && node.hasSize) {
      final private = here == Mark.private && (mark != Mark.private);
      final field = node is RenderEditable;
      final secure = field && node.obscureText;
      final masked = field && maskInputs && here != Mark.shown;
      // A private mark is covered once, whole; fields inside it are under that cover already.
      if (private || ((secure || masked) && here != Mark.private)) {
        out.add(node.localToGlobal(Offset.zero) & node.size);
      }
    }
    node.visitChildren((child) => walk(child, here));
  }

  walk(root, null);
  return out;
}

/// The nearest widget written in the app around `element` that paints a bigger box: what **Parent** selects.
Picked? parentOf(Picked picked, {required Element stop, bool maskInputs = false}) {
  Picked? found;
  final size = picked.box.size;
  picked.element.visitAncestorElements((ancestor) {
    if (ancestor == stop) return false;
    final box = ancestor.renderObject;
    if (box is! RenderBox || !box.attached || !box.hasSize || !isLocal(ancestor)) return true;
    if (box.size.width <= size.width + 0.5 && box.size.height <= size.height + 0.5) return true;
    found = identify(ancestor, box, stop: stop, maskInputs: maskInputs);
    return found == null;
  });
  return found;
}
