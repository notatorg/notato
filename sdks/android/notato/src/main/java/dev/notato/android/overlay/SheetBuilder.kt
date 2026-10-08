package dev.notato.android.overlay

import android.graphics.Color
import android.graphics.Typeface
import android.text.InputType
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.StyleSpan
import android.view.Gravity
import android.view.View
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.Switch
import android.widget.TextView
import dev.notato.android.NotatoConnection
import dev.notato.android.NotatoMode
import dev.notato.android.internal.Controller
import dev.notato.android.internal.NoteRecord
import dev.notato.android.internal.Session
import dev.notato.android.model.Severity
import dev.notato.android.model.Status
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Builds the overlay's sheets, and goes from one to another inside the bottom sheet. */
internal class SheetBuilder(private val controller: Controller, private val session: Session) {
    private val sheets get() = session.overlay
    private val ui get() = sheets.ui
    private val sync get() = controller.sync

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
            } catch (error: CancellationException) {
                throw error
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
        val byline = SheetCopy.byline(a.author.name ?: if (a.author.kind == "agent") "An agent" else null, SheetCopy.ago(a.createdAt))
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
                        sync.setPeopleOnly(a.id, on)
                        // Built again with the change in it (the badge, and the entry recording it), unless it was left meanwhile.
                        val now = sync.notes[a.id] ?: return@launch
                        val open = sheets.sheet as? BottomSheet
                        if (open?.page === page) {
                            open.show(notePage(now, number, fromList, replyField?.text, asideSwitch?.isChecked == true), fade = false, keepScroll = true)
                        }
                    } catch (error: CancellationException) {
                        throw error
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
                setSpan(StyleSpan(Typeface.BOLD), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
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
                buttons += ui.sheetButton("Ask the agent to revert") { run(status, { sync.requestRevert(a.id, reply.text.toString()) }, "Asked the agent to undo that change") }
            }
            if (a.status == Status.REVERT_REQUESTED) {
                buttons += ui.sheetButton("Cancel request") { run(status, { sync.cancelRevert(a.id) }, "Revert request taken back") }
            }
            if (record.mine && a.status == Status.OPEN) {
                buttons += ui.sheetButton("Delete", Ui.ButtonKind.DANGER) { run(status, { sync.delete(a.id) }, "Note deleted") }
            }
            buttons += ui.sheetButton("Reply", Ui.ButtonKind.PRIMARY) {
                val text = reply.text.toString().trim()
                if (text.isEmpty()) {
                    status.text = "Write a reply first."
                    status.visibility = View.VISIBLE
                } else {
                    val isAside = asideToggle.isChecked
                    run(status, {
                        sync.reply(a.id, text, aside = isAside)
                        asideToggle.isChecked = false
                    }, if (isAside) "Aside sent" else "Reply sent")
                }
            }
        } else {
            // Close is the header's ×.
            buttons += ui.sheetButton("Delete", Ui.ButtonKind.DANGER) { run(status, { sync.delete(a.id) }, "Note deleted") }
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
        controller.mode, controller.serverHost, controller.hasServer, sync.connection, sync.failure, sync.retrying,
        controller.pinsVisible, controller.recordsOnRoute(session).size, sync.notes.size, controller.pendingCount, controller.shakeAvailable,
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
            opens(Icon.LIST, "Notes", SheetCopy.notes(here, sync.notes.size)) { notesPage() },
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
        val (label, color) = when (sync.connection) {
            NotatoConnection.CONNECTED -> "Connected" to Ui.CONNECTED
            // The backoff's own tries keep saying offline; a Retry, or the first try, says it is connecting.
            NotatoConnection.CONNECTING -> if (sync.failure != null && !sync.retrying) "Offline" to Ui.OFFLINE else "Connecting…" to Ui.CONNECTING
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
        val down = when (sync.connection) {
            NotatoConnection.OFFLINE, NotatoConnection.REFUSED -> sync.connection
            NotatoConnection.CONNECTING -> sync.failure
            else -> null
        } ?: return null
        val host = controller.serverHost ?: "The server"
        val detail = sync.failureDetail ?: sync.connectionDetail
        val (title, body) = if (down == NotatoConnection.REFUSED) {
            "The server refused this app" to "${detail ?: "$host refused this app."} Notes stay on this phone."
        } else {
            // Two reasons are worth saying instead, as they are fixed in the app, not the server: Android blocking plain
            // http, and an address that cannot be read as a URL.
            val fixedHere = detail?.takeIf { it.startsWith("Android blocked") || it.contains("is not a valid URL") }
            "Can't reach the server" to (fixedHere ?: "$host isn't answering. Notes stay on this phone and send when it's back.")
        }
        val texts = ui.column(2,
            ui.text(title, 13f, weight = 700),
            ui.text(body, 13f, ui.cardMuted).apply { setLineSpacing(0f, 1.2f) },
        )
        val retrying = sync.retrying
        val retry = ui.text(if (retrying) "Trying…" else "Retry", 13f, ui.cardBackground, maxLines = 1, weight = 700).apply {
            background = ui.pressable(ui.cardText, Ui.over(ui.cardText, ui.cardBackground, 0.25f), 10)
            setPadding(ui.dp(12), ui.dp(7), ui.dp(12), ui.dp(7))
            alpha = if (retrying) 0.6f else 1f
            contentDescription = "Retry"
            setOnClickListener { if (!sync.retrying) sync.retryNow() }
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
        val all = sync.notes.size
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
                SheetCopy.noteRow(a.status, a.peopleOnly == true, SheetCopy.ago(a.createdAt)), titleLines = 2, opens = true,
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
            if (sync.serverScreenshots) "Each note takes one of the screen" else "The server has them turned off",
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
                    sync.clearLocal()
                    close()
                    sheets.toast("Notes cleared")
                },
            ))),
            gap = 14,
        )
    }
}
