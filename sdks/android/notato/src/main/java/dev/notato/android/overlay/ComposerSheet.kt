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
import dev.notato.android.model.NoteIntent
import dev.notato.android.model.Severity

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
        // A small heading over each group of controls, and a rule over the sharing switches, as the web composer has them.
        val rule = View(context).apply { setBackgroundColor(ui.cardLine) }
        val visibility = ui.own(LinearLayout(context)).apply {
            orientation = LinearLayout.VERTICAL
            addView(rule, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, ui.dp(1)))
            addView(ui.text("Visibility", 13f, weight = 600), LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = ui.dp(10) })
            addView(shared.first, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = ui.dp(10) })
            addView(peopleOnly.first, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = ui.dp(10) })
        }
        val intentGroup = ui.column(7, ui.text("Feedback type", 13f, weight = 600), intents.view)
        val severityGroup = ui.column(7, ui.text("Severity", 13f, weight = 600), severities.view)
        addView(ui.card(ui.column(12, header, comment, intentGroup, severityGroup, visibility, error, footer)))
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
