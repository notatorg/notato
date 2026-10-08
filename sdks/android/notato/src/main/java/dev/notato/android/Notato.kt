package dev.notato.android

import android.annotation.SuppressLint
import android.app.Application
import android.content.Context
import android.os.Looper
import android.util.Log
import android.view.View
import dev.notato.android.inspect.ElementProvider
import dev.notato.android.inspect.ViewInspector
import dev.notato.android.internal.Controller
import dev.notato.android.internal.TAG
import dev.notato.android.model.AgentStep
import dev.notato.android.model.Annotation
import dev.notato.android.model.NetworkEntry
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.io.File

/** How Notato is talking to its server. */
public enum class NotatoConnection {
    /** Notato is off. */
    DISABLED,

    /** No server: notes stay on the device (test mode, or `noServer`). */
    LOCAL,
    CONNECTING,
    CONNECTED,

    /** The server cannot be reached; Notato keeps trying, and notes wait on the device. */
    OFFLINE,

    /** The server answered but refused this app (a wrong token or project). */
    REFUSED,
}

/** A snapshot of Notato for the app to show: collect [Notato.state]. */
public data class NotatoState(
    val isEnabled: Boolean = false,
    val isToolbarVisible: Boolean = false,
    val isAnnotating: Boolean = false,
    val connection: NotatoConnection = NotatoConnection.DISABLED,
    val connectionDetail: String? = null,
    /**
     * Every note Notato knows of in this project: from the server, and made here and not sent yet. Those read from the
     * server's list are summaries, without their `context` and `steps`; those made here or heard of since are whole.
     */
    val annotations: List<Annotation> = emptyList(),
    /** Notes made here the server does not have yet (in test mode: not packaged yet). */
    val pendingCount: Int = 0,
)

/** For notes made from code: [Notato.annotate]. */
public data class AnnotateOptions(
    /** `blocker`, `major`, `minor` or `nit`. */
    val severity: String? = null,
    /** `fix`, `change`, `question`, `approve` or `variants`. */
    val intent: String? = null,
    /** Set to make the note as an agent of this name rather than as the person. */
    val agentName: String? = null,
    val steps: List<AgentStep>? = null,
    val screenshot: Boolean = true,
    /** People only: the note and its thread stay between people and never reach the agent. A person's note only. */
    val peopleOnly: Boolean = false,
)

/**
 * Notato for native Android: point at something in the app, write a note, and your coding agent gets it with the
 * element's identity, where it is written and a screenshot.
 *
 * Start it from `Application.onCreate` with [start], or with no code at all through the manifest (see the README). Call
 * everything else on the main thread.
 */
public object Notato {
    private var controller: Controller? = null
    private val idle = MutableStateFlow(NotatoState())

    /** Notato now; collect it to show its state in the app. */
    public val state: StateFlow<NotatoState> get() = controller?.stateFlow ?: idle

    /** The configuration Notato was started with, or null before [start]. */
    public val config: NotatoConfig? get() = controller?.config

    public val isStarted: Boolean get() = controller != null

    /**
     * Starts Notato for the whole app. Call it once, from `Application.onCreate`; calling it again applies a new
     * configuration. Values from `debug.notato.*` system properties win over [config], so a build can be pointed at
     * another server without being rebuilt.
     */
    @JvmStatic
    public fun start(application: Application, config: NotatoConfig) {
        checkMain()
        val merged = withSystemProperties(config)
        installAddOns(merged)
        val existing = controller
        if (existing != null) {
            existing.reconfigure(merged)
            return
        }
        controller = Controller(application, merged).also { it.start() }
    }

    /** Starts Notato from the manifest's `notato.*` meta-data. False when there is no `notato.project`. */
    @JvmStatic
    public fun start(application: Application): Boolean {
        val config = manifestConfig(application) ?: return false
        start(application, config)
        return true
    }

    /** Turns Notato on, and remembers that across launches (when [NotatoConfig.rememberRuntimeState]). */
    @JvmStatic
    public fun enable(): Unit = withController { it.setEnabled(true, remember = true) }

