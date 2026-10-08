import Foundation

// The wire shapes of @notato/schema (packages/schema/src/index.ts), the contract with the server. Enumerations
// travel as strings, so a value added to the schema later does not break reading what the server sends.

/// What a note asks for (`Annotation.intent`).
public enum Intent {
    public static let fix = "fix"
    public static let change = "change"
    public static let question = "question"
    public static let approve = "approve"
    public static let variants = "variants"
}

/// How much a note matters (`Annotation.severity`).
public enum Severity {
    public static let blocker = "blocker"
    public static let major = "major"
    public static let minor = "minor"
    public static let nit = "nit"
}

/// Where a note stands (`Annotation.status`): open → acknowledged → resolved; a resolved change can be asked to be
/// undone (revert_requested → reverted).
public enum Status {
    public static let open = "open"
    public static let acknowledged = "acknowledged"
    public static let variantChosen = "variant_chosen"
    public static let resolved = "resolved"
    public static let revertRequested = "revert_requested"
    public static let reverted = "reverted"
    public static let dismissed = "dismissed"
}

/// Who wrote a note or a reply: a person, or an agent.
public struct Author: Codable, Sendable, Equatable {
    /// `human` or `agent`.
    public var kind: String
    public var name: String?

    public init(kind: String, name: String? = nil) {
        self.kind = kind
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.name = trimmed?.isEmpty == false ? trimmed : nil
    }

    public static func human(_ name: String?) -> Author { Author(kind: "human", name: name) }
    public static func agent(_ name: String?) -> Author { Author(kind: "agent", name: name) }
}

/// A rectangle in points from the top left of the window.
public struct PageRect: Codable, Sendable, Equatable {
    public var x: Double, y: Double, w: Double, h: Double

    public init(x: Double, y: Double, w: Double, h: Double) {
        self.x = x; self.y = y; self.w = w; self.h = h
    }
}

/// A screenshot: its content address (sha256) and its size in pixels.
public struct AssetRef: Codable, Sendable, Equatable {
    public var id: String
    /// `image/png` or `image/webp`.
    public var mime: String
    public var w: Int
    public var h: Int
    /// Where it is in a bundle zip (`shots/01-full.png`); nil elsewhere.
    public var path: String?
}

/// Where an element is written: a path from the repository root and the 1-based line and column.
public struct SourceLocation: Codable, Sendable, Equatable {
    public var file: String
    public var line: Int
    public var col: Int
    /// Set when this is the closest marked view around the element rather than the element itself.
    public var nearest: Bool?
}

/// The marked view (`.notato()`) an element is, or is inside.
public struct ComponentInfo: Codable, Sendable, Equatable {
    public var name: String
    public var source: String?
    /// The marked views around the element, outermost first.
    public var path: [String]?
}

/// What a note is about, as precisely as it can be told: how to find it again, what it is and where it is written.
public struct ElementIdentity: Codable, Sendable, Equatable {
    /// On iOS, the screen and the accessibility element: `ProductDetailView button:text("Add to cart")`.
    public var selector: String
    /// The accessibility identifier.
    public var testId: String?
    public var role: String?
    /// The accessibility label.
    public var name: String?
    /// The kind of control, as SwiftUI names it: `Button`, `Text`, `Toggle`.
    public var tag: String
    public var classes: [String]?
    /// Visible text (label and value), at most 200 code points (`textLimit`).
    public var text: String?
    public var source: SourceLocation?
    public var component: ComponentInfo?
    public var styles: [String: String]?
    public var ancestors: [String]?
    /// The accessibility identifier.
    public var platformId: String?
}

extension ElementIdentity {
    /// The most `text` may hold, in Unicode code points: what the server's schema counts, not characters as Swift
    /// counts them (an emoji with a skin tone is one character and two code points).
    static let textLimit = 200
}

