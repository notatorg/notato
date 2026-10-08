import Foundation
import Observation
import OSLog

/// How Notato stands with its server.
public enum NotatoConnection: String, Sendable {
    /// Notato is switched off.
    case disabled
    /// No server: notes stay on the device (test mode) until packaged.
    case local
    case connecting
    case connected
    /// The server cannot be reached. Notes are kept and sent when it can.
    case offline
    /// The server refused this app (a missing or wrong token, a project the token cannot use).
    case refused
}

/// Optional details for `Notato.annotate`.
public struct AnnotateOptions: Sendable {
    /// `Severity.blocker`, `.major`, `.minor`, `.nit`.
    public var severity: String?
    /// `Intent.fix`, `.change`, `.question`, `.approve`.
    public var intent: String?
    /// Recorded as an agent's note when set; a person's otherwise.
    public var agentName: String?
    public var steps: [AgentStep]?
    /// Take a screenshot (when allowed).
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

public struct NotatoError: LocalizedError, Sendable {
    public let message: String
    public var errorDescription: String? { message }
}

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

let log = Logger(subsystem: "com.notato.sdk", category: "Notato")

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

/// Notato at runtime: switch it on and off, start annotating, select an element, or annotate one from code.
///
/// ```swift
/// @main struct ShopApp: App {
///     init() {
///         #if DEBUG
///         Notato.start(NotatoConfiguration(project: "shop-ios"))
///         #endif
///     }
///     var body: some Scene { WindowGroup { RootView() } }
/// }
/// ```
@MainActor
@Observable
public final class Notato {
    public static let shared = Notato()

    // ---- what the app and the overlay read ----------------------------------------------------------------------

    public private(set) var configuration: NotatoConfiguration?
    public private(set) var isEnabled = false
    public private(set) var isToolbarVisible = true
    public internal(set) var isAnnotating = false
    public private(set) var connection: NotatoConnection = .disabled
    /// The last connection problem, fit to show to a person.
    public private(set) var connectionDetail: String?
    /// The notes Notato knows of for this project, from the server and from this device.
    public var annotations: [Annotation] { records.map(\.annotation) }
    /// Notes made on this device that have not reached the server yet.
    public var pendingCount: Int { records.lazy.filter(\.pending).count }

    /// Every note, in the order they came. Changed only by `insert` and `forget`, which keep the index by id
    /// (`record(_:)`) and `generation` in step with it.
    private(set) var records: [NoteRecord] = []
    /// Moves on whenever a note is added or forgotten: what is worked out from the notes (`notes(onRoute:)`) is kept
    /// until it does.
    private(set) var generation = 0
    var state = RuntimeState(remember: true)
    var serverScreenshots = true
    var problem: String?

    @ObservationIgnored var store: LocalStore?
    @ObservationIgnored var client: NotatoClient?
    @ObservationIgnored var syncTask: Task<Void, Never>?
    @ObservationIgnored var started = Date()
    @ObservationIgnored var platform: PlatformHooks?
    @ObservationIgnored private var loaded = false
    /// Notes deleted here while a copy was on its way to the server: the server's word of them is not taken back in.
    @ObservationIgnored private var deletedHere: Set<String> = []
    /// `records` by id.
    @ObservationIgnored private var byId: [String: NoteRecord] = [:]
    /// The notes on each screen, as of a `generation`.
    @ObservationIgnored private var screens: (generation: Int, notes: [String: ScreenNotes])?

    /// What `environment.platform` says on notes made here.
    static let platform = "ios"

    private init() {}

    /// A Notato of its own with nothing running (no overlay, no connection, nothing remembered on the device): for
    /// tests, which must not touch `shared`'s server or the app's settings.
    init(configuration: NotatoConfiguration) {
        self.configuration = configuration
        state = RuntimeState(remember: false)
    }

    var mode: NotatoMode { configuration?.mode ?? .dev }
    var server: URL? {
        if let override = state.server { return URL(string: override) }
        return configuration?.resolvedServer
    }
    var hasServer: Bool { server != nil && mode != .test }
    var authorName: String? { state.author ?? configuration?.author }
    var screenshotsWanted: Bool { state.screenshots ?? configuration?.screenshots ?? true }
    var screenshotsOn: Bool { screenshotsWanted && serverScreenshots }
    var pinsVisible: Bool { state.pinsVisible ?? true }

    // ---- start-up ----------------------------------------------------------------------------------------------

