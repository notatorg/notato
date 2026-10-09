package dev.notato.android.overlay

import android.animation.TimeInterpolator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.drawable.Drawable
import android.graphics.drawable.InsetDrawable
import android.graphics.drawable.LayerDrawable
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewTreeObserver
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import dev.notato.android.NotatoConnection
import dev.notato.android.inspect.Box
import dev.notato.android.inspect.ViewInspector
import dev.notato.android.internal.Follower
import kotlin.math.abs
import kotlin.math.floor

/** What the overlay draws for a selection: outlines and a name, in window pixels. Equal when it would draw the same. */
internal data class SelectionDrawing(val boxes: List<Box>, val title: String)

/** A pin as the overlay draws it, and its element followed from frame to frame (none when it was not found). */
internal data class PinDrawing(
    val id: String, val number: Int, val status: String, val box: Box, val detached: Boolean, val pending: Boolean, val follow: Follower? = null,
)

/**
 * Where pins go when several want the same spot. A pin that would cover one already placed tries the left, then the
 * right, then rows below; after a fixed number of tries it overlaps rather than search forever.
 */
internal object PinSpread {
    private const val SIDEWAYS = 3
    private const val ROWS = 3
    private val OFFSETS = (listOf(0) + (1..SIDEWAYS).map { -it } + (1..SIDEWAYS)).toIntArray()

    /**
     * [wanted] are the pins' top-left corners, in order. Two pins closer than [near] on both axes overlap; [step] is
     * how far a pin moves to get clear; every place stays within [minX]..[maxX] and [minY]..[maxY].
     *
     * The pins already placed are kept in a grid, so a spot is checked against the few pins in the cells around it
     * rather than against every pin placed: placing many stays quick however they fall.
     */
    fun place(wanted: List<Pair<Float, Float>>, near: Float, step: Float, minX: Float, maxX: Float, minY: Float, maxY: Float): List<Pair<Float, Float>> {
        val placed = ArrayList<Pair<Float, Float>>(wanted.size)
        val grid = HashMap<Long, MutableList<Pair<Float, Float>>>()
        // Cells twice as wide as a pin's reach: whatever a spot could overlap is in at most two cells each way.
        val cell = if (near > 0f) 2 * near else 1f
        fun cellOf(value: Float) = floor(value / cell).toLong()
        fun key(cx: Long, cy: Long) = (cx shl 32) xor (cy and 0xffffffffL)
        fun free(x: Float, y: Float): Boolean {
            for (cx in cellOf(x - near)..cellOf(x + near)) for (cy in cellOf(y - near)..cellOf(y + near)) {
                val there = grid[key(cx, cy)] ?: continue
                for (p in there) if (abs(p.first - x) < near && abs(p.second - y) < near) return false
            }
            return true
        }
        for ((x, y) in wanted) {
            var spot: Pair<Float, Float>? = null
            search@ for (row in 0..ROWS) {
                for (offset in OFFSETS) {
                    val cx = (x + offset * step).coerceIn(minX, maxOf(minX, maxX))
                    val cy = (y + row * step).coerceIn(minY, maxOf(minY, maxY))
                    if (free(cx, cy)) {
                        spot = cx to cy
                        break@search
                    }
                }
            }
            val place = spot ?: (x to y)
            placed += place
            grid.getOrPut(key(cellOf(place.first), cellOf(place.second))) { ArrayList(2) } += place
        }
        return placed
    }
}

