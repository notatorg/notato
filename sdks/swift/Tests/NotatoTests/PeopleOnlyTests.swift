import Foundation
import Testing
@testable import Notato

@Suite("People only and asides")
struct PeopleOnlyTests {
    private let dom = Author.human("Dom")
    private let at = Date(timeIntervalSince1970: 1_791_360_000)

    private func object(_ value: some Encodable) throws -> [String: Any] {
        try #require(try JSONSerialization.jsonObject(with: NotatoJSON.encoder.encode(value)) as? [String: Any])
    }

    @Test func turningPeopleOnlyOnSetsTheFlagAndRecordsItAsTheServerDoes() throws {
        let on = Fixture.annotation().settingPeopleOnly(true, by: dom, at: at)
        #expect(on.peopleOnly == true)
        let entry = try #require(on.thread.last)
        #expect(on.thread.count == 1)
        #expect(entry.author == dom)
        #expect(entry.automatic == true && entry.peopleOnly == true && entry.aside == nil)
        #expect(entry.body == "Made this people only: the agent won't see it.")
        #expect(entry.createdAt == NotatoJSON.timestamp(at))
        #expect(entry.id.range(of: "^[0-9A-HJKMNP-TV-Z]{26}$", options: .regularExpression) != nil)
        #expect(try object(on)["peopleOnly"] as? Bool == true)
        let written = try #require((try object(on)["thread"] as? [[String: Any]])?.first)
        #expect(written["automatic"] as? Bool == true && written["peopleOnly"] as? Bool == true && written["aside"] == nil)
    }

    @Test func turningItOffLeavesTheKeyOutAndRecordsThatToo() throws {
        let off = Fixture.annotation().settingPeopleOnly(true, by: dom, at: at).settingPeopleOnly(false, by: dom, at: at.addingTimeInterval(60))
        #expect(off.peopleOnly == nil)
        #expect(off.thread.map(\.peopleOnly) == [true, false])
        #expect(off.thread.map(\.body) == ["Made this people only: the agent won't see it.", "Shared this with the agent."])
        #expect(try object(off)["peopleOnly"] == nil, "off is not written, as the server leaves it out")
        let entries = try #require(try object(off)["thread"] as? [[String: Any]])
        #expect(entries[1]["peopleOnly"] as? Bool == false, "but the entry for turning it off says false")
    }

    @Test func settingItTheWayItIsChangesNothing() {
        let note = Fixture.annotation()
        #expect(note.settingPeopleOnly(false, by: dom) == note)
        let on = note.settingPeopleOnly(true, by: dom)
        #expect(on.settingPeopleOnly(true, by: dom) == on)
    }

    @Test func isPeopleOnlyNeverWritesFalse() throws {
        var note = Fixture.annotation()
        #expect(try object(note)["peopleOnly"] == nil)
        note.isPeopleOnly = true
        #expect(note.peopleOnly == true)
        #expect(try object(note)["peopleOnly"] as? Bool == true)
        note.isPeopleOnly = false
        #expect(note.peopleOnly == nil)
        #expect(try object(note)["peopleOnly"] == nil)
    }

    @Test func aReplyWritesAsideOnlyWhenItIsOne() throws {
        let plain = Reply(id: "01M471ZCEXZ4AEZHN0YP8RGVW4", author: dom, body: "Thanks", createdAt: "2026-10-07T08:00:00.000Z")
        #expect(Set(try object(plain).keys) == ["id", "author", "body", "createdAt"])
        var aside = plain
        aside.aside = true
        #expect(try object(aside)["aside"] as? Bool == true)
    }

    @Test func whatTheServerWritesReadsBack() throws {
        let json = #"{"id":"01M471ZCEXZ4AEZHN0YP8RGVW4","author":{"kind":"human","name":"Dom"},"body":"Shared this with the agent.","createdAt":"2026-10-07T08:00:00.000Z","automatic":true,"peopleOnly":false}"#
        let reply = try NotatoJSON.decoder.decode(Reply.self, from: Data(json.utf8))
        #expect(reply.automatic == true && reply.peopleOnly == false && reply.aside == nil)
        var text = String(decoding: try NotatoJSON.encoder.encode(Fixture.annotation()), as: UTF8.self)
        text = text.replacingOccurrences(of: "\"thread\":[]", with: "\"peopleOnly\":true,\"thread\":[{\"id\":\"r1\",\"author\":{\"kind\":\"human\"},\"body\":\"psst\",\"createdAt\":\"2026-10-07T08:00:00.000Z\",\"aside\":true}]")
        let note = try NotatoJSON.decoder.decode(Annotation.self, from: Data(text.utf8))
        #expect(note.isPeopleOnly)
        #expect(note.thread.first?.aside == true)
    }

