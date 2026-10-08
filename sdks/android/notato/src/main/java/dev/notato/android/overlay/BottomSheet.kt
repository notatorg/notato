package dev.notato.android.overlay

import android.annotation.SuppressLint
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewTreeObserver
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import androidx.core.view.isVisible
import kotlin.math.abs

/** What one sheet shows in the bottom sheet, and where it is among the others. */
internal class SheetPage(
    val place: SheetPlace,
    /** What it shows: it is built again in place when this changes (the menu's server state). */
    val state: () -> Any? = { null },
    val build: () -> SheetParts,
)

/**
 * A sheet's content: [top] stays put (the header), [body] scrolls when there is not room for all of it, [bottom] stays
 * put under it (the buttons). Each part is [gap] from the next.
 */
internal class SheetParts(val top: List<View>, val body: View? = null, val bottom: List<View> = emptyList(), val gap: Int = 10)

/**
 * The modal bottom sheet the menu, Notes, Settings, Clear notes and a note's card are all drawn in: a grabber over the
 * content, on the bottom edge and under the navigation bar (and over the keyboard). Going from the menu to what it
 * opens, and back, swaps the content inside it ([show]); [refresh] builds it again in place when what it shows has
 * changed, so the server's state (and a Retry) shows live in the menu. It slides up when shown; dragged down, it closes
 * through [dismiss].
 */
@SuppressLint("ViewConstructor")
internal class BottomSheet(private val ui: Ui, first: SheetPage, private val dismiss: () -> Unit) : LinearLayout(ui.context) {
    private val top = ui.own(LinearLayout(context)).apply { orientation = VERTICAL }
    private val body = ui.own(FrameLayout(context))
    private val scroll = ui.own(ScrollView(context)).apply {
        isVerticalScrollBarEnabled = false
        overScrollMode = OVER_SCROLL_NEVER
        addView(body)
    }
    private val bottom = ui.own(LinearLayout(context)).apply { orientation = VERTICAL }

    /** What it shows now. */
    var page: SheetPage = first
        private set
    private var built: Any? = null

    /** The navigation bar's height, or the keyboard's: the sheet goes under it, and its content stays above it. */
    var bottomInset = 0
        set(value) {
            if (field == value) return
            field = value
            pad()
        }

    init {
        ui.own(this)
        orientation = VERTICAL
        val r = ui.dp(28).toFloat()
        background = GradientDrawable().apply {
            setColor(ui.cardBackground)
            cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
        }
        // The surface's shadow alone: nothing in it has elevation of its own.
        elevation = ui.dp(16).toFloat()
        isClickable = true // a tap on the sheet is the sheet's, not the backdrop's
        val grabber = ui.own(View(context)).apply {
            background = ui.rounded(ui.cardLine, 2.5)
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        addView(grabber, LayoutParams(ui.dp(36), ui.dp(5)).apply { gravity = Gravity.CENTER_HORIZONTAL })
        addView(top, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = ui.dp(10) })
        // Whatever room the header and buttons leave: as tall as it is when that is enough, scrolling when not.
        addView(scroll, LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f))
        addView(bottom, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
        pad()
        built = first.state()
        fill(first.build(), keepScroll = false)
    }

    private fun pad() = setPadding(ui.dp(18), ui.dp(10), ui.dp(18), ui.dp(24) + bottomInset)

    /** Shows [next] in this sheet instead of what it shows now: faded in, or (rebuilding the same note) as it was. */
    fun show(next: SheetPage, fade: Boolean = true, keepScroll: Boolean = false) {
        page = next
        built = next.state()
        fill(next.build(), keepScroll)
        if (fade) {
            for (part in listOf(top, scroll, bottom)) {
                part.alpha = 0f
                part.animate().alpha(1f).setDuration(160).setInterpolator(Motion.SETTLE).start()
            }
        }
    }

