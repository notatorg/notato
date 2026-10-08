package dev.notato.android.net

import android.net.TrafficStats
import dev.notato.android.model.Annotation
import dev.notato.android.model.AnnotationList
import dev.notato.android.model.Author
import dev.notato.android.model.ErrorBody
import dev.notato.android.model.NotatoJson
import dev.notato.android.model.PeopleOnlyChange
import dev.notato.android.model.RelayResult
import dev.notato.android.model.ReplyBody
import dev.notato.android.model.ServerConfig
import dev.notato.android.model.StatusChange
import dev.notato.android.model.StoredAnnotation
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.encodeToJsonElement
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.MalformedURLException
import java.net.URL
import java.net.URLEncoder
import java.util.UUID

/** A refusal from the server, or no answer at all (status 0): every way a request to the server can fail. */
public class NotatoServerException(message: String, public val status: Int, cause: Throwable? = null) : IOException(message, cause) {
    /** The server understood and said no: sending the same thing again would fail the same way. */
    public val permanent: Boolean get() = status in 400..499 && status != 408 && status != 429

    /**
     * This one note is refused for good (malformed, too big, a clash): it is marked failed and the notes queued after it
     * still go. Anything else (no answer, 401, 403, 404, 408, 429, 5xx) holds the whole queue until the next try.
     */
    internal val refused: Boolean get() = status in REFUSED

    private companion object {
        val REFUSED = setOf(400, 409, 413, 415, 422)
    }
}

/** One server-sent event. */
public data class ServerSentEvent(val event: String, val data: String)

/** Writes an annotation as the server expects it: nulls left out, except `bundleId`, which the schema requires. */
internal fun encodeAnnotation(annotation: Annotation): String {
    val obj = NotatoJson.encodeToJsonElement(annotation) as JsonObject
    val withBundle = if ("bundleId" in obj) obj else JsonObject(obj + ("bundleId" to JsonNull))
    return withBundle.toString()
}

/**
 * What a request sends. Its length is known before a byte is written, so it streams to the server (fixed-length
 * streaming) rather than being held whole: a note's screenshots, or a tester's zip, are read from disk as they go.
 */
internal abstract class RequestBody(val contentType: String) {
    abstract val length: Long
    abstract fun writeTo(out: OutputStream)
}

internal class BytesBody(private val bytes: ByteArray, contentType: String) : RequestBody(contentType) {
    override val length: Long get() = bytes.size.toLong()
    override fun writeTo(out: OutputStream) = out.write(bytes)
}

internal class FileBody(private val file: File, contentType: String) : RequestBody(contentType) {
    override val length: Long = file.length()
    override fun writeTo(out: OutputStream) {
        file.inputStream().use { it.copyTo(out) }
    }
}

/**
 * The multipart form the server ingests: the annotation as JSON, and each screenshot as an `asset:<id>` file, written
 * straight from the files on disk. A screenshot whose file is missing is left out.
 */
internal class MultipartForm(annotation: Annotation, assets: Map<String, File>, boundary: String) :
    RequestBody("multipart/form-data; boundary=$boundary") {
    /** The form in order: its own lines as bytes, and the screenshots as the files they are in. */
    private val parts: List<Any>

    init {
        val parts = mutableListOf<Any>()
        val text = StringBuilder()
        fun line(value: String) = text.append(value).append("\r\n")
        line("--$boundary")
        line("Content-Disposition: form-data; name=\"annotation\"")
        line("")
        line(encodeAnnotation(annotation))
        for (ref in listOfNotNull(annotation.screenshots?.full, annotation.screenshots?.crop)) {
            val file = assets[ref.id]?.takeIf { it.isFile } ?: continue
            line("--$boundary")
            line("Content-Disposition: form-data; name=\"asset:${ref.id}\"; filename=\"${ref.id}\"")
            line("Content-Type: ${ref.mime}")
            line("")
            parts += text.toString().toByteArray(Charsets.UTF_8)
            text.setLength(0)
            parts += file
            line("")
        }
        line("--$boundary--")
        parts += text.toString().toByteArray(Charsets.UTF_8)
        this.parts = parts
    }

    override val length: Long = parts.sumOf { if (it is ByteArray) it.size.toLong() else (it as File).length() }

    override fun writeTo(out: OutputStream) {
        for (part in parts) if (part is ByteArray) out.write(part) else (part as File).inputStream().use { it.copyTo(out) }
    }
}

/**
 * Notato's sockets are tagged as its own, so the network profiler and StrictMode's untagged-socket check tell them from
 * the app's. ("NOTA".)
 */
private const val SOCKET_TAG = 0x4e4f5441

/** Runs [block] with this thread's sockets tagged as Notato's, then puts the thread's tag back. */
private inline fun <T> tagged(block: () -> T): T {
    val before = TrafficStats.getThreadStatsTag()
    TrafficStats.setThreadStatsTag(SOCKET_TAG)
    try {
        return block()
    } finally {
        TrafficStats.setThreadStatsTag(before)
    }
}

