package dev.notato.android.overlay

import android.annotation.SuppressLint
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.text.Editable
import android.text.InputType
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextWatcher
import android.text.style.StyleSpan
import android.view.Gravity
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewTreeObserver
import android.view.animation.PathInterpolator
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import dev.notato.android.NotatoConnection
import dev.notato.android.NotatoMode
import dev.notato.android.internal.Controller
import dev.notato.android.internal.NoteRecord
import dev.notato.android.internal.Session
import dev.notato.android.model.Intent
import dev.notato.android.model.Severity
import dev.notato.android.model.Status
import kotlinx.coroutines.launch
import kotlin.math.abs

// ---- where a sheet is, and what it says: plain functions, so the tests can pin them --------------------------------

/** Where a sheet is among the others: what Back goes to, what leads its header, and whether folding the toolbar closes it. */
internal sealed interface SheetPlace {
    data object Menu : SheetPlace
    data object Notes : SheetPlace
    data object Settings : SheetPlace
    data object ConfirmClear : SheetPlace

    /** A note's card: opened from its pin on the screen, or from the Notes list (which it goes back to). */
    data class Note(val id: String, val fromList: Boolean) : SheetPlace
}

/** Where Back goes: the menu from what it opens, the list from a note opened there; null where there is no Back. */
internal fun backFrom(place: SheetPlace): SheetPlace? = when (place) {
    SheetPlace.Menu -> null
    SheetPlace.Notes, SheetPlace.Settings, SheetPlace.ConfirmClear -> SheetPlace.Menu
    is SheetPlace.Note -> if (place.fromList) SheetPlace.Notes else null
}

/** What a sheet's header starts with: the potato (the menu), a Back button, or the note's pin (a note opened from it). */
internal enum class HeaderLead { POTATO, BACK, PIN }

internal fun headerLead(place: SheetPlace): HeaderLead = when {
    place == SheetPlace.Menu -> HeaderLead.POTATO
    backFrom(place) != null -> HeaderLead.BACK
    else -> HeaderLead.PIN
}

/**
 * Opened from the toolbar's ⋯, directly or through what it opened (a note from the Notes list included): folding the
 * toolbar closes it. A note opened from its pin on the screen stays.
 */
internal fun closesWithToolbar(place: SheetPlace): Boolean = place !is SheetPlace.Note || place.fromList

/** The sheets' words: the same in every SDK. */
internal object SheetCopy {
    /** The Notes list shows this many; the rest are reached by their pins. */
    const val NOTES_SHOWN = 10

    /** And after them, at most this many without a pin (made elsewhere, or older than the newest pins). */
    const val UNPINNED_SHOWN = 40

    /** The menu's Notes row and the Notes sheet's header: "2 on this screen · 7 in all". */
    fun notes(here: Int, all: Int) = "$here on this screen · $all in all"

    /**
     * Under the Notes list: the notes it does not show, if there are any. [withPins] of this screen's are reached by
     * their pins, [onBoard] have none (only the board shows them), and [others] are on other screens.
     */
    fun notesFooter(withPins: Int, onBoard: Int, others: Int): String? = listOfNotNull(
        withPins.takeIf { it > 0 }?.let { "$it more here: tap their pins." },
        onBoard.takeIf { it > 0 }?.let { "$it more here are on the board." },
        others.takeIf { it > 0 }?.let { "$it more on other screens." },
    ).joinToString(" ").ifEmpty { null }

    /** The menu's Clear notes row and the sheet that confirms it. */
    fun clear(pending: Int) = if (pending == 1) "Removes the note on this device" else "Removes all $pending from this device"

    fun noteTitle(number: Int) = if (number > 0) "Note $number" else "Note"

    /** Who wrote a note and when: "Dom · 2h ago", or whichever of them there is. */
    fun byline(author: String?, ago: String?) = listOfNotNull(author, ago).joinToString(" · ").ifEmpty { null }

    /** A note in the Notes list: "open · People only · 2h ago". */
    fun noteRow(status: String, peopleOnly: Boolean, ago: String?) =
        listOfNotNull(status.replace('_', ' '), PEOPLE_ONLY.takeIf { peopleOnly }, ago).joinToString(" · ")

    /** A note's card shows the last of its thread; the rest are on the board. */
    const val THREAD_SHOWN = 4

    /** Under a long thread: how many replies the card does not show. */
    fun earlier(replies: Int): String? = (replies - THREAD_SHOWN).takeIf { it > 0 }?.let { "$it earlier on the board." }

