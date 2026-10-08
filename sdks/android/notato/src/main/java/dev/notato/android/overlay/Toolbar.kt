package dev.notato.android.overlay

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.TimeInterpolator
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.RectF
import android.os.Build
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.animation.PathInterpolator
import android.widget.FrameLayout
import android.widget.LinearLayout
import dev.notato.android.NotatoConnection
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/** What the Annotate button's count says: always there, "0" included, and no more than "99+". */
internal fun barCount(count: Int): String = when {
    count <= 0 -> "0"
    count > 99 -> "99+"
    else -> count.toString()
}

/** What the folded toolbar's badge says: nothing for no notes, and no more than "99+". */
internal fun foldedCount(count: Int): String? = if (count <= 0) null else barCount(count)

/**
 * The dot on ⋯ and on the folded button: shown only when something is wrong, so not when connected, nor with no
 * server at all. Amber while connecting, red when the server cannot be reached or refused this app.
 */
internal fun connectionDotColor(connection: NotatoConnection): Int? = when (connection) {
    NotatoConnection.CONNECTING -> 0xFFE9B44C.toInt()
    NotatoConnection.OFFLINE, NotatoConnection.REFUSED -> 0xFFEF6B5E.toInt()
    else -> null
}

/**
 * A spring as a curve over an animation's time: damping ratio 0.68, so quick off the mark, one overshoot of about 5%,
 * and settled by the end. The web toolbar's `springEasing` samples the same curve.
 */
internal fun spring(t: Float): Float {
    if (t <= 0f) return 0f
    if (t >= 1f) return 1f
    val zeta = 0.68
    val omega = 6 / zeta // within 0.3% of the end by t = 1
    val damped = omega * sqrt(1 - zeta * zeta)
    val decay = exp(-zeta * omega * t)
    return (1 - decay * (cos(damped * t) + zeta / sqrt(1 - zeta * zeta) * sin(damped * t))).toFloat()
}

/**
 * The toolbar: a dark bar (a grip, Annotate with its count, ⋯ and the fold chevron) that a drag anywhere on moves, and
 * that folds into one round button and opens out of it again. It folds toward the side it is held to and grows away
 * from it, so the buttons stay where they will be and the edge sweeps over them; its corners round off to a circle as
 * it goes.
 *
 * It is laid out at its open size all the time. What shows is a bar [shown] wide at the held side, the rest clipped
 * away and taking no touches, so the width can change on every frame without a layout pass, and its place changes on
 * the very same frame. The held edge stays where it was on screen when the fold or open started: a dragged toolbar's
 * fraction is changed to match where it ends up, and one still in its corner keeps that edge anyway.
 */