    /** Turns Notato off: the overlay goes, the connection closes. Notes not yet sent stay on the device. */
    @JvmStatic
    public fun disable(): Unit = withController { it.setEnabled(false, remember = true) }

    @JvmStatic
    public fun setEnabled(enabled: Boolean): Unit = if (enabled) enable() else disable()

    /** Forgets every choice made at runtime (on or off, the toolbar, name, server) and goes back to the configuration. */
    @JvmStatic
    public fun resetRuntimeState(): Unit = withController { it.resetRuntimeState() }

    @JvmStatic
    public fun showToolbar(): Unit = withController { it.setToolbar(true) }

    /** Hides the toolbar. Shaking the device brings it back (unless [NotatoConfig.shakeToToggle] is off). */
    @JvmStatic
    public fun hideToolbar(): Unit = withController { it.setToolbar(false) }

    /** Picking mode: the next tap selects what is under it instead of reaching the app. */
    @JvmStatic
    public fun startAnnotating(): Unit = withController { it.startAnnotating() }

    @JvmStatic
    public fun stopAnnotating(): Unit = withController { it.stopAnnotating() }

    /** Selects a view and opens the note composer on it, as tapping it in picking mode would. */
    @JvmStatic
    public fun select(view: View): Unit = withController { it.select(view) }

    /** Selects what a selector finds on the screen (`#sign_in`, `button:text("Pay")`) and opens the composer on it. */
    @JvmStatic
    public fun select(selector: String): Unit = withController { it.select(selector) }

    /**
     * Makes a note from code about what [selector] finds on the screen, sends it (or keeps it, in test mode) and returns
     * it. Throws [IllegalArgumentException] when nothing matches.
     */
    public suspend fun annotate(selector: String, comment: String, options: AnnotateOptions = AnnotateOptions()): Annotation =
        running().annotate(selector, comment, options)

    /** Makes a note from code about [view]. */
    public suspend fun annotate(view: View, comment: String, options: AnnotateOptions = AnnotateOptions()): Annotation =
        running().annotate(view, comment, options)

    /**
     * Test mode: packages the notes on this device as a zip (`annotations.json`, `feedback.md` and the screenshots), and
     * uploads it when a server is set and [upload] is true. Returns the zip, in the app's cache folder.
     */
    public suspend fun packageNotes(upload: Boolean = true): File = running().packageNotes(upload)

    /** Records a request for the `network` context of later notes. The last 50 are kept. */
    @JvmStatic
    public fun recordRequest(entry: NetworkEntry) {
        controller?.recordRequest(entry)
    }

    /** Adds a source of elements the View tree cannot see into (the `notato-compose` artifact registers its own). */
    @JvmStatic
    public fun register(provider: ElementProvider) {
        if (ViewInspector.providers.none { it.javaClass == provider.javaClass }) ViewInspector.providers += provider
    }

    /**
     * Marks how private a view is, for screenshots and for everything a note records (`Modifier.notatoMask` does the
     * same for a composable):
     *
     * - `true`: private (card numbers, personal details). Covered in screenshots, and neither its text nor that of any
     *   view inside it is recorded: no text, label or content description, no `:text(…)` in selectors, nothing in the
     *   text of the views around it. Everything inside it is private too.
     * - `false`: not private. A text field (a search box) is shown, and its value recorded, even when
     *   [NotatoConfig.maskInputs] is on; on a container, the fields in it are. A private view around it still wins,
     *   and password fields are masked regardless.
     * - `null`: back to the default.
     */
    @JvmStatic
    @JvmOverloads
    public fun mask(view: View, masked: Boolean? = true) {
        view.setTag(R.id.notato_mask, masked)
    }

    /** Stops Notato completely; [start] can start it again. Mostly for tests. */
    @JvmStatic
    public fun shutdown() {
        controller?.close()
        controller = null
    }

    // ---- start-up details --------------------------------------------------------------------------------------------