    fun settings(project: String, mode: NotatoMode) = "Project $project · ${mode.name.lowercase().replaceFirstChar { it.uppercase() }} mode"
}

/** What the Notes list shows of a screen's notes ([rows], in order), and how many it leaves to their pins or the board. */
internal class NotesListing<T>(val rows: List<T>, val withPins: Int, val onBoard: Int)

/**
 * The Notes list's rows from a screen's notes, oldest first: the first [SheetCopy.NOTES_SHOWN], then those without a
 * pin ([hasPin]: notes made on the web or iOS, or older than the newest pins), which could not be opened here otherwise,
 * up to [SheetCopy.UNPINNED_SHOWN] of them. The rest have pins to tap, or are on the board.
 */
internal fun <T> notesListing(notes: List<T>, hasPin: (T) -> Boolean): NotesListing<T> {
    val rest = notes.drop(SheetCopy.NOTES_SHOWN)
    val (withPins, without) = rest.partition(hasPin)
    val unpinned = without.take(SheetCopy.UNPINNED_SHOWN).toSet()
    val rows = notes.take(SheetCopy.NOTES_SHOWN) + rest.filter { it in unpinned }
    return NotesListing(rows, withPins.size, without.size - unpinned.size)
}

// ---- small parts -----------------------------------------------------------------------------------------------------

/** A text field in a sheet or the composer: soft, no outline, rounded 12. */
private fun Ui.field(hint: String, value: String? = null, lines: Int = 1): EditText = own(EditText(context)).apply {
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

private fun Ui.ago(iso: String): String? = runCatching {
    val format = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }
    val seconds = (System.currentTimeMillis() - format.parse(iso.take(19))!!.time) / 1000
    when {
        seconds < 60 -> "just now"
        seconds < 3600 -> "${seconds / 60}m ago"
        seconds < 86400 -> "${seconds / 3600}h ago"
        else -> "${seconds / 86400}d ago"
    }
}.getOrNull()

private fun Ui.badge(text: String, color: Int): TextView = text(text.replace('_', ' '), 11f, color, bold = true, maxLines = 1).apply {
    background = rounded(Color.argb(38, Color.red(color), Color.green(color), Color.blue(color)), 9)
    setPadding(dp(7), dp(2), dp(7), dp(2))
}

// People only and asides: the same words in every SDK.
internal const val PEOPLE_ONLY = "People only"
internal const val PEOPLE_ONLY_HINT = "Keep this between people: the agent won't see it."
internal const val ASIDE = "Aside"
internal const val ASIDE_HINT = "Just for people: the agent won't see this reply."

/** A note's card with no server to send it to (test mode): where the note is, and how it leaves. */
internal const val KEPT_HERE = "Kept on this device. Package it from the menu to share it."

/**
 * A note that is People only, as the web toolbar draws it: no fill, a hairline, small muted capitals. It is not a
 * status, so it has no colour.
 */
private fun Ui.peopleOnlyBadge(): View = text(PEOPLE_ONLY, 10.5f, cardMuted, bold = true, maxLines = 1).apply {
    isAllCaps = true
    letterSpacing = 0.04f
    background = rounded(Color.TRANSPARENT, 9, strokeColor = cardLine)
    setPadding(dp(7), dp(2), dp(7), dp(2))
    contentDescription = PEOPLE_ONLY
}

