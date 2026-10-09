package dev.notato.android.internal

import android.graphics.Rect
import android.view.View
import dev.notato.android.inspect.Box
import dev.notato.android.inspect.ScreenElement
import dev.notato.android.inspect.Selectors
import dev.notato.android.inspect.ViewInspector
import java.lang.ref.WeakReference

/** The most pins drawn on one screen: the newest. The Notes list has every one (as in the React Native and Flutter SDKs). */
internal const val MAX_PINS = 150

/**
 * The notes on a screen that get a pin: those made on Android (a note from the web or iOS names nothing here to
 * follow, so it is only in the Notes list), and of those the newest [MAX_PINS]. [onRoute] is oldest first, numbered.
 */
internal fun pinned(onRoute: List<Pair<Int, NoteRecord>>): List<Pair<Int, NoteRecord>> =
    onRoute.filter { it.second.annotation.environment.platform == "android" }.takeLast(MAX_PINS)

/**
 * The elements of one reading of the screen, indexed by id and by type, so each note's selector is looked up rather
 * than matched against every element. What a selector finds is remembered for the reading: several notes on one
 * element (or on a list's rows) look it up once.
 */
internal class ScanIndex(val elements: List<ScreenElement>) {
    private val byId = HashMap<String, MutableList<ScreenElement>>()
    private val byType = HashMap<String, MutableList<ScreenElement>>()
    private val found = HashMap<Selectors.Parsed, ScreenElement?>()

    init {
        // In drawing order, as the elements are: an element is in its role's list and its control's, once in each.
        for (e in elements) {
            e.identifier?.let { byId.getOrPut(it) { ArrayList(1) } += e }
            val role = e.role?.lowercase()
            if (role != null) byType.getOrPut(role) { ArrayList() } += e
            val control = e.control.lowercase()
            if (control != role) byType.getOrPut(control) { ArrayList() } += e
        }
    }

    /** What [Selectors.query] would find first. */
    fun first(selector: Selectors.Parsed): ScreenElement? {
        if (found.containsKey(selector)) return found[selector]
        val type = selector.type
        // Only those that could match, still in drawing order, so :nth counts the same. A type in other scripts is
        // matched by the slow way: lowercasing it may not be how equals(ignoreCase) compares it.
        val candidates = when {
            selector.id != null -> byId[selector.id].orEmpty()
            type != null && type != "*" && type.all { it.code < 128 } -> byType[type.lowercase()].orEmpty()
            else -> elements
        }
        // The first match (or the nth): the search stops there rather than matching every candidate.
        val wanted = selector.nth ?: 1
        var seen = 0
        val first = candidates.firstOrNull { Selectors.matches(it, selector) && ++seen == wanted }
        found[selector] = first
        return first
    }
}

/**
 * The notes grouped by the screen they were made on, oldest first and numbered as their pins are, and how many wait
 * to be sent: worked out again only when [notes] has changed, not on every frame or render.
 */
internal class ScreenNotes(private val notes: NoteBook) {
    private var groupedVersion = -1L
    private var byRoute: Map<String, List<Pair<Int, NoteRecord>>> = emptyMap()
    private var waiting = 0

    /** Notes made here the server does not have yet (in test mode: not packaged yet). */
    val pending: Int
        get() {
            regroup()
            return waiting
        }

    /** The notes on a screen, oldest first, numbered as their pins are. */
    fun on(route: String): List<Pair<Int, NoteRecord>> {
        regroup()
        return byRoute[route].orEmpty()
    }

    private fun regroup() {
        if (groupedVersion == notes.version) return
        val groups = HashMap<String, MutableList<NoteRecord>>()
        var pending = 0
        for (record in notes.all) {
            groups.getOrPut(record.annotation.route) { ArrayList() } += record
            if (record.pending) pending++
        }
        val order = compareBy<NoteRecord>({ it.annotation.createdAt }, { it.annotation.id })
        byRoute = groups.mapValues { (_, list) -> list.sortedWith(order).mapIndexed { index, record -> index + 1 to record } }
        waiting = pending
        groupedVersion = notes.version
    }
}

/**
 * Where a pinned element is from one frame to the next, between readings of the screen: so a pin moves with a list as
 * it scrolls, rather than wait for the scroll to end. Only its place is asked for, never its description, so it is
 * cheap enough for every frame. Main thread only.
 */
internal interface Follower {
    /** Where the element is now, in window pixels; null once it has gone, or now shows something else. */
    fun bounds(): Box?

    /** No longer followed. */
    fun release() = Unit

    companion object {
        /** A follower for the live object behind [element], when it has one (a View, or a provider's node). */
        fun of(element: ScreenElement): Follower? {
            val ref = element.ref ?: return null
            val target = ref.get() ?: return null
            if (target is View) return ViewFollower(target)
            val provider = ViewInspector.providers.firstOrNull { runCatching { it.boundsOf(ref) }.getOrNull() != null } ?: return null
            return object : Follower {
                override fun bounds(): Box? = runCatching { provider.boundsOf(ref) }.getOrNull()
            }
        }
    }
}

/**
 * Follows a View. One taken off the window even for a moment (a list row scrolled away, which a RecyclerView can
 * bind to another item and put back within the same frame) is not followed any more: the next reading of the screen
 * finds the note's element again.
 */
private class ViewFollower(view: View) : Follower, View.OnAttachStateChangeListener {
    private val view = WeakReference(view)
    private var gone = !view.isAttachedToWindow
    private val location = IntArray(2)
    private val visible = Rect()

    init {
        view.addOnAttachStateChangeListener(this)
    }

    override fun bounds(): Box? {
        val v = view.get() ?: return null
        // Shown and not scrolled out of what holds it.
        if (gone || !v.isShown || !v.getGlobalVisibleRect(visible)) return null
        v.getLocationInWindow(location)
        return Box(location[0].toFloat(), location[1].toFloat(), (location[0] + v.width).toFloat(), (location[1] + v.height).toFloat())
    }

    override fun release() {
        view.get()?.removeOnAttachStateChangeListener(this)
    }

    override fun onViewAttachedToWindow(v: View) = Unit

    override fun onViewDetachedFromWindow(v: View) {
        gone = true
    }
}
