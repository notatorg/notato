import Foundation
import Testing
@testable import Notato

@Suite("The client against a server", .serialized)
struct ClientTests {
    /// A project of `count` notes, served `limit` at a time as the server pages them.
    static func pages(_ count: Int, paging: Bool = true) -> @Sendable (URLRequest) -> (Int, Data) {
        { request in
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let limit = query.first { $0.name == "limit" }?.value.flatMap(Int.init) ?? count
            let after = query.first { $0.name == "afterSeq" }?.value.flatMap(Int.init) ?? 0
            let seqs = Array((after + 1)...max(after + 1, count)).prefix(limit).filter { $0 <= count }
            let items = seqs.map { seq -> StoredAnnotation in
                var annotation = Fixture.annotation()
                annotation.id = String(format: "note%05d", seq)
                return StoredAnnotation(seq: seq, annotation: annotation)
            }
            let next = paging && items.count == limit ? items.last?.seq : nil
            return (200, try! NotatoJSON.encoder.encode(AnnotationList(items: items, next: next)))
        }
    }

    @Test func everyPageIsReadNotJustTheFirst500() async throws {
        let client = StubServer.client(Self.pages(1_201))
        let items = try await client.list(project: "shop-ios")
        #expect(items.count == 1_201)
        #expect(items.last?.annotation.id == "note01201", "the newest notes are there")
        #expect(StubServer.requests.map { $0.query ?? "" } == ["limit=500", "limit=500&afterSeq=500", "limit=500&afterSeq=1000"])
    }

    @Test func aServerFromBeforePagingIsReadInOne() async throws {
        let client = StubServer.client(Self.pages(30, paging: false))
        #expect(try await client.list(project: "shop-ios").count == 30)
        #expect(StubServer.requests.count == 1)
    }

    @Test func aPageThatFailsFailsTheWholeList() async {
        let pages = Self.pages(1_201)
        let client = StubServer.client { request in
            request.url?.query?.contains("afterSeq=500") == true ? (503, Data("{\"error\":\"busy\"}".utf8)) : pages(request)
        }
        await #expect(throws: NotatoServerError.self) { try await client.list(project: "shop-ios") }
    }

    @Test func aCursorThatDoesNotMoveOnIsNotFollowedForEver() async {
        let client = StubServer.client { _ in
            (200, try! NotatoJSON.encoder.encode(AnnotationList(items: [StoredAnnotation(seq: 7, annotation: Fixture.annotation())], next: 7)))
        }
        await #expect(throws: NotatoServerError.self) { try await client.list(project: "shop-ios") }
        #expect(StubServer.requests.count == 2)
    }

    @Test func theMultipartFormCarriesTheAnnotationAndEachScreenshot() throws {
        let annotation = Fixture.annotation()
        let body = try NotatoClient.form(annotation, assets: [String(repeating: "a", count: 64): Data([137, 80, 78, 71])], boundary: "B")
        let text = String(decoding: body, as: UTF8.self)
        #expect(text.hasPrefix("--B\r\nContent-Disposition: form-data; name=\"annotation\"\r\n\r\n{"))
        #expect(text.contains("name=\"asset:\(String(repeating: "a", count: 64))\""))
        #expect(!text.contains("asset:\(String(repeating: "b", count: 64))"), "a screenshot with no bytes is not sent")
        #expect(text.hasSuffix("--B--\r\n"))
    }

    @Test func aRefusalAndAnUnknownProjectComeBackWithTheServersWords() async {
        let unknown = "project \"shop-ios\" does not exist on this server: ask its admin to create it"
        let client = StubServer.client { request in
            request.url?.path.hasPrefix("/projects/shop-ios/") == true
                ? (404, try! JSONEncoder().encode(["error": unknown]))
                : (422, Data("{\"error\":\"annotation.id: ids are 1 to 128 letters, digits, _ or -\"}".utf8))
        }
        var annotation = Fixture.annotation()
        annotation.projectId = "shop-ios"
        do {
            _ = try await client.post(annotation, assets: [:])
            Issue.record("expected the server to say no")
        } catch let error as NotatoServerError {
            #expect(error.status == 404 && !error.refusesNote && error.message == unknown)
        } catch {
            Issue.record("\(error)")
        }
        annotation.projectId = "other"
        await #expect(throws: NotatoServerError(message: "annotation.id: ids are 1 to 128 letters, digits, _ or -", status: 422)) {
            try await client.post(annotation, assets: [:])
        }
    }
}