/** A choice that is on or off: a title, a line saying what it does, and a switch. A tap anywhere on the row flips it. */
@SuppressLint("UseSwitchCompatOrMaterialCode")
private fun Ui.toggleRow(title: String, hint: String, checked: Boolean = false): Pair<LinearLayout, Switch> {
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
private fun Ui.switchRow(icon: Icon, title: String, sub: String, checked: Boolean): Pair<LinearLayout, Switch> {
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

// ---- the note being written --------------------------------------------------------------------------------------------

/**
 * The note being written about the selected element: what, what is wanted, how bad, and whether it is People only
 * (kept between people, never sent to the agent). It floats away from what it is about, with no scrim.
 */
@SuppressLint("ViewConstructor")
internal class ComposerSheet(
    private val ui: Ui,
    title: String,
    subtitle: String?,
    screenshotsOff: Boolean,
    onParent: () -> Unit,
    onCancel: () -> Unit,
    /** The comment, the intent, the severity and People only. */
    private val onSend: suspend (String, String?, String?, Boolean) -> String?,
    private val launch: (suspend () -> Unit) -> Unit,
) : FrameLayout(ui.context) {
    private val titleView = ui.text(title, 15f, bold = true, maxLines = 1)
    private val subtitleView = ui.text(subtitle, 12f, ui.cardMuted, maxLines = 2)
    val comment = ui.field("What should change?", lines = 3).apply { contentDescription = "NotatoComment" }
    private val intents = ui.Chips(listOf(Intent.FIX to "Fix", Intent.CHANGE to "Change", Intent.QUESTION to "Question", Intent.APPROVE to "Approve"))
    private val severities = ui.Chips(listOf(Severity.BLOCKER to "Blocker", Severity.MAJOR to "Major", Severity.MINOR to "Minor", Severity.NIT to "Nit"))
    private val peopleOnly = ui.toggleRow(PEOPLE_ONLY, PEOPLE_ONLY_HINT)
    private val error = ui.text(null, 12f, Ui.DANGER).apply { visibility = GONE }
    private val send: TextView
    private var busy = false

    init {
        ui.own(this)
        subtitleView.visibility = if (subtitle.isNullOrEmpty()) GONE else VISIBLE
        // A soft capsule 30 high.
        val parent = ui.row(5, ui.icon(Icon.UP, ui.cardText, 14, 2.4f), ui.text("Parent", 13.5f, maxLines = 1, weight = 600)).apply {
            background = ui.pressable(ui.soft, ui.cardLine, 15)
            setPadding(ui.dp(11), 0, ui.dp(12), 0)
            minimumHeight = ui.dp(30)
            isClickable = true
            contentDescription = "Select the element around this one"
            setOnClickListener { onParent() }
        }
        // The sheets' Close, named for what it does here.
        val close = ui.headerButton(Ui.HeaderButton.CLOSE, "Cancel") { onCancel() }
        val titles = ui.column(1, titleView, subtitleView)
        val header = ui.own(LinearLayout(context)).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(titles, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(parent, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, ui.dp(30)).apply { marginStart = ui.dp(8) })
            addView(close, LinearLayout.LayoutParams(ui.dp(30), ui.dp(30)).apply { marginStart = ui.dp(8) })
        }
        send = ui.button("Send", primary = true) { send() }.apply { contentDescription = "NotatoSend" }
        val note = ui.text(if (screenshotsOff) "No screenshot: they are turned off." else "Tap another element to change what this note is about.", 12f, ui.cardMuted)
        val footer = ui.own(LinearLayout(context)).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(note, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(send, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { marginStart = ui.dp(10) })
        }
        comment.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) = update()
        })
        addView(ui.card(ui.column(12, header, comment, intents.view, severities.view, peopleOnly.first, error, footer)))
        update()
    }

    fun setTarget(title: String, subtitle: String?) {
        titleView.text = title
        subtitleView.text = subtitle
        subtitleView.visibility = if (subtitle.isNullOrEmpty()) GONE else VISIBLE
    }

    private fun update() {
        send.alpha = if (!busy && comment.text.isNotBlank()) 1f else 0.45f
    }

    private fun send() {
        val text = comment.text.toString().trim()
        if (busy || text.isEmpty()) return
        busy = true
        send.text = "Sending…"
        update()
        launch {
            val problem = onSend(text, intents.selected, severities.selected, peopleOnly.second.isChecked)
            busy = false
            send.text = "Send"
            update()
            if (problem != null) {
                error.text = problem
                error.visibility = VISIBLE
            }
        }
    }
}

// ---- one bottom sheet for the menu and everything it opens ---------------------------------------------------------------

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
                part.animate().alpha(1f).setDuration(160).setInterpolator(SETTLE).start()
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
                animate().translationY(0f).setDuration(280).setInterpolator(SETTLE).start()
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
            downInScroll = scroll.visibility == VISIBLE && event.y >= scroll.top && event.y < scroll.bottom
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
                        animate().translationY(height.toFloat()).setDuration(180).setInterpolator(EASE_IN).withEndAction { dismiss() }.start()
                    } else {
                        animate().translationY(0f).setDuration(220).setInterpolator(SETTLE).start()
                    }
                }
                velocity?.recycle()
                velocity = null
            }
        }
        return true
    }

    private companion object {
        val SETTLE = PathInterpolator(0.32f, 0.72f, 0f, 1f)
        val EASE_IN = PathInterpolator(0.42f, 0f, 1f, 1f)
    }
}

// ---- the sheets ------------------------------------------------------------------------------------------------------------

