package dev.notato.android.compose

import androidx.compose.ui.Modifier
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.node.SemanticsModifierNode
import androidx.compose.ui.semantics.AccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsConfiguration
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.AnnotatedString
import dev.notato.android.inspect.Box
import dev.notato.android.inspect.HostInfo
import dev.notato.android.inspect.Privacy
import dev.notato.android.inspect.ScreenElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NotatoMaskTest {
    private val host = HostInfo("AccountScreen", listOf("MainActivity"), listOf("MainActivity"), 2f)

    private fun semantics(build: SemanticsConfiguration.() -> Unit) = SemanticsConfiguration().apply(build)

    private fun describe(c: SemanticsConfiguration, privacy: Privacy = Privacy.DEFAULT, maskInputs: Boolean = false, inside: String? = null): ScreenElement? =
        NotatoCompose.describe(c, Box(0f, 0f, 200f, 100f), host, maskInputs, privacy, { inside })

    private fun SemanticsConfiguration.textField(value: String, label: String) {
        this[SemanticsActions.SetText] = AccessibilityAction(null) { true }
        this[SemanticsProperties.EditableText] = AnnotatedString(value)
        this[SemanticsProperties.Text] = listOf(AnnotatedString(label))
    }

    @Test
    fun theModifierOnlySetsTheMark() {
        for (masked in listOf(true, false)) {
            val element = Modifier.notatoMask(masked) as ModifierNodeElement<*>
            val node = element.create() as SemanticsModifierNode
            val config = SemanticsConfiguration()
            with(node) { config.applySemantics() }
            assertEquals(masked, config.getOrNull(NotatoMaskKey))
            // Nothing merged or cleared: TalkBack reads the same.
            assertFalse(node.shouldMergeDescendantSemantics)
            assertFalse(node.shouldClearDescendantSemantics)
            assertFalse(config.isMergingSemanticsOfDescendants)
        }
    }

    @Test
    fun aNodeIsAsPrivateAsWhatItSitsIn() {
        val plain = semantics { }
        val marked = semantics { this[NotatoMaskKey] = true }
        val shown = semantics { this[NotatoMaskKey] = false }
        assertEquals(Privacy.DEFAULT, NotatoCompose.privacyOf(plain, Privacy.DEFAULT))
        assertEquals(Privacy.PRIVATE, NotatoCompose.privacyOf(marked, Privacy.DEFAULT))
        assertEquals(Privacy.PRIVATE, NotatoCompose.privacyOf(plain, Privacy.PRIVATE))
        assertEquals(Privacy.SHOWN, NotatoCompose.privacyOf(shown, Privacy.DEFAULT))
        assertEquals(Privacy.SHOWN, NotatoCompose.privacyOf(plain, Privacy.SHOWN))
        // A private container wins over a field in it marked not private.
        assertEquals(Privacy.PRIVATE, NotatoCompose.privacyOf(shown, Privacy.PRIVATE))
    }

    @Test
    fun aPrivateNodeSaysNothing() {
        val name = semantics {
            this[SemanticsProperties.Text] = listOf(AnnotatedString("Ada Lovelace"))
            this[SemanticsProperties.ContentDescription] = listOf("Ada's name")
            this[SemanticsProperties.TestTag] = "account_name"
        }
        val plain = describe(name)!!
        assertEquals("Ada Lovelace", plain.text)
        assertFalse(plain.isMasked)

        val hidden = describe(name, Privacy.PRIVATE)!!
        assertNull(hidden.text)
        assertNull(hidden.label)
        assertNull(hidden.words)
        assertTrue(hidden.isMasked)
        assertTrue(hidden.isCovered(maskInputs = false))
        // What it is and its test tag are not the person's data.
        assertEquals("text", hidden.role)
        assertEquals("account_name", hidden.identifier)
    }

    @Test
    fun aPrivateControlSaysNothingOfWhatIsInsideIt() {
        val pay = semantics {
            this[SemanticsProperties.Role] = Role.Button
            this[SemanticsActions.OnClick] = AccessibilityAction(null) { true }
        }
        assertEquals("Pay 4242", describe(pay, inside = "Pay 4242")!!.label)
        val hidden = describe(pay, Privacy.PRIVATE, inside = "Pay 4242")!!
        assertNull(hidden.label)
        assertNull(hidden.text)
    }

    @Test
    fun whatAPrivateNodeIsSetToIsLeftOut() {
        val toggle = semantics {
            this[SemanticsProperties.Role] = Role.Switch
            this[SemanticsProperties.ToggleableState] = ToggleableState.On
            this[SemanticsProperties.Selected] = true
        }
        assertEquals("on", describe(toggle)!!.styles!!["state"])
        val styles = describe(toggle, Privacy.PRIVATE)!!.styles!!
        assertNull(styles["state"])
        assertNull(styles["selected"])
        assertNotNull(styles["width"])
    }

    @Test
    fun aGroupingMarkedPrivateIsKeptSoItIsCovered() {
        assertNull(describe(semantics { }))
        assertNull(describe(semantics { this[NotatoMaskKey] = false }))
        // Inside a private container but with nothing to say of its own: its own elements are covered instead.
        assertNull(describe(semantics { }, Privacy.PRIVATE))
        val card = describe(semantics { this[NotatoMaskKey] = true }, Privacy.PRIVATE)!!
        assertTrue(card.isMasked)
        assertEquals("Composable", card.control)
    }

    @Test
    fun textFieldsFollowMaskInputsUnlessMarked() {
        val email = semantics { textField("ada@example.com", "Email") }
        // Shown in dev mode, by default.
        assertEquals("ada@example.com", describe(email)!!.text)
        // maskInputs: the value is left out, the label is not, and the field is covered.
        val masked = describe(email, maskInputs = true)!!
        assertNull(masked.text)
        assertEquals("Email", masked.label)
        assertTrue(masked.isCovered(maskInputs = true))
        // Marked not private (a search box): shown and recorded even so.
        val search = describe(semantics { textField("trail shoes", "Search") }, Privacy.SHOWN, maskInputs = true)!!
        assertEquals("trail shoes", search.text)
        assertTrue(search.isUnmasked)
        assertFalse(search.isCovered(maskInputs = true))
        // Marked private: neither its value nor its label.
        val secret = describe(email, Privacy.PRIVATE)!!
        assertNull(secret.text)
        assertNull(secret.label)
    }

    @Test
    fun passwordFieldsAreAlwaysMasked() {
        val password = semantics {
            textField("correct horse", "Password")
            this[SemanticsProperties.Password] = Unit
        }
        for (maskInputs in listOf(false, true)) {
            val e = describe(password, Privacy.SHOWN, maskInputs)!!
            assertNull(e.text)
            assertEquals("Password", e.label)
            assertTrue(e.isCovered(maskInputs))
        }
    }
}
