import Foundation
import OSLog

/// The app's recent log messages, read back from the unified log (its own `Logger` / `os_log` entries), attached to
/// each note as `context.console` in the web SDK's shape. Nothing is hooked: the system keeps the log already.
enum LogRecorder {
    /// Entries from this process since `since`, newest last, at most `limit`, without the system's own subsystems.
    ///
    /// The store is asked to leave out what it can itself (Apple's subsystems and Notato's, anything before `since`),
    /// which is most of what a process logs, and to read from the newest back, which would let the reading stop at
    /// `limit`. Where it reads from the oldest whatever it is asked (macOS 27 and iOS 26 both do), only the last
    /// `limit` are kept on the way through.
    static func recent(limit: Int, since: Date) -> [LogEntry] {
        guard limit > 0, let store = try? OSLogStore(scope: .currentProcessIdentifier) else { return [] }
        // The log's clock runs a little behind `Date()`: an entry written just after `since` can be dated just before
        // it. A second's margin keeps those, and takes nothing that matters from before Notato started.
        let since = since.addingTimeInterval(-1)
        let predicate = NSPredicate(format: "date >= %@ AND NOT (subsystem BEGINSWITH %@) AND subsystem != %@",
                                    since as NSDate, "com.apple.", Self.ownSubsystem)
        // A store that cannot take the predicate is read whole; `describe` leaves out the same either way.
        guard let entries = (try? store.getEntries(with: [.reverse], matching: predicate)) ?? (try? store.getEntries(with: [.reverse])) else {
            return []
        }
        let executable = ProcessInfo.processInfo.processName
        return last(limit, of: entries.lazy.compactMap { $0 as? OSLogEntryLog }, since: since, date: \.date) {
            describe($0, executable: executable)
        }
    }

    static let ownSubsystem = "com.notato.sdk"

    /// The last `limit` of `entries` that `keep` keeps (it describes each, or says nil), oldest first. Which way the
    /// entries come is told from their dates: newest first, it stops at `limit` (or at `since`); oldest first, it goes
    /// through them all keeping only the last `limit`.
    static func last<S: Sequence>(_ limit: Int, of entries: S, since: Date, date: (S.Element) -> Date,
                                  keep: (S.Element) -> LogEntry?) -> [LogEntry] {
        guard limit > 0 else { return [] }
        var kept = Ring<LogEntry>(capacity: limit)
        var newestFirst: Bool?
        var firstDate: Date?
        for entry in entries {
            let when = date(entry)
            if newestFirst == nil {
                if let firstDate {
                    if when != firstDate { newestFirst = when < firstDate }
                } else {
                    firstDate = when
                }
            }
            if when < since {
                if newestFirst == true { break }
                continue
            }
            guard let item = keep(entry) else { continue }
            kept.append(item)
            if newestFirst == true, kept.count == limit { break }
        }
        return newestFirst == true ? kept.inOrder.reversed() : kept.inOrder
    }

    /// One entry as a note carries it, or nil when it is not the app's own: Apple's frameworks log plenty in-process,
    /// some with no subsystem at all, so only what the app's code logged (its executable, or a subsystem of its own) is
    /// kept, which is what explains a bug. Debug messages are left out.
    private static func describe(_ entry: OSLogEntryLog, executable: String) -> LogEntry? {
        let subsystem = entry.subsystem
        if subsystem.hasPrefix("com.apple.") || subsystem == ownSubsystem { return nil }
        if subsystem.isEmpty && entry.sender != executable { return nil }
        let level: String
        switch entry.level {
        case .debug: return nil
        case .error, .fault: level = "error"
        case .notice: level = "warn"
        case .info: level = "info"
        default: level = "log"
        }
        let category = entry.category.isEmpty ? "" : "[\(entry.category)] "
        var message = category + entry.composedMessage
        if message.count > 1000 { message = String(message.prefix(999)) + "…" }
        return LogEntry(level: level, message: message, at: NotatoJSON.timestamp(entry.date))
    }
}

/// The last `capacity` things appended, without moving the rest along each time one goes.
struct Ring<Element> {
    let capacity: Int
    private var items: [Element] = []
    private var start = 0

    init(capacity: Int) {
        self.capacity = max(1, capacity)
        items.reserveCapacity(self.capacity)
    }

    var count: Int { items.count }

    mutating func append(_ item: Element) {
        if items.count < capacity {
            items.append(item)
        } else {
            items[start] = item
            start = (start + 1) % capacity
        }
    }

    /// Oldest first.
    var inOrder: [Element] { Array(items[start...] + items[..<start]) }
}