/** What the overlay asks of the controller. */
internal interface OverlayActions {
    val isAnnotating: Boolean
    val isToolbarVisible: Boolean
    val pinsVisible: Boolean
    val count: Int
    val connection: NotatoConnection
    /** Where the toolbar is, as fractions of the room it moves in: its corner's until it is dragged. */
    val toolbarFraction: Pair<Float, Float>
    val toolbarDragged: Boolean
    /** Folded into its round button (or folding into it). */
    val toolbarCollapsed: Boolean
    /** The side it folds toward and opens away from. */
    val toolbarHeldRight: Boolean
    /** The fold or open going on takes a dragged toolbar back to where it was before (its fraction is set already). */
    val toolbarReturning: Boolean
    fun setToolbarCollapsed(collapsed: Boolean)
    /** Dragged there by hand. */
    fun dragToolbar(fraction: Pair<Float, Float>)
    /** Where folding or opening leaves a dragged toolbar, at its new width, with its held edge where it was. */
    fun keepToolbarAt(fraction: Pair<Float, Float>)
    fun toggleAnnotating()
    fun stopAnnotating()
    fun pick(x: Float, y: Float)
    fun openMenu()
    fun openPin(id: String)
    fun sheetClosed(wasComposer: Boolean)
    /** The window drew a frame: something on screen may have moved. */
    fun drew()
    /** The window gained or lost focus, or the overlay left it: a dialog may have opened or closed. */
    fun windowsChanged()
}

/**
 * Everything Notato draws over the app, as one full-size view in the top window: the selection, the pins, the
 * annotate hint, the toolbar, the sheets and the toast. Its layers take no touches themselves, so a touch that misses
 * Notato's controls goes on to the app's views underneath.
 */
@SuppressLint("ViewConstructor")
internal class OverlayRoot(context: Context, private val actions: OverlayActions) : FrameLayout(context) {
    val ui = Ui(context)
    private val pickSurface = PickSurface(context)
    private val marks = MarksView(context)
    private val pinLayer = ui.own(FrameLayout(context))
    private val hint: LinearLayout
    private val toolbar: ToolbarView
    private val backdrop = ui.own(View(context))

    /** Holds the sheet. One closing takes no touches on its way out: they go on to what is underneath. */
    private val sheetHost = ui.own(object : FrameLayout(context) {
        override fun dispatchTouchEvent(event: MotionEvent): Boolean = sheet != null && super.dispatchTouchEvent(event)
    })
    private val toast: TextView
    private val handler = Handler(Looper.getMainLooper())
    private val pins = HashMap<String, Pin>()

    /** A pin's view, and what it was last drawn with: its look is made again only when that changes. */
    private class Pin(val view: TextView) {
        var number = -1
        var status: String? = null
        var pending = false

        /** How opaque it is when shown: fainter when its element was not found, and it stands where the note was made. */
        var alpha = 1f

        /** Its element, followed from frame to frame; where that was when the pin was placed, and where the pin went. */
        var follow: Follower? = null
        var anchor: Box? = null
        var x = 0f
        var y = 0f

        /** Its element has left the screen since it was placed: hidden until the screen is next read. */
        var lost = false
    }

    /**
     * Frames the window has drawn since the overlay joined it, and when the last was. None since the controller last
     * looked means nothing on screen has moved (a scroll, a layout, a recomposition and an animation all draw), so the
     * pins and the route need not be worked out again.
     */
    var frames = 0L
        private set
    var lastFrameAt = 0L
        private set
    private val drawn = ViewTreeObserver.OnDrawListener {
        frames++
        lastFrameAt = SystemClock.uptimeMillis()
        actions.drew()
    }

    /** Before each frame is drawn the pins catch up with their elements, so they move in the same frame as those do. */
    private val following = ViewTreeObserver.OnPreDrawListener {
        followPins()
        true
    }

    /** A dialog opening takes the focus from the window without it drawing anything. */
    private val focus = ViewTreeObserver.OnWindowFocusChangeListener { actions.windowsChanged() }

    var safeTop = 0
        private set
    var safeBottom = 0
        private set
    var keyboard = 0
        private set
    var sheetAtTop = false
    var sheet: View? = null
        private set

    /**
     * The sheet showing was opened from the toolbar's buttons (the menu, and what was opened from it, a note from the
     * Notes list included), so folding the toolbar closes it.
     */
    val sheetFromToolbar: Boolean get() = (sheet as? BottomSheet)?.page?.place?.let(::closesWithToolbar) == true

