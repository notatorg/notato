package dev.notato.android.overlay

import android.content.Context
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.os.Build
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.graphics.ColorUtils
import androidx.core.graphics.PathParser
import dev.notato.android.R
import dev.notato.android.inspect.ViewInspector
import dev.notato.android.model.Status

/**
 * The overlay's look, and small builders for its views. Everything is set on the view itself: no app theme reaches it.
 * The same palette as the web toolbar and the board: a bar that is always dark, sheets and cards that follow the
 * system's light or dark setting, and teal for the brand.
 */
internal class Ui(val context: Context) {
    val density = context.resources.displayMetrics.density
    val dark = (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    fun dp(value: Number): Int = (value.toFloat() * density + 0.5f).toInt()

    companion object {
        // The bar, the hint and the toast: always dark.
        val BAR = Color.parseColor("#17181b")
        val BAR_TEXT = Color.parseColor("#eceded")
        val BAR_MUTED = Color.parseColor("#8b8f97")
        val BAR_PRESSED = Color.parseColor("#2a2c31")
        val BAR_LINE = Color.parseColor("#33353a")
        val BAR_ACCENT = Color.parseColor("#45bfa8")
        val ON_BAR_ACCENT = Color.parseColor("#0b1f1b")

        /** The brand: buttons, the primary tile, selected chips, open pins. */
        val ACCENT = Color.parseColor("#1f8a78")
        val ACCENT_PRESSED = Color.parseColor("#187465")
        val DANGER = Color.parseColor("#d6453d")
        val SELECTION = Color.parseColor("#ef4444")

        /** The ring of a pin whose note is not sent yet (white otherwise): on the screen and in the sheets alike. */
        val PENDING_RING = Color.parseColor("#e9b44c")

        // The server, as the menu's pill shows it (the bar's dot: connectionDotColor).
        val CONNECTED = Color.parseColor("#2e9a5b")
        val CONNECTING = Color.parseColor("#d99a1e")
        val OFFLINE = Color.parseColor("#ef6b5e")

        /** Each status's colour, read once: pins ask for it every time they are drawn. */
        private val STATUS_COLORS = mapOf(
            Status.ACKNOWLEDGED to "#d99a1e",
            Status.RESOLVED to "#2e9a5b",
            Status.REVERT_REQUESTED to "#8b5cf6",
            Status.VARIANT_CHOSEN to "#0891b2",
            Status.REVERTED to "#64748b",
            Status.DISMISSED to "#9a9a9a",
        ).mapValues { Color.parseColor(it.value) }
        private val OPEN_COLOR = Color.parseColor("#1f8a78")

        /** A pin's colour: the same for each status as on the web and the board. */
        fun statusColor(status: String): Int = STATUS_COLORS[status] ?: OPEN_COLOR

        /** [color] at [fraction] opacity laid over [base], as CSS's color-mix does it. */
        fun over(base: Int, color: Int, fraction: Float): Int = ColorUtils.blendARGB(base, color, fraction)
    }

    // Sheets and cards: the system's light or dark.
    val cardBackground = Color.parseColor(if (dark) "#1d1e21" else "#ffffff")
    val cardText = Color.parseColor(if (dark) "#e6e7ea" else "#1d1f22")
    val cardMuted = Color.parseColor(if (dark) "#8f939b" else "#686c72")
    val cardLine = Color.parseColor(if (dark) "#2f3136" else "#e4e4df")
    /** Icon tiles, fields, a reply's bubble, a row being pressed. */
    val soft = Color.parseColor(if (dark) "#26272b" else "#f2f2ef")
    val fieldBackground = soft

    fun rounded(color: Int, radiusDp: Number, strokeColor: Int? = null, strokeDp: Number = 1): GradientDrawable = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(radiusDp).toFloat()
        if (strokeColor != null) setStroke(dp(strokeDp), strokeColor)
    }

    /** A rounded background that turns [pressed] while a finger is on it. */
    fun pressable(color: Int, pressed: Int, radiusDp: Number, strokeColor: Int? = null): Drawable = StateListDrawable().apply {
        addState(intArrayOf(android.R.attr.state_pressed), rounded(pressed, radiusDp, strokeColor))
        addState(intArrayOf(), rounded(color, radiusDp, strokeColor))
    }

    /** The system font at a weight (600 semibold, 700 bold, 800 heavy); bold or regular before Android 9. */
    fun weight(weight: Int): Typeface = if (Build.VERSION.SDK_INT >= 28) {
        Typeface.create(Typeface.DEFAULT, weight, false)
    } else {
        if (weight >= 600) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
    }

