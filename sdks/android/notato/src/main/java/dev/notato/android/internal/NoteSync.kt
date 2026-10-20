package dev.notato.android.internal

import android.os.SystemClock
import android.util.Log
import dev.notato.android.AnnotateOptions
import dev.notato.android.NotatoConnection
import dev.notato.android.NotatoMode
import dev.notato.android.model.AnnotateRequest
import dev.notato.android.model.Annotation
import dev.notato.android.model.Author
import dev.notato.android.model.RelayResult
import dev.notato.android.model.Status
import dev.notato.android.model.StoredAnnotation
import dev.notato.android.net.NotatoClient
import dev.notato.android.net.NotatoServerException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File

/** How sending a note went, and what to tell the person (null: nothing to say). */
internal class SendResult(val outcome: SendOutcome, val message: String?)

/**
 * The notes Notato knows of, kept in step with the server. Notes made here are kept on the device ([store]) until the
 * server has them; the server's are read when it connects and followed over its event stream after that; and what the
 * person does to a note (a reply, People only, a revert, a delete) goes through here. Main thread only, as the
 * [controller] it belongs to. [formerBase] is where earlier versions kept the notes: what is left there is moved to
 * [storeBase] when the notes are read.
 */
internal class NoteSync(private val controller: Controller, private val storeBase: File, project: String, private val formerBase: File? = null) {
    val notes = NoteBook()

    /** Counts changes to [notes], so a list from the server can tell what changed here after it was asked for. */
    private var clock = 0L

