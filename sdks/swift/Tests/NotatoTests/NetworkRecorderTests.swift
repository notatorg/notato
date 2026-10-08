import Foundation
import Testing
@testable import Notato

@Suite("Recording the app's requests", .serialized)
struct NetworkRecorderTests {
    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RelayNetwork.self]
        NotatoNetworkRecorder.useRelay(NotatoNetworkRecorder.Relay(configuration: configuration))
    }

    private func recorded(_ path: String) -> [NetworkEntry] {
        NotatoNetworkRecorder.snapshot().filter { $0.url == "http://app.test\(path)" }
    }

    @Test func theBodyReachesTheAppAPieceAtATimeAndTheRequestIsRecorded() async {
        let app = AppSessionDelegate()
        let (response, body, error) = await app.load("/stream")
        #expect(error == nil && response?.statusCode == 200)
        #expect(body == "one two three")
        #expect(recorded("/stream").last?.status == 200, "recorded, without its query")
    }

    @Test func aRedirectIsTheAppsSessionsToFollow() async {
        let app = AppSessionDelegate()
        let (response, body, error) = await app.load("/old")
        #expect(app.redirects == ["/new"], "the app's delegate was asked")
        #expect(error == nil && response?.statusCode == 200 && body == "arrived")
        #expect(recorded("/old").last?.status == 302 && recorded("/new").last?.status == 200)
    }

    @Test func aRedirectTheAppRefusesIsNotFollowed() async {
        let app = AppSessionDelegate(follow: false)
        let (response, body, error) = await app.load("/old")
        #expect(app.redirects == ["/new"])
        #expect(error == nil && response?.statusCode == 302 && body == "moved", "the redirect's own answer, as without Notato")
    }

    @Test func aChallengeIsTheAppsSessionsToAnswer() async {
        let app = AppSessionDelegate()
        let (response, body, error) = await app.load("/private")
        #expect(app.challenges == ["shop"], "the app's delegate was asked")
        #expect(error == nil && response?.statusCode == 200 && body == "welcome dom")
    }

    /// A real server's event stream never ends: the app sees its first event only if each piece is handed on as it
    /// comes (a stub's pieces are handed over together, so this needs a server).
    @Test(.enabled(if: LiveServer.url != nil))
    func aStreamThatNeverEndsReachesTheAppAsItComes() async throws {
        NotatoNetworkRecorder.useRelay(NotatoNetworkRecorder.Relay(configuration: .ephemeral))
        let app = AppSessionDelegate()
        let (session, task) = app.start(LiveServer.url!.appendingPathComponent("projects/swift-recorder/events"))
        defer { session.invalidateAndCancel() }
        for _ in 0..<50 where app.pieces.isEmpty { try await Task.sleep(nanoseconds: 100_000_000) }
        #expect(String(decoding: app.pieces.reduce(Data(), +), as: UTF8.self).hasPrefix("event: hello"))
        #expect(task.state == .running, "still going")
    }

    @Test func uploadTasksAndSocketsAreLeftToTheNetwork() {
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let request = URLRequest(url: URL(string: "http://app.test/upload")!)
        #expect(NotatoNetworkRecorder.canInit(with: session.dataTask(with: request)))
        #expect(!NotatoNetworkRecorder.canInit(with: session.uploadTask(with: request, from: Data([1]))))
        #expect(!NotatoNetworkRecorder.canInit(with: session.webSocketTask(with: URL(string: "ws://app.test/live")!)))
        #expect(!NotatoNetworkRecorder.canInit(with: URLRequest(url: URL(string: "ftp://app.test/file")!)))
    }
}