    /** Marks a view as Notato's own, so the picker never selects it. */
    fun <T : View> own(view: T): T = view.apply { tag = ViewInspector.OWN_TAG }

    fun text(value: CharSequence?, sizeSp: Float = 14f, color: Int = cardText, bold: Boolean = false, maxLines: Int = Int.MAX_VALUE, weight: Int? = null): TextView =
        own(TextView(context)).apply {
            text = value
            setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
            setTextColor(color)
            typeface = weight?.let { weight(it) } ?: if (bold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
            this.maxLines = maxLines
            if (maxLines == 1) ellipsize = TextUtils.TruncateAt.END
            includeFontPadding = false
        }

    /** The composer's buttons: teal for the primary one, soft-filled (no outline) for a quiet one. */
    fun button(label: String, primary: Boolean = false, destructive: Boolean = false, onClick: () -> Unit): TextView =
        text(label, 14f, if (primary) Color.WHITE else if (destructive) DANGER else cardText, maxLines = 1, weight = if (primary) 700 else 600).apply {
            background = if (primary) pressable(ACCENT, ACCENT_PRESSED, 12) else pressable(soft, cardLine, 12)
            setPadding(dp(14), dp(9), dp(14), dp(9))
            gravity = Gravity.CENTER
            minHeight = dp(38)
            isClickable = true
            isFocusable = true
            contentDescription = label
            setOnClickListener { onClick() }
        }

    /**
     * The composer's surface: it floats away from what it is about, so it is the sheets' surface without the grabber.
     * The shadow is the surface's alone (nothing inside it has elevation).
     */
    fun card(content: View): FrameLayout = own(FrameLayout(context)).apply {
        background = rounded(cardBackground, 28)
        elevation = dp(10).toFloat()
        setPadding(dp(18), dp(16), dp(18), dp(18))
        isClickable = true // a tap on the card is the card's, not the backdrop's
        addView(content)
    }

    // ---- the sheets' parts: the same in the menu and in everything it opens ---------------------------------------------

    enum class ButtonKind {
        PLAIN, PRIMARY,

        /** Quiet, in red: deleting one note. */
        DANGER,

        /** Filled red: confirming what cannot be undone. */
        DESTRUCTIVE,
    }

    /** A sheet's button: as wide as it is given ([ButtonRow] shares the room out), 50 high, rounded 14. */
    fun sheetButton(label: String, kind: ButtonKind = ButtonKind.PLAIN, onClick: () -> Unit): TextView {
        val ink = when (kind) {
            ButtonKind.PLAIN -> cardText
            ButtonKind.DANGER -> DANGER
            ButtonKind.PRIMARY, ButtonKind.DESTRUCTIVE -> Color.WHITE
        }
        val strong = kind == ButtonKind.PRIMARY || kind == ButtonKind.DESTRUCTIVE
        return text(label, 15f, ink, maxLines = 1, weight = if (strong) 700 else 600).apply {
            background = when (kind) {
                ButtonKind.PLAIN, ButtonKind.DANGER -> pressable(soft, cardLine, 14)
                ButtonKind.PRIMARY -> pressable(ACCENT, ACCENT_PRESSED, 14)
                ButtonKind.DESTRUCTIVE -> pressable(DANGER, over(cardBackground, DANGER, 0.85f), 14)
            }
            setPadding(dp(14), 0, dp(14), 0)
            gravity = Gravity.CENTER
            minHeight = dp(50)
            isClickable = true
            isFocusable = true
            contentDescription = label
            setOnClickListener { onClick() }
        }
    }

    enum class HeaderButton { BACK, CLOSE }

    /**
     * Back to the sheet this one was opened from (a 38 circle, where the menu has its potato), or close (a 30 circle at
     * the other end). [description] is what TalkBack and tests call it.
     */
    fun headerButton(kind: HeaderButton, description: String = if (kind == HeaderButton.BACK) "Back" else "Close", onClick: () -> Unit): FrameLayout {
        val back = kind == HeaderButton.BACK
        val size = if (back) 38 else 30
        val glyph = if (back) 18 else 16
        return own(FrameLayout(context)).apply {
            background = pressable(soft, cardLine, size / 2f)
            addView(
                icon(if (back) Icon.CHEVRON_LEFT else Icon.CLOSE, if (back) cardText else cardMuted, glyph, strokeWidth = if (back) 2.8f else 2.7f),
                FrameLayout.LayoutParams(dp(glyph), dp(glyph), Gravity.CENTER),
            )
            layoutParams = LinearLayout.LayoutParams(dp(size), dp(size))
            contentDescription = description
            isClickable = true
            isFocusable = true
            setOnClickListener { onClick() }
        }
    }

    /**
     * A sheet's first line, as the menu's: [leading] (the potato, a Back button or a note's pin), the title with a line
     * under it, then [trailing] (the menu's connection, or Close) at the far end.
     */
    fun sheetHeader(title: String, subtitle: String?, leading: View, trailing: View?): LinearLayout {
        val heading = text(title, 20f, maxLines = 1, weight = 700).apply {
            letterSpacing = -0.02f // −0.4 at 20
            androidx.core.view.ViewCompat.setAccessibilityHeading(this, true)
        }
        val titles = column(2, heading, *listOfNotNull(subtitle?.let { text(it, 12f, cardMuted, maxLines = 1) }).toTypedArray())
        return own(LinearLayout(context)).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(4), dp(2), dp(2), dp(6))
            addView(leading)
            addView(titles, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(12) })
            trailing?.let { addView(it, (it.layoutParams as? LinearLayout.LayoutParams ?: LinearLayout.LayoutParams(-2, -2)).apply { marginStart = dp(8) }) }
        }
    }

    enum class TileStyle { PLAIN, PRIMARY, DANGER }

    /** A row's 40 tile (rounded 12): an icon on the soft fill, white on teal for the primary row. */
    fun tile(shape: Icon, style: TileStyle = TileStyle.PLAIN, sizeDp: Int = 40): FrameLayout = own(FrameLayout(context)).apply {
        background = rounded(if (style == TileStyle.PRIMARY) ACCENT else soft, 12)
        val ink = when (style) {
            TileStyle.PRIMARY -> Color.WHITE
            TileStyle.DANGER -> DANGER
            TileStyle.PLAIN -> cardText
        }
        addView(icon(shape, ink, 19), FrameLayout.LayoutParams(dp(19), dp(19), Gravity.CENTER))
        layoutParams = LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp))
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    }

    /**
     * A note's pin as the screen draws it: a 24 circle in its status's colour with its number in white, in a 2 ring
     * (white, or amber while it is not sent yet).
     */
    fun pinMark(number: Int, status: String, pending: Boolean): TextView = text(if (number > 0) number.toString() else "", 12f, Color.WHITE, maxLines = 1, weight = 800).apply {
        gravity = Gravity.CENTER
        background = rounded(statusColor(status), 14, if (pending) PENDING_RING else Color.WHITE, 2)
    }

    /** A tile (rounded 12, soft) holding a note's pin: in the Notes rows (40) and a note's header (38). */
    fun pinTile(number: Int, status: String, pending: Boolean, sizeDp: Int = 40): FrameLayout = own(FrameLayout(context)).apply {
        background = rounded(soft, 12)
        addView(pinMark(number, status, pending), FrameLayout.LayoutParams(dp(28), dp(28), Gravity.CENTER))
        layoutParams = LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp))
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    }

    /**
     * A row of a sheet, as the menu's: a tile, a title with a line under it, and › when it opens another sheet. 58
     * high at least; soft and rounded while pressed.
     */
    fun sheetRow(tile: View, title: String, sub: String, titleColor: Int = cardText, titleLines: Int = 1, opens: Boolean = false, onClick: () -> Unit): LinearLayout {
        val texts = column(2,
            text(title, 15.5f, titleColor, maxLines = titleLines, weight = 600).apply { if (titleLines > 1) ellipsize = TextUtils.TruncateAt.END },
            text(sub, 12.5f, cardMuted, maxLines = 1),
        )
        return own(LinearLayout(context)).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = dp(58)
            setPadding(dp(4), dp(7), dp(4), dp(7))
            background = pressable(Color.TRANSPARENT, soft, 14)
            addView(tile)
            addView(texts, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(14) })
            if (opens) {
                val chevron = text("›", 18f, cardMuted, maxLines = 1).apply { importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }
                addView(chevron, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(12) })
            }
            isClickable = true
            isFocusable = true
            contentDescription = title
            setOnClickListener { onClick() }
        }
    }

    /** Where a group of rows starts: 9 of room with a 1 rule 4 into it. */
    fun groupRule(): View = own(View(context)).apply {
        background = android.graphics.drawable.InsetDrawable(android.graphics.drawable.ColorDrawable(cardLine), 0, dp(4), 0, dp(4))
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(9))
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    /** A label over a text field in a sheet. */
    fun fieldLabel(value: String): TextView = text(value, 12.5f, cardMuted, maxLines = 1, weight = 600).apply {
        setPadding(dp(4), 0, dp(4), 0)
    }

    fun column(spacingDp: Int = 10, vararg children: View): LinearLayout = own(LinearLayout(context)).apply {
        orientation = LinearLayout.VERTICAL
        children.forEachIndexed { index, child ->
            // A child that set its own size (an icon) keeps it.
            val own = child.layoutParams
            addView(child, LinearLayout.LayoutParams(own?.width ?: LinearLayout.LayoutParams.MATCH_PARENT, own?.height ?: LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                if (index > 0) topMargin = dp(spacingDp)
            })
        }
    }

    fun row(spacingDp: Int = 8, vararg children: View): LinearLayout = own(LinearLayout(context)).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        children.forEachIndexed { index, child ->
            // A child that set its own size (an icon: a plain View would fill the row) keeps it.
            val own = child.layoutParams
            addView(child, LinearLayout.LayoutParams(own?.width ?: LinearLayout.LayoutParams.WRAP_CONTENT, own?.height ?: LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                if (index > 0) marginStart = dp(spacingDp)
            })
        }
    }

    fun icon(shape: Icon, color: Int, sizeDp: Int = 20, strokeWidth: Float = 2f): View = own(View(context)).apply {
        background = IconDrawable(shape, color, density, strokeWidth)
        layoutParams = LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp))
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    /** The Notato potato, tilted as on the web and the board. */
    fun potato(sizeDp: Int): ImageView = own(ImageView(context)).apply {
        setImageResource(R.drawable.notato_potato)
        scaleType = ImageView.ScaleType.FIT_CENTER
        rotation = -8f
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        layoutParams = LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp))
    }

    /** A switch in the brand's colours rather than the app theme's. */
    fun tint(switch: android.widget.Switch) {
        val states = arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf())
        switch.thumbTintList = ColorStateList(states, intArrayOf(ACCENT, if (dark) Color.parseColor("#b9bbc0") else Color.WHITE))
        switch.trackTintList = ColorStateList(states, intArrayOf(over(cardBackground, ACCENT, 0.5f), if (dark) Color.parseColor("#4a4c52") else Color.parseColor("#c9cac6")))
    }

    /** A row of choices of which at most one is on; tapping the one that is on turns it off. */
    inner class Chips(options: List<Pair<String, String>>) {
        var selected: String? = null
            private set
        private val views = mutableListOf<Pair<String, TextView>>()
        val view: View

        init {
            val row = own(LinearLayout(context)).apply { orientation = LinearLayout.HORIZONTAL }
            for ((index, option) in options.withIndex()) {
                val (value, label) = option
                val chip = text(label, 13f, cardText, maxLines = 1).apply {
                    setPadding(dp(11), dp(6), dp(11), dp(6))
                    isClickable = true
                    contentDescription = label
                    setOnClickListener { select(if (selected == value) null else value) }
                }
                views += value to chip
                row.addView(chip, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                    if (index > 0) marginStart = dp(6)
                })
            }
            view = own(HorizontalScrollView(context)).apply {
                isHorizontalScrollBarEnabled = false
                addView(row)
            }
            select(null)
        }

        fun select(value: String?) {
            selected = value
            for ((v, chip) in views) {
                val on = v == value
                chip.background = rounded(if (on) ACCENT else Color.TRANSPARENT, 14, if (on) ACCENT else cardLine)
                chip.setTextColor(if (on) Color.WHITE else cardText)
            }
        }
    }
}

