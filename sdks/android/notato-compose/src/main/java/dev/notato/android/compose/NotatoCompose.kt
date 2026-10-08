package dev.notato.android.compose

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ContextWrapper
import android.view.View
import android.view.ViewGroup
import androidx.compose.runtime.Recomposer
import androidx.compose.runtime.tooling.CompositionData
import androidx.compose.ui.layout.LayoutInfo
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.platform.findViewTreeCompositionContext
import androidx.compose.ui.platform.isDebugInspectorInfoEnabled
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsConfiguration
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.tooling.data.Group
import androidx.compose.ui.tooling.data.NodeGroup
import androidx.compose.ui.tooling.data.SourceLocation
import androidx.compose.ui.tooling.data.UiToolingDataApi
import androidx.compose.ui.tooling.data.asTree
import dev.notato.android.Notato
import dev.notato.android.inspect.Box
import dev.notato.android.inspect.ElementProvider
import dev.notato.android.inspect.HostInfo
import dev.notato.android.inspect.Privacy
import dev.notato.android.inspect.ScreenElement
import dev.notato.android.model.ComponentInfo
import java.util.IdentityHashMap
import java.util.Locale
import kotlin.math.absoluteValue

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
@OptIn(UiToolingDataApi::class)
public object NotatoCompose : ElementProvider {
    /**
     * Registers with Notato and, when [sourceInfo] is on, turns on Compose's inspection data. That must happen before
     * the first composition, so `Notato.start` (from `Application.onCreate` or the manifest) calls it.
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

    // ---- source -------------------------------------------------------------------------------------------------------

    internal class Source(
        val composable: String?,
        val location: dev.notato.android.model.SourceLocation?,
        val component: ComponentInfo?,
        val screen: String?,
    )

    /**
     * The slot tables of every composition in a ComposeView (lazy list items and dialogs are compositions of their
     * own), read as trees, with each layout node's place in them.
     */
    internal class SourceIndex private constructor(tables: Collection<CompositionData>, windowTables: Collection<CompositionData>) {
        private val parents = IdentityHashMap<Group, Group>()
        private val nodes = IdentityHashMap<Any, Group>()
        private val userCache = IdentityHashMap<Group, Boolean>()

        /** Calls that open a window of their own (`Dialog(…)` in SizeGuideDialog), in the compositions of the app's window. */
        private val windowCalls = ArrayList<Group>()

        init {
            for (table in tables) read(table, collectWindowCalls = false)
            for (table in windowTables) read(table, collectWindowCalls = true)
        }

        private fun read(table: CompositionData, collectWindowCalls: Boolean) {
            val tree = runCatching { table.asTree() }.getOrNull() ?: return
            val stack = ArrayDeque<Group>()
            stack.addLast(tree)
            while (stack.isNotEmpty()) {
                val group = stack.removeLast()
                if (group is NodeGroup) nodes.putIfAbsent(group.node, group)
                if (collectWindowCalls && group.name in windowComposables && isUser(group.location)) windowCalls += group
                for (child in group.children) {
                    parents[child] = group
                    stack.addLast(child)
                }
            }
        }

        /**
         * The groups from the outermost composition down to [layout]'s node (or from [group]), joining compositions where
         * they nest.
         */
        private fun pathTo(layout: LayoutInfo?, group: Group? = null): List<Group> {
            val out = ArrayDeque<Group>()
            var start = group
            var info: LayoutInfo? = layout
            var guard = 0
            while (guard++ < 256) {
                if (start == null) {
                    if (info == null) break
                    start = nodes[info]
                    if (start == null) {
                        info = info.parentInfo
                        continue
                    }
                }
                var current: Group? = start
                var outermostNode: LayoutInfo? = null
                val segment = ArrayList<Group>()
                while (current != null) {
                    segment += current
                    (current as? NodeGroup)?.let { outermostNode = it.node as? LayoutInfo }
                    current = parents[current]
                }
                for (g in segment) out.addFirst(g)
                // A composition inside another (a lazy list's items) hangs off a layout node of the outer one.
                start = null
                info = outermostNode?.parentInfo ?: break
            }
            return out
        }

        /** A call made from the app's code. The compiler hashes every package; an unknown hash (-1) is library code. */
        private fun isUser(location: SourceLocation?): Boolean =
            location?.sourceFile != null && location.packageHash != -1 && location.packageHash !in libraryHashes

