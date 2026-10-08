package dev.notato.android

import dev.notato.android.internal.LocalStore
import dev.notato.android.internal.PeopleOnly
import dev.notato.android.internal.SafeIds
import dev.notato.android.internal.writeAtomically
import dev.notato.android.model.Author
import dev.notato.android.model.NotatoJson
import dev.notato.android.net.encodeAnnotation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files

/** The notes kept on the device: ids from the server never reach outside the store. */
class StoreTest {
    @get:Rule
    val temp = TemporaryFolder()

    /** filesDir, with something of the app's own next to Notato's folder. */
    private fun filesDir(): File = temp.newFolder("files").also { File(it, "app-data.db").writeText("the app's") }

    private fun base(files: File) = File(files, "notato")

    @Test
    fun idsMustBeSafeToNameAFile() {
        assertTrue(SafeIds.isSafe("01J9ZQ3V4X5Y6Z7A8B9C0D1E2F"))
        assertTrue(SafeIds.isSafe("a".repeat(64)))
        assertTrue(SafeIds.isSafe("3f2c1a9e-7b4d-4c3e-9f1a-2b3c4d5e6f70"))
        for (bad in listOf("", "..", ".", "../..", "a/b", "a\\b", "a.png", "a b", "a".repeat(129))) assertFalse(bad, SafeIds.isSafe(bad))
    }

    @Test
    fun aDeleteWithATraversingIdLeavesEverythingAlone() {
        val files = filesDir()
        val store = LocalStore(base(files), "android-sample")
        val note = Fixture.annotation()
        store.save(note)
        for (id in listOf("..", "../..", "../../..", "/", ".")) store.remove(id)
        assertTrue(File(files, "app-data.db").isFile)
        assertEquals(listOf(note.id), store.load().map { it.annotation.id })
        // A real id still goes.
        store.remove(note.id)
        assertTrue(store.load().isEmpty())
        assertTrue(File(files, "app-data.db").isFile)
    }

    @Test
    fun aLinkOutOfTheStoreIsNotFollowedWhenDeleting() {
        val files = filesDir()
        val outside = temp.newFolder("outside").also { File(it, "keep.txt").writeText("keep") }
        val store = LocalStore(base(files), "android-sample")
        store.root.mkdirs()
        Files.createSymbolicLink(File(store.root, "01J9ZQ3V4X5Y6Z7A8B9C0D1E2F").toPath(), outside.toPath())
        store.remove("01J9ZQ3V4X5Y6Z7A8B9C0D1E2F")
        assertTrue(File(outside, "keep.txt").isFile)
    }

    @Test
    fun aProjectFolderIsItsIdWhenSafeAndAnotherNameWhenNot() {
        assertEquals("android-sample", SafeIds.projectFolder("android-sample"))
        assertEquals("shop.v2@acme", SafeIds.projectFolder("shop.v2@acme"))
        assertEquals("p-2e2e", SafeIds.projectFolder(".."))
        assertEquals("p-2e", SafeIds.projectFolder("."))
        assertEquals("p-2e2e2f2e2e", SafeIds.projectFolder("../.."))
        assertEquals("p-636166c3a9", SafeIds.projectFolder("café"))
        assertEquals(2 + 64, SafeIds.projectFolder("é".repeat(100)).length)

        // Clearing a project called ".." clears its own folder, not filesDir.
        val files = filesDir()
        val store = LocalStore(base(files), "..")
        store.save(Fixture.annotation())
        assertEquals(File(base(files), "p-2e2e").canonicalPath, store.root.canonicalPath)
        store.clear()
        assertFalse(store.root.exists())
        assertTrue(File(files, "app-data.db").isFile)
    }

