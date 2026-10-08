import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import 'mask.dart';

/// Where a widget was created in the source: Flutter's debug builds record it for every widget
/// (`--track-widget-creation`, on by default for `flutter run` and `flutter test`).
class CreationLocation {
  const CreationLocation(this.file, this.line, this.column);

  /// The file's path on the machine that built the app, where the agent works.
  final String file;
  final int line;
  final int column;

  @override
  String toString() => '$file:$line:$column';
}

/// What a tap picked: the widget written in your code that the touched render object belongs to, where it is on screen,
/// and the identity a note carries.
class Picked {
  Picked({
    required this.identity,
    required this.element,
    required this.box,
    Rect? rect,
    this.private = false,
    this.input = false,
    this.shown = false,
    String? Function()? text,
  }) : _rect = rect,
       _textOf = text;

  final Map<String, Object?> identity;

  /// The widget written in the app that it is, and what it paints.
  final Element element;
  final RenderBox box;

  /// Inside a private `NotatoMask`, or a password field.
  final bool private;

  /// A text field.
  final bool input;

  /// A text field inside `NotatoMask(private: false)`.
  final bool shown;

  Rect? _rect;

  /// Where it is, in global (logical pixel) coordinates: as it was picked, or, for one of a whole screen's widgets, where
  /// it is the first time this is asked.
  Rect get rect => _rect ??= box.localToGlobal(Offset.zero) & box.size;

  final String? Function()? _textOf;
  String? _text;
  var _textRead = false;

  /// Its text: the identity's, or, for one of a whole screen's widgets, read the first time a selector asks for it.
  String? get text {
    final textOf = _textOf;
    if (textOf == null) return identity['text'] as String?;
    if (!_textRead) {
      _text = textOf();
      _textRead = true;
    }
    return _text;
  }
}

final _inspector = WidgetInspectorService.instance;

/// Where each widget was created, worked out once: widgets are immutable, and many survive rebuilds.
final _created = Expando<Object>('notato creation');
const _none = Object();

/// The creation location Flutter recorded for an element's widget, read through the inspector's own serialization
/// (the one DevTools uses), or null in a build without widget creation tracking.
CreationLocation? creationOf(Element element) {
  if (!kDebugMode) return null;
  final widget = element.widget;
  final known = _created[widget];
  if (known != null) return known == _none ? null : known as CreationLocation;
  final location = _readCreation(element);
  _created[widget] = location ?? _none;
  return location;
}

CreationLocation? _readCreation(Element element) {
  try {
    final json = element.toDiagnosticsNode().toJsonMap(
      InspectorSerializationDelegate(service: _inspector, subtreeDepth: 0),
    );
    final location = json['creationLocation'];
    if (location is! Map) return null;
    final file = location['file'];
    final line = location['line'];
    final column = location['column'];
    if (file is! String || line is! int || column is! int) return null;
    final uri = Uri.tryParse(file);
    return CreationLocation(uri != null && uri.scheme == 'file' ? uri.toFilePath() : file, line, column);
  } catch (_) {
    return null;
  }
}