extension ClientTests {
    static func stored(_ annotation: Annotation) -> Data {
        try! NotatoJSON.encoder.encode(StoredAnnotation(seq: 3, annotation: annotation))
    }

    @Test func peopleOnlyIsTurnedOnAndOffWithAPatchAsThePerson() async throws {
        let dom = Author.human("Dom")
        let on = Fixture.annotation().settingPeopleOnly(true, by: dom)
        let client = StubServer.client { request in
            (200, Self.stored(String(decoding: StubServer.body(of: request), as: UTF8.self).contains("true") ? on : Fixture.annotation()))
        }
        #expect(try await client.setPeopleOnly(id: on.id, true, author: dom).annotation.isPeopleOnly)
        #expect(try await !client.setPeopleOnly(id: on.id, false, author: dom).annotation.isPeopleOnly)
        let sent = StubServer.received
        #expect(sent.map(\.method) == ["PATCH", "PATCH"])
        #expect(sent.allSatisfy { $0.url.path == "/annotations/\(on.id)" })
        #expect(sent.map { String(decoding: $0.body, as: UTF8.self) } == [
            #"{"author":{"kind":"human","name":"Dom"},"peopleOnly":true}"#,
            #"{"author":{"kind":"human","name":"Dom"},"peopleOnly":false}"#,
        ])
    }

    @Test func onlyAPersonMayAndTheServersWordsSaySo() async {
        let words = "only a person can turn People only on or off: it is how people keep a note from the agent"
        let client = StubServer.client { _ in (403, try! JSONEncoder().encode(["error": words])) }
        await #expect(throws: NotatoServerError(message: words, status: 403)) {
            try await client.setPeopleOnly(id: "01M471ZCEXZ4AEZHN0YP8RGVW4", true, author: .agent("claude"))
        }
    }

    @Test func anAsideIsSentAsOneAndAPlainReplyLeavesTheKeyOut() async throws {
        let client = StubServer.client { _ in (201, Self.stored(Fixture.annotation())) }
        _ = try await client.reply(id: "n1", text: "Between us: check with design first", author: .human("Dom"), aside: true)
        _ = try await client.reply(id: "n1", text: "Thanks", author: .human("Dom"))
        let sent = StubServer.received
        #expect(sent.allSatisfy { $0.method == "POST" && $0.url.path == "/annotations/n1/replies" })
        #expect(sent.map { String(decoding: $0.body, as: UTF8.self) } == [
            #"{"aside":true,"author":{"kind":"human","name":"Dom"},"body":"Between us: check with design first"}"#,
            #"{"author":{"kind":"human","name":"Dom"},"body":"Thanks"}"#,
        ])
    }
}

/// Sending and connecting, against a stubbed server: in this suite, as `StubServer` is one for all.
extension ClientTests {
    @Test func theListIsReadAsASummary() async throws {
        let client = StubServer.client(Self.pages(3))
        _ = try await client.list(project: "shop-ios", summary: true)
        #expect(StubServer.requests.map { $0.query ?? "" } == ["limit=500&fields=summary"])
    }