/**
 * Whether buttons whose own widths are [widths] can sit side by side in equal shares of [room], [gap] apart: each
 * share must hold the widest of them.
 */
internal fun buttonsFit(widths: List<Int>, room: Int, gap: Int): Boolean {
    if (widths.size <= 1) return true
    return widths.max() * widths.size + gap * (widths.size - 1) <= room
}

/**
 * A sheet's buttons: as wide as they can be, side by side in equal widths 10 apart; one above the other, full width,
 * when they do not fit.
 */
@android.annotation.SuppressLint("ViewConstructor")
internal class ButtonRow(ui: Ui, buttons: List<View>) : android.view.ViewGroup(ui.context) {
    private val gap = ui.dp(10)
    private var stacked = false

    init {
        ui.own(this)
        for (button in buttons) addView(button)
    }

    private fun shown() = (0 until childCount).map { getChildAt(it) }.filter { it.visibility != GONE }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val room = MeasureSpec.getSize(widthMeasureSpec) - paddingLeft - paddingRight
        val views = shown()
        val natural = MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
        for (view in views) view.measure(natural, natural)
        stacked = !buttonsFit(views.map { it.measuredWidth }, room, gap)
        fun exactly(size: Int) = MeasureSpec.makeMeasureSpec(size.coerceAtLeast(0), MeasureSpec.EXACTLY)
        var height = 0
        if (stacked) {
            views.forEachIndexed { index, view ->
                view.measure(exactly(room), exactly(view.measuredHeight))
                height += view.measuredHeight + if (index > 0) gap else 0
            }
        } else if (views.isNotEmpty()) {
            val each = (room - gap * (views.size - 1)) / views.size
            height = views.maxOf { it.measuredHeight }
            for (view in views) view.measure(exactly(each), exactly(height))
        }
        setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), height + paddingTop + paddingBottom)
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        val views = shown().let { if (!stacked && layoutDirection == LAYOUT_DIRECTION_RTL) it.reversed() else it }
        var x = paddingLeft
        var y = paddingTop
        for (view in views) {
            view.layout(x, y, x + view.measuredWidth, y + view.measuredHeight)
            if (stacked) y += view.measuredHeight + gap else x += view.measuredWidth + gap
        }
    }
}

