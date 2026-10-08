package dev.notato.android.overlay

import dev.notato.android.NotatoMode
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

// Where a sheet is, and what it says: plain functions, so the tests can pin them.

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

    /** How long ago [iso] was, as the sheets say it: "just now", "5m ago", "2h ago", "3d ago". Null when it cannot be read. */
    fun ago(iso: String, now: Long = System.currentTimeMillis()): String? {
        val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        val at = runCatching { format.parse(iso.take(19)) }.getOrNull() ?: return null
        val seconds = (now - at.time) / 1000
        return when {
            seconds < 60 -> "just now"
            seconds < 3600 -> "${seconds / 60}m ago"
            seconds < 86400 -> "${seconds / 3600}h ago"
            else -> "${seconds / 86400}d ago"
        }
    }
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

// People only and asides: the same words in every SDK.
internal const val PEOPLE_ONLY = "People only"
internal const val PEOPLE_ONLY_HINT = "Keep this between people: the agent won't see it."
internal const val ASIDE = "Aside"
internal const val ASIDE_HINT = "Just for people: the agent won't see this reply."

/** A note's card with no server to send it to (test mode): where the note is, and how it leaves. */
internal const val KEPT_HERE = "Kept on this device. Package it from the menu to share it."