    @Test @MainActor func onConnectingTheNotesWaitingGoBeforeTheListIsRead() async throws {
        let notato = Fixture.notato()
        let waiting = NoteRecord(Fixture.note(7), pending: true, mine: true)
        notato.insert([waiting])
        let listed = Fixture.note(8)
        notato.client = StubServer.client { request in
            switch (request.httpMethod ?? "GET", request.url!.path) {
            case ("POST", _): return (201, Self.stored(Fixture.note(7)))
            default:
                var summary = listed
                summary.context = [:]
                return (200, try! NotatoJSON.encoder.encode(AnnotationList(items: [StoredAnnotation(seq: 1, annotation: Fixture.note(7)),
                                                                                  StoredAnnotation(seq: 2, annotation: summary)], next: nil)))
            }
        }
        // What the server allows was asked before the stream was opened, not on `hello`.
        await notato.handle(ServerSentEvent(event: "hello", data: "{}"), client: notato.client!)
        #expect(Self.seen() == [
            "POST /projects/swift-sample/annotations",
            "GET /projects/swift-sample/annotations?limit=500&fields=summary",
        ])
        #expect(!waiting.pending)
        #expect(notato.records.map(\.id) == ["note00007", "note00008"], "the waiting note is not forgotten: it was sent first")
    }

    @Test @MainActor func aNewerCopyFromAnEventWinsOverTheAnswerToTheSend() async throws {
        let notato = Fixture.notato()
        let record = NoteRecord(Fixture.note(3), pending: true, mine: true)
        notato.insert([record])
        var acknowledged = Fixture.note(3)
        acknowledged.status = Status.acknowledged
        let newer = acknowledged
        notato.client = StubServer.client { _ in
            // While the POST is on its way the agent acknowledges the note, and the event for it lands first.
            DispatchQueue.main.sync { MainActor.assumeIsolated { notato.upsert(newer) } }
            return (201, Self.stored(Fixture.note(3)))
        }
        #expect(await notato.send(record) == .sent)
        #expect(!record.pending)
        #expect(record.annotation.status == Status.acknowledged, "the answer's older copy does not overwrite it")

        // With no event, the answer's copy is taken.
        let second = NoteRecord(Fixture.note(4), pending: true, mine: true)
        notato.insert([second])
        var stored = Fixture.note(4)
        stored.thread = [Reply(id: "r1", author: .agent("claude"), body: "On it", createdAt: stored.createdAt)]
        let answer = stored
        notato.client = StubServer.client { _ in (201, Self.stored(answer)) }
        #expect(await notato.send(second) == .sent)
        #expect(second.annotation.thread.count == 1)
    }

    @Test @MainActor func theTokenGoesOnlyToTheServerItWasConfiguredFor() {
        var configuration = NotatoConfiguration(project: "shop-ios", server: URL(string: "http://notato.example:4747"))
        configuration.token = "notato_secret"
        for (server, gets) in [("http://notato.example:4747", true), ("http://NOTATO.example:4747/", true),
                               ("https://notato.example:4747", false), ("http://notato.example", false),
                               ("http://notato.example:4748", false), ("http://evil.example:4747", false),
                               ("http://notato.example.evil.example:4747", false)] {
            #expect((Notato.token(for: URL(string: server)!, configuration: configuration) != nil) == gets, "\(server)")
        }
        var https = NotatoConfiguration(project: "shop-ios", server: URL(string: "https://notato.example"))
        https.token = "notato_secret"
        #expect(Notato.token(for: URL(string: "https://notato.example:443/")!, configuration: https) == "notato_secret", "the scheme's own port")
        let local = NotatoConfiguration(project: "shop-ios")
        #expect(Notato.token(for: NotatoConfiguration.defaultServer, configuration: local) == nil, "no token, none sent")

        // The clients Notato makes: the configured server's has the token, one typed into Settings has none.
        let notato = Notato(configuration: configuration)
        #expect(notato.client(for: URL(string: "http://notato.example:4747")!).token == "notato_secret")
        #expect(notato.client(for: URL(string: "http://typed.example:4747")!).token == nil)
    }

    @Test func aCancelledRequestIsACancellationNotAnUnreachableServer() {
        #expect(NotatoClient.isCancellation(URLError(.cancelled)))
        #expect(NotatoClient.isCancellation(CancellationError()))
        #expect(!NotatoClient.isCancellation(URLError(.cannotConnectToHost)))
    }
}

