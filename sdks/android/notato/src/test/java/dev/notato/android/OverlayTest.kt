package dev.notato.android

import dev.notato.android.internal.Hider
import dev.notato.android.overlay.PinSpread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/** Pins spread out, and the overlay hidden for captures. */
class OverlayTest {
    // In dp, at a density of 1: a 28dp pin, overlapping within 20dp, moved 22dp at a time.
    private fun spread(wanted: List<Pair<Float, Float>>, width: Float = 400f, height: Float = 800f) =
        PinSpread.place(wanted, near = 20f, step = 22f, minX = 2f, maxX = width - 28f - 2f, minY = 24f, maxY = height - 28f)

    private fun overlapping(places: List<Pair<Float, Float>>) =
        places.indices.any { i -> (0 until i).any { j -> abs(places[i].first - places[j].first) < 20f && abs(places[i].second - places[j].second) < 20f } }

    @Test(timeout = 2_000)
    fun twoNotesOnAnElementAtTheLeftEdgeSitSideBySide() {
        // An element whose right edge is under 34dp: both pins clamp to the left margin, and the search must still end.
        val places = spread(listOf(2f to 100f, 2f to 100f))
        assertEquals(2f to 100f, places[0])
        assertEquals(24f to 100f, places[1])
    }

    @Test(timeout = 2_000)
    fun manyNotesNearTheLeftEdgeAreAllPlaced() {
        val places = spread(List(12) { 10f to 300f })
        assertEquals(12, places.size)
        assertTrue(!overlapping(places))
    }

    @Test
    fun aSecondNoteGoesToTheLeftAsBefore() {
        assertEquals(listOf(200f to 100f, 178f to 100f), spread(listOf(200f to 100f, 200f to 100f)))
    }

    @Test(timeout = 2_000)
    fun withNoRoomLeftTheyOverlapRatherThanSearchForever() {
        val places = spread(List(200) { 100f to 100f })
        assertEquals(200, places.size)
        // A window narrower than a pin: every place is the same one.
        assertEquals(3, spread(List(3) { 2f to 30f }, width = 20f, height = 40f).size)
    }

    private class Overlay(var alpha: Float = 1f)

    private fun hider() = Hider<Overlay, Float>({ it.alpha }, { overlay, value -> overlay.alpha = value }, 0f)

    @Test
    fun overlappingCapturesShowTheOverlayAgainWhenTheLastEnds() {
        val hider = hider()
        val overlay = Overlay()
        hider.hide(overlay) // an agent's capture
        hider.hide(overlay) // a tap during it
        assertEquals(0f, overlay.alpha)
        hider.show(overlay) // the agent's ends first
        assertEquals(0f, overlay.alpha)
        hider.show(overlay)
        assertEquals(1f, overlay.alpha)
        // Shown once more by mistake: nothing changes.
        hider.show(overlay)
        assertEquals(1f, overlay.alpha)
    }

    @Test
    fun anOverlayComesBackAsItWasBeforeTheFirstCapture() {
        val hider = hider()
        val overlay = Overlay(0.5f)
        hider.hide(overlay)
        hider.hide(overlay)
        hider.show(overlay)
        hider.show(overlay)
        assertEquals(0.5f, overlay.alpha)
    }
}
