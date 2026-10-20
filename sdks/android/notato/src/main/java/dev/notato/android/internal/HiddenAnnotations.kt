package dev.notato.android.internal

import dev.notato.android.model.Annotation
import dev.notato.android.model.NotatoJson
import dev.notato.android.model.Status
import kotlinx.serialization.encodeToString
import java.security.MessageDigest

/** Device preferences only. Neither annotations nor their copies on the server are changed. */
internal class HiddenAnnotations {
    private var signature: List<String?>? = null
    private var key = ""
    private var groups: Map<String, List<String>> = emptyMap()
    var encoded: String? = null
        private set
    var ids: Set<String> = emptySet()
        private set

    fun select(parts: List<String?>, saved: String?): Boolean {
        if (signature == parts && encoded == saved) return false
        signature = parts
        encoded = saved
        key = MessageDigest.getInstance("SHA-256").digest(NotatoJson.encodeToString(parts).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        groups = runCatching { NotatoJson.decodeFromString<Map<String, List<String>>>(saved ?: "{}") }.getOrDefault(emptyMap())
        ids = groups[key].orEmpty().toSet()
        return true
    }

    fun contains(a: Annotation): Boolean = isCompleted(a.status) && a.id in ids

    fun hide(annotations: Iterable<Annotation>): Boolean {
        val next = ids.toMutableSet()
        for (a in annotations) if (isCompleted(a.status)) next += a.id
        if (next.size == ids.size) return false
        ids = next
        save()
        return true
    }

    fun clear() {
        ids = emptySet()
        save()
    }

    private fun save() {
        groups = groups + (key to ids.toList())
        encoded = NotatoJson.encodeToString(groups)
    }

    companion object {
        fun isCompleted(status: String): Boolean = status in listOf(Status.RESOLVED, Status.REVERTED, Status.DISMISSED)
    }
}