/// What the server allows (`/config`), asked before anything is captured or sent: in this suite, as `StubServer` is one
/// for all.
extension ClientTests {
    /// The requests the stub has had, as `GET /path?query`.
    static func seen() -> [String] {
        StubServer.received.map { "\($0.method) \($0.url.path)\($0.url.query.map { "?\($0)" } ?? "")" }
    }

    /// A stub that answers `/config` with `config` and takes every note.
    static func server(config: @escaping @Sendable () -> (Int, String)) -> NotatoClient {
        StubServer.client { request in
            if request.url?.path == "/config" {
                let (status, body) = config()
                return (status, Data(body.utf8))
            }
            return (201, Self.stored(Fixture.note(7)))
        }
    }

    @Test @MainActor func noScreenshotIsTakenUntilTheServerHasSaidItTakesThem() async throws {
        let notato = Fixture.notato()
        #expect(!notato.screenshotsOn, "not asked yet")
        let answer = Answer("{\"screenshots\":true,\"derivedScreenshots\":true}")
        notato.client = Self.server { answer.now }
        try await notato.readPolicy(notato.client!)
        #expect(Self.seen() == ["GET /config?project=swift-sample"], "asked for the project")
        #expect(notato.screenshotsOn && notato.serverDerivedScreenshots && !notato.captureOnly)

        // It cannot be asked again: what it said no longer counts.
        answer.now = (503, "{\"error\":\"busy\"}")
        await #expect(throws: NotatoServerError.self) { try await notato.readPolicy(notato.client!) }
        #expect(!notato.screenshotsOn && notato.serverPolicy?.screenshots == nil)
        answer.now = (200, "{\"screenshots\":false}")
        try await notato.readPolicy(notato.client!)
        #expect(!notato.screenshotsOn && notato.serverPolicy?.screenshots == false)
        answer.now = (200, "{}")
        try await notato.readPolicy(notato.client!)
        #expect(!notato.screenshotsOn, "an answer that does not say so is not a yes")

        // What one server said says nothing of another, typed into Settings.
        answer.now = (200, "{\"screenshots\":true}")
        try await notato.readPolicy(notato.client!)
        notato.state.server = "http://typed.test"
        #expect(notato.serverPolicy == nil && !notato.screenshotsOn)
    }

    @Test @MainActor func testModeAsksTooAndWithNoServerNothingStopsScreenshots() async throws {
        let tester = Notato(configuration: NotatoConfiguration(project: "swift-sample", mode: .test, server: URL(string: "http://stub.test")))
        #expect(tester.hasServer && !tester.screenshotsOn, "a configured Test server receives the live testing session and decides about screenshots too")
        tester.client = Self.server { (200, "{\"screenshots\":true}") }
        await tester.refreshPolicy()
        #expect(tester.screenshotsOn)
        #expect(Notato(configuration: NotatoConfiguration(project: "swift-sample", mode: .test)).screenshotsOn, "no server")
        var offline = NotatoConfiguration(project: "swift-sample")
        offline.noServer = true
        #expect(Notato(configuration: offline).screenshotsOn)
    }

    @Test @MainActor func theServerIsAskedOnceForABurstOfPictures() async {
        let notato = Fixture.notato()
        notato.client = Self.server { (200, "{\"screenshots\":true}") }
        for _ in 0..<3 { await notato.refreshPolicy() }
        #expect(Self.seen() == ["GET /config?project=swift-sample"])
        #expect(notato.screenshotsOn)
    }

    @Test @MainActor func aCaptureOnlyTokenSendsWhatWaitsAndReadsNothingBack() async throws {
        let notato = Fixture.notato()
        let waiting = NoteRecord(Fixture.note(7), pending: true, mine: true)
        notato.insert([waiting])
        notato.client = Self.server { (200, "{\"screenshots\":true,\"captureOnly\":true}") }
        try await notato.readPolicy(notato.client!)
        #expect(notato.captureOnly)
        let sending = Task { try await notato.sendOnly(every: .seconds(60)) }
        for _ in 0..<100 where waiting.pending { try await Task.sleep(for: .milliseconds(20)) }
        sending.cancel()
        await #expect(throws: CancellationError.self) { try await sending.value }
        #expect(!waiting.pending)
        #expect(Self.seen() == ["GET /config?project=swift-sample", "POST /projects/swift-sample/annotations"], "no stream, no list")
    }