    init {
        tag = ViewInspector.OWN_TAG
        clipChildren = false
        addView(pickSurface, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        addView(marks, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        addView(pinLayer, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))

        val done = ui.text("Done", 14f, Ui.ON_BAR_ACCENT, bold = true).apply {
            background = ui.pressable(Ui.BAR_ACCENT, Ui.over(Ui.BAR_ACCENT, Color.BLACK, 0.12f), 12)
            setPadding(ui.dp(12), ui.dp(5), ui.dp(12), ui.dp(5))
            isClickable = true
            setOnClickListener { actions.stopAnnotating() }
        }
        hint = ui.row(12, ui.text("Tap what you want to comment on", 14f, Ui.BAR_TEXT), done).apply {
            background = ui.rounded(Ui.BAR, 20, Ui.BAR_LINE, 1)
            setPadding(ui.dp(16), ui.dp(7), ui.dp(7), ui.dp(7))
            elevation = ui.dp(8).toFloat()
            isClickable = true
            visibility = GONE
        }
        addView(hint, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.CENTER_HORIZONTAL))

        toolbar = ToolbarView(ui, actions, ::toolbarRoom).apply { elevation = ui.dp(10).toFloat() }
        addView(toolbar, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))

        backdrop.setBackgroundColor(Color.argb(82, 18, 20, 24))
        backdrop.isClickable = true
        backdrop.setOnClickListener { closeSheet() }
        backdrop.visibility = GONE
        // Siblings with elevation draw by it, not by order: lift the backdrop and sheets over the toolbar's shadow.
        backdrop.translationZ = ui.dp(11).toFloat()
        sheetHost.translationZ = ui.dp(11).toFloat()
        addView(backdrop, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        addView(sheetHost, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))

