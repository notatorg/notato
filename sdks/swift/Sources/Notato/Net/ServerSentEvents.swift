import Foundation

/// One server-sent event: its type, and its data lines joined.
struct ServerSentEvent: Sendable, Equatable {
    var event: String
    var data: String
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
struct ServerSentEventParser: Sendable {
    private var type = "message"
    private var data: [String] = []

    /// Returns an event when `line` (without its newline) completes one.
    mutating func feed(_ line: String) -> ServerSentEvent? {
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
