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
            case ("GET", "/config"): return (200, Data("{}".utf8))
            default:
                var summary = listed
                summary.context = [:]
                return (200, try! NotatoJSON.encoder.encode(AnnotationList(items: [StoredAnnotation(seq: 1, annotation: Fixture.note(7)),
                                                                                  StoredAnnotation(seq: 2, annotation: summary)], next: nil)))
            }
        }
        await notato.handle(ServerSentEvent(event: "hello", data: "{}"), client: notato.client!)
        #expect(StubServer.received.map { "\($0.method) \($0.url.path)\($0.url.query.map { "?\($0)" } ?? "")" } == [
            "GET /config",
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
        configuration.token = "pft_secret"
        for (server, gets) in [("http://notato.example:4747", true), ("http://NOTATO.example:4747/", true),
                               ("https://notato.example:4747", false), ("http://notato.example", false),
                               ("http://notato.example:4748", false), ("http://evil.example:4747", false),
                               ("http://notato.example.evil.example:4747", false)] {
            #expect((Notato.token(for: URL(string: server)!, configuration: configuration) != nil) == gets, "\(server)")
        }
        var https = NotatoConfiguration(project: "shop-ios", server: URL(string: "https://notato.example"))
        https.token = "pft_secret"
        #expect(Notato.token(for: URL(string: "https://notato.example:443/")!, configuration: https) == "pft_secret", "the scheme's own port")
        let local = NotatoConfiguration(project: "shop-ios")
        #expect(Notato.token(for: NotatoConfiguration.defaultServer, configuration: local) == nil, "no token, none sent")

        // The clients Notato makes: the configured server's has the token, one typed into Settings has none.
        let notato = Notato(configuration: configuration)
        #expect(notato.client(for: URL(string: "http://notato.example:4747")!).token == "pft_secret")
        #expect(notato.client(for: URL(string: "http://typed.example:4747")!).token == nil)
    }

    @Test func aCancelledRequestIsACancellationNotAnUnreachableServer() {
        #expect(NotatoClient.isCancellation(URLError(.cancelled)))
        #expect(NotatoClient.isCancellation(CancellationError()))
        #expect(!NotatoClient.isCancellation(URLError(.cannotConnectToHost)))
    }
}