/// Records the app's HTTP requests (method, URL without its query, status, duration) for `context.network`.
/// Add it to a session the app makes: `configuration.protocolClasses = [NotatoNetworkRecorder.self] + (configuration.protocolClasses ?? [])`.
///
/// A request it records is made again through Notato's own session, which hands each part back to the app's session
/// as it comes: the response, the body a piece at a time (nothing is held back until the end), each redirect, which
/// the app's session (and its delegate) follows or not as it would have, and authentication challenges, server trust
/// (certificate pinning) included, which go to the app's session's delegate to answer. A request's body goes as it
/// was given, a stream included.
///
/// What cannot be carried over: the app's session configuration itself, as a protocol is never told which session it
/// serves. Notato's session has the system's defaults (the shared cookie store, cache and credential store), with
/// each request's own headers, timeout and cache policy. Upload tasks (`upload(for:from:)`, `upload(for:fromFile:)`),
/// whose body a protocol cannot read, and stream and web socket tasks are not recorded: they go to the network as they
/// would without it.
public final class NotatoNetworkRecorder: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var entries: [NetworkEntry] = []
    nonisolated(unsafe) private static var current: Relay?
    private static let handledKey = "NotatoNetworkRecorder.handled"

    /// The session requests are made again through, made on first use. A test sets its own (`useRelay`).
    static var relay: Relay {
        lock.withLock {
            if let current { return current }
            let made = Relay(configuration: .default)
            current = made
            return made
        }
    }

    static func useRelay(_ relay: Relay) { lock.withLock { current = relay } }

    // This load's state, under `state`: set on the loading thread, read on the relay's.
    private let state = NSLock()
    private var inner: URLSessionDataTask?
    private var started = Date()
    private var status = 0
    private var stopped = false
    private var recorded = false
    private var clientThread: Thread?
    private var clientModes: [String] = []
    private var answer: (@Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void)?

    static func snapshot() -> [NetworkEntry] {
        lock.withLock { entries }
    }

    private static func add(_ entry: NetworkEntry) {
        lock.withLock {
            entries.append(entry)
            if entries.count > 50 { entries.removeFirst(entries.count - 50) }
        }
    }

    override public class func canInit(with request: URLRequest) -> Bool {
        guard let scheme = request.url?.scheme?.lowercased(), ["http", "https"].contains(scheme) else { return false }
        return URLProtocol.property(forKey: handledKey, in: request) == nil
    }

    /// An upload task's body is given to the task, not the request, where a protocol cannot read it; streams and web
    /// sockets are not one request and one response. They are left to the network, unrecorded.
    override public class func canInit(with task: URLSessionTask) -> Bool {
        if task is URLSessionUploadTask || task is URLSessionStreamTask || task is URLSessionWebSocketTask { return false }
        guard let request = task.currentRequest ?? task.originalRequest else { return false }
        return canInit(with: request)
    }

    override public class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override public func startLoading() {
        let mutable = (request as NSURLRequest).mutableCopy() as! NSMutableURLRequest
        URLProtocol.setProperty(true, forKey: Self.handledKey, in: mutable)
        // The app's session is called back on this thread, in this run loop mode, as URLProtocol asks.
        let mode = RunLoop.current.currentMode ?? .default
        state.withLock {
            started = Date()
            clientThread = Thread.current
            clientModes = Array(Set([mode.rawValue, RunLoop.Mode.default.rawValue]))
        }
        guard let task = Self.relay.start(mutable as URLRequest, for: self) else {
            return completed(URLError(.cancelled))
        }
        state.withLock { inner = task }
    }

    override public func stopLoading() {
        let task = state.withLock {
            stopped = true
            return inner
        }
        task?.cancel()
    }

    // ---- what the relay hands back, passed to the app's session ---------------------------------------------------

    fileprivate func received(_ response: URLResponse) {
        state.withLock { status = (response as? HTTPURLResponse)?.statusCode ?? 0 }
        toClient { $0.client?.urlProtocol($0, didReceive: response, cacheStoragePolicy: .notAllowed) }
    }

    fileprivate func received(_ data: Data) {
        toClient { $0.client?.urlProtocol($0, didLoad: data) }
    }

    /// The server redirected. The app's session decides whether to follow: if it does, it stops this load and makes
    /// the new request itself (through a recorder of its own); if not, this load goes on to hand it the redirect's own
    /// response and body, as a session that does not follow a redirect gets them.
    fileprivate func redirected(to request: URLRequest, by response: HTTPURLResponse) {
        let mutable = (request as NSURLRequest).mutableCopy() as! NSMutableURLRequest
        URLProtocol.removeProperty(forKey: Self.handledKey, in: mutable)
        let next = mutable as URLRequest
        record(status: response.statusCode, failed: false)
        toClient { $0.client?.urlProtocol($0, wasRedirectedTo: next, redirectResponse: response) }
    }

    /// The server (or the connection's trust) asks who is asking: the app's session's delegate answers, through this
    /// recorder (`URLAuthenticationChallengeSender`), and the answer goes back to the relay's session.
    fileprivate func challenged(_ challenge: URLAuthenticationChallenge,
                                answer: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        state.withLock { self.answer = answer }
        let forwarded = URLAuthenticationChallenge(authenticationChallenge: challenge, sender: self)
        toClient(orElse: { answer(.cancelAuthenticationChallenge, nil) }) { $0.client?.urlProtocol($0, didReceive: forwarded) }
    }

    fileprivate func completed(_ error: Error?) {
        record(status: state.withLock { status }, failed: error != nil)
        toClient { recorder in
            if let error { recorder.client?.urlProtocol(recorder, didFailWithError: error) } else { recorder.client?.urlProtocolDidFinishLoading(recorder) }
        }
    }

    /// Adds this load to what notes carry, once: at a redirect, or when it ends.
    private func record(status: Int, failed: Bool) {
        let (started, first) = state.withLock {
            defer { recorded = true }
            return (self.started, !recorded)
        }
        guard first else { return }
        let url = request.url.map { url -> String in
            var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
            parts?.query = nil
            parts?.fragment = nil
            return parts?.string ?? url.absoluteString
        } ?? ""
        Self.add(NetworkEntry(method: request.httpMethod ?? "GET", url: url, status: failed ? 0 : status,
                              durationMs: Int(Date().timeIntervalSince(started) * 1000), at: NotatoJSON.timestamp(started)))
    }

    /// Runs `call` on the thread the load was started on, unless the load was stopped (then `orElse`, if given).
    private func toClient(orElse: (@Sendable () -> Void)? = nil, _ call: @escaping @Sendable (NotatoNetworkRecorder) -> Void) {
        let (thread, modes) = state.withLock { (clientThread, clientModes) }
        let block = ClientCall { [self] in
            if state.withLock({ stopped }) { orElse?() } else { call(self) }
        }
        guard let thread, thread != Thread.current else { return block.run() }
        perform(#selector(runCall(_:)), on: thread, with: block, waitUntilDone: false, modes: modes)
    }

    @objc private func runCall(_ call: ClientCall) { call.run() }

    /// The session recorded requests are made again through, and its delegate, which hands each task's events to the
    /// recorder it is for.
    final class Relay: NSObject, URLSessionDataDelegate, @unchecked Sendable {
        private let lock = NSLock()
        private var recorders: [Int: NotatoNetworkRecorder] = [:]
        private var session: URLSession?

        init(configuration: URLSessionConfiguration) {
            super.init()
            let queue = OperationQueue()
            queue.maxConcurrentOperationCount = 1
            queue.name = "com.notato.sdk.network"
            session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
        }

        func start(_ request: URLRequest, for recorder: NotatoNetworkRecorder) -> URLSessionDataTask? {
            guard let task = session?.dataTask(with: request) else { return nil }
            lock.withLock { recorders[task.taskIdentifier] = recorder }
            task.resume()
            return task
        }

        private func recorder(_ task: URLSessionTask) -> NotatoNetworkRecorder? {
            lock.withLock { recorders[task.taskIdentifier] }
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                        completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void) {
            recorder(dataTask)?.received(response)
            completionHandler(.allow)
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            recorder(dataTask)?.received(data)
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
            // Not followed here: the app's session is told, and follows it (or not) itself.
            recorder(task)?.redirected(to: request, by: response)
            completionHandler(nil)
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                        completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            guard let recorder = recorder(task) else { return completionHandler(.performDefaultHandling, nil) }
            recorder.challenged(challenge, answer: completionHandler)
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, needNewBodyStream completionHandler: @escaping @Sendable (InputStream?) -> Void) {
            // A stream is read once; the app's session gives a new one to a new load (a redirect it follows) itself.
            completionHandler(nil)
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            let recorder = lock.withLock { recorders.removeValue(forKey: task.taskIdentifier) }
            recorder?.completed(error)
        }
    }
}

