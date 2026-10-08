import Foundation
import Testing
@testable import Notato

@Suite("Against a real server", .serialized, .enabled(if: LiveServer.url != nil))
struct LiveServerTests {
    static var server: URL? { LiveServer.url }

    private func note(project: String) -> Annotation {
        var annotation = Fixture.annotation()
        annotation.id = ULID.make()
        annotation.projectId = project
        annotation.screenshots = nil
        return annotation
    }

    @Test func theListIsASummaryAndAPackageGoesUpFromItsFile() async throws {
        let project = "swift-live-\(UUID().uuidString.prefix(8).lowercased())"
        let client = NotatoClient(base: Self.server!, token: nil)
        let sent = note(project: project)
        _ = try await client.post(sent, assets: [:])
        let summary = try await client.list(project: project, summary: true)
        #expect(summary.map(\.annotation.id) == [sent.id])
        #expect(summary.first?.annotation.context.isEmpty == true && summary.first?.annotation.steps == nil, "no context, no steps")
        #expect(summary.first?.annotation.comment == sent.comment && summary.first?.annotation.target == sent.target)
        #expect(try await client.list(project: project).first?.annotation.context.isEmpty == false, "asked whole, it is whole")

        let packaged = note(project: project)
        let (bundle, files) = BundleWriter.build([LocalAnnotation(annotation: packaged, assets: [:])], project: project, author: "Dom",
                                                 appName: "Sample", appVersion: "1.0")
        let zip = FileManager.default.temporaryDirectory.appendingPathComponent("notato-live-\(UUID().uuidString).zip")
        defer { try? FileManager.default.removeItem(at: zip) }
        try BundleWriter.write(bundle, files: files, to: zip)
        try await client.uploadBundle(project: project, file: zip)
        #expect(try await client.list(project: project, summary: true).map(\.annotation.id).contains(packaged.id))
    }

    @Test @MainActor func onConnectingANoteWaitingGoesFirstAndTheListKeepsItsContext() async throws {
        let project = "swift-live-\(UUID().uuidString.prefix(8).lowercased())"
        let notato = Notato(configuration: NotatoConfiguration(project: project, server: Self.server))
        let client = notato.client(for: Self.server!)
        notato.client = client
        let waiting = NoteRecord(note(project: project), pending: true, mine: true)
        notato.insert([waiting])
        let elsewhere = note(project: project)
        _ = try await client.post(elsewhere, assets: [:])
        await notato.handle(ServerSentEvent(event: "hello", data: "{}"), client: client)
        #expect(!waiting.pending)
        #expect(Set(notato.records.map(\.id)) == [waiting.id, elsewhere.id])
        #expect(waiting.annotation.context.isEmpty == false, "the list's summary did not take the context away")
    }

    @Test func theEventStreamFollowsTheProject() async throws {
        let project = "swift-live-\(UUID().uuidString.prefix(8).lowercased())"
        let client = NotatoClient(base: Self.server!, token: nil)
        var seen: [String] = []
        for try await event in client.events(project: project, agent: false) {
            seen.append(event.event)
            if event.event == "hello" { _ = try await client.post(note(project: project), assets: [:]) }
            if event.event == "created" { break }
        }
        #expect(seen == ["hello", "created"])
    }
}
