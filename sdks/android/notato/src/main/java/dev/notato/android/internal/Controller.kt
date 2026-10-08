package dev.notato.android.internal

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import dev.notato.android.AnnotateOptions
import dev.notato.android.BuildConfig
import dev.notato.android.NotatoConfig
import dev.notato.android.NotatoConnection
import dev.notato.android.NotatoMode
import dev.notato.android.NotatoState
import dev.notato.android.inspect.Box
import dev.notato.android.inspect.ScreenElement
import dev.notato.android.inspect.Selectors
import dev.notato.android.inspect.ViewInspector
import dev.notato.android.model.AgentStep
import dev.notato.android.model.Annotation
import dev.notato.android.model.Author
import dev.notato.android.model.ElementIdentity
import dev.notato.android.model.EnvironmentInfo
import dev.notato.android.model.LogEntry
import dev.notato.android.model.NetworkEntry
import dev.notato.android.model.NotatoJson
import dev.notato.android.model.PageRect
import dev.notato.android.model.SdkInfo
import dev.notato.android.model.Status
import dev.notato.android.model.Target
import dev.notato.android.model.Viewport
import dev.notato.android.net.NotatoClient
import dev.notato.android.net.NotatoServerException
import dev.notato.android.overlay.ComposerSheet
import dev.notato.android.overlay.SheetBuilder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.io.IOException
import java.lang.ref.WeakReference

internal const val TAG = "Notato"

/** The SDK as notes name it (`environment.sdk`). */
private const val SDK_NAME = "dev.notato:notato-android"

/**
 * The running Notato: the overlay in each Activity, picking and making notes, and the state the app sees. The notes
 * themselves, and the server, are [sync]'s. Main thread only.
 */