/** Builds the overlay's sheets, and goes from one to another inside the bottom sheet. */
internal class SheetBuilder(private val controller: Controller, private val session: Session) {
    private val sheets get() = session.overlay
    private val ui get() = sheets.ui

    /** The ⋯ menu, in a new bottom sheet. */
    fun menu(): BottomSheet = BottomSheet(ui, menuPage(), ::close)

    /** A note's card, opened from its pin on the screen, in a new bottom sheet. */
    fun pin(record: NoteRecord, number: Int): BottomSheet = BottomSheet(ui, notePage(record, number, fromList = false), ::close)

    private fun close() = sheets.closeSheet()

    /** Shows [page] in the bottom sheet that is open (from the menu to what it opens, and back), or in a new one. */
    private fun go(page: SheetPage) {
        sheets.hideKeyboard()
        val open = sheets.sheet as? BottomSheet
        if (open != null) open.show(page) else sheets.showSheet(BottomSheet(ui, page, ::close), dim = true)
    }

    private fun back(place: SheetPlace) = when (backFrom(place)) {
        SheetPlace.Menu -> go(menuPage())
        SheetPlace.Notes -> go(notesPage())
        else -> close()
    }

    /** A sheet's header with Back (or [pin], for a note opened from it) and Close. */
    private fun header(place: SheetPlace, title: String, subtitle: String?, pin: (() -> View)? = null): View {
        val leading = when (headerLead(place)) {
            HeaderLead.BACK -> ui.headerButton(Ui.HeaderButton.BACK) { back(place) }
            HeaderLead.PIN -> pin?.invoke() ?: ui.potato(38)
            HeaderLead.POTATO -> ui.potato(38)
        }
        return ui.sheetHeader(title, subtitle, leading, ui.headerButton(Ui.HeaderButton.CLOSE) { close() })
    }

    /** A line of a sheet inset 4, as the rows' words are. */
    private fun inset(view: TextView): TextView = view.apply { setPadding(ui.dp(4), paddingTop, ui.dp(4), paddingBottom) }

    private fun run(status: TextView, action: suspend () -> Unit, done: String) {
        controller.scope.launch {
            try {
                action()
                sheets.closeSheet()
                sheets.toast(done)
            } catch (error: Exception) {
                status.text = error.message
                status.visibility = View.VISIBLE
            }
        }
    }

    // ---- a note ---------------------------------------------------------------------------------------------------------

    /**
     * One note: what was said, where it stands, the thread, and what the person can do now. [draft] and [aside] are a
     * reply being written, kept when the card is built again in place.
     */
    private fun notePage(record: NoteRecord, number: Int, fromList: Boolean, draft: CharSequence? = null, aside: Boolean = false): SheetPage {
        lateinit var page: SheetPage
        page = SheetPage(SheetPlace.Note(record.annotation.id, fromList)) { noteParts(page, record, number, draft, aside) }
        return page
    }

