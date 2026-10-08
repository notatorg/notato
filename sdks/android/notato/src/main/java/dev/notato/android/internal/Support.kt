package dev.notato.android.internal

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import dev.notato.android.model.Annotation
import dev.notato.android.model.AssetRef
import dev.notato.android.model.BundleAuthor
import dev.notato.android.model.FeedbackBundle
import dev.notato.android.model.LogEntry
import dev.notato.android.model.NotatoJson
import dev.notato.android.model.Screenshots
import dev.notato.android.net.encodeAnnotation
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStream
import java.math.BigInteger
import java.security.MessageDigest
import java.security.SecureRandom
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** Universally unique, lexicographically sortable ids: 48 bits of milliseconds and 80 random bits, in Crockford base32. */
internal object Ulid {
    private const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    private val random = SecureRandom()

    fun make(millis: Long = System.currentTimeMillis()): String {
        val bytes = ByteArray(16)
        var ms = millis
        for (i in 5 downTo 0) {
            bytes[i] = (ms and 0xFF).toByte()
            ms = ms shr 8
        }
        val tail = ByteArray(10).also { random.nextBytes(it) }
        tail.copyInto(bytes, 6)
        var value = BigInteger(1, bytes)
        val out = CharArray(26)
        val mask = BigInteger.valueOf(31)
        for (i in 25 downTo 0) {
            out[i] = ALPHABET[value.and(mask).toInt()]
            value = value.shiftRight(5)
        }
        return String(out)
    }
}

internal object Time {
    fun iso(date: Date = Date()): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }.format(date)
}

internal fun sha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

/** An annotation made on this device, and its screenshots on disk by asset id: read only when sent or packaged. */
internal class LocalAnnotation(val annotation: Annotation, val assets: Map<String, File>)

/**
 * Writes [bytes] to [file] whole or not at all: to a file beside it first, flushed to the disk, then renamed over it. A
 * crash or a full disk part way leaves the old file (or none), never half of one.
 */
internal fun writeAtomically(file: File, bytes: ByteArray) {
    val temp = File(file.parentFile, file.name + ".tmp")
    try {
        FileOutputStream(temp).use { out ->
            out.write(bytes)
            out.fd.sync()
        }
        // A rename within a folder replaces the file in one step on Android. Where it cannot replace one (Windows,
        // running the unit tests), the old file goes first.
        if (!temp.renameTo(file) && !(file.delete() && temp.renameTo(file))) throw IOException("Could not write ${file.path}")
    } catch (error: IOException) {
        temp.delete()
        throw error
    }
}

/**
 * Ids that may name a file. Annotation and screenshot ids also come from the server (and from files on disk), so one
 * like `../..` must never reach a path: the schema's `SafeId` is checked here too, before any id is joined into one.
 */
internal object SafeIds {
    private val id = Regex("^[A-Za-z0-9_-]{1,128}$")
    private val folder = Regex("^[A-Za-z0-9_.@-]+$")

    fun isSafe(value: String): Boolean = id.matches(value)

    /**
     * The folder a project's notes are kept in: the project id itself when that is a safe name (every id the server
     * takes is, so existing notes stay where they are), else a name made from its bytes that cannot leave the store.
     */
    fun projectFolder(project: String): String {
        if (folder.matches(project) && project != "." && project != "..") return project
        val bytes = project.toByteArray(Charsets.UTF_8)
        return "p-" + if (bytes.size <= 64) bytes.joinToString("") { "%02x".format(it) } else sha256(bytes)
    }

    /** Whether [file] is inside [parent] once links and `..` are resolved: checked before anything is deleted. */
    fun inside(file: File, parent: File): Boolean = runCatching {
        file.canonicalPath.startsWith(parent.canonicalPath + File.separator)
    }.getOrDefault(false)
}

/**
 * Notes made on this device, on disk until the server has them: a note made while the server is down still reaches
 * the agent later, and a tester's notes survive a restart until they are packaged. One folder per note under the
 * project's folder in [base], its screenshots first and `annotation.json` last, each written whole or not at all.
 */
internal class LocalStore(private val base: File, project: String) {
    val root = File(base, SafeIds.projectFolder(project))
    private var warned = false

