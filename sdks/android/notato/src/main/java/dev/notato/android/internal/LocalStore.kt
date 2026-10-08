package dev.notato.android.internal

import android.util.Log
import dev.notato.android.model.Annotation
import dev.notato.android.model.NotatoJson
import dev.notato.android.net.encodeAnnotation
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

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
