package dev.notato.android.internal

import dev.notato.android.model.LogEntry
import java.util.Date

/**
 * The app's recent warnings and errors, read back from logcat (an app may read its own process's log), attached to each
 * note as `context.console` in the web SDK's shape.
 */
internal object LogRecorder {
    private val line = Regex("""^\s*(\d+(?:\.\d+)?)\s+\d+\s+\d+\s+([VDIWEF])\s+(.*?)\s*:\s(.*)$""")

    /**
     * Credentials a line can carry (an HTTP client logging its headers), each with what it is replaced by: the header's
     * name stays, so the line still says what it was.
     */
    private val credentials = listOf(
        Regex("""(?i)\b((?:proxy-)?authorization|(?:set-)?cookie)(\s*[:=]\s*)[^\r\n]+""") to "\$1\$2[redacted]",
        // A bearer token on its own (in an error message, say): long, unlike the word in a sentence.
        Regex("""(?i)\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}""") to "\$1 [redacted]",
    )

    /** A log line without the credentials in it. */
    fun redact(text: String): String = credentials.fold(text) { out, (pattern, replacement) -> pattern.replace(out, replacement) }

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
                    val text = "[$tag] ${redact(message)}".let { if (it.length > 1000) it.take(999) + "…" else it }
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
