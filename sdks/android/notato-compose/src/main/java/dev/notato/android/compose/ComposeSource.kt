package dev.notato.android.compose

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ContextWrapper
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import androidx.compose.runtime.Recomposer
import androidx.compose.runtime.tooling.CompositionData
import androidx.compose.ui.layout.LayoutInfo
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.platform.findViewTreeCompositionContext
import androidx.compose.ui.tooling.data.Group
import androidx.compose.ui.tooling.data.NodeGroup
import androidx.compose.ui.tooling.data.SourceLocation
import androidx.compose.ui.tooling.data.UiToolingDataApi
import androidx.compose.ui.tooling.data.asTree
import dev.notato.android.model.ComponentInfo
import java.util.IdentityHashMap
import kotlin.math.absoluteValue
import dev.notato.android.model.SourceLocation as NoteSourceLocation

// Where a composable is written, from Compose's inspection data (the slot tables Android Studio's Layout Inspector reads).

/** Where an element is written: the call that made it, the composables around it, and the screen it is on. */
internal class Source(
    val composable: String?,
    val location: NoteSourceLocation?,
    val component: ComponentInfo?,
    val screen: String?,
)

/**
 * The slot tables of every composition in a ComposeView (lazy list items and dialogs are compositions of their
 * own), read as trees, with each layout node's place in them.
 */
@OptIn(UiToolingDataApi::class)
@SuppressLint("VisibleForTests") // ViewRootForTest finds the Compose views in a dialog's activity window.
internal class SourceIndex private constructor(tables: Collection<CompositionData>, windowTables: Collection<CompositionData>) {
    private val parents = IdentityHashMap<Group, Group>()
    private val nodes = IdentityHashMap<Any, Group>()
    private val userCache = IdentityHashMap<Group, Boolean>()

    /** Calls that open a window of their own (`Dialog(…)` in SizeGuideDialog), in the compositions of the app's window. */
    private val windowCalls = ArrayList<Group>()

    /** The screen composable, for the route, once it has been worked out from this index (it can be none). */
    var screenWorkedOut = false
    var screen: String? = null

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
            location = NoteSourceLocation(file, location.lineNumber.coerceAtLeast(1), 1),
            component = enclosing?.let { ComponentInfo(it, file, functions.takeIf { f -> f.size >= 2 }) },
            screen = screen,
        )
    }

    companion object {
        private class Cached(val changes: Long, val tables: Int, val at: Long, val index: SourceIndex) {
            /** When the compositions were first seen to have moved on from these, while the index went on being used. */
            var behindSince = -1L
        }

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
            val now = SystemClock.uptimeMillis()
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

        /**
         * The index read last for [view], without reading the compositions again even when they have changed: unless
         * they have been seen to differ from it for [maxBehindMs] or more. Null when there is none to use.
         */
        fun last(view: View, maxBehindMs: Long): SourceIndex? {
            val cached = view.getTag(R.id.notato_source_index) as? Cached ?: return null
            val tables = (view.getTag(androidx.compose.ui.R.id.inspection_slot_table_set) as? Set<*>)?.size ?: 0
            if (cached.tables == tables && cached.changes == changesOf(view)) return cached.index
            val now = SystemClock.uptimeMillis()
            if (cached.behindSince < 0) cached.behindSince = now
            return cached.index.takeIf { now - cached.behindSince < maxBehindMs }
        }
    }
}

/** The endings that make a composable a screen, for the route: `ProductScreen`, `SizeGuideDialog`. */
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
