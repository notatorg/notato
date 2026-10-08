package dev.notato.android.compose

import android.annotation.SuppressLint
import android.view.View
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.platform.isDebugInspectorInfoEnabled
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsConfiguration
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.state.ToggleableState
import dev.notato.android.Notato
import dev.notato.android.inspect.Box
import dev.notato.android.inspect.ElementProvider
import dev.notato.android.inspect.HostInfo
import dev.notato.android.inspect.Privacy
import dev.notato.android.inspect.ScreenElement
import dev.notato.android.model.ComponentInfo
import java.util.Locale

/**
 * Notato for Jetpack Compose. Notato sees into a `ComposeView` through its semantics (what TalkBack reads), and
 * finds where each element is written (file and line, and the composables around it) from Compose's inspection data,
 * as Android Studio's Layout Inspector does.
 *
 * Nothing to call: with this artifact on the classpath, `Notato.start` installs it. Mark what is private with
 * [notatoMask].
 */
// ViewRootForTest is how Compose's own test tools reach a ComposeView's semantics, as Notato does here.
@SuppressLint("VisibleForTests")
public object NotatoCompose : ElementProvider {
    /**
     * Registers with Notato and, when [sourceInfo] is on, turns on Compose's inspection data. That must happen before
     * the first composition, so `Notato.start` (from `Application.onCreate` or the manifest) calls it: an app need not.
     */
    @JvmStatic
    public fun install(sourceInfo: Boolean) {
        Notato.register(this)
        if (sourceInfo) isDebugInspectorInfoEnabled = true
    }

    override fun handles(view: View): Boolean = view is ViewRootForTest

    // The unmerged tree: a row people tap as one (merged for TalkBack) still has its price as an element of its own,
    // so a note can be about the price. A tap on a button's label still means the button (see chainAt).
    // Privacy is handed down the tree from the ComposeView's own: a node is as private as what it sits in, or more.

    override fun elements(view: View, host: HostInfo, maskInputs: Boolean): List<ScreenElement> {
        val root = (view as ViewRootForTest).semanticsOwner.unmergedRootSemanticsNode
        val out = mutableListOf<ScreenElement>()
        fun visit(node: SemanticsNode, above: Privacy) {
            if (node.boundsInWindow.isEmpty) return
            val privacy = privacyOf(node.config, above)
            describe(node, host, maskInputs, null, privacy)?.let { out += it }
            for (child in node.children) visit(child, privacy)
        }
        visit(root, host.privacy)
        return out
    }

    override fun chainAt(view: View, x: Float, y: Float, host: HostInfo, maskInputs: Boolean): List<ScreenElement> {
        val root = (view as ViewRootForTest).semanticsOwner.unmergedRootSemanticsNode
        val path = mutableListOf<Pair<SemanticsNode, Privacy>>()
        var current: SemanticsNode? = root
        var privacy = host.privacy
        while (current != null) {
            privacy = privacyOf(current.config, privacy)
            path += current to privacy
            // Later children draw over earlier ones.
            current = current.children.asReversed().firstOrNull { child ->
                val r = child.boundsInWindow
                !r.isEmpty && x >= r.left && x < r.right && y >= r.top && y < r.bottom
            }
        }
        // Picking needs the compositions as they are now (a lazy list composes its rows as it scrolls, which the
        // Recomposer does not count): an index that does not know the node picked is read again.
        var index = SourceIndex.of(view)
        if (index != null && path.size > 1 && !index.knows(path.last().first.layoutInfo)) index = SourceIndex.of(view, maxAgeMs = 0)
        val described = path.asReversed().mapNotNull { (node, p) -> describe(node, host, maskInputs, index, p)?.let { node to it } }
        // A control that reads as one thing (a button, a checkbox, a chip) is picked whole, not its label.
        val control = described.indexOfFirst { (node, _) ->
            node.config.isMergingSemanticsOfDescendants && node.config.contains(SemanticsProperties.Role)
        }
        return (if (control > 0) described.drop(control) else described).map { it.second }
    }

    override fun screenOf(view: View, host: HostInfo): String? {
        // The screen composable is in the outermost composition: the index is reused until the compositions change.
        val index = SourceIndex.of(view, maxAgeMs = Long.MAX_VALUE) ?: return null
        // The first elements, outermost first, whose source is known: they are on the screen composable.
        val pending = ArrayDeque(listOf((view as ViewRootForTest).semanticsOwner.unmergedRootSemanticsNode))
        var tried = 0
        while (pending.isNotEmpty() && tried++ < 40) {
            val node = pending.removeFirst()
            index.sourceOf(node.layoutInfo)?.screen?.let { return it }
            pending.addAll(node.children)
        }
        return null
    }

    /** A node's privacy, from its own [notatoMask] and the privacy of what it sits in. */
    internal fun privacyOf(config: SemanticsConfiguration, above: Privacy): Privacy = above.withMark(config.getOrNull(NotatoMaskKey))

    /** The text inside a node that reads as one thing, as TalkBack would read it, without what is marked private. */
    private fun textInside(node: SemanticsNode): String? {
        if (!node.config.isMergingSemanticsOfDescendants) return null
        val parts = mutableListOf<String>()
        fun walk(n: SemanticsNode) {
            for (child in n.children) {
                if (child.config.isMergingSemanticsOfDescendants || child.config.getOrNull(NotatoMaskKey) == true) continue
                child.config.getOrNull(SemanticsProperties.Text)?.forEach { parts += it.text }
                walk(child)
            }
        }
        walk(node)
        return parts.joinToString(" ").ifBlank { null }
    }

    // ---- semantics ---------------------------------------------------------------------------------------------------

