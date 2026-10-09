package dev.notato.android.internal

import android.app.Activity
import android.os.SystemClock
import android.view.ViewGroup
import dev.notato.android.inspect.Box
import dev.notato.android.inspect.ScreenElement
import dev.notato.android.inspect.ViewInspector
import dev.notato.android.overlay.OverlayActions
import dev.notato.android.overlay.OverlayRoot
import dev.notato.android.overlay.PinDrawing
import dev.notato.android.overlay.SelectionDrawing
import dev.notato.android.overlay.SheetBuilder
import kotlinx.coroutines.CompletableDeferred

/** The picture taken for a note, and the reading of the screen taken just after it. */
internal class Shot(
    /** The window without Notato's overlay, or null when screenshots are off or it could not be taken. */
    val screen: CapturedScreen?,
    /** Every element on screen then: what to cover in [screen], and what the note's selector must tell its element apart from. */
    val all: List<ScreenElement>,
)

/**
 * A [Shot] on its way: taken once the composer has opened, so a tap opens it at once. Send waits for it; a selection
 * dropped first gives the picture back as soon as it arrives. Main thread only.
 */
internal class PendingShot {
    private val done = CompletableDeferred<Shot>()
    private var taken: Shot? = null
    private var released = false

    fun complete(shot: Shot) {
        taken = shot
        if (released) shot.screen?.release()
        done.complete(shot)
    }

    suspend fun await(): Shot = done.await()

    /** Done with: the picture's memory goes back now, or as soon as it has been taken. */
    fun release() {
        released = true
        taken?.screen?.release()
    }

    companion object {
        /** One taken already: a note made from code reads the screen before it selects. */
        fun of(shot: Shot): PendingShot = PendingShot().apply { complete(shot) }
    }
}

/** What is selected, and the picture taken for it. */
internal class Selection(
    /** The element and everything around it, innermost first; [index] is the one selected. */
    val chain: List<ScreenElement>,
    var index: Int,
    /**
     * The picture and the reading of the screen. A tap on another element while the composer is open makes a new
     * selection with the same one: the screen under the composer has not changed.
     */
    val shot: PendingShot,
) {
    val element: ScreenElement get() = chain[index]

    /** The outline and the name the overlay draws for it. A private element shows no words: only what it is and its id. */
    fun drawing(): SelectionDrawing {
        val e = element
        var title = e.control + (e.identifier?.let { " #$it" } ?: "")
        e.words?.takeIf { e.kind != "area" && !e.isMasked }?.let { title += " “${if (it.length > 28) it.take(27) + "…" else it}”" }
        return SelectionDrawing(listOf(e.bounds), title)
    }

    /**
     * What screenshots cover, from [all] (the shot's reading) and the element itself: private elements (and all in
     * them), secure fields, and text fields when inputs are masked.
     */
    fun masks(all: List<ScreenElement>, maskInputs: Boolean): List<Box> =
        (all + element).filter { it.isCovered(maskInputs) }.map { it.bounds }.distinct()
}

/**
 * Notato in one Activity: the overlay in its top window, what is selected, which screen it shows (its route), and when
 * the route and the pins are worked out again.
 */
internal class Session(val activity: Activity, private val controller: Controller) : OverlayActions {
    /** The window root the overlay is in, and where picking and screenshots look. */
    var root: ViewGroup? = null
        private set
    var selection: Selection? = null

    /** The screen showing, as notes name it; empty until it is first worked out. */
    var route: String = ""
        private set

    /** When the route is worked out again. */
    private val routeCadence = Cadence()

    /** When the pins are placed again, and what they were last placed with: the notes' version and the route. */
    private val pinCadence = Cadence()
    private var placedVersion = -1L
    private var placedRoute: String? = null

    // Last: the overlay draws itself as it is made, and asks this session for its state.
    val overlay = OverlayRoot(activity, this)