    @Test
    fun savesAndLoadsANoteWithItsScreenshotsAndSkipsUnsafeOnes() {
        val store = LocalStore(base(filesDir()), "android-sample")
        val note = Fixture.annotation()
        val full = note.screenshots!!.full.id
        val saved = store.save(note, mapOf(full to byteArrayOf(1, 2), "../escape" to byteArrayOf(3)))
        assertEquals(setOf(full), saved.keys)
        val loaded = store.load().single()
        assertEquals(note, loaded.annotation)
        // Where the screenshot is, not its bytes: it is read when the note is sent or packaged.
        assertEquals(setOf(full), loaded.assets.keys)
        assertEquals(listOf(1, 2), loaded.assets.getValue(full).readBytes().map { it.toInt() })
        assertFalse(File(store.root, "escape.png").exists())

        // A note on disk whose id is not safe, or not its folder's name, is not taken.
        val odd = File(store.root, "elsewhere").apply { mkdirs() }
        File(odd, "annotation.json").writeText(encodeAnnotation(note.copy(id = "elsewhere-2")))
        val bad = File(store.root, "bad").apply { mkdirs() }
        val json = NotatoJson.parseToJsonElement(encodeAnnotation(note)).toString().replace(note.id, "../bad")
        File(bad, "annotation.json").writeText(json)
        assertEquals(listOf(note.id), store.load().map { it.annotation.id })
    }

    @Test
    fun turningPeopleOnlyOnForAWaitingNoteKeepsItsScreenshots() {
        val store = LocalStore(base(filesDir()), "android-sample")
        val note = Fixture.annotation()
        val full = note.screenshots!!.full.id
        store.save(note, mapOf(full to byteArrayOf(1, 2)))
        // As the controller does it: only annotation.json is written again.
        val changed = PeopleOnly.toggle(note, on = true, author = Author.human("Ada"))
        store.save(changed)
        val loaded = store.load().single()
        assertEquals(true, loaded.annotation.peopleOnly)
        assertEquals(PeopleOnly.ON_TEXT, loaded.annotation.thread.single().body)
        assertEquals(listOf(1, 2), loaded.assets.getValue(full).readBytes().map { it.toInt() })
    }

    @Test
    fun aNoteThatCannotBeReadIsSkippedAndTheRestStillLoad() {
        val store = LocalStore(base(filesDir()), "android-sample")
        val good = Fixture.annotation()
        store.save(good)
        // A file cut short (as a write that was not whole-or-nothing could leave one), and one from who knows where.
        val broken = File(store.root, "01J9ZQ3V4X5Y6Z7A8B9C0D1E2G").apply { mkdirs() }
        File(broken, "annotation.json").writeText(encodeAnnotation(good.copy(id = broken.name)).take(80))
        val garbage = File(store.root, "01J9ZQ3V4X5Y6Z7A8B9C0D1E2H").apply { mkdirs() }
        File(garbage, "annotation.json").writeBytes(byteArrayOf(0, 1, 2))
        assertEquals(listOf(good.id), store.load().map { it.annotation.id })
        // Left on the device, not deleted: a later version may read it.
        assertTrue(File(broken, "annotation.json").isFile)
    }

    @Test
    fun aWriteIsWholeOrNotAtAll() {
        val store = LocalStore(base(filesDir()), "android-sample")
        val note = Fixture.annotation()
        val full = note.screenshots!!.full.id
        store.save(note, mapOf(full to byteArrayOf(1, 2, 3)))
        val folder = File(store.root, note.id)
        // Nothing is left beside the files once they are written.
        assertEquals(setOf("annotation.json", "$full.png"), folder.list()!!.toSet())

        // A crash part way through writing the note again leaves its temporary file, never half of annotation.json.
        File(folder, "annotation.json.tmp").writeText(encodeAnnotation(note.copy(comment = "half")).take(40))
        File(folder, "$full.png.tmp").writeBytes(byteArrayOf(9))
        val loaded = store.load().single()
        assertEquals(note, loaded.annotation)
        assertEquals(listOf(1, 2, 3), loaded.assets.getValue(full).readBytes().map { it.toInt() })
        // And what was left is cleared away.
        assertEquals(setOf("annotation.json", "$full.png"), folder.list()!!.toSet())

        writeAtomically(File(folder, "annotation.json"), "{}".toByteArray())
        assertEquals("{}", File(folder, "annotation.json").readText())
    }

    @Test
    fun anUnsafeIdIsNeverSaved() {
        val files = filesDir()
        val store = LocalStore(base(files), "android-sample")
        store.save(Fixture.annotation().copy(id = "../../evil"))
        assertFalse(File(files, "evil").exists())
        assertTrue(store.load().isEmpty())
    }
}