    @Test func aNewNoteSentPeopleOnlySaysSoInTheForm() throws {
        var note = Fixture.annotation()
        note.isPeopleOnly = true
        let text = String(decoding: try NotatoClient.form(note, assets: [:], boundary: "B"), as: UTF8.self)
        #expect(text.contains("\"peopleOnly\":true"))
    }

    @Test func aPeopleOnlyNoteWithAnAsideAndItsHistoryPassesTheServersSchema() throws {
        var note = Fixture.annotation().settingPeopleOnly(true, by: dom, at: at)
        note.thread.append(Reply(id: ULID.make(at: at), author: dom, body: "Between us: check with design first.", createdAt: NotatoJSON.timestamp(at), aside: true))
        note = note.settingPeopleOnly(false, by: dom, at: at.addingTimeInterval(60))
        guard let result = try Fixture.validate("annotation", try NotatoJSON.encoder.encode(note)) else { return }
        #expect(result.ok, "\(result.output)")
        note.isPeopleOnly = true
        #expect(try Fixture.validate("annotation", try NotatoJSON.encoder.encode(note))?.ok == true)
    }

    @Test func aPackageCarriesPeopleOnlyAndItsHistory() throws {
        let note = Fixture.annotation().settingPeopleOnly(true, by: dom, at: at)
        let (bundle, _) = BundleWriter.build([LocalAnnotation(annotation: note, assets: [:])], project: "swift-sample", author: "Dom",
                                             appName: "Sample", appVersion: "1.0")
        #expect(bundle.annotations[0].isPeopleOnly)
        #expect(bundle.annotations[0].thread.map(\.peopleOnly) == [true])
        if let result = try Fixture.validate("bundle", try NotatoJSON.encoder.encode(bundle)) { #expect(result.ok, "\(result.output)") }
    }
}

/// `Notato.setPeopleOnly` where no server is needed: a note this device has not sent yet.
@Suite("People only on the device")
@MainActor
struct PeopleOnlyOnTheDeviceTests {
    private func note(pending: Bool) -> NoteRecord {
        var annotation = Fixture.annotation()
        annotation.id = ULID.make()
        let record = NoteRecord(annotation, pending: pending, mine: true)
        Notato.shared.insert([record])
        return record
    }

    private func forget(_ record: NoteRecord) { Notato.shared.forget { $0 === record } }

    @Test func aNoteNotSentYetIsChangedHereWithTheSameEntryTheServerWrites() async throws {
        let record = note(pending: true)
        defer { forget(record) }
        try await Notato.shared.setPeopleOnly(record.id, true)
        #expect(record.annotation.isPeopleOnly)
        let entry = try #require(record.annotation.thread.last)
        #expect(entry.automatic == true && entry.peopleOnly == true && entry.author.kind == "human")
        #expect(entry.body == "Made this people only: the agent won't see it.")
        try await Notato.shared.setPeopleOnly(record.id, true)
        #expect(record.annotation.thread.count == 1, "no change, no entry")
        try await Notato.shared.setPeopleOnly(record.id, false)
        #expect(!record.annotation.isPeopleOnly)
        #expect(record.annotation.thread.map(\.peopleOnly) == [true, false])
        #expect(record.pending, "still to be sent, with the flag")
    }

    @Test func oneTheServerHasIsChangedOnlyThere() async {
        let record = note(pending: false)
        defer { forget(record) }
        await #expect(throws: NotatoError.self) { try await Notato.shared.setPeopleOnly(record.id, true) }
        #expect(!record.annotation.isPeopleOnly && record.annotation.thread.isEmpty)
    }

    @Test func oneOnItsWayToTheServerIsLeftAlone() async {
        let record = note(pending: true)
        record.sending = true
        defer { forget(record) }
        await #expect(throws: NotatoError.self) { try await Notato.shared.setPeopleOnly(record.id, true) }
        #expect(!record.annotation.isPeopleOnly && record.annotation.thread.isEmpty)
    }
}