/**
 * The Notato HTTP API (packages/server/src/http.ts): post annotations with their screenshots, read them back, follow
 * changes over server-sent events, and act on them as the person.
 */
internal class NotatoClient(baseUrl: String, token: String?) {
    val base: String = baseUrl.trimEnd('/')
    private val token = token?.trim()?.ifEmpty { null }

    private fun segment(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")

    private fun open(method: String, path: String, timeoutMs: Int = 30_000): HttpURLConnection {
        val connection = URL(base + path).openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.connectTimeout = 10_000
        connection.readTimeout = timeoutMs
        if (token != null) connection.setRequestProperty("Authorization", "Bearer $token")
        return connection
    }

    /**
     * Why the server could not be asked. Not only IOExceptions: a port out of range is an IllegalArgumentException, and
     * an app without the INTERNET permission gets a SecurityException.
     */
    private fun unreachable(error: Exception): NotatoServerException {
        val message = error.message ?: error.javaClass.simpleName
        if (error is MalformedURLException) {
            return NotatoServerException("The Notato server address $base is not a valid URL: $message", 0, error)
        }
        if (message.contains("CLEARTEXT", ignoreCase = true)) {
            return NotatoServerException("Android blocked plain http to $base. Allow cleartext traffic for this host (see the Notato Android README).", 0, error)
        }
        return NotatoServerException("Cannot reach the Notato server at $base: $message", 0, error)
    }

    private fun refusal(connection: HttpURLConnection, status: Int): NotatoServerException {
        val text = runCatching { connection.errorStream?.bufferedReader()?.use { it.readText() } }.getOrNull().orEmpty()
        val detail = runCatching { NotatoJson.decodeFromString(ErrorBody.serializer(), text).error }.getOrNull()
        return NotatoServerException(detail ?: "The server answered $status.", status)
    }

    /** One request and its answer's text. However it fails (a bad address included), it throws [NotatoServerException]. */
    private fun request(method: String, path: String, body: RequestBody? = null, headers: Map<String, String> = emptyMap()): String = tagged {
        var connection: HttpURLConnection? = null
        try {
            connection = open(method, path)
            for ((name, value) in headers) connection.setRequestProperty(name, value)
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", body.contentType)
                connection.setFixedLengthStreamingMode(body.length)
                connection.outputStream.buffered().use { body.writeTo(it) }
            }
            val status = connection.responseCode
            if (status in 200..299) return@tagged connection.inputStream.bufferedReader().use { it.readText() }
            throw refusal(connection, status)
        } catch (error: NotatoServerException) {
            throw error
        } catch (error: Exception) {
            throw unreachable(error)
        } finally {
            connection?.disconnect()
        }
    }

    /** An answer that is not what the API sends (a proxy's or tunnel's page) is a failure to reach it, not a crash. */
    private fun <T> decode(serializer: KSerializer<T>, text: String): T = try {
        NotatoJson.decodeFromString(serializer, text)
    } catch (error: IllegalArgumentException) {
        throw NotatoServerException("The answer from $base is not Notato's: ${error.message?.take(200)}", 0, error)
    }

    private fun json(value: String) = BytesBody(value.toByteArray(Charsets.UTF_8), "application/json")

    suspend fun config(): ServerConfig = withContext(Dispatchers.IO) {
        decode(ServerConfig.serializer(), request("GET", "/config"))
    }

    /** Sends an annotation, its screenshots read from [assets] as they go. Safe to repeat: the server keeps the first copy of an id. */
    suspend fun post(annotation: Annotation, assets: Map<String, File>): StoredAnnotation = withContext(Dispatchers.IO) {
        val path = "/projects/${segment(annotation.projectId)}/annotations"
        decode(StoredAnnotation.serializer(), request("POST", path, MultipartForm(annotation, assets, "notato-${UUID.randomUUID()}")))
    }

    /**
     * Every note in the project, oldest first, as summaries (`fields=summary`: no context and no steps, which are most
     * of a note's size and which nothing here shows; an older server ignores it and sends them whole). The server
     * answers a page at a time (`next` says there is more); all of them are read before this returns, and if any page
     * fails it throws, so a partial list is never taken for the whole.
     */
    suspend fun list(project: String): List<StoredAnnotation> = withContext(Dispatchers.IO) {
        val all = mutableListOf<StoredAnnotation>()
        var after: Long? = null
        while (true) {
            ensureActive()
            val query = "limit=$PAGE&fields=summary" + (after?.let { "&afterSeq=$it" } ?: "")
            val page = decode(AnnotationList.serializer(), request("GET", "/projects/${segment(project)}/annotations?$query"))
            all += page.items
            val next = page.next ?: break
            // A server that does not move on would be asked forever.
            if (after != null && next <= after) throw NotatoServerException("The server's list did not move on from $after.", 0)
            after = next
        }
        all
    }

