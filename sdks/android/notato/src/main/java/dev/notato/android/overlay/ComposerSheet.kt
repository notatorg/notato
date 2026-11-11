package dev.notato.android.overlay

import android.annotation.SuppressLint
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.AccessibilityDelegateCompat
import androidx.core.view.ViewCompat
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat
import dev.notato.android.model.NoteIntent
import dev.notato.android.model.Severity

/**
 * The composer's Visibility button and the two switches it opens: what it says for the switches, its icon, and whether
 * it is open. A composer starts with it closed; the switches show only while it is open.
 */
internal class ComposerVisibility(var shared: Boolean = false, var hiddenFromAgent: Boolean = false) {
    var open = false
        private set

    fun toggle() {
        open = !open
    }

    /** The two switch rows ("Share with project", "Hide from agent") show under the button only while it is open. */
    val switchesShown: Boolean get() = open

    val label: String get() = label(shared, hiddenFromAgent)

    /** What TalkBack says for the button (it adds expanded or collapsed). */
    val description: String get() = "Visibility: $label"

    /** A lock while the note is not shared, two people once it is. */
    val icon: Icon get() = if (shared) Icon.PEOPLE else Icon.LOCK

    /** The chevron points down while closed and up while open. */
    val chevronRotation: Float get() = if (open) 180f else 0f

