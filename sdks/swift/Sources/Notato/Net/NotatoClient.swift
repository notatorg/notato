import Foundation

/// A refusal from the server, or no answer at all.
public struct NotatoServerError: LocalizedError, Sendable, Equatable {
    public var message: String
    /// 0 when the server could not be reached.
    public var status: Int

    /// The server understood and said no: sending the same thing again would fail the same way.
    public var permanent: Bool { (400..<500).contains(status) && status != 408 && status != 429 }

    /// The server will never take this note as it is (a malformed or too large one, an id it has for another): it is
    /// marked failed and the notes after it are still sent. Anything else (401, 403, an unknown project's 404, 408,
    /// 429, 5xx, no answer) is about the server or the app rather than the note, and holds the queue for a later try.
    var refusesNote: Bool { [400, 409, 413, 415, 422].contains(status) }

    public var errorDescription: String? { message }
}

/// One server-sent event.
public struct ServerSentEvent: Sendable, Equatable {
    public var event: String
    public var data: String
}

/// The Notato HTTP API (packages/server/src/http.ts): post annotations with their screenshots, read them back, follow
/// changes over server-sent events, and act on them as the person.
final class NotatoClient: Sendable {
    let base: URL
    let token: String?
    let session: URLSession

    init(base: URL, token: String?, session: URLSession = NotatoClient.sharedSession) {
        self.base = base
        self.token = token?.isEmpty == false ? token : nil
        self.session = session
    }

    /// One session for every client: a client is made on each reconnect and settings change, and a session is never
    /// let go of until it is invalidated, which cannot be done safely while an older client may still be asked.
    static let sharedSession = makeSession()

    /// A list is read in pages of this many, at most `maxPages` of them.
    static let pageSize = 500
    static let maxPages = 200

