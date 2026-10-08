import Foundation
import Testing
@testable import Notato

// The `Notato` object's own bookkeeping: its index of notes by id and by screen, and the queue that sends them.

@Suite("The notes, by id and by screen")
@MainActor
struct NoteIndexTests {
    @Test func tenThousandListedNotesMergeIntoTenThousandRecordsInOnePass() {
        let notato = Fixture.notato()
        notato.insert((0..<10_000).map { NoteRecord(Fixture.note($0)) })
        // The server lists them as a summary (no context, no steps), every tenth acknowledged since.
        let listed = (0..<10_000).map { n -> Annotation in
            var annotation = Fixture.note(n)
            annotation.context = [:]
            annotation.steps = nil
            if n % 10 == 0 { annotation.status = Status.acknowledged }
            return annotation
        }
        let changed = Flag(), unchanged = Flag()
        withObservationTracking { _ = notato.record("note00000")?.annotation } onChange: { changed.raised = true }
        withObservationTracking { _ = notato.record("note00001")?.annotation } onChange: { unchanged.raised = true }

        let elapsed = ContinuousClock().measure { notato.merge(listed, summary: true) }
        #expect(elapsed < .seconds(1), "\(elapsed); well under 100 ms in a release build")
        #expect(notato.records.count == 10_000)
        #expect(notato.record("note00010")?.annotation.status == Status.acknowledged)
        #expect(notato.record("note00011")?.annotation.status == Status.open)
        #expect(notato.record("note00011")?.annotation.context.isEmpty == false, "a summary keeps the context known here")
        #expect(notato.record("note00011")?.annotation.steps?.count == 1)
        #expect(changed.raised && !unchanged.raised, "only a note that changed is set again, so only its views are drawn again")
    }

    @Test func aListAddsWhatIsNewAndSendsWhatWasWaiting() {
        let notato = Fixture.notato()
        let waiting = NoteRecord(Fixture.note(1), pending: true, mine: true, assets: ["shot": .bytes(Data([1]))])
        notato.insert([NoteRecord(Fixture.note(0)), waiting])
        var other = Fixture.note(9)
        other.projectId = "another-project"
        notato.merge([Fixture.note(1), Fixture.note(2), Fixture.note(2), other], summary: true)
        #expect(notato.records.map(\.id) == ["note00000", "note00001", "note00002"], "once each, and only this project's")
        #expect(!waiting.pending && waiting.assets == nil, "the server has it: it is not sent again")
        #expect(notato.record("note00002") != nil && notato.record("note00009") == nil)
    }

    @Test func forgettingANoteTakesItOutOfTheIndexAndTheScreens() {
        let notato = Fixture.notato()
        notato.insert((0..<5).map { NoteRecord(Fixture.note($0)) })
        #expect(notato.notes(onRoute: "/ProductList").count == 5)
        let before = notato.generation
        notato.forget { $0.id == "note00002" }
        #expect(notato.generation != before)
        #expect(notato.record("note00002") == nil && notato.records.count == 4)
        #expect(notato.notes(onRoute: "/ProductList").all.map(\.id) == ["note00000", "note00001", "note00003", "note00004"])
        notato.insert([NoteRecord(Fixture.note(2))])
        #expect(notato.notes(onRoute: "/ProductList").all.map(\.id).last == "note00004", "in pin order, not the order they came")
    }

    @Test func aScreensPinsAreTheNewest150MadeOnThisPlatformNumberedAmongAllItsNotes() {
        let notato = Fixture.notato()
        // 220 notes on one screen, of which 20 from a web page whose route has the same name, and 5 on another screen.
        let here = (0..<220).map { NoteRecord(Fixture.note($0, platform: $0 % 11 == 5 ? "web" : "ios")) }
        notato.insert((here + (220..<225).map { NoteRecord(Fixture.note($0, route: "/Checkout")) }).shuffled())
        let screen = notato.notes(onRoute: "/ProductList")
        #expect(screen.count == 220)
        #expect(screen.all.map(\.id) == here.map(\.id), "oldest first, so each keeps its number")
        #expect(screen.pinned.count == PinLayout.maxPins)
        let pinnedIds: [String] = screen.pinned.map(\.record.id)
        let newestOnIOS: [String] = here.filter { $0.platform == "ios" }.suffix(PinLayout.maxPins).map(\.id)
        #expect(pinnedIds == newestOnIOS)
        #expect(screen.pinned.allSatisfy { screen.all[$0.number - 1] === $0.record }, "numbered as the Notes list numbers them")
        #expect(notato.notes(onRoute: "/Checkout").count == 5)
        #expect(screen.newest(50).map(\.number) == Array(171...220), "the Notes list: the newest 50, in pin order")
    }

