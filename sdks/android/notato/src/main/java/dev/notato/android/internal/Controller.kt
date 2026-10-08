package dev.notato.android.internal

import android.app.Activity
import android.app.Application
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.res.Configuration
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.view.ViewGroup
import androidx.core.content.FileProvider
import dev.notato.android.AnnotateOptions
import dev.notato.android.NotatoConfig
import dev.notato.android.NotatoConnection
import dev.notato.android.NotatoMode
import dev.notato.android.NotatoState
import dev.notato.android.ToolbarCorner
import dev.notato.android.inspect.Box
import dev.notato.android.inspect.Reading
import dev.notato.android.inspect.ScreenElement
import dev.notato.android.inspect.Selectors
import dev.notato.android.inspect.ViewInspector
import dev.notato.android.BuildConfig
import dev.notato.android.model.AgentStep
import dev.notato.android.model.Annotation
import dev.notato.android.model.AnnotateRequest
import dev.notato.android.model.Author
import dev.notato.android.model.ElementIdentity
import dev.notato.android.model.EnvironmentInfo
import dev.notato.android.model.LogEntry
import dev.notato.android.model.NetworkEntry
import dev.notato.android.model.PageRect
import dev.notato.android.model.SdkInfo
import dev.notato.android.model.NotatoJson
import dev.notato.android.model.RelayResult
import dev.notato.android.model.Status
import dev.notato.android.model.Target
import dev.notato.android.model.Viewport
import dev.notato.android.net.NotatoClient
import dev.notato.android.net.NotatoServerException
import dev.notato.android.overlay.ComposerSheet
import dev.notato.android.overlay.OverlayActions
import dev.notato.android.overlay.OverlayRoot
import dev.notato.android.overlay.PinDrawing
import dev.notato.android.overlay.SelectionDrawing
import dev.notato.android.overlay.SheetBuilder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.lang.ref.WeakReference
import java.util.Locale
import kotlin.math.abs
import kotlin.math.sqrt

internal const val TAG = "Notato"

/** What is selected, and the picture taken when it was. */
internal class Selection(
    /** The element and everything around it, innermost first; [index] is the one selected. */
    val chain: List<ScreenElement>,
    var index: Int,
    val all: List<ScreenElement>,
    val screen: CapturedScreen?,
) {
    val element: ScreenElement get() = chain[index]
}

/** Notato in one Activity. */
internal class Session(val activity: Activity, private val controller: Controller) : OverlayActions {
    var host: ViewGroup? = null
    var selection: Selection? = null
    var route: String = ""

    /** The overlay's frame count when the route was last worked out, and when that was. */
    var routeFrame = -1L
    var routeAt = 0L

    /** The last reading of the screen for the pins, indexed; the frame it was taken at, and when. */
    var scan: ScanIndex? = null
    var scanFrame = -1L
    var lastScan = 0L

    /** What the pins were last placed with: the frame of the reading used, and the notes' version. */
    var placedFrame = -1L
    var placedVersion = -1L

    // Last: the overlay draws itself as it is made, and asks this session for its state.
    val overlay = OverlayRoot(activity, this)

    /** Puts the overlay in the top window, moving it into a full-screen dialog while one shows. */
    fun attach() {
        val top = Windows.top(activity) ?: return
        if (top !== host) {
            (overlay.parent as? ViewGroup)?.removeView(overlay)
            top.addView(overlay, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            host = top
            overlay.requestApplyInsets()
        } else if (top.indexOfChild(overlay) != top.childCount - 1) {
            overlay.bringToFront()
        }
    }

    /** Drops the selection, and the picture taken for it. */
    fun dropSelection() {
        selection?.screen?.release()
        selection = null
    }

    fun detach() {
        dropSelection()
        overlay.hideKeyboard()
        (overlay.parent as? ViewGroup)?.removeView(overlay)
        host = null
    }

    /** The window root the app's content is drawn in: where picking and screenshots look. */
    val root: View? get() = host

    override val isAnnotating get() = controller.annotating
    override val isToolbarVisible get() = controller.toolbarVisible
    override val pinsVisible get() = controller.pinsVisible
    override val count get() = controller.recordsOnRoute(this).size
    override val connection get() = controller.connection
    override val toolbarFraction get() = controller.toolbarFraction
    override val toolbarDragged get() = controller.fold.position != null
    override val toolbarCollapsed get() = controller.fold.collapsed
    override val toolbarHeldRight get() = controller.fold.heldRight
    override val toolbarReturning get() = controller.fold.returning
    override fun dragToolbar(fraction: Pair<Float, Float>) = controller.dragToolbar(fraction)
    override fun keepToolbarAt(fraction: Pair<Float, Float>) = controller.fold.keep(fraction)

    override fun toggleAnnotating() = if (controller.annotating) controller.stopAnnotating() else controller.startAnnotating()
    override fun stopAnnotating() = controller.stopAnnotating()
    override fun pick(x: Float, y: Float) = controller.pick(this, x, y)
    override fun openMenu() = overlay.showSheet(SheetBuilder(controller, this).menu(), dim = true)
    override fun setToolbarCollapsed(collapsed: Boolean) = controller.setToolbarCollapsed(collapsed)
    override fun openPin(id: String) = controller.openPin(this, id)
    override fun sheetClosed(wasComposer: Boolean) {
        if (wasComposer) controller.cancelSelection(this)
    }
}

@Serializable
internal data class AndroidContext(
    val screen: String? = null,
    val components: List<String>? = null,
    val activity: String? = null,
    val composable: String? = null,
    val device: String,
    val android: String,
    val sdk: Int,
    val emulator: Boolean,
    val orientation: String,
    val nightMode: Boolean,
    val fontScale: Float,
    val density: Float,
    val locale: String,
    val packageName: String,
)

/** The running Notato: the overlay in each Activity, the notes, and the connection to the server. */
internal class Controller(val app: Application, var config: NotatoConfig) : Application.ActivityLifecycleCallbacks, SensorEventListener {
    /** Nothing Notato does may take the app down: whatever escapes one of its coroutines is logged, not thrown. */
    val scope = CoroutineScope(
        SupervisorJob() + Dispatchers.Main.immediate + CoroutineExceptionHandler { _, error ->
            Log.e(TAG, "Notato hit a problem it did not expect; the app carries on.", error)
        },
    )
    private val handler = Handler(Looper.getMainLooper())
    var state = RuntimeState(app, config.rememberRuntimeState)
    var fold = ToolbarFold(state, config.toolbarPosition)
        private set
    var store = LocalStore(File(app.filesDir, "notato"), config.project)
        private set
    val notes = NoteBook()

    /** Counts changes to [notes], so a list from the server can tell what changed here after it was asked for. */
    private var clock = 0L

    /**
     * Notes deleted (here, or by an event) and when, on [clock]: a list asked for before then does not bring them back,
     * and an event about one (a note deleted here while it was being sent arriving) does not either.
     */
    private val deletions = object : LinkedHashMap<String, Long>() {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Long>?) = size > 256
    }

