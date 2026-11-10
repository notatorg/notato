package dev.notato.android

import dev.notato.android.overlay.ComposerVisibility
import dev.notato.android.overlay.Icon
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The composer's Visibility button: what it says for the two switches, and the switches it opens. */
class ComposerTest {
    @Test
    fun theButtonSaysWhoWillSeeTheNoteForEachPairOfSwitches() {
        assertEquals("You and your agent", ComposerVisibility.label(shared = false, hiddenFromAgent = false))
        assertEquals("Shared with project", ComposerVisibility.label(shared = true, hiddenFromAgent = false))
        assertEquals("Only you", ComposerVisibility.label(shared = false, hiddenFromAgent = true))
        assertEquals("Project, not agent", ComposerVisibility.label(shared = true, hiddenFromAgent = true))
    }

    @Test
    fun theLabelAndIconFollowTheSwitchesAsTheyChange() {
        val state = ComposerVisibility()
        assertEquals("You and your agent", state.label)
        assertEquals("Visibility: You and your agent", state.description)
        assertEquals(Icon.LOCK, state.icon)

        state.shared = true
        assertEquals("Shared with project", state.label)
        assertEquals(Icon.PEOPLE, state.icon)

        state.hiddenFromAgent = true
        assertEquals("Visibility: Project, not agent", state.description)
        assertEquals(Icon.PEOPLE, state.icon)

        state.shared = false
        assertEquals("Only you", state.label)
        assertEquals(Icon.LOCK, state.icon)
    }

    @Test
    fun itStartsClosedEvenWhenSharedByDefault() {
        for (shared in listOf(false, true)) {
            val state = ComposerVisibility(shared = shared)
            assertFalse(state.open)
            assertFalse(state.switchesShown)
            assertEquals(0f, state.chevronRotation)
        }
        assertEquals("NotatoVisibility", ComposerVisibility.TEST_ID)
    }

    @Test
    fun openingShowsTheSwitchesAndTurnsTheChevronUp() {
        val state = ComposerVisibility()
        state.toggle()
        assertTrue(state.open)
        assertTrue(state.switchesShown)
        assertEquals(180f, state.chevronRotation)
        // Changing a switch while open keeps it open.
        state.hiddenFromAgent = true
        assertTrue(state.switchesShown)

        state.toggle()
        assertFalse(state.switchesShown)
        assertEquals(0f, state.chevronRotation)
    }
}