    /** The `notato-compose` artifact, when the app has it: found by name so the core needs no Compose. */
    private fun installAddOns(config: NotatoConfig) {
        val compose = try {
            Class.forName("dev.notato.android.compose.NotatoCompose")
        } catch (_: ClassNotFoundException) {
            return
        }
        try {
            compose.getMethod("install", Boolean::class.javaPrimitiveType).invoke(null, config.composeSourceInfo)
        } catch (error: Throwable) {
            Log.w(TAG, "Notato could not set up Compose support: $error")
        }
    }

    private fun running(): Controller {
        checkMain()
        return controller ?: throw IllegalStateException("Notato has not been started: call Notato.start in Application.onCreate.")
    }

    private inline fun withController(block: (Controller) -> Unit) {
        checkMain()
        val c = controller
        if (c == null) {
            Log.w(TAG, "Notato has not been started: call Notato.start in Application.onCreate.")
            return
        }
        block(c)
    }

    private fun checkMain() {
        check(Looper.myLooper() == Looper.getMainLooper()) { "Call Notato on the main thread." }
    }

    internal fun manifestConfig(context: Context): NotatoConfig? {
        val meta = runCatching {
            @Suppress("DEPRECATION")
            context.packageManager.getApplicationInfo(context.packageName, android.content.pm.PackageManager.GET_META_DATA).metaData
        }.getOrNull()
        val values = mutableMapOf<String, Any?>()
        meta?.keySet()?.filter { it.startsWith("notato.") }?.forEach { key ->
            @Suppress("DEPRECATION")
            values[key.removePrefix("notato.")] = meta.get(key)
        }
        values.putAll(systemProperties())
        return NotatoConfig.from(values)
    }

    private val propertyKeys = listOf(
        "project", "mode", "server", "token", "enabled", "author", "screenshots", "maskInputs", "showToolbar", "toolbarPosition",
        "shakeToToggle", "rememberRuntimeState", "captureLogs", "logLimit", "composeSourceInfo", "appName", "appVersion",
        "maxScreenshotScale",
    )

    /** `debug.notato.*` system properties (`adb shell setprop debug.notato.server http://localhost:4790`). */
    @SuppressLint("PrivateApi") // Read-only, and optional: without it, only the manifest and code configure Notato.
    private fun systemProperties(): Map<String, String> {
        val values = mutableMapOf<String, String>()
        val get = runCatching { Class.forName("android.os.SystemProperties").getMethod("get", String::class.java) }.getOrNull() ?: return values
        for (key in propertyKeys) {
            // Property names are limited in length and are case-sensitive; both spellings are read.
            for (name in listOf("debug.notato.$key", "debug.notato.${key.lowercase()}")) {
                val value = runCatching { get.invoke(null, name) as? String }.getOrNull()
                if (!value.isNullOrEmpty()) {
                    values[key] = if (value == "none") "" else value
                    break
                }
            }
        }
        return values
    }

    private fun withSystemProperties(config: NotatoConfig): NotatoConfig {
        val props = systemProperties()
        if (props.isEmpty()) return config
        val base = mutableMapOf<String, Any?>(
            "project" to config.project, "mode" to config.mode.name, "token" to config.token, "enabled" to config.enabled,
            "appName" to config.appName, "appVersion" to config.appVersion, "author" to config.author, "screenshots" to config.screenshots,
            "maskInputs" to config.maskInputs, "showToolbar" to config.showToolbar, "toolbarPosition" to config.toolbarPosition.name,
            "shakeToToggle" to config.shakeToToggle, "rememberRuntimeState" to config.rememberRuntimeState, "captureLogs" to config.captureLogs,
            "logLimit" to config.logLimit, "composeSourceInfo" to config.composeSourceInfo, "maxScreenshotScale" to config.maxScreenshotScale,
        )
        base["server"] = if (config.noServer) "" else config.server
        base.putAll(props)
        return NotatoConfig.from(base) ?: config
    }
}