    @Test func pinsAreLookedForAgainOnlyWhenTheScreenIsReadAgainOrANoteIsNew() {
        let notato = Fixture.notato()
        notato.insert((0..<3).map { NoteRecord(Fixture.note($0)) })
        let board = PinBoard()
        var looked: [String] = []
        let locate: (NoteRecord) -> CGRect? = { record in
            looked.append(record.id)
            return record.id == "note00002" ? nil : CGRect(x: 16, y: 200, width: 370, height: 40)
        }
        let first = board.pins(for: notato.notes(onRoute: "/ProductList").pinned, width: 402, scanned: true, locate: locate)
        #expect(looked.count == 3)
        #expect(first.map(\.number) == [1, 2, 3])
        #expect(first[2].detached && first[2].rect == CGRect(x: 16, y: 217, width: 370, height: 39.67), "not found: where it was made")
        #expect(first.map(\.origin) == PinLayout.place(first.map(\.rect), width: 402))

        // A tick with nothing new: nothing looked for, the pins where they were.
        #expect(board.pins(for: notato.notes(onRoute: "/ProductList").pinned, width: 402, scanned: false, locate: locate) == first)
        #expect(looked.count == 3)

        // A note's status changes: its pin shows it at once, without looking.
        notato.record("note00000")?.annotation.status = Status.resolved
        #expect(board.pins(for: notato.notes(onRoute: "/ProductList").pinned, width: 402, scanned: false, locate: locate)[0].status == Status.resolved)
        #expect(looked.count == 3)

        // A new note: only it is looked for.
        notato.insert([NoteRecord(Fixture.note(3))])
        #expect(board.pins(for: notato.notes(onRoute: "/ProductList").pinned, width: 402, scanned: false, locate: locate).count == 4)
        #expect(looked == ["note00000", "note00001", "note00002", "note00003"])

        // The screen read again: every one is.
        _ = board.pins(for: notato.notes(onRoute: "/ProductList").pinned, width: 402, scanned: true, locate: locate)
        #expect(looked.count == 8)
    }

    @Test func aNoteRecordParsesItsSelectorOnce() {
        let record = NoteRecord(Fixture.note(0))
        #expect(record.selector?.id == "PromoBanner")
        record.annotation.target.identity[0].selector = "button:text(\"Add to cart\")"
        #expect(record.selector?.text == "Add to cart", "parsed again when the server changes it")
        let elements = Fixture.productList
        for selector in ["button:text(\"Add to cart\"):nth(2)", "button", "#PromoBanner", "button:nth(9)"] {
            #expect(Selectors.first(try! Selectors.parse(selector), in: elements) == (try! Selectors.query(selector, in: elements)).first, "\(selector)")
        }
    }
}

@Suite("Sending the queue")
@MainActor
struct QueueTests {
    private func records(_ count: Int) -> [NoteRecord] {
        (0..<count).map { n in
            var annotation = Fixture.annotation()
            annotation.id = "01M471ZCEXZ4AEZHN0YP8RGVW\(n)"
            return NoteRecord(annotation, pending: true, mine: true)
        }
    }

    @Test(arguments: [400, 409, 413, 415, 422])
    nonisolated func theseRefuseTheNoteItself(status: Int) {
        #expect(NotatoServerError(message: "no", status: status).refusesNote)
    }

    @Test(arguments: [0, 200, 401, 403, 404, 408, 429, 500, 502, 503])
    nonisolated func theseHoldTheQueue(status: Int) {
        #expect(!NotatoServerError(message: "not now", status: status).refusesNote)
    }

    @Test func aRefusedNoteIsPassedOverAndTheRestStillGo() async {
        let queue = records(4)
        var tried: [String] = []
        let stopped = await Notato.drain(queue) { record in
            tried.append(record.id)
            if record === queue[1] {
                record.error = "Too big"
                return .refused("Too big")
            }
            record.pending = false
            return .sent
        }
        #expect(stopped == nil)
        #expect(tried == queue.map(\.id))
        let stillPending: [String] = queue.filter(\.pending).map(\.id)
        #expect(stillPending == [queue[1].id])
        // On the next try (or launch, `LocalStore.refuse`) it is not sent again.
        tried = []
        _ = await Notato.drain(queue) { tried.append($0.id); return .sent }
        #expect(tried.isEmpty)
    }

    @Test func anythingElseStopsTheQueueWithEverythingStillQueued() async {
        let queue = records(4)
        var tried: [String] = []
        let unknown = NotatoServerError(message: "project \"x\" does not exist on this server: create it first", status: 404)
        let stopped = await Notato.drain(queue) { record in
            tried.append(record.id)
            if record === queue[1] { return .held(unknown) }
            record.pending = false
            return .sent
        }
        #expect(stopped == unknown)
        let firstTwo: [String] = [queue[0].id, queue[1].id]
        #expect(tried == firstTwo)
        #expect(queue.filter(\.pending).count == 3)
        #expect(SendOutcome.held(unknown).problem == "Saved on this device, not sent: \(unknown.message)", "the server's words are shown")
        #expect(SendOutcome.held(NotatoServerError(message: "offline", status: 0)).problem == "Saved. It's sent when the server can be reached.")
    }

    @Test func aNoteDeletedWhileTheQueueIsSentIsNotSent() async {
        let queue = records(3)
        var tried: [String] = []
        _ = await Notato.drain(queue) { record in
            tried.append(record.id)
            queue[2].deleted = true
            return .sent
        }
        let firstTwo: [String] = [queue[0].id, queue[1].id]
        #expect(tried == firstTwo)
    }

    @Test func onlyNotesTheServerHadBeforeTheLoadAndNoLongerListsAreForgotten() {
        let notes = records(4)
        notes[0].pending = false
        notes[1].pending = false
        // notes[2] is waiting to be sent, notes[3] was made (and sent) while the pages came.
        notes[3].pending = false
        let known: Set<String> = [notes[0].id, notes[1].id]
        var listed = StoredAnnotation(seq: 1, annotation: Fixture.annotation())
        listed.annotation.id = notes[0].id
        #expect(Notato.forgotten(known: known, listed: [listed], now: notes) == [notes[1].id])
        #expect(Notato.forgotten(known: known.union([notes[2].id]), listed: [listed], now: notes) == [notes[1].id], "never one waiting to be sent")
    }
}