    private fun touch(record: NoteRecord) {
        record.touched = ++clock
        notes.changed()
    }

    private val sessions = mutableMapOf<Activity, Session>()
    private var resumed: WeakReference<Activity>? = null
    private var client: NotatoClient? = null
    private var syncJob: Job? = null
    private var loaded = false
    private val startedAt = System.currentTimeMillis()
    val network = ArrayDeque<NetworkEntry>()

    val stateFlow = MutableStateFlow(NotatoState())

    var enabled = false
        private set
    var toolbarVisible = true
        private set
    /** Annotating or selecting, from the toolbar, the menu or code: a folded toolbar opens for it, and folds again after. */
    var annotating = false
        private set(value) {
            if (field == value) return
            field = value
            if (fold.annotating(value)) foldChanged()
        }
    var connection = NotatoConnection.DISABLED
        private set
    var connectionDetail: String? = null
        private set

    /**
     * The last try at the server failed (OFFLINE, or REFUSED), and why; null once it connects. Kept while it tries
     * again, so the menu's banner stays up through the backoff's own tries rather than flickering.
     */
    var failure: NotatoConnection? = null
        private set
    var failureDetail: String? = null
        private set

    /** Retry was pressed in the menu, and that try has not finished yet. */
    var retrying = false
        private set
    var serverScreenshots = true
        private set
    var problem: String? = config.problem
        private set

    val mode get() = config.mode
    val server: String? get() = state.server ?: config.resolvedServer
    val hasServer get() = server != null && mode != NotatoMode.TEST
    val authorName get() = state.author ?: config.author
    val serverOverride get() = state.server
    val screenshotsWanted get() = state.screenshots ?: config.screenshots
    private val screenshotsOn get() = screenshotsWanted && serverScreenshots
    val pinsVisible get() = state.pinsVisible ?: true

    val toolbarFraction: Pair<Float, Float>
        get() = fold.position ?: when (config.toolbarPosition) {
            // Bottom corners start a little up, clear of a navigation bar; people drag it where they like.
            ToolbarCorner.BOTTOM_START -> 0f to 0.86f
            ToolbarCorner.TOP_END -> 1f to 0.06f
            ToolbarCorner.TOP_START -> 0f to 0.06f
            ToolbarCorner.BOTTOM_END -> 1f to 0.86f
        }

    /** Dragged there by hand: remembered, and the side it folds toward is worked out again from there. */
    fun dragToolbar(fraction: Pair<Float, Float>) {
        fold.moved(fraction)
        render()
    }

    /** Folds the toolbar into its round button, or opens it, by hand. */
    fun setToolbarCollapsed(collapsed: Boolean) {
        if (fold.set(collapsed)) foldChanged()
        render()
    }

    /** Folding closes what was opened from the toolbar's buttons: the menu, and what was opened from it. */
    private fun foldChanged() {
        if (!fold.collapsed) return
        for (session in sessions.values) if (session.overlay.sheetFromToolbar) session.overlay.closeSheet()
    }

    // ---- start-up -----------------------------------------------------------------------------------------------------

    fun start() {
        app.registerActivityLifecycleCallbacks(this)
        problem?.let {
            Log.e(TAG, "$it Notato stays off.")
            return
        }
        toolbarVisible = state.toolbarVisible ?: config.showToolbar
        setEnabled(state.enabled ?: config.enabled, remember = false)
    }

    fun reconfigure(next: NotatoConfig) {
        val wasEnabled = enabled
        setEnabled(false, remember = false)
        if (next.project != config.project) {
            // Another project: its own notes, on this device and on the server.
            notes.clear()
            loaded = false
            store = LocalStore(File(app.filesDir, "notato"), next.project)
        }
        config = next
        state = RuntimeState(app, next.rememberRuntimeState)
        fold = ToolbarFold(state, next.toolbarPosition)
        problem = next.problem
        if (problem != null) {
            Log.e(TAG, "$problem Notato stays off.")
            return
        }
        toolbarVisible = state.toolbarVisible ?: next.showToolbar
        setEnabled(state.enabled ?: next.enabled || wasEnabled && state.enabled == null && next.enabled, remember = false)
    }

    fun setEnabled(on: Boolean, remember: Boolean) {
        if (on && problem != null) {
            Log.e(TAG, "$problem Notato stays off.")
            return
        }
        if (remember) state.enabled = on
        if (on == enabled) return publish()
        enabled = on
        if (on) {
            scope.launch { loadLocal() }
            resumed?.get()?.let { session(it).attach() }
            restartSync()
            updateWork()
        } else {
            annotating = false
            syncJob?.cancel()
            syncJob = null
            updateWork()
            for (session in sessions.values) session.detach()
            sessions.clear()
            connection = NotatoConnection.DISABLED
            connectionDetail = null
        }
        publish()
    }

    fun setToolbar(visible: Boolean) {
        toolbarVisible = visible
        state.toolbarVisible = visible
        if (!visible) stopAnnotating()
        publish()
    }

    fun startAnnotating() {
        if (!enabled) return
        annotating = true
        publish()
    }

    fun stopAnnotating() {
        annotating = false
        for (session in sessions.values) {
            session.dropSelection()
            session.overlay.showSelection(null)
            if (session.overlay.sheet is ComposerSheet) session.overlay.closeSheet()
        }
        publish()
    }

    fun togglePins() {
        state.pinsVisible = !pinsVisible
        render()
    }

    fun resetRuntimeState() {
        state.reset()
        fold = ToolbarFold(state, config.toolbarPosition)
        toolbarVisible = config.showToolbar
        setEnabled(config.enabled, remember = false)
        restartSync()
        publish()
    }

    private fun session(activity: Activity): Session = sessions.getOrPut(activity) { Session(activity, this) }

    private fun currentSession(): Session? = resumed?.get()?.let { sessions[it] }

    // ---- activities ---------------------------------------------------------------------------------------------------

    override fun onActivityResumed(activity: Activity) {
        resumed = WeakReference(activity)
        // One started before Notato was: it is showing all the same.
        if (startedActivities == 0) startedActivities = 1
        updateWork()
        if (enabled) session(activity).apply { attach(); overlay.render() }
    }

    override fun onActivityStarted(activity: Activity) {
        startedActivities++
        updateWork()
    }

    override fun onActivityStopped(activity: Activity) {
        startedActivities = (startedActivities - 1).coerceAtLeast(0)
        updateWork()
    }

