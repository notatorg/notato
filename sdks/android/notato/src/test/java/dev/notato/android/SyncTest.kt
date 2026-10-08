package dev.notato.android

import dev.notato.android.internal.NoteRecord
import dev.notato.android.internal.SendOutcome
import dev.notato.android.internal.SyncEvent
import dev.notato.android.internal.captureThenScan
import dev.notato.android.internal.decodeEvent
import dev.notato.android.internal.mergeList
import dev.notato.android.internal.outcomeOf
import dev.notato.android.internal.sendQueue
import dev.notato.android.model.NotatoJson
import dev.notato.android.model.ServerEventData
import dev.notato.android.net.NotatoServerException
import dev.notato.android.net.ServerSentEvent
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

/** Sending the queue, and matching the notes here to the server's list. */
class SyncTest {
    private fun note(id: String) = Fixture.annotation().copy(id = id)

    private fun record(id: String, touched: Long, pending: Boolean = false) = NoteRecord(note(id), pending = pending).also { it.touched = touched }

    @Test
    fun aRefusedNoteIsPassedOverAndTheRestStillGo() = runBlocking {
        val sent = mutableListOf<String>()
        val outcomes = mapOf("A" to SendOutcome.SENT, "B" to SendOutcome.REFUSED, "C" to SendOutcome.SENT)
        sendQueue(listOf("A", "B", "C")) { sent += it; outcomes.getValue(it) }
        assertEquals(listOf("A", "B", "C"), sent)
    }

    @Test
    fun aNoteNotTakenForNowHoldsTheQueue() = runBlocking {
        val sent = mutableListOf<String>()
        val outcomes = mapOf("A" to SendOutcome.SENT, "B" to SendOutcome.HELD, "C" to SendOutcome.SENT)
        sendQueue(listOf("A", "B", "C")) { sent += it; outcomes.getValue(it) }
        assertEquals(listOf("A", "B"), sent)
    }

    @Test
    fun onlyTheseAnswersRefuseANoteForGood() {
        for (status in listOf(400, 409, 413, 415, 422)) {
            assertEquals("$status", SendOutcome.REFUSED, outcomeOf(NotatoServerException("no", status)))
        }
        // No answer, a token or project the server does not know (404 on a shared server), busy, or broken: kept.
        for (status in listOf(0, 401, 403, 404, 408, 429, 500, 502, 503)) {
            assertEquals("$status", SendOutcome.HELD, outcomeOf(NotatoServerException("not now", status)))
        }
    }

    @Test
    fun theListDropsWhatTheServerNoLongerHasButNeverAWaitingNote() {
        val records = listOf(record("GONE", 1), record("KEPT", 2), record("WAITING", 3, pending = true))
        val merge = mergeList(records, listOf(note("KEPT"), note("NEW")), since = 5, deletedSince = emptySet())
        assertEquals(setOf("GONE"), merge.drops)
        assertEquals(listOf("KEPT", "NEW"), merge.upserts.map { it.id })
    }

    @Test
    fun whatChangedHereWhileTheListWasReadIsNewerThanIt() {
        // Made and sent here after the list was asked for (so not on it), and changed by an event meanwhile.
        val records = listOf(record("SENT-MEANWHILE", 7), record("UPDATED-MEANWHILE", 8), record("OLD", 2))
        val merge = mergeList(records, listOf(note("UPDATED-MEANWHILE"), note("OLD")), since = 5, deletedSince = emptySet())
        assertEquals(emptySet<String>(), merge.drops)
        assertEquals(listOf("OLD"), merge.upserts.map { it.id })
    }

    @Test
    fun aNoteDeletedWhileTheListWasReadIsNotBroughtBack() {
        val merge = mergeList(emptyList(), listOf(note("DELETED"), note("OTHER")), since = 5, deletedSince = setOf("DELETED"))
        assertEquals(listOf("OTHER"), merge.upserts.map { it.id })
    }

    @Test
    fun eventsAreReadIntoWhatTheyMean() {
        val note = Fixture.annotation()
        val data = NotatoJson.encodeToString(ServerEventData.serializer(), ServerEventData(note.id, note.projectId, note))
        assertSame(SyncEvent.Hello, decodeEvent(ServerSentEvent("hello", "{}")))
        for (kind in listOf("created", "updated", "replied")) {
            assertEquals(kind, note, (decodeEvent(ServerSentEvent(kind, data)) as SyncEvent.Changed).annotation)
        }
        assertEquals("N1", (decodeEvent(ServerSentEvent("deleted", "{\"id\":\"N1\"}")) as SyncEvent.Deleted).id)
        val relay = decodeEvent(ServerSentEvent("annotate-request", "{\"requestId\":\"R1\",\"args\":{\"target\":\"#save\",\"comment\":\"Too small\"}}"))
        assertEquals("#save", (relay as SyncEvent.Relay).request.args.target)
        // What cannot be read, and what this SDK does not act on, is passed over.
        assertNull(decodeEvent(ServerSentEvent("created", "not json")))
        assertNull(decodeEvent(ServerSentEvent("deleted", "{}")))
        assertNull(decodeEvent(ServerSentEvent("annotate-request", "{}")))
        assertNull(decodeEvent(ServerSentEvent("message", "plain")))
    }

    @Test
    fun theScreenIsReadAfterThePictureIsTaken() = runBlocking {
        // What the reading says to cover must be where it was in the picture: the picture first, then the reading.
        val order = mutableListOf<String>()
        val (picture, reading) = captureThenScan({
            order += "capture started"
            yield()
            order += "capture done"
            "picture"
        }) {
            order += "scan"
            listOf("elements")
        }
        assertEquals(listOf("capture started", "capture done", "scan"), order)
        assertEquals("picture" to listOf("elements"), picture to reading)
        // No picture (screenshots off): the screen is still read.
        assertEquals(null to 1, captureThenScan({ null }) { 1 })
    }

    @Test
    fun aWaitingNoteTheServerListsIsTakenAsSent() {
        // Even one made after the list was asked for: the server has it, so it has arrived.
        val merge = mergeList(listOf(record("ARRIVED", 9, pending = true)), listOf(note("ARRIVED")), since = 5, deletedSince = emptySet())
        assertEquals(listOf("ARRIVED"), merge.upserts.map { it.id })
    }
}
