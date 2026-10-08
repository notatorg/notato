package dev.notato.android

import dev.notato.android.internal.RuntimeState
import dev.notato.android.internal.ToolbarFold
import dev.notato.android.internal.toolbarHeldRight
import dev.notato.android.overlay.barCount
import dev.notato.android.overlay.connectionDotColor
import dev.notato.android.overlay.foldedCount
import dev.notato.android.overlay.spring
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ToolbarTest {
    /** A device's SharedPreferences, kept across "launches" of the app. */
    private val device = RuntimeState.Memory()

    @Test
    fun remembersBeingFoldedNextToWhereItWasDragged() {
        val state = RuntimeState(device)
        state.toolbarPosition = 0.25f to 0.5f
        val fold = ToolbarFold(state, ToolbarCorner.BOTTOM_END)
        assertFalse(fold.collapsed)
        assertTrue(fold.set(true))
        assertEquals("1", device.get("toolbar.collapsed"))
        assertEquals("0.25,0.5", device.get("toolbar.position"))

        // The next launch comes back folded, where it was.
        val next = RuntimeState(device)
        assertTrue(ToolbarFold(next, ToolbarCorner.BOTTOM_END).collapsed)
        assertEquals(0.25f to 0.5f, next.toolbarPosition)

        // Opened again, nothing is left behind; a reset forgets the fold with the place.
        assertTrue(ToolbarFold(next, ToolbarCorner.BOTTOM_END).set(false))
        assertNull(device.get("toolbar.collapsed"))
        ToolbarFold(next, ToolbarCorner.BOTTOM_END).set(true)
        next.reset()
        assertFalse(ToolbarFold(RuntimeState(device), ToolbarCorner.BOTTOM_END).collapsed)
        assertNull(RuntimeState(device).toolbarPosition)
    }

    @Test
    fun saysWhenWhatShowsChangedAndOnlyThen() {
        val fold = ToolbarFold(RuntimeState(device), ToolbarCorner.BOTTOM_END)
        assertTrue(fold.set(true))
        assertFalse(fold.set(true))
        assertTrue(fold.set(false))
        assertFalse(fold.set(false))
    }

    @Test
    fun opensForAnnotatingWhileFoldedAndFoldsAgainAfter() {
        val state = RuntimeState(device)
        val fold = ToolbarFold(state, ToolbarCorner.BOTTOM_END)
        fold.set(true)
        assertTrue(fold.annotating(true))
        assertFalse(fold.collapsed)
        assertTrue(fold.openedForAnnotate)
        // Opening for annotating is not the person's choice: a launch now would still come back folded.
        assertTrue(state.toolbarCollapsed)
        assertFalse(fold.annotating(true))
        assertTrue(fold.annotating(false))
        assertTrue(fold.collapsed)
        assertFalse(fold.openedForAnnotate)
    }

    @Test
    fun staysOpenAfterAnnotatingWhenItWasOpenAlready() {
        val fold = ToolbarFold(RuntimeState(device), ToolbarCorner.BOTTOM_END)
        assertFalse(fold.annotating(true))
        assertFalse(fold.annotating(false))
        assertFalse(fold.collapsed)
    }

    @Test
    fun aFoldOrOpenByHandWhileAnnotatingIsKept() {
        val fold = ToolbarFold(RuntimeState(device), ToolbarCorner.BOTTOM_END)
        fold.set(true)
        fold.annotating(true)
        // Opened by hand while it was open for annotating: it stays open after.
        assertFalse(fold.set(false))
        assertFalse(fold.openedForAnnotate)
        assertFalse(fold.annotating(false))
        assertFalse(fold.collapsed)

        // Folded by hand while annotating: it stays folded, and stopping changes nothing.
        fold.set(true)
        fold.annotating(true)
        assertTrue(fold.set(true))
        assertTrue(fold.collapsed)
        assertFalse(fold.annotating(false))
        assertTrue(fold.collapsed)
    }

    @Test
    fun annotatingAgainWhileFoldedByHandOpensItAgain() {
        val fold = ToolbarFold(RuntimeState(device), ToolbarCorner.BOTTOM_END)
        fold.set(true)
        fold.annotating(true)
        fold.set(true) // folded by hand mid-annotating
        fold.annotating(false)
        assertTrue(fold.annotating(true))
        assertFalse(fold.collapsed)
    }

    @Test
    fun keepsTheSideItIsHeldToUntilItIsMoved() {
        val state = RuntimeState(device)
        // Dragged as a circle just right of the middle.
        state.toolbarPosition = 0.55f to 0.5f
        val fold = ToolbarFold(state, ToolbarCorner.BOTTOM_START)
        assertTrue(fold.heldRight)
        fold.set(false) // nothing changes: nothing is fixed yet
        fold.set(true)
        assertTrue(fold.heldRight)
        // Opened, the wide bar is mostly in the left half: its fraction says left, but it still folds back to the right.
        fold.set(false)
        fold.keep(0.3f to 0.5f) // where the overlay left it, its held edge kept
        assertTrue(fold.heldRight)
        // In memory only: a launch now works it out from the fraction.
        assertFalse(ToolbarFold(RuntimeState(device), ToolbarCorner.BOTTOM_END).heldRight)
        fold.set(true)
        assertTrue(fold.heldRight)
        fold.annotating(true)
        assertTrue(fold.heldRight)
        // Moved by hand: worked out again from where it is now.
        fold.moved(0.3f to 0.5f)
        assertFalse(fold.heldRight)
    }

    @Test
    fun foldOpenFoldComesBackToTheSameSpot() {
        val state = RuntimeState(device)
        val open = 0.3f to 0.5f
        val circle = 0.62f to 0.5f
        state.toolbarPosition = open
        val fold = ToolbarFold(state, ToolbarCorner.BOTTOM_END)
        // The first fold keeps the held edge: the overlay works out where that puts the circle, and keeps it.
        assertTrue(fold.set(true))
        assertFalse(fold.returning)
        assertEquals(open, fold.position)
        fold.keep(circle)
        assertEquals(circle, state.toolbarPosition)
        // From then on each fold or open goes back to where the one before started, exactly.
        assertTrue(fold.set(false))
        assertTrue(fold.returning)
        assertEquals(open, state.toolbarPosition)
        assertFalse(fold.annotating(true)) // open already
        assertFalse(fold.annotating(false))
        assertTrue(fold.set(true))
        assertTrue(fold.returning)
        assertEquals(circle, state.toolbarPosition)
        assertTrue(fold.set(false))
        assertEquals(open, state.toolbarPosition)
        assertTrue(fold.set(true))
        assertEquals(circle, state.toolbarPosition)
        // Moved by hand: nowhere to go back to; the next open keeps its held edge again.
        fold.moved(0.8f to 0.2f)
        assertTrue(fold.set(false))
        assertFalse(fold.returning)
        assertEquals(0.8f to 0.2f, state.toolbarPosition)
    }

    @Test
    fun openingForAnnotatingMovesItInMemoryOnly() {
        val state = RuntimeState(device)
        val open = 0.3f to 0.5f
        val circle = 0.62f to 0.5f
        state.toolbarPosition = circle
        state.toolbarCollapsed = true
        val fold = ToolbarFold(state, ToolbarCorner.BOTTOM_END)
        assertTrue(fold.annotating(true))
        fold.keep(open)
        // It shows open there, but a launch now comes back folded, where the round button was.
        assertEquals(open, fold.position)
        assertTrue(state.toolbarCollapsed)
        assertEquals(circle, state.toolbarPosition)
        assertTrue(fold.annotating(false))
        assertTrue(fold.returning)
        assertEquals(circle, fold.position)
        // The next opening, by hand, goes back to where annotating had it.
        assertTrue(fold.set(false))
        assertEquals(open, state.toolbarPosition)

        // Folded by hand while open for annotating: where it showed becomes the person's, and it folds back as before.
        fold.set(true)
        assertEquals(circle, state.toolbarPosition)
        fold.annotating(true)
        assertEquals(open, fold.position)
        assertEquals(circle, state.toolbarPosition)
        assertTrue(fold.set(true))
        assertEquals(circle, state.toolbarPosition)
        assertFalse(fold.annotating(false))
    }

    @Test
    fun anUndraggedToolbarStaysInItsCornerAndUndragged() {
        val state = RuntimeState(device)
        val fold = ToolbarFold(state, ToolbarCorner.BOTTOM_END)
        fold.set(true)
        fold.set(false)
        fold.set(true)
        assertFalse(fold.returning)
        assertNull(state.toolbarPosition)
    }

    @Test
    fun anUndraggedToolbarIsHeldToItsCorner() {
        val fold = ToolbarFold(RuntimeState(device), ToolbarCorner.TOP_START)
        assertFalse(fold.heldRight)
        fold.set(true)
        assertFalse(fold.heldRight)
        assertTrue(ToolbarFold(RuntimeState(RuntimeState.Memory()), ToolbarCorner.TOP_END).heldRight)
    }

    @Test
    fun foldsTowardTheSideItIsHeldTo() {
        // Never dragged: its corner.
        assertTrue(toolbarHeldRight(null, ToolbarCorner.BOTTOM_END))
        assertTrue(toolbarHeldRight(null, ToolbarCorner.TOP_END))
        assertFalse(toolbarHeldRight(null, ToolbarCorner.BOTTOM_START))
        assertFalse(toolbarHeldRight(null, ToolbarCorner.TOP_START))
        // Dragged: the half it was left in, whatever the corner.
        assertTrue(toolbarHeldRight(0.5f to 0f, ToolbarCorner.BOTTOM_START))
        assertTrue(toolbarHeldRight(1f to 1f, ToolbarCorner.TOP_START))
        assertFalse(toolbarHeldRight(0.49f to 0.86f, ToolbarCorner.BOTTOM_END))
        assertFalse(toolbarHeldRight(0f to 0f, ToolbarCorner.TOP_END))
    }

    @Test
    fun annotateAlwaysShowsItsCountAndTheFoldedButtonOnlyWhenThereIsOne() {
        // On the open bar, "0" included.
        assertEquals("0", barCount(0))
        assertEquals("1", barCount(1))
        assertEquals("99", barCount(99))
        assertEquals("99+", barCount(100))
        // On the folded button's corner, gone at 0.
        assertNull(foldedCount(0))
        assertEquals("1", foldedCount(1))
        assertEquals("99", foldedCount(99))
        assertEquals("99+", foldedCount(100))
        assertEquals("99+", foldedCount(1234))
    }

    @Test
    fun theDotShowsOnlyAServerInTrouble() {
        // The design's amber and red, on ⋯ and on the folded button alike.
        assertEquals(0xFFE9B44C.toInt(), connectionDotColor(NotatoConnection.CONNECTING))
        assertEquals(0xFFEF6B5E.toInt(), connectionDotColor(NotatoConnection.OFFLINE))
        assertEquals(0xFFEF6B5E.toInt(), connectionDotColor(NotatoConnection.REFUSED))
        assertNull(connectionDotColor(NotatoConnection.CONNECTED))
        assertNull(connectionDotColor(NotatoConnection.LOCAL))
        assertNull(connectionDotColor(NotatoConnection.DISABLED))
    }

    @Test
    fun theSpringOvershootsAboutFivePercentOnceAndSettles() {
        val samples = (0..1000).map { spring(it / 1000f) }
        assertEquals(0f, samples.first(), 0f)
        assertEquals(1f, samples.last(), 0f)
        val peak = samples.indices.maxBy { samples[it] }
        assertEquals(1.054f, samples[peak], 0.005f)
        // Peaks about halfway (272ms of the opening's 560ms), rising all the way there.
        assertEquals(0.486f, peak / 1000f, 0.01f)
        assertTrue((1..peak).all { samples[it] >= samples[it - 1] })
        // Never dips back below the end by more than a hair, and has settled by the end.
        assertTrue(samples.drop(peak).all { it > 0.99f })
        assertEquals(1f, samples[999], 0.003f)
    }
}