    private fun noteParts(page: SheetPage, record: NoteRecord, number: Int, draft: CharSequence?, aside: Boolean): SheetParts {
        val a = record.annotation
        val fromList = (page.place as SheetPlace.Note).fromList
        val byline = SheetCopy.byline(a.author.name ?: if (a.author.kind == "agent") "An agent" else null, ui.ago(a.createdAt))
        val head = header(page.place, SheetCopy.noteTitle(number), byline) { ui.pinTile(number, a.status, record.pending, sizeDp = 38) }

        val badges = ui.row(5, ui.badge(a.status, Ui.statusColor(a.status)))
        a.intent?.let { badges.addView(ui.badge(it, ui.cardMuted), LinearLayout.LayoutParams(-2, -2).apply { marginStart = ui.dp(5) }) }
        a.severity?.let { badges.addView(ui.badge(it, if (it == Severity.BLOCKER) Ui.DANGER else ui.cardMuted), LinearLayout.LayoutParams(-2, -2).apply { marginStart = ui.dp(5) }) }
        if (a.peopleOnly == true) badges.addView(ui.peopleOnlyBadge(), LinearLayout.LayoutParams(-2, -2).apply { marginStart = ui.dp(5) })
        // Scrolls sideways rather than cut the last badge off on a narrow phone.
        val badgeStrip = ui.own(HorizontalScrollView(ui.context)).apply {
            isHorizontalScrollBarEnabled = false
            addView(badges)
        }
        val rows = mutableListOf<View>(badgeStrip, ui.text(a.comment, 16f))
        a.target.identity.firstOrNull()?.let { id ->
            val target = id.tag + (id.testId?.let { " #$it" } ?: "") + (id.text?.let { " “${if (it.length > 30) it.take(29) + "…" else it}”" } ?: "")
            rows += ui.text(target, 12.5f, ui.cardMuted, maxLines = 2)
        }
        if (record.pending && !controller.hasServer) {
            // Test mode, or no server: nothing is waiting to be sent, the note goes out in a package.
            rows += ui.text(KEPT_HERE, 12.5f, ui.cardMuted)
        } else if (record.pending) {
            val why = record.error?.let { "Not sent: $it" } ?: record.held?.let { "Not sent yet (kept here, tried again on reconnect): $it" }
            rows += ui.text(why ?: "Not sent yet: it goes when the server can be reached.", 12.5f, Ui.CONNECTING)
        }
        val status = inset(ui.text(null, 12.5f, Ui.DANGER)).apply { visibility = View.GONE }
        var replyField: EditText? = null
        var asideSwitch: Switch? = null
        // People only, for the note and its thread: through the server for a note it has, here for one still waiting.
        if (record.pending || controller.hasServer) {
            val (row, switch) = ui.toggleRow(PEOPLE_ONLY, PEOPLE_ONLY_HINT, a.peopleOnly == true)
            var undoing = false
            switch.setOnCheckedChangeListener { view, on ->
                if (undoing) return@setOnCheckedChangeListener
                view.isEnabled = false
                status.visibility = View.GONE
                controller.scope.launch {
                    try {
                        controller.setPeopleOnly(a.id, on)
                        // Built again with the change in it (the badge, and the entry recording it), unless it was left meanwhile.
                        val now = controller.notes[a.id] ?: return@launch
                        val open = sheets.sheet as? BottomSheet
                        if (open?.page === page) {
                            open.show(notePage(now, number, fromList, replyField?.text, asideSwitch?.isChecked == true), fade = false, keepScroll = true)
                        }
                    } catch (error: Exception) {
                        undoing = true
                        view.isChecked = !on
                        undoing = false
                        view.isEnabled = true
                        status.text = error.message ?: "Could not change People only."
                        status.visibility = View.VISIBLE
                    }
                }
            }
            rows += row
        }
        for (reply in a.thread.takeLast(SheetCopy.THREAD_SHOWN)) {
            val who = reply.author.name ?: if (reply.author.kind == "agent") "Agent" else "You"
            val text = SpannableStringBuilder("$who: ").apply {
                setSpan(StyleSpan(android.graphics.Typeface.BOLD), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                append(reply.body)
            }
            rows += if (reply.aside == true) {
                // An aside is muted and outlined rather than filled, and says so: it was kept from the agent.
                val label = ui.row(4, ui.icon(Icon.USERS, ui.cardMuted, 11), ui.text(ASIDE, 11f, ui.cardMuted, maxLines = 1, weight = 700))
                ui.column(3, label, ui.text(text, 13f, ui.cardMuted)).apply {
                    background = ui.rounded(Color.TRANSPARENT, 12, ui.cardLine)
                    setPadding(ui.dp(11), ui.dp(6), ui.dp(11), ui.dp(7))
                    contentDescription = "$ASIDE. $text"
                }
            } else {
                ui.text(text, 13f).apply {
                    background = ui.rounded(ui.soft, 12)
                    setPadding(ui.dp(11), ui.dp(7), ui.dp(11), ui.dp(7))
                }
            }
        }
        SheetCopy.earlier(a.thread.size)?.let { rows += ui.text(it, 12f, ui.cardMuted) }
        val buttons = mutableListOf<View>()
        if (controller.hasServer && !record.pending) {
            val reply = ui.field(if (a.status == Status.RESOLVED) "Reply, or say what was wrong" else "Reply").apply { setText(draft) }
            // An aside: this one reply is for the people on the thread. Off again for the next reply.
            val (asideRow, asideToggle) = ui.toggleRow(ASIDE, ASIDE_HINT, aside)
            replyField = reply
            asideSwitch = asideToggle
            rows += reply
            rows += asideRow
            if (a.status == Status.RESOLVED) {
                buttons += ui.sheetButton("Ask the agent to revert") { run(status, { controller.requestRevert(a.id, reply.text.toString()) }, "Asked the agent to undo that change") }
            }
            if (a.status == Status.REVERT_REQUESTED) {
                buttons += ui.sheetButton("Cancel request") { run(status, { controller.cancelRevert(a.id) }, "Revert request taken back") }
            }
            if (record.mine && a.status == Status.OPEN) {
                buttons += ui.sheetButton("Delete", Ui.ButtonKind.DANGER) { run(status, { controller.delete(a.id) }, "Note deleted") }
            }
            buttons += ui.sheetButton("Reply", Ui.ButtonKind.PRIMARY) {
                val text = reply.text.toString().trim()
                if (text.isEmpty()) {
                    status.text = "Write a reply first."
                    status.visibility = View.VISIBLE
                } else {
                    val isAside = asideToggle.isChecked
                    run(status, {
                        controller.reply(a.id, text, aside = isAside)
                        asideToggle.isChecked = false
                    }, if (isAside) "Aside sent" else "Reply sent")
                }
            }
        } else {
            // Close is the header's ×.
            buttons += ui.sheetButton("Delete", Ui.ButtonKind.DANGER) { run(status, { controller.delete(a.id) }, "Note deleted") }
        }
        val body = ui.column(12, *rows.toTypedArray()).apply { setPadding(ui.dp(4), 0, ui.dp(4), 0) }
        return SheetParts(top = listOf(head), body = body, bottom = listOf(ButtonRow(ui, buttons), status), gap = 14)
    }

    // ---- the ⋯ menu -----------------------------------------------------------------------------------------------------

    /** The ⋯ menu: built again in place whenever what it shows changes, so the server's state is live in it. */
    private fun menuPage() = SheetPage(SheetPlace.Menu, ::menuState) {
        SheetParts(top = listOfNotNull(menuHeader(), menuBanner()), body = menuRows(), gap = 10)
    }

    /** Everything the menu shows: it is built again when this changes. */
    private fun menuState(): List<Any?> = listOf(
        controller.mode, controller.serverHost, controller.hasServer, controller.connection, controller.failure, controller.retrying,
        controller.pinsVisible, controller.recordsOnRoute(session).size, controller.notes.size, controller.pendingCount, controller.shakeAvailable,
    )

    private fun menuRows(): View {
        val here = controller.recordsOnRoute(session).size
        val pending = controller.pendingCount
        /** A row that closes the menu, then does what it is for. */
        fun row(icon: Icon, title: String, sub: String, style: Ui.TileStyle = Ui.TileStyle.PLAIN, opens: Boolean = false, action: () -> Unit): View =
            ui.sheetRow(ui.tile(icon, style), title, sub, if (style == Ui.TileStyle.DANGER) Ui.DANGER else ui.cardText, opens = opens) {
                close()
                action()
            }
        /** A row that opens another sheet in this one: with ›, but for a question asked before something is done. */
        fun opens(icon: Icon, title: String, sub: String, style: Ui.TileStyle = Ui.TileStyle.PLAIN, chevron: Boolean = true, page: () -> SheetPage): View =
            ui.sheetRow(ui.tile(icon, style), title, sub, if (style == Ui.TileStyle.DANGER) Ui.DANGER else ui.cardText, opens = chevron) { go(page()) }

        val groups = mutableListOf<List<View>>()
        groups += listOf(
            row(Icon.CROSSHAIR, "Annotate", "Tap an element, write a note", Ui.TileStyle.PRIMARY) { controller.startAnnotating() },
            row(
                if (controller.pinsVisible) Icon.EYE_OFF else Icon.EYE,
                if (controller.pinsVisible) "Hide pins" else "Show pins",
                when (here) {
                    0 -> "No pins on this screen"
                    1 -> "1 pin on this screen"
                    else -> "$here pins on this screen"
                },
            ) { controller.togglePins() },
            opens(Icon.LIST, "Notes", SheetCopy.notes(here, controller.notes.size)) { notesPage() },
        )
        if (controller.mode == NotatoMode.TEST && pending > 0) {
            groups += listOf(
                row(Icon.PACKAGE, "Package and share", "Zip with screenshots, share anywhere", opens = true) {
                    controller.scope.launch { controller.packageAndShare(session) }
                },
                opens(Icon.TRASH, "Clear notes", SheetCopy.clear(pending), Ui.TileStyle.DANGER, chevron = false) { clearPage() },
            )
        }
        groups += listOf(
            opens(Icon.SLIDERS, "Settings", "Your name, screenshots, server") { settingsPage() },
        )
        groups += listOf(
            row(Icon.MINIMIZE, "Hide toolbar", if (controller.shakeAvailable) "Shake to bring it back" else "The app can bring it back") { controller.setToolbar(false) },
            row(Icon.POWER, "Turn Notato off", "Until the app turns it on again", Ui.TileStyle.DANGER) { controller.setEnabled(false, remember = true) },
        )
        val rows = ui.own(LinearLayout(ui.context)).apply { orientation = LinearLayout.VERTICAL }
        for ((index, group) in groups.withIndex()) {
            // Each group but the first starts after a little room, with a rule in the middle of it.
            if (index > 0) rows.addView(ui.groupRule())
            for (row in group) rows.addView(row, LinearLayout.LayoutParams(-1, -2))
        }
        return rows
    }

    /** The potato, "Notato", the mode and server, and (with a server) how the connection is. */
    private fun menuHeader(): View {
        val mode = controller.mode.name.lowercase().replaceFirstChar { it.uppercase() }
        val sub = "$mode mode · ${controller.serverHost ?: "notes stay on this phone"}"
        return ui.sheetHeader("Notato", sub, ui.potato(38), statusPill())
    }

    /** Connected, connecting or offline; nothing when there is no server to be connected to. */
    private fun statusPill(): View? {
        if (!controller.hasServer) return null
        val (label, color) = when (controller.connection) {
            NotatoConnection.CONNECTED -> "Connected" to Ui.CONNECTED
            // The backoff's own tries keep saying offline; a Retry, or the first try, says it is connecting.
            NotatoConnection.CONNECTING -> if (controller.failure != null && !controller.retrying) "Offline" to Ui.OFFLINE else "Connecting…" to Ui.CONNECTING
            NotatoConnection.OFFLINE -> "Offline" to Ui.OFFLINE
            NotatoConnection.REFUSED -> "Refused" to Ui.OFFLINE
            else -> return null
        }
        val dot = ui.own(View(ui.context)).apply {
            background = ui.rounded(color, 3.5)
            layoutParams = LinearLayout.LayoutParams(ui.dp(7), ui.dp(7))
        }
        return ui.row(6, dot, ui.text(label, 12f, maxLines = 1, weight = 700)).apply {
            background = ui.rounded(Ui.over(ui.cardBackground, color, 0.14f), 999)
            setPadding(ui.dp(10), ui.dp(4), ui.dp(10), ui.dp(4))
        }
    }

    /** With a server that cannot be reached (or refused this app): what that means, and Retry. */
    private fun menuBanner(): View? {
        if (!controller.hasServer) return null
        val down = when (controller.connection) {
            NotatoConnection.OFFLINE, NotatoConnection.REFUSED -> controller.connection
            NotatoConnection.CONNECTING -> controller.failure
            else -> null
        } ?: return null
        val host = controller.serverHost ?: "The server"
        val detail = controller.failureDetail ?: controller.connectionDetail
        val (title, body) = if (down == NotatoConnection.REFUSED) {
            "The server refused this app" to "${detail ?: "$host refused this app."} Notes stay on this phone."
        } else {
            // Two reasons are worth saying instead, as they are fixed in the app, not the server: Android blocking plain
            // http, and an address that is not a URL (saved before addresses were checked).
            val fixedHere = detail?.takeIf { it.startsWith("Android blocked") || it.contains("is not a valid URL") }
            "Can't reach the server" to (fixedHere ?: "$host isn't answering. Notes stay on this phone and send when it's back.")
        }
        val texts = ui.column(2,
            ui.text(title, 13f, weight = 700),
            ui.text(body, 13f, ui.cardMuted).apply { setLineSpacing(0f, 1.2f) },
        )
        val retrying = controller.retrying
        val retry = ui.text(if (retrying) "Trying…" else "Retry", 13f, ui.cardBackground, maxLines = 1, weight = 700).apply {
            background = ui.pressable(ui.cardText, Ui.over(ui.cardText, ui.cardBackground, 0.25f), 10)
            setPadding(ui.dp(12), ui.dp(7), ui.dp(12), ui.dp(7))
            alpha = if (retrying) 0.6f else 1f
            contentDescription = "Retry"
            setOnClickListener { if (!controller.retrying) controller.retryNow() }
            // After the listener, which makes a view clickable again: no second try while one is going.
            isClickable = !retrying
            isEnabled = !retrying
        }
        return ui.own(LinearLayout(ui.context)).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.TOP
            background = ui.rounded(Ui.over(ui.cardBackground, Ui.OFFLINE, 0.12f), 16)
            setPadding(ui.dp(12), ui.dp(11), ui.dp(12), ui.dp(11))
            addView(texts, LinearLayout.LayoutParams(0, -2, 1f))
            addView(retry, LinearLayout.LayoutParams(-2, -2).apply { marginStart = ui.dp(10) })
        }
    }