    static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        // The event stream is quiet between pings (every 15s): this is the gap allowed between bytes, not a total.
        configuration.timeoutIntervalForRequest = 60
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }

    private func url(_ path: String) -> URL {
        URL(string: base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path)!
    }

    private static func segment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? value
    }

    private func request(_ method: String, _ path: String, json: Data? = nil) -> URLRequest {
        var request = URLRequest(url: url(path))
        request.httpMethod = method
        request.timeoutInterval = 30
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let json {
            request.httpBody = json
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private func unreachable(_ error: Error) -> NotatoServerError {
        let message = (error as NSError).localizedDescription
        if (error as NSError).code == NSURLErrorAppTransportSecurityRequiresSecureConnection {
            return NotatoServerError(message: "App Transport Security blocked \(base.absoluteString). Add NSAllowsLocalNetworking to Info.plist (see the Notato Swift README).", status: 0)
        }
        return NotatoServerError(message: "Cannot reach the Notato server at \(base.absoluteString): \(message)", status: 0)
    }

    /// Sends a request, with its body from `file` when there is one (streamed from the file, not read into memory).
    private func send(_ request: URLRequest, file: URL? = nil) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            if let file {
                (data, response) = try await session.upload(for: request, fromFile: file)
            } else {
                (data, response) = try await session.data(for: request)
            }
        } catch {
            throw Self.isCancellation(error) ? CancellationError() : unreachable(error)
        }
        try Self.check(response, data)
        return data
    }

    /// The task was cancelled (a reconnect, Notato switched off), which is not the server being out of reach.
    static func isCancellation(_ error: Error) -> Bool {
        error is CancellationError || (error as? URLError)?.code == .cancelled
    }

    private static func check(_ response: URLResponse, _ data: Data) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else {
            let detail = (try? NotatoJSON.decoder.decode(ErrorBody.self, from: data))?.error
            throw NotatoServerError(message: detail ?? "The server answered \(http.statusCode).", status: http.statusCode)
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do {
            return try NotatoJSON.decoder.decode(type, from: data)
        } catch {
            throw NotatoServerError(message: "The server's answer could not be read: \(error.localizedDescription)", status: 200)
        }
    }

    func config() async throws -> ServerConfig {
        try decode(ServerConfig.self, try await send(request("GET", "/config")))
    }

    /// The multipart form the server ingests: the annotation as JSON, and each screenshot as an `asset:<id>` file.
    static func form(_ annotation: Annotation, assets: [String: Data], boundary: String) throws -> Data {
        var body = Data()
        func line(_ text: String) { body.append(Data((text + "\r\n").utf8)) }
        line("--\(boundary)")
        line("Content-Disposition: form-data; name=\"annotation\"")
        line("")
        body.append(try NotatoJSON.encoder.encode(annotation))
        line("")
        for ref in [annotation.screenshots?.full, annotation.screenshots?.crop].compactMap({ $0 }) {
            guard let bytes = assets[ref.id] else { continue }
            line("--\(boundary)")
            line("Content-Disposition: form-data; name=\"asset:\(ref.id)\"; filename=\"\(ref.id)\"")
            line("Content-Type: \(ref.mime)")
            line("")
            body.append(bytes)
            line("")
        }
        line("--\(boundary)--")
        return body
    }

    /// Sends an annotation. Safe to repeat: the server keeps the first copy of an id.
    func post(_ annotation: Annotation, assets: [String: Data]) async throws -> StoredAnnotation {
        let boundary = "notato-\(UUID().uuidString)"
        var request = request("POST", "/projects/\(Self.segment(annotation.projectId))/annotations")
        request.httpBody = try Self.form(annotation, assets: assets, boundary: boundary)
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        return try decode(StoredAnnotation.self, try await send(request))
    }

    /// Every annotation of a project, oldest first, read a page at a time: a full page says where the next one starts
    /// (`next`), and a server from before paging sends one page without it. Throws when any page cannot be had, so a
    /// list cut short is never taken for the whole of it. A `summary` asks for each note without its context and
    /// steps (`context: {}`), most of a note's size and nothing the overlay shows; a server from before it sends them
    /// whole.
    func list(project: String, summary: Bool = false) async throws -> [StoredAnnotation] {
        var items: [StoredAnnotation] = []
        var after: Int?
        for _ in 0..<Self.maxPages {
            let query = "limit=\(Self.pageSize)" + (after.map { "&afterSeq=\($0)" } ?? "") + (summary ? "&fields=summary" : "")
            let page = try decode(AnnotationList.self, try await send(request("GET", "/projects/\(Self.segment(project))/annotations?\(query)")))
            items += page.items
            guard let next = page.next else { return items }
            // A cursor that does not move on would ask for the same page for ever.
            guard next > (after ?? Int.min) else {
                throw NotatoServerError(message: "The server's list of notes did not move on from \(next).", status: 200)
            }
            after = next
        }
        throw NotatoServerError(message: "The project has more notes than Notato reads (\(Self.maxPages * Self.pageSize)).", status: 200)
    }

    func setStatus(id: String, status: String, note: String?, author: Author?) async throws -> StoredAnnotation {
        let body = try NotatoJSON.encoder.encode(StatusChange(status: status, note: note?.isEmpty == false ? note : nil, author: author))
        return try decode(StoredAnnotation.self, try await send(request("PATCH", "/annotations/\(Self.segment(id))", json: body)))
    }

    /// An aside is for the people on the thread: the server keeps it from the agent.
    func reply(id: String, text: String, author: Author?, aside: Bool = false) async throws -> StoredAnnotation {
        let body = try NotatoJSON.encoder.encode(ReplyBody(body: text, author: author, aside: aside ? true : nil))
        return try decode(StoredAnnotation.self, try await send(request("POST", "/annotations/\(Self.segment(id))/replies", json: body)))
    }

    /// Turns People only on or off. The server records the change in the thread, and refuses (403) anyone but a person.
    func setPeopleOnly(id: String, _ on: Bool, author: Author?) async throws -> StoredAnnotation {
        let body = try NotatoJSON.encoder.encode(PeopleOnlyChange(peopleOnly: on, author: author))
        return try decode(StoredAnnotation.self, try await send(request("PATCH", "/annotations/\(Self.segment(id))", json: body)))
    }

    func delete(id: String) async throws {
        _ = try await send(request("DELETE", "/annotations/\(Self.segment(id))"))
    }

    /// Tells the server how an annotate request relayed from `notato_annotate` went.
    func relayResult(requestId: String, _ result: RelayResult) async throws {
        _ = try await send(request("POST", "/relay/\(Self.segment(requestId))/result", json: try NotatoJSON.encoder.encode(result)))
    }

    /// Uploads a bundle zip, streamed from its file.
    func uploadBundle(project: String, file: URL) async throws {
        var request = request("POST", "/projects/\(Self.segment(project))/bundles")
        request.setValue("application/zip", forHTTPHeaderField: "Content-Type")
        _ = try await send(request, file: file)
    }

    /// The largest event the stream may send: far more than any note, so a stream past it is broken, and is dropped
    /// (and connected again) rather than held in memory.
    static let maxEvent = 4 << 20

    /// Follows the project's event stream until cancelled or the connection drops: `hello` first, then `created`,
    /// `updated`, `replied`, `deleted`, and (with `agent`) `annotate-request`.
    func events(project: String, agent: Bool) -> AsyncThrowingStream<ServerSentEvent, Error> {
        var stream = request("GET", "/projects/\(Self.segment(project))/events\(agent ? "?agent=1" : "")")
        stream.timeoutInterval = 60
        stream.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        let request = stream
        let session = self.session
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await session.bytes(for: request)
                    if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                        var data = Data()
                        for try await byte in bytes.prefix(4096) { data.append(byte) }
                        try Self.check(response, data)
                    }
                    var reader = ServerSentEventReader()
                    for try await byte in bytes {
                        if let event = try reader.feed(byte) { continuation.yield(event) }
                    }
                    continuation.finish()
                } catch let error as NotatoServerError {
                    continuation.finish(throwing: error)
                } catch {
                    if Self.isCancellation(error) { continuation.finish() } else { continuation.finish(throwing: self.unreachable(error)) }
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

/// The event stream a byte at a time: splits it into lines for `ServerSentEventParser`, and refuses an event longer
/// than `maxEvent`, which no server sends: the stream is dropped (and connected again) rather than kept growing in
/// memory.
struct ServerSentEventReader {
    let maxEvent: Int
    private var parser = ServerSentEventParser()
    private var line = Data()
    /// What the event so far holds, in the lines before this one.
    private var held = 0

    init(maxEvent: Int = NotatoClient.maxEvent) { self.maxEvent = maxEvent }

    mutating func feed(_ byte: UInt8) throws -> ServerSentEvent? {
        if byte == UInt8(ascii: "\n") {
            // A blank line ends the event; a comment (the keep-alive ping) is not part of one.
            if line.isEmpty { held = 0 } else if line.first != UInt8(ascii: ":") { held += line.count }
            defer { line.removeAll(keepingCapacity: line.count <= 64 << 10) }
            return parser.feed(String(decoding: line, as: UTF8.self))
        }
        if byte == UInt8(ascii: "\r") { return nil }
        guard held + line.count < maxEvent else {
            throw NotatoServerError(message: "The server's event stream sent an event larger than \(maxEvent >> 20) MB.", status: 0)
        }
        line.append(byte)
        return nil
    }
}

/// The text/event-stream format, one line at a time: `event:` and `data:` lines, a blank line ending each event.
public struct ServerSentEventParser: Sendable {
    private var type = "message"
    private var data: [String] = []

    public init() {}

    /// Returns an event when `line` (without its newline) completes one.
    public mutating func feed(_ line: String) -> ServerSentEvent? {
        if line.isEmpty {
            defer {
                type = "message"
                data = []
            }
            return data.isEmpty ? nil : ServerSentEvent(event: type, data: data.joined(separator: "\n"))
        }
        if line.hasPrefix(":") { return nil } // a comment, such as the keep-alive ping
        let field: Substring
        var value: Substring
        if let colon = line.firstIndex(of: ":") {
            field = line[..<colon]
            value = line[line.index(after: colon)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = Substring(line)
            value = ""
        }
        if field == "event" { type = String(value) } else if field == "data" { data.append(String(value)) }
        return nil
    }
}