    @Test @MainActor func aCaptureOnlyTokensHeldNoteStopsItAsAStreamDroppingWould() async throws {
        let notato = Fixture.notato()
        let waiting = NoteRecord(Fixture.note(7), pending: true, mine: true)
        notato.insert([waiting])
        notato.client = StubServer.client { request in
            request.url?.path == "/config" ? (200, Data("{\"captureOnly\":true}".utf8)) : (503, Data("{\"error\":\"busy\"}".utf8))
        }
        try await notato.readPolicy(notato.client!)
        await #expect(throws: NotatoServerError(message: "busy", status: 503)) { try await notato.sendOnly() }
        #expect(waiting.pending && waiting.error == nil, "still queued, not refused")
    }

    @Test @MainActor func aCaptureOnlyTokenKeepsAConflictWithoutAssumingDelivery() async throws {
        let notato = Fixture.notato()
        let resent = NoteRecord(Fixture.note(7), pending: true, mine: true)
        notato.insert([resent])
        notato.client = StubServer.client { request in
            request.url?.path == "/config" ? (200, Data("{\"captureOnly\":true}".utf8)) : (409, Data("{\"error\":\"annotation id already exists\"}".utf8))
        }
        try await notato.readPolicy(notato.client!)
        #expect(await notato.send(resent) == .refused("annotation id already exists"))
        #expect(resent.pending && resent.error != nil)

        // With any other token the server sends its copy back for an id it has: a 409 is a refusal.
        let other = NoteRecord(Fixture.note(8), pending: true, mine: true)
        notato.insert([other])
        notato.policy?.captureOnly = false
        #expect(await notato.send(other) == .refused("annotation id already exists"))
    }

    @Test @MainActor func aPackageLeavesScreenshotsOutUnlessTheServerTakesThem() async throws {
        let tester = Notato(configuration: NotatoConfiguration(project: "swift-sample", mode: .test, server: URL(string: "http://stub.test")))
        let shot = String(repeating: "a", count: 64)
        tester.insert([NoteRecord(Fixture.note(7), pending: true, mine: true, assets: [shot: .bytes(Data([137, 80, 78, 71]))])])
        let answer = Answer("{\"screenshots\":false}")
        tester.client = Self.server { answer.now }
        // Stored uncompressed, so the names and the JSON can be looked for in the zip's bytes.
        let off = try await tester.writePackage()
        let without = try Data(contentsOf: off)
        try? FileManager.default.removeItem(at: off)
        #expect(without.range(of: Data("shots/".utf8)) == nil && without.range(of: Data("\"screenshots\"".utf8)) == nil)

        answer.now = (200, "{\"screenshots\":true}")
        tester.policyAsked = nil
        let on = try await tester.writePackage()
        defer { try? FileManager.default.removeItem(at: on) }
        #expect(try Data(contentsOf: on).range(of: Data("shots/01-full.png".utf8)) != nil)

        // A capture-only token may send the captured notes as a package too.
        answer.now = (200, "{\"screenshots\":true,\"captureOnly\":true}")
        tester.policyAsked = nil
        #expect(try await tester.uploadPackage(on) == true)
        #expect(Self.seen().contains { $0.hasPrefix("POST") }, "\(Self.seen())")
    }
}

/// A stub's answer, changed as a test goes on.
final class Answer: @unchecked Sendable {
    private let lock = NSLock()
    private var answer: (Int, String)

    init(_ body: String) { answer = (200, body) }

    var now: (Int, String) {
        get { lock.withLock { answer } }
        set { lock.withLock { answer = newValue } }
    }
}
