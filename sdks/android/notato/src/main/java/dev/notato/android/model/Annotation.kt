package dev.notato.android.model

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

// The wire shapes of @notato/schema (packages/schema/src/index.ts), the contract with the server. Enumerations travel
// as strings, so a value added to the schema later does not break reading what the server sends.

/**
 * What a note asks for ([Annotation.intent], [dev.notato.android.AnnotateOptions.intent]). `question` wants an answer,
 * not an edit. Named so as not to clash with `android.content.Intent`.
 */
public object NoteIntent {
    public const val FIX: String = "fix"
    public const val CHANGE: String = "change"
    public const val QUESTION: String = "question"
    public const val APPROVE: String = "approve"
    public const val VARIANTS: String = "variants"
}

/** How much a note matters ([Annotation.severity]). */
public object Severity {
    public const val BLOCKER: String = "blocker"
    public const val MAJOR: String = "major"
    public const val MINOR: String = "minor"
    public const val NIT: String = "nit"
}

/** open → acknowledged → resolved; a resolved change can be asked to be undone (revert_requested → reverted). */
public object Status {
    public const val OPEN: String = "open"
    public const val ACKNOWLEDGED: String = "acknowledged"
    public const val VARIANT_CHOSEN: String = "variant_chosen"
    public const val RESOLVED: String = "resolved"
    public const val REVERT_REQUESTED: String = "revert_requested"
    public const val REVERTED: String = "reverted"
    public const val DISMISSED: String = "dismissed"
}

/** Who wrote a note or a reply: a person, or an agent. */
@Serializable
public data class Author(
    /** `human` or `agent`. */
    val kind: String,
    val name: String? = null,
) {
    public companion object {
        public fun human(name: String?): Author = Author("human", name?.trim()?.ifEmpty { null })
        public fun agent(name: String?): Author = Author("agent", name?.trim()?.ifEmpty { null })
    }
}

/** A rectangle in dp from the top left of the window. */
@Serializable
public data class PageRect(val x: Double, val y: Double, val w: Double, val h: Double)

/** A screenshot: its content hash as its id, its type and size, and (in a bundle) its path in the zip. */
@Serializable
public data class AssetRef(
    val id: String,
    /** `image/png` or `image/webp`. */
    val mime: String,
    val w: Int,
    val h: Int,
    val path: String? = null,
)

/** Where an element is written: a path (or a file name) and the 1-based line and column. */
@Serializable
public data class SourceLocation(
    val file: String,
    val line: Int,
    val col: Int,
    /** Set when this is the nearest place around the element rather than the element itself. */
    val nearest: Boolean? = null,
)

/** The component an element is in: a composable written in the app, or a Fragment or Activity, and where it is written. */
@Serializable
public data class ComponentInfo(
    val name: String,
    val source: String? = null,
    /** The components around the element, outermost first. */
    val path: List<String>? = null,
)

/** Everything a note records about the element it is on, for the agent to find it in the code. */
@Serializable
public data class ElementIdentity(
    /** On Android, the screen and the element: `LoginFragment #sign_in` or `ProductList button:text("Add to cart")`. */
    val selector: String,
    /** The view's resource id name, or the composable's test tag. */
    val testId: String? = null,
    val role: String? = null,
    /** Content description, or the text a screen reader would read. */
    val name: String? = null,
    /** The view's class, or the kind of composable. */
    val tag: String,
    val classes: List<String>? = null,
    /** Visible text, at most 200 characters. */
    val text: String? = null,
    val source: SourceLocation? = null,
    val component: ComponentInfo? = null,
    val styles: Map<String, String>? = null,
    val ancestors: List<String>? = null,
    val platformId: String? = null,
)

/** One thing an agent did before it made a note (`notato_annotate`'s `steps`). */
@Serializable
public data class AgentStep(
    val action: String,
    val target: String? = null,
    val value: String? = null,
    val at: String,
)

/** One entry in a note's thread: a reply, or an automatic entry recording a change. */
@Serializable
public data class Reply(
    val id: String,
    val author: Author,
    val body: String,
    val createdAt: String,
    val automatic: Boolean? = null,
    /** A reply for the people on the thread, kept from the agent. Set by the person who writes it, when they send it. */
    val aside: Boolean? = null,
    /**
     * Only on the automatic entry that records someone turning People only on (`true`) or off (`false`) for the
     * note.
     */
    val peopleOnly: Boolean? = null,
)

/** The window's size in dp. */
@Serializable
public data class Viewport(val w: Double, val h: Double)

/** What a note was made on: the app and device, the window's size and density, and the SDK. */
@Serializable
public data class EnvironmentInfo(
    val userAgent: String,
    val viewport: Viewport,
    val dpr: Double,
    /** `web`, `maui`, `ios`, `android`, or a newer SDK's. */
    val platform: String,
    /** The package that made the note, and its version. Absent from notes made before 0.2. */
    val sdk: SdkInfo? = null,
)

