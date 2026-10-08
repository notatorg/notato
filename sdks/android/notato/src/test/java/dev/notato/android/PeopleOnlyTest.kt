package dev.notato.android

import dev.notato.android.internal.BundleWriter
import dev.notato.android.internal.LocalAnnotation
import dev.notato.android.internal.PeopleOnly
import dev.notato.android.model.Annotation
import dev.notato.android.model.Author
import dev.notato.android.model.FeedbackBundle
import dev.notato.android.model.NotatoJson
import dev.notato.android.model.Reply
import dev.notato.android.net.encodeAnnotation
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** People only and asides: what is kept from the agent, as the server would record it. */
class PeopleOnlyTest {
    private val ada = Author.human("Ada")

    private fun json(annotation: Annotation): JsonObject = NotatoJson.parseToJsonElement(encodeAnnotation(annotation)).jsonObject

    @Test
    fun turningItOnHereSetsTheFlagAndRecordsItInTheThread() {
        val note = PeopleOnly.toggle(Fixture.annotation(), on = true, author = ada, id = "R1", at = "2026-10-07T10:00:00.000Z")
        assertEquals(true, note.peopleOnly)
        val entry = note.thread.single()
        assertEquals(Reply("R1", ada, "Made this people only: the agent won't see it.", "2026-10-07T10:00:00.000Z", automatic = true, peopleOnly = true), entry)

        val obj = json(note)
        assertTrue(obj["peopleOnly"]!!.jsonPrimitive.boolean)
        val written = obj["thread"]!!.jsonArray.single().jsonObject
        assertTrue(written["automatic"]!!.jsonPrimitive.boolean)
        assertTrue(written["peopleOnly"]!!.jsonPrimitive.boolean)
        assertFalse("aside" in written)
    }

    @Test
    fun turningItOffLeavesTheFlagOutAndRecordsFalse() {
        val on = PeopleOnly.toggle(Fixture.annotation(), on = true, author = ada)
        val off = PeopleOnly.toggle(on, on = false, author = Author.human("Grace"))
        assertNull(off.peopleOnly)
        assertEquals(2, off.thread.size)
        val entry = off.thread.last()
        assertEquals("Shared this with the agent.", entry.body)
        assertEquals(Author.human("Grace"), entry.author)
        assertEquals(true, entry.automatic)
        assertEquals(false, entry.peopleOnly)

        val obj = json(off)
        // Off is the flag left out, never written as false; the entry recording it says false.
        assertFalse("peopleOnly" in obj)
        assertFalse(obj["thread"]!!.jsonArray.last().jsonObject["peopleOnly"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun turningItToHowItIsChangesNothing() {
        val note = Fixture.annotation()
        assertSame(note, PeopleOnly.toggle(note, on = false, author = ada))
        val on = PeopleOnly.toggle(note, on = true, author = ada)
        assertSame(on, PeopleOnly.toggle(on, on = true, author = ada))
    }

    @Test(expected = IllegalArgumentException::class)
    fun onlyAPersonCanTurnItOnOrOff() {
        PeopleOnly.toggle(Fixture.annotation(), on = true, author = Author.agent("claude"))
    }

    @Test
    fun aNoteWithoutItSaysNothingAboutIt() {
        val obj = json(Fixture.annotation())
        assertFalse("peopleOnly" in obj)
    }

    @Test
    fun aChangeMadeWhileTheNoteWasOnItsWayIsSentAfterIt() {
        val sent = Fixture.annotation()
        val changed = PeopleOnly.toggle(sent, on = true, author = ada)
        // Changed here, and the server took the copy from before: it must be told.
        assertEquals(true, PeopleOnly.stillToSend(true, changed, sent))
        // Turned on and off again, or the server has it already: nothing to say.
        assertNull(PeopleOnly.stillToSend(true, sent, sent))
        assertNull(PeopleOnly.stillToSend(true, changed, changed))
        // Off here, on at the server.
        assertEquals(false, PeopleOnly.stillToSend(true, PeopleOnly.toggle(changed, false, ada), changed))
        // Not changed here: the server's copy wins (someone else may have changed it).
        assertNull(PeopleOnly.stillToSend(false, changed, sent))
    }

    @Test
    fun theServersFieldsAreRead() {
        val reply = """{"id":"R","author":{"kind":"human","name":"Ada"},"body":"Between us","createdAt":"2026-10-07T10:00:00.000Z","aside":true}"""
        assertEquals(true, NotatoJson.decodeFromString(Reply.serializer(), reply).aside)
        val record = """{"id":"S","author":{"kind":"human"},"body":"Shared this with the agent.","createdAt":"x","automatic":true,"peopleOnly":false}"""
        assertEquals(false, NotatoJson.decodeFromString(Reply.serializer(), record).peopleOnly)
        val note = json(Fixture.annotation()).let { JsonObject(it + ("peopleOnly" to JsonPrimitive(true))) }
        assertEquals(true, NotatoJson.decodeFromJsonElement(Annotation.serializer(), note).peopleOnly)
    }

    /** A People only note with its history and an aside, as a test-mode package carries it. */
    private fun withHistory(): Annotation {
        val aside = Reply("R0", ada, "Between us: the old price was right.", "2026-10-07T09:59:00.000Z", aside = true)
        return PeopleOnly.toggle(Fixture.annotation().copy(thread = listOf(aside)), on = true, author = ada)
    }

    @Test
    fun aPeopleOnlyNoteWithItsHistoryPassesTheServersSchema() {
        val result = Fixture.validate("annotation", encodeAnnotation(withHistory())) ?: return
        assertTrue(result.second, result.first)
    }

    @Test
    fun aPackageKeepsPeopleOnlyAndItsHistory() {
        val annotation = withHistory()
        val (bundle, _) = BundleWriter.build(listOf(LocalAnnotation(annotation, emptyMap())), "android-sample", "Ada", "Notato Android sample", "1.0")
        val packed = bundle.annotations.single()
        assertEquals(true, packed.peopleOnly)
        assertEquals(listOf(true, null), packed.thread.map { it.aside })
        assertEquals(listOf(null, true), packed.thread.map { it.peopleOnly })
        assertTrue(BundleWriter.markdown(bundle).contains("People only"))

        val result = Fixture.validate("bundle", NotatoJson.encodeToString(FeedbackBundle.serializer(), bundle)) ?: return
        assertTrue(result.second, result.first)
    }
}
