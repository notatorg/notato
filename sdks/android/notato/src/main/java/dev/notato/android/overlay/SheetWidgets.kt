package dev.notato.android.overlay

import android.annotation.SuppressLint
import android.graphics.Color
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Switch
import android.widget.TextView

// The sheets' small parts, shared by the composer and the bottom sheet's pages.

/** A text field in a sheet or the composer: soft, no outline, rounded 12. */
internal fun Ui.field(hint: String, value: String? = null, lines: Int = 1): EditText = own(EditText(context)).apply {
    setText(value)
    this.hint = hint
    setHintTextColor(cardMuted)
    setTextColor(cardText)
    textSize = 15f
    background = rounded(fieldBackground, 12)
    setPadding(dp(12), dp(11), dp(12), dp(11))
    if (lines > 1) {
        minLines = lines
        gravity = Gravity.TOP or Gravity.START
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    } else {
        isSingleLine = true
    }
}

internal fun Ui.badge(text: String, color: Int): TextView = text(text.replace('_', ' '), 11f, color, bold = true, maxLines = 1).apply {
    background = rounded(Color.argb(38, Color.red(color), Color.green(color), Color.blue(color)), 9)
    setPadding(dp(7), dp(2), dp(7), dp(2))
}

/**
 * A note that is People only, as the web toolbar draws it: no fill, a hairline, small muted capitals. It is not a
 * status, so it has no colour.
 */
internal fun Ui.peopleOnlyBadge(): View = text(PEOPLE_ONLY, 10.5f, cardMuted, bold = true, maxLines = 1).apply {
    isAllCaps = true
    letterSpacing = 0.04f
    background = rounded(Color.TRANSPARENT, 9, strokeColor = cardLine)
    setPadding(dp(7), dp(2), dp(7), dp(2))
    contentDescription = PEOPLE_ONLY
}

/** A choice that is on or off: a title, a line saying what it does, and a switch. A tap anywhere on the row flips it. */
@SuppressLint("UseSwitchCompatOrMaterialCode")
internal fun Ui.toggleRow(title: String, hint: String, checked: Boolean = false): Pair<LinearLayout, Switch> {
    val switch = own(Switch(context)).apply {
        isChecked = checked
        contentDescription = title
        tint(this)
    }
    val row = own(LinearLayout(context)).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        addView(column(2, text(title, 15f, weight = 600), text(hint, 12.5f, cardMuted)), LinearLayout.LayoutParams(0, -2, 1f))
        addView(switch, LinearLayout.LayoutParams(-2, -2).apply { marginStart = dp(10) })
        setOnClickListener { if (switch.isEnabled) switch.toggle() }
    }
    return row to switch
}

/**
 * A sheet's row with a switch at its end (Settings' Screenshots): a row's tile, title and line under it, and a tap on
 * the words flips the switch.
 */
@SuppressLint("UseSwitchCompatOrMaterialCode")
internal fun Ui.switchRow(icon: Icon, title: String, sub: String, checked: Boolean): Pair<LinearLayout, Switch> {
    val switch = own(Switch(context)).apply {
        isChecked = checked
        contentDescription = title
        tint(this)
    }
    val row = own(LinearLayout(context)).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        minimumHeight = dp(58)
        setPadding(dp(4), dp(7), dp(4), dp(7))
        addView(tile(icon))
        addView(column(2, text(title, 15.5f, weight = 600), text(sub, 12.5f, cardMuted, maxLines = 2)), LinearLayout.LayoutParams(0, -2, 1f).apply { marginStart = dp(14) })
        addView(switch, LinearLayout.LayoutParams(-2, -2).apply { marginStart = dp(10) })
        setOnClickListener { if (switch.isEnabled) switch.toggle() }
    }
    return row to switch
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
@SuppressLint("ViewConstructor")
internal class ButtonRow(ui: Ui, buttons: List<View>) : ViewGroup(ui.context) {
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