/**
 * The toolbar's and sheets' small icons: SVG path data in a 24 box, stroked round, as in the design. The dots (the
 * menu's three, the grip's six) are filled circles.
 */
internal enum class Icon(private val data: String? = null) {
    CROSSHAIR("M4 12a8 8 0 1 0 16 0a8 8 0 1 0-16 0M12 1.5V6M12 18v4.5M1.5 12H6M18 12h4.5"),
    MORE,
    GRIP,
    CLOSE("M6 6l12 12M18 6 6 18"),
    UP("M12 19V5M5 12l7-7 7 7"),
    EYE("M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0"),
    EYE_OFF("M2 2l20 20M10.7 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a13 13 0 0 1-1.7 2.7M6.6 6.6A13.5 13.5 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 1 0 4.2 4.2"),
    LIST("M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"),
    PACKAGE("M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8"),
    TRASH("M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4h6v2"),
    SLIDERS("M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"),
    MINIMIZE("M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"),
    POWER("M12 2v10M18.4 6.6a9 9 0 1 1-12.8 0"),
    CHEVRON_LEFT("M15 6l-6 6 6 6"),
    CHEVRON_RIGHT("M9 6l6 6-6 6"),

    /** People only, and asides: kept between people. */
    USERS("M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M5 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"),

    /** Settings' Screenshots. */
    CAMERA("M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3zM9 13a3 3 0 1 0 6 0a3 3 0 1 0-6 0"),
    ;

