package dev.notato.android

import dev.notato.android.inspect.Box
import dev.notato.android.inspect.Privacy
import dev.notato.android.inspect.ScreenElement
import dev.notato.android.inspect.Selectors
import dev.notato.android.inspect.ViewInspector
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** What is private: covered in screenshots, and none of its words in a note or its selector. */
class MaskingTest {
    private fun of(vararg marks: Boolean?) = Privacy.of(marks.asSequence())

    @Test
    fun aMarkCountsOnTheElementAndEverythingInIt() {
        assertEquals(Privacy.DEFAULT, of())
        assertEquals(Privacy.DEFAULT, of(null, null))
        assertEquals(Privacy.PRIVATE, of(true))
        // Innermost first: a field in a private container is private.
        assertEquals(Privacy.PRIVATE, of(null, null, true))
        assertEquals(Privacy.SHOWN, of(false))
        assertEquals(Privacy.SHOWN, of(null, false))
    }

    @Test
    fun aPrivateContainerWinsOverAFieldMarkedNotPrivate() {
        assertEquals(Privacy.PRIVATE, of(false, true))
        assertEquals(Privacy.PRIVATE, of(false, null, true))
        assertEquals(Privacy.PRIVATE, of(true, false))
    }

    @Test
    fun handingPrivacyDownTheTreeAgreesWithReadingUpIt() {
        val marks = listOf(null, true, false)
        for (a in marks) for (b in marks) for (c in marks) {
            // a is the outermost: down from the root, then up from the element.
            val down = Privacy.DEFAULT.withMark(a).withMark(b).withMark(c)
            assertEquals("$a $b $c", of(c, b, a), down)
        }
        assertEquals(Privacy.PRIVATE, Privacy.PRIVATE.withMark(false))
        assertEquals(Privacy.SHOWN, Privacy.SHOWN.withMark(null))
    }

    @Test
    fun whatIsHidden() {
        for (maskInputs in listOf(false, true)) {
            // Plain text: only when private.
            assertFalse(Privacy.DEFAULT.hides(isTextInput = false, isSecure = false, maskInputs = maskInputs))
            assertFalse(Privacy.SHOWN.hides(isTextInput = false, isSecure = false, maskInputs = maskInputs))
            assertTrue(Privacy.PRIVATE.hides(isTextInput = false, isSecure = false, maskInputs = maskInputs))
            // Password fields always, even marked not private.
            for (privacy in Privacy.entries) assertTrue(privacy.hides(isTextInput = true, isSecure = true, maskInputs = maskInputs))
            // A field marked not private never is (unless it is a password field).
            assertFalse(Privacy.SHOWN.hides(isTextInput = true, isSecure = false, maskInputs = maskInputs))
            assertTrue(Privacy.PRIVATE.hides(isTextInput = true, isSecure = false, maskInputs = maskInputs))
        }
        // Other text fields follow maskInputs.
        assertTrue(Privacy.DEFAULT.hides(isTextInput = true, isSecure = false, maskInputs = true))
        assertFalse(Privacy.DEFAULT.hides(isTextInput = true, isSecure = false, maskInputs = false))
    }

    private fun element(
        role: String?,
        text: String? = null,
        id: String? = null,
        top: Float = 0f,
        input: Boolean = false,
        secure: Boolean = false,
        masked: Boolean = false,
        unmasked: Boolean = false,
    ) = ScreenElement(
        "view", role, text, text, id, if (input) "EditText" else "TextView", Box(0f, top, 100f, top + 40f),
        isTextInput = input, isSecure = secure, isMasked = masked, isUnmasked = unmasked,
    )

    @Test
    fun aPrivateElementHasNoWords() {
        // Even when a provider hands over text with it.
        val card = element("text", "4242 4242 4242 4242", masked = true)
        assertNull(card.words)
        assertEquals(Privacy.PRIVATE, card.privacy)
        assertFalse(card.toString().contains("4242"))
        assertEquals("4242 4242 4242 4242", element("text", "4242 4242 4242 4242").words)
    }

    @Test
    fun screenshotsCoverPrivateElementsSecureFieldsAndMaskedInputs() {
        assertTrue(element("text", masked = true).isCovered(maskInputs = false))
        assertFalse(element("text").isCovered(maskInputs = true))
        assertTrue(element("textbox", input = true, secure = true, unmasked = true).isCovered(maskInputs = false))
        assertTrue(element("textbox", input = true).isCovered(maskInputs = true))
        assertFalse(element("textbox", input = true).isCovered(maskInputs = false))
        // A search box marked not private.
        assertFalse(element("textbox", input = true, unmasked = true).isCovered(maskInputs = true))
    }

    private val screen = listOf(
        element("text", "Ada Lovelace", top = 0f, masked = true),
        element("text", "Your account", top = 100f),
        element("text", "ada@example.com", top = 200f, masked = true),
        element("textbox", "4242 4242", id = "card_number", top = 300f, input = true, masked = true),
    )

    @Test
    fun aPrivateElementsSelectorNeverUsesItsText() {
        assertEquals("text:nth(1)", Selectors.make(screen[0], screen, null))
        assertEquals("AccountScreen text:nth(3)", Selectors.make(screen[2], screen, "AccountScreen"))
        // An id, when it has one.
        assertEquals("#card_number", Selectors.make(screen[3], screen, null))
        // The text of what is not private still is.
        assertEquals("text:text(\"Your account\")", Selectors.make(screen[1], screen, null))
        for (e in screen) {
            val selector = Selectors.make(e, screen, null)
            assertFalse(selector, listOf("Ada", "ada@", "4242").any { selector.contains(it) })
            assertTrue(Selectors.same(Selectors.query(selector, screen).single(), e))
        }
    }

    @Test
    fun aPrivateElementCannotBeFoundByItsText() {
        assertTrue(Selectors.query("text:text(\"Lovelace\")", screen).isEmpty())
        assertTrue(Selectors.query("*:text(\"4242\")", screen).isEmpty())
        assertEquals(1, Selectors.query("text:text(\"account\")", screen).size)
    }

    @Test
    fun aPasswordIsTheInputTypesClassAndVariationTogether() {
        val text = android.text.InputType.TYPE_CLASS_TEXT
        val number = android.text.InputType.TYPE_CLASS_NUMBER
        val datetime = android.text.InputType.TYPE_CLASS_DATETIME
        assertTrue(ViewInspector.isPasswordType(text or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD))
        assertTrue(ViewInspector.isPasswordType(text or android.text.InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD))
        assertTrue(ViewInspector.isPasswordType(text or android.text.InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD))
        assertTrue(ViewInspector.isPasswordType(number or android.text.InputType.TYPE_NUMBER_VARIATION_PASSWORD))
        // Flags (multi-line, no suggestions) do not change what it is.
        assertTrue(ViewInspector.isPasswordType(text or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD or android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS))
        // The number password's variation bits are also a URI's and a date's.
        assertFalse(ViewInspector.isPasswordType(text or android.text.InputType.TYPE_TEXT_VARIATION_URI))
        assertFalse(ViewInspector.isPasswordType(datetime or android.text.InputType.TYPE_DATETIME_VARIATION_DATE))
        assertFalse(ViewInspector.isPasswordType(number))
        assertFalse(ViewInspector.isPasswordType(text or android.text.InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS))
        assertFalse(ViewInspector.isPasswordType(number or android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL))
    }
}