    /** Builds the content again if what it shows has changed. */
    fun refresh() {
        val now = page.state()
        if (now == built) return
        built = now
        fill(page.build(), keepScroll = true)
    }

    private fun fill(parts: SheetParts, keepScroll: Boolean) {
        val y = scroll.scrollY
        top.removeAllViews()
        body.removeAllViews()
        bottom.removeAllViews()
        val gap = ui.dp(parts.gap)
        parts.top.forEachIndexed { index, view ->
            top.addView(view, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { if (index > 0) topMargin = gap })
        }
        parts.body?.let { body.addView(it, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT)) }
        scroll.visibility = if (parts.body != null) VISIBLE else GONE
        (scroll.layoutParams as LayoutParams).topMargin = gap
        parts.bottom.forEachIndexed { index, view ->
            bottom.addView(view, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { if (index > 0) topMargin = gap })
        }
        bottom.visibility = if (parts.bottom.isNotEmpty()) VISIBLE else GONE
        (bottom.layoutParams as LayoutParams).topMargin = gap
        if (keepScroll) scroll.post { scroll.scrollTo(0, y) } else scroll.scrollTo(0, 0)
    }

    /** Up from below the screen's edge, once it has been laid out. */
    fun slideIn() {
        viewTreeObserver.addOnPreDrawListener(object : ViewTreeObserver.OnPreDrawListener {
            override fun onPreDraw(): Boolean {
                if (viewTreeObserver.isAlive) viewTreeObserver.removeOnPreDrawListener(this)
                translationY = height.toFloat()
                animate().translationY(0f).setDuration(280).setInterpolator(Motion.SETTLE).start()
                return true
            }
        })
    }

    // ---- dragged down, it closes -------------------------------------------------------------------------------------

    private val slop = ViewConfiguration.get(context).scaledTouchSlop
    private var downX = 0f
    private var downY = 0f
    private var downInScroll = false
    private var dragging = false
    private var velocity: VelocityTracker? = null

    /** A drag down, more down than across: from what does not scroll, or from the scrolling part when it is at its top. */
    private fun pullingDown(event: MotionEvent): Boolean {
        val dy = event.rawY - downY
        return dy > slop && dy > abs(event.rawX - downX) && !(downInScroll && scroll.canScrollVertically(-1))
    }

    private fun track(event: MotionEvent) {
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            velocity?.recycle()
            velocity = VelocityTracker.obtain()
            downX = event.rawX
            downY = event.rawY
            downInScroll = scroll.isVisible && event.y >= scroll.top && event.y < scroll.bottom
            dragging = false
        }
        // In screen terms: the sheet itself moves under the finger.
        val screen = MotionEvent.obtain(event).apply { setLocation(event.rawX, event.rawY) }
        velocity?.addMovement(screen)
        screen.recycle()
    }

    override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
        track(event)
        if (event.actionMasked == MotionEvent.ACTION_MOVE && !dragging && pullingDown(event)) {
            dragging = true
            animate().cancel()
            downY = event.rawY - translationY
            return true
        }
        return false
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked != MotionEvent.ACTION_DOWN || velocity == null) track(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_MOVE -> {
                if (!dragging && pullingDown(event)) {
                    dragging = true
                    animate().cancel()
                    downY = event.rawY - translationY
                }
                if (dragging) translationY = (event.rawY - downY).coerceAtLeast(0f)
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (dragging) {
                    dragging = false
                    val speed = velocity?.run { computeCurrentVelocity(1000); yVelocity } ?: 0f
                    if (event.actionMasked == MotionEvent.ACTION_UP && (translationY > height * 0.3f || speed > ui.dp(900))) {
                        animate().translationY(height.toFloat()).setDuration(180).setInterpolator(Motion.EASE_IN).withEndAction { dismiss() }.start()
                    } else {
                        animate().translationY(0f).setDuration(220).setInterpolator(Motion.SETTLE).start()
                    }
                }
                velocity?.recycle()
                velocity = null
            }
        }
        return true
    }
}
