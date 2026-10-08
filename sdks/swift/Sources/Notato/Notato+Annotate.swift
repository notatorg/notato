import Foundation

/// Optional details for a note made from code with `Notato.annotate(_:comment:options:)`.
public struct AnnotateOptions: Sendable {
    /// How much it matters: `Severity.blocker`, `.major`, `.minor` or `.nit`.
    public var severity: String?
    /// What is wanted: `Intent.fix`, `.change`, `.question`, `.approve` or `.variants`.
    public var intent: String?
    /// Recorded as an agent's note when set; a person's otherwise.
    public var agentName: String?
    /// What was done to get here, for an agent that drove the app.
    public var steps: [AgentStep]?
    /// Take a screenshot, when screenshots are on.
    public var screenshot: Bool
    /// People only: the note and its thread stay between people and never reach the agent. A person's note only: it is
    /// left off an agent's (`agentName`).
    public var peopleOnly: Bool

    public init(severity: String? = nil, intent: String? = nil, agentName: String? = nil, steps: [AgentStep]? = nil, screenshot: Bool = true,
                peopleOnly: Bool = false) {
        self.severity = severity
        self.intent = intent
        self.agentName = agentName
        self.steps = steps
        self.screenshot = screenshot
        self.peopleOnly = peopleOnly
    }
}

// Making a note, or opening one, from code. The overlay that finds what a selector means is UIKit's, so without UIKit
// (the macOS build the tests run on) both say so.
#if canImport(UIKit)
extension Notato {
    /// Makes a note about the element a selector finds on screen, without any UI, as a person or (with
    /// `agentName`) an agent: `#AddToCart`, `button:text("Add to cart")`, `ProductDetail text:text("£89")`. Throws
    /// when nothing matches, or when the server refuses the note for good (it stays on the device, marked failed); a
    /// note the server cannot take yet is returned, and sent when it can be.
    @discardableResult
    public func annotate(_ selector: String, comment: String, options: AnnotateOptions = AnnotateOptions()) async throws -> Annotation {
        guard isEnabled, let platform else { throw NotatoError(message: "Notato is off. Call enable() first.") }
        let comment = comment.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !comment.isEmpty else { throw NotatoError(message: "A note needs a comment.") }
        var found = try platform.find(selector)
        if found == nil {
            // The accessibility tree is built lazily the first time it is read: look again once it has been.
            try await Task.sleep(for: .milliseconds(500))
            found = try platform.find(selector)
        }
        guard case (let session, var selection)? = found else {
            let route = platform.sessions.first.map { platform.route(of: $0) } ?? "?"
            throw NotatoError(message: "no element on the screen matches \"\(selector)\" (the app is on \(route)). iOS selectors look like #identifier, button:text(\"Add to cart\") or text:text(\"£89\"):nth(2).")
        }
        if options.screenshot, screenshotsOn, let window = session.appWindow { selection.screen = platform.capture(window, elements: selection.all) }
        let author: Author = options.agentName.map { .agent($0) } ?? .human(authorName)
        let record = await platform.create(selection, comment: comment, intent: options.intent, severity: options.severity, author: author,
                                           mode: options.agentName == nil ? mode.rawValue : NotatoMode.agent.rawValue, steps: options.steps,
                                           peopleOnly: options.peopleOnly && options.agentName == nil, in: session)
        // A note the server will never take is no note to report back (to an agent's `notato_annotate`, say). One that
        // waits for the server is: it is sent when it can be.
        if case let .refused(message) = await send(record) {
            throw NotatoError(message: "The server refused the note: \(message)")
        }
        return record.annotation
    }

    /// Selects the element a selector finds, as if it had been tapped, and opens the note for it.
    public func select(_ selector: String) throws {
        guard isEnabled, let platform else { throw NotatoError(message: "Notato is off. Call enable() first.") }
        guard case (let session, var selection)? = try platform.find(selector) else {
            throw NotatoError(message: "No element on the screen matches \"\(selector)\".")
        }
        isAnnotating = true
        if screenshotsOn, let window = session.appWindow { selection.screen = platform.capture(window, elements: selection.all) }
        platform.select(selection, in: session)
    }
}
#else
extension Notato {
    @discardableResult
    public func annotate(_ selector: String, comment: String, options: AnnotateOptions = AnnotateOptions()) async throws -> Annotation {
        throw NotatoError(message: "Notato's overlay needs UIKit (iOS or Mac Catalyst).")
    }

    public func select(_ selector: String) throws {
        throw NotatoError(message: "Notato's overlay needs UIKit (iOS or Mac Catalyst).")
    }
}
#endif
