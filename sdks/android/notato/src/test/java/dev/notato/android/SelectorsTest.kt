package dev.notato.android

import dev.notato.android.inspect.Box
import dev.notato.android.inspect.ScreenElement
import dev.notato.android.inspect.Selectors
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** Selectors: read, matched, and made as short as they can be while finding only their element. */
class SelectorsTest {
    private fun element(
        role: String?,
        text: String? = null,
        id: String? = null,
        control: String = "Text",
        top: Float = 0f,
        label: String? = null,
        kind: String = "compose",
    ) = ScreenElement(kind, role, label ?: text, text, id, control, Box(0f, top, 100f, top + 40f))

    private val screen = listOf(
        element("heading", "Kit for the hills"),
        element("text", "£89.00", top = 100f),
        element("text", "£179.00", top = 200f),
        element("text", "£89.00", top = 300f),
        element("button", "Add to basket", id = "add_to_basket", control = "Button", top = 400f),
        element("textbox", null, id = "email", control = "TextInputEditText", label = "Email", top = 500f, kind = "view"),
    )

    @Test
    fun parsesEveryPart() {
        assertEquals(Selectors.Parsed("ShopScreen", "button", null, "Add to basket", null), Selectors.parse("ShopScreen button:text(\"Add to basket\")"))
        assertEquals(Selectors.Parsed(null, null, "sign_in", null, null), Selectors.parse("#sign_in"))
        assertEquals(Selectors.Parsed(null, "text", null, "£89", 2), Selectors.parse("text:has-text('£89'):nth(2)"))
        assertEquals(Selectors.Parsed(null, "*", null, "a \"quoted\" word", null), Selectors.parse("*:text(\"a \\\"quoted\\\" word\")"))
    }

    @Test
    fun explainsWhatIsWrongWithABadSelector() {
        assertTrue(assertThrows(Selectors.SelectorException::class.java) { Selectors.parse("button:text(\"open") }.message!!.contains("unclosed quote"))
        assertTrue(assertThrows(Selectors.SelectorException::class.java) { Selectors.parse("button:first()") }.message!!.contains(":first is not supported"))
        assertTrue(assertThrows(Selectors.SelectorException::class.java) { Selectors.parse("text:nth(0)") }.message!!.contains("positive"))
        assertTrue(assertThrows(Selectors.SelectorException::class.java) { Selectors.parse("ShopScreen :nth(2)") }.message!!.contains("expected"))
    }

    @Test
    fun findsByRoleControlIdAndTextIgnoringCase() {
        assertEquals("Add to basket", Selectors.query("button:text(\"add to\")", screen).single().text)
        assertEquals("Add to basket", Selectors.query("Button", screen).single().text)
        assertEquals("email", Selectors.query("#email", screen).single().identifier)
        // A field's label counts as its words.
        assertEquals("email", Selectors.query("textbox:text(\"Email\")", screen).single().identifier)
        assertEquals(300f, Selectors.query("ShopScreen text:text(\"£89.00\"):nth(2)", screen).single().bounds.top)
        assertTrue(Selectors.query("text:text(\"£89.00\"):nth(3)", screen).isEmpty())
    }

    @Test
    fun makesTheShortestSelectorThatFindsOnlyThatElement() {
        assertEquals("ProductScreen #add_to_basket", Selectors.make(screen[4], screen, "ProductScreen"))
        assertEquals("heading:text(\"Kit for the hills\")", Selectors.make(screen[0], screen, null))
        assertEquals("text:text(\"£89.00\"):nth(2)", Selectors.make(screen[3], screen, null))
        for (e in screen) {
            val found = Selectors.query(Selectors.make(e, screen, "ShopScreen"), screen)
            assertEquals(Selectors.make(e, screen, null), 1, found.size)
            assertTrue(Selectors.same(found.single(), e))
        }
    }

    @Test
    fun anElementDescribedAgainIsStillTheSameOne() {
        // Picking describes the screen afresh: an equal copy, not the object in the list, must still get #id and :nth.
        val copy = element("button", "Add to basket", id = "add_to_basket", control = "Button", top = 400f)
        assertEquals("#add_to_basket", Selectors.make(copy, screen, null))
        val price = element("text", "£89.00", top = 300f)
        assertEquals("text:text(\"£89.00\"):nth(2)", Selectors.make(price, screen, null))
    }

    @Test
    fun aRepeatedIdFallsBackToRoleAndText() {
        val twice = screen + element("button", "Add to basket", id = "add_to_basket", control = "Button", top = 600f)
        assertEquals("button:text(\"Add to basket\"):nth(2)", Selectors.make(twice.last(), twice, null))
    }

    @Test
    fun boxesKnowWhatTheyContain() {
        val box = Box(10f, 10f, 110f, 50f)
        assertTrue(box.contains(10f, 10f))
        assertTrue(!box.contains(110f, 30f))
        assertEquals(4000f, box.area)
        assertEquals(Box(0f, 10f, 110f, 60f), box.union(Box(0f, 20f, 20f, 60f)))
        assertNull(element(null).role)
    }
}