    /// Starts Notato with a configuration. Call once, early (the app's `init`). Whether it shows straight away
    /// depends on `enabled` and on what was chosen at runtime before.
    public static func start(_ configuration: NotatoConfiguration) {
        shared.begin(configuration)
    }

    /// Starts Notato from the app's Info.plist (`Notato` dictionary) and `NOTATO_*` environment variables.
    /// Does nothing (and logs why) when neither names a project.
    public static func start() {
        guard let configuration = NotatoConfiguration.fromInfoPlist() else {
            log.error("Notato.start(): no Notato configuration with a Project in Info.plist or NOTATO_PROJECT. Notato stays off.")
            return
        }
        start(configuration)
    }

    private func begin(_ configuration: NotatoConfiguration) {
        self.configuration = configuration
        state = RuntimeState(remember: configuration.rememberRuntimeState)
        started = Date()
        problem = configuration.problem
        if let problem {
            log.error("\(problem, privacy: .public) Notato stays off.")
            return
        }
        isToolbarVisible = state.toolbarVisible ?? configuration.showToolbar
        setEnabled(state.enabled ?? configuration.enabled, remember: false)
    }

    // ---- on and off -----------------------------------------------------------------------------------------------

    /// Switches Notato on. Remembered across launches unless `rememberRuntimeState` is off.
    public func enable() { setEnabled(true, remember: true) }

    /// Switches Notato off: removes the overlay and closes the connection. Remembered like `enable()`.
    public func disable() { setEnabled(false, remember: true) }

    /// Forgets the choices made at runtime and goes back to the configuration.
    public func resetRuntimeState() {
        state.reset()
        guard let configuration else { return }
        isToolbarVisible = configuration.showToolbar
        platform?.toolbarPositionReset()
        setEnabled(configuration.enabled, remember: false)
        restartSync()
    }

    public func showToolbar() { setToolbar(true) }

    public func hideToolbar() { setToolbar(false) }

    func setToolbar(_ visible: Bool) {
        isToolbarVisible = visible
        state.toolbarVisible = visible
        if !visible { stopAnnotating() }
    }

    /// The next tap selects what is under it.
    public func startAnnotating() {
        guard isEnabled else { return }
        isAnnotating = true
    }

    public func stopAnnotating() {
        isAnnotating = false
        platform?.clearSelection()
    }

    func togglePins() { state.pinsVisible = !pinsVisible }

    private func setEnabled(_ on: Bool, remember: Bool) {
        if on, let problem {
            log.error("\(problem, privacy: .public) Notato stays off.")
            return
        }
        if remember { state.enabled = on }
        guard on != isEnabled else { return }
        isEnabled = on
        if on, let configuration {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("notato", isDirectory: true)
            store = LocalStore(base: base, project: configuration.project)
            Task { await loadLocal() }
            platform = PlatformHooks.make(self)
            platform?.attach()
            restartSync()
        } else {
            isAnnotating = false
            syncTask?.cancel()
            syncTask = nil
            platform?.detach()
            platform = nil
            connection = .disabled
            connectionDetail = nil
        }
    }

    // ---- the notes, by id and by screen ----------------------------------------------------------------------------

    /// A note by its id. Read in a view, the view is drawn again when notes come or go (it may be this one).
    func record(_ id: String) -> NoteRecord? {
        _ = generation
        return byId[id]
    }

    /// Adds the notes not known yet, in order.
    func insert(_ new: [NoteRecord]) {
        var added: [NoteRecord] = []
        for record in new where byId[record.id] == nil {
            byId[record.id] = record
            added.append(record)
        }
        guard !added.isEmpty else { return }
        records.append(contentsOf: added)
        generation += 1
    }

    /// Forgets the notes that match.
    func forget(where gone: (NoteRecord) -> Bool) {
        var dropped: [NoteRecord] = []
        let kept = records.filter { record in
            if gone(record) {
                dropped.append(record)
                return false
            }
            return true
        }
        guard !dropped.isEmpty else { return }
        for record in dropped where byId[record.id] === record { byId[record.id] = nil }
        records = kept
        generation += 1
    }

    /// The notes on a screen, in pin order. Worked out for every screen at once, and again only when a note is added
    /// or forgotten, so the overlay can ask on every tick.
    func notes(onRoute route: String) -> ScreenNotes {
        if screens?.generation != generation { screens = (generation, Self.byScreen(records)) }
        return screens?.notes[route] ?? ScreenNotes()
    }