    /**
     * Notes deleted (here, or by an event) and when, on [clock]: a list asked for before then does not bring them back,
     * and an event about one (a note deleted here while it was being sent arriving) does not either.
     */
    private val deletions = object : LinkedHashMap<String, Long>() {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Long>?) = size > MAX_DELETIONS
    }

    /** The project's notes kept on this device. */
    var store = LocalStore(storeBase, project)
        private set

    /** The notes kept on the device have been read since Notato started, or since the project changed. */
    private var loaded = false

    private var client: NotatoClient? = null
    private var job: Job? = null

    var connection = NotatoConnection.DISABLED
        private set
    var connectionDetail: String? = null
        private set

    /**
     * The last try at the server failed (OFFLINE, or REFUSED), and why; null once it connects. Kept while it tries
     * again, so the menu's banner stays up through the backoff's own tries rather than flickering.
     */
    var failure: NotatoConnection? = null
        private set
    var failureDetail: String? = null
        private set

    /** Retry was pressed in the menu, and that try has not finished yet. */
    var retrying = false
        private set

    /** What the server allows, as it last said: asked when Notato connects, and again before a screenshot. */
    private var policy = ServerPolicy()
    private var asking: Job? = null

    /**
     * Whether the server takes screenshots: true with no server to ask, and null while the server has not said (they
     * are not taken until it has).
     */
    val serverScreenshots: Boolean? get() = if (controller.server == null) true else policy.screenshots
    val serverDerivedScreenshots: Boolean get() = policy.derivedScreenshots

    /**
     * This app's token can only send notes (a capture-only token): it cannot follow the project's notes, read them,
     * reply, or upload a package, so Notato sends what is made here and nothing more.
     */
    val captureOnly: Boolean get() = policy.captureOnly

    private val scope get() = controller.scope
    private val me get() = Author.human(controller.authorName)

    private fun touch(record: NoteRecord) {
        record.touched = ++clock
        notes.changed()
    }

    /** Keeps a note just made here, ready to send. */
    fun add(record: NoteRecord) {
        touch(record)
        notes.add(record)
    }

    /** Another project: its own notes, on this device and on the server. */
    fun switchProject(project: String) {
        notes.clear()
        loaded = false
        store = LocalStore(storeBase, project)
    }

    // ---- sending ----------------------------------------------------------------------------------------------------

    /**
     * Sends one note now. Whatever goes wrong is told, never thrown. A note is never posted twice at once: one already
     * on its way is left to that send, which says how it went.
     */
    suspend fun send(record: NoteRecord): SendResult {
        if (!record.pending || record.deletedHere || record.sending) return SendResult(SendOutcome.SENT, null)
        if (!controller.hasServer) return SendResult(SendOutcome.HELD, null)
        val client = client ?: return SendResult(SendOutcome.HELD, NOT_REACHABLE)
        val id = record.annotation.id
        val store = store
        record.sending = true
        val stored = try {
            client.post(record.annotation, record.assets ?: emptyMap()).also { heardFrom(null) }
        } catch (error: CancellationException) {
            throw error
        } catch (error: NotatoServerException) {
            heardFrom(error)
            val outcome = outcomeOf(error)
            return when {
                outcome == SendOutcome.REFUSED -> {
                    record.error = error.message
                    record.held = null
                    Log.w(TAG, "The Notato server refused a note: ${error.message}")
                    controller.publish()
                    SendResult(outcome, "The server refused it: ${error.message}")
                }
                error.status != 0 -> {
                    // The server is there but not taking it now (a project it does not have, a token it does not
                    // know): what it said goes on the note, which stays queued for the next connect.
                    record.held = error.message
                    controller.publish()
                    SendResult(outcome, "Saved, not sent: ${error.message}")
                }
                else -> SendResult(outcome, NOT_REACHABLE)
            }
        } catch (error: Exception) {
            Log.w(TAG, "Notato could not send a note", error)
            return SendResult(SendOutcome.HELD, NOT_REACHABLE)
        } finally {
            record.sending = false
        }
        if (record.deletedHere) {
            // Deleted here while it was on its way: the server has it now, so it is deleted there too.
            try {
                client.delete(id)
            } catch (error: NotatoServerException) {
                Log.w(TAG, "Notato could not delete a note on the server that was deleted here: ${error.message}")
            }
            return SendResult(SendOutcome.SENT, null)
        }
        // Only while it still waits: an event can bring the server's copy first, with changes newer than this answer.
        val local = record.annotation
        if (notes.posted(record, stored.annotation, ::touch)) {
            keepPeopleOnly(record, local, stored.annotation)
            withContext(Dispatchers.IO) { store.remove(id) }
        }
        controller.publish()
        return SendResult(SendOutcome.SENT, null)
    }

    /**
     * With a capture-only token there is no event stream to say whether the server is there: each send says so instead
     * ([error] is why it failed, null when the server took it).
     */
    private fun heardFrom(error: NotatoServerException?) {
        if (!captureOnly) return
        when {
            error == null -> if (connection != NotatoConnection.CONNECTED) setConnection(NotatoConnection.CONNECTED, null)
            // This one note refused for good (malformed, too big) says nothing about the connection.
            error.refused -> Unit
            error.permanent -> setConnection(NotatoConnection.REFUSED, error.message)
            else -> setConnection(NotatoConnection.OFFLINE, error.message)
        }
    }

    /** Sends what is queued, oldest first: one refused note never holds up the rest. */
    private suspend fun flush() = sendQueue(notes.queue()) { send(it).outcome }

    /** Reads the notes kept on the device, once, and sends them if the server is there. */
    suspend fun loadLocal() {
        if (loaded) return
        loaded = true
        val store = store
        val former = formerBase
        val items = withContext(Dispatchers.IO) {
            // Notes an earlier version kept where backups reach: moved first, so they are read with the rest.
            if (former != null) moveStore(former, storeBase)
            store.load()
        }
        // Reconfigured for another project while this one's notes were read: they are not that project's.
        if (store !== this.store) return
        for (item in items) {
            val id = item.annotation.id
            if (id !in notes && id !in deletions) notes.add(NoteRecord(item.annotation, pending = true, mine = true, assets = item.assets).also { touch(it) })
        }
        controller.publish()
        if (connection == NotatoConnection.CONNECTED) flush()
    }

    /** Test mode's Clear notes: every note not sent (or packaged) goes, from here and from the device. */
    fun clearLocal() {
        notes.removeAll { it.pending }
        val store = store
        scope.launch(Dispatchers.IO) { store.clear() }
        controller.publish()
    }

    // ---- the server: live updates over server-sent events --------------------------------------------------------------

    /** Connects to the server (again), or says there is none: notes stay on the device. */
    fun restart() {
        job?.cancel()
        job = null
        // An ask still on its way answers the policy it was asked for, not this one: let go of, not cancelled.
        asking = null
        // What the server allows is asked again (it may be another server now): until it answers, no screenshots.
        policy = ServerPolicy()
        failure = null
        failureDetail = null
        retrying = false
        if (!controller.enabled) return
        val url = controller.server
        // The token goes only to the server it was configured for, never to one typed into the Settings sheet.
        client = url?.let { NotatoClient(it, controller.config.tokenFor(it)) }
        val c = client
        if (!controller.hasServer || c == null) {
            setConnection(NotatoConnection.LOCAL, if (controller.mode == NotatoMode.TEST) null else "No server is set: notes stay on this device.")
            // Test mode with a server: notes stay here until packaged, but whether it takes screenshots still counts.
            if (c != null) ask(c)
            return
        }
        job = scope.launch {
            // One catching up at a time: a reconnect while the last one is still reading the list waits for it.
            val catchingUp = Mutex()
            var delayMs = FIRST_RETRY_MS
            while (isActive) {
                setConnection(NotatoConnection.CONNECTING, null)
                // What the server allows comes first: whether it takes screenshots, and whether this app's token may
                // read anything back at all.
                ask(c).join()
                if (captureOnly) {
                    sendOnly()
                    continue
                }
                try {
                    // Decoded on the thread that reads the stream: the main thread only applies what came.
                    val events = c.events(controller.config.project, agent = controller.mode == NotatoMode.AGENT)
                    events.mapNotNull(::decodeEvent).flowOn(Dispatchers.IO).collect { event ->
                        delayMs = FIRST_RETRY_MS
                        when (event) {
                            SyncEvent.Hello -> {
                                setConnection(NotatoConnection.CONNECTED, null)
                                // Beside the stream, not in it: events go on being taken while the list is read.
                                launch { catchingUp.withLock { catchUp(c) } }
                            }
                            is SyncEvent.Changed -> upsert(event.annotation)
                            is SyncEvent.Deleted -> deleted(event.id)
                            // Answered at once, whatever else is going on.
                            is SyncEvent.Relay -> scope.launch { answerRelay(event.request, c) }
                        }
                    }
                    if (!isActive) return@launch
                    setConnection(NotatoConnection.OFFLINE, "The server closed the connection.")
                } catch (error: CancellationException) {
                    throw error
                } catch (error: NotatoServerException) {
                    if (!isActive) return@launch
                    if (error.permanent) {
                        setConnection(NotatoConnection.REFUSED, error.message)
                        delayMs = LAST_RETRY_MS
                    } else {
                        setConnection(NotatoConnection.OFFLINE, error.message)
                    }
                } catch (error: Exception) {
                    if (!isActive) return@launch
                    setConnection(NotatoConnection.OFFLINE, error.message)
                }
                delay(delayMs)
                delayMs = minOf(LAST_RETRY_MS, delayMs * 2)
            }
        }
    }

    /** Notato was turned off: the stream closes, and nothing is sent until it is on again. */
    fun stop() {
        job?.cancel()
        job = null
        connection = NotatoConnection.DISABLED
        connectionDetail = null
    }

    /** The menu's Retry: tries the server again now, rather than when the backoff would. */
    fun retryNow() {
        if (!controller.enabled || !controller.hasServer) return
        val was = failure
        val why = failureDetail
        restart()
        // Still down until this try says otherwise: the banner stays, saying it is trying.
        if (connection == NotatoConnection.CONNECTING) {
            failure = was
            failureDetail = why
            retrying = was != null
        }
        controller.publish()
    }

    private fun setConnection(next: NotatoConnection, detail: String?) {
        if (!controller.enabled) return
        if (next == NotatoConnection.REFUSED && connection != next) Log.w(TAG, "Notato: $detail")
        connection = next
        connectionDetail = detail
        when (next) {
            NotatoConnection.CONNECTING -> Unit
            NotatoConnection.OFFLINE, NotatoConnection.REFUSED -> {
                failure = next
                failureDetail = detail
                retrying = false
            }
            else -> {
                failure = null
                failureDetail = null
                retrying = false
            }
        }
        controller.publish()
    }

    /**
     * Asks the server what it allows (`/config`), one ask at a time: whoever needs the answer waits for it, and one that
     * stops waiting (a screenshot that cannot wait long) does not stop the asking. Never fails: a server that does not
     * answer leaves what it said last, or nothing, which keeps screenshots off.
     */
    private fun ask(c: NotatoClient): Job = asking?.takeIf { it.isActive } ?: scope.launch {
        // Answered into the policy it was asked for: a restart meanwhile starts another, which this does not touch.
        val policy = policy
        try {
            policy.answered(c.config(controller.config.project), SystemClock.uptimeMillis())
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            policy.unanswered(SystemClock.uptimeMillis())
        }
    }.also { asking = it }

    /**
     * Whether the server lets a screenshot be taken now. What it said is asked again when it is more than a few seconds
     * old, waiting a moment at most (a slow server must not hold the note up). With no server there is no one to ask;
     * with one that has not said, the answer is no.
     */
    suspend fun screenshotsAllowed(): Boolean {
        if (controller.server == null) return true
        val c = client ?: return false
        if (policy.stale(SystemClock.uptimeMillis())) withTimeoutOrNull(ASK_WAIT_MS) { ask(c).join() }
        return serverScreenshots == true
    }

    /**
     * A capture-only token sends notes and reads nothing back: there is no event stream to follow and no list to read,
     * and asking for them would only be refused. What is queued here is sent straight away, then looked at again every
     * few seconds while Notato is on; each send says whether the server can be reached.
     */
    private suspend fun sendOnly() {
        setConnection(NotatoConnection.CONNECTED, null)
        while (captureOnly) {
            flush()
            delay(LAST_RETRY_MS)
        }
    }

    /**
     * Connected: the server's settings, then the notes queued here sent, then the project's list read (which has
     * them by then, rather than missing them until the next connect).
     */
    private suspend fun catchUp(c: NotatoClient) {
        try {
            ask(c).join()
            flush()
            reload(c)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            Log.w(TAG, "Notato could not catch up with the server: ${error.message}")
        }
    }

    /** The server deleted a note. One still waiting here is kept: the server never had it. */
    private fun deleted(id: String) {
        deletions[id] = ++clock
        if (notes[id]?.pending == false) notes.remove(id)
        controller.publish()
    }

    /**
     * Reads the project's whole list (every page) and makes the notes here match it. If any page fails, nothing
     * changes: a partial list must not drop the notes it did not reach. The notes are indexed by id, so this is one
     * pass over each, however long the list.
     */
    private suspend fun reload(c: NotatoClient) {
        val since = clock
        val listed = try {
            c.list(controller.config.project)
        } catch (error: NotatoServerException) {
            Log.w(TAG, "Notato could not read the project's notes: ${error.message}")
            return
        }
        val merge = mergeList(notes.all, listed.map { it.annotation }, since, deletions.filterValues { it > since }.keys)
        for (annotation in merge.upserts) take(annotation)
        if (merge.drops.isNotEmpty()) notes.removeAll { it.annotation.id in merge.drops }
        controller.publish()
    }

    /** Takes the server's copy of a note, and tells the app and the overlay. */
    fun upsert(annotation: Annotation) {
        take(annotation)
        controller.publish()
    }

    /**
     * Takes the server's copy of a note: a new one, a change, or (for one waiting here) word that it arrived. One
     * deleted here is not brought back by it (an event about a note deleted while it was being sent).
     */
    private fun take(annotation: Annotation) {
        val arrived = notes.take(annotation, controller.config.project, { it in deletions }, ::touch) ?: return
        keepPeopleOnly(arrived.record, arrived.local, annotation)
        val store = store
        scope.launch(Dispatchers.IO) { store.remove(annotation.id) }
    }

    /** Agent mode: an agent asked, through `notato_annotate`, for something in this app to be annotated. */
    private suspend fun answerRelay(request: AnnotateRequest, c: NotatoClient) {
        val args = request.args
        val result = try {
            val options = AnnotateOptions(severity = args.severity, intent = args.intent, agentName = args.author ?: "agent", steps = args.steps)
            RelayResult(ok = true, annotationId = controller.annotate(args.target, args.comment, options).id)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            RelayResult(ok = false, error = error.message ?: error.javaClass.simpleName)
        }
        runCatching { c.relayResult(request.requestId, result) }.onFailure { Log.w(TAG, "Notato could not report an annotate result: ${it.message}") }
    }

    // ---- acting on a note, as the person --------------------------------------------------------------------------

    private fun connected(): NotatoClient {
        val c = client?.takeIf { controller.hasServer } ?: throw IllegalStateException("Not connected to a Notato server.")
        // As the browser SDK says: the token can send notes, and the rest is done on the board.
        check(!captureOnly) { "This app's token can only send notes: read, answer and change them on the board." }
        return c
    }

    /** Replies as the person; an [aside] is for the people on the thread, and kept from the agent. */
    suspend fun reply(id: String, text: String, aside: Boolean = false) = upsert(connected().reply(id, text, me, aside).annotation)

    /**
     * People only on or off for a note, as the person. One the server has is changed there, and the server records
     * the change in its thread; one still waiting here (test mode, or made while the server was down) is changed here,
     * with the same entry in its thread, so a package carries the history.
     */
    suspend fun setPeopleOnly(id: String, on: Boolean) {
        val record = notes[id] ?: throw IllegalStateException("That note is not here any more.")
        if ((record.annotation.peopleOnly == true) == on) return
        if (!record.pending) {
            upsert(connected().setPeopleOnly(id, on, me).annotation)
            return
        }
        record.annotation = PeopleOnly.toggle(record.annotation, on, me)
        record.peopleOnlyChanged = true
        touch(record)
        val store = store
        // Only annotation.json is written again (whole or not at all): the screenshots on disk have not changed.
        val annotation = record.annotation
        withContext(Dispatchers.IO) { store.save(annotation) }
        // Sent (or deleted) while it was being written: the copy kept here is not wanted any more.
        if (!record.pending || record.deletedHere) withContext(Dispatchers.IO) { store.remove(id) }
        controller.publish()
    }

    /**
     * The server's copy of a note that was waiting here has arrived. If People only was changed here meanwhile and the
     * server's copy says otherwise (the change came while the note was on its way), the server is told: the person
     * chose to keep it from the agent, or to share it, and that must not be lost.
     */
    private fun keepPeopleOnly(record: NoteRecord, local: Annotation, server: Annotation) {
        val wanted = PeopleOnly.stillToSend(record.peopleOnlyChanged, local, server)
        record.peopleOnlyChanged = false
        if (wanted == null) return
        val c = client?.takeIf { controller.hasServer } ?: return
        if (captureOnly) {
            Log.w(TAG, "Notato could not turn People only ${if (wanted) "on" else "off"} on the server: this app's token can only send notes. Change it on the board.")
            return
        }
        scope.launch {
            try {
                upsert(c.setPeopleOnly(server.id, wanted, me).annotation)
            } catch (error: NotatoServerException) {
                Log.w(TAG, "Notato could not turn People only ${if (wanted) "on" else "off"} on the server: ${error.message}")
            }
        }
    }

    /** Asks the agent to undo a resolved note's change, saying why ([reason]) or with the usual words. */
    suspend fun requestRevert(id: String, reason: String?) =
        upsert(connected().setStatus(id, Status.REVERT_REQUESTED, reason?.takeIf { it.isNotBlank() } ?: "Please undo this change.", me).annotation)

    suspend fun cancelRevert(id: String) = upsert(connected().setStatus(id, Status.RESOLVED, "Revert request taken back.", me).annotation)

    suspend fun delete(id: String) {
        val record = notes[id]
        if (record != null && !record.pending && controller.hasServer) connected().delete(id)
        // One not sent yet never goes; one on its way is deleted on the server once it is there (see send).
        record?.deletedHere = true
        deletions[id] = ++clock
        notes.remove(id)
        val store = store
        withContext(Dispatchers.IO) { store.remove(id) }
        controller.publish()
    }

    private companion object {
        /** How many deletions are remembered: enough for any list or event still on its way. */
        const val MAX_DELETIONS = 256

        /** The first wait before trying the server again, doubled each failed try up to the last. */
        const val FIRST_RETRY_MS = 1_000L
        const val LAST_RETRY_MS = 10_000L

        /** How long a screenshot waits, at most, for the server to say whether it takes them. */
        const val ASK_WAIT_MS = 1_500L

        const val NOT_REACHABLE = "Saved. It's sent when the server can be reached."
    }
}