/// Code that is not the app's: Flutter's own widgets, packages from the pub cache, and Dart's SDK.
bool isLibraryFile(String file) =>
    file.contains('/packages/flutter/') ||
    file.contains('/packages/flutter_test/') ||
    file.contains('/.pub-cache/') ||
    file.contains(r'\Pub\Cache\') ||
    file.startsWith('org-dartlang-sdk:') ||
    file.contains('/dart-sdk/');

/// Whether an element's widget was written in the app's own code.
bool isLocal(Element element) {
  final location = creationOf(element);
  return location != null && !isLibraryFile(location.file);
}

/// Framework widgets that hand on a child made elsewhere, or build one in a closure of yours: their child is your
/// code, but they are not your widgets.
const _passThrough = <String>{'KeyedSubtree', 'Builder', 'StatefulBuilder', 'Obx', 'GetBuilder', 'Observer'};
final _passThroughName = RegExp(r'(Builder|Listener|Provider|Consumer|Selector|Scope|Notifier)$');

/// A widget class written in the app: a stateless or stateful widget whose build creates widgets in the app's code.
/// (Flutter's `Card` is created by you but builds in Flutter; your `ProductCard` builds in your file.)
bool isAppComponent(Element element) {
  // Inherited and parent-data widgets (proxies) only pass their child on.
  if (element is! StatelessElement && element is! StatefulElement) return false;
  final name = _typeName(element.widget);
  if (_passThrough.contains(name) || _passThroughName.hasMatch(name)) return false;
  Element? child;
  element.visitChildren((c) => child ??= c);
  return child != null && isLocal(child!);
}

String typeName(Widget widget) => _typeName(widget);

String _typeName(Widget widget) {
  final name = widget.runtimeType.toString();
  final generic = name.indexOf('<');
  return generic > 0 ? name.substring(0, generic) : name;
}

const _buttons = <String>{
  'ElevatedButton',
  'FilledButton',
  'OutlinedButton',
  'TextButton',
  'IconButton',
  'FloatingActionButton',
  'CupertinoButton',
  'InkWell',
  'GestureDetector',
  'ListTile',
  'PopupMenuButton',
  'BackButton',
  'CloseButton',
};
const _roles = <String, String>{
  'TextField': 'textbox',
  'TextFormField': 'textbox',
  'CupertinoTextField': 'textbox',
  'Checkbox': 'checkbox',
  'CheckboxListTile': 'checkbox',
  'Switch': 'switch',
  'SwitchListTile': 'switch',
  'CupertinoSwitch': 'switch',
  'Radio': 'radio',
  'Slider': 'slider',
  'Image': 'img',
  'Icon': 'img',
};

/// A widget's own test id, for selectors: its key, or its Semantics identifier. Not one it sits in.
String? ownTestId(Widget widget) {
  final key = _keyValue(widget.key);
  if (key != null) return key;
  return widget is Semantics ? _readableId(widget.properties.identifier) : null;
}

/// A key as a test id: a `ValueKey` of a string, a number or an enum, what people key widgets with to find them. Any
/// other value (a `ValueKey(contact)`) says nothing a selector can use, and its text could be anything of the app's.
String? _keyValue(Key? key) {
  if (key is! ValueKey) return null;
  final value = key.value;
  return value is String || value is int || value is Enum ? _readableId('$value') : null;
}

/// A test id a selector can name (`#pay`): at most 100 of the characters `#` reads. Anything else (a sentence, a long
/// value) is not taken as one: it would make a selector nothing can read.
String? _readableId(String? id) {
  final trimmed = id?.trim();
  return trimmed != null && trimmed.isNotEmpty && trimmed.length <= 100 && _idChars.hasMatch(trimmed) ? trimmed : null;
}

final _idChars = RegExp(r'^[\w.@/-]+$');

/// The text a render object shows: its own paragraph's, or the paragraphs under it, trimmed to what a note keeps.
String? textUnder(RenderObject object) {
  final parts = <String>[];
  var length = 0;
  void walk(RenderObject node) {
    if (length > 200) return;
    // Nothing inside something private is read, not even as a container's text.
    if (node is RenderNotatoMask && node.isPrivate) return;
    if (node is RenderParagraph) {
      length += node.text.toPlainText().length;
      parts.add(node.text.toPlainText());
      return;
    }
    node.visitChildren(walk);
  }

  walk(object);
  final text = parts.join(' ').replaceAll(RegExp(r'\s+'), ' ').trim();
  if (text.isEmpty) return null;
  return text.length > 200 ? text.substring(0, 200) : text;
}

/// How the `NotatoMask`s around an element mark it: private (a private mark, the outermost of them winning), shown
/// (a field inside `private: false` with nothing private around it), or neither.
enum Mark { private, shown }

Mark? markOf(Element element, {Element? stop}) {
  Mark? mark;
  void look(Element e) {
    final widget = e.widget;
    if (widget is NotatoMask) {
      if (widget.private) {
        mark = Mark.private;
      } else {
        mark ??= Mark.shown;
      }
    }
  }

  look(element);
  if (element != stop) {
    element.visitAncestorElements((ancestor) {
      if (ancestor == stop) return false;
      look(ancestor);
      return mark != Mark.private;
    });
  }
  return mark;
}

/// The text field an element is, or holds: its EditableText's.
EditableText? fieldOf(Element element) {
  if (element.widget is EditableText) return element.widget as EditableText;
  EditableText? found;
  var visited = 0;
  void visit(Element e) {
    if (found != null || visited++ > 60) return;
    if (e.widget is EditableText) {
      found = e.widget as EditableText;
      return;
    }
    e.visitChildren(visit);
  }

  element.visitChildren(visit);
  return found;
}

/// The widget under a global point of `root` (the app's own subtree, so Notato's overlay is never picked), as a note
/// describes it. Null when nothing there was made by a widget, or in a build that does not record where widgets come
/// from (release and profile builds).
Picked? pickAt(RenderBox root, Offset global, {required Element stop, bool maskInputs = false}) {
  if (!kDebugMode || !root.attached) return null;
  final result = BoxHitTestResult();
  root.hitTest(result, position: root.globalToLocal(global));
  for (final entry in result.path) {
    final target = entry.target;
    if (target is! RenderBox || !target.attached || !target.hasSize) continue;
    final creator = target.debugCreator;
    if (creator is! DebugCreator) continue;
    final picked = identify(creator.element, target, stop: stop, maskInputs: maskInputs);
    if (picked != null) return picked;
  }
  return null;
}

/// The identity of the widget that made `box`, by way of its element: the nearest widget written in the app (the
/// view), the app's widget classes around it, and where the view is written.
Picked? identify(Element element, RenderBox box, {required Element stop, bool maskInputs = false}) {
  // The element and its ancestors, nearest first, up to the app's root.
  final chain = <Element>[element];
  if (element != stop) {
    element.visitAncestorElements((ancestor) {
      chain.add(ancestor);
      return ancestor != stop;
    });
  }
  // The view: the nearest widget written in the app's code (the `Text` you wrote, not the `RichText` it builds).
  final viewIndex = chain.indexWhere(isLocal);
  if (viewIndex < 0) return null;
  final view = chain[viewIndex];
  // Up to, not including, the app's root: what Notato wraps it in is not part of it.
  final above = chain.sublist(viewIndex + 1).where((e) => e != stop).toList();

  // Your widget classes around it, nearest first; and what is between the view and the nearest of them.
  final components = <String>[];
  var componentIndex = -1;
  for (var i = 0; i < above.length; i++) {
    if (!isAppComponent(above[i])) continue;
    final name = _typeName(above[i].widget);
    if (components.isEmpty) componentIndex = i;
    if (components.isEmpty || components.last != name) components.add(name);
    if (components.length >= maxPath) break;
  }
  final within = componentIndex < 0 ? above : above.sublist(0, componentIndex);
  return describe(
    view,
    box,
    components: components,
    within: within,
    mark: markOf(view, stop: stop),
    maskInputs: maskInputs,
    full: true,
  );
}

/// The most widget classes a note names around a widget.
const maxPath = 8;

/// One step of a walk down the tree: the mark below a widget, given the mark above it.
Mark? markBelow(Element element, Mark? above) {
  final widget = element.widget;
  if (widget is! NotatoMask || above == Mark.private) return above;
  return widget.private ? Mark.private : (above ?? Mark.shown);
}

/// A widget's type names that are text fields: only these are searched for the field's text.
const _textFields = <String>{
  'TextField',
  'TextFormField',
  'CupertinoTextField',
  'CupertinoSearchTextField',
  'CupertinoTextFormFieldRow',
  'SearchBar',
  'EditableText',
};

/// The identity of a widget written in the app, from what is around it: [components], your widget classes around it,
/// nearest first; [within], the widgets between it and the nearest of those, nearest first (what it sits in: a button,
/// a tile, its key and label); and [mark], the `NotatoMask`s around it.
Picked describe(
  Element view,
  RenderBox box, {
  required List<String> components,
  required Iterable<Element> within,
  required Mark? mark,
  required bool maskInputs,
  bool full = false,
}) {
  final location = creationOf(view);
  final path = components.reversed.toList();
  final component = components.isEmpty ? null : components.first;

  final tag = _typeName(view.widget);
  String? testId;
  Element? testIdOn;
  String? label;
  String? role = _roles[tag];
  Element? container;
  for (final e in [view, ...within]) {
    final widget = e.widget;
    if (testId == null) {
      testId = _keyValue(widget.key);
      if (testId != null) testIdOn = e;
    }
    if (widget is Semantics) {
      final identifier = _readableId(widget.properties.identifier);
      if (testId == null && identifier != null) {
        testId = identifier;
        testIdOn = e;
      }
      label ??= widget.properties.label;
    }
    if (widget is Tooltip) label ??= widget.message;
    final type = _typeName(widget);
    if (container == null && e != view && _buttons.contains(type) && isLocal(e)) container = e;
    if (_buttons.contains(type)) role ??= 'button';
    role ??= _roles[type];
  }

  // Something private says nothing of what it shows: not its text, not its label, not its key (an app may key a widget
  // with what it shows: `ValueKey(email)`). A field says its hint either way.
  final field = _textFields.contains(tag) ? fieldOf(view) : null;
  final secure = field?.obscureText ?? false;
  final isPrivate = mark == Mark.private || secure;
  if (isPrivate) {
    label = null;
    testId = null;
    testIdOn = null;
  }
  if (field != null) role ??= 'textbox';
  final viewWidget = view.widget;
  String? readText() {
    final String? raw;
    if (isPrivate) {
      raw = null;
    } else if (field != null) {
      raw = maskInputs && mark != Mark.shown ? null : field.controller.text;
    } else {
      raw = viewWidget is Text
          ? (viewWidget.data ?? viewWidget.textSpan?.toPlainText())
          : (view.renderObject != null ? textUnder(view.renderObject!) : textUnder(box));
    }
    final trimmed = raw?.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (trimmed == null || trimmed.isEmpty) return null;
    return trimmed.length > 200 ? trimmed.substring(0, 200) : trimmed;
  }

  // `ProductCard > ElevatedButton#add > Text`: the test id goes on the widget that has it (the view, or what it sits in).
  String part(Element e) {
    final id = testIdOn == e || (testIdOn != null && testIdOn != container && e == view) ? '#$testId' : '';
    final named = e == view && label != null ? '[label="${label.replaceAll(r'\', r'\\').replaceAll('"', r'\"')}"]' : '';
    return '${_typeName(e.widget)}$id$named';
  }

  final selector = [?component, if (container != null) part(container), part(view)].join(' > ');

  // A widget picked for a note has all of it now. One of a whole screen read for selectors reads its text and where it
  // is only when asked: most are never asked.
  final text = full ? readText() : null;
  return Picked(
    rect: full ? box.localToGlobal(Offset.zero) & box.size : null,
    text: full ? null : readText,
    element: view,
    box: box,
    private: isPrivate,
    input: field != null,
    shown: mark == Mark.shown,
    identity: {
      'selector': selector,
      'tag': tag,
      'testId': ?testId,
      'role': ?role,
      'name': ?label,
      'text': ?text,
      if (location != null) 'source': {'file': location.file, 'line': location.line, 'col': location.column},
      if (component != null)
        'component': {'name': component, 'source': ?location?.toString(), if (path.length >= 2) 'path': path},
      if (path.isNotEmpty) 'ancestors': path,
    },
  );
}