internal class Controller(
    val app: Application,
    config: NotatoConfig,
    /** Where the app reads Notato's state (`Notato.state`): written here whenever something it shows changes. */
    private val published: MutableStateFlow<NotatoState>,
) : Application.ActivityLifecycleCallbacks {
    var config: NotatoConfig = config
        private set

    /** Nothing Notato does may take the app down: whatever escapes one of its coroutines is logged, not thrown. */
    val scope = CoroutineScope(
        SupervisorJob() + Dispatchers.Main.immediate + CoroutineExceptionHandler { _, error ->
            Log.e(TAG, "Notato hit a problem it did not expect; the app carries on.", error)
        },
    )
    private val handler = Handler(Looper.getMainLooper())

    /** What the person chose at runtime (on or off, the toolbar, their name, a server), over the configuration. */
    private var runtime = RuntimeState(app, config.rememberRuntimeState)
    var fold = ToolbarFold(runtime, config.toolbarPosition)
        private set
    val sync = NoteSync(this, File(app.filesDir, "notato"), config.project)
    private val screens = ScreenNotes(sync.notes)
    private val shake = ShakeDetector(app) { setToolbar(!toolbarVisible) }

    private val sessions = mutableMapOf<Activity, Session>()
    private var resumed: WeakReference<Activity>? = null
    private val startedAt = System.currentTimeMillis()

    /** The last requests the app recorded ([recordRequest]), for the `network` context of the next notes. */
    private val network = ArrayDeque<NetworkEntry>()

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

    /** Why the configuration cannot be used (Notato stays off), or null. */
    var problem: String? = config.problem
        private set

    val mode get() = config.mode
    val server: String? get() = runtime.server ?: config.resolvedServer
    val hasServer get() = server != null && mode != NotatoMode.TEST
    val authorName get() = runtime.author ?: config.author
    val serverOverride get() = runtime.server
    val screenshotsWanted get() = runtime.screenshots ?: config.screenshots
    private val screenshotsOn get() = screenshotsWanted && sync.serverScreenshots
    val pinsVisible get() = runtime.pinsVisible ?: true
    val shakeAvailable get() = config.shakeToToggle && shake.isListening

    /** Where the toolbar is, as fractions of the room it moves in: where it was dragged, else its corner. */
    val toolbarFraction: Pair<Float, Float> get() = fold.position ?: cornerFraction(config.toolbarPosition)

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
        toolbarVisible = runtime.toolbarVisible ?: config.showToolbar
        setEnabled(runtime.enabled ?: config.enabled, remember = false)
    }

    fun reconfigure(next: NotatoConfig) {
        setEnabled(false, remember = false)
        if (next.project != config.project) sync.switchProject(next.project)
        config = next
        runtime = RuntimeState(app, next.rememberRuntimeState)
        fold = ToolbarFold(runtime, next.toolbarPosition)
        problem = next.problem
        if (problem != null) {
            Log.e(TAG, "$problem Notato stays off.")
            return
        }
        toolbarVisible = runtime.toolbarVisible ?: next.showToolbar
        setEnabled(runtime.enabled ?: next.enabled, remember = false)
    }

    fun setEnabled(on: Boolean, remember: Boolean) {
        if (on && problem != null) {
            Log.e(TAG, "$problem Notato stays off.")
            return
        }
        if (remember) runtime.enabled = on
        if (on == enabled) return publish()
        enabled = on
        if (on) {
            scope.launch { sync.loadLocal() }
            resumed?.get()?.let { session(it).attach() }
            sync.restart()
            updateWork()
        } else {
            annotating = false
            sync.stop()
            updateWork()
            for (session in sessions.values) session.detach()
            sessions.clear()
        }
        publish()
    }

    fun setToolbar(visible: Boolean) {
        toolbarVisible = visible
        runtime.toolbarVisible = visible
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
        runtime.pinsVisible = !pinsVisible
        render()
    }

    fun resetRuntimeState() {
        runtime.reset()
        fold = ToolbarFold(runtime, config.toolbarPosition)
        toolbarVisible = config.showToolbar
        setEnabled(config.enabled, remember = false)
        sync.restart()
        publish()
    }

    /** Saves the settings sheet. Returns what is wrong with them instead, changing nothing, when the server is not a URL. */
    fun saveSettings(name: String, screenshots: Boolean, server: String): String? {
        val trimmed = server.trim().trimEnd('/')
        val reset = trimmed.isEmpty() || trimmed == config.resolvedServer
        if (!reset) NotatoConfig.serverProblem(trimmed)?.let { return "\"$trimmed\" $it." }
        runtime.author = name
        runtime.screenshots = if (screenshots == config.screenshots) null else screenshots
        val changed = if (reset) {
            (runtime.server != null).also { runtime.server = null }
        } else {
            (runtime.server != trimmed).also { runtime.server = trimmed }
        }
        if (changed) {
            // Another server: the notes read from the last one are not this one's.
            sync.notes.removeAll { !it.pending }
            sync.restart()
        }
        publish()
        return null
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
            if (config.shakeToToggle) shake.start()
            handler.post(tick)
        } else {
            // In the background nothing is on screen to follow, and a shake in a pocket must not toggle the toolbar.
            shake.stop()
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
                    session.updateRoute()
                    if (pinsVisible) {
                        session.placePins(sync.notes.version, config.resolvedMaskInputs) { pinned(recordsOnRoute(session)) }
                    } else {
                        session.hidePins()
                    }
                    session.selection?.let { session.overlay.showSelection(it.drawing()) }
                }
                tickProblem = null
            } catch (error: Exception) {
                val problem = "${error::class.java.name}: ${error.message}"
                if (problem != tickProblem) {
                    tickProblem = problem
                    Log.e(TAG, "Notato could not update its pins; the app carries on.", error)
                }
            }
            handler.postDelayed(this, TICK_MS)
        }
    }

    /** Notes made here the server does not have yet (in test mode: not packaged yet). */
    val pendingCount: Int get() = screens.pending

    /** The notes on the session's screen, oldest first, numbered as their pins are. */
    fun recordsOnRoute(session: Session): List<Pair<Int, NoteRecord>> = screens.on(session.route.ifEmpty { session.currentRoute() })

    /** The ids of the notes on the session's screen that have a pin (see [pinned]). */
    fun pinnedOn(session: Session): Set<String> = pinned(recordsOnRoute(session)).mapTo(HashSet()) { it.second.annotation.id }

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

    private fun select(session: Session, selection: Selection) {
        // Another picture than the one this selection keeps (a second tap before the first's picture came): its memory goes back.
        session.selection?.screen?.takeIf { it !== selection.screen }?.release()
        session.selection = selection
        val drawing = selection.drawing()
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
        val next = (selection.index + 1 until selection.chain.size).firstOrNull { selection.chain[it].bounds.area > current.area * PARENT_GROWTH }
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
        val record = found?.second ?: sync.notes[id] ?: return
        session.overlay.showSheet(SheetBuilder(this, session).pin(record, found?.first ?: 0), dim = true)
    }

    // ---- making notes --------------------------------------------------------------------------------------------

    /** The composer's Send: makes the note about what is selected and sends it. Returns what is wrong, or null. */
    suspend fun submit(session: Session, comment: String, intent: String?, severity: String?, peopleOnly: Boolean): String? {
        val selection = session.selection ?: return "Select something first."
        val record = create(session, selection, comment, intent, severity, Author.human(authorName), mode.name.lowercase(), null, peopleOnly)
        session.selection = null
        session.overlay.showSelection(null)
        session.overlay.closeSheet()
        annotating = false
        publish()
        val problem = sync.send(record).message
        session.overlay.toast(problem ?: if (hasServer) "Sent" else "Saved on this device. Package it from the menu.")
        return null
    }

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
        val route = session.currentRoute()
        val pin = screens.on(route).size + 1
        val shots = selection.screen?.takeIf { screenshotsOn }?.let { screen ->
            screen.use {
                withContext(Dispatchers.Default) {
                    ScreenshotComposer.compose(screen, listOf(element.bounds), pin, selection.masks(config.resolvedMaskInputs), config.maxScreenshotScale)
                }
            }
        }
        val context = linkedMapOf<String, JsonElement>(
            "android" to NotatoJson.encodeToJsonElement(AndroidContext.serializer(), DeviceInfo.context(session.activity, element)),
            "screenshot" to buildJsonObject { put("pin", pin) },
        )
        if (config.captureLogs) {
            val logs = withContext(Dispatchers.IO) { LogRecorder.recent(config.logLimit, startedAt) }
            if (logs.isNotEmpty()) context["console"] = NotatoJson.encodeToJsonElement(ListSerializer(LogEntry.serializer()), logs)
        }
        if (network.isNotEmpty()) context["network"] = NotatoJson.encodeToJsonElement(ListSerializer(NetworkEntry.serializer()), network.toList())
        fun round(px: Float) = Math.round(px / density * 100) / 100.0
        val appName = appName()
        val appVersion = appVersion()
        var annotation = Annotation(
            id = Ulid.make(),
            projectId = config.project,
            author = author,
            mode = mode,
            createdAt = Time.iso(),
            url = "android://${app.packageName}$route",
            route = route,
            appName = appName,
            appVersion = appVersion,
            environment = EnvironmentInfo(
                userAgent = DeviceInfo.userAgent(appName, appVersion),
                viewport = Viewport(round((root?.width ?: 0).toFloat()), round((root?.height ?: 0).toFloat())),
                dpr = density.toDouble(),
                platform = "android",
                sdk = SdkInfo(SDK_NAME, BuildConfig.NOTATO_VERSION),
            ),
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
        val store = sync.store
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
        sync.add(record)
        publish()
        return record
    }

    /** What a note records about the element it is on: never the words of a private one. */
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

    private fun appName(): String = config.appName ?: DeviceInfo.appLabel(app)

    private fun appVersion(): String? = config.appVersion ?: DeviceInfo.appVersion(app)

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
                "no element on the screen matches \"$selector\" (the app is on ${session.currentRoute()}). Android selectors look like #resource_id, " +
                    "button:text(\"Sign in\") or text:text(\"£89\"):nth(2).",
            )
        }
        return annotate(session, found, all, screen, comment, options)
    }

    /** Makes a note about [view], as a person or (with an agent name) an agent. */
    suspend fun annotate(view: View, comment: String, options: AnnotateOptions): Annotation {
        val session = sessionOf(view) ?: throw IllegalStateException("Notato is off.")
        val root = session.root ?: throw IllegalStateException("The activity has no window yet.")
        checkNote(comment, options)
        val (screen, all) = captureThenScan({ picture(session, root, options.screenshot) }) { ViewInspector.elements(root, config.resolvedMaskInputs) }
        return annotate(session, ViewInspector.describe(view, config.resolvedMaskInputs), all, screen, comment, options)
    }

    /** The session whose window [view] is in, else the one showing. */
    private fun sessionOf(view: View): Session? = sessions.values.firstOrNull { it.root === view.rootView } ?: currentSession()

    /** What is wrong with a note made from code, found before any picture is taken. */
    private fun checkNote(comment: String, options: AnnotateOptions) {
        require(comment.isNotBlank()) { "A note needs a comment." }
        require(!options.peopleOnly || options.agentName == null) { "Only a person's note can be People only: leave agentName out." }
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
        val noteMode = if (options.agentName != null) "agent" else mode.name.lowercase()
        val record = create(session, Selection(listOf(element), 0, all, screen), comment, options.intent, options.severity, author, noteMode, options.steps, options.peopleOnly)
        sync.send(record)
        return record.annotation
    }

    /** Selects what [selector] finds on the screen, as a tap would, and opens the composer on it. */
    fun select(selector: String) {
        val session = currentSession() ?: throw IllegalStateException("Notato is off, or no activity is showing.")
        val root = session.root ?: return
        val parsed = Selectors.parse(selector)
        // Looked for now, so a selector that finds nothing fails here; looked for again once the picture is taken.
        val found = Selectors.query(parsed, ViewInspector.elements(root, config.resolvedMaskInputs)).firstOrNull()
            ?: throw IllegalArgumentException("No element on the screen matches \"$selector\".")
        selectElement(session, found) { all -> Selectors.query(parsed, all).firstOrNull() }
    }

    /** Selects [view], as a tap would, and opens the composer on it. */
    fun select(view: View) {
        val session = sessionOf(view) ?: throw IllegalStateException("Notato is off.")
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
                .filter { it.bounds.area > bounds.area * PARENT_GROWTH }
            select(session, Selection(chain, 0, all, screen))
        }
    }

    // ---- test mode: a bundle zip ----------------------------------------------------------------------------------------

    /** The notes on this device as a bundle zip, uploaded to the server when there is one and [upload] is true. */
    suspend fun packageNotes(upload: Boolean): File {
        val file = makePackage()
        val url = server
        if (upload && url != null) NotatoClient(url, config.tokenFor(url)).uploadBundle(config.project, file)
        return file
    }

    /** The notes on this device (those not sent, and in test mode every one made here) as a bundle zip in the app's cache. */
    private suspend fun makePackage(): File {
        val mine = sync.notes.all.filter { it.pending || (mode == NotatoMode.TEST && it.mine) }
        check(mine.isNotEmpty()) { "Nothing to package yet: make at least one note." }
        val items = mine.map { LocalAnnotation(it.annotation, it.assets ?: emptyMap()) }
        val project = config.project
        val author = authorName
        val name = appName()
        val version = appVersion()
        // Off the main thread from here: the bundle looks at the screenshots' files, and the zip reads them.
        return withContext(Dispatchers.IO) { writePackage(app.cacheDir, items, project, author, name, version) }
    }

    /** The menu's Package and share: the zip, uploaded when there is a server, then the share sheet. */
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
            sharePackage(session.activity, file)
        } catch (error: Exception) {
            Log.w(TAG, "Notato could not share the package", error)
            session.overlay.toast("Packaged as ${file.name}, but it could not be shared: ${error.message}")
            return
        }
        session.overlay.toast(problem?.let { "Packaged, but not uploaded: $it" } ?: if (server == null) "Packaged. Send the zip to the developer." else "Packaged and uploaded.")
    }

    // ---- state for the app and the overlay ----------------------------------------------------------------------------

    /** The connection as Settings says it. */
    fun describeConnection(): String {
        val host = serverHost
        return when (sync.connection) {
            NotatoConnection.CONNECTED -> "Connected to ${host ?: "the server"}"
            NotatoConnection.CONNECTING -> "Connecting to ${host ?: "the server"}…"
            NotatoConnection.OFFLINE -> sync.connectionDetail ?: "Cannot reach ${host ?: "the server"}"
            NotatoConnection.REFUSED -> sync.connectionDetail ?: "${host ?: "The server"} refused this app"
            NotatoConnection.LOCAL -> if (mode == NotatoMode.TEST) {
                host?.let { "Notes stay on this device; a package is uploaded to $it" } ?: "Notes stay on this device until packaged"
            } else {
                sync.connectionDetail ?: "No server"
            }
            NotatoConnection.DISABLED -> problem ?: "Off"
        }
    }

    /** The server as the menu names it: `localhost:4747`. */
    val serverHost: String? get() = server?.substringAfter("://")?.substringBefore('/')

    /** Tells the overlays and the app (through [published]) that something changed. */
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
     * hands on the same list, so [published] (which compares) does not even look through it.
     */
    private fun emitState() {
        val notes = sync.notes
        if (emittedVersion != notes.version) {
            emitted = notes.all.map { it.annotation }
            emittedVersion = notes.version
        }
        published.value = NotatoState(
            isEnabled = enabled,
            isToolbarVisible = enabled && toolbarVisible,
            isAnnotating = enabled && annotating,
            connection = sync.connection,
            connectionDetail = sync.connectionDetail ?: problem,
            annotations = emitted,
            pendingCount = pendingCount,
        )
    }

    /**
     * Keeps a request the app recorded, from any thread, for the `network` context of the next notes. As the web SDK
     * records them, without the query string or fragment: they routinely carry tokens.
     */
    fun recordRequest(entry: NetworkEntry) {
        val kept = entry.copy(url = entry.url.substringBefore('#').substringBefore('?'))
        handler.post {
            network.addLast(kept)
            while (network.size > MAX_REQUESTS) network.removeFirst()
        }
    }

    fun close() {
        setEnabled(false, remember = false)
        app.unregisterActivityLifecycleCallbacks(this)
        scope.cancel()
    }

    private companion object {
        /** How often the overlay looks at the screen: the pins, the route and the window it belongs in. */
        const val TICK_MS = 250L

        /** Parent selects the nearest element around this one that is bigger than it by more than this. */
        const val PARENT_GROWTH = 1.02f

        /** How many recorded requests a note's `network` context carries, at most. */
        const val MAX_REQUESTS = 50
    }
}