    /** An id that cannot name a file: the file operation is skipped (once said in the log), whatever else happens. */
    private fun unsafe(id: String): Boolean {
        if (SafeIds.isSafe(id)) return false
        if (!warned) {
            warned = true
            Log.w(TAG, "Notato skipped a file for the id \"${id.take(40)}\": ids are letters, digits, _ and - only.")
        }
        return true
    }

    /**
     * Saves a note, with its screenshots' bytes by asset id ([pictures]; none when only the note changed, as the
     * screenshots on disk have not). Returns where the screenshots now are, so they need not be kept in memory.
     */
    @Synchronized
    fun save(annotation: Annotation, pictures: Map<String, ByteArray> = emptyMap()): Map<String, File> {
        if (unsafe(annotation.id)) return emptyMap()
        val folder = File(root, annotation.id).apply { mkdirs() }
        val files = linkedMapOf<String, File>()
        for ((id, bytes) in pictures) {
            if (unsafe(id)) continue
            val file = File(folder, "$id.png")
            writeAtomically(file, bytes)
            files[id] = file
        }
        writeAtomically(File(folder, "annotation.json"), encodeAnnotation(annotation).toByteArray(Charsets.UTF_8))
        return files
    }

    /**
     * Every note kept here, oldest first, with where its screenshots are (they are not read). A folder that cannot be
     * read is said in the log and left where it is; the others still load.
     */
    @Synchronized
    fun load(): List<LocalAnnotation> {
        val notes = mutableListOf<LocalAnnotation>()
        for (folder in root.listFiles() ?: emptyArray()) {
            if (!folder.isDirectory) continue
            try {
                read(folder)?.let { notes += it }
            } catch (error: Exception) {
                Log.w(TAG, "Notato could not read the note kept in ${folder.name}; it is left on the device and skipped.", error)
            }
        }
        return notes.sortedWith(compareBy({ it.annotation.createdAt }, { it.annotation.id }))
    }

    private fun read(folder: File): LocalAnnotation? {
        // What a write cut short left behind: never the file itself, which is whole or missing.
        folder.listFiles { f -> f.name.endsWith(".tmp") }?.forEach { it.delete() }
        // No annotation.json: the note was never finished being written (it is written last).
        val json = File(folder, "annotation.json").takeIf { it.isFile } ?: return null
        val annotation = NotatoJson.decodeFromString(Annotation.serializer(), json.readText())
        // Kept only in the folder its id names: any other could never be removed once the server has it.
        if (unsafe(annotation.id) || folder.name != annotation.id) return null
        val assets = (folder.listFiles { f -> f.extension == "png" } ?: emptyArray())
            .filter { SafeIds.isSafe(it.nameWithoutExtension) }
            .associate { it.nameWithoutExtension to it }
        return LocalAnnotation(annotation, assets)
    }

    @Synchronized
    fun remove(id: String) {
        if (unsafe(id)) return
        val folder = File(root, id)
        if (SafeIds.inside(folder, root)) folder.deleteRecursively()
    }

    @Synchronized
    fun clear() {
        if (SafeIds.inside(root, base)) root.deleteRecursively()
    }
}

/** What a person chose on the device, kept in SharedPreferences: each unset value falls back to the configuration. */
internal class RuntimeState(private val store: Store) {
    /** Where the choices live: SharedPreferences, or memory alone when the app asked for nothing to be remembered. */
    interface Store {
        fun get(key: String): String?
        fun set(key: String, value: String?)
    }

    class Memory : Store {
        private val values = mutableMapOf<String, String>()
        override fun get(key: String): String? = values[key]
        override fun set(key: String, value: String?) {
            if (value == null) values.remove(key) else values[key] = value
        }
    }

    private class Preferences(private val prefs: SharedPreferences) : Store {
        override fun get(key: String): String? = prefs.getString(key, null)
        override fun set(key: String, value: String?) = prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()
    }

    constructor(context: Context, remember: Boolean) :
        this(if (remember) Preferences(context.getSharedPreferences("notato", Context.MODE_PRIVATE)) else Memory())

    private fun get(key: String): String? = store.get(key)
    private fun set(key: String, value: String?) = store.set(key, value)

    private fun bool(key: String) = get(key)?.let { it == "1" }
    private fun setBool(key: String, value: Boolean?) = set(key, value?.let { if (it) "1" else "0" })