/** The package that made a note, and its version. */
@Serializable
public data class SdkInfo(val name: String, val version: String)

/** What a note is about: the element (or an area), what is known of it, and where it was. */
@Serializable
public data class Target(
    /** `element`, `text`, `area` or `multi`. */
    val kind: String,
    val identity: List<ElementIdentity>,
    val rect: PageRect,
    val selectedText: String? = null,
)

/** A note's screenshots. */
@Serializable
public data class Screenshots(
    /** The whole window with the target outlined. */
    val full: AssetRef,
    val crop: AssetRef? = null,
)

/** A note: what was said, about what, where and by whom, with its screenshots, context, status and thread. */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
public data class Annotation(
    /** A ULID. */
    val id: String,
    val projectId: String,
    /** Null outside a bundle, and always written: the schema requires the key. */
    @EncodeDefault(EncodeDefault.Mode.ALWAYS) val bundleId: String? = null,
    val author: Author,
    val mode: String,
    val createdAt: String,
    val url: String,
    val route: String,
    val appName: String? = null,
    val appVersion: String? = null,
    val environment: EnvironmentInfo,
    val target: Target,
    val comment: String,
    val severity: String? = null,
    val intent: String? = null,
    val variants: JsonElement? = null,
    val screenshots: Screenshots? = null,
    val steps: List<AgentStep>? = null,
    /** Keyed by plugin id: `console`, `network`, `android`. The server never interprets it. */
    val context: Map<String, JsonElement> = emptyMap(),
    val status: String,
    val thread: List<Reply> = emptyList(),
    /**
     * People only: the note and its whole thread are between people, and never reach the agent. `true` when on, and
     * left out (null) when off. Anyone on the thread can turn it on or off; each change is recorded in the thread.
     */
    val peopleOnly: Boolean? = null,
)

/** A tester's notes packaged together (the zip's `annotations.json`). */
@Serializable
internal data class FeedbackBundle(
    val id: String,
    val projectId: String,
    val createdAt: String,
    val author: BundleAuthor,
    val appName: String? = null,
    val appVersion: String? = null,
    val annotations: List<Annotation>,
    val schemaVersion: Int = 1,
)

@Serializable
internal data class BundleAuthor(val name: String? = null)

/** An annotation as the server stores it, with the order it arrived in. */
@Serializable
internal data class StoredAnnotation(val seq: Long = 0, val annotation: Annotation)

// ---- server bodies ------------------------------------------------------------------------------------------------

/** One page of the list, oldest first: `next` is there when the page was full, and is the `afterSeq` of the next one. */
@Serializable
internal data class AnnotationList(val items: List<StoredAnnotation> = emptyList(), val next: Long? = null)

@Serializable
internal data class ServerConfig(val screenshots: Boolean = true)

@Serializable
internal data class ErrorBody(val error: String? = null)

@Serializable
internal data class ServerEventData(val id: String? = null, val projectId: String? = null, val annotation: Annotation? = null)

/** What an agent asks this app to annotate, relayed from `notato_annotate`. */
@Serializable
internal data class AnnotateRequest(val requestId: String, val args: Args) {
    @Serializable
    internal data class Args(
        val target: String,
        val comment: String,
        val severity: String? = null,
        val intent: String? = null,
        val steps: List<AgentStep>? = null,
        val author: String? = null,
    )
}

@Serializable
internal data class RelayResult(val ok: Boolean, val annotationId: String? = null, val error: String? = null)

@Serializable
internal data class StatusChange(val status: String, val note: String? = null, val author: Author? = null)

/** A reply; `aside` (true, or left out) keeps it from the agent. */
@Serializable
internal data class ReplyBody(val body: String, val author: Author? = null, val aside: Boolean? = null)

/** People only on or off, as a PATCH: only a person can change it, and the server records it in the thread. */
@Serializable
internal data class PeopleOnlyChange(val peopleOnly: Boolean, val author: Author? = null)

/** A log line, in the shape of the web SDK's `console` context. */
@Serializable
internal data class LogEntry(val level: String, val message: String, val at: String)

/** One HTTP request the app made, for [dev.notato.android.Notato.recordRequest]: the web SDK's `network` context. */
@Serializable
public data class NetworkEntry(
    /** `GET`, `POST`, … */
    val method: String,
    /** The address. Its query string and fragment are left out when it is recorded: they routinely carry tokens. */
    val url: String,
    /** The response's status code, or 0 when there was none. */
    val status: Int,
    val durationMs: Long,
    /** When it was made, as an ISO 8601 time in UTC (`2026-10-06T09:00:00.000Z`). */
    val at: String,
)

/** How Notato writes and reads JSON: nulls left out (the schema rejects them), unknown fields ignored. */
internal val NotatoJson: Json = Json {
    explicitNulls = false
    ignoreUnknownKeys = true
    encodeDefaults = true
}
