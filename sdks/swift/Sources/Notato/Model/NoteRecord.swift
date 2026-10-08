import Foundation
import Observation

/// What became of one attempt to send a note.
enum SendOutcome: Equatable {
    /// The server has it.
    case sent
    /// The server will never take it as it is (400, 409, 413, 415 or 422). It is marked failed with the server's
    /// reason and kept on the device, and the notes after it are sent all the same.
    case refused(String)
    /// Not now: the server cannot be reached, or answered 401, 403, 404, 408, 429 or 5xx. It stays queued, and so does
    /// everything after it, until the next connection or launch.
    case held(NotatoServerError)
    /// Nothing was sent: there is no server, or the note was sent, refused or deleted already, or is on its way.
    case skipped

    /// What to tell the person who just made the note, or nil when it went.
    var problem: String? {
        switch self {
        case .sent, .skipped: return nil
        case let .refused(message): return "The server refused it: \(message)"
        case let .held(error) where error.status == 0: return "Saved. It's sent when the server can be reached."
        case let .held(error): return "Saved on this device, not sent: \(error.message)"
        }
    }
}

/// A note Notato knows of: from the server, or made here and not sent yet.
@MainActor
@Observable
final class NoteRecord: Identifiable {
    var annotation: Annotation
    /// Made here and not yet taken by the server (or, in test mode, not yet packaged).
    var pending: Bool
    /// Why the server refused it for good: it stays on the device, marked failed, and is not sent again.
    var error: String?
    /// Why it has not been sent yet, when the server said (a project it does not know, a token it does not take).
    var notice: String?
    /// Made on this device in this run.
    var mine: Bool
    /// Its screenshots while it is not sent: the files they are kept in, read only when it is sent or packaged.
    @ObservationIgnored var assets: [String: KeptAsset]?
    /// The marked view it was made on, followed live for its pin.
    @ObservationIgnored var markId: UUID?
    /// On its way to the server now.
    @ObservationIgnored var sending = false
    /// Deleted on this device: never sent again, and deleted on the server too if a copy was already on its way.
    @ObservationIgnored var deleted = false
    /// Its first selector, parsed, and the text it was parsed from (`selector`).
    @ObservationIgnored private var parsed: (source: String, selector: Selectors.Parsed?)?

    /// The annotation's id, which never changes.
    nonisolated let id: String
    /// Where, when and on which platform it was made, which the server never changes either: enough to tell which
    /// notes are on a screen, and in which order, without reading each annotation.
    nonisolated let route: String
    nonisolated let createdAt: String
    nonisolated let platform: String

    init(_ annotation: Annotation, pending: Bool = false, mine: Bool = false, assets: [String: KeptAsset]? = nil) {
        self.id = annotation.id
        self.route = annotation.route
        self.createdAt = annotation.createdAt
        self.platform = annotation.environment.platform
        self.annotation = annotation
        self.pending = pending
        self.mine = mine
        self.assets = assets
    }

    /// The note's selector, parsed once (and again only if the server changes it): pins look for their element twice
    /// a second.
    var selector: Selectors.Parsed? {
        guard let source = annotation.target.identity.first?.selector else { return nil }
        if let parsed, parsed.source == source { return parsed.selector }
        let selector = try? Selectors.parse(source)
        parsed = (source, selector)
        return selector
    }
}

/// The notes on one screen, in pin order: oldest first, so a note keeps its number as more are made.
@MainActor
struct ScreenNotes {
    var all: [NoteRecord] = []
    /// The notes pinned on the screen: the newest `PinLayout.maxPins` of those made on this platform (a note from
    /// another is about another app's screen of the same name), with their numbers among `all`. Every note is in the
    /// Notes list all the same.
    var pinned: [(number: Int, record: NoteRecord)] = []

    var count: Int { all.count }

    /// The newest `limit`, still in pin order, with their numbers.
    func newest(_ limit: Int) -> [(number: Int, record: NoteRecord)] {
        all.indices.suffix(limit).map { (number: $0 + 1, record: all[$0]) }
    }
}
