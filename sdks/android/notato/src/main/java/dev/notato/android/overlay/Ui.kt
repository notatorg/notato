package dev.notato.android.overlay

import android.animation.TimeInterpolator
import android.content.Context
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.InsetDrawable
import android.graphics.drawable.StateListDrawable
import android.os.Build
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.animation.PathInterpolator
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.Switch
import android.widget.TextView
import androidx.core.graphics.ColorUtils
import androidx.core.graphics.drawable.toDrawable
import androidx.core.graphics.toColorInt
import androidx.core.view.ViewCompat
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
        val BAR = "#17181b".toColorInt()
        val BAR_TEXT = "#eceded".toColorInt()
        val BAR_MUTED = "#8b8f97".toColorInt()
        val BAR_PRESSED = "#2a2c31".toColorInt()
        val BAR_LINE = "#33353a".toColorInt()
        val BAR_ACCENT = "#45bfa8".toColorInt()
        val ON_BAR_ACCENT = "#0b1f1b".toColorInt()

        /** The brand: buttons, the primary tile, selected chips, open pins. */
        val ACCENT = "#1f8a78".toColorInt()
        val ACCENT_PRESSED = "#187465".toColorInt()
        val DANGER = "#d6453d".toColorInt()
        val SELECTION = "#ef4444".toColorInt()

        /** The ring of a pin whose note is not sent yet (white otherwise): on the screen and in the sheets alike. */
        val PENDING_RING = "#e9b44c".toColorInt()

        // The server, as the menu's pill shows it (the bar's dot: connectionDotColor).
        val CONNECTED = "#2e9a5b".toColorInt()
        val CONNECTING = "#d99a1e".toColorInt()
        val OFFLINE = "#ef6b5e".toColorInt()

        /** Each status's colour, read once: pins ask for it every time they are drawn. */
        private val STATUS_COLORS = mapOf(
            Status.ACKNOWLEDGED to "#d99a1e",
            Status.RESOLVED to "#2e9a5b",
            Status.REVERT_REQUESTED to "#8b5cf6",
            Status.VARIANT_CHOSEN to "#0891b2",
            Status.REVERTED to "#64748b",
            Status.DISMISSED to "#9a9a9a",
        ).mapValues { it.value.toColorInt() }

        /** A pin's colour: the same for each status as on the web and the board (an open note's is the brand's). */
        fun statusColor(status: String): Int = STATUS_COLORS[status] ?: ACCENT

        /** [color] at [fraction] opacity laid over [base], as CSS's color-mix does it. */
        fun over(base: Int, color: Int, fraction: Float): Int = ColorUtils.blendARGB(base, color, fraction)
    }

    // Sheets and cards: the system's light or dark.
    val cardBackground = (if (dark) "#1d1e21" else "#ffffff").toColorInt()
    val cardText = (if (dark) "#e6e7ea" else "#1d1f22").toColorInt()
    val cardMuted = (if (dark) "#8f939b" else "#686c72").toColorInt()
    val cardLine = (if (dark) "#2f3136" else "#e4e4df").toColorInt()
    /** Icon tiles, fields, a reply's bubble, a row being pressed. */
    val soft = (if (dark) "#26272b" else "#f2f2ef").toColorInt()
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
            ViewCompat.setAccessibilityHeading(this, true)
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
        background = InsetDrawable(cardLine.toDrawable(), 0, dp(4), 0, dp(4))
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
        background = IconDrawable(shape, color, strokeWidth)
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
    fun tint(switch: Switch) {
        val states = arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf())
        switch.thumbTintList = ColorStateList(states, intArrayOf(ACCENT, if (dark) "#b9bbc0".toColorInt() else Color.WHITE))
        switch.trackTintList = ColorStateList(states, intArrayOf(over(cardBackground, ACCENT, 0.5f), if (dark) "#4a4c52".toColorInt() else "#c9cac6".toColorInt()))
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

/** The overlay's easing curves: the same in the toolbar and the sheets. */
internal object Motion {
    /** Quick off the mark and settling gently: things arriving. */
    val SETTLE: TimeInterpolator = PathInterpolator(0.32f, 0.72f, 0f, 1f)

    /** Slow to start, then away: things leaving. */
    val EASE_IN: TimeInterpolator = PathInterpolator(0.42f, 0f, 1f, 1f)
}