    static func byScreen(_ records: [NoteRecord]) -> [String: ScreenNotes] {
        var screens: [String: ScreenNotes] = [:]
        for (route, notes) in Dictionary(grouping: records, by: \.route) {
            let all = notes.sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
            var pinned: [(number: Int, record: NoteRecord)] = []
            for (offset, record) in all.enumerated().reversed() where record.platform == platform {
                pinned.append((offset + 1, record))
                if pinned.count == PinLayout.maxPins { break }
            }
            screens[route] = ScreenNotes(all: all, pinned: pinned.reversed())
        }
        return screens
    }

    // ---- notes on the device -------------------------------------------------------------------------------------

    private func loadLocal() async {
        guard let store, !loaded else { return }
        loaded = true
        insert(await store.load().map { item in
            let record = NoteRecord(item.annotation, pending: true, mine: true, assets: item.assets)
            record.error = item.refusal
            return record
        })
        if connection == .connected { await flush() }
    }

    /// A note made here: in the list at once, and kept on the device until the server has it, its screenshots in
    /// files rather than in memory.
    func add(_ record: NoteRecord, screenshots: [String: Data]) async {
        record.assets = screenshots.mapValues { .bytes($0) }
        insert([record])
        guard let store else { return }
        do {
            let kept = try await store.keep(record.annotation, screenshots: screenshots)
            // Sent or deleted while it was written: nothing of it is wanted now (the store removes the files next).
            if record.pending, !record.deleted { record.assets = kept }
        } catch {
            log.error("Notato could not keep a note on the device: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Test mode: forget the notes kept on this device.
    func clearLocal() async {
        forget { $0.pending }
        await store?.clear()
    }

    // ---- sending -------------------------------------------------------------------------------------------------

    /// Sends one note now, unless it has gone or is going already.
    @discardableResult
    func send(_ record: NoteRecord) async -> SendOutcome {
        guard hasServer, let client, record.pending, record.error == nil, !record.deleted, !record.sending else { return .skipped }
        record.sending = true
        defer { record.sending = false }
        do {
            // Read from their files only now, and off the main actor.
            let kept = record.assets ?? [:]
            let screenshots = await Task.detached { KeptAsset.read(kept) }.value
            let stored = try await client.post(record.annotation, assets: screenshots)
            Self.landed(record, as: stored.annotation)
            await store?.remove(record.id)
            if record.deleted {
                // Deleted here while it was on its way: delete it there too.
                try? await client.delete(id: stored.annotation.id)
                return .skipped
            }
            return .sent
        } catch let error as NotatoServerError where error.refusesNote {
            record.error = error.message
            await store?.refuse(record.id, because: error.message)
            log.warning("The Notato server refused a note: \(error.message, privacy: .public)")
            return .refused(error.message)
        } catch let error as NotatoServerError {
            record.notice = error.status == 0 ? nil : error.message
            return .held(error)
        } catch {
            return .held(NotatoServerError(message: error.localizedDescription, status: 0))
        }
    }

    /// The server's answer to a note sent: it has it. The answer's copy is taken only while the note is still waiting
    /// for it: an event may have brought the server's copy while the note was on its way, or a newer one (acknowledged,
    /// replied to), and that one stays. It is taken before anything else is awaited, so an event after it wins too.
    static func landed(_ record: NoteRecord, as stored: Annotation) {
        if record.pending, !record.deleted { record.annotation = stored }
        record.pending = false
        record.notice = nil
        record.assets = nil
    }

    /// Sends every note waiting to go, oldest first. Returns why it stopped early, if it did.
    @discardableResult
    func flush() async -> NotatoServerError? {
        await Self.drain(records) { await self.send($0) }
    }

    /// Sends a queue in order. A refused note is passed over (it is marked failed) and the rest still go; anything
    /// else that stops one (no connection, a project the server does not know, a busy server) stops there, with it and
    /// everything after it still queued for the next try. Returns that reason.
    static func drain(_ queue: [NoteRecord], send: (NoteRecord) async -> SendOutcome) async -> NotatoServerError? {
        for record in queue where record.pending && record.error == nil && !record.deleted {
            if case let .held(error) = await send(record) { return error }
        }
        return nil
    }

    /// After every page of the list has come: the notes to forget, which the server had before the load (so not one
    /// still waiting to be sent, nor one sent or made while the pages came) and no longer lists.
    static func forgotten(known: Set<String>, listed: [StoredAnnotation], now: [NoteRecord]) -> Set<String> {
        let gone = known.subtracting(listed.map(\.annotation.id))
        return Set(now.filter { gone.contains($0.id) && !$0.pending }.map(\.id))
    }

    // ---- the server: live updates over server-sent events ------------------------------------------------------------

    func restartSync() {
        syncTask?.cancel()
        syncTask = nil
        guard isEnabled, let configuration else { return }
        client = server.map { client(for: $0) }
        guard hasServer, let client else {
            connection = .local
            connectionDetail = mode == .test ? nil : "No server is set: notes stay on this device."
            return
        }
        let project = configuration.project
        let agent = mode == .agent
        syncTask = Task { [weak self] in
            var delay: UInt64 = 1
            while !Task.isCancelled {
                self?.connection = .connecting
                do {
                    for try await event in client.events(project: project, agent: agent) {
                        await self?.handle(event, client: client)
                        delay = 1
                    }
                    if Task.isCancelled { return }
                    self?.setConnection(.offline, "The server closed the connection.")
                } catch let error as NotatoServerError where error.permanent {
                    self?.setConnection(.refused, error.message)
                    delay = 10
                } catch {
                    if Task.isCancelled { return }
                    self?.setConnection(.offline, (error as? NotatoServerError)?.message ?? error.localizedDescription)
                }
                try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
                delay = min(10, delay * 2)
            }
        }
    }

    /// A client of `server`, with the project token when the server may have it (`token(for:configuration:)`).
    func client(for server: URL, session: URLSession = NotatoClient.sharedSession) -> NotatoClient {
        NotatoClient(base: server, token: configuration.flatMap { Self.token(for: server, configuration: $0) }, session: session)
    }

    /// The project token, if `server` may have it: only the server it was configured for does (the same scheme, host
    /// and port). A server typed into Settings gets none, so the token never goes anywhere it was not set up to go,
    /// over plain http least of all.
    static func token(for server: URL, configuration: NotatoConfiguration) -> String? {
        guard let token = configuration.token, !token.isEmpty, let configured = configuration.resolvedServer,
              let origin = origin(of: server), origin == Self.origin(of: configured) else { return nil }
        return token
    }

    /// Scheme, host and port, with the scheme's own port when none is written.
    private static func origin(of url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased(), !host.isEmpty else { return nil }
        let port = url.port ?? (scheme == "https" ? 443 : scheme == "http" ? 80 : -1)
        return "\(scheme)://\(host):\(port)"
    }

    /// Tries the server again now, instead of waiting out the backoff between attempts (the menu's Retry).
    func retryConnection() {
        guard isEnabled, hasServer else { return }
        restartSync()
    }

    private func setConnection(_ next: NotatoConnection, _ detail: String?) {
        guard isEnabled else { return }
        connection = next
        connectionDetail = detail
    }

    func handle(_ event: ServerSentEvent, client: NotatoClient) async {
        switch event.event {
        case "hello":
            setConnection(.connected, nil)
            serverScreenshots = (try? await client.config())?.screenshots ?? serverScreenshots
            // The notes made while away go first, so the list read next has them.
            let held = await flush()
            await reload(client)
            // Connected, yet a note was not taken (an unknown project, a token that may not write): say why.
            if let held, held.status != 0 {
                platform?.toast("Notes not sent: \(held.message)")
            }
        case "created", "updated", "replied":
            if let data = event.data.data(using: .utf8), let body = try? NotatoJSON.decoder.decode(ServerEventData.self, from: data), let annotation = body.annotation {
                upsert(annotation)
            }
        case "deleted":
            if let data = event.data.data(using: .utf8), let body = try? NotatoJSON.decoder.decode(ServerEventData.self, from: data), let id = body.id {
                if let record = record(id), !record.pending { forget { $0 === record } }
                deletedHere.remove(id)
            }
        case "annotate-request":
            if let data = event.data.data(using: .utf8), let request = try? NotatoJSON.decoder.decode(AnnotateRequest.self, from: data) {
                Task { await self.answerRelay(request, client: client) }
            }
        default:
            break
        }
    }

    /// Reads every note of the project, a page at a time, then forgets those the server no longer has. Nothing is
    /// forgotten unless every page came: a list cut short would look like deletions. The list is a summary (no
    /// context, no steps), which is all the overlay shows and a small part of a note's size.
    private func reload(_ client: NotatoClient) async {
        guard let project = configuration?.project else { return }
        let known = Set(records.lazy.filter { !$0.pending }.map(\.id))
        let items: [StoredAnnotation]
        do {
            items = try await client.list(project: project, summary: true)
        } catch is CancellationError {
            return
        } catch {
            log.error("Notato could not read the project's notes from the server: \(error.localizedDescription, privacy: .public)")
            return
        }
        merge(items.map(\.annotation), summary: true)
        let forgotten = Self.forgotten(known: known, listed: items, now: records)
        if !forgotten.isEmpty { forget { forgotten.contains($0.id) } }
    }

    func upsert(_ annotation: Annotation) { merge([annotation]) }

    /// Takes in notes from the server, in one pass through the index: each one known takes the server's copy, one
    /// waiting to be sent that the server turns out to have is sent, and the rest are added. A `summary` (a list read
    /// with `fields=summary`) keeps the context and steps known here, which the server never changes.
    func merge(_ listed: [Annotation], summary: Bool = false) {
        guard let project = configuration?.project else { return }
        var added: [NoteRecord] = []
        var addedById: [String: NoteRecord] = [:]
        var sent: [String] = []
        for annotation in listed where annotation.projectId == project && !deletedHere.contains(annotation.id) {
            if let known = byId[annotation.id] ?? addedById[annotation.id] {
                if Self.adopt(annotation, into: known, summary: summary) { sent.append(known.id) }
            } else {
                let record = NoteRecord(annotation)
                addedById[record.id] = record
                added.append(record)
            }
        }
        insert(added)
        if !sent.isEmpty, let store { Task { for id in sent { await store.remove(id) } } }
    }

    /// The server's copy of a note into its record. Returns whether the note was waiting to be sent, which it no
    /// longer is.
    static func adopt(_ annotation: Annotation, into record: NoteRecord, summary: Bool) -> Bool {
        var next = annotation
        let current = record.annotation
        if summary {
            next.context = current.context
            next.steps = current.steps
        }
        // Only a change is set: the same copy set again would draw everything showing the note again.
        if next != current { record.annotation = next }
        guard record.pending else { return false }
        record.pending = false
        record.assets = nil
        return true
    }

    /// Agent mode: an agent asked, through `notato_annotate`, for something in this app to be annotated.
    private func answerRelay(_ request: AnnotateRequest, client: NotatoClient) async {
        let result: RelayResult
        do {
            let annotation = try await annotate(request.args.target, comment: request.args.comment, options: AnnotateOptions(
                severity: request.args.severity, intent: request.args.intent, agentName: request.args.author ?? "agent", steps: request.args.steps))
            if let record = record(annotation.id), record.pending, let notice = record.notice {
                // Made, but the server answered and did not take it (a project it does not know, say): reporting it
                // filed would send the agent looking for a note the server does not have.
                let reason = notice.hasSuffix(".") ? notice : notice + "."
                result = RelayResult(ok: false, annotationId: nil, error: "The note was made on the device but the server did not take it: \(reason) It is sent again on the next connection.")
            } else {
                result = RelayResult(ok: true, annotationId: annotation.id, error: nil)
            }
        } catch {
            result = RelayResult(ok: false, annotationId: nil, error: error.localizedDescription)
        }
        do {
            try await client.relayResult(requestId: request.requestId, result)
        } catch {
            log.warning("Notato could not report an annotate result: \(error.localizedDescription, privacy: .public)")
        }
    }

    // ---- acting on a note, as the person ---------------------------------------------------------------------

    private func connectedClient() throws -> NotatoClient {
        guard hasServer, let client else { throw NotatoError(message: "Not connected to a Notato server.") }
        return client
    }

    /// An aside is for the people on the thread: the agent never sees it.
    func reply(_ id: String, _ text: String, aside: Bool = false) async throws {
        upsert(try await connectedClient().reply(id: id, text: text, author: .human(authorName), aside: aside).annotation)
    }

    /// Turns People only on or off for a note, as the person. The server does it (and records it in the thread) once it
    /// has the note; a note not sent yet (offline, or test mode) is changed on the device, with the same entry in its
    /// thread, and goes to the server or into a package that way.
    func setPeopleOnly(_ id: String, _ on: Bool) async throws {
        guard let record = record(id) else { throw NotatoError(message: "That note is gone.") }
        guard on != record.annotation.isPeopleOnly else { return }
        let author = Author.human(authorName)
        guard record.pending else {
            upsert(try await connectedClient().setPeopleOnly(id: id, on, author: author).annotation)
            return
        }
        // On its way now: the server's copy, when it lands, would replace this change.
        guard !record.sending else { throw NotatoError(message: "The note is being sent: try again in a moment.") }
        record.annotation = record.annotation.settingPeopleOnly(on, by: author)
        if let store { _ = try? await store.keep(record.annotation) }
    }

    func requestRevert(_ id: String, reason: String?) async throws {
        let note = reason?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? reason : "Please undo this change."
        upsert(try await connectedClient().setStatus(id: id, status: Status.revertRequested, note: note, author: .human(authorName)).annotation)
    }

    func cancelRevert(_ id: String) async throws {
        upsert(try await connectedClient().setStatus(id: id, status: Status.resolved, note: "Revert request taken back.", author: .human(authorName)).annotation)
    }

    func delete(_ id: String) async throws {
        let record = record(id)
        if let record, !record.pending, hasServer {
            try await connectedClient().delete(id: id)
        }
        if let record {
            // A copy on its way now is deleted on the server when it lands (`send`); one not sent yet never goes.
            record.deleted = true
            if record.sending { deletedHere.insert(id) }
        }
        forget { $0.id == id }
        await store?.remove(id)
    }

    func saveSettings(name: String, screenshots: Bool, server: String) {
        state.author = name
        state.screenshots = screenshots == (configuration?.screenshots ?? true) ? nil : screenshots
        let trimmed = server.trimmingCharacters(in: .whitespaces)
        let changed: Bool
        if trimmed.isEmpty || trimmed == configuration?.resolvedServer?.absoluteString {
            changed = state.server != nil
            state.server = nil
        } else if let url = URL(string: trimmed), ["http", "https"].contains(url.scheme ?? "") {
            changed = state.server != trimmed
            state.server = trimmed
        } else {
            platform?.toast("\"\(trimmed)\" is not an http(s) address; the server was not changed.")
            changed = false
        }
        if changed {
            forget { !$0.pending }
            restartSync()
        }
    }

    /// The server as people know it: `localhost:4747`, or the whole address when it has no host.
    var serverHost: String? {
        server.map { url in url.host.map { "\($0)\(url.port.map { ":\($0)" } ?? "")" } ?? url.absoluteString }
    }

    func describeConnection() -> String {
        let host = serverHost
        switch connection {
        case .connected: return "Connected to \(host ?? "the server")"
        case .connecting: return "Connecting to \(host ?? "the server")…"
        case .offline: return connectionDetail ?? "Cannot reach \(host ?? "the server")"
        case .refused: return connectionDetail ?? "\(host ?? "The server") refused this app"
        case .local:
            if mode == .test { return host.map { "Notes stay on this device; a package is uploaded to \($0)" } ?? "Notes stay on this device until packaged" }
            return connectionDetail ?? "No server"
        case .disabled: return problem ?? "Off"
        }
    }

    // ---- test mode: a bundle zip -----------------------------------------------------------------------------------

    /// Packages this device's notes as a bundle zip (`feedback.md`, `annotations.json`, `shots/`), the format
    /// `notato_import_bundle` reads, and uploads it when a server is set. Returns the zip's file URL.
    public func package(upload: Bool = true) async throws -> URL {
        guard let configuration else { throw NotatoError(message: "Notato has not been started.") }
        let mine = records.filter { $0.pending || (mode == .test && $0.mine) }
        if mine.isEmpty { throw NotatoError(message: "Nothing to package yet: make at least one note.") }
        let items = mine.map { LocalAnnotation(annotation: $0.annotation, assets: $0.assets ?? [:]) }
        let (bundle, files) = BundleWriter.build(items, project: configuration.project, author: authorName,
                                                 appName: AppInfo.name(configuration), appVersion: AppInfo.version(configuration))
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmm"
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("notato-\(SafeIds.folder(forProject: configuration.project))-\(formatter.string(from: Date())).zip")
        // Written to the file a screenshot at a time, each read from where it is kept, off the main actor.
        try await Task.detached { try BundleWriter.write(bundle, files: files, to: url) }.value
        if upload, let server {
            try await client(for: server).uploadBundle(project: configuration.project, file: url)
        }
        return url
    }
}