    companion object {
        /** The button's words, the web composer's: who will see the note. */
        fun label(shared: Boolean, hiddenFromAgent: Boolean): String = when {
            shared && hiddenFromAgent -> "Project, not agent"
            shared -> "Shared with project"
            hiddenFromAgent -> "Only you"
            else -> "You and your agent"
        }

        /** The button's test id (UI Automator's resource id). */
        const val TEST_ID = "NotatoVisibility"
    }
}

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
    sharedByDefault: Boolean = false,
    onParent: () -> Unit,
    onCancel: () -> Unit,
    /** The comment, the intent, the severity and People only. */
    private val onSend: suspend (String, String?, String?, Boolean, Boolean) -> String?,
    private val launch: (suspend () -> Unit) -> Unit,
) : FrameLayout(ui.context) {
    private val titleView = ui.text(title, 15f, bold = true, maxLines = 1)
    private val subtitleView = ui.text(subtitle, 12f, ui.cardMuted, maxLines = 2)
    val comment = ui.field("What should change?", lines = 3).apply { contentDescription = "NotatoComment" }
    private val intents = ui.Chips(listOf(NoteIntent.FIX to "Fix", NoteIntent.CHANGE to "Change", NoteIntent.QUESTION to "Question", NoteIntent.APPROVE to "Approve"))
    private val severities = ui.Chips(
        listOf(Severity.BLOCKER to "Blocker", Severity.MAJOR to "Major", Severity.MINOR to "Minor", Severity.NIT to "Nit"),
        // The severity's colours, the web composer's.
        dots = mapOf(Severity.BLOCKER to Ui.DANGER, Severity.MAJOR to 0xFFD99A1E.toInt(), Severity.MINOR to 0xFF2F6FDE.toInt(), Severity.NIT to 0xFF9A9A9A.toInt())
    )
    private val shared = ui.toggleRow("Share with project", "Project members can see this feedback.").also { it.second.isChecked = sharedByDefault }
    private val peopleOnly = ui.toggleRow(PEOPLE_ONLY, PEOPLE_ONLY_HINT)
    private val error = ui.text(null, 12f, Ui.DANGER).apply { visibility = GONE }
    private val visibilityState = ComposerVisibility(shared = sharedByDefault)
    private val visibilityIcon = ui.icon(visibilityState.icon, ui.cardMuted, 14)
    private val visibilityLabel = ui.text(null, 13.5f, maxLines = 1, weight = 600)
    private val visibilityChevron = ui.icon(Icon.CHEVRON_DOWN, ui.cardMuted, 12)
    private val visibilityButton: LinearLayout
    private val switches: LinearLayout
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
        // The visibility button: a capsule as wide as what it says, opening the two switches under it.
        visibilityButton = ui.row(6, visibilityIcon, visibilityLabel, visibilityChevron).apply {
            setPadding(ui.dp(12), 0, ui.dp(12), 0)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, ui.dp(34))
            isClickable = true
            isFocusable = true
            setOnClickListener { toggleVisibility() }
        }
        ViewCompat.setAccessibilityDelegate(visibilityButton, object : AccessibilityDelegateCompat() {
            override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfoCompat) {
                super.onInitializeAccessibilityNodeInfo(host, info)
                info.className = android.widget.Button::class.java.name
                info.viewIdResourceName = ComposerVisibility.TEST_ID
                info.stateDescription = if (visibilityState.open) "Expanded" else "Collapsed"
                info.addAction(if (visibilityState.open) AccessibilityNodeInfoCompat.AccessibilityActionCompat.ACTION_COLLAPSE else AccessibilityNodeInfoCompat.AccessibilityActionCompat.ACTION_EXPAND)
            }

            override fun performAccessibilityAction(host: View, action: Int, args: android.os.Bundle?): Boolean {
                val wanted = when (action) {
                    AccessibilityNodeInfoCompat.ACTION_EXPAND -> true
                    AccessibilityNodeInfoCompat.ACTION_COLLAPSE -> false
                    else -> return super.performAccessibilityAction(host, action, args)
                }
                if (wanted != visibilityState.open) toggleVisibility()
                return true
            }
        })
        switches = ui.column(10, shared.first, peopleOnly.first)
        shared.second.setOnCheckedChangeListener { _, _ -> showVisibility() }
        peopleOnly.second.setOnCheckedChangeListener { _, _ -> showVisibility() }
        // The type over the comment and the severity under it, with no headings: the groups keep their names for TalkBack.
        titled(intents.view, "Feedback type")
        titled(severities.view, "Severity")
        addView(ui.card(ui.column(12, header, intents.view, comment, severities.view, visibilityButton, switches, error, footer)))
        showVisibility()
        update()
    }

    /** Puts the cursor in the comment and opens the keyboard for it, as the other platforms do. */
    fun focusComment() {
        if (!isAttachedToWindow || !comment.requestFocus()) return
        context.getSystemService(InputMethodManager::class.java)?.showSoftInput(comment, InputMethodManager.SHOW_IMPLICIT)
    }

    fun setTarget(title: String, subtitle: String?) {
        titleView.text = title
        subtitleView.text = subtitle
        subtitleView.visibility = if (subtitle.isNullOrEmpty()) GONE else VISIBLE
    }

    /** Names a group of chips for TalkBack, where a heading over it used to. */
    private fun titled(group: View, title: String) {
        ViewCompat.setAccessibilityDelegate(group, object : AccessibilityDelegateCompat() {
            override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfoCompat) {
                super.onInitializeAccessibilityNodeInfo(host, info)
                info.containerTitle = title
            }
        })
    }

    private fun toggleVisibility() {
        visibilityState.toggle()
        showVisibility()
        val turn = visibilityChevron.animate()
        turn.cancel()
        if (Motion.enabled(context) && isAttachedToWindow) {
            turn.rotation(visibilityState.chevronRotation).setDuration(Motion.IN_MS).setInterpolator(Motion.SETTLE).start()
        } else {
            visibilityChevron.rotation = visibilityState.chevronRotation
        }
    }

    /** The button and the switches as the state has them: called when it opens or closes and when a switch changes. */
    private fun showVisibility() {
        visibilityState.shared = shared.second.isChecked
        visibilityState.hiddenFromAgent = peopleOnly.second.isChecked
        val open = visibilityState.open
        visibilityLabel.text = visibilityState.label
        visibilityIcon.background = IconDrawable(visibilityState.icon, ui.cardMuted)
        visibilityButton.background = ui.pressable(if (open) ui.soft else android.graphics.Color.TRANSPARENT, ui.soft, 17, ui.cardLine)
        visibilityButton.contentDescription = visibilityState.description
        switches.visibility = if (visibilityState.switchesShown) VISIBLE else GONE
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
            val problem = onSend(text, intents.selected, severities.selected, peopleOnly.second.isChecked, shared.second.isChecked)
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
