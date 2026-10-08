package dev.notato.android

import dev.notato.android.internal.BundleWriter
import dev.notato.android.internal.LocalAnnotation
import dev.notato.android.internal.Ulid
import dev.notato.android.model.Annotation
import dev.notato.android.model.FeedbackBundle
import dev.notato.android.model.NotatoJson
import dev.notato.android.net.MultipartForm
import dev.notato.android.net.encodeAnnotation
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.zip.ZipInputStream

/** What the SDK sends is what the server takes: its own schema (packages/schema, run with bun), the form, the bundle and the ids. */
class ContractTest {
    @get:Rule
    val temp = TemporaryFolder()

    /** A screenshot on disk, as the store keeps it. */
    private fun shot(bytes: ByteArray): File = temp.newFile().apply { writeBytes(bytes) }

    /** The form as the server receives it. */
    private fun form(annotation: Annotation, assets: Map<String, File>): String {
        val form = MultipartForm(annotation, assets, "XYZ")
        val out = ByteArrayOutputStream()
        form.writeTo(out)
        // The length it says up front is the length it writes: the request streams with exactly that many bytes.
        assertEquals(form.length, out.size().toLong())
        return String(out.toByteArray(), Charsets.UTF_8)
    }

    @Test
    fun anAnnotationAsSentPassesTheServersSchema() {
        val result = Fixture.validate("annotation", encodeAnnotation(Fixture.annotation())) ?: return
        assertTrue(result.second, result.first)
    }

    @Test
    fun aPeopleOnlyNoteAsSentSaysSoAndPassesTheServersSchema() {
        val annotation = Fixture.annotation().copy(peopleOnly = true)
        val json = encodeAnnotation(annotation)
        assertTrue(NotatoJson.parseToJsonElement(json).jsonObject["peopleOnly"].toString() == "true")
        // In the form the server ingests, too.
        assertTrue(form(annotation, emptyMap()).contains("\"peopleOnly\":true"))
        val result = Fixture.validate("annotation", json) ?: return
        assertTrue(result.second, result.first)
    }

    @Test
    fun theCheckIsRealABadAnnotationFails() {
        val result = Fixture.validate("annotation", encodeAnnotation(Fixture.annotation(severity = "catastrophic"))) ?: return
        assertFalse(result.second, result.first)
    }

    @Test
    fun bundleIdIsWrittenAsNullAndMissingOptionalsAreLeftOut() {
        val json = encodeAnnotation(Fixture.annotation(severity = null, screenshots = false))
        val obj = NotatoJson.parseToJsonElement(json).jsonObject
        assertEquals(JsonNull, obj["bundleId"])
        assertFalse("severity" in obj)
        assertFalse("screenshots" in obj)
        assertFalse("peopleOnly" in obj)
        assertFalse(json.contains("null,") && json.indexOf("null") != json.indexOf("\"bundleId\":null") + 11)
    }

    @Test
    fun aPackagedBundlePassesTheServersSchemaAndHoldsItsFiles() {
        val annotation = Fixture.annotation()
        val assets = mapOf(annotation.screenshots!!.full.id to shot(byteArrayOf(1, 2, 3)), annotation.screenshots!!.crop!!.id to shot(byteArrayOf(4, 5)))
        val (bundle, files) = BundleWriter.build(listOf(LocalAnnotation(annotation, assets)), "android-sample", "Ada", "Notato Android sample", "1.0")
        assertEquals(setOf("shots/01-full.png", "shots/01-crop.png"), files.keys)
        assertEquals("test", bundle.annotations.single().mode)
        assertEquals(bundle.id, bundle.annotations.single().bundleId)

        // Written to a file as it goes, the screenshots read from theirs.
        val zipFile = temp.newFile("bundle.zip")
        zipFile.outputStream().use { BundleWriter.zip(bundle, files, it) }
        val entries = linkedMapOf<String, List<Int>>()
        ZipInputStream(zipFile.inputStream()).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                entries[entry.name] = zip.readBytes().map { it.toInt() }
            }
        }
        assertEquals(listOf("feedback.md", "annotations.json", "shots/01-full.png", "shots/01-crop.png"), entries.keys.toList())
        assertEquals(listOf(1, 2, 3), entries["shots/01-full.png"])
        assertEquals(listOf(4, 5), entries["shots/01-crop.png"])
        assertTrue(BundleWriter.markdown(bundle).contains("The price should line up with the name."))

        val result = Fixture.validate("bundle", NotatoJson.encodeToString(FeedbackBundle.serializer(), bundle)) ?: return
        assertTrue(result.second, result.first)
    }

    @Test
    fun idsAreUlidsThatSortByTime() {
        val earlier = Ulid.make(1_700_000_000_000)
        val later = Ulid.make(1_700_000_000_001)
        assertEquals(26, earlier.length)
        assertTrue(earlier < later)
        assertTrue(Regex("^[0-9A-HJKMNP-TV-Z]{26}$").matches(earlier))
    }

    @Test
    fun theFormCarriesTheAnnotationAndEachScreenshotAsAnAsset() {
        val annotation = Fixture.annotation()
        val full = annotation.screenshots!!.full.id
        val body = form(annotation, mapOf(full to shot("PNG".toByteArray())))
        assertTrue(body.startsWith("--XYZ\r\nContent-Disposition: form-data; name=\"annotation\"\r\n\r\n{"))
        assertTrue(body.contains("name=\"asset:$full\"; filename=\"$full\"\r\nContent-Type: image/png\r\n\r\nPNG\r\n"))
        // The crop's file was not given, so it is not sent.
        assertFalse(body.contains("asset:${annotation.screenshots!!.crop!!.id}"))
        assertTrue(body.endsWith("--XYZ--\r\n"))
    }

    @Test
    fun aScreenshotWhoseFileHasGoneIsLeftOutOfTheForm() {
        val annotation = Fixture.annotation()
        val full = annotation.screenshots!!.full.id
        val body = form(annotation, mapOf(full to File(temp.root, "gone.png")))
        assertFalse(body.contains("asset:$full"))
        assertTrue(body.endsWith("--XYZ--\r\n"))
    }

    @Test
    fun aBundleWithoutScreenshotFilesStillHasItsNotes() {
        val annotation = Fixture.annotation()
        val (bundle, files) = BundleWriter.build(listOf(LocalAnnotation(annotation, mapOf(annotation.screenshots!!.full.id to File(temp.root, "gone.png")))), "android-sample", null, null, null)
        assertTrue(files.isEmpty())
        assertEquals(null, bundle.annotations.single().screenshots)
    }
}
