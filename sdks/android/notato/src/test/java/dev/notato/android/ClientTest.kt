package dev.notato.android

import dev.notato.android.internal.SendOutcome
import dev.notato.android.internal.outcomeOf
import dev.notato.android.model.Author
import dev.notato.android.model.ErrorBody
import dev.notato.android.model.NotatoJson
import dev.notato.android.model.Status
import dev.notato.android.model.StoredAnnotation
import dev.notato.android.net.NotatoClient
import dev.notato.android.net.NotatoServerException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** The client against a real HTTP server on this machine. */
class ClientTest {
    /** Just enough HTTP/1.1 for these tests (unit tests compile against android.jar, which has no JDK HTTP server). */
    private class TinyServer(private val handle: (Request, OutputStream) -> Unit) : Closeable {
        class Request(val method: String, val target: String, val headers: Map<String, String>, val body: ByteArray)

        private val socket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        private val pool = Executors.newCachedThreadPool { Thread(it).apply { isDaemon = true } }
        val base = "http://127.0.0.1:${socket.localPort}"

        init {
            pool.execute {
                while (!socket.isClosed) {
                    val client = try {
                        socket.accept()
                    } catch (_: IOException) {
                        break
                    }
                    pool.execute { serve(client) }
                }
            }
        }

        private fun line(input: InputStream): String? {
            val out = ByteArrayOutputStream()
            while (true) {
                val b = input.read()
                if (b < 0) return null
                if (b == '\n'.code) return out.toString(Charsets.UTF_8.name()).trimEnd('\r')
                out.write(b)
            }
        }

        private fun serve(client: Socket) = client.use {
            runCatching {
                val input = BufferedInputStream(it.getInputStream())
                val (method, target) = (line(input) ?: return@use).split(" ")
                val headers = linkedMapOf<String, String>()
                while (true) {
                    val header = line(input) ?: return@use
                    if (header.isEmpty()) break
                    headers[header.substringBefore(':').trim().lowercase()] = header.substringAfter(':').trim()
                }
                val length = headers["content-length"]?.toInt() ?: 0
                val body = ByteArray(length)
                var read = 0
                while (read < length) {
                    val n = input.read(body, read, length - read)
                    if (n < 0) break
                    read += n
                }
                handle(Request(method, target, headers, body), it.getOutputStream())
            }
        }

        override fun close() {
            socket.close()
            pool.shutdownNow()
        }
    }

    private var server: TinyServer? = null
    private val seen: MutableList<String> = Collections.synchronizedList(mutableListOf())

    @After
    fun stop() {
        server?.close()
    }

    private fun serve(handle: (TinyServer.Request, OutputStream) -> Unit): String {
        val s = TinyServer { request, out ->
            seen += "${request.method} ${request.target}"
            handle(request, out)
        }
        server = s
        return s.base
    }