extension String {
    /// At most `limit` Unicode code points, ending in "…" when cut. The cut falls between characters, so a character
    /// made of several code points (an emoji, a syllable with its marks) is left out whole rather than split.
    func clipped(toScalars limit: Int) -> String {
        guard unicodeScalars.count > limit else { return self }
        guard limit > 1 else { return limit == 1 ? "…" : "" }
        var out = ""
        var used = 0
        for character in self {
            let size = character.unicodeScalars.count
            if used + size > limit - 1 { break }
            out.append(character)
            used += size
        }
        if out.isEmpty {
            // The first character alone is longer than the limit (a pile of combining marks): cut inside it.
            var view = String.UnicodeScalarView()
            view.append(contentsOf: unicodeScalars.prefix(limit - 1))
            out = String(view)
        }
        return out + "…"
    }
}

/// One thing an agent did on its way to a note (`tap`, `type`, …), on what, and when.
public struct AgentStep: Codable, Sendable, Equatable {
    public var action: String
    public var target: String?
    public var value: String?
    public var at: String

    public init(action: String, target: String? = nil, value: String? = nil, at: String) {
        self.action = action; self.target = target; self.value = value; self.at = at
    }
}

/// One entry in a note's thread.
public struct Reply: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var author: Author
    public var body: String
    public var createdAt: String
    /// Written by Notato to record something the person did (turning People only on or off), not something they said.
    public var automatic: Bool?
    /// An aside: for the people on the thread, kept from the agent. Set by the person when they send it.
    public var aside: Bool?
    /// Only on the automatic entry recording People only turned on (`true`) or off (`false`).
    public var peopleOnly: Bool?
}

extension Reply {
    /// The automatic entry recording someone turning People only on or off, as the server writes it.
    static func peopleOnlyChange(_ on: Bool, by author: Author, at date: Date = Date()) -> Reply {
        Reply(id: ULID.make(at: date), author: author,
              body: on ? "Made this people only: the agent won't see it." : "Shared this with the agent.",
              createdAt: NotatoJSON.timestamp(date), automatic: true, peopleOnly: on)
    }
}

/// The window's size, in points.
public struct Viewport: Codable, Sendable, Equatable {
    public var w: Double
    public var h: Double
}

/// Where a note was made: the platform, the device and the window.
public struct EnvironmentInfo: Codable, Sendable, Equatable {
    public var userAgent: String
    public var viewport: Viewport
    public var dpr: Double
    /// `web`, `maui`, `ios`, `android`, or a newer SDK's.
    public var platform: String
    /// The package that made the note, and its version. Absent from notes made before 0.2.
    public var sdk: SDKInfo? = nil
}

/// The SDK that made a note, and its version.
public struct SDKInfo: Codable, Sendable, Equatable {
    public var name: String
    public var version: String
}

/// What a note is about: one element or several, and the rectangle around them.
public struct Target: Codable, Sendable, Equatable {
    /// `element`, `text`, `area` or `multi`.
    public var kind: String
    public var identity: [ElementIdentity]
    public var rect: PageRect
    public var selectedText: String?
}

/// A note's pictures.
public struct Screenshots: Codable, Sendable, Equatable {
    /// The whole window with the target outlined.
    public var full: AssetRef
    public var crop: AssetRef?
}

/// A note: what someone said about a place in the app, with everything an agent needs to find and fix it.
public struct Annotation: Codable, Sendable, Equatable, Identifiable {
    /// A ULID.
    public var id: String
    public var projectId: String
    /// The bundle a tester's note was packaged in; nil outside one. Always written, as null when nil: the schema
    /// requires the key.
    @AlwaysPresent public var bundleId: String?
    public var author: Author
    /// The mode it was made in: `dev`, `test` or `agent`.
    public var mode: String
    /// ISO 8601, with milliseconds.
    public var createdAt: String

    /// `ios://<bundle id><route>`.
    public var url: String
    /// The screens showing when it was made, outermost first: `/ProductList/ProductDetail`.
    public var route: String
    public var appName: String?
    public var appVersion: String?
    public var environment: EnvironmentInfo

    public var target: Target
    public var comment: String
    /// `Severity`'s values, or nil.
    public var severity: String?
    /// `Intent`'s values, or nil.
    public var intent: String?
    /// Alternatives an agent offered to choose from, carried as the server sent them.
    public var variants: JSONValue?

    public var screenshots: Screenshots?
    public var steps: [AgentStep]?
    /// Keyed by plugin id: `console`, `network`, `ios`. The server never interprets it.
    public var context: [String: JSONValue]

