import Foundation
import Testing
@testable import Notato

@Suite("Hidden annotations")
@MainActor
struct HiddenAnnotationsTests {
    @Test func hidingPreservesPinNumbersFromTheScreenshots() {
        let notato = Fixture.notato()
        var completed = Fixture.note(0)
        completed.status = Status.resolved
        let open = NoteRecord(Fixture.note(1))
        notato.insert([NoteRecord(completed), open])
        notato.hideCompleted()
        let notes = notato.notes(onRoute: open.route)
        #expect(notes.count == 1)
        #expect(notes.newest(50).first?.number == 2)
        #expect(notes.pinned.first?.number == 2)
        #expect(notes.number(of: open) == 2)
    }

    @Test func hidingKeepsFeedbackAndRestoresReopenedTasksAndQuestions() {
        let notato = Fixture.notato()
        let records = (0..<2001).map { i -> NoteRecord in
            var a = Fixture.note(i, route: i % 2 == 0 ? "/ProductList" : "/Other")
            a.status = Status.resolved
            return NoteRecord(a)
        }
        notato.insert(records)
        notato.hideAnnotation(records[0].id)
        #expect(notato.hiddenCount == 1)
        notato.hideCompleted()
        #expect(notato.hiddenCount == 2001)
        #expect(notato.annotations.count == 2001)
        #expect(notato.notes(onRoute: "/ProductList").count == 0)
        #expect(notato.notes(onRoute: "/Other").count == 0)

        let reload = Fixture.notato()
        reload.state.hiddenAnnotations = notato.state.hiddenAnnotations
        reload.insert(records.map { NoteRecord($0.annotation) })
        #expect(reload.visibleCount == 0)
        #expect(reload.notes(onRoute: "/ProductList").count == 0)
        var reopened = records[0].annotation
        reopened.status = Status.open
        reload.upsert(reopened)
        #expect(reload.notes(onRoute: "/ProductList").count == 1)
        var question = records[1].annotation
        question.status = "awaiting_response"
        reload.upsert(question)
        #expect(reload.notes(onRoute: "/Other").count == 1)
        reload.hideAnnotation(reopened.id)
        #expect(reload.visibleCount == 2)
        reload.restoreHidden()
        #expect(reload.visibleCount == 2001)
        #expect(reload.hiddenCount == 0)
    }

    @Test func preferencesArePrivateToEachConnectionAndPerson() {
        var hidden = HiddenAnnotations()
        let parts = ["https://stub.test", "shop", "dev", "credential", "Alice"]
        _ = hidden.select(parts, saved: nil)
        var a = Fixture.annotation()
        a.status = Status.reverted
        hidden.hide([a])
        let saved = hidden.encoded
        #expect(saved?.contains("credential") == false)
        for i in parts.indices {
            var other = parts
            other[i] = "other"
            _ = hidden.select(other, saved: saved)
            #expect(!hidden.contains(a))
        }
        _ = hidden.select(parts, saved: saved)
        #expect(hidden.contains(a))
    }
}