    /** Puts the overlay in the top window, moving it into a full-screen dialog while one shows. */
    fun attach() {
        val top = Windows.top(activity) ?: return
        if (top !== root) {
            (overlay.parent as? ViewGroup)?.removeView(overlay)
            top.addView(overlay, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            root = top
            overlay.requestApplyInsets()
        } else if (top.indexOfChild(overlay) != top.childCount - 1) {
            overlay.bringToFront()
        }
    }

    /** Drops the selection, and the picture taken for it. */
    fun dropSelection() {
        selection?.shot?.release()
        selection = null
    }

    fun detach() {
        dropSelection()
        overlay.hideKeyboard()
        (overlay.parent as? ViewGroup)?.removeView(overlay)
        root = null
    }

    // ---- the route: which screen shows -----------------------------------------------------------------------------

    /**
     * The Activity, its Fragments, and the screen composable showing now: `/MainActivity/ProductListScreen`. Not
     * [settled] (the window is still drawing), the screen composable may be the one worked out last.
     */
    fun currentRoute(settled: Boolean = true): String {
        val activityName = activity.javaClass.simpleName
        val root = root ?: return "/$activityName"
        // The View in the middle of the window says which Fragment shows; a ComposeView says which screen composable.
        val (inside, screen) = ViewInspector.screenAt(root, root.width / 2f, root.height / 2f)
        val parts = mutableListOf(activityName)
        parts += inside
        screen?.let { if (it !in parts) parts += it }
        ViewInspector.providedScreen(root, settled)?.let { if (it !in parts) parts += it }
        return "/" + parts.joinToString("/")
    }

    /**
     * Works the route out again when the screen may have changed (see [Cadence]). While the window keeps drawing, a
     * Compose screen is the one worked out last: reading its compositions again mid-scroll would stall the scroll. A
     * screen that is still costs nothing. Returns true while it is to be worked out again once the window is still.
     */
    fun updateRoute(now: Long = SystemClock.uptimeMillis()): Boolean {
        val frames = overlay.frames
        if (routeCadence.due(frames, overlay.lastFrameAt, now, changed = route.isEmpty())) {
            val next = currentRoute(settled = routeCadence.settled)
            if (next != route) {
                route = next
                overlay.render()
            }
        }
        return routeCadence.pending(frames)
    }

    // ---- pins ------------------------------------------------------------------------------------------------------

    /**
     * Puts the pins of [notes] (this screen's that have one, numbered) where their elements are, reading the screen to
     * find them: at once when a note or the route changed, else once the window has been still for a moment after
     * drawing, and every couple of seconds while it keeps drawing. Between readings each pin follows its element
     * frame by frame ([Follower]), so readings can be this rare. Returns true while a settled reading is still to come.
     */
    fun placePins(version: Long, maskInputs: Boolean, now: Long = SystemClock.uptimeMillis(), notes: () -> List<Pair<Int, NoteRecord>>): Boolean {
        val frames = overlay.frames
        val changed = placedVersion != version || placedRoute != route
        if (!pinCadence.due(frames, overlay.lastFrameAt, now, changed)) return pinCadence.pending(frames)
        placedVersion = version
        placedRoute = route
        val shown = notes()
        val root = root
        if (shown.isEmpty() || root == null) {
            overlay.showPins(emptyList())
            return pinCadence.pending(frames)
        }
        val reading = ScanIndex(ViewInspector.elements(root, maskInputs, lite = true))
        val density = root.resources.displayMetrics.density
        overlay.showPins(
            shown.map { (number, record) ->
                val a = record.annotation
                val found = record.live(maskInputs) ?: record.selector()?.let { reading.first(it) }
                val r = a.target.rect
                val stored = Box((r.x * density).toFloat(), (r.y * density).toFloat(), ((r.x + r.w) * density).toFloat(), ((r.y + r.h) * density).toFloat())
                PinDrawing(a.id, number, a.status, found?.bounds ?: stored, found == null, record.pending, found?.let { Follower.of(it) })
            },
        )
        return pinCadence.pending(frames)
    }

    /** Pins turned off: none drawn, and placed afresh when they are turned on again. */
    fun hidePins() {
        overlay.showPins(emptyList())
        placedVersion = -1
    }

    // ---- what the overlay asks of Notato ---------------------------------------------------------------------------

    override val isAnnotating get() = controller.annotating
    override val isToolbarVisible get() = controller.toolbarVisible
    override val pinsVisible get() = controller.pinsVisible
    override val count get() = controller.recordsOnRoute(this).size
    override val connection get() = controller.sync.connection
    override val toolbarFraction get() = controller.toolbarFraction
    override val toolbarDragged get() = controller.fold.position != null
    override val toolbarCollapsed get() = controller.fold.collapsed
    override val toolbarHeldRight get() = controller.fold.heldRight
    override val toolbarReturning get() = controller.fold.returning
    override fun dragToolbar(fraction: Pair<Float, Float>) = controller.dragToolbar(fraction)
    override fun keepToolbarAt(fraction: Pair<Float, Float>) = controller.fold.keep(fraction)

    override fun toggleAnnotating() = if (controller.annotating) controller.stopAnnotating() else controller.startAnnotating()
    override fun stopAnnotating() = controller.stopAnnotating()
    override fun pick(x: Float, y: Float) = controller.pick(this, x, y)
    override fun openMenu() = overlay.showSheet(SheetBuilder(controller, this).menu(), dim = true)
    override fun setToolbarCollapsed(collapsed: Boolean) = controller.setToolbarCollapsed(collapsed)
    override fun openPin(id: String) = controller.openPin(this, id)
    override fun sheetClosed(wasComposer: Boolean) {
        if (wasComposer) controller.cancelSelection(this)
    }

    override fun drew() = controller.wake()

    // A full-screen dialog is laid out a frame or two after it takes the focus: looked for a little while.
    override fun windowsChanged() = controller.wake(forMs = 1000)

}

/**
 * When something worked out from the screen (the route, the pins) is worked out again, from the frames the window
 * draws: at once when what it depends on has [changed]; once the window has been still for [settleMs] after drawing (a
 * scroll, a transition or an animation has ended); and while it keeps drawing, every [slowMs] at most. A window that
 * draws nothing costs nothing. Plain numbers, so it can be tested without a window.
 */
internal class Cadence(private val settleMs: Long = 250, private val slowMs: Long = 2000) {
    private var frame = -1L

    /** When the window was first seen to have drawn since it was last worked out: the slow interval runs from there. */
    private var drawingSince = -1L

    /** Whether the window was still the last time it was worked out. */
    var settled = false
        private set

    /** Whether it is due now, given the window's frame count and when it last drew; when it is, it counts as done. */
    fun due(frames: Long, lastFrameAt: Long, now: Long, changed: Boolean = false): Boolean {
        val still = now - lastFrameAt >= settleMs
        if (frames != frame && drawingSince < 0) drawingSince = now
        val due = changed || frame < 0 || frames != frame && (still || now - drawingSince >= slowMs) || !settled && still
        if (due) {
            frame = frames
            drawingSince = -1
            settled = still
        }
        return due
    }

    /** Whether it will be due again with nothing else changing: the window has drawn since, or was not still then. */
    fun pending(frames: Long): Boolean = frames != frame || !settled
}
