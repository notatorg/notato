package dev.notato.android

import dev.notato.android.inspect.Box
import dev.notato.android.inspect.ScreenElement
import dev.notato.android.inspect.Selectors
import dev.notato.android.internal.MAX_PINS
import dev.notato.android.internal.NoteRecord
import dev.notato.android.internal.ScanIndex
import dev.notato.android.internal.pinned
import dev.notato.android.overlay.PinSpread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.random.Random

/** Which notes get a pin, finding their elements, and spreading the pins out: quick with many notes. */
class PinsTest {
    private fun record(id: String, platform: String = "android"): NoteRecord {
        val note = Fixture.annotation()
        return NoteRecord(note.copy(id = id, environment = note.environment.copy(platform = platform)))
    }

    @Test
    fun onlyNotesMadeOnAndroidGetPinsAndTheyKeepTheirNumbers() {
        val onRoute = listOf(1 to record("A"), 2 to record("WEB", "web"), 3 to record("B"), 4 to record("IOS", "ios"))
        assertEquals(listOf(1 to "A", 3 to "B"), pinned(onRoute).map { (n, r) -> n to r.annotation.id })
    }

    @Test
    fun aScreenWithManyNotesPinsTheNewest() {
        val onRoute = (1..400).map { it to record("N$it") }
        val pins = pinned(onRoute)
        assertEquals(MAX_PINS, pins.size)
        assertEquals(400 - MAX_PINS + 1, pins.first().first)
        assertEquals(400, pins.last().first)
    }

    private fun element(role: String?, text: String?, id: String? = null, control: String = "Text", top: Float = 0f) =
        ScreenElement("compose", role, text, text, id, control, Box(0f, top, 100f, top + 40f))

    @Test
    fun theIndexFindsWhatTheSelectorFinds() {
        val random = Random(7)
        val roles = listOf("text", "button", "heading", null)
        val controls = listOf("Text", "MaterialButton", "TextView", "ProductRow")
        val elements = (0 until 600).map { i ->
            element(roles[random.nextInt(roles.size)], "Item ${i % 37}", id = if (i % 11 == 0) "row_${i % 5}" else null, control = controls[random.nextInt(controls.size)], top = i * 10f)
        }
        val index = ScanIndex(elements)
        val selectors = listOf(
            "#row_3", "#row_3:nth(2)", "#missing", "button", "button:text(\"Item 4\")", "button:text(\"Item 4\"):nth(3)",
            "MATERIALBUTTON:text(\"item 12\")", "textview", "productrow:nth(40)", "*:text(\"Item 36\")", ":text(\"Item 2\"):nth(5)",
            "text:nth(999)", "heading#row_0", "ShopScreen text:text(\"Item 9\")",
        )
        for (raw in selectors) {
            val parsed = Selectors.parse(raw)
            assertSame(raw, Selectors.query(raw, elements).firstOrNull(), index.first(parsed))
            // Asked again (another note on the same element): the same answer.
            assertSame(raw, Selectors.query(raw, elements).firstOrNull(), index.first(parsed))
        }
    }

    // In dp, at a density of 1: a 28dp pin, overlapping within 20dp, moved 22dp at a time.
    private fun spread(wanted: List<Pair<Float, Float>>) = PinSpread.place(wanted, near = 20f, step = 22f, minX = 2f, maxX = 370f, minY = 24f, maxY = 772f)

    /** The spread as it was before the grid: every spot checked against every pin placed. */
    private fun spreadByHand(wanted: List<Pair<Float, Float>>): List<Pair<Float, Float>> {
        val placed = ArrayList<Pair<Float, Float>>()
        val offsets = listOf(0, -1, -2, -3, 1, 2, 3)
        for ((x, y) in wanted) {
            var spot: Pair<Float, Float>? = null
            search@ for (row in 0..3) {
                for (offset in offsets) {
                    val cx = (x + offset * 22f).coerceIn(2f, 370f)
                    val cy = (y + row * 22f).coerceIn(24f, 772f)
                    if (placed.none { abs(it.first - cx) < 20f && abs(it.second - cy) < 20f }) {
                        spot = cx to cy
                        break@search
                    }
                }
            }
            placed += spot ?: (x to y)
        }
        return placed
    }

    @Test
    fun theGridPlacesPinsWhereCheckingEveryPinWould() {
        val random = Random(42)
        repeat(20) {
            // Crowded: a few elements with many notes each, and some anywhere.
            val wanted = List(150) {
                if (random.nextBoolean()) (random.nextInt(4) * 90f + 10f) to (random.nextInt(4) * 120f + 40f)
                else random.nextFloat() * 400f to random.nextFloat() * 800f
            }
            assertEquals(spreadByHand(wanted), spread(wanted))
        }
    }

    @Test(timeout = 5_000)
    fun manyPinsOnOneElementAreSpreadQuickly() {
        val wanted = List(MAX_PINS) { 180f to 300f }
        val started = System.nanoTime()
        repeat(100) { spread(wanted) }
        val each = (System.nanoTime() - started) / 100 / 1_000
        println("Spread $MAX_PINS pins on one element in $each µs")
        assertEquals(MAX_PINS, spread(wanted).size)
        assertTrue(each < 50_000)
    }
}