    var enabled: Boolean?
        get() = bool("enabled")
        set(value) = setBool("enabled", value)
    var toolbarVisible: Boolean?
        get() = bool("toolbar")
        set(value) = setBool("toolbar", value)
    var screenshots: Boolean?
        get() = bool("screenshots")
        set(value) = setBool("screenshots", value)
    var pinsVisible: Boolean?
        get() = bool("pins")
        set(value) = setBool("pins", value)
    var author: String?
        get() = get("author")
        set(value) = set("author", value?.trim()?.ifEmpty { null })
    var server: String?
        get() = get("server")
        set(value) = set("server", value?.trim()?.trimEnd('/')?.ifEmpty { null })

    /** Where the toolbar was dragged to, as fractions of the window so it survives rotation. */
    var toolbarPosition: Pair<Float, Float>?
        get() = get("toolbar.position")?.split(",")?.takeIf { it.size == 2 }?.let { (x, y) ->
            val fx = x.toFloatOrNull() ?: return null
            val fy = y.toFloatOrNull() ?: return null
            fx.coerceIn(0f, 1f) to fy.coerceIn(0f, 1f)
        }
        set(value) = set("toolbar.position", value?.let { "${it.first},${it.second}" })

    /** Whether the toolbar was left folded into its round button, kept next to its place. Unset is open. */
    var toolbarCollapsed: Boolean
        get() = bool("toolbar.collapsed") ?: false
        set(value) = setBool("toolbar.collapsed", value.takeIf { it })

    fun reset() {
        for (key in listOf("enabled", "toolbar", "screenshots", "pins", "author", "server", "toolbar.position", "toolbar.collapsed")) set(key, null)
    }
}

/**
 * Writes a tester's notes as the bundle zip the rest of Notato reads (packages/core/src/bundle.ts):
 * `annotations.json`, a `feedback.md` to read top to bottom, and the screenshots in `shots/`.
 */
internal object BundleWriter {
    /** The bundle, and the files that go in the zip with it: the zip's path for each, and the screenshot on disk. */
    fun build(items: List<LocalAnnotation>, project: String, author: String?, appName: String?, appVersion: String?): Pair<FeedbackBundle, Map<String, File>> {
        val id = Ulid.make()
        val files = linkedMapOf<String, File>()
        val annotations = items.mapIndexed { index, item ->
            val n = "%02d".format(index + 1)
            var shots: Screenshots? = null
            val refs = item.annotation.screenshots
            val full = refs?.full?.let { item.assets[it.id] }?.takeIf { it.isFile }
            if (refs != null && full != null) {
                val fullRef = refs.full.copy(path = "shots/$n-full.png")
                files[fullRef.path!!] = full
                var cropRef: AssetRef? = null
                val cropFile = refs.crop?.let { item.assets[it.id] }?.takeIf { it.isFile }
                if (refs.crop != null && cropFile != null) {
                    cropRef = refs.crop.copy(path = "shots/$n-crop.png")
                    files[cropRef.path!!] = cropFile
                }
                shots = Screenshots(fullRef, cropRef)
            }
            item.annotation.copy(bundleId = id, mode = "test", screenshots = shots)
        }
        return FeedbackBundle(id, project, Time.iso(), BundleAuthor(author), appName, appVersion, annotations) to files
    }

