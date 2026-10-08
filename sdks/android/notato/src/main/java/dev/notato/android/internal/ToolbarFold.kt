package dev.notato.android.internal

import dev.notato.android.ToolbarCorner

/**
 * Whether the toolbar is folded into its one round button, where it is, and the side it is held to.
 *
 * The person's choice (folded or not, and where a dragged toolbar is) is remembered in [state]. Annotating while it is
 * folded opens it for as long as annotating lasts without remembering that: a launch mid-annotation comes back folded,
 * where the round button was.
 */
internal class ToolbarFold(private val state: RuntimeState, private val corner: ToolbarCorner) {
    /** Opened because annotating (or selecting, from any trigger) started while it was folded: it folds again after. */
    var openedForAnnotate = false
        private set

    /** Where a dragged toolbar is while it is open for annotating: in memory only, like that opening. */
    private var annotatingAt: Pair<Float, Float>? = null

    /** The held side, once a fold or open has started; in memory only, and forgotten when the toolbar is moved. */
    private var held: Boolean? = null

    /** Where a dragged toolbar was before the last fold or open: the next one goes back there. Memory only, like [held]. */
    private var returnTo: Pair<Float, Float>? = null

    /**
     * The last fold or open put a dragged toolbar back where it was before the one before (its [position] is set
     * already), rather than keeping its held edge. So fold, open, fold comes back to the very same spot, even when the
     * open bar did not fit on the held side and had to be pushed inside the margins.
     */
    var returning = false
        private set

    /** Folded now. */
    val collapsed: Boolean get() = state.toolbarCollapsed && !openedForAnnotate

    /** Where it was dragged to, as fractions of the room it moves in; null while it is still in its corner. */
    val position: Pair<Float, Float>? get() = annotatingAt ?: state.toolbarPosition

    /**
     * The side it folds toward and opens away from, and its chevron points at. Worked out from where it is when a fold
     * or open starts, then kept: a wide bar opened from a circle just right of the middle can end up mostly in the left
     * half, and folding it again must still go right, back to where the circle was.
     */
    val heldRight: Boolean get() = held ?: toolbarHeldRight(position, corner)

    /** Moved by hand: remembered, and the held side is worked out again from there, with nowhere to go back to. */
    fun moved(to: Pair<Float, Float>) {
        state.toolbarPosition = to
        annotatingAt = null
        held = null
        returnTo = null
        returning = false
    }

    /** Where a fold or open that kept its held edge left a dragged toolbar, at its new width. */
    fun keep(at: Pair<Float, Float>) {
        if (openedForAnnotate) annotatingAt = at else state.toolbarPosition = at
    }

    /** Folded or opened by hand (the chevron, the round button). True when that changed what shows. */
    fun set(collapsed: Boolean): Boolean {
        val was = this.collapsed
        val at = position
        // What showed for annotating becomes the person's own.
        annotatingAt?.let { state.toolbarPosition = it }
        annotatingAt = null
        openedForAnnotate = false
        state.toolbarCollapsed = collapsed
        return changed(was, at)
    }

    /** Annotating started or stopped. True when that changed what shows. */
    fun annotating(active: Boolean): Boolean {
        val was = collapsed
        val at = position
        if (active && collapsed) openedForAnnotate = true
        if (!active && openedForAnnotate) {
            openedForAnnotate = false
            annotatingAt = null
        }
        return changed(was, at)
    }

    /** After a fold or open: [at] is where the toolbar was when it started. */
    private fun changed(was: Boolean, at: Pair<Float, Float>?): Boolean {
        if (collapsed == was) return false
        held = held ?: toolbarHeldRight(at, corner)
        // A toolbar still in its corner stays there (and undragged): its held edge is the corner's anyway.
        if (at == null) {
            returning = false
            return true
        }
        val back = returnTo
        returning = back != null
        returnTo = at
        if (back != null) keep(back)
        return true
    }
}

/**
 * The side the toolbar is held to when nothing has fixed it yet: once dragged, the nearer half of the room it moves in;
 * until then, its configured corner.
 */
internal fun toolbarHeldRight(dragged: Pair<Float, Float>?, corner: ToolbarCorner): Boolean =
    dragged?.let { it.first >= 0.5f } ?: (corner == ToolbarCorner.BOTTOM_END || corner == ToolbarCorner.TOP_END)

/**
 * Where a toolbar that has not been dragged sits, as fractions of the room it moves in. Bottom corners start a little
 * up, clear of a navigation bar; people drag it where they like.
 */
internal fun cornerFraction(corner: ToolbarCorner): Pair<Float, Float> = when (corner) {
    ToolbarCorner.BOTTOM_START -> 0f to 0.86f
    ToolbarCorner.TOP_END -> 1f to 0.06f
    ToolbarCorner.TOP_START -> 0f to 0.06f
    ToolbarCorner.BOTTOM_END -> 1f to 0.86f
}
