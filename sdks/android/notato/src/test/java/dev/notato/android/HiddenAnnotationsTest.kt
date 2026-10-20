package dev.notato.android

import dev.notato.android.internal.HiddenAnnotations
import dev.notato.android.internal.NoteBook
import dev.notato.android.internal.NoteRecord
import dev.notato.android.internal.RuntimeState
import dev.notato.android.internal.ScreenNotes
import dev.notato.android.model.Status
import org.junit.Assert.*
import org.junit.Test

class HiddenAnnotationsTest {
    @Test fun hidingKeepsFeedbackSurvivesReloadAndRevealsReopenedNotes() {
        val parts = listOf("https://stub.test", "shop", "DEV", "credential", "Alice")
        val state = RuntimeState(RuntimeState.Memory())
        val hidden = HiddenAnnotations()
        hidden.select(parts, state.hiddenAnnotations)
        val notes = NoteBook()
        repeat(2001) { i -> notes.add(NoteRecord(Fixture.annotation().copy(id = "note-$i", route = if (i % 2 == 0) "/one" else "/two", status = Status.RESOLVED))) }
        assertTrue(hidden.hide(listOf(notes.all[0].annotation)))
        assertTrue(hidden.hide(notes.all.map { it.annotation }))
        state.hiddenAnnotations = hidden.encoded
        assertFalse(state.hiddenAnnotations!!.contains("credential"))
        val reload = HiddenAnnotations()
        reload.select(parts, state.hiddenAnnotations)
        val screens = ScreenNotes(notes, reload)
        assertEquals(2001, notes.size)
        assertEquals(2001, reload.ids.size)
        assertTrue(screens.on("/one").isEmpty())
        assertTrue(screens.on("/two").isEmpty())
        notes.all[0].annotation = notes.all[0].annotation.copy(status = Status.OPEN)
        notes.all[1].annotation = notes.all[1].annotation.copy(status = "awaiting_response")
        notes.changed()
        assertEquals(1, screens.on("/one").size)
        assertEquals(1, screens.on("/two").size)
        assertFalse(reload.hide(listOf(notes.all[0].annotation)))
        reload.clear()
        notes.changed()
        assertEquals(2001, screens.on("/one").size + screens.on("/two").size)
    }

    @Test fun eachConnectionAndPersonHasTheirOwnPreference() {
        val hidden = HiddenAnnotations()
        val parts = listOf("https://stub.test", "shop", "DEV", "credential", "Alice")
        hidden.select(parts, null)
        val a = Fixture.annotation().copy(status = Status.REVERTED)
        hidden.hide(listOf(a))
        val saved = hidden.encoded
        for (i in parts.indices) {
            hidden.select(parts.mapIndexed { index, part -> if (i == index) "other" else part }, saved)
            assertFalse(hidden.contains(a))
        }
        hidden.select(parts, saved)
        assertTrue(hidden.contains(a))
    }
}