        toast = ui.text("", 14f, Ui.BAR_TEXT, weight = 600).apply {
            background = ui.rounded(Ui.BAR, 18, Ui.BAR_LINE, 1)
            setPadding(ui.dp(16), ui.dp(9), ui.dp(16), ui.dp(9))
            elevation = ui.dp(12).toFloat()
            visibility = GONE
        }
        addView(toast, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.CENTER_HORIZONTAL))

        // The window's own insets, not those handed down: views above may have consumed some (the decor view takes the
        // bars it draws behind in an app that is not edge to edge), while the overlay covers the whole window.
        ViewCompat.setOnApplyWindowInsetsListener(this) { _, insets ->
            readInsets(ViewCompat.getRootWindowInsets(this) ?: insets)
            layoutInsets()
            insets
        }
        render()
    }

    /**
     * Before Android 11 (and in apps targeting older), insets stop at the first view that consumes them, and the
     * app's content, laid out before the overlay, usually does: the listener above is then never called. So the
     * window's insets are read again after each layout too, as the bars and keyboard changing lay the window out.
     */
    private val rootInsets = ViewTreeObserver.OnGlobalLayoutListener {
        ViewCompat.getRootWindowInsets(this)?.let { if (readInsets(it)) layoutInsets() }
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        viewTreeObserver.addOnGlobalLayoutListener(rootInsets)
        viewTreeObserver.addOnDrawListener(drawn)
        viewTreeObserver.addOnPreDrawListener(following)
        viewTreeObserver.addOnWindowFocusChangeListener(focus)
        // Another window (a dialog's, or the activity's again): whatever was worked out for the last one is stale.
        frames++
        ViewCompat.getRootWindowInsets(this)?.let { if (readInsets(it)) layoutInsets() }
    }

    override fun onDetachedFromWindow() {
        viewTreeObserver.removeOnGlobalLayoutListener(rootInsets)
        viewTreeObserver.removeOnDrawListener(drawn)
        viewTreeObserver.removeOnPreDrawListener(following)
        viewTreeObserver.removeOnWindowFocusChangeListener(focus)
        super.onDetachedFromWindow()
        // Its window went (a dialog closed): it goes back into the one under it.
        actions.windowsChanged()
    }

    /** Takes the safe areas and the keyboard's height from [insets]; true when they changed. */
    private fun readInsets(insets: WindowInsetsCompat): Boolean {
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
        val keyboard = (ime.bottom - bars.bottom).coerceAtLeast(0)
        if (bars.top == safeTop && bars.bottom == safeBottom && keyboard == this.keyboard) return false
        safeTop = bars.top
        safeBottom = bars.bottom
        this.keyboard = keyboard
        return true
    }

    private fun layoutInsets() {
        (hint.layoutParams as LayoutParams).topMargin = safeTop + ui.dp(8)
        (toast.layoutParams as LayoutParams).topMargin = safeTop + ui.dp(56)
        applySheetPosition()
        requestLayout()
        toolbar.place()
    }

    // ---- state from the controller ---------------------------------------------------------------------------------

    fun render() {
        // Out of the way while a note is written, and back once it is sent or cancelled.
        toolbar.centerPivot()
        Motion.reveal(toolbar, actions.isToolbarVisible && sheet !is ComposerSheet, scale = 0.9f)
        Motion.reveal(pinLayer, actions.pinsVisible)
        val annotating = actions.isAnnotating
        pickSurface.visibility = if (annotating) VISIBLE else GONE
        Motion.reveal(hint, annotating && marks.selection == null && sheet == null, offsetY = -ui.dp(12).toFloat())
        toolbar.render()
        if (!annotating && sheet == null) marks.show(null)
        (sheet as? BottomSheet)?.refresh()
    }

    fun showSelection(selection: SelectionDrawing?) = marks.show(selection)

    // ---- the toolbar is dragged anywhere, and remembered as a fraction of the room it moves in -----------------------

    /** Where the toolbar's left and top may go, for a toolbar of this size: clear of the edges, system bars and keyboard. */
    private fun toolbarRoom(w: Float, h: Float): FloatArray {
        val margin = ui.dp(12)
        val minX = margin.toFloat()
        val minY = (safeTop + margin).toFloat()
        val maxX = (width - margin - w).coerceAtLeast(minX)
        // The keyboard is measured from the navigation bar's top, so the two add up (as for the sheets).
        val maxY = (height - (safeBottom + keyboard) - margin - h).coerceAtLeast(minY)
        return floatArrayOf(minX, minY, maxX, maxY)
    }

    // ---- pins -----------------------------------------------------------------------------------------------------

    fun showPins(drawings: List<PinDrawing>) {
        if (drawings.isEmpty() && pins.isEmpty()) return
        // A 24dp circle in its status's colour with a 2dp white ring around it, as on the web.
        val size = ui.dp(28)
        val minX = 2f
        val maxX = (width - size - 2).toFloat()
        val minY = safeTop.toFloat()
        val maxY = (height - size).toFloat()
        val wanted = drawings.map { pin ->
            (pin.box.right - size / 2f).coerceIn(minX, maxX.coerceAtLeast(minX)) to (pin.box.top - size / 2f).coerceIn(minY, maxY.coerceAtLeast(minY))
        }
        // Several notes on one element: side by side, not on top of each other.
        val places = PinSpread.place(wanted, ui.dp(20).toFloat(), ui.dp(22).toFloat(), minX, maxX, minY, maxY)
        val keep = HashSet<String>(drawings.size * 2)
        for ((index, pin) in drawings.withIndex()) {
            keep += pin.id
            var fresh = false
            val held = pins.getOrPut(pin.id) {
                fresh = true
                Pin(ui.text("", 12f, Color.WHITE, maxLines = 1, weight = 800).apply {
                    gravity = Gravity.CENTER
                    isClickable = true
                    setOnClickListener { actions.openPin(pin.id) }
                    pinLayer.addView(this, LayoutParams(size, size))
                })
            }
            val view = held.view
            // Only what changed is set: setting the same text or a new drawable would lay out and draw the pin again,
            // and a window that keeps drawing never looks still.
            if (held.number != pin.number) view.text = pin.number.toString()
            if (held.status != pin.status || held.pending != pin.pending) view.background = pinLook(pin.status, pin.pending)
            if (held.number != pin.number || held.status != pin.status) {
                view.contentDescription = "Note ${pin.number}, ${pin.status.replace('_', ' ')}"
            }
            held.number = pin.number
            held.status = pin.status
            held.pending = pin.pending
            // Followed from here: where its element is now is where the pin was just placed from.
            if (held.follow !== pin.follow) held.follow?.release()
            held.follow = pin.follow
            held.anchor = pin.follow?.bounds()
            held.x = places[index].first
            held.y = places[index].second
            // These two draw again only when the value is new.
            view.translationX = held.x
            view.translationY = held.y
            val alpha = if (pin.detached) 0.55f else 1f
            when {
                fresh || held.lost -> {
                    held.alpha = alpha
                    held.lost = false
                    popIn(held, grow = true)
                }
                alpha != held.alpha -> {
                    held.alpha = alpha
                    popIn(held, grow = false)
                }
            }
        }
        val each = pins.entries.iterator()
        while (each.hasNext()) {
            val (id, held) = each.next()
            if (id !in keep) {
                held.follow?.release()
                val view = held.view
                view.setOnClickListener(null)
                view.isClickable = false
                popOut(view) { pinLayer.removeView(view) }
                each.remove()
            }
        }
    }

    /**
     * Moves the pins with their elements, before a frame is drawn: by as much as each element has moved since the pin
     * was placed, so pins spread apart stay apart. One whose element has left the screen shrinks away until the screen
     * is next read, which finds it again (or where it is now).
     */
    private fun followPins() {
        if (pins.isEmpty() || pinLayer.visibility != VISIBLE) return
        val size = ui.dp(28)
        val maxX = (width - size - 2).toFloat().coerceAtLeast(2f)
        val minY = safeTop.toFloat()
        val maxY = (height - size).toFloat().coerceAtLeast(minY)
        for (held in pins.values) {
            val follow = held.follow ?: continue
            val anchor = held.anchor ?: continue
            val now = follow.bounds()
            if (now == null) {
                if (!held.lost) {
                    held.lost = true
                    popOut(held.view, then = null)
                }
                continue
            }
            // Setting the same place again draws nothing.
            held.view.translationX = (held.x + now.right - anchor.right).coerceIn(2f, maxX)
            held.view.translationY = (held.y + now.top - anchor.top).coerceIn(minY, maxY)
            if (held.lost) {
                held.lost = false
                popIn(held, grow = true)
            }
        }
    }

    /**
     * A pin's look: its status's colour in a white ring (amber while its note waits to be sent), on a faint dark rim
     * that stands it off a light background. Drawn rather than an elevation shadow: a hundred and more shadows, drawn
     * again whenever the pins move, cost far more than a rim.
     */
    private fun pinLook(status: String, pending: Boolean): Drawable = LayerDrawable(
        arrayOf(
            ui.rounded(Color.argb(46, 0, 0, 0), 14),
            InsetDrawable(ui.rounded(Ui.statusColor(status), 13, if (pending) Ui.PENDING_RING else Color.WHITE, 2), ui.dp(1)),
        ),
    )

    /** A pin arriving, or coming back: it grows out of its spot ([grow]), or only fades to how opaque it should be. */
    private fun popIn(held: Pin, grow: Boolean) {
        val view = held.view
        view.visibility = VISIBLE
        if (!Motion.enabled(context)) {
            view.animate().cancel()
            view.alpha = held.alpha
            view.scaleX = 1f
            view.scaleY = 1f
            return
        }
        if (grow) {
            view.animate().cancel()
            // A new pin starts small; one caught shrinking away turns round where it is.
            if (view.scaleX >= 1f) {
                view.alpha = 0f
                view.scaleX = 0.4f
                view.scaleY = 0.4f
            }
            view.animate().alpha(held.alpha).scaleX(1f).scaleY(1f).setStartDelay(0).setDuration(PIN_IN_MS).setInterpolator(POP).start()
        } else {
            view.animate().alpha(held.alpha).setStartDelay(0).setDuration(Motion.IN_MS).setInterpolator(Motion.SETTLE).start()
        }
    }

    /** A pin leaving, or hidden while its element is off screen: it shrinks away, then [then] (or it waits, invisible). */
    private fun popOut(view: View, then: (() -> Unit)?) {
        view.animate().cancel()
        val done = Runnable {
            if (then != null) then() else view.visibility = INVISIBLE
        }
        if (!Motion.enabled(context) || !view.isShown) {
            view.alpha = 0f
            done.run()
            return
        }
        view.animate().alpha(0f).scaleX(0.4f).scaleY(0.4f).setStartDelay(0).setDuration(Motion.OUT_MS).setInterpolator(Motion.EASE_IN).withEndAction(done).start()
    }

    // ---- sheets -----------------------------------------------------------------------------------------------------

    /**
     * Shows a sheet: the composer floating over the bottom (or the top, clear of what is selected), or a modal
     * [BottomSheet] on the bottom edge (the menu, and a note opened from its pin) that slides up and is dragged down
     * to close. What the bottom sheet opens is shown inside it, not here.
     */
    fun showSheet(view: View, dim: Boolean, atTop: Boolean = false) {
        // One still on its way out goes at once: two sheets never show together.
        sheetHost.removeAllViews()
        sheet = view
        sheetAtTop = atTop
        val screen = resources.displayMetrics.widthPixels
        val width = if (view is BottomSheet) minOf(ui.dp(480), screen) else minOf(ui.dp(480), screen - ui.dp(20))
        sheetHost.addView(view, LayoutParams(width, LayoutParams.WRAP_CONTENT, Gravity.CENTER_HORIZONTAL))
        // Fading out, it lets touches through to the app; shown, a tap on it closes the sheet.
        backdrop.isClickable = dim
        Motion.reveal(backdrop, dim)
        applySheetPosition()
        render()
        if (view is BottomSheet) {
            view.slideIn()
        } else if (Motion.enabled(context)) {
            // The composer floats up (or down, at the top) into place as it fades in.
            view.alpha = 0f
            view.translationY = composerOffset(atTop)
            view.animate().alpha(1f).translationY(0f).setStartDelay(0).setDuration(Motion.IN_MS).setInterpolator(Motion.SETTLE).start()
        }
    }

    /** How far the composer travels as it comes and goes: from below, or from above when it floats at the top. */
    private fun composerOffset(atTop: Boolean) = ui.dp(if (atTop) -16 else 24).toFloat()

    private fun applySheetPosition() {
        val params = sheetHost.layoutParams as LayoutParams
        val bottomSheet = sheet as? BottomSheet
        val top = sheetAtTop && keyboard == 0
        params.gravity = if (top) Gravity.TOP else Gravity.BOTTOM
        if (bottomSheet != null) {
            // On the bottom edge, under the navigation bar (its content over the keyboard), never up into the status bar.
            params.topMargin = safeTop + ui.dp(48)
            params.bottomMargin = 0
            // The keyboard is measured from the navigation bar's top: over it, the sheet's content clears both.
            bottomSheet.bottomInset = safeBottom + keyboard
        } else {
            params.topMargin = if (top) safeTop + ui.dp(10) else 0
            params.bottomMargin = if (top) 0 else safeBottom + keyboard + ui.dp(10)
        }
        sheetHost.layoutParams = params
    }

    /**
     * Closes the sheet, whatever closes it (Cancel, Send, the backdrop, a fold of the toolbar, code): it goes the way it
     * came, the bottom sheet down off the screen's edge and the composer fading as it drops away, and is taken away once
     * it has. It is closed as far as anything else is concerned at once.
     */
    fun closeSheet() {
        val closing = sheet
        val wasComposer = closing is ComposerSheet
        hideKeyboard()
        sheet = null
        closing?.let { view ->
            val gone = Runnable { if (view.parent === sheetHost) sheetHost.removeView(view) }
            when {
                !Motion.enabled(context) || !view.isShown -> gone.run()
                view is BottomSheet -> view.slideOut(gone)
                else -> view.animate().alpha(0f).translationY(composerOffset(sheetAtTop)).setStartDelay(0).setDuration(Motion.OUT_MS)
                    .setInterpolator(Motion.EASE_IN).withEndAction(gone).start()
            }
        }
        backdrop.isClickable = false
        Motion.reveal(backdrop, false)
        actions.sheetClosed(wasComposer)
        render()
    }

    fun hideKeyboard() {
        val focused = findFocus() ?: return
        focused.clearFocus()
        context.getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(windowToken, 0)
    }

    /** A word at the top of the screen: it drops in, fading, and goes back up after a moment (longer for more words). */
    fun toast(message: String) {
        toast.text = message
        val offset = -ui.dp(12).toFloat()
        Motion.reveal(toast, true, offsetY = offset, scale = 0.96f)
        handler.removeCallbacksAndMessages(TOAST)
        handler.postAtTime({ Motion.reveal(toast, false, offsetY = offset, scale = 0.96f) }, TOAST, SystemClock.uptimeMillis() + if (message.length > 70) 5000 else 2800)
    }

    private companion object {
        val TOAST = Any()

        /** Pins pop in on a spring, overshooting a little. */
        val POP = TimeInterpolator { spring(it) }
        const val PIN_IN_MS = 300L
    }

    /** Takes every tap while annotating: the controller picks what is underneath. */
    private inner class PickSurface(context: Context) : View(context) {
        init {
            tag = ViewInspector.OWN_TAG
            visibility = GONE
        }

        private var downX = 0f
        private var downY = 0f

        @SuppressLint("ClickableViewAccessibility")
        override fun onTouchEvent(event: MotionEvent): Boolean {
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.x
                    downY = event.y
                }
                MotionEvent.ACTION_UP -> if (abs(event.x - downX) + abs(event.y - downY) < ViewConfiguration.get(context).scaledTouchSlop * 2) {
                    actions.pick(event.x, event.y)
                }
            }
            return true
        }
    }

    /** The selection's outline and name. */
    private inner class MarksView(context: Context) : View(context) {
        var selection: SelectionDrawing? = null
            private set
        private val fill = Paint().apply { color = Color.argb(31, 239, 68, 68) }
        private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Ui.SELECTION
            style = Paint.Style.STROKE
            strokeWidth = ui.dp(2).toFloat()
        }
        private val labelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Ui.SELECTION }
        private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 12f, resources.displayMetrics)
        }

        private val rect = RectF()

        init {
            tag = ViewInspector.OWN_TAG
        }

        fun show(selection: SelectionDrawing?) {
            // The tick hands the same selection over four times a second: drawn again only when it moved.
            if (selection == this.selection) return
            this.selection = selection
            invalidate()
        }

        override fun onDraw(canvas: Canvas) {
            val selection = selection ?: return
            for (box in selection.boxes) {
                rect.set(box.left, box.top, box.right, box.bottom)
                canvas.drawRoundRect(rect, ui.dp(3).toFloat(), ui.dp(3).toFloat(), fill)
                canvas.drawRoundRect(rect, ui.dp(3).toFloat(), ui.dp(3).toFloat(), stroke)
            }
            val first = selection.boxes.firstOrNull() ?: return
            val title = selection.title.let { if (it.length > 48) it.take(47) + "…" else it }
            val w = textPaint.measureText(title) + ui.dp(14)
            val h = ui.dp(20).toFloat()
            val x = first.left.coerceIn(ui.dp(8).toFloat(), (width - w - ui.dp(8)).coerceAtLeast(ui.dp(8).toFloat()))
            val y = if (first.top - h - ui.dp(4) < safeTop) first.bottom + ui.dp(4) else first.top - h - ui.dp(4)
            rect.set(x, y, x + w, y + h)
            canvas.drawRoundRect(rect, ui.dp(5).toFloat(), ui.dp(5).toFloat(), labelPaint)
            canvas.drawText(title, x + ui.dp(7), y + h - ui.dp(6), textPaint)
        }
    }
}
