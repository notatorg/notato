import Foundation

/// Selectors for iOS, written like CSS so they read at a glance and an agent can write one:
/// `ProductDetail button:text("Add to cart")`.
///
/// - `#AddToCart`: the accessibility identifier, or the name of a `.notato("AddToCart")` mark.
/// - `button`: the role (`*` for any).
/// - `:text("Add to cart")`: the label or value contains this, ignoring case.
/// - `:nth(2)`: the second match on the screen, in reading order.
/// - A leading word followed by a space is the screen (`.notatoScreen()`), quoted when it is not one capitalised word
///   (`"My cart" button`): a hint for people, ignored when matching.
enum Selectors {
    struct Parsed: Hashable {
        var screen: String?
        var role: String?
        var id: String?
        var text: String?
        var nth: Int?
    }

    static func quote(_ text: String) -> String {
        "\"" + text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    /// The shortest selector that finds only this element among `all`, with the screen in front when known.
    static func make(for element: ScreenElement, among all: [ScreenElement], screen: String?) -> String {
        let prefix = screen.map { "\(screenName($0)) " } ?? ""
        if let id = element.identifier, !id.isEmpty, all.filter({ $0.identifier == id && $0 != element }).isEmpty {
            return prefix + "#" + plain(id)
        }
        var base = element.role ?? element.control.lowercased()
        if let text = element.text, !text.isEmpty {
            base += ":text(\(quote(String(text.prefix(60)))))"
        }
        let parsed = try? parse(base)
        let same = parsed.map { p in all.filter { matches($0, p) } } ?? []
        if same.count > 1, let index = same.firstIndex(of: element) {
            base += ":nth(\(index + 1))"
        }
        return prefix + base
    }

    /// A screen's name as it is written in front of a selector: bare when it is one capitalised word, as most type
    /// names are, and quoted otherwise (`.notatoScreen("My cart")`), so it reads back whatever it holds.
    private static func screenName(_ name: String) -> String {
        name.range(of: #"^[A-Z][A-Za-z0-9_.-]*$"#, options: .regularExpression) != nil ? name : quote(name)
    }

    private static func plain(_ id: String) -> String {
        id.range(of: #"^[A-Za-z_][\w.-]*$"#, options: .regularExpression) != nil ? id : quote(id)
    }

    static func matches(_ element: ScreenElement, _ selector: Parsed) -> Bool {
        if let role = selector.role, role != "*", role != element.role, role.lowercased() != element.control.lowercased() { return false }
        if let id = selector.id, element.identifier != id { return false }
        if let text = selector.text {
            guard let own = element.text, own.range(of: text, options: [.caseInsensitive, .diacriticInsensitive]) != nil else { return false }
        }
        return true
    }

    /// The elements a selector finds, in reading order (`nth` applied).
    static func query(_ selector: String, in elements: [ScreenElement]) throws -> [ScreenElement] {
        let parsed = try parse(selector)
        let found = elements.filter { matches($0, parsed) }
        if let nth = parsed.nth { return nth <= found.count ? [found[nth - 1]] : [] }
        return found
    }

    /// The first element a parsed selector finds (the `nth`, with one), looking no further than it has to.
    static func first(_ parsed: Parsed, in elements: [ScreenElement]) -> ScreenElement? {
        var left = parsed.nth ?? 1
        for element in elements where matches(element, parsed) {
            left -= 1
            if left == 0 { return element }
        }
        return nil
    }

    struct SelectorError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    static func parse(_ raw: String) throws -> Parsed {
        var s = Substring(raw.trimmingCharacters(in: .whitespaces))
        var result = Parsed()
        func fail(_ why: String) -> SelectorError { SelectorError(message: "selector \"\(raw)\": \(why)") }

        func ident() -> String {
            let word = s.prefix { $0.isLetter || $0.isNumber || "_-.".contains($0) }
            s = s.dropFirst(word.count)
            return String(word)
        }
        func quoted() throws -> String {
            guard let quote = s.first, quote == "\"" || quote == "'" else { return ident() }
            s = s.dropFirst()
            var out = ""
            while let c = s.first, c != quote {
                if c == "\\", s.count > 1 { s = s.dropFirst() }
                out.append(s.first!)
                s = s.dropFirst()
            }
            if s.isEmpty { throw fail("unclosed quote") }
            s = s.dropFirst()
            return out
        }
        // The screen: a quoted name, or a leading word, followed by a space. Nothing else holds a space outside quotes.
        if s.first == "\"" || s.first == "'" {
            let screen = try quoted()
            guard s.first == " " else { throw fail("a quoted screen name needs a space and a selector after it") }
            result.screen = screen
            s = s.drop(while: { $0 == " " })
        } else if let space = s.firstIndex(of: " "), !s[..<space].contains(where: { "#:\"'*()".contains($0) }) {
            result.screen = String(s[..<space])
            s = s[space...].drop(while: { $0 == " " })
        }
        if s.isEmpty { throw fail(result.screen == nil ? "nothing to match" : "nothing to match after the screen") }
        if s.first == "*" {
            result.role = "*"
            s = s.dropFirst()
        } else if let first = s.first, first.isLetter {
            result.role = ident()
        }
        while let c = s.first {
            switch c {
            case "#":
                s = s.dropFirst()
                result.id = try quoted()
                if result.id?.isEmpty ?? true { throw fail("# needs an identifier") }
            case ":":
                s = s.dropFirst()
                let pseudo = ident()
                guard s.first == "(" else { throw fail(":\(pseudo) needs (…)") }
                s = s.dropFirst()
                let argument = try quoted()
                guard s.first == ")" else { throw fail("missing )") }
                s = s.dropFirst()
                switch pseudo {
                case "text", "has-text": result.text = argument
                case "nth", "nth-match":
                    guard let n = Int(argument), n > 0 else { throw fail(":nth needs a positive number") }
                    result.nth = n
                default: throw fail(":\(pseudo) is not supported; use :text(\"…\") or :nth(n)")
                }
            default:
                throw fail("unexpected \"\(c)\"")
            }
        }
        if result.role == nil, result.id == nil, result.text == nil { throw fail("expected a role, #id or :text(\"…\")") }
        return result
    }
}