    override fun onActivityDestroyed(activity: Activity) {
        sessions.remove(activity)?.detach()
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

    // ---- the overlay's rhythm: pins follow their elements ---------------------------------------------------------------

    /** Activities started and not stopped: none means the app is in the background. */
    private var startedActivities = 0

    /** Whether the tick and the shake detector are running: only while Notato is on and the app is in the foreground. */
    private var working = false

    private fun updateWork() {
        val want = enabled && startedActivities > 0
        if (want == working) return
        working = want
        if (want) {
            startShake()
            handler.post(tick)
        } else {
            // In the background nothing is on screen to follow, and a shake in a pocket must not toggle the toolbar.
            stopShake()
            handler.removeCallbacks(tick)
        }
    }

    /** The last thing the tick tripped over, so a problem that repeats every tick is logged once. */
    private var tickProblem: String? = null

    private val tick = object : Runnable {
        override fun run() {
            if (!working) return
            // The tick runs on the app's own main thread: whatever Notato trips over reading the screen must not reach the app.
            try {
                currentSession()?.let { session ->
                    session.attach()
                    updateRoute(session)
                    if (pinsVisible) {
                        placePins(session)
                    } else {
                        session.overlay.showPins(emptyList())
                        session.placedFrame = -1
                    }
                    session.selection?.let { session.overlay.showSelection(drawing(it)) }
                }
                tickProblem = null
            } catch (error: Exception) {
                val problem = "${error::class.java.name}: ${error.message}"
                if (problem != tickProblem) {
                    tickProblem = problem
                    Log.e(TAG, "Notato could not update its pins; the app carries on.", error)
                }
            }
            handler.postDelayed(this, 250)
        }
    }

    // ---- what is worked out from the notes: once per change to them, not on every frame or render -------------------

    private var groupedVersion = -1L
    private var byRoute: Map<String, List<Pair<Int, NoteRecord>>> = emptyMap()
    private var waiting = 0

    private fun regroup() {
        if (groupedVersion == notes.version) return
        val groups = HashMap<String, MutableList<NoteRecord>>()
        var pending = 0
        for (record in notes.all) {
            groups.getOrPut(record.annotation.route) { ArrayList() } += record
            if (record.pending) pending++
        }
        val order = compareBy<NoteRecord>({ it.annotation.createdAt }, { it.annotation.id })
        byRoute = groups.mapValues { (_, list) -> list.sortedWith(order).mapIndexed { index, record -> index + 1 to record } }
        waiting = pending
        groupedVersion = notes.version
    }

    /** Notes made here the server does not have yet (in test mode: not packaged yet). */
    val pendingCount: Int
        get() {
            regroup()
            return waiting
        }

    /** The notes on a screen, oldest first, numbered as their pins are. */
    fun notesOn(route: String): List<Pair<Int, NoteRecord>> {
        regroup()
        return byRoute[route].orEmpty()
    }

    fun recordsOnRoute(session: Session): List<Pair<Int, NoteRecord>> = notesOn(session.route.ifEmpty { routeOf(session) })

    /** The ids of the notes on the session's screen that have a pin (see [pinned]). */
    fun pinnedOn(session: Session): Set<String> = pinned(recordsOnRoute(session)).mapTo(HashSet()) { it.second.annotation.id }

    /**
     * Works the route out again when the screen may have changed: after the window has drawn, once it has been still
     * for a quarter of a second (or each second while it keeps drawing). A screen that is still costs nothing.
     */
    private fun updateRoute(session: Session) {
        val overlay = session.overlay
        val now = SystemClock.uptimeMillis()
        val due = session.route.isEmpty() ||
            overlay.frames != session.routeFrame && (now - overlay.lastFrameAt >= 250 || now - session.routeAt >= 1000)
        if (!due) return
        session.routeFrame = overlay.frames
        session.routeAt = now
        val route = routeOf(session)
        if (route != session.route) {
            session.route = route
            session.scan = null
            session.placedFrame = -1
            overlay.render()
        }
    }

    /**
     * Puts the pins where their elements are now: the newest [MAX_PINS] of this screen's notes made on Android. When
     * the window has drawn nothing since they were placed and no note changed, they are where they were and nothing is
     * worked out. The screen is read at most twice a second, and only once it has drawn since the last reading.
     */
    private fun placePins(session: Session) {
        val overlay = session.overlay
        val frames = overlay.frames
        if (session.placedFrame == frames && session.placedVersion == notes.version) return
        val shown = pinned(recordsOnRoute(session))
        val root = session.root
        if (shown.isEmpty() || root == null) {
            overlay.showPins(emptyList())
            session.placedFrame = frames
            session.placedVersion = notes.version
            return
        }
        val now = SystemClock.uptimeMillis()
        val reading = session.scan?.takeIf { session.scanFrame == frames || now - session.lastScan < 500 }
            ?: ScanIndex(ViewInspector.elements(root, config.resolvedMaskInputs, lite = true)).also {
                session.scan = it
                session.scanFrame = frames
                session.lastScan = now
            }
        val density = root.resources.displayMetrics.density
        overlay.showPins(
            shown.map { (number, record) ->
                val a = record.annotation
                val found = liveBox(record) ?: record.selector()?.let { reading.first(it)?.bounds }
                val r = a.target.rect
                val stored = Box((r.x * density).toFloat(), (r.y * density).toFloat(), ((r.x + r.w) * density).toFloat(), ((r.y + r.h) * density).toFloat())
                PinDrawing(a.id, number, a.status, found ?: stored, found == null, record.pending)
            },
        )
        // A reading older than the last frame: placed again on the next tick, and read again once it may be.
        session.placedFrame = session.scanFrame
        session.placedVersion = notes.version
    }

    /**
     * Where the view a note was made on is, while it is on screen and still shows what the note is about. A list's
     * recycled row shows another item: the reference is dropped and the note's selector finds it from then on.
     */
    private fun liveBox(record: NoteRecord): Box? {
        val view = record.view?.get() ?: return null
        if (!view.isAttachedToWindow || !view.isShown) return null
        val now = ViewInspector.describe(view, config.resolvedMaskInputs, Reading(lite = true))
        if (record.viewKey != ViewKey(now.identifier, now.words)) {
            record.view = null
            return null
        }
        return now.bounds
    }

    // ---- routes ----------------------------------------------------------------------------------------------------

    /** The Activity, its Fragments, and the screen composable showing: `/MainActivity/ProductListScreen`. */
    fun routeOf(session: Session): String {
        val activity = session.activity.javaClass.simpleName
        val root = session.root ?: return "/$activity"
        // The View in the middle of the window says which Fragment shows; a ComposeView says which screen composable.
        val (inside, screen) = ViewInspector.screenAt(root, root.width / 2f, root.height / 2f)
        val parts = mutableListOf(activity)
        parts += inside
        screen?.let { if (it !in parts) parts += it }
        ViewInspector.providedScreen(root)?.let { if (it !in parts) parts += it }
        return "/" + parts.joinToString("/")
    }

    // ---- picking ---------------------------------------------------------------------------------------------------

    fun pick(session: Session, x: Float, y: Float) {
        val root = session.root ?: return
        val chain = ViewInspector.chainAt(root, x, y, config.resolvedMaskInputs).ifEmpty {
            val d = root.resources.displayMetrics.density
            listOf(ScreenElement("area", null, null, null, null, "Area", Box(x - 32 * d, y - 32 * d, x + 32 * d, y + 32 * d)))
        }
        val existing = session.selection
        if (existing != null) {
            select(session, Selection(chain, 0, existing.all, existing.screen))
            return
        }
        scope.launch {
            val (screen, all) = captureThenScan({ picture(session, root) }) { ViewInspector.elements(root, config.resolvedMaskInputs) }
            select(session, Selection(chain, 0, all, screen))
        }
    }

    /** A picture of the session's window for a note, when screenshots are on (and [wanted]). */
    private suspend fun picture(session: Session, root: View, wanted: Boolean = true): CapturedScreen? =
        if (wanted && screenshotsOn) Windows.capture(session.activity, root, session.overlay) else null

    private fun drawing(selection: Selection): SelectionDrawing {
        val e = selection.element
        var title = e.control + (e.identifier?.let { " #$it" } ?: "")
        // A private element shows no words (it has none): only what it is and its id.
        e.words?.takeIf { e.kind != "area" && !e.isMasked }?.let { title += " “${if (it.length > 28) it.take(27) + "…" else it}”" }
        return SelectionDrawing(listOf(e.bounds), title)
    }

    private fun select(session: Session, selection: Selection) {
        // Another picture than the one this selection keeps (a second tap before the first's picture came): its memory goes back.
        session.selection?.screen?.takeIf { it !== selection.screen }?.release()
        session.selection = selection
        val drawing = drawing(selection)
        session.overlay.showSelection(drawing)
        val e = selection.element
        val subtitle = listOfNotNull(
            e.screen?.let { "in $it" },
            e.source?.let { "${it.file.substringAfterLast('/')}:${it.line}${if (it.nearest == true) " (around it)" else ""}" }
                ?: e.component?.source?.substringAfterLast('/'),
        ).joinToString(" · ").ifEmpty { null }
        val existing = session.overlay.sheet as? ComposerSheet
        if (existing != null) {
            existing.setTarget(drawing.title, subtitle)
        } else {
            val root = session.root
            val atTop = root != null && e.bounds.top + e.bounds.height / 2 > root.height / 2
            session.overlay.showSheet(
                ComposerSheet(
                    session.overlay.ui, drawing.title, subtitle, screenshotsOff = !screenshotsOn,
                    onParent = { selectParent(session) },
                    onCancel = { session.overlay.closeSheet() },
                    onSend = { comment, intent, severity, peopleOnly -> submit(session, comment, intent, severity, peopleOnly) },
                    launch = { block -> scope.launch { block() } },
                ),
                dim = false, atTop = atTop,
            )
        }
        annotating = true
        session.overlay.render()
    }

    fun selectParent(session: Session) {
        val selection = session.selection ?: return
        val current = selection.element.bounds
        val next = (selection.index + 1 until selection.chain.size).firstOrNull { selection.chain[it].bounds.area > current.area * 1.02f }
        if (next == null) {
            session.overlay.toast("That is the whole screen.")
            return
        }
        selection.index = next
        select(session, selection)
    }

    fun cancelSelection(session: Session) {
        session.dropSelection()
        session.overlay.showSelection(null)
        annotating = false
        publish()
    }

    fun openPin(session: Session, id: String) {
        val list = recordsOnRoute(session)
        val found = list.firstOrNull { it.second.annotation.id == id }
        val record = found?.second ?: notes[id] ?: return
        session.overlay.showSheet(SheetBuilder(this, session).pin(record, found?.first ?: 0), dim = true)
    }

    // ---- making notes --------------------------------------------------------------------------------------------

    suspend fun submit(session: Session, comment: String, intent: String?, severity: String?, peopleOnly: Boolean): String? {
        val selection = session.selection ?: return "Select something first."
        val record = create(session, selection, comment, intent, severity, Author.human(authorName), mode.name.lowercase(), null, peopleOnly)
        session.selection = null
        session.overlay.showSelection(null)
        session.overlay.closeSheet()
        annotating = false
        publish()
        val problem = send(record).message
        session.overlay.toast(problem ?: if (hasServer) "Sent" else "Saved on this device. Package it from the menu.")
        return null
    }

    /** What screenshots cover: private elements (and all in them), secure fields, and text fields when inputs are masked. */
    private fun maskBoxes(selection: Selection): List<Box> =
        (selection.all + selection.element).filter { it.isCovered(config.resolvedMaskInputs) }.map { it.bounds }.distinct()

    /**
     * Makes a note about the selected element and keeps it on the device (its screenshots as files), ready to send. The
     * selection's picture is done with once the screenshots are made from it, and is let go of here whatever happens.
     */
    private suspend fun create(
        session: Session, selection: Selection, comment: String, intent: String?, severity: String?, author: Author, mode: String, steps: List<AgentStep>?,
        peopleOnly: Boolean = false,
    ): NoteRecord {
        try {
            return make(session, selection, comment, intent, severity, author, mode, steps, peopleOnly)
        } finally {
            // Several megabytes at full resolution: back now, not when the collector gets round to it.
            selection.screen?.release()
        }
    }

    private suspend fun make(
        session: Session, selection: Selection, comment: String, intent: String?, severity: String?, author: Author, mode: String, steps: List<AgentStep>?,
        peopleOnly: Boolean,
    ): NoteRecord {
        val root = session.root
        val density = root?.resources?.displayMetrics?.density ?: 1f
        val element = selection.element
        val route = routeOf(session)
        val pin = notesOn(route).size + 1
        val shots = selection.screen?.takeIf { screenshotsOn }?.let { screen ->
            screen.use {
                withContext(Dispatchers.Default) {
                    ScreenshotComposer.compose(screen, listOf(element.bounds), pin, maskBoxes(selection), config.maxScreenshotScale)
                }
            }
        }
        val context = linkedMapOf<String, JsonElement>(
            "android" to NotatoJson.encodeToJsonElement(AndroidContext.serializer(), deviceContext(session, element)),
            "screenshot" to buildJsonObject { put("pin", pin) },
        )
        if (config.captureLogs) {
            val logs = withContext(Dispatchers.IO) { LogRecorder.recent(config.logLimit, startedAt) }
            if (logs.isNotEmpty()) context["console"] = NotatoJson.encodeToJsonElement(ListSerializer(LogEntry.serializer()), logs)
        }
        if (network.isNotEmpty()) context["network"] = NotatoJson.encodeToJsonElement(ListSerializer(NetworkEntry.serializer()), network.toList())
        fun round(px: Float) = Math.round(px / density * 100) / 100.0
        var annotation = Annotation(
            id = Ulid.make(),
            projectId = config.project,
            author = author,
            mode = mode,
            createdAt = Time.iso(),
            url = "android://${app.packageName}$route",
            route = route,
            appName = appName(),
            appVersion = appVersion(),
            environment = EnvironmentInfo(userAgent(), Viewport(round((root?.width ?: 0).toFloat()), round((root?.height ?: 0).toFloat())), density.toDouble(), "android", SdkInfo("dev.notato:notato-android", BuildConfig.NOTATO_VERSION)),
            target = Target(
                kind = if (element.kind == "area") "area" else "element",
                identity = listOf(identity(element, selection.all)),
                rect = PageRect(round(element.bounds.left), round(element.bounds.top), round(element.bounds.width), round(element.bounds.height)),
            ),
            comment = comment.trim(),
            severity = severity,
            intent = intent,
            screenshots = shots?.refs,
            steps = steps,
            context = context,
            status = Status.OPEN,
            peopleOnly = peopleOnly.takeIf { it },
        )
        // On the device before anything else: the screenshots are written out and only their files are kept.
        val store = store
        val draft = annotation
        val files = withContext(Dispatchers.IO) {
            try {
                store.save(draft, shots?.assets ?: emptyMap())
            } catch (error: IOException) {
                Log.w(TAG, "Notato could not keep a note on the device: it is sent without its screenshots, and not kept if the app stops first.", error)
                null
            }
        }
        if (files == null) annotation = annotation.copy(screenshots = null)
        val record = NoteRecord(annotation, pending = true, mine = true, assets = files ?: emptyMap())
        (element.ref?.get() as? View)?.let {
            record.view = WeakReference(it)
            record.viewKey = ViewKey(element.identifier, element.words)
        }
        touch(record)
        notes.add(record)
        publish()
        return record
    }

    private fun identity(e: ScreenElement, all: List<ScreenElement>): ElementIdentity = ElementIdentity(
        selector = Selectors.make(e, all, e.screen),
        testId = e.identifier,
        role = e.role,
        name = e.label.takeUnless { e.isMasked },
        tag = e.control,
        text = e.text.takeUnless { e.isMasked },
        source = e.source,
        component = e.component,
        styles = e.styles,
        ancestors = e.ancestors,
        platformId = e.identifier,
    )

    private fun appName(): String = config.appName ?: app.applicationInfo.loadLabel(app.packageManager).toString()

    private fun appVersion(): String? = config.appVersion ?: runCatching {
        val info = app.packageManager.getPackageInfo(app.packageName, 0)
        val code = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
        "${info.versionName} ($code)"
    }.getOrNull()

    private val emulator get() = Build.FINGERPRINT.contains("generic") || Build.FINGERPRINT.contains("emulator") || Build.MODEL.contains("sdk_gphone") || Build.HARDWARE.contains("ranchu")

    private fun userAgent() = "${appName()}/${appVersion() ?: ""} (Android ${Build.VERSION.RELEASE}; ${Build.MANUFACTURER} ${Build.MODEL}${if (emulator) "; emulator" else ""}) Android View"

    private fun deviceContext(session: Session, element: ScreenElement): AndroidContext {
        val configuration = session.activity.resources.configuration
        return AndroidContext(
            screen = element.screen,
            components = element.component?.path,
            activity = session.activity.javaClass.name,
            composable = element.component?.name?.takeIf { element.kind == "compose" },
            device = "${Build.MANUFACTURER} ${Build.MODEL}",
            android = Build.VERSION.RELEASE,
            sdk = Build.VERSION.SDK_INT,
            emulator = emulator,
            orientation = if (configuration.orientation == Configuration.ORIENTATION_LANDSCAPE) "landscape" else "portrait",
            nightMode = (configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES,
            fontScale = configuration.fontScale,
            density = session.activity.resources.displayMetrics.density,
            locale = Locale.getDefault().toLanguageTag(),
            packageName = app.packageName,
        )
    }

    /** Makes a note about the element a selector finds on screen, as a person or (with an agent name) an agent. */
    suspend fun annotate(selector: String, comment: String, options: AnnotateOptions): Annotation {
        val session = currentSession() ?: throw IllegalStateException("Notato is off, or no activity is showing.")
        val root = session.root ?: throw IllegalStateException("The activity has no window yet.")
        checkNote(comment, options)
        val parsed = try {
            Selectors.parse(selector)
        } catch (error: Selectors.SelectorException) {
            throw IllegalArgumentException(error.message)
        }
        val (screen, all) = captureThenScan({ picture(session, root, options.screenshot) }) { ViewInspector.elements(root, config.resolvedMaskInputs) }
        val found = Selectors.query(parsed, all).firstOrNull() ?: run {
            screen?.release()
            throw IllegalArgumentException(
                "no element on the screen matches \"$selector\" (the app is on ${routeOf(session)}). Android selectors look like #resource_id, " +
                    "button:text(\"Sign in\") or text:text(\"£89\"):nth(2).",
            )
        }
        return annotate(session, found, all, screen, comment, options)
    }

    suspend fun annotate(view: View, comment: String, options: AnnotateOptions): Annotation {
        val session = sessions.values.firstOrNull { it.root === view.rootView } ?: currentSession() ?: throw IllegalStateException("Notato is off.")
        val root = session.root ?: throw IllegalStateException("The activity has no window yet.")
        checkNote(comment, options)
        val (screen, all) = captureThenScan({ picture(session, root, options.screenshot) }) { ViewInspector.elements(root, config.resolvedMaskInputs) }
        return annotate(session, ViewInspector.describe(view, config.resolvedMaskInputs), all, screen, comment, options)
    }

    /** What is wrong with a note made from code, found before any picture is taken. */
    private fun checkNote(comment: String, options: AnnotateOptions) {
        if (comment.isBlank()) throw IllegalArgumentException("A note needs a comment.")
        if (options.peopleOnly && options.agentName != null) {
            throw IllegalArgumentException("Only a person's note can be People only: leave agentName out.")
        }
    }

    /**
     * The full description of an element found in the list: listing skips the costly parts (where a composable is
     * written), so it is described again by picking at its centre.
     */
    private fun enrich(root: View, element: ScreenElement): ScreenElement {
        if (element.kind != "compose" || element.source != null) return element
        val b = element.bounds
        return ViewInspector.chainAt(root, (b.left + b.right) / 2, (b.top + b.bottom) / 2, config.resolvedMaskInputs)
            .firstOrNull { Selectors.same(it, element) } ?: element
    }

    /** Files the note: [all] and [screen] were read in that order (the picture first), just before. */
    private suspend fun annotate(
        session: Session, found: ScreenElement, all: List<ScreenElement>, screen: CapturedScreen?, comment: String, options: AnnotateOptions,
    ): Annotation {
        val root = session.root ?: run {
            screen?.release()
            throw IllegalStateException("The activity has no window any more.")
        }
        val element = enrich(root, found)
        val author = options.agentName?.let { Author.agent(it) } ?: Author.human(authorName)
        val record = create(session, Selection(listOf(element), 0, all, screen), comment, options.intent, options.severity, author,
            if (options.agentName != null) "agent" else mode.name.lowercase(), options.steps, options.peopleOnly)
        send(record)
        return record.annotation
    }

    fun select(selector: String) {
        val session = currentSession() ?: throw IllegalStateException("Notato is off, or no activity is showing.")
        val root = session.root ?: return
        val parsed = Selectors.parse(selector)
        // Looked for now, so a selector that finds nothing fails here; looked for again once the picture is taken.
        val found = Selectors.query(parsed, ViewInspector.elements(root, config.resolvedMaskInputs)).firstOrNull()
            ?: throw IllegalArgumentException("No element on the screen matches \"$selector\".")
        selectElement(session, found) { all -> Selectors.query(parsed, all).firstOrNull() }
    }

    fun select(view: View) {
        val session = sessions.values.firstOrNull { it.root === view.rootView } ?: currentSession() ?: throw IllegalStateException("Notato is off.")
        selectElement(session, null) { ViewInspector.describe(view, config.resolvedMaskInputs) }
    }

    /**
     * Selects an element as a tap would: the picture is taken first and the screen read after it, so what is covered in
     * the picture is where it was then. [find] finds the element in that reading ([before] when it has gone meanwhile).
     */
    private fun selectElement(session: Session, before: ScreenElement?, find: (List<ScreenElement>) -> ScreenElement?) {
        val root = session.root ?: return
        annotating = true
        scope.launch {
            val (screen, all) = captureThenScan({ picture(session, root) }) { ViewInspector.elements(root, config.resolvedMaskInputs) }
            val found = find(all) ?: before
            if (found == null) {
                screen?.release()
                annotating = false
                publish()
                return@launch
            }
            val element = enrich(root, found)
            val bounds = element.bounds
            val chain = listOf(element) + ViewInspector.chainAt(root, bounds.left + bounds.width / 2, bounds.top + bounds.height / 2, config.resolvedMaskInputs)
                .filter { it.bounds.area > bounds.area * 1.02f }
            select(session, Selection(chain, 0, all, screen))
        }
    }

    // ---- sending ----------------------------------------------------------------------------------------------------

    /** How sending a note went, and what to tell the person (null: nothing to say). */
    class SendResult(val outcome: SendOutcome, val message: String?)

    /**
     * Sends one note now. Whatever goes wrong is told, never thrown. A note is never posted twice at once: one already
     * on its way is left to that send, which says how it went.
     */
    suspend fun send(record: NoteRecord): SendResult {
        if (!record.pending || record.deletedHere || record.sending) return SendResult(SendOutcome.SENT, null)
        if (!hasServer) return SendResult(SendOutcome.HELD, null)
        val client = client ?: return SendResult(SendOutcome.HELD, "Saved. It's sent when the server can be reached.")
        val id = record.annotation.id
        val store = store
        record.sending = true
        val stored = try {
            client.post(record.annotation, record.assets ?: emptyMap())
        } catch (error: CancellationException) {
            throw error
        } catch (error: NotatoServerException) {
            val outcome = outcomeOf(error)
            return when {
                outcome == SendOutcome.REFUSED -> {
                    record.error = error.message
                    record.held = null
                    Log.w(TAG, "The Notato server refused a note: ${error.message}")
                    publish()
                    SendResult(outcome, "The server refused it: ${error.message}")
                }
                error.status != 0 -> {
                    // The server is there but not taking it now (a project it does not have, a token it does not
                    // know): what it said goes on the note, which stays queued for the next connect.
                    record.held = error.message
                    publish()
                    SendResult(outcome, "Saved, not sent: ${error.message}")
                }
                else -> SendResult(outcome, "Saved. It's sent when the server can be reached.")
            }
        } catch (error: Exception) {
            Log.w(TAG, "Notato could not send a note", error)
            return SendResult(SendOutcome.HELD, "Saved. It's sent when the server can be reached.")
        } finally {
            record.sending = false
        }
        if (record.deletedHere) {
            // Deleted here while it was on its way: the server has it now, so it is deleted there too.
            try {
                client.delete(id)
            } catch (error: NotatoServerException) {
                Log.w(TAG, "Notato could not delete a note on the server that was deleted here: ${error.message}")
            }
            return SendResult(SendOutcome.SENT, null)
        }
        // Only while it still waits: an event can bring the server's copy first, with changes newer than this answer.
        val local = record.annotation
        if (notes.posted(record, stored.annotation, ::touch)) {
            keepPeopleOnly(record, local, stored.annotation)
            withContext(Dispatchers.IO) { store.remove(id) }
        }
        publish()
        return SendResult(SendOutcome.SENT, null)
    }

    /** Sends what is queued, oldest first: one refused note never holds up the rest. */
    private suspend fun flush() = sendQueue(notes.queue()) { send(it).outcome }

    private suspend fun loadLocal() {
        if (loaded) return
        loaded = true
        val store = store
        val items = withContext(Dispatchers.IO) { store.load() }
        // Reconfigured for another project while this one's notes were read: they are not that project's.
        if (store !== this.store) return
        for (item in items) {
            val id = item.annotation.id
            if (id !in notes && id !in deletions) notes.add(NoteRecord(item.annotation, pending = true, mine = true, assets = item.assets).also { touch(it) })
        }
        publish()
        if (connection == NotatoConnection.CONNECTED) flush()
    }

    fun clearLocal() {
        notes.removeAll { it.pending }
        val store = store
        scope.launch(Dispatchers.IO) { store.clear() }
        publish()
    }

    // ---- the server: live updates over server-sent events --------------------------------------------------------------

    fun restartSync() {
        syncJob?.cancel()
        syncJob = null
        failure = null
        failureDetail = null
        retrying = false
        if (!enabled) return
        val url = server
        // The token goes only to the server it was configured for, never to one typed into the Settings sheet.
        client = url?.let { NotatoClient(it, config.tokenFor(it)) }
        val c = client
        if (!hasServer || c == null) {
            setConnection(NotatoConnection.LOCAL, if (mode == NotatoMode.TEST) null else "No server is set: notes stay on this device.")
            return
        }
        syncJob = scope.launch {
            // One catching up at a time: a reconnect while the last one is still reading the list waits for it.
            val catchingUp = Mutex()
            var delayMs = 1000L
            while (isActive) {
                setConnection(NotatoConnection.CONNECTING, null)
                try {
                    // Decoded on the thread that reads the stream: the main thread only applies what came.
                    c.events(config.project, agent = mode == NotatoMode.AGENT).mapNotNull(::decodeEvent).flowOn(Dispatchers.IO).collect { event ->
                        delayMs = 1000
                        when (event) {
                            SyncEvent.Hello -> {
                                setConnection(NotatoConnection.CONNECTED, null)
                                // Beside the stream, not in it: events go on being taken while the list is read.
                                launch { catchingUp.withLock { catchUp(c) } }
                            }
                            is SyncEvent.Changed -> upsert(event.annotation)
                            is SyncEvent.Deleted -> deleted(event.id)
                            // Answered at once, whatever else is going on.
                            is SyncEvent.Relay -> scope.launch { answerRelay(event.request, c) }
                        }
                    }
                    if (!isActive) return@launch
                    setConnection(NotatoConnection.OFFLINE, "The server closed the connection.")
                } catch (error: NotatoServerException) {
                    if (!isActive) return@launch
                    if (error.permanent) {
                        setConnection(NotatoConnection.REFUSED, error.message)
                        delayMs = 10_000
                    } else {
                        setConnection(NotatoConnection.OFFLINE, error.message)
                    }
                } catch (error: Exception) {
                    if (!isActive) return@launch
                    if (error is kotlinx.coroutines.CancellationException) throw error
                    setConnection(NotatoConnection.OFFLINE, error.message)
                }
                delay(delayMs)
                delayMs = minOf(10_000, delayMs * 2)
            }
        }
    }

    /** The menu's Retry: tries the server again now, rather than when the backoff would. */
    fun retryNow() {
        if (!enabled || !hasServer) return
        val was = failure
        val why = failureDetail
        restartSync()
        // Still down until this try says otherwise: the banner stays, saying it is trying.
        if (connection == NotatoConnection.CONNECTING) {
            failure = was
            failureDetail = why
            retrying = was != null
        }
        publish()
    }

    private fun setConnection(next: NotatoConnection, detail: String?) {
        if (!enabled) return
        if (next == NotatoConnection.REFUSED && connection != next) Log.w(TAG, "Notato: $detail")
        connection = next
        connectionDetail = detail
        when (next) {
            NotatoConnection.CONNECTING -> Unit
            NotatoConnection.OFFLINE, NotatoConnection.REFUSED -> {
                failure = next
                failureDetail = detail
                retrying = false
            }
            else -> {
                failure = null
                failureDetail = null
                retrying = false
            }
        }
        publish()
    }

    /**
     * Connected: the server's settings, then the notes queued here sent, then the project's list read (which has
     * them by then, rather than missing them until the next connect).
     */
    private suspend fun catchUp(c: NotatoClient) {
        try {
            serverScreenshots = try {
                c.config().screenshots
            } catch (error: NotatoServerException) {
                serverScreenshots
            }
            flush()
            reload(c)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            Log.w(TAG, "Notato could not catch up with the server: ${error.message}")
        }
    }

    /** The server deleted a note. One still waiting here is kept: the server never had it. */
    private fun deleted(id: String) {
        deletions[id] = ++clock
        if (notes[id]?.pending == false) notes.remove(id)
        publish()
    }

    /**
     * Reads the project's whole list (every page) and makes the notes here match it. If any page fails, nothing
     * changes: a partial list must not drop the notes it did not reach. The notes are indexed by id, so this is one
     * pass over each, however long the list.
     */
    private suspend fun reload(c: NotatoClient) {
        val since = clock
        val listed = try {
            c.list(config.project)
        } catch (error: NotatoServerException) {
            Log.w(TAG, "Notato could not read the project's notes: ${error.message}")
            return
        }
        val merge = mergeList(notes.all, listed.map { it.annotation }, since, deletions.filterValues { it > since }.keys)
        for (annotation in merge.upserts) take(annotation)
        if (merge.drops.isNotEmpty()) notes.removeAll { it.annotation.id in merge.drops }
        publish()
    }

    fun upsert(annotation: Annotation) {
        take(annotation)
        publish()
    }

    /**
     * Takes the server's copy of a note: a new one, a change, or (for one waiting here) word that it arrived. One
     * deleted here is not brought back by it (an event about a note deleted while it was being sent).
     */
    private fun take(annotation: Annotation) {
        val arrived = notes.take(annotation, config.project, { it in deletions }, ::touch) ?: return
        keepPeopleOnly(arrived.record, arrived.local, annotation)
        val store = store
        scope.launch(Dispatchers.IO) { store.remove(annotation.id) }
    }

    /** Agent mode: an agent asked, through `notato_annotate`, for something in this app to be annotated. */
    private suspend fun answerRelay(request: AnnotateRequest, c: NotatoClient) {
        val result = try {
            val annotation = annotate(request.args.target, request.args.comment, AnnotateOptions(
                severity = request.args.severity, intent = request.args.intent, agentName = request.args.author ?: "agent", steps = request.args.steps,
            ))
            RelayResult(ok = true, annotationId = annotation.id)
        } catch (error: Exception) {
            RelayResult(ok = false, error = error.message ?: error.javaClass.simpleName)
        }
        runCatching { c.relayResult(request.requestId, result) }.onFailure { Log.w(TAG, "Notato could not report an annotate result: ${it.message}") }
    }

    // ---- acting on a note, as the person --------------------------------------------------------------------------

    private fun connected(): NotatoClient = client?.takeIf { hasServer } ?: throw IllegalStateException("Not connected to a Notato server.")

    /** Replies as the person; an [aside] is for the people on the thread, and kept from the agent. */
    suspend fun reply(id: String, text: String, aside: Boolean = false) =
        upsert(connected().reply(id, text, Author.human(authorName), aside).annotation)

    /**
     * People only on or off for a note, as the person. One the server has is changed there, and the server records
     * the change in its thread; one still waiting here (test mode, or made while the server was down) is changed here,
     * with the same entry in its thread, so a package carries the history.
     */
    suspend fun setPeopleOnly(id: String, on: Boolean) {
        val record = notes[id] ?: throw IllegalStateException("That note is not here any more.")
        if ((record.annotation.peopleOnly == true) == on) return
        val me = Author.human(authorName)
        if (!record.pending) {
            upsert(connected().setPeopleOnly(id, on, me).annotation)
            return
        }
        record.annotation = PeopleOnly.toggle(record.annotation, on, me)
        record.peopleOnlyChanged = true
        touch(record)
        val store = store
        // Only annotation.json is written again (whole or not at all): the screenshots on disk have not changed.
        val annotation = record.annotation
        withContext(Dispatchers.IO) { store.save(annotation) }
        // Sent (or deleted) while it was being written: the copy kept here is not wanted any more.
        if (!record.pending || record.deletedHere) withContext(Dispatchers.IO) { store.remove(id) }
        publish()
    }

    /**
     * The server's copy of a note that was waiting here has arrived. If People only was changed here meanwhile and the
     * server's copy says otherwise (the change came while the note was on its way), the server is told: the person
     * chose to keep it from the agent, or to share it, and that must not be lost.
     */
    private fun keepPeopleOnly(record: NoteRecord, local: Annotation, server: Annotation) {
        val wanted = PeopleOnly.stillToSend(record.peopleOnlyChanged, local, server)
        record.peopleOnlyChanged = false
        if (wanted == null) return
        val c = client?.takeIf { hasServer } ?: return
        scope.launch {
            try {
                upsert(c.setPeopleOnly(server.id, wanted, Author.human(authorName)).annotation)
            } catch (error: NotatoServerException) {
                Log.w(TAG, "Notato could not turn People only ${if (wanted) "on" else "off"} on the server: ${error.message}")
            }
        }
    }

    suspend fun requestRevert(id: String, reason: String?) =
        upsert(connected().setStatus(id, Status.REVERT_REQUESTED, reason?.takeIf { it.isNotBlank() } ?: "Please undo this change.", Author.human(authorName)).annotation)

    suspend fun cancelRevert(id: String) = upsert(connected().setStatus(id, Status.RESOLVED, "Revert request taken back.", Author.human(authorName)).annotation)

    suspend fun delete(id: String) {
        val record = notes[id]
        if (record != null && !record.pending && hasServer) connected().delete(id)
        // One not sent yet never goes; one on its way is deleted on the server once it is there (see send).
        record?.deletedHere = true
        deletions[id] = ++clock
        notes.remove(id)
        val store = store
        withContext(Dispatchers.IO) { store.remove(id) }
        publish()
    }

    /** Saves the settings sheet. Returns what is wrong with them instead, changing nothing, when the server is not a URL. */
    fun saveSettings(name: String, screenshots: Boolean, server: String): String? {
        val trimmed = server.trim().trimEnd('/')
        val reset = trimmed.isEmpty() || trimmed == config.resolvedServer
        if (!reset) NotatoConfig.serverProblem(trimmed)?.let { return "\"$trimmed\" $it." }
        state.author = name
        state.screenshots = if (screenshots == config.screenshots) null else screenshots
        val changed = if (reset) {
            (state.server != null).also { state.server = null }
        } else {
            (state.server != trimmed).also { state.server = trimmed }
        }
        if (changed) {
            notes.removeAll { !it.pending }
            restartSync()
        }
        publish()
        return null
    }

    fun describeConnection(): String {
        val host = server?.substringAfter("://")?.substringBefore('/')
        return when (connection) {
            NotatoConnection.CONNECTED -> "Connected to ${host ?: "the server"}"
            NotatoConnection.CONNECTING -> "Connecting to ${host ?: "the server"}…"
            NotatoConnection.OFFLINE -> connectionDetail ?: "Cannot reach ${host ?: "the server"}"
            NotatoConnection.REFUSED -> connectionDetail ?: "${host ?: "The server"} refused this app"
            NotatoConnection.LOCAL -> if (mode == NotatoMode.TEST) {
                host?.let { "Notes stay on this device; a package is uploaded to $it" } ?: "Notes stay on this device until packaged"
            } else {
                connectionDetail ?: "No server"
            }
            NotatoConnection.DISABLED -> problem ?: "Off"
        }
    }

    /** The server as the menu names it: `localhost:4792`. */
    val serverHost: String? get() = server?.substringAfter("://")?.substringBefore('/')

    // ---- test mode: a bundle zip ----------------------------------------------------------------------------------------

    suspend fun packageNotes(upload: Boolean): File {
        val file = makePackage()
        val url = server
        if (upload && url != null) NotatoClient(url, config.tokenFor(url)).uploadBundle(config.project, file)
        return file
    }

    /**
     * The notes on this device as a bundle zip in the app's cache, written to the file as it goes (the screenshots
     * read from disk one at a time). Packages made before go once they are an hour old: each is made again from the
     * notes when asked for, and the last one shared may still be being read by the app it went to.
     */
    private suspend fun makePackage(): File {
        val mine = notes.all.filter { it.pending || (mode == NotatoMode.TEST && it.mine) }
        if (mine.isEmpty()) throw IllegalStateException("Nothing to package yet: make at least one note.")
        val items = mine.map { LocalAnnotation(it.annotation, it.assets ?: emptyMap()) }
        val project = config.project
        val author = authorName
        val name = appName()
        val version = appVersion()
        val stamp = java.text.SimpleDateFormat("yyyyMMdd-HHmm", Locale.US).format(java.util.Date())
        // Off the main thread from here: the bundle looks at the screenshots' files, and the zip reads them.
        return withContext(Dispatchers.IO) {
            val (bundle, files) = BundleWriter.build(items, project, author, name, version)
            val folder = File(app.cacheDir, "notato").apply { mkdirs() }
            val hourAgo = System.currentTimeMillis() - 3_600_000
            folder.listFiles { f -> f.name.startsWith("notato-") && f.name.endsWith(".zip") && f.lastModified() < hourAgo }?.forEach { it.delete() }
            val file = File(folder, "notato-$project-$stamp.zip")
            try {
                FileOutputStream(file).buffered().use { BundleWriter.zip(bundle, files, it) }
            } catch (error: Exception) {
                file.delete()
                throw error
            }
            file
        }
    }

    suspend fun packageAndShare(session: Session) {
        val file = try {
            makePackage()
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            session.overlay.toast(error.message ?: "Could not package the notes.")
            return
        }
        var problem: String? = null
        server?.let { url ->
            try {
                NotatoClient(url, config.tokenFor(url)).uploadBundle(config.project, file)
            } catch (error: NotatoServerException) {
                problem = error.message
            }
        }
        try {
            val uri = FileProvider.getUriForFile(app, "${app.packageName}.notato.files", file)
            val share = Intent(Intent.ACTION_SEND).apply {
                type = "application/zip"
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            session.activity.startActivity(Intent.createChooser(share, "Notato feedback"))
        } catch (error: Exception) {
            Log.w(TAG, "Notato could not share the package", error)
            session.overlay.toast("Packaged as ${file.name}, but it could not be shared: ${error.message}")
            return
        }
        session.overlay.toast(problem?.let { "Packaged, but not uploaded: $it" } ?: if (server == null) "Packaged. Send the zip to the developer." else "Packaged and uploaded.")
    }

    // ---- shake ---------------------------------------------------------------------------------------------------------

    private var lastShake = 0L
    private var sensors: SensorManager? = null
    val shakeAvailable get() = config.shakeToToggle && sensors != null

    private fun startShake() {
        if (!config.shakeToToggle || sensors != null) return
        val manager = app.getSystemService(SensorManager::class.java) ?: return
        val accelerometer = manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: return
        manager.registerListener(this, accelerometer, SensorManager.SENSOR_DELAY_UI)
        sensors = manager
    }

    private fun stopShake() {
        sensors?.unregisterListener(this)
        sensors = null
    }

    override fun onSensorChanged(event: SensorEvent) {
        val (x, y, z) = event.values
        val force = sqrt(x * x + y * y + z * z) / SensorManager.GRAVITY_EARTH
        val now = System.currentTimeMillis()
        if (force > 2.7f && now - lastShake > 1000) {
            lastShake = now
            setToolbar(!toolbarVisible)
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    // ---- state for the app ----------------------------------------------------------------------------------------

    /** Tells the overlays and the app (through [stateFlow]) that something changed. */
    fun publish() {
        render()
        emitState()
    }

    /** Draws the overlays again: for what only they show (the toolbar's place and fold, the pins shown or hidden). */
    private fun render() {
        for (session in sessions.values) session.overlay.render()
    }

    private var emittedVersion = -1L
    private var emitted: List<Annotation> = emptyList()

    /**
     * The state the app sees. The notes are copied into it only when they changed: a toggle or a connection change
     * hands on the same list, so [stateFlow] (which compares) does not even look through it.
     */
    private fun emitState() {
        if (emittedVersion != notes.version) {
            emitted = notes.all.map { it.annotation }
            emittedVersion = notes.version
        }
        stateFlow.value = NotatoState(
            isEnabled = enabled,
            isToolbarVisible = enabled && toolbarVisible,
            isAnnotating = enabled && annotating,
            connection = connection,
            connectionDetail = connectionDetail ?: problem,
            annotations = emitted,
            pendingCount = pendingCount,
        )
    }

    fun recordRequest(entry: NetworkEntry) {
        handler.post {
            network.addLast(entry)
            while (network.size > 50) network.removeFirst()
        }
    }

    fun close() {
        setEnabled(false, remember = false)
        app.unregisterActivityLifecycleCallbacks(this)
        scope.cancel()
    }

    @Suppress("unused")
    private val debuggable get() = app.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
}