        /**
         * Whether [group] could be a composable of the app's own: library code can reach the app's composables only
         * through lambdas, which have no name, so a named call made from library code (`CompositionLocalProvider` in
         * MaterialTheme) is the library's. A call site Compose could not place is given the benefit of the doubt.
         */
        private fun calledFromApp(group: Group): Boolean {
            val at = group.location ?: return true
            return at.sourceFile == null || at.packageHash == -1 || isUser(at)
        }

        /**
         * Whether [group] is a call of a composable written in the app: the calls in its own body are app code. Only
         * groups without a location (structure, not calls) are looked through; a content lambda has a location (where it
         * is invoked), so `CompositionLocalProvider { app code }` is not taken for app code.
         */
        private fun writtenInApp(group: Group): Boolean = userCache.getOrPut(group) {
            val pending = ArrayDeque(group.children)
            var seen = 0
            while (pending.isNotEmpty() && seen++ < 64) {
                val child = pending.removeFirst()
                if (child.location != null) {
                    if (isUser(child.location)) return@getOrPut true
                } else {
                    pending.addAll(child.children)
                }
            }
            false
        }

        /** Whether [layout]'s node was in the compositions when they were read. */
        fun knows(layout: LayoutInfo): Boolean = nodes.containsKey(layout)

        fun sourceOf(layout: LayoutInfo): Source? {
            var path = pathTo(layout)
            if (path.isEmpty()) return null
            // The innermost call made from app code is where the element is written: `Button(…)` in ProductRow.kt.
            var callIndex = path.indices.reversed().firstOrNull { i -> path[i].name != null && isUser(path[i].location) } ?: return null
            // In a dialog's window, the dialog's own composition starts at its content: put the call that opened it in
            // front, preferring one in the same file as the element.
            if (windowCalls.isNotEmpty()) {
                val file = path[callIndex].location?.sourceFile
                val opener = windowCalls.lastOrNull { it.location?.sourceFile == file } ?: windowCalls.last()
                val prefix = pathTo(null, opener)
                path = prefix + path
                callIndex += prefix.size
            }
            val call = path[callIndex]
            val functions = (0 until callIndex).map { path[it] }
                .filter { g -> g.name != null && !g.isInline && calledFromApp(g) && writtenInApp(g) }
                .mapNotNull { it.name }
                .filter { it.firstOrNull()?.isUpperCase() == true }
            val location = call.location!!
            val file = location.sourceFile!!
            val enclosing = functions.lastOrNull()
            val screen = functions.lastOrNull { name -> screenSuffixes.any { name.endsWith(it) } }
            return Source(
                composable = call.name,
                // Compose records the line (from 1) but no column: 1 points at the line.
                location = dev.notato.android.model.SourceLocation(file, location.lineNumber.coerceAtLeast(1), 1),
                component = enclosing?.let { ComponentInfo(it, file, functions.takeIf { f -> f.size >= 2 }) },
                screen = screen,
            )
        }

        companion object {
            private class Cached(val changes: Long, val tables: Int, val at: Long, val index: SourceIndex)

            /**
             * How many times the Recomposer of [view]'s window has applied changes: the compositions are as they were
             * while it stays the same. -1 when it cannot be found (a dialog's window, whose compositions hang off the
             * activity's).
             */
            private fun changesOf(view: View): Long =
                (runCatching { view.findViewTreeCompositionContext() }.getOrNull() as? Recomposer)?.changeCount ?: -1

            @Suppress("UNCHECKED_CAST")
            private fun tablesOf(view: View): List<CompositionData> =
                (view.getTag(androidx.compose.ui.R.id.inspection_slot_table_set) as? Set<CompositionData>)?.toList() ?: emptyList()

            /** The Compose views in the activity's own window, when [view] is in another (a dialog's). */
            private fun windowViews(view: View): List<View> {
                val activity = generateSequence(view.context) { (it as? ContextWrapper)?.baseContext }.filterIsInstance<Activity>().firstOrNull()
                val decor = activity?.window?.peekDecorView() ?: return emptyList()
                if (view.rootView === decor) return emptyList()
                val found = mutableListOf<View>()
                fun visit(v: View) {
                    if (v is ViewRootForTest) found += v else if (v is ViewGroup) for (i in 0 until v.childCount) visit(v.getChildAt(i))
                }
                visit(decor)
                return found
            }

            /**
             * Reading the slot tables walks every composition, so an index is reused while the compositions have not
             * changed (the same Recomposer count and the same number of compositions), for up to [maxAgeMs]; without a
             * count to go by, for half a second at most. It is kept on the view, not in a static: it holds the view's
             * layout nodes, and through them its activity, which a static would keep alive after the activity is gone.
             */
            fun of(view: View, maxAgeMs: Long = 500): SourceIndex? {
                val now = android.os.SystemClock.uptimeMillis()
                val tables = tablesOf(view).ifEmpty { return null }
                val changes = changesOf(view)
                (view.getTag(R.id.notato_source_index) as? Cached)?.let { cached ->
                    val same = cached.tables == tables.size && cached.changes == changes
                    val limit = if (changes >= 0) maxAgeMs else minOf(maxAgeMs, 500)
                    if (same && now - cached.at < limit) return cached.index
                }
                return SourceIndex(tables, windowViews(view).flatMap { tablesOf(it) })
                    .also { view.setTag(R.id.notato_source_index, Cached(changes, tables.size, now, it)) }
            }
        }
    }