/// The app's session's delegate answering a challenge it was handed: the answer goes back to the relay's session.
extension NotatoNetworkRecorder: URLAuthenticationChallengeSender {
    private func respond(_ disposition: URLSession.AuthChallengeDisposition, _ credential: URLCredential?) {
        let answer = state.withLock {
            defer { self.answer = nil }
            return self.answer
        }
        answer?(disposition, credential)
    }

    public func use(_ credential: URLCredential, for challenge: URLAuthenticationChallenge) { respond(.useCredential, credential) }
    public func continueWithoutCredential(for challenge: URLAuthenticationChallenge) { respond(.useCredential, nil) }
    public func cancel(_ challenge: URLAuthenticationChallenge) { respond(.cancelAuthenticationChallenge, nil) }
    public func performDefaultHandling(for challenge: URLAuthenticationChallenge) { respond(.performDefaultHandling, nil) }
    public func rejectProtectionSpaceAndContinue(with challenge: URLAuthenticationChallenge) { respond(.rejectProtectionSpace, nil) }
}

/// A call to make on the loading thread, as an object `perform(_:on:with:waitUntilDone:modes:)` can carry.
private final class ClientCall: NSObject, @unchecked Sendable {
    let run: @Sendable () -> Void
    init(_ run: @escaping @Sendable () -> Void) { self.run = run }
}