    suspend fun setStatus(id: String, status: String, note: String?, author: Author?): StoredAnnotation = withContext(Dispatchers.IO) {
        val body = NotatoJson.encodeToString(StatusChange.serializer(), StatusChange(status, note?.ifBlank { null }, author))
        // HttpURLConnection cannot send PATCH: the server takes a POST with this header as one.
        val text = request("POST", "/annotations/${segment(id)}", json(body), mapOf("X-HTTP-Method-Override" to "PATCH"))
        decode(StoredAnnotation.serializer(), text)
    }

    /** Replies as [author]; an [aside] is for the people on the thread, and kept from the agent. */
    suspend fun reply(id: String, text: String, author: Author?, aside: Boolean = false): StoredAnnotation = withContext(Dispatchers.IO) {
        val body = NotatoJson.encodeToString(ReplyBody.serializer(), ReplyBody(text, author, aside.takeIf { it }))
        decode(StoredAnnotation.serializer(), request("POST", "/annotations/${segment(id)}/replies", json(body)))
    }

    /** Turns People only on or off for a note. Only a person may (an agent gets 403); the server records it in the thread. */
    suspend fun setPeopleOnly(id: String, on: Boolean, author: Author?): StoredAnnotation = withContext(Dispatchers.IO) {
        val body = NotatoJson.encodeToString(PeopleOnlyChange.serializer(), PeopleOnlyChange(on, author))
        val text = request("POST", "/annotations/${segment(id)}", json(body), mapOf("X-HTTP-Method-Override" to "PATCH"))
        decode(StoredAnnotation.serializer(), text)
    }

    suspend fun delete(id: String) = withContext(Dispatchers.IO) {
        request("DELETE", "/annotations/${segment(id)}")
        Unit
    }

    suspend fun relayResult(requestId: String, result: RelayResult) = withContext(Dispatchers.IO) {
        request("POST", "/relay/${segment(requestId)}/result", json(NotatoJson.encodeToString(RelayResult.serializer(), result)))
        Unit
    }

    /** Uploads a tester's zip, read from [zip] as it goes. */
    suspend fun uploadBundle(project: String, zip: File) = withContext(Dispatchers.IO) {
        request("POST", "/projects/${segment(project)}/bundles", FileBody(zip, "application/zip"))
        Unit
    }

    /**
     * Follows the project's event stream until the connection drops: `hello` first, then `created`, `updated`,
     * `replied`, `deleted`, and (with [agent]) `annotate-request`. The server pings every 15 seconds.
     */
    fun events(project: String, agent: Boolean): Flow<ServerSentEvent> = flow {
        val connection = try {
            open("GET", "/projects/${segment(project)}/events${if (agent) "?agent=1" else ""}", timeoutMs = 45_000)
        } catch (error: Exception) {
            throw unreachable(error)
        }
        connection.setRequestProperty("Accept", "text/event-stream")
        coroutineScope {
            // A blocking read does not see cancellation: closing the connection from another thread ends it at once,
            // so stopping or reconnecting does not wait for the next ping (or leave a stale stream the server still feeds).
            val closer = launch(start = CoroutineStart.UNDISPATCHED) {
                try {
                    awaitCancellation()
                } finally {
                    connection.disconnect()
                }
            }
            try {
                val status = try {
                    // The connection is made here: its socket is tagged as Notato's.
                    tagged { connection.responseCode }
                } catch (error: Exception) {
                    // Cut off by the closer above: that is a stop, not a failure.
                    currentCoroutineContext().ensureActive()
                    throw unreachable(error)
                }
                if (status !in 200..299) throw refusal(connection, status)
                val parser = ServerSentEventParser()
                connection.inputStream.bufferedReader().use { reader ->
                    while (true) {
                        currentCoroutineContext().ensureActive()
                        val line = try {
                            reader.readLine()
                        } catch (error: IOException) {
                            currentCoroutineContext().ensureActive()
                            throw unreachable(error)
                        } ?: break
                        parser.feed(line)?.let { emit(it) }
                    }
                }
            } finally {
                closer.cancel()
                connection.disconnect()
            }
        }
    }.flowOn(Dispatchers.IO)

    companion object {
        /** Notes per page of the list. */
        const val PAGE = 500
    }
}

/** The text/event-stream format, one line at a time: `event:` and `data:` lines, a blank line ending each event. */
public class ServerSentEventParser {
    private var type = "message"
    private val data = mutableListOf<String>()

    /** Returns an event when [line] (without its newline) completes one. */
    public fun feed(line: String): ServerSentEvent? {
        if (line.isEmpty()) {
            val event = if (data.isEmpty()) null else ServerSentEvent(type, data.joinToString("\n"))
            type = "message"
            data.clear()
            return event
        }
        if (line.startsWith(":")) return null // a comment, such as the keep-alive ping
        val colon = line.indexOf(':')
        val field = if (colon < 0) line else line.substring(0, colon)
        var value = if (colon < 0) "" else line.substring(colon + 1)
        if (value.startsWith(" ")) value = value.substring(1)
        when (field) {
            "event" -> type = value
            "data" -> data.add(value)
        }
        return null
    }
}
