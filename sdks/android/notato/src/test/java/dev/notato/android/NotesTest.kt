package dev.notato.android

import dev.notato.android.internal.NoteBook
import dev.notato.android.internal.NoteRecord
import dev.notato.android.internal.mergeList
import dev.notato.android.model.Status
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** The notes here, indexed by id: taking the server's copies, its answers, and what is sent. */
class NotesTest {
    private fun note(id: String, project: String = "android-sample") = Fixture.annotation().copy(id = id, projectId = project)

    private var clock = 0L
    private fun touch(record: NoteRecord) {
        record.touched = ++clock
    }

    private fun NoteBook.take(id: String, deleted: Set<String> = emptySet()) =
        take(note(id), "android-sample", { it in deleted }, ::touch)

    @Test
    fun theIndexKeepsInStepWithTheNotes() {
        val notes = NoteBook()
        for (id in listOf("A", "B", "C", "D")) notes.add(NoteRecord(note(id)))
        assertEquals(listOf("A", "B", "C", "D"), notes.all.map { it.annotation.id })
        assertEquals("C", notes["C"]?.annotation?.id)

        assertEquals("B", notes.remove("B")?.annotation?.id)
        assertNull(notes["B"])
        assertNull(notes.remove("B"))
        notes.removeAll { it.annotation.id == "D" }
        assertFalse("D" in notes)
        assertEquals(listOf("A", "C"), notes.all.map { it.annotation.id })

        // A second note with an id already here replaces it where it is.
        val replacement = NoteRecord(note("A"), pending = true)
        notes.add(replacement)
        assertEquals(listOf("A", "C"), notes.all.map { it.annotation.id })
        assertSame(replacement, notes["A"])

        notes.clear()
        assertEquals(0, notes.size)
        assertNull(notes["A"])
    }

    @Test
    fun everyChangeMovesTheVersion() {
        val notes = NoteBook()
        var last = notes.version
        fun moved() = (notes.version != last).also { last = notes.version }
        notes.add(NoteRecord(note("A")))
        assertTrue(moved())
        notes.changed()
        assertTrue(moved())
        notes.remove("A")
        assertTrue(moved())
        // Nothing removed, nothing changed.
        notes.removeAll { true }
        assertFalse(moved())
        notes.remove("missing")
        assertFalse(moved())
    }

    @Test
    fun aNewNoteIsAddedAndAKnownOneUpdatedInPlace() {
        val notes = NoteBook()
        assertNull(notes.take("A"))
        val record = notes["A"]!!
        assertNull(notes.take(note("A").copy(status = Status.RESOLVED), "android-sample", { false }, ::touch))
        assertSame(record, notes["A"])
        assertEquals(Status.RESOLVED, record.annotation.status)
        assertEquals(2L, record.touched)
    }

    @Test
    fun aWaitingNoteTheServerSendsHasArrived() {
        val notes = NoteBook()
        val waiting = NoteRecord(note("A").copy(comment = "as written here"), pending = true, mine = true, assets = emptyMap()).also { it.held = "busy" }
        notes.add(waiting)
        val arrived = notes.take(note("A").copy(comment = "as the server has it"), "android-sample", { false }, ::touch)!!
        assertSame(waiting, arrived.record)
        assertEquals("as written here", arrived.local.comment)
        assertEquals("as the server has it", waiting.annotation.comment)
        assertFalse(waiting.pending)
        assertNull(waiting.held)
        assertNull(waiting.assets)
    }

    @Test
    fun anotherProjectsNoteAndOneDeletedHereAreLeftOut() {
        val notes = NoteBook()
        assertNull(notes.take(note("A", project = "other"), "android-sample", { false }, ::touch))
        // Deleted here while it was being sent: the server's event about it arriving does not bring it back.
        notes.take("B", deleted = setOf("B"))
        assertEquals(0, notes.size)
    }

    @Test
    fun theAnswerToAPostIsTakenOnlyWhileTheNoteStillWaits() {
        val notes = NoteBook()
        val record = NoteRecord(note("A"), pending = true, mine = true)
        notes.add(record)
        assertTrue(notes.posted(record, note("A").copy(comment = "the post's answer"), ::touch))
        assertFalse(record.pending)
        assertEquals("the post's answer", record.annotation.comment)

        // The event came first, and a reply after it: the post's older answer does not undo them.
        val second = NoteRecord(note("B"), pending = true, mine = true)
        notes.add(second)
        notes.take(note("B").copy(status = Status.ACKNOWLEDGED, comment = "with a reply"), "android-sample", { false }, ::touch)
        assertFalse(notes.posted(second, note("B").copy(comment = "the post's answer"), ::touch))
        assertEquals("with a reply", second.annotation.comment)
        assertEquals(Status.ACKNOWLEDGED, second.annotation.status)
    }

    @Test
    fun theQueueLeavesOutWhatIsOnItsWayRefusedOrDeleted() {
        val notes = NoteBook()
        val ready = NoteRecord(note("READY"), pending = true)
        val sending = NoteRecord(note("SENDING"), pending = true).also { it.sending = true }
        val refused = NoteRecord(note("REFUSED"), pending = true).also { it.error = "too big" }
        val deleted = NoteRecord(note("DELETED"), pending = true).also { it.deletedHere = true }
        val sent = NoteRecord(note("SENT"))
        for (r in listOf(ready, sending, refused, deleted, sent)) notes.add(r)
        assertEquals(listOf("READY"), notes.queue().map { it.annotation.id })
    }

    @Test
    fun aSelectorIsParsedOnceAndAgainOnlyWhenItChanges() {
        val record = NoteRecord(note("A"))
        val first = record.selector()
        assertEquals("£89.00", first?.text)
        assertSame(first, record.selector())
        val identity = record.annotation.target.identity.single()
        record.annotation = record.annotation.copy(target = record.annotation.target.copy(identity = listOf(identity.copy(selector = "#price"))))
        assertEquals("price", record.selector()?.id)
        // A web note's CSS is no Android selector: no pin can follow it.
        record.annotation = record.annotation.copy(target = record.annotation.target.copy(identity = listOf(identity.copy(selector = "div > .price"))))
        assertNull(record.selector())
    }

    @Test(timeout = 10_000)
    fun tenThousandListedNotesAreMatchedInOnePass() {
        // 10,000 here (the first 5,000 waiting to be sent), and a list of 10,000 from the server: half of what is here
        // and 5,000 new ones. Matched by id rather than searched for, this is milliseconds, not seconds.
        val notes = NoteBook()
        for (i in 0 until 10_000) notes.add(NoteRecord(note("N$i"), pending = i < 5_000).also { it.touched = 1 })
        val listed = (5_000 until 15_000).map { note("N$it") }
        val started = System.nanoTime()
        val merge = mergeList(notes.all, listed, since = 5, deletedSince = emptySet())
        for (annotation in merge.upserts) notes.take(annotation, "android-sample", { false }, ::touch)
        notes.removeAll { it.annotation.id in merge.drops }
        val ms = (System.nanoTime() - started) / 1_000_000

        // The waiting ones are kept though the list does not have them; the rest match the list.
        assertEquals(15_000, notes.size)
        assertTrue(notes.all.take(5_000).all { it.pending })
        assertEquals(15_000, notes.all.map { it.annotation.id }.toSet().size)
        assertNotEquals(null, notes["N14999"])
        assertTrue("took $ms ms", ms < 2_000)
    }
}
