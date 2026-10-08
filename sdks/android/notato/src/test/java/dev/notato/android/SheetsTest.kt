package dev.notato.android

import dev.notato.android.overlay.HeaderLead
import dev.notato.android.overlay.SheetCopy
import dev.notato.android.overlay.SheetPlace
import dev.notato.android.overlay.backFrom
import dev.notato.android.overlay.buttonsFit
import dev.notato.android.overlay.closesWithToolbar
import dev.notato.android.overlay.headerLead
import dev.notato.android.overlay.notesListing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The sheets: one bottom sheet whose content goes from the menu to what it opens and back. */
class SheetsTest {
    @Test
    fun backFromWhatTheMenuOpensReopensTheMenu() {
        for (place in listOf(SheetPlace.Notes, SheetPlace.Settings, SheetPlace.ConfirmClear)) {
            assertEquals(SheetPlace.Menu, backFrom(place))
            assertEquals(HeaderLead.BACK, headerLead(place))
        }
        // The menu leads with the potato, and has nowhere to go back to.
        assertNull(backFrom(SheetPlace.Menu))
        assertEquals(HeaderLead.POTATO, headerLead(SheetPlace.Menu))
    }

    @Test
    fun aNoteFromTheListHasBackAndOneFromAPinHasThePin() {
        val fromList = SheetPlace.Note("n1", fromList = true)
        assertEquals(SheetPlace.Notes, backFrom(fromList))
        assertEquals(HeaderLead.BACK, headerLead(fromList))

        val fromPin = SheetPlace.Note("n1", fromList = false)
        assertNull(backFrom(fromPin))
        assertEquals(HeaderLead.PIN, headerLead(fromPin))
    }

    @Test
    fun foldingTheToolbarClosesWhatTheMenuOpenedButNotANoteFromItsPin() {
        for (place in listOf(SheetPlace.Menu, SheetPlace.Notes, SheetPlace.Settings, SheetPlace.ConfirmClear, SheetPlace.Note("n1", fromList = true))) {
            assertTrue("$place", closesWithToolbar(place))
        }
        assertFalse(closesWithToolbar(SheetPlace.Note("n1", fromList = false)))
    }

    @Test
    fun theNotesSheetSaysWhatItDoesNotShow() {
        assertEquals("2 on this screen · 7 in all", SheetCopy.notes(2, 7))
        assertNull(SheetCopy.notesFooter(withPins = 0, onBoard = 0, others = 0))
        assertEquals("4 more on other screens.", SheetCopy.notesFooter(withPins = 0, onBoard = 0, others = 4))
        assertEquals("2 more here: tap their pins.", SheetCopy.notesFooter(withPins = 2, onBoard = 0, others = 0))
        assertEquals("2 more here: tap their pins. 1 more on other screens.", SheetCopy.notesFooter(withPins = 2, onBoard = 0, others = 1))
        assertEquals("2 more here: tap their pins. 3 more here are on the board.", SheetCopy.notesFooter(withPins = 2, onBoard = 3, others = 0))
        assertEquals("open · People only · 2h ago", SheetCopy.noteRow("open", peopleOnly = true, ago = "2h ago"))
        assertEquals("revert requested", SheetCopy.noteRow("revert_requested", peopleOnly = false, ago = null))
    }

    @Test
    fun theNotesListShowsTheNotesThatHaveNoPin() {
        // Notes 1 to 30 on a screen; the even ones have pins (the odd ones were made on the web, say).
        val listing = notesListing((1..30).toList()) { it % 2 == 0 }
        assertEquals((1..10) + (11..29 step 2), listing.rows)
        assertEquals(10, listing.withPins)
        assertEquals(0, listing.onBoard)

        // A screen with far more notes than pins: those past the list's room are on the board.
        val crowded = notesListing((1..400).toList()) { it > 250 }
        assertEquals(SheetCopy.NOTES_SHOWN + SheetCopy.UNPINNED_SHOWN, crowded.rows.size)
        assertEquals(150, crowded.withPins)
        assertEquals(240 - SheetCopy.UNPINNED_SHOWN, crowded.onBoard)

        // A few notes, all shown.
        assertEquals(listOf(1, 2, 3), notesListing(listOf(1, 2, 3)) { true }.rows)
    }

    @Test
    fun aNotesHeaderAndTheOtherSheetsSubtitles() {
        assertEquals("Note 3", SheetCopy.noteTitle(3))
        assertEquals("Note", SheetCopy.noteTitle(0))
        assertEquals("Dom · 2h ago", SheetCopy.byline("Dom", "2h ago"))
        assertEquals("2h ago", SheetCopy.byline(null, "2h ago"))
        assertNull(SheetCopy.byline(null, null))
        assertEquals("Removes the note on this device", SheetCopy.clear(1))
        assertEquals("Removes all 4 from this device", SheetCopy.clear(4))
        assertEquals("Project shop · Dev mode", SheetCopy.settings("shop", NotatoMode.DEV))
    }

    @Test
    fun aLongThreadSaysHowManyRepliesAreOnlyOnTheBoard() {
        // The card shows the last four, as the React Native and Flutter cards do, in the same words.
        assertEquals(4, SheetCopy.THREAD_SHOWN)
        assertNull(SheetCopy.earlier(0))
        assertNull(SheetCopy.earlier(4))
        assertEquals("1 earlier on the board.", SheetCopy.earlier(5))
        assertEquals("16 earlier on the board.", SheetCopy.earlier(20))
    }

    @Test
    fun buttonsSitSideBySideInEqualWidthsOnlyWhileEachFitsItsShare() {
        assertTrue(buttonsFit(listOf(100, 120), room = 300, gap = 10))
        // 2 × 160 + 10 is more than 300, though 100 + 160 + 10 would fit: equal widths or one above the other.
        assertFalse(buttonsFit(listOf(100, 160), room = 300, gap = 10))
        assertTrue(buttonsFit(listOf(400), room = 300, gap = 10))
    }
}
