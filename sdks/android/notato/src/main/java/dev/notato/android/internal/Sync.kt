package dev.notato.android.internal

import dev.notato.android.model.AnnotateRequest
import dev.notato.android.model.Annotation
import dev.notato.android.model.NotatoJson
import dev.notato.android.model.ServerEventData
import dev.notato.android.net.NotatoServerException
import dev.notato.android.net.ServerSentEvent

/** How sending one note went. */
internal enum class SendOutcome {
    SENT,

    /** Refused for good (400, 409, 413, 415, 422): marked failed on the note, and the queue goes on past it. */
    REFUSED,

    /** Not now (no answer, 401, 403, 404, 408, 429, 5xx): kept, and the queue waits for the next try. */
    HELD,
}

internal fun outcomeOf(error: NotatoServerException): SendOutcome = if (error.refused) SendOutcome.REFUSED else SendOutcome.HELD

/** Sends [queue] in order. A note refused for good never blocks the ones after it; anything else stops the run. */
internal suspend fun <T> sendQueue(queue: List<T>, send: suspend (T) -> SendOutcome) {
    for (item in queue) if (send(item) == SendOutcome.HELD) return
}

/** What a full list from the server changes here: the notes to take from it, and the ids to drop. */
internal class ListMerge(val upserts: List<Annotation>, val drops: Set<String>)

/**
 * Matches the notes here to [listed], the server's whole list, asked for when the records' clock read [since]. What
 * changed here after that (a note made or sent here, an event heard) is newer than the list and is left as it is; a
 * note deleted after that ([deletedSince]) is not brought back; a note still waiting to be sent is never dropped.
 */
internal fun mergeList(records: List<NoteRecord>, listed: List<Annotation>, since: Long, deletedSince: Set<String>): ListMerge {
    val here = records.associateBy { it.annotation.id }
    val upserts = listed.filter { annotation ->
        if (annotation.id in deletedSince) return@filter false
        val record = here[annotation.id] ?: return@filter true
        // A note waiting to be sent that the server lists has arrived: taking it marks it sent.
        record.pending || record.touched <= since
    }
    val ids = listed.mapTo(HashSet()) { it.id }
    val drops = records.filter { !it.pending && it.touched <= since && it.annotation.id !in ids }.mapTo(HashSet()) { it.annotation.id }
    return ListMerge(upserts, drops)
}

/** An event from the server's stream, decoded off the main thread. */
internal sealed interface SyncEvent {
    /** Connected: what changed while away is caught up on. */
    data object Hello : SyncEvent

    /** A note made, changed or replied to. */
    class Changed(val annotation: Annotation) : SyncEvent

    class Deleted(val id: String) : SyncEvent

    /** Agent mode: an agent asked, through `notato_annotate`, for something in this app to be annotated. */
    class Relay(val request: AnnotateRequest) : SyncEvent
}

/** Reads one event of the stream; null for one this SDK does not act on, or cannot read. */
internal fun decodeEvent(event: ServerSentEvent): SyncEvent? = when (event.event) {
    "hello" -> SyncEvent.Hello
    "created", "updated", "replied" -> data(event)?.annotation?.let { SyncEvent.Changed(it) }
    "deleted" -> data(event)?.id?.let { SyncEvent.Deleted(it) }
    "annotate-request" -> try {
        SyncEvent.Relay(NotatoJson.decodeFromString(AnnotateRequest.serializer(), event.data))
    } catch (_: IllegalArgumentException) {
        null
    }
    else -> null
}

private fun data(event: ServerSentEvent): ServerEventData? = try {
    NotatoJson.decodeFromString(ServerEventData.serializer(), event.data)
} catch (_: IllegalArgumentException) {
    null
}

/**
 * Takes the picture first and reads the screen after it, so what the reading says to cover (private elements, secure
 * and masked fields) is where it was in the picture. Read the other way round, a field that moved or appeared between
 * the two would be in the picture uncovered.
 */
internal suspend fun <P, S> captureThenScan(capture: suspend () -> P?, scan: () -> S): Pair<P?, S> {
    val picture = capture()
    return picture to scan()
}
