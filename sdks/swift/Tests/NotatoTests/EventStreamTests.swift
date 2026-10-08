import Foundation
import Testing
@testable import Notato

@Suite("The event stream")
struct EventStreamTests {
    @Test func serverSentEventsSplitOnBlankLinesAndSkipComments() {
        var parser = ServerSentEventParser()
        let lines = ["event: hello", "data: {\"projectId\":\"p\"}", "", ": ping", "", "event: updated", "data: {\"a\":1,", "data: \"b\":2}", "", "data: plain", ""]
        let events = lines.compactMap { parser.feed($0) }
        #expect(events == [ServerSentEvent(event: "hello", data: "{\"projectId\":\"p\"}"),
                           ServerSentEvent(event: "updated", data: "{\"a\":1,\n\"b\":2}"),
                           ServerSentEvent(event: "message", data: "plain")])
    }

    private func feed(_ text: String, into reader: inout ServerSentEventReader) throws -> [ServerSentEvent] {
        try Data(text.utf8).compactMap { try reader.feed($0) }
    }

    @Test func eventsAreReadAByteAtATime() throws {
        var reader = ServerSentEventReader()
        let events = try feed(": ping\n\nevent: hello\r\ndata: {}\r\n\r\nevent: created\ndata: {\"a\":\ndata: 1}\n\n", into: &reader)
        #expect(events == [ServerSentEvent(event: "hello", data: "{}"), ServerSentEvent(event: "created", data: "{\"a\":\n1}")])
    }

    @Test func anEventPastTheLimitDropsTheStreamRatherThanGrowing() throws {
        var reader = ServerSentEventReader(maxEvent: 64)
        #expect(throws: NotatoServerError.self) { _ = try feed("data: " + String(repeating: "x", count: 100), into: &reader) }
        // Many lines of one event count together; pings between events do not.
        var lines = ServerSentEventReader(maxEvent: 64)
        #expect(throws: NotatoServerError.self) { _ = try feed(String(repeating: "data: 0123456789\n", count: 8), into: &lines) }
        var pings = ServerSentEventReader(maxEvent: 64)
        #expect(try feed(String(repeating: ": ping\n", count: 100) + "data: ok\n\n", into: &pings).map(\.data) == ["ok"])
        #expect(NotatoClient.maxEvent == 4 << 20)
    }
}
