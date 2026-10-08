package dev.notato.android.internal

import dev.notato.android.inspect.ScreenElement
import dev.notato.android.inspect.Selectors

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
