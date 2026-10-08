/// Notato's selectors on a native screen, as every mobile SDK reads them: `ProductCard > Text#price`,
/// `FilledButton:text("Add to basket")`, `#pay:nth(2)`. Leading names are the widgets (or the screen) around the
/// element; the last part says the element itself:
///
///   `Text`, `button`, `*`     its widget type or role (`*` for any)
///   `#pay`                    its key (`ValueKey('pay')`) or Semantics identifier
///   `[label="Pay now"]`       its semantics label, exactly
///   `:text("basket")`         its text or label contains this, ignoring case
///   `:nth(2)`                 the second match, in painting order
class Selector {
  Selector({this.ancestors = const [], this.type, this.id, this.label, this.text, this.nth});
  final List<String> ancestors;
  String? type;
  String? id;
  String? label;
  String? text;
  int? nth;
}

/// What a selector is matched against: one element on the screen.
abstract interface class Candidate {
  String get tag;
  String? get role;
  String? get testId;
  String? get label;

  /// Null for a private element: it can never be found by its text.
  String? get text;

  /// The app's widgets around it, outermost first.
  List<String> get path;
}

class SelectorException implements Exception {
  const SelectorException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// Splits on top-level whitespace and `>`, keeping quoted strings, brackets and parentheses whole.
List<String> _tokens(String input) {
  final out = <String>[];
  final current = StringBuffer();
  var depth = 0;
  String? quote;
  for (var i = 0; i < input.length; i++) {
    final c = input[i];
    if (quote != null) {
      current.write(c);
      if (c == r'\' && i + 1 < input.length) {
        current.write(input[++i]);
      } else if (c == quote) {
        quote = null;
      }
      continue;
    }
    if (c == '"' || c == "'") {
      quote = c;
      current.write(c);
    } else if (c == '[' || c == '(') {
      depth++;
      current.write(c);
    } else if (c == ']' || c == ')') {
      depth--;
      current.write(c);
    } else if (depth == 0 && (c == '>' || c.trim().isEmpty)) {
      if (current.isNotEmpty) out.add(current.toString());
      current.clear();
    } else {
      current.write(c);
    }
  }
  if (quote != null || depth != 0) throw SelectorException('unbalanced quotes or brackets in "$input"');
  if (current.isNotEmpty) out.add(current.toString());
  return out;
}

String _unquote(String s) {
  if (s.length >= 2 && (s[0] == '"' || s[0] == "'") && s[s.length - 1] == s[0]) {
    return s.substring(1, s.length - 1).replaceAllMapped(RegExp(r'\\(.)'), (m) => m[1]!);
  }
  return s;
}

const _quoted = r'''("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')''';
final _head = RegExp(r'^(\*|[A-Za-z_][\w.$-]*)');
final _readers = <(RegExp, void Function(Selector, RegExpMatch))>[
  (RegExp(r'^#([\w.@/-]+)'), (s, m) => s.id = m[1]),
  (RegExp('^\\[label=$_quoted\\]'), (s, m) => s.label = _unquote(m[1]!)),
  (RegExp('^:text\\($_quoted\\)'), (s, m) => s.text = _unquote(m[1]!)),
  (RegExp(r'^:nth\((\d+)\)'), (s, m) => s.nth = int.parse(m[1]!)),
];

Selector parseSelector(String input) {
  final parts = _tokens(input.trim());
  if (parts.isEmpty) throw const SelectorException('an empty selector');
  var rest = parts.removeLast();
  final selector = Selector(ancestors: parts.map(_unquote).toList());
  final head = _head.firstMatch(rest);
  if (head != null) {
    if (head[1] != '*') selector.type = head[1];
    rest = rest.substring(head[0]!.length);
  }
  while (rest.isNotEmpty) {
    RegExpMatch? match;
    for (final (pattern, apply) in _readers) {
      match = pattern.firstMatch(rest);
      if (match != null) {
        apply(selector, match);
        break;
      }
    }
    if (match == null) throw SelectorException('cannot read "$rest" in "$input"');
    rest = rest.substring(match[0]!.length);
  }
  return selector;
}

/// An element's fields in lower case, worked out once: pins match many selectors against the same elements.
final _folded = Expando<({String tag, String? role, String? component, String? text, String? label})>('folded');

({String tag, String? role, String? component, String? text, String? label}) _fold(Candidate c) => _folded[c] ??= (
  tag: c.tag.toLowerCase(),
  role: c.role?.toLowerCase(),
  component: c.path.isEmpty ? null : c.path.last.toLowerCase(),
  text: c.text?.toLowerCase(),
  label: c.label?.toLowerCase(),
);

bool _matchesSelf(Candidate c, Selector s, String? type, String? text) {
  if (s.id != null && c.testId != s.id) return false;
  if (s.label != null && c.label != s.label) return false;
  if (type == null && text == null) return true;
  final f = _fold(c);
  if (type != null && f.tag != type && f.role != type && f.component != type) return false;
  if (text != null && !(f.text?.contains(text) ?? false) && !(f.label?.contains(text) ?? false)) return false;
  return true;
}

/// Selectors read before: pins ask for the same ones every time they are placed.
final _parsed = <String, Selector>{};

Selector _parseCached(String input) {
  final known = _parsed[input];
  if (known != null) return known;
  final s = parseSelector(input);
  if (_parsed.length > 2000) _parsed.clear();
  return _parsed[input] = s;
}

/// Whether the names appear around the element, outermost first, not necessarily one inside the next.
bool _within(Candidate c, List<String> ancestors) {
  var at = 0;
  for (final name in c.path) {
    if (at < ancestors.length && name == ancestors[at]) at++;
  }
  return at == ancestors.length;
}

/// The elements filed by what selectors most often start from, their test id and their type (widget type, role or
/// widget class, in lower case): built once per look at the screen, so the pins' many selectors each read a few
/// elements, not all.
class SelectorIndex<C extends Candidate> {
  SelectorIndex._(this.byId, this.byType);
  final Map<String, List<C>> byId;
  final Map<String, List<C>> byType;
}

SelectorIndex<C> indexOf<C extends Candidate>(List<C> candidates) {
  final byId = <String, List<C>>{};
  final byType = <String, List<C>>{};
  void file(Map<String, List<C>> map, String key, C c) {
    final list = map[key] ??= [];
    if (list.isEmpty || !identical(list.last, c)) list.add(c);
  }

  for (final c in candidates) {
    final id = c.testId;
    if (id != null) file(byId, id, c);
    final f = _fold(c);
    file(byType, f.tag, c);
    if (f.role != null) file(byType, f.role!, c);
    if (f.component != null) file(byType, f.component!, c);
  }
  return SelectorIndex._(byId, byType);
}

/// The elements a selector finds, in painting order (one, with `:nth`). Leading names narrow the search when the app
/// has those widgets around the element; a name that is only a screen's (`Checkout button`) is not held against it.
/// With an [index] of the same elements, only those with the selector's test id or type are looked at.
List<C> query<C extends Candidate>(List<C> candidates, String selector, {SelectorIndex<C>? index}) {
  final s = _parseCached(selector);
  final type = s.type?.toLowerCase();
  final text = s.text?.toLowerCase();
  final pool = index == null
      ? candidates
      : s.id != null
      ? (index.byId[s.id] ?? const [])
      : type != null
      ? (index.byType[type] ?? const [])
      : candidates;
  final own = pool.where((c) => _matchesSelf(c, s, type, text)).toList();
  final narrowed = s.ancestors.isEmpty ? own : own.where((c) => _within(c, s.ancestors)).toList();
  final found = narrowed.isNotEmpty ? narrowed : own;
  final nth = s.nth;
  if (nth != null) return nth >= 1 && nth <= found.length ? [found[nth - 1]] : [];
  return found;
}

/// A selector that finds this element again: its own, made sharper with its text when it has no test id.
String selectorToFind(Map<String, Object?> identity) {
  final selector = identity['selector'] as String? ?? '*';
  final text = identity['text'] as String?;
  if (identity['testId'] != null || text == null || text.isEmpty) return selector;
  final short = text.length > 60 ? text.substring(0, 60) : text;
  return '$selector:text(${_quote(short)})';
}

String _quote(String s) => '"${s.replaceAll(r'\', r'\\').replaceAll('"', r'\"')}"';
