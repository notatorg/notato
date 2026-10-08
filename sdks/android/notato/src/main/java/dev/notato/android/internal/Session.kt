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

/** What is selected, and the picture taken when it was. */
internal class Selection(
    /** The element and everything around it, innermost first; [index] is the one selected. */
    val chain: List<ScreenElement>,
    var index: Int,
    val all: List<ScreenElement>,
    val screen: CapturedScreen?,
) {
    val element: ScreenElement get() = chain[index]

    /** The outline and the name the overlay draws for it. A private element shows no words: only what it is and its id. */
    fun drawing(): SelectionDrawing {
        val e = element
        var title = e.control + (e.identifier?.let { " #$it" } ?: "")
        e.words?.takeIf { e.kind != "area" && !e.isMasked }?.let { title += " “${if (it.length > 28) it.take(27) + "…" else it}”" }
        return SelectionDrawing(listOf(e.bounds), title)
    }

    /** What screenshots cover: private elements (and all in them), secure fields, and text fields when inputs are masked. */
    fun masks(maskInputs: Boolean): List<Box> = (all + element).filter { it.isCovered(maskInputs) }.map { it.bounds }.distinct()
}

/**
 * Notato in one Activity: the overlay in its top window, what is selected, which screen it shows (its route), and the
 * reading of that screen the pins were last placed from.
 */
internal class Session(val activity: Activity, private val controller: Controller) : OverlayActions {
    /** The window root the overlay is in, and where picking and screenshots look. */
    var root: ViewGroup? = null
        private set
    var selection: Selection? = null

    /** The screen showing, as notes name it; empty until it is first worked out. */
    var route: String = ""
        private set

    /** The overlay's frame count when the route was last worked out, and when that was. */
    private var routeFrame = -1L
    private var routeAt = 0L

    /** The last reading of the screen for the pins, indexed; the frame it was taken at, and when. */
    private var scan: ScanIndex? = null
    private var scanFrame = -1L
    private var lastScan = 0L

    /** What the pins were last placed with: the frame of the reading used, and the notes' version. */
    private var placedFrame = -1L
    private var placedVersion = -1L

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
        selection?.screen?.release()
        selection = null
    }

    fun detach() {
        dropSelection()
        overlay.hideKeyboard()
        (overlay.parent as? ViewGroup)?.removeView(overlay)
        root = null
    }

    // ---- the route: which screen shows -----------------------------------------------------------------------------

    /** The Activity, its Fragments, and the screen composable showing now: `/MainActivity/ProductListScreen`. */
    fun currentRoute(): String {
        val activityName = activity.javaClass.simpleName
        val root = root ?: return "/$activityName"
        // The View in the middle of the window says which Fragment shows; a ComposeView says which screen composable.
        val (inside, screen) = ViewInspector.screenAt(root, root.width / 2f, root.height / 2f)
        val parts = mutableListOf(activityName)
        parts += inside
        screen?.let { if (it !in parts) parts += it }
        ViewInspector.providedScreen(root)?.let { if (it !in parts) parts += it }
        return "/" + parts.joinToString("/")
    }

    /**
     * Works the route out again when the screen may have changed: after the window has drawn, once it has been still
     * for a quarter of a second (or each second while it keeps drawing). A screen that is still costs nothing.
     */
    fun updateRoute() {
        val now = SystemClock.uptimeMillis()
        val due = route.isEmpty() ||
            overlay.frames != routeFrame && (now - overlay.lastFrameAt >= ROUTE_SETTLE_MS || now - routeAt >= ROUTE_MAX_AGE_MS)
        if (!due) return
        routeFrame = overlay.frames
        routeAt = now
        val next = currentRoute()
        if (next != route) {
            route = next
            scan = null
            placedFrame = -1
            overlay.render()
        }
    }

    // ---- pins ------------------------------------------------------------------------------------------------------

    /**
     * Puts the pins of [notes] (this screen's that have one, numbered) where their elements are now. When the window
     * has drawn nothing since they were placed and no note changed ([version]), they are where they were and nothing is
     * worked out. The screen is read at most twice a second, and only once it has drawn since the last reading.
     */
    fun placePins(version: Long, maskInputs: Boolean, notes: () -> List<Pair<Int, NoteRecord>>) {
        val frames = overlay.frames
        if (placedFrame == frames && placedVersion == version) return
        val shown = notes()
        val root = root
        if (shown.isEmpty() || root == null) {
            overlay.showPins(emptyList())
            placedFrame = frames
            placedVersion = version
            return
        }
        val now = SystemClock.uptimeMillis()
        val reading = scan?.takeIf { scanFrame == frames || now - lastScan < SCAN_MIN_GAP_MS }
            ?: ScanIndex(ViewInspector.elements(root, maskInputs, lite = true)).also {
                scan = it
                scanFrame = frames
                lastScan = now
            }
        val density = root.resources.displayMetrics.density
        overlay.showPins(
            shown.map { (number, record) ->
                val a = record.annotation
                val found = record.liveBounds(maskInputs) ?: record.selector()?.let { reading.first(it)?.bounds }
                val r = a.target.rect
                val stored = Box((r.x * density).toFloat(), (r.y * density).toFloat(), ((r.x + r.w) * density).toFloat(), ((r.y + r.h) * density).toFloat())
                PinDrawing(a.id, number, a.status, found ?: stored, found == null, record.pending)
            },
        )
        // A reading older than the last frame: placed again on the next tick, and read again once it may be.
        placedFrame = scanFrame
        placedVersion = version
    }

    /** Pins turned off: none drawn, and placed afresh when they are turned on again. */
    fun hidePins() {
        overlay.showPins(emptyList())
        placedFrame = -1
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

    private companion object {
        /** The route is worked out again once the window has been still this long... */
        const val ROUTE_SETTLE_MS = 250L

        /** ...or this long after the last time, while it keeps drawing. */
        const val ROUTE_MAX_AGE_MS = 1000L

        /** The pins read the screen at most this often. */
        const val SCAN_MIN_GAP_MS = 500L
    }
}
