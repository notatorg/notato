package dev.notato.android

import dev.notato.android.model.Annotation
import dev.notato.android.model.AssetRef
import dev.notato.android.model.Author
import dev.notato.android.model.ComponentInfo
import dev.notato.android.model.ElementIdentity
import dev.notato.android.model.EnvironmentInfo
import dev.notato.android.model.PageRect
import dev.notato.android.model.SdkInfo
import dev.notato.android.model.Screenshots
import dev.notato.android.model.SourceLocation
import dev.notato.android.model.Status
import dev.notato.android.model.Target
import dev.notato.android.model.Viewport
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.io.File
import java.util.concurrent.TimeUnit

internal object Fixture {
    fun annotation(severity: String? = "major", screenshots: Boolean = true): Annotation = Annotation(
        id = "01J9ZQ3V4X5Y6Z7A8B9C0D1E2F",
        projectId = "android-sample",
        author = Author.human("Ada"),
        mode = "dev",
        createdAt = "2026-10-06T09:00:00.000Z",
        url = "android://dev.notato.sample/MainActivity/ShopScreen",
        route = "/MainActivity/ShopScreen",
        appName = "Notato Android sample",
        appVersion = "1.0 (1)",
        environment = EnvironmentInfo("Notato Android sample/1.0 (Android 16; Google Pixel 7)", Viewport(412.0, 915.0), 2.625, "android", SdkInfo("dev.notato:notato-android", BuildConfig.NOTATO_VERSION)),
        target = Target(
            kind = "element",
            identity = listOf(
                ElementIdentity(
                    selector = "ShopScreen text:text(\"£89.00\")",
                    role = "text",
                    tag = "Text",
                    text = "£89.00",
                    source = SourceLocation("ShopScreens.kt", 92, 1),
                    component = ComponentInfo("ProductRow", "ShopScreens.kt", listOf("ShopTheme", "ShopScreen", "ProductRow")),
                    styles = mapOf("width" to "60dp", "height" to "24dp"),
                    ancestors = listOf("MainActivity", "ComposeView"),
                ),
            ),
            rect = PageRect(300.5, 210.0, 60.0, 24.0),
        ),
        comment = "The price should line up with the name.",
        severity = severity,
        intent = "fix",
        screenshots = if (screenshots) Screenshots(AssetRef("a".repeat(64), "image/png", 824, 1830), AssetRef("b".repeat(64), "image/png", 220, 120)) else null,
        context = mapOf("android" to buildJsonObject { put("sdk", JsonPrimitive(36)) }),
        status = Status.OPEN,
    )

    /** The repository root: the tests run from sdks/android/notato. */
    val repository: File = generateSequence(File("").absoluteFile) { it.parentFile }.first { File(it, "packages/schema").isDirectory }

    private fun bun(): String? = listOfNotNull(System.getenv("HOME")?.let { "$it/.bun/bin/bun" }, "/opt/homebrew/bin/bun", "/usr/local/bin/bun")
        .firstOrNull { File(it).canExecute() }

    /** Runs the server's own Zod schema over JSON this SDK wrote. Null when bun is not installed. */
    fun validate(kind: String, json: String): Pair<Boolean, String>? {
        val bun = bun() ?: return null
        val file = File.createTempFile("notato-", ".json").apply { writeText(json) }
        val process = ProcessBuilder(bun, "sdks/android/scripts/validate.ts", kind, file.path)
            .directory(repository)
            .redirectErrorStream(true)
            .start()
        val output = process.inputStream.bufferedReader().readText()
        process.waitFor(60, TimeUnit.SECONDS)
        file.delete()
        return (process.exitValue() == 0) to output
    }
}