    // ---- what the menu opens ----------------------------------------------------------------------------------------------

    /** The notes on this screen (the first ten), each opening its card with Back to this list. */
    private fun notesPage() = SheetPage(SheetPlace.Notes) {
        val list = controller.recordsOnRoute(session)
        val all = controller.notes.size
        val rows = ui.own(LinearLayout(ui.context)).apply { orientation = LinearLayout.VERTICAL }
        if (list.isEmpty()) {
            rows.addView(ui.sheetRow(ui.tile(Icon.CROSSHAIR, Ui.TileStyle.PRIMARY), "Annotate", "No notes on this screen yet") {
                close()
                controller.startAnnotating()
            })
        }
        val pinned = controller.pinnedOn(session)
        val listing = notesListing(list) { it.second.annotation.id in pinned }
        for ((number, record) in listing.rows) {
            val a = record.annotation
            val row = ui.sheetRow(
                ui.pinTile(number, a.status, record.pending), a.comment,
                SheetCopy.noteRow(a.status, a.peopleOnly == true, ui.ago(a.createdAt)), titleLines = 2, opens = true,
            ) { go(notePage(record, number, fromList = true)) }
            rows.addView(row, LinearLayout.LayoutParams(-1, -2))
        }
        SheetCopy.notesFooter(listing.withPins, listing.onBoard, all - list.size)?.let { more ->
            rows.addView(ui.groupRule())
            rows.addView(ui.text(more, 12.5f, ui.cardMuted).apply { setPadding(ui.dp(4), ui.dp(5), ui.dp(4), ui.dp(2)) }, LinearLayout.LayoutParams(-1, -2))
        }
        SheetParts(top = listOf(header(SheetPlace.Notes, "Notes", SheetCopy.notes(list.size, all))), body = rows, gap = 10)
    }