    private val screenSuffixes = listOf("Screen", "Page", "Route", "Destination", "Dialog", "Sheet")

    /** Composables that show their content in a window of their own. */
    private val windowComposables = setOf("Dialog", "AlertDialog", "BasicAlertDialog", "DatePickerDialog", "TimePickerDialog", "ModalBottomSheet", "Popup")

    /**
     * The package hashes Compose records for AndroidX's own composables (the compiler hashes the package name as
     * `String.hashCode` does). A call from one of these is library code, so the search goes on up to the app's call.
     */
    private val libraryHashes: Set<Int> = listOf(
        "androidx.compose.animation", "androidx.compose.animation.core", "androidx.compose.animation.graphics.vector",
        "androidx.compose.foundation", "androidx.compose.foundation.gestures", "androidx.compose.foundation.interaction",
        "androidx.compose.foundation.layout", "androidx.compose.foundation.lazy", "androidx.compose.foundation.lazy.grid",
        "androidx.compose.foundation.lazy.layout", "androidx.compose.foundation.lazy.staggeredgrid", "androidx.compose.foundation.pager",
        "androidx.compose.foundation.selection", "androidx.compose.foundation.shape", "androidx.compose.foundation.text",
        "androidx.compose.foundation.text.input", "androidx.compose.foundation.text.input.internal",
        "androidx.compose.foundation.text.input.internal.selection", "androidx.compose.foundation.text.modifiers",
        "androidx.compose.foundation.text.selection", "androidx.compose.foundation.text.contextmenu",
        "androidx.compose.foundation.contextmenu", "androidx.compose.foundation.window",
        "androidx.compose.material", "androidx.compose.material.internal", "androidx.compose.material.ripple",
        "androidx.compose.material.icons", "androidx.compose.material.icons.filled", "androidx.compose.material.pullrefresh",
        "androidx.compose.material3", "androidx.compose.material3.internal", "androidx.compose.material3.tokens",
        "androidx.compose.material3.carousel", "androidx.compose.material3.pulltorefresh", "androidx.compose.material3.adaptive",
        "androidx.compose.material3.adaptive.layout", "androidx.compose.material3.adaptive.navigation",
        "androidx.compose.material3.adaptive.navigationsuite", "androidx.compose.material3.windowsizeclass",
        "androidx.compose.runtime", "androidx.compose.runtime.internal", "androidx.compose.runtime.livedata",
        "androidx.compose.runtime.rxjava2", "androidx.compose.runtime.rxjava3", "androidx.compose.runtime.saveable",
        "androidx.compose.ui", "androidx.compose.ui.awt", "androidx.compose.ui.graphics", "androidx.compose.ui.graphics.vector",
        "androidx.compose.ui.input", "androidx.compose.ui.layout", "androidx.compose.ui.node", "androidx.compose.ui.platform",
        "androidx.compose.ui.res", "androidx.compose.ui.semantics", "androidx.compose.ui.text", "androidx.compose.ui.tooling",
        "androidx.compose.ui.tooling.preview", "androidx.compose.ui.viewinterop", "androidx.compose.ui.window",
        "androidx.activity.compose", "androidx.lifecycle.compose", "androidx.lifecycle.viewmodel.compose",
        "androidx.navigation.compose", "androidx.navigation3.ui", "androidx.navigation3.runtime", "androidx.paging.compose",
        "androidx.constraintlayout.compose", "androidx.hilt.navigation.compose", "androidx.wear.compose.material",
        "androidx.wear.compose.material3", "androidx.wear.compose.foundation", "androidx.tv.material3",
        "androidx.compose.ui.unit", "androidx.compose.ui.draw",
    ).map(::packageHash).toSet()

    /** The hash Compose's compiler writes after `#` in source information. */
    internal fun packageHash(name: String): Int = name.fold(0) { hash, char -> hash * 31 + char.code }.absoluteValue
}