    /** Writes the zip to [out] as it goes: the screenshots are read from disk one at a time, never all held at once. */
    fun zip(bundle: FeedbackBundle, files: Map<String, File>, out: OutputStream) {
        ZipOutputStream(out).use { zip ->
            fun add(name: String, bytes: ByteArray) {
                zip.putNextEntry(ZipEntry(name))
                zip.write(bytes)
                zip.closeEntry()
            }
            add("feedback.md", markdown(bundle).toByteArray())
            add("annotations.json", NotatoJson.encodeToString(FeedbackBundle.serializer(), bundle).toByteArray())
            for ((name, file) in files) {
                // Screenshots are compressed already: stored, which needs their size and checksum before they go in.
                val crc = CRC32()
                file.inputStream().use { input ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buffer)
                        if (n < 0) break
                        crc.update(buffer, 0, n)
                    }
                }
                val entry = ZipEntry(name).apply {
                    method = ZipEntry.STORED
                    size = file.length()
                    compressedSize = size
                    this.crc = crc.value
                }
                zip.putNextEntry(entry)
                file.inputStream().use { it.copyTo(zip) }
                zip.closeEntry()
            }
        }
    }

    private fun oneLine(text: String) = text.split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")

    fun markdown(bundle: FeedbackBundle): String = buildString {
        append("# Feedback").append(bundle.appName?.let { " for $it" } ?: "").append(bundle.appVersion?.let { " $it" } ?: "").append("\n\n")
        append("Project `${bundle.projectId}` · bundle `${bundle.id}` · ").append(bundle.author.name?.let { "from $it · " } ?: "")
        append("${bundle.createdAt} · ${bundle.annotations.size} annotation${if (bundle.annotations.size == 1) "" else "s"}\n")
        bundle.annotations.forEachIndexed { i, a ->
            append("\n## ${i + 1}. ${a.route}").append(a.severity?.let { " — $it" } ?: "").append(if (a.peopleOnly == true) " · People only" else "").append("\n\n")
            a.comment.lines().forEach { append("> ").append(it).append('\n') }
            append('\n')
            a.screenshots?.full?.path?.let { append("![Full screenshot, target outlined]($it)\n") }
            a.screenshots?.crop?.path?.let { append("![Crop of the target]($it)\n") }
            append('\n')
            a.target.identity.forEachIndexed { n, id ->
                val said = (id.name ?: id.text)?.let { " “${oneLine(it).take(80)}”" } ?: ""
                append("- Target${if (a.target.identity.size > 1) " ${n + 1}" else ""} (${a.target.kind}): ${id.role ?: id.tag}$said\n")
                append("  - Selector: `${id.selector}`\n")
                id.testId?.let { append("  - Test id: `$it`\n") }
                id.source?.let { append("  - Written at: `${it.file}:${it.line}:${it.col}`${if (it.nearest == true) " (the nearest place around it)" else ""}\n") }
                id.component?.let { c -> append("  - Component: ${c.name}").append(c.source?.let { " (`$it`)" } ?: "").append('\n') }
            }
            append("- Page: ${a.url}\n")
            append("- Viewport: ${a.environment.viewport.w}×${a.environment.viewport.h} @${a.environment.dpr}x · ${a.author.name ?: a.author.kind} · ${a.createdAt}\n")
            a.steps?.takeIf { it.isNotEmpty() }?.let { steps ->
                append("\nSteps taken:\n")
                steps.forEachIndexed { n, s -> append("${n + 1}. ${s.action}").append(s.target?.let { " `$it`" } ?: "").append(s.value?.let { " = ${oneLine(it)}" } ?: "").append('\n') }
            }
        }
    }
}

/**
 * The app's recent warnings and errors, read back from logcat (an app may read its own process's log), attached to each
 * note as `context.console` in the web SDK's shape.
 */
internal object LogRecorder {
    private val line = Regex("""^\s*(\d+(?:\.\d+)?)\s+\d+\s+\d+\s+([VDIWEF])\s+(.*?)\s*:\s(.*)$""")

    fun recent(limit: Int, sinceMillis: Long): List<LogEntry> {
        if (limit <= 0) return emptyList()
        return try {
            val process = ProcessBuilder("logcat", "-d", "-v", "epoch", "--pid=${android.os.Process.myPid()}", "*:W")
                .redirectErrorStream(true)
                .start()
            val entries = ArrayDeque<LogEntry>()
            process.inputStream.bufferedReader().useLines { lines ->
                for (raw in lines) {
                    val match = line.find(raw) ?: continue
                    val (seconds, level, tag, message) = match.destructured
                    val millis = (seconds.toDouble() * 1000).toLong()
                    if (millis < sinceMillis || tag.startsWith("Notato")) continue
                    val text = "[$tag] $message".let { if (it.length > 1000) it.take(999) + "…" else it }
                    entries.addLast(LogEntry(if (level == "W") "warn" else "error", text, Time.iso(Date(millis))))
                    if (entries.size > limit) entries.removeFirst()
                }
            }
            process.waitFor()
            entries.toList()
        } catch (_: Exception) {
            emptyList()
        }
    }
}