    private fun settingsPage() = SheetPage(SheetPlace.Settings) {
        val name = ui.field("Your name, on your notes", controller.authorName)
        val server = ui.field(controller.config.resolvedServer ?: "No server: notes stay on this device", controller.serverOverride).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        }
        val serverError = inset(ui.text(null, 12.5f, Ui.DANGER)).apply { visibility = View.GONE }
        val (shotsRow, screenshots) = ui.switchRow(
            Icon.CAMERA, "Screenshots",
            if (controller.serverScreenshots) "Each note takes one of the screen" else "The server has them turned off",
            controller.screenshotsWanted,
        )
        val body = ui.column(14,
            ui.column(6, ui.fieldLabel("Your name"), name),
            ui.column(6, ui.fieldLabel("Server"), server, serverError, inset(ui.text(controller.describeConnection(), 12f, ui.cardMuted))),
            shotsRow,
        )
        val buttons = ButtonRow(ui, listOf(
            ui.sheetButton("Reset") {
                controller.resetRuntimeState()
                close()
                sheets.toast("Back to the app's configured settings")
            },
            ui.sheetButton("Save", Ui.ButtonKind.PRIMARY) {
                val problem = controller.saveSettings(name.text.toString(), screenshots.isChecked, server.text.toString())
                if (problem == null) {
                    close()
                } else {
                    serverError.text = problem
                    serverError.visibility = View.VISIBLE
                }
            },
        ))
        SheetParts(
            top = listOf(header(SheetPlace.Settings, "Settings", SheetCopy.settings(controller.config.project, controller.mode))),
            body = body, bottom = listOf(buttons), gap = 14,
        )
    }

    private fun clearPage() = SheetPage(SheetPlace.ConfirmClear) {
        SheetParts(
            top = listOf(header(SheetPlace.ConfirmClear, "Clear notes?", SheetCopy.clear(controller.pendingCount))),
            body = inset(ui.text("A package you already shared keeps them.", 13.5f, ui.cardMuted)),
            bottom = listOf(ButtonRow(ui, listOf(
                ui.sheetButton("Keep them") { close() },
                ui.sheetButton("Clear", Ui.ButtonKind.DESTRUCTIVE) {
                    controller.clearLocal()
                    close()
                    sheets.toast("Notes cleared")
                },
            ))),
            gap = 14,
        )
    }
}
