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

    @Test fun hideDoneLeavesOutEveryFinishedNoteIncludingLaterOnesAndIsRemembered() {
        val parts = listOf("https://stub.test", "shop", "DEV", "credential", "Alice")
        val state = RuntimeState(RuntimeState.Memory())
        assertFalse(state.hideDone)
        val hidden = HiddenAnnotations()
        hidden.select(parts, state.hiddenAnnotations)
        val notes = NoteBook()
        notes.add(NoteRecord(Fixture.annotation().copy(id = "resolved", route = "/one", status = Status.RESOLVED)))
        notes.add(NoteRecord(Fixture.annotation().copy(id = "reverted", route = "/one", status = Status.REVERTED)))
        notes.add(NoteRecord(Fixture.annotation().copy(id = "dismissed", route = "/one", status = Status.DISMISSED)))
        notes.add(NoteRecord(Fixture.annotation().copy(id = "open", route = "/one", status = Status.OPEN)))
        val screens = ScreenNotes(notes, hidden)
        fun shown() = screens.on("/one").map { it.second.annotation.id }
        assertEquals(4, shown().size)

        val number = screens.on("/one").single { it.second.annotation.id == "open" }.first

        // On: every finished note goes, and the open one keeps its number.
        state.hideDone = true
        hidden.hideDone = state.hideDone
        notes.changed()
        assertEquals(listOf("open"), shown())
        assertEquals(number, screens.on("/one").single().first)

        // One finished afterwards goes too, with nothing pressed again.
        notes.all[3].annotation = notes.all[3].annotation.copy(status = Status.RESOLVED)
        notes.changed()
        assertTrue(shown().isEmpty())

        // Reopened, it is back by itself.
        notes.all[0].annotation = notes.all[0].annotation.copy(status = Status.OPEN)
        notes.changed()
        assertEquals(listOf("resolved"), shown())

        // The switch is not the per-note list: nothing was added to it, so turning it off shows them all.
        assertTrue(hidden.ids.isEmpty())

        // Remembered: a new start reads it back.
        val reload = HiddenAnnotations()
        reload.select(parts, state.hiddenAnnotations)
        reload.hideDone = state.hideDone
        assertTrue(reload.hideDone)
        assertEquals(listOf("resolved"), ScreenNotes(notes, reload).on("/one").map { it.second.annotation.id })

        state.hideDone = false
        hidden.hideDone = state.hideDone
        notes.changed()
        assertEquals(4, shown().size)
    }

    @Test fun hideDoneIsStoredOnlyWhileOnAndResetClearsIt() {
        val store = RuntimeState.Memory()
        val state = RuntimeState(store)
        state.hideDone = true
        assertEquals("1", store.get("hide.done"))
        assertTrue(RuntimeState(store).hideDone)
        state.hideDone = false
        assertNull(store.get("hide.done"))
        state.hideDone = true
        state.reset()
        assertFalse(RuntimeState(store).hideDone)
    }

    @Test fun notesHiddenOneAtATimeStayHiddenWithTheSwitchOff() {
        val hidden = HiddenAnnotations()
        hidden.select(listOf("a"), null)
        val one = Fixture.annotation().copy(id = "one", status = Status.RESOLVED)
        val two = Fixture.annotation().copy(id = "two", status = Status.RESOLVED)
        hidden.hide(listOf(one))
        assertTrue(hidden.contains(one))
        assertFalse(hidden.contains(two))
        hidden.hideDone = true
        assertTrue(hidden.contains(two))
        hidden.hideDone = false
        assertTrue(hidden.contains(one))
        assertFalse(hidden.contains(two))
    }
}
