package dev.notato.android.internal

import android.app.Activity
import android.content.Intent
import androidx.core.content.FileProvider
import dev.notato.android.model.AssetRef
import dev.notato.android.model.BundleAuthor
import dev.notato.android.model.FeedbackBundle
import dev.notato.android.model.NotatoJson
import dev.notato.android.model.Screenshots
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

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

/** The folder in the app's cache that packages are written to, and that Notato's FileProvider shares from. */
private const val PACKAGE_FOLDER = "notato"

/** Packages older than this are deleted when the next is made. */
private const val PACKAGE_MAX_AGE_MS = 60 * 60 * 1000L

/**
 * Writes [items] as a bundle zip in the app's cache ([cacheDir]), as it goes (the screenshots read from disk one at a
 * time), and returns it. Packages made before go once they are an hour old: each is made again from the notes when
 * asked for, and the last one shared may still be being read by the app it went to. Call it off the main thread.
 */
internal fun writePackage(cacheDir: File, items: List<LocalAnnotation>, project: String, author: String?, appName: String?, appVersion: String?): File {
    val (bundle, files) = BundleWriter.build(items, project, author, appName, appVersion)
    val folder = File(cacheDir, PACKAGE_FOLDER).apply { mkdirs() }
    val old = System.currentTimeMillis() - PACKAGE_MAX_AGE_MS
    folder.listFiles { f -> f.name.startsWith("notato-") && f.name.endsWith(".zip") && f.lastModified() < old }?.forEach { it.delete() }
    val stamp = SimpleDateFormat("yyyyMMdd-HHmm", Locale.US).format(Date())
    val file = File(folder, "notato-$project-$stamp.zip")
    try {
        FileOutputStream(file).buffered().use { BundleWriter.zip(bundle, files, it) }
    } catch (error: Exception) {
        file.delete()
        throw error
    }
    return file
}

/** Opens the share sheet for a package, handed over through Notato's own FileProvider. */
internal fun sharePackage(activity: Activity, file: File) {
    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.notato.files", file)
    val share = Intent(Intent.ACTION_SEND).apply {
        type = "application/zip"
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    activity.startActivity(Intent.createChooser(share, "Notato feedback"))
}
