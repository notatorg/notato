package dev.notato.android

import java.net.URI
import java.net.URISyntaxException

/** Who annotates, and where the notes go. The same three modes as the web, MAUI and iOS SDKs. */
public enum class NotatoMode {
    /** The developer, live to a local `notato dev` server that your coding agent reads over MCP. */
    DEV,

    /** A tester. Notes are kept on the device and packaged as a zip, and uploaded when a server is set. */
    TEST,

    /** An AI agent driving the app. Like dev, and the app also takes `notato_annotate` requests. */
    AGENT,
}

/** The corner the toolbar starts in, until it is dragged: start is the left edge, end the right. */
public enum class ToolbarCorner { BOTTOM_END, BOTTOM_START, TOP_END, TOP_START }

/**
 * Settings for Notato. Set them in code, or (with no code at all) as `<meta-data android:name="notato.project" …>` in
 * the manifest, with `debug.notato.*` system properties over either (`adb shell setprop debug.notato.server …`).
 * Choices made at runtime (on or off, the toolbar, a name, a server typed in) are remembered on the device and win over
 * these until reset.
 */
public data class NotatoConfig(
    /** Project id on the server. Letters, digits and `. _ - @`, but not only dots. */
    val project: String,
    /** Who annotates, and where the notes go. */
    val mode: NotatoMode = NotatoMode.DEV,
    /** The server. Null means `notato dev` (localhost:4747) in dev and agent mode, and none in test mode. */
    val server: String? = null,
    /** Leave the server out entirely, even in dev mode: notes stay on the device. */
    val noServer: Boolean = false,
    /**
     * A project token (`notato_…`) for a shared `notato serve`. It is sent only to [server] (its scheme, host and port),
     * never to a server typed into the toolbar's settings.
     */
    val token: String? = null,
    /** Whether Notato is on when the app starts. `Notato.enable()` and `disable()` change it at runtime. */
    val enabled: Boolean = true,
    /** The app's name, recorded on every note. The app's label when null. */
    val appName: String? = null,
    /** The app's version, recorded on every note. Its version name and code when null. */
    val appVersion: String? = null,
    /** The name on this person's notes. They can change it in the toolbar's settings. */
    val author: String? = null,
    /** Take screenshots. A server that has them off wins either way. */
    val screenshots: Boolean = true,
    /** Cover text fields in screenshots. Null means on in test and agent mode. Password fields always are. */
    val maskInputs: Boolean? = null,
    /** Show the floating toolbar. Without it, the app can still drive Notato from code. */
    val showToolbar: Boolean = true,
    /** The corner the toolbar starts in. People can drag it; where they leave it is remembered. */
    val toolbarPosition: ToolbarCorner = ToolbarCorner.BOTTOM_END,
    /** Shaking the device shows or hides the toolbar. */
    val shakeToToggle: Boolean = true,
    /** Remember runtime choices across launches. */
    val rememberRuntimeState: Boolean = true,
    /** Attach the app's recent warnings and errors from logcat to each note. */
    val captureLogs: Boolean = true,
    /** The most log lines a note carries: the latest. */
    val logLimit: Int = 50,
    /**
     * Turn on Compose's inspection data (with the `notato-compose` artifact) so notes say which file, line and
     * composable an element was written in, as Android Studio's Layout Inspector does.
     */
    val composeSourceInfo: Boolean = true,
    /** The scale screenshots are stored at, at most, in pixels per dp. Phones are 2.6x to 3.5x; 2x is plenty. */
    val maxScreenshotScale: Double = 2.0,
) {
    public companion object {
        /** What `notato dev` listens on. On an emulator, `adb reverse tcp:4747 tcp:4747` makes it localhost there too. */
        public const val DEFAULT_SERVER: String = "http://localhost:4747"

        /** The server's own rule, with ASCII spelled out: Android's regex `\w` can take letters the server refuses. */
        private val projectId = Regex("^(?!\\.+$)[A-Za-z0-9_.@-]{1,128}$")

        /**
         * Why [url] cannot be a server address, said after the address (`is not an http(s) URL`), or null when it can:
         * http or https, a host, a port that is a number from 1 to 65535, and nothing after the path.
         */
        internal fun serverProblem(url: String): String? {
            val uri = try {
                URI(url)
            } catch (_: URISyntaxException) {
                return "is not a valid URL"
            }
            val scheme = uri.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") return "is not an http(s) URL"
            val authority = uri.rawAuthority ?: return "has no host"
            if (uri.host == null) {
                // URI reads `localhost:47o7` as a name it cannot split into a host and a port.
                val port = authority.substringAfterLast(':', "")
                return if (authority.contains(':') && port.any { !it.isDigit() }) "has a port that is not a number" else "has no valid host"
            }
            if (uri.port != -1 && uri.port !in 1..65535) return "has a port outside 1 to 65535"
            if (uri.rawQuery != null || uri.rawFragment != null) return "has a query or fragment; give only the server's address"
            return null
        }

        /**
         * Whether two server addresses are the same server: the same scheme, host (ignoring case) and port, a missing
         * port being the scheme's own (80, 443). The path does not matter. An address that cannot be read is no match.
         */
        internal fun sameServer(a: String, b: String): Boolean {
            fun origin(url: String): Triple<String, String, Int>? {
                val uri = try {
                    URI(url.trim())
                } catch (_: URISyntaxException) {
                    return null
                }
                val scheme = uri.scheme?.lowercase() ?: return null
                val host = uri.host?.lowercase()?.trimEnd('.')?.ifEmpty { null } ?: return null
                val port = when {
                    uri.port != -1 -> uri.port
                    scheme == "http" -> 80
                    scheme == "https" -> 443
                    else -> return null
                }
                return Triple(scheme, host, port)
            }
            val first = origin(a) ?: return false
            return first == origin(b)
        }

        /**
         * Builds a configuration from loose values (manifest meta-data, system properties), keys as in the README
         * (`project`, `mode`, `server`, …), compared without case. Null when there is no project.
         */
        public fun from(values: Map<String, Any?>): NotatoConfig? {
            val v = values.mapKeys { it.key.lowercase().replace("_", "").replace("-", "") }
            fun string(key: String) = v[key]?.toString()?.trim()
            fun bool(key: String): Boolean? = when (val raw = v[key]) {
                is Boolean -> raw
                null -> null
                else -> when (raw.toString().trim().lowercase()) {
                    "1", "true", "yes", "on" -> true
                    "0", "false", "no", "off" -> false
                    else -> null
                }
            }
            val project = string("project")?.ifEmpty { null } ?: return null
            val server = string("server")
            return NotatoConfig(
                project = project,
                mode = string("mode")?.let { m -> NotatoMode.entries.firstOrNull { it.name.equals(m, ignoreCase = true) } } ?: NotatoMode.DEV,
                server = server?.ifEmpty { null },
                noServer = server != null && server.isEmpty(),
                token = string("token")?.ifEmpty { null },
                enabled = bool("enabled") ?: true,
                appName = string("appname"),
                appVersion = string("appversion"),
                author = string("author"),
                screenshots = bool("screenshots") ?: true,
                maskInputs = bool("maskinputs"),
                showToolbar = bool("showtoolbar") ?: true,
                toolbarPosition = string("toolbarposition")?.let { p ->
                    ToolbarCorner.entries.firstOrNull { it.name.replace("_", "").equals(p.replace("_", ""), ignoreCase = true) }
                } ?: ToolbarCorner.BOTTOM_END,
                shakeToToggle = bool("shaketotoggle") ?: true,
                rememberRuntimeState = bool("rememberruntimestate") ?: true,
                captureLogs = bool("capturelogs") ?: true,
                logLimit = string("loglimit")?.toIntOrNull() ?: 50,
                composeSourceInfo = bool("composesourceinfo") ?: true,
                maxScreenshotScale = string("maxscreenshotscale")?.toDoubleOrNull() ?: 2.0,
            )
        }
    }

    /** The server notes go to, or null for none: [server], else `notato dev`'s outside test mode. */
    public val resolvedServer: String?
        get() = when {
            noServer -> null
            server != null -> server.trim().trimEnd('/')
            mode == NotatoMode.TEST -> null
            else -> DEFAULT_SERVER
        }

    /**
     * The project token to send to [url]: the configured one, but only to the configured server (the same scheme,
     * host and port). A server typed into the Settings sheet is someone's guess at an address, and never gets it.
     */
    internal fun tokenFor(url: String): String? {
        val token = token?.trim()?.ifEmpty { null } ?: return null
        val configured = resolvedServer ?: return null
        return token.takeIf { sameServer(url, configured) }
    }

    /** Whether text fields are covered: [maskInputs], else on outside dev mode. */
    public val resolvedMaskInputs: Boolean get() = maskInputs ?: (mode != NotatoMode.DEV)

    /** Why this configuration cannot be used, or null. */
    public val problem: String?
        get() {
            if (project.isEmpty()) return "Notato needs a project id: set notato.project in the manifest, or project in NotatoConfig."
            if (!projectId.matches(project)) return "Notato's project id \"$project\" may only use letters, digits and . _ - @ (at most 128, not only dots)."
            val url = resolvedServer
            if (url != null) serverProblem(url)?.let { return "Notato's server \"$url\" $it." }
            if (maxScreenshotScale !in 1.0..4.0) return "Notato's maxScreenshotScale must be between 1 and 4."
            return null
        }
}