    /// `Status`'s values, or one from a newer server.
    public var status: String
    public var thread: [Reply]
    /// People only: the note and its whole thread are between people, and never reach the agent. Written only when
    /// on (`isPeopleOnly` keeps it so).
    public var peopleOnly: Bool?
}

extension Annotation {
    /// People only, as a plain on or off. Off leaves the key out, as the server does.
    public var isPeopleOnly: Bool {
        get { peopleOnly == true }
        set { peopleOnly = newValue ? true : nil }
    }

    /// People only turned on or off by `author` where the server cannot do it (a note not sent yet, test mode): the
    /// flag, and the same automatic entry in the thread the server writes, so a package carries the history. The
    /// same annotation when it is that way already.
    func settingPeopleOnly(_ on: Bool, by author: Author, at date: Date = Date()) -> Annotation {
        guard on != isPeopleOnly else { return self }
        var next = self
        next.isPeopleOnly = on
        next.thread.append(.peopleOnlyChange(on, by: author, at: date))
        return next
    }
}

/// A tester's notes packaged together (the zip's `annotations.json`).
public struct FeedbackBundle: Codable, Sendable, Equatable {
    public struct BundleAuthor: Codable, Sendable, Equatable {
        public var name: String?
    }

    public var id: String
    public var projectId: String
    public var createdAt: String
    public var author: BundleAuthor
    public var appName: String?
    public var appVersion: String?
    public var annotations: [Annotation]
    public var schemaVersion: Int = 1
}

/// An annotation as the server stores it, with the order it arrived in.
public struct StoredAnnotation: Codable, Sendable, Equatable {
    public var seq: Int
    public var annotation: Annotation
}

// ---- server bodies -------------------------------------------------------------------------------------------

/// One page of a project's annotations, oldest first. `next` is there when the page is full: the rest come after it.
struct AnnotationList: Codable, Sendable {
    var items: [StoredAnnotation]
    var next: Int?
}

struct ServerConfig: Codable, Sendable {
    var screenshots: Bool?
}

struct ErrorBody: Codable, Sendable {
    var error: String?
}

struct ServerEventData: Codable, Sendable {
    var id: String?
    var projectId: String?
    var annotation: Annotation?
}

/// What an agent asks this app to annotate, relayed from `notato_annotate`.
struct AnnotateRequest: Codable, Sendable {
    struct Args: Codable, Sendable {
        var target: String
        var comment: String
        var severity: String?
        var intent: String?
        var steps: [AgentStep]?
        var author: String?
    }

    var requestId: String
    var args: Args
}

struct RelayResult: Codable, Sendable {
    var ok: Bool
    var annotationId: String?
    var error: String?
}

struct StatusChange: Codable, Sendable {
    var status: String
    var note: String?
    var author: Author?
}

struct ReplyBody: Codable, Sendable {
    var body: String
    var author: Author?
    /// Only when it is an aside: left out otherwise.
    var aside: Bool?
}

/// People only turned on or off for a note on the server (`PATCH /annotations/:id`). Only a person may.
struct PeopleOnlyChange: Codable, Sendable {
    var peopleOnly: Bool
    var author: Author?
}

/// A log message, in the shape of the web SDK's `console` context.
struct LogEntry: Codable, Sendable, Equatable {
    var level: String
    var message: String
    var at: String
}

/// One HTTP request, in the shape of the web SDK's `network` context.
struct NetworkEntry: Codable, Sendable, Equatable {
    var method: String
    var url: String
    var status: Int
    var durationMs: Int
    var at: String
}

enum NotatoJSON {
    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()

    static let decoder = JSONDecoder()

    /// Made once: a formatter is slow to make, and a list of notes or a log reads many timestamps. Foundation's
    /// formatters are safe to use from several threads once set up, and these are never changed after.
    nonisolated(unsafe) private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    nonisolated(unsafe) private static let whole = ISO8601DateFormatter()

    static func timestamp(_ date: Date = Date()) -> String {
        fractional.string(from: date)
    }

    /// A timestamp read back, with or without its fraction of a second.
    static func date(_ text: String) -> Date? {
        fractional.date(from: text) ?? whole.date(from: text)
    }
}
