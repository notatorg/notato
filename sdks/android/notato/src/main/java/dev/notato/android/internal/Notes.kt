package dev.notato.android.internal

import android.view.View
import dev.notato.android.inspect.Box
import dev.notato.android.inspect.Reading
import dev.notato.android.inspect.Selectors
import dev.notato.android.inspect.ViewInspector
import dev.notato.android.model.Annotation
import java.io.File
import java.lang.ref.WeakReference

/** What an element said when a note was made on it: its view is followed for the pin only while it still says this. */
internal data class ViewKey(val identifier: String?, val words: String?)

/** A note Notato knows of: from the server, or made here and not sent yet. Changed on the main thread only. */
internal class NoteRecord(
    var annotation: Annotation,
    /** Made here and not yet taken by the server (or, in test mode, not yet packaged). */
    var pending: Boolean = false,
    var mine: Boolean = false,
    /** Its screenshots on disk, by asset id, until the server has them: read only when the note is sent or packaged. */
    var assets: Map<String, File>? = null,
) {
    /** Why the server refused it for good: it is not sent again (until the next launch). */
    var error: String? = null

    /** What the server said when it did not take it for now (a project it does not have): it stays queued. */
    var held: String? = null

    /** When it last changed here, on the controller's clock: a list asked for before then is older than it. */
    var touched: Long = 0

    /**
     * People only was turned on or off here while the note waited to be sent. Once the server has the note, its copy
     * is checked against this one: a change made while the note was on its way must not be lost.
     */
    var peopleOnlyChanged: Boolean = false

    /** A send of it is under way: nothing sends it again until that one is done, so it is never posted twice at once. */
    var sending: Boolean = false

    /** Deleted here while it was on its way to the server: once the server has it, it is deleted there too. */
    var deletedHere: Boolean = false

    /** The view it was made on, followed live for its pin while it still shows what the note is about ([viewKey]). */
    var view: WeakReference<View>? = null
    var viewKey: ViewKey? = null

    /**
     * Where the view it was made on is, while that view is on screen and still shows what the note is about. A list's
     * recycled row shows another item: the reference is dropped, and the note's selector finds it from then on.
     */
    fun liveBounds(maskInputs: Boolean): Box? {
        val view = view?.get() ?: return null
        if (!view.isAttachedToWindow || !view.isShown) return null
        val now = ViewInspector.describe(view, maskInputs, Reading(lite = true))
        if (viewKey != ViewKey(now.identifier, now.words)) {
            this.view = null
            return null
        }
        return now.bounds
    }

    private var parsedFrom: String? = null
    private var parsed: Selectors.Parsed? = null

    /**
     * The note's selector, parsed once and again only when it changes: the pins look every note up several times a
     * second. Null when the note has none, or one this SDK cannot read (a web note's CSS).
     */
    fun selector(): Selectors.Parsed? {
        val raw = annotation.target.identity.firstOrNull()?.selector ?: return null
        if (raw != parsedFrom) {
            parsedFrom = raw
            parsed = try {
                Selectors.parse(raw)
            } catch (_: IllegalArgumentException) {
                null
            }
        }
        return parsed
    }
}

/**
 * The notes here, in the order they came, with an index by id kept in step with them: a list of thousands from the
 * server is matched against them in one pass, not one search per note. Main thread only.
 */
internal class NoteBook {
    private val list = ArrayList<NoteRecord>()
    private val byId = HashMap<String, NoteRecord>()

    /**
     * Goes up with every change to the notes or to one of them (see [changed]): what is worked out from them (the pins,
     * each screen's notes, the state the app sees) is worked out again only when it has moved.
     */
    var version: Long = 0
        private set

    val all: List<NoteRecord> get() = list
    val size: Int get() = list.size

    operator fun get(id: String): NoteRecord? = byId[id]

    operator fun contains(id: String): Boolean = id in byId

    /** Adds a note; one already here with its id is replaced where it is. */
    fun add(record: NoteRecord) {
        val old = byId.put(record.annotation.id, record)
        if (old == null) list += record else list[list.indexOf(old)] = record
        version++
    }

    fun remove(id: String): NoteRecord? {
        val record = byId.remove(id) ?: return null
        list.remove(record)
        version++
        return record
    }

    /** Removes every note [predicate] picks, in one pass. */
    fun removeAll(predicate: (NoteRecord) -> Boolean): Boolean {
        val removed = list.removeAll { record -> predicate(record).also { if (it) byId.remove(record.annotation.id) } }
        if (removed) version++
        return removed
    }

    fun clear() {
        list.clear()
        byId.clear()
        version++
    }

    /** One of the notes changed in place (its annotation, or whether it is sent). */
    fun changed() {
        version++
    }

    /**
     * Takes the server's copy of a note: a new one, a change, or (for one waiting here) word that it arrived. One of
     * another project, or one [ignored] (deleted here), is left out. Returns the note that was waiting and what it was
     * here, when it is one that has just arrived: the caller finishes it off (its files, People only).
     */
    fun take(annotation: Annotation, project: String, ignored: (String) -> Boolean, touch: (NoteRecord) -> Unit): Arrival? {
        if (annotation.projectId != project || ignored(annotation.id)) return null
        val existing = byId[annotation.id]
        if (existing == null) {
            add(NoteRecord(annotation).also(touch))
            return null
        }
        val local = existing.annotation
        existing.annotation = annotation
        touch(existing)
        if (!existing.pending) return null
        existing.pending = false
        existing.error = null
        existing.held = null
        existing.assets = null
        return Arrival(existing, local)
    }

    /**
     * The server's answer to posting [record]: its copy, [stored]. Taken only while the note still waits here: an event
     * can bring the server's copy before this answer does, and changes made since with it, which are newer than this
     * answer. True when it was taken.
     */
    fun posted(record: NoteRecord, stored: Annotation, touch: (NoteRecord) -> Unit): Boolean {
        if (!record.pending) return false
        record.annotation = stored
        record.pending = false
        record.error = null
        record.held = null
        record.assets = null
        touch(record)
        return true
    }

    /** The notes to send, in the order they came: waiting, not refused, not on their way already, and not deleted. */
    fun queue(): List<NoteRecord> = list.filter { it.pending && it.error == null && !it.sending && !it.deletedHere }

    /** A note that waited here and that the server now has, with the copy it had here. */
    class Arrival(val record: NoteRecord, val local: Annotation)
}