@SuppressLint("ViewConstructor")
internal class ToolbarView(
    private val ui: Ui,
    private val actions: OverlayActions,
    /** Where the toolbar's left and top may go, for a toolbar of this size: min x, min y, max x, max y. */
    private val room: (width: Float, height: Float) -> FloatArray,
) : ViewGroup(ui.context) {
    private val shape = object : ViewOutlineProvider() {
        override fun getOutline(view: View, outline: Outline) {
            val left = shownLeft
            outline.setRoundRect(left.roundToInt(), 0, (left + shown).roundToInt(), height, radius(shown))
        }
    }

    /** Six dots: where to hold it. Only a sign: a drag anywhere on the bar moves it. */
    private val grip = slot(ui.icon(Icon.GRIP, Ui.BAR_MUTED, 14), 14, 20).apply { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }
    private val crosshair = ui.icon(Icon.CROSSHAIR, Ui.BAR_TEXT, 18, 2.2f)
    private val label = ui.text("Annotate", 15f, Ui.BAR_TEXT, maxLines = 1, weight = 700).apply { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }

    /** The notes on this screen, on the Annotate button: always there, "0" included. */
    private val count = ui.text("0", 12.5f, Ui.BAR_TEXT, maxLines = 1, weight = 700).apply {
        gravity = Gravity.CENTER
        minWidth = ui.dp(22)
        setPadding(ui.dp(7), ui.dp(1), ui.dp(7), ui.dp(1))
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    private val annotate = ui.own(LinearLayout(context)).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(ui.dp(12), 0, ui.dp(10), 0)
        addView(crosshair, LinearLayout.LayoutParams(ui.dp(18), ui.dp(18)))
        addView(label, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { marginStart = ui.dp(8) })
        addView(count, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { marginStart = ui.dp(8) })
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, ui.dp(44))
        contentDescription = "Annotate"
        isClickable = true
        setOnClickListener { actions.toggleAnnotating() }
    }
    private val dot = ui.own(View(context)).apply {
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        visibility = GONE
    }
    private val more = slot(ui.icon(Icon.MORE, Ui.BAR_TEXT, 18), 18, 44, "Notato menu") { actions.openMenu() }
    private val chevron = ui.icon(Icon.CHEVRON_RIGHT, Ui.BAR_MUTED, 16, 2.2f)
    private val collapse = slot(chevron, 16, 28, "Collapse the toolbar") { foldByHand(true) }
    private val row = ui.own(LinearLayout(context)).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        for ((index, child) in listOf(grip, annotate, more, collapse).withIndex()) {
            addView(child, (child.layoutParams as LinearLayout.LayoutParams).apply { if (index > 0) marginStart = ui.dp(2) })
        }
    }
    private val pill = Pill()

    /** The count on the folded button's corner: teal, with a ring in the bar's colour, and gone at 0. */
    private val badge = ui.text("", 11f, Ui.ON_BAR_ACCENT, maxLines = 1, weight = 800).apply {
        gravity = Gravity.CENTER
        // An 18dp pill with a 2dp ring in the bar's colour around it.
        minWidth = ui.dp(22)
        setPadding(ui.dp(7), 0, ui.dp(7), 0)
        background = ui.rounded(Ui.BAR_ACCENT, 11, Ui.BAR, 2)
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        visibility = GONE
    }
    private val status = ui.own(View(context)).apply {
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        visibility = GONE
    }
    private val fab = Fab()

    private val items get() = (0 until row.childCount).map { row.getChildAt(it) }

    init {
        ui.own(this)
        clipChildren = false // the badge stands out over the round button's edge
        outlineProvider = shape // the shadow follows the pill
        // On ⋯, only while the server is connecting or cannot be reached.
        more.addView(dot, FrameLayout.LayoutParams(ui.dp(8), ui.dp(8), Gravity.TOP or Gravity.END).apply { setMargins(0, ui.dp(9), ui.dp(9), 0) })
        styleAnnotate(false)
        addView(pill)
        addView(fab)
    }

    /** A place on the bar 44 high with an icon in the middle; a button when it has [onClick]. */
    private fun slot(icon: View, iconDp: Int, widthDp: Int, description: String? = null, onClick: (() -> Unit)? = null): FrameLayout = ui.own(FrameLayout(context)).apply {
        addView(icon, FrameLayout.LayoutParams(ui.dp(iconDp), ui.dp(iconDp), Gravity.CENTER))
        layoutParams = LinearLayout.LayoutParams(ui.dp(widthDp), ui.dp(44))
        if (onClick != null) {
            background = ui.pressable(Color.TRANSPARENT, Ui.BAR_PRESSED, 12)
            contentDescription = description
            isClickable = true
            setOnClickListener { onClick() }
        }
    }

    /** Annotate is teal with dark ink while annotating, and plain on the bar otherwise. */
    private fun styleAnnotate(active: Boolean) {
        val ink = if (active) Ui.ON_BAR_ACCENT else Ui.BAR_TEXT
        annotate.background = if (active) {
            ui.pressable(Ui.BAR_ACCENT, Ui.over(Ui.BAR_ACCENT, Color.BLACK, 0.12f), 12)
        } else {
            ui.pressable(Color.TRANSPARENT, Ui.BAR_PRESSED, 12)
        }
        crosshair.background = IconDrawable(Icon.CROSSHAIR, ink, ui.density, 2.2f)
        label.setTextColor(ink)
        count.setTextColor(ink)
        count.background = ui.rounded(if (active) Color.argb(41, 11, 31, 27) else Ui.BAR_PRESSED, 11)
    }

    // ---- state from the controller ---------------------------------------------------------------------------------

    private var annotating = false
    private var trouble: Int? = null

    fun render() {
        if (actions.isAnnotating != annotating) {
            annotating = actions.isAnnotating
            styleAnnotate(annotating)
        }
        val n = actions.count
        count.text = barCount(n)
        if (Build.VERSION.SDK_INT >= 30) annotate.stateDescription = if (n == 1) "1 note on this screen" else "$n notes on this screen"
        val folded = foldedCount(n)
        badge.text = folded ?: ""
        badge.visibility = if (folded != null) VISIBLE else GONE
        val problem = connectionDotColor(actions.connection)
        if (problem != trouble) {
            trouble = problem
            if (problem != null) {
                dot.background = ui.rounded(problem, 4, Ui.BAR, 1.5)
                status.background = ui.rounded(problem, 7, Ui.BAR, 2)
            }
        }
        dot.visibility = if (problem != null) VISIBLE else GONE
        status.visibility = if (problem != null) VISIBLE else GONE
        setHeldRight(actions.toolbarHeldRight)
        setCollapsed(actions.toolbarCollapsed)
        place()
    }

    // ---- size and place ---------------------------------------------------------------------------------------------

    /** Folded, or folding or opening: [collapsed] is where it is going. */
    private var collapsed = actions.toolbarCollapsed
    private var heldRight = actions.toolbarHeldRight

    /** The width showing while it folds or opens; null once it is there. */
    private var morphWidth: Float? = null
    private var morph: ValueAnimator? = null

    /** While it folds or opens: the width it started at and is going to, and the pill's left at each. */
    private var morphPlace: FloatArray? = null

    init {
        chevron.background = IconDrawable(if (heldRight) Icon.CHEVRON_RIGHT else Icon.CHEVRON_LEFT, Ui.BAR_MUTED, ui.density, 2.2f)
        settleNow()
    }

    /** How wide the bar showing is: a circle the bar's height across when folded. */
    private val shown: Float get() = morphWidth ?: if (collapsed) height.toFloat() else width.toFloat()

    /** Where the bar showing starts in this view: it is held to one side of it. */
    private val shownLeft: Float get() = if (heldRight) width - shown else 0f

    /** The corners at width [w]: 16 open, rounding off to a circle as it folds. */
    private fun radius(w: Float): Float {
        val h = height.toFloat()
        val open = ui.dp(16).toFloat()
        if (width <= height) return h / 2
        val p = ((w - h) / (width - h)).coerceIn(0f, 1f)
        return h / 2 + (open - h / 2) * p
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val unspecified = MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
        pill.measure(unspecified, unspecified)
        // The round button inside the bar's padding: the circle around it is the bar's own height.
        val size = MeasureSpec.makeMeasureSpec(ui.dp(44), MeasureSpec.EXACTLY)
        fab.measure(size, size)
        setMeasuredDimension(pill.measuredWidth, pill.measuredHeight)
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        pill.layout(0, 0, pill.measuredWidth, pill.measuredHeight)
        val inset = (height - fab.measuredHeight) / 2
        val x = if (heldRight) width - inset - fab.measuredWidth else inset
        fab.layout(x, inset, x + fab.measuredWidth, inset + fab.measuredHeight)
        reshape()
    }

    /** Places it from its fraction, for the width showing now. */
    fun place() {
        val host = parent as? View ?: return
        // A fold or open not rendered yet may have changed the fraction already: wait for it, so nothing jumps first.
        if (host.width == 0 || width == 0 || dragging || actions.toolbarCollapsed != collapsed) return
        val w = shown
        val (minX, minY, maxX, maxY) = room(w, height.toFloat())
        val (fx, fy) = actions.toolbarFraction
        val m = morphPlace
        val left = if (m != null) {
            // On the width's own curve, so the held edge stays exactly where it is, frame by frame.
            val p = if (m[1] != m[0]) (w - m[0]) / (m[1] - m[0]) else 1f
            m[2] + (m[3] - m[2]) * p
        } else {
            minX + (maxX - minX) * fx
        }
        translationX = left - shownLeft
        translationY = minY + (maxY - minY) * fy
    }

    /**
     * Where the pill's left ends up at width [to] when it starts from [from] wide at [fromLeft] on screen. Back where it
     * was before the last fold or open, when the controller says so (that fraction is set already); else the held edge
     * stays put (as far as the margins allow), and a dragged toolbar's fraction is changed to put it there at that width.
     * One still in its corner is there already, and stays undragged.
     */
    private fun target(from: Float, fromLeft: Float, to: Float): Float {
        val (minX, _, maxX, _) = room(to, height.toFloat())
        if (actions.toolbarReturning) return minX + (maxX - minX) * actions.toolbarFraction.first
        val edge = if (heldRight) fromLeft + from else fromLeft
        val left = (if (heldRight) edge - to else edge).coerceIn(minX, maxX)
        if (actions.toolbarDragged) {
            val fy = actions.toolbarFraction.second
            actions.keepToolbarAt((if (maxX > minX) (left - minX) / (maxX - minX) else 1f) to fy)
        }
        return left
    }

    private fun reshape() {
        pill.invalidate()
        pill.invalidateOutline()
        invalidateOutline()
        place()
    }

    private fun setHeldRight(right: Boolean) {
        if (right == heldRight) return
        if (morph != null) settleNow()
        heldRight = right
        chevron.background = IconDrawable(if (right) Icon.CHEVRON_RIGHT else Icon.CHEVRON_LEFT, Ui.BAR_MUTED, ui.density, 2.2f)
        requestLayout() // the round button goes to that side
        reshape()
    }

    // ---- folding and opening ------------------------------------------------------------------------------------------

    /** The chevron, the round button, or a tap on the rim around it. */
    private fun foldByHand(next: Boolean) = actions.setToolbarCollapsed(next)

    /** On screen and placed, so where it is can be read. */
    private fun placed(): Boolean = isAttachedToWindow && isShown && width > 0 && ((parent as? View)?.width ?: 0) > 0

    private fun animationsOn(): Boolean {
        if (!placed()) return false
        return if (Build.VERSION.SDK_INT >= 26) {
            ValueAnimator.areAnimatorsEnabled()
        } else {
            Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) != 0f
        }
    }

    private fun setCollapsed(next: Boolean) {
        if (next == collapsed) return
        // Mid-flight this is the width on screen, and the views are where they are: a change of mind turns round there.
        val from = shown
        val fromLeft = translationX + shownLeft
        val turning = morph != null
        val onScreen = placed()
        stopMorph()
        collapsed = next
        val to = if (next) height.toFloat() else width.toFloat()
        val toLeft = if (onScreen) target(from, fromLeft, to) else fromLeft
        if (!animationsOn()) return settleNow()

        morphWidth = from
        morphPlace = floatArrayOf(from, to, fromLeft, toLeft)
        row.visibility = VISIBLE
        fab.visibility = VISIBLE
        fab.isClickable = next
        val toward = if (heldRight) 1f else -1f
        // Nearest the held side first: that is where the sweep starts.
        val shownItems = items.filter { it.visibility == VISIBLE }.sortedBy { it.left }.let { if (heldRight) it.reversed() else it }

        morph = ValueAnimator.ofFloat(from, to).apply {
            duration = if (next) 420 else 560
            interpolator = if (next) SETTLE else SPRING
            addUpdateListener {
                morphWidth = it.animatedValue as Float
                reshape()
            }
            addListener(object : AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: Animator) {
                    if (morph === animation) finishMorph()
                }
            })
        }
        if (next) {
            // The far buttons go first, as the edge comes in over them, then the button they fold into turns in.
            shownItems.reversed().forEachIndexed { i, item ->
                item.animate().alpha(0f).translationX(ui.dp(8) * toward).scaleX(0.92f).scaleY(0.92f)
                    .setDuration(160).setStartDelay(16L * i).setInterpolator(EASE_IN).start()
            }
            if (!turning) fab.apply { alpha = 0f; scaleX = 0.5f; scaleY = 0.5f; rotation = -90f * toward }
            fab.animate().alpha(1f).scaleX(1f).scaleY(1f).rotation(0f).setDuration(460).setStartDelay(170).setInterpolator(SPRING).start()
            if (!turning && badge.visibility == VISIBLE) {
                badge.apply { alpha = 0f; scaleX = 0.4f; scaleY = 0.4f }
                badge.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(380).setStartDelay(400).setInterpolator(SPRING).start()
            }
        } else {
            fab.animate().alpha(0f).scaleX(0.5f).scaleY(0.5f).rotation(-90f * toward).setDuration(180).setStartDelay(0).setInterpolator(EASE_IN).start()
            shownItems.forEachIndexed { i, item ->
                if (!turning) item.apply { alpha = 0f; translationX = ui.dp(10) * toward; scaleX = 0.94f; scaleY = 0.94f }
                // Close behind the edge, which covers most of the way in the first 150ms.
                item.animate().alpha(1f).translationX(0f).scaleX(1f).scaleY(1f)
                    .setDuration(280).setStartDelay(25L + 18 * i).setInterpolator(SETTLE).start()
            }
        }
        morph?.start()
    }

    /** Stops whatever is moving, leaving each view where it is on screen. */
    private fun stopMorph() {
        val running = morph
        morph = null
        morphPlace = null
        running?.cancel()
        for (view in items + fab + badge) view.animate().cancel()
    }

    /** The width has arrived. What is now hidden has nothing left to show; the rest finish on their own. */
    private fun finishMorph() {
        morph = null
        morphWidth = null
        morphPlace = null
        if (collapsed) {
            for (item in items) item.animate().cancel()
            row.visibility = INVISIBLE
            for (item in items) item.rest()
        } else {
            fab.animate().cancel()
            badge.animate().cancel()
            fab.visibility = INVISIBLE
            fab.rest()
            badge.rest()
        }
        reshape()
    }

    /** Straight to where it is going, nothing moving: animations off, a drag starting mid-flight, the first render. */
    private fun settleNow() {
        stopMorph()
        morphWidth = null
        for (view in items + fab + badge) view.rest()
        row.visibility = if (collapsed) INVISIBLE else VISIBLE
        fab.visibility = if (collapsed) VISIBLE else INVISIBLE
        fab.isClickable = collapsed
        reshape()
    }

    private fun View.rest() {
        alpha = 1f
        translationX = 0f
        scaleX = 1f
        scaleY = 1f
        rotation = 0f
    }

    // ---- dragging: from anywhere on it, its buttons and the round button included ------------------------------------

    private val slop = ViewConfiguration.get(context).scaledTouchSlop
    private var downX = 0f
    private var downY = 0f
    private var startLeft = 0f
    private var startTop = 0f
    private var dragging = false

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        // What is clipped away is not there: a touch on it goes on to what is underneath.
        if (event.actionMasked == MotionEvent.ACTION_DOWN && (event.x < shownLeft || event.x > shownLeft + shown)) return false
        return super.dispatchTouchEvent(event)
    }

    private fun down(event: MotionEvent) {
        downX = event.rawX
        downY = event.rawY
        dragging = false
    }

    private fun beyondSlop(event: MotionEvent) = abs(event.rawX - downX) + abs(event.rawY - downY) > slop

    private fun startDrag() {
        if (morph != null) settleNow()
        startLeft = translationX + shownLeft
        startTop = translationY
        dragging = true
    }

    override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> down(event)
            MotionEvent.ACTION_MOVE -> if (!dragging && beyondSlop(event)) {
                startDrag()
                return true
            }
        }
        return false
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> down(event)
            MotionEvent.ACTION_MOVE -> {
                if (!dragging && beyondSlop(event)) startDrag()
                if (dragging) {
                    val (minX, minY, maxX, maxY) = room(shown, height.toFloat())
                    translationX = (startLeft + event.rawX - downX).coerceIn(minX, maxX) - shownLeft
                    translationY = (startTop + event.rawY - downY).coerceIn(minY, maxY)
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> if (dragging) {
                val (minX, minY, maxX, maxY) = room(shown, height.toFloat())
                val left = translationX + shownLeft
                dragging = false
                // Moved by hand: the side it is held to is worked out again (the render this brings turns the chevron).
                actions.dragToolbar(
                    (if (maxX > minX) (left - minX) / (maxX - minX) else 1f) to (if (maxY > minY) (translationY - minY) / (maxY - minY) else 1f),
                )
            } else if (event.actionMasked == MotionEvent.ACTION_UP && collapsed) {
                // A tap on the rim around the round button opens it too.
                foldByHand(false)
            }
        }
        return true
    }

    // ---- its parts ---------------------------------------------------------------------------------------------------

    /** The bar: of the width showing, clipped to it, with the buttons at their open places. */
    private inner class Pill : FrameLayout(ui.context) {
        private val paint = Paint().apply { color = Ui.BAR }
        private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Ui.BAR_LINE
            style = Paint.Style.STROKE
            strokeWidth = ui.dp(1).toFloat()
        }
        private val edge = RectF()

        init {
            ui.own(this)
            setPadding(ui.dp(5), ui.dp(5), ui.dp(5), ui.dp(5))
            clipToOutline = true
            outlineProvider = shape
            addView(row, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
        }

        override fun dispatchDraw(canvas: Canvas) {
            // Drawn here rather than as a background: while the spring overshoots, the bar is wider than this view.
            canvas.drawRect(shownLeft, 0f, shownLeft + shown, height.toFloat(), paint)
            // A hairline ring just inside its edge, so it stands off a dark app too.
            val inset = ring.strokeWidth / 2
            val r = radius(shown) - inset
            edge.set(shownLeft + inset, inset, shownLeft + shown - inset, height - inset)
            canvas.drawRoundRect(edge, r, r, ring)
            super.dispatchDraw(canvas)
        }
    }

    /** What the bar folds into: the potato, the count on its corner, and the server's state only when something is wrong. */
    private inner class Fab : ViewGroup(ui.context) {
        private val potato = ui.potato(40)

        init {
            ui.own(this)
            clipChildren = false
            contentDescription = "Show the Notato toolbar"
            addView(potato)
            addView(badge)
            addView(status)
            setOnClickListener { foldByHand(false) }
        }

        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            fun exactly(dp: Int) = MeasureSpec.makeMeasureSpec(ui.dp(dp), MeasureSpec.EXACTLY)
            potato.measure(exactly(40), exactly(40))
            badge.measure(MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED), exactly(22))
            status.measure(exactly(14), exactly(14))
            setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), MeasureSpec.getSize(heightMeasureSpec))
        }

        override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
            val n = potato.measuredWidth
            potato.layout((width - n) / 2, (height - n) / 2, (width + n) / 2, (height + n) / 2)
            // This sits 5dp inside the circle. The count stands out over its top right, as on the web: its middle just
            // outside the circle's edge, halfway round.
            val out = ui.dp(11)
            badge.layout(width + out - badge.measuredWidth, -ui.dp(10), width + out, badge.measuredHeight - ui.dp(10))
            // The dot on the bottom left, on the circle's edge.
            val s = status.measuredWidth
            val left = -ui.dp(5)
            status.layout(left, height + ui.dp(5) - s, left + s, height + ui.dp(5))
        }
    }

    private companion object {
        val SPRING = TimeInterpolator { spring(it) }
        val SETTLE = PathInterpolator(0.32f, 0.72f, 0f, 1f)
        val EASE_IN = PathInterpolator(0.42f, 0f, 1f, 1f)
    }
}