    /** Parsed once, the first time it is drawn. */
    val path: Path? by lazy { data?.let { PathParser.createPathFromPathData(it) } }
}

/** Draws an [Icon] in [color], [strokeWidth] in the icon's 24 box. */
internal class IconDrawable(private val shape: Icon, color: Int, @Suppress("unused") private val density: Float, private val strokeWidth: Float = 2f) : Drawable() {
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        this.color = color
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color }

    override fun draw(canvas: Canvas) {
        val b = bounds
        val s = minOf(b.width(), b.height()) / 24f
        canvas.save()
        canvas.translate(b.left + (b.width() - 24 * s) / 2, b.top + (b.height() - 24 * s) / 2)
        canvas.scale(s, s)
        stroke.strokeWidth = strokeWidth
        when (shape) {
            Icon.MORE -> for (x in listOf(5f, 12f, 19f)) canvas.drawCircle(x, 12f, 1.8f, fill)
            Icon.GRIP -> for (y in listOf(6f, 12f, 18f)) {
                canvas.drawCircle(9f, y, 1.6f, fill)
                canvas.drawCircle(15f, y, 1.6f, fill)
            }
            else -> shape.path?.let { canvas.drawPath(it, stroke) }
        }
        canvas.restore()
    }

    override fun setAlpha(alpha: Int) {
        stroke.alpha = alpha
        fill.alpha = alpha
    }

    override fun setColorFilter(colorFilter: ColorFilter?) {
        stroke.colorFilter = colorFilter
        fill.colorFilter = colorFilter
    }

    @Deprecated("Deprecated in Java")
    override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}
