import Foundation
import OSLog
import Testing
@testable import Notato

@Suite("The app's log")
struct LogTests {
    private struct Line {
        let date: Date
        let text: String
    }

    private let start = Date(timeIntervalSince1970: 1_791_360_000)

    private func lines(_ count: Int) -> [Line] {
        (0..<count).map { Line(date: start.addingTimeInterval(Double($0)), text: "line \($0)") }
    }

    @Test func readNewestFirstItStopsAtTheLimit() {
        var looked = 0
        let found = LogRecorder.last(5, of: lines(10_000).reversed(), since: start, date: \.date) { line in
            looked += 1
            return LogEntry(level: "info", message: line.text, at: "")
        }
        #expect(found.map(\.message) == (9_995..<10_000).map { "line \($0)" }, "the newest, newest last")
        #expect(looked == 5, "not one more than it needs")
    }

    @Test func readOldestFirstItKeepsOnlyTheLastOnTheWay() {
        let found = LogRecorder.last(5, of: lines(10_000), since: start.addingTimeInterval(9_000), date: \.date) { line in
            line.text.hasSuffix("7") ? nil : LogEntry(level: "info", message: line.text, at: "")
        }
        #expect(found.map(\.message) == ["line 9993", "line 9994", "line 9995", "line 9996", "line 9998", "line 9999"].suffix(5))
    }

    @Test func nothingBeforeTheStartIsTaken() {
        let found = LogRecorder.last(50, of: lines(20).reversed(), since: start.addingTimeInterval(15), date: \.date) {
            LogEntry(level: "info", message: $0.text, at: "")
        }
        #expect(found.map(\.message) == (15..<20).map { "line \($0)" })
    }

    @Test func aRingKeepsTheLastInOrder() {
        var ring = Ring<Int>(capacity: 3)
        for n in 1...7 { ring.append(n) }
        #expect(ring.inOrder == [5, 6, 7])
    }

    /// The real unified log (slow on macOS: a few seconds to open it).
    @Test func theAppsOwnMessagesAreReadBackNewestLast() async throws {
        let since = Date()
        let logger = Logger(subsystem: "com.example.notato-tests", category: "Log")
        let apple = Logger(subsystem: "com.apple.notato-tests", category: "x")
        for n in 0..<20 {
            logger.error("app message \(n, privacy: .public)")
            apple.error("framework message \(n, privacy: .public)")
        }
        try await Task.sleep(nanoseconds: 300_000_000)
        // Some machines cannot read this process's log back at all (logd refuses, or delivers late): with nothing of
        // ours there to read, there is nothing to test, and the rest of the suite covers the reading logic.
        let readable = (try? OSLogStore(scope: .currentProcessIdentifier).getEntries())?
            .contains { ($0 as? OSLogEntryLog)?.subsystem == "com.example.notato-tests" } ?? false
        guard readable else { return }
        let found = LogRecorder.recent(limit: 5, since: since)
        #expect(found.map(\.message) == (15..<20).map { "[Log] app message \($0)" })
        #expect(found.allSatisfy { $0.level == "error" })
    }
}
