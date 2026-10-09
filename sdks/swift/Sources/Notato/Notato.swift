import Foundation
import Observation
import OSLog

/// How Notato stands with its server.
public enum NotatoConnection: String, Sendable {
    /// Notato is switched off.
    case disabled
    /// No server: notes stay on the device (test mode, or `noServer`) until packaged.
    case local
    /// Connecting to the server, or connecting again after it went away.
    case connecting
    /// Connected: notes go to the server as they are made, and its changes come back live.
    case connected
    /// The server cannot be reached. Notes are kept and sent when it can.
    case offline
    /// The server refused this app (a missing or wrong token, a project the token cannot use).
    case refused
}

/// Why Notato could not do what the app asked: it is off, nothing on screen matches a selector, there is nothing to
/// package. The message is written to be shown to a person.
public struct NotatoError: LocalizedError, Sendable {
    public let message: String
    public var errorDescription: String? { message }
}

let log = Logger(subsystem: "com.notato.sdk", category: "Notato")

/// Notato at runtime: switch it on and off, start annotating, select an element, or annotate one from code.
///
/// Start it once, as early as the app starts, and leave it out of release builds:
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
    /// The one Notato of the app. It is `@Observable`, so a view can read its state and be drawn again as it changes.
    public static let shared = Notato()

    // ---- what the app and the overlay read ----------------------------------------------------------------------

    /// What Notato was started with, or nil before `start`.
    public private(set) var configuration: NotatoConfiguration?
    /// Whether Notato is on: its overlay showing (unless the toolbar is hidden) and its connection open.
    public private(set) var isEnabled = false
    /// Whether the floating toolbar shows. Hidden, the app can still drive Notato from code.
    public private(set) var isToolbarVisible = true
    /// Whether the next tap selects what is under it.
    public internal(set) var isAnnotating = false
    /// How Notato stands with its server.
    public internal(set) var connection: NotatoConnection = .disabled
    /// The last connection problem, fit to show to a person.
    public internal(set) var connectionDetail: String?
    /// The notes Notato knows of for this project, from the server and from this device. Those read from the server's
    /// list are summaries, without their `context` and `steps`; those made here or heard of since are whole.
    public var annotations: [Annotation] { records.map(\.annotation) }
    /// Notes made on this device that have not reached the server yet.
    public var pendingCount: Int { records.lazy.filter(\.pending).count }

    /// Every note, in the order they came. Changed only by `insert` and `forget`, which keep the index by id
    /// (`record(_:)`) and `generation` in step with it.
    private(set) var records: [NoteRecord] = []
    /// Moves on whenever a note is added or forgotten: what is worked out from the notes (`notes(onRoute:)`) is kept
    /// until it does.
    private(set) var generation = 0
    /// What the person chose on the device, over the configuration.
    var state = RuntimeState(remember: true)
    /// Whether the server takes screenshots: one that has them off wins over the configuration.
    var serverScreenshots = true
    /// Why the configuration cannot be used, when it cannot: Notato stays off.
    var problem: String?

    /// Where this project's notes not sent yet are kept.
    @ObservationIgnored var store: LocalStore?
    @ObservationIgnored var client: NotatoClient?
    /// Reads the server's event stream while Notato is on (`restartSync`).
    @ObservationIgnored var syncTask: Task<Void, Never>?
    /// When Notato started: the log a note carries goes back to here.
    @ObservationIgnored var started = Date()
    /// The overlay, while Notato is on (none without UIKit).
    @ObservationIgnored var platform: PlatformHooks?
    /// The notes kept on the device have been read in.
    @ObservationIgnored private var loaded = false
    /// Notes deleted here while a copy was on its way to the server: the server's word of them is not taken back in.
    @ObservationIgnored private var deletedHere: Set<String> = []
    /// `records` by id.
    @ObservationIgnored private var byId: [String: NoteRecord] = [:]
    /// The notes on each screen, as of a `generation`.
    @ObservationIgnored private var screens: (generation: Int, notes: [String: ScreenNotes])?

    /// What `environment.platform` says on notes made here.
    static let platformName = "ios"

    private init() {}

    /// A Notato of its own with nothing running (no overlay, no connection, nothing remembered on the device): for
    /// tests, which must not touch `shared`'s server or the app's settings.
    init(configuration: NotatoConfiguration) {
        self.configuration = configuration
        state = RuntimeState(remember: false)
    }

    var mode: NotatoMode { configuration?.mode ?? .dev }
    /// The server: one typed into Settings, else the configured one.
    var server: URL? {
        if let override = state.server { return URL(string: override) }
        return configuration?.resolvedServer
    }
    /// Whether notes go to a server as they are made. In test mode a server only receives packages.
    var hasServer: Bool { server != nil && mode != .test }
    var authorName: String? { state.author ?? configuration?.author }
    var screenshotsWanted: Bool { state.screenshots ?? configuration?.screenshots ?? true }
    var screenshotsOn: Bool { screenshotsWanted && serverScreenshots }
    /// Whether the pins show: `state`'s, kept apart from it, so the overlay reading it is not drawn again whenever
    /// something else is remembered (the toolbar dropped somewhere, or folded).
    private(set) var pinsVisible = true

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
        pinsVisible = state.pinsVisible ?? true
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
        pinsVisible = true
        guard let configuration else { return }
        isToolbarVisible = configuration.showToolbar
        platform?.toolbarPositionReset()
        setEnabled(configuration.enabled, remember: false)
        restartSync()
    }

    /// Shows the floating toolbar. Remembered like `enable()`.
    public func showToolbar() { setToolbar(true) }

    /// Hides the floating toolbar (and stops annotating). Shaking the device, or `showToolbar()`, brings it back.
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

    /// Stops annotating, and lets go of anything selected.
    public func stopAnnotating() {
        isAnnotating = false
        platform?.clearSelection()
    }

    func togglePins() {
        pinsVisible.toggle()
        state.pinsVisible = pinsVisible
    }

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
            for (offset, record) in all.enumerated().reversed() where record.platform == platformName {
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
                do {
                    try await client.delete(id: stored.annotation.id)
                } catch {
                    log.warning("Notato could not delete a note on the server: \(error.localizedDescription, privacy: .public)")
                }
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

    // ---- the server's copies of notes -----------------------------------------------------------------------------

    /// One note from the server: an event, or the answer to something done to it.
    func upsert(_ annotation: Annotation) { merge([annotation]) }

    /// The server says a note was deleted. One still waiting to be sent from here is kept: it was made here, after.
    func deletedOnServer(_ id: String) {
        if let record = record(id), !record.pending { forget { $0 === record } }
        deletedHere.remove(id)
    }

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
        do {
            try await store?.keep(record.annotation)
        } catch {
            log.error("Notato could not keep a note's change on the device: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Asks the agent to undo a resolved note's change, with why when the person said.
    func requestRevert(_ id: String, reason: String?) async throws {
        let note = reason?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? reason : "Please undo this change."
        upsert(try await connectedClient().setStatus(id: id, status: Status.revertRequested, note: note, author: .human(authorName)).annotation)
    }

    /// Takes a revert request back: the note is resolved again.
    func cancelRevert(_ id: String) async throws {
        upsert(try await connectedClient().setStatus(id: id, status: Status.resolved, note: "Revert request taken back.", author: .human(authorName)).annotation)
    }

    /// Deletes a note, on the server too once it has it.
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

    /// What the person saved in Settings. A server typed in replaces the configured one (and gets no token) until
    /// reset; changing it forgets the notes read from the old one.
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

    /// How Notato stands with its server, in a sentence for Settings and VoiceOver.
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
    /// `notato_import_bundle` reads, and uploads it when `upload` is true and a server is set. Returns the zip's file
    /// URL. Throws `NotatoServerError` when the upload fails; the zip is written all the same.
    public func packageNotes(upload: Bool = true) async throws -> URL {
        let url = try await writePackage()
        if upload { try await uploadPackage(url) }
        return url
    }

    /// Writes this device's notes to a bundle zip in the temporary folder, and returns where.
    func writePackage() async throws -> URL {
        guard let configuration else { throw NotatoError(message: "Notato has not been started.") }
        let mine = records.filter { $0.pending || (mode == .test && $0.mine) }
        if mine.isEmpty { throw NotatoError(message: "Nothing to package yet: make at least one note.") }
        let items = mine.map { LocalAnnotation(annotation: $0.annotation, assets: $0.assets ?? [:]) }
        let (bundle, files) = BundleWriter.build(items, project: configuration.project, author: authorName,
                                                 appName: AppInfo.name(configuration), appVersion: AppInfo.version(configuration))
        let formatter = DateFormatter()
        // A file name, not a date for people: the same digits whatever the device's calendar and language.
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmm"
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("notato-\(SafeIds.folder(forProject: configuration.project))-\(formatter.string(from: Date())).zip")
        // Written to the file a screenshot at a time, each read from where it is kept, off the main actor.
        try await Task.detached { try BundleWriter.write(bundle, files: files, to: url) }.value
        return url
    }

    /// Uploads a package to the server, when one is set.
    func uploadPackage(_ url: URL) async throws {
        guard let configuration, let server else { return }
        try await client(for: server).uploadBundle(project: configuration.project, file: url)
    }
}