    private fun roleName(role: Role): String? = when (role) {
        Role.Button -> "button"
        Role.Checkbox -> "checkbox"
        Role.Switch -> "switch"
        Role.RadioButton -> "radio"
        Role.Tab -> "tab"
        Role.Image -> "img"
        Role.DropdownList -> "combobox"
        Role.ValuePicker -> "slider"
        Role.Carousel -> "list"
        else -> null
    }

    /** What a composable is called when its source is not known: from its role, so selectors stay the same either way. */
    private fun controlFor(role: String?): String = when (role) {
        "button" -> "Button"
        "checkbox" -> "Checkbox"
        "switch" -> "Switch"
        "radio" -> "RadioButton"
        "tab" -> "Tab"
        "img" -> "Image"
        "combobox" -> "DropdownMenu"
        "textbox" -> "TextField"
        "heading", "text" -> "Text"
        "progressbar" -> "ProgressIndicator"
        "slider" -> "Slider"
        "list" -> "List"
        "dialog" -> "Dialog"
        else -> "Composable"
    }

    private fun clip(text: String?): String? = text?.trim()?.replace(Regex("\\s+"), " ")?.ifEmpty { null }?.let { if (it.length > 200) it.take(199) + "…" else it }

    private fun describe(node: SemanticsNode, host: HostInfo, maskInputs: Boolean, index: SourceIndex?, privacy: Privacy): ScreenElement? {
        val r = node.boundsInWindow
        return describe(node.config, Box(r.left, r.top, r.right, r.bottom), host, maskInputs, privacy, { textInside(node) }) {
            index?.sourceOf(node.layoutInfo)
        }
    }

    /**
     * An element from a node's semantics, or null for a node that says nothing a person could point at. Only the node's
     * own configuration, the text [inside] it and where it is written ([source]), so the rules can be tested without a
     * composition.
     */
    internal fun describe(
        c: SemanticsConfiguration, bounds: Box, host: HostInfo, maskInputs: Boolean, privacy: Privacy,
        inside: () -> String? = { null }, source: () -> Source? = { null },
    ): ScreenElement? {
        // A private node says nothing: no text, label or content description, and nothing it is set to.
        val hidden = privacy == Privacy.PRIVATE
        val texts = c.getOrNull(SemanticsProperties.Text)?.joinToString(" ") { it.text } ?: inside()
        val editable = c.getOrNull(SemanticsProperties.EditableText)?.text
        val description = c.getOrNull(SemanticsProperties.ContentDescription)?.joinToString(" ")
        val tag = c.getOrNull(SemanticsProperties.TestTag)
        val secure = c.contains(SemanticsProperties.Password)
        val input = c.contains(SemanticsActions.SetText) || c.contains(SemanticsProperties.EditableText)
        val clickable = c.contains(SemanticsActions.OnClick)
        val toggle = c.getOrNull(SemanticsProperties.ToggleableState)
        val progress = c.getOrNull(SemanticsProperties.ProgressBarRangeInfo)
        val scrolls = c.contains(SemanticsProperties.VerticalScrollAxisRange) || c.contains(SemanticsProperties.HorizontalScrollAxisRange) ||
            c.contains(SemanticsProperties.CollectionInfo)
        val dialog = c.contains(SemanticsProperties.IsDialog)
        val heading = c.contains(SemanticsProperties.Heading)
        val role = c.getOrNull(SemanticsProperties.Role)?.let { roleName(it) } ?: when {
            input -> "textbox"
            heading -> "heading"
            progress != null -> if (c.contains(SemanticsActions.SetProgress)) "slider" else "progressbar"
            dialog -> "dialog"
            scrolls -> "list"
            clickable -> "button"
            texts != null -> "text"
            description != null -> "img"
            else -> null
        }
        // Layout-only nodes and plain groupings say nothing a person could point at; one marked private is kept, to be
        // covered in screenshots.
        if (role == null && tag == null && toggle == null && c.getOrNull(NotatoMaskKey) != true) return null

        val shownText = if (privacy.hides(input, secure, maskInputs)) null else clip(if (input) editable else texts)
        val label = if (hidden) null else clip(description) ?: (if (input) clip(texts) else null) ?: shownText
        val density = host.density.takeIf { it > 0 } ?: 1f
        val styles = linkedMapOf(
            "width" to String.format(Locale.US, "%.0fdp", bounds.width / density),
            "height" to String.format(Locale.US, "%.0fdp", bounds.height / density),
        )
        if (!hidden) {
            toggle?.let { styles["state"] = if (it == ToggleableState.On) "on" else if (it == ToggleableState.Off) "off" else "indeterminate" }
            c.getOrNull(SemanticsProperties.Selected)?.let { styles["selected"] = it.toString() }
            progress?.let { styles["progress"] = String.format(Locale.US, "%.2f of %.2f", it.current, it.range.endInclusive) }
        }
        if (c.contains(SemanticsProperties.Disabled)) styles["enabled"] = "false"

        val at = source()
        val screen = at?.screen ?: host.screen
        return ScreenElement(
            kind = "compose",
            role = role,
            label = label,
            text = shownText,
            identifier = tag,
            // The composable's own name when the source says, but only with a role to keep selectors stable.
            control = at?.composable?.takeIf { role != null } ?: controlFor(role),
            bounds = bounds,
            isTextInput = input,
            isSecure = secure,
            source = at?.location,
            component = at?.component ?: host.screen?.let { ComponentInfo(it, null, host.components.takeIf { c -> c.size >= 2 }) },
            ancestors = host.ancestors + "ComposeView",
            styles = styles,
            screen = screen,
            // Pins find composables again by selector; the View that holds them is not where they are.
            ref = null,
            isMasked = hidden,
            isUnmasked = privacy == Privacy.SHOWN,
        )
    }
}