    private fun OutputStream.reply(status: Int, body: String) {
        val bytes = body.toByteArray()
        write("HTTP/1.1 $status X\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
        write(bytes)
        flush()
    }

    private fun stored(seq: Long) = StoredAnnotation(seq, Fixture.annotation().copy(id = "N$seq"))

    private fun page(from: Long, to: Long, next: Long?): String {
        val items = (from..to).joinToString(",") { NotatoJson.encodeToString(StoredAnnotation.serializer(), stored(it)) }
        return "{\"items\":[$items]" + (next?.let { ",\"next\":$it" } ?: "") + "}"
    }

    private fun failure(block: suspend () -> Unit): NotatoServerException = runBlocking {
        try {
            block()
        } catch (error: NotatoServerException) {
            return@runBlocking error
        }
        fail("expected a NotatoServerException")
        throw AssertionError()
    }

    @Test
    fun readsEveryPageOfTheList() = runBlocking {
        val base = serve { request, out ->
            when (request.target.substringAfter('?')) {
                "limit=500&fields=summary" -> out.reply(200, page(1, 2, next = 2))
                "limit=500&fields=summary&afterSeq=2" -> out.reply(200, page(3, 4, next = 4))
                "limit=500&fields=summary&afterSeq=4" -> out.reply(200, page(5, 5, next = null))
                else -> out.reply(400, "{\"error\":\"unexpected\"}")
            }
        }
        val all = NotatoClient(base, null).list("android-sample")
        assertEquals(listOf("N1", "N2", "N3", "N4", "N5"), all.map { it.annotation.id })
        assertEquals(
            listOf(
                "GET /projects/android-sample/annotations?limit=500&fields=summary",
                "GET /projects/android-sample/annotations?limit=500&fields=summary&afterSeq=2",
                "GET /projects/android-sample/annotations?limit=500&fields=summary&afterSeq=4",
            ),
            seen,
        )
    }

    @Test
    fun anOlderServerSendsOnePage() = runBlocking {
        val base = serve { _, out -> out.reply(200, page(1, 3, next = null)) }
        assertEquals(3, NotatoClient(base, null).list("android-sample").size)
        assertEquals(1, seen.size)
    }

    @Test
    fun aPageThatFailsFailsTheWholeList() {
        val base = serve { request, out ->
            if (request.target.endsWith("?limit=500&fields=summary")) out.reply(200, page(1, 2, next = 2)) else out.reply(503, "{\"error\":\"busy\"}")
        }
        assertEquals(503, failure { NotatoClient(base, null).list("android-sample") }.status)
    }

    @Test
    fun aListThatDoesNotMoveOnIsNotAskedForever() {
        val base = serve { _, out -> out.reply(200, page(1, 2, next = 2)) }
        failure { NotatoClient(base, null).list("android-sample") }
        assertEquals(2, seen.size)
    }

    @Test
    fun aStatusChangeIsAPostThatSaysItMeansPatch() = runBlocking {
        var override: String? = null
        var body = ""
        val base = serve { request, out ->
            override = request.headers["x-http-method-override"]
            body = request.body.decodeToString()
            out.reply(200, NotatoJson.encodeToString(StoredAnnotation.serializer(), stored(1)))
        }
        NotatoClient(base, null).setStatus("N1", Status.REVERT_REQUESTED, "Please undo this change.", null)
        assertEquals(listOf("POST /annotations/N1"), seen)
        assertEquals("PATCH", override)
        assertTrue(body, body.contains("\"status\":\"revert_requested\""))
    }

    @Test
    fun peopleOnlyIsAPatchThatSaysWhoChangedIt() = runBlocking {
        val bodies = Collections.synchronizedList(mutableListOf<String>())
        val overrides = Collections.synchronizedList(mutableListOf<String?>())
        val base = serve { request, out ->
            overrides += request.headers["x-http-method-override"]
            bodies += request.body.decodeToString()
            out.reply(200, NotatoJson.encodeToString(StoredAnnotation.serializer(), stored(1)))
        }
        val client = NotatoClient(base, null)
        client.setPeopleOnly("N1", true, Author.human("Ada"))
        client.setPeopleOnly("N1", false, Author.human(null))
        assertEquals(listOf("POST /annotations/N1", "POST /annotations/N1"), seen)
        assertEquals(listOf("PATCH", "PATCH"), overrides)
        assertEquals(
            listOf("""{"peopleOnly":true,"author":{"kind":"human","name":"Ada"}}""", """{"peopleOnly":false,"author":{"kind":"human"}}"""),
            bodies,
        )
    }

    @Test
    fun anAgentTurningPeopleOnlyOnOrOffIsRefused() {
        val why = "only a person can turn People only on or off: it is how people keep a note from the agent"
        val base = serve { _, out -> out.reply(403, NotatoJson.encodeToString(ErrorBody.serializer(), ErrorBody(why))) }
        val error = failure { NotatoClient(base, null).setPeopleOnly("N1", true, Author.agent("claude")) }
        assertEquals(403, error.status)
        assertEquals(why, error.message)
    }

    @Test
    fun anAsideSaysSoAndAPlainReplySaysNothing() = runBlocking {
        val bodies = Collections.synchronizedList(mutableListOf<String>())
        val base = serve { request, out ->
            bodies += request.body.decodeToString()
            out.reply(201, NotatoJson.encodeToString(StoredAnnotation.serializer(), stored(1)))
        }
        val client = NotatoClient(base, null)
        client.reply("N1", "Between us", Author.human("Ada"), aside = true)
        client.reply("N1", "For the agent too", Author.human("Ada"))
        assertEquals(listOf("POST /annotations/N1/replies", "POST /annotations/N1/replies"), seen)
        assertEquals(
            listOf(
                """{"body":"Between us","author":{"kind":"human","name":"Ada"},"aside":true}""",
                """{"body":"For the agent too","author":{"kind":"human","name":"Ada"}}""",
            ),
            bodies,
        )
    }

    @Test
    fun aBadAddressIsAnErrorNotACrash() {
        val annotation = Fixture.annotation()
        val malformed = failure { NotatoClient("http://localhost:47o7", null).post(annotation, emptyMap()) }
        assertEquals(0, malformed.status)
        assertTrue(malformed.message!!, malformed.message!!.contains("not a valid URL"))
        // A port out of range is an IllegalArgumentException inside HttpURLConnection.
        assertEquals(0, failure { NotatoClient("http://localhost:99999", null).post(annotation, emptyMap()) }.status)
    }

    @Test
    fun anAnswerThatIsNotTheApisIsAnError() {
        val base = serve { _, out -> out.reply(200, "<html>Sign in to the tunnel</html>") }
        val error = failure { NotatoClient(base, null).post(Fixture.annotation(), emptyMap()) }
        assertEquals(0, error.status)
        assertEquals(SendOutcome.HELD, outcomeOf(error))
    }

    @Test
    fun anUnknownProjectSaysWhyAndKeepsTheNote() {
        val why = "project \"shop\" does not exist on this server: create it with `notato project create shop`"
        val base = serve { _, out -> out.reply(404, NotatoJson.encodeToString(ErrorBody.serializer(), ErrorBody(why))) }
        val error = failure { NotatoClient(base, null).post(Fixture.annotation(), emptyMap()) }
        assertEquals(404, error.status)
        assertEquals(why, error.message)
        assertEquals(SendOutcome.HELD, outcomeOf(error))
    }

    @Test
    fun aServerTypedInSettingsNeverGetsTheProjectToken() = runBlocking {
        val heard = Collections.synchronizedMap(linkedMapOf<String, String?>())
        val configured = serve { request, out ->
            heard["configured"] = request.headers["authorization"]
            out.reply(200, "{\"screenshots\":true}")
        }
        TinyServer { request, out ->
            heard["typed"] = request.headers["authorization"]
            out.reply(200, "{\"screenshots\":true}")
        }.use { other ->
            val config = NotatoConfig("android-sample", server = configured, token = "pft_secret")
            // As the controller makes its clients: the token for the server it is going to, if it is that one.
            NotatoClient(configured, config.tokenFor(configured)).config()
            NotatoClient(other.base, config.tokenFor(other.base)).config()
        }
        assertEquals("Bearer pft_secret", heard["configured"])
        assertTrue("typed" in heard)
        assertEquals(null, heard["typed"])
    }

    @Test
    fun aNoteIsPostedWithItsScreenshotsReadFromDisk() = runBlocking {
        val annotation = Fixture.annotation()
        val full = annotation.screenshots!!.full.id
        val png = File.createTempFile("notato-", ".png").apply { writeBytes(ByteArray(200_000) { (it % 251).toByte() }) }
        var body = ByteArray(0)
        var length: String? = null
        val base = serve { request, out ->
            body = request.body
            length = request.headers["content-length"]
            out.reply(201, NotatoJson.encodeToString(StoredAnnotation.serializer(), StoredAnnotation(1, annotation)))
        }
        NotatoClient(base, null).post(annotation, mapOf(full to png))
        png.delete()
        // Streamed with its length given up front, and every byte of the file in it.
        assertEquals(body.size.toString(), length)
        val text = String(body, Charsets.ISO_8859_1)
        val start = text.indexOf("Content-Type: image/png\r\n\r\n") + "Content-Type: image/png\r\n\r\n".length
        assertTrue(start > 0)
        assertTrue((0 until 200_000).all { body[start + it] == (it % 251).toByte() })
    }

    @Test
    fun stoppingTheEventStreamDoesNotWaitForTheServer() = runBlocking {
        val probe = CountDownLatch(1)
        val closed = CountDownLatch(1)
        val base = serve { _, out ->
            out.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\nevent: hello\ndata: {}\n\n".toByteArray())
            out.flush()
            // Then nothing at all, not even a ping, until the client has stopped: only then is the line tried.
            probe.await(20, TimeUnit.SECONDS)
            repeat(50) {
                try {
                    out.write(":\n".toByteArray())
                    out.flush()
                } catch (_: IOException) {
                    closed.countDown()
                    return@serve
                }
                Thread.sleep(100)
            }
        }
        val hello = CountDownLatch(1)
        val job = launch(Dispatchers.Default) {
            NotatoClient(base, null).events("android-sample", agent = false).collect { if (it.event == "hello") hello.countDown() }
        }
        assertTrue(hello.await(5, TimeUnit.SECONDS))
        // A read blocked on a silent server ends when the stream is stopped, not at the next ping or the read timeout.
        withTimeout(3_000) {
            job.cancel()
            job.join()
        }
        probe.countDown()
        assertTrue("the server saw the stream closed", closed.await(10, TimeUnit.SECONDS))
    }
}
