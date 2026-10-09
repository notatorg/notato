import Foundation
#if canImport(UIKit)
import UIKit
import SwiftUI
import CoreMotion

/// What is selected, and the picture taken when it was (with what to cover in it, as it was then).
struct SelectionState {
    /// What the note is about.
    var elements: [ScreenElement]
    /// Everything on screen with it, which its selector must tell it apart from.
    var all: [ScreenElement]
    /// The target's kind as the schema has it: `element`, or `area` for a spot with nothing described there.
    var kind: String
    var screen: CapturedScreen?
    /// The marked view it is, followed live for its pin.
    var markId: UUID?
}

/// The iOS side of Notato: an overlay window over each of the app's windows, picking, screenshots, pins.
@MainActor
final class PlatformHooks {
    /// How often the overlay catches up with the app: its windows, its screen, the count of notes on it.
    private static let tickInterval: TimeInterval = 0.25
    /// The longest pins go without the screen being read again, for what moves without a scroll (an animation).
    private static let rescanInterval: TimeInterval = 2
    /// How long nothing must have moved for the pins to count as settled, when the screen is read again.
    private static let settleDelay: CFTimeInterval = 0.12
    /// How long after switching application accessibility on its tree is taken to be built (`AccessibilityRuntime`).
    private static let accessibilityWarmUp: TimeInterval = 0.5
    /// How far a pin moves in sight; further, it fades out where it was and in where it goes.
    private static let hopDistance: CGFloat = 90
    /// How hard a shake must be, in g, and how long after one before another counts.
    private static let shakeForce = 2.6
    private static let shakeInterval: TimeInterval = 1

    let notato: Notato
    var sessions: [OverlaySession] = []
    private var observers: [NSObjectProtocol] = []
    private var timer: Timer?
    /// Runs while the pins follow what moves under them, and stops once nothing has moved for `settleDelay`.
    private var follower: CADisplayLink?
    private var lastMove: CFTimeInterval = 0
    /// Notato has needed the accessibility tree, and switched application accessibility on for it.
    private var accessibilityWanted = false
    /// The last switching on that the tree was read once after, to have it built.
    private var primedFor: Date?
    private var tickSoon = false
    private var motion: CMMotionManager?
    private var lastShake = Date.distantPast

    init(_ notato: Notato) { self.notato = notato }

    static func make(_ notato: Notato) -> PlatformHooks? { PlatformHooks(notato) }

    // ---- windows -----------------------------------------------------------------------------------------------

    /// Notato switched on: an overlay over each of the app's windows, kept up to date until `detach`. Application
    /// accessibility is switched on later, when it is first needed (`needAccessibility`); one a killed run left on is
    /// put back now.
    func attach() {
        AccessibilityRuntime.undoKilledRun()
        attachAll()
        // A scene connected or came to the front: put the overlay in its window.
        for name in [UIScene.didActivateNotification, UIWindow.didBecomeKeyNotification, UIScene.willEnterForegroundNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.attachAll() }
            })
        }
        // In the background nothing is on screen to keep up with. (Coming forward, the app is still in the background
        // until it is active.)
        for name in [UIApplication.didEnterBackgroundNotification, UIApplication.didBecomeActiveNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.refresh() }
            })
        }
        // The keyboard moves the app's content without a scroll: the pins are placed again once it has.
        for name in [UIResponder.keyboardDidShowNotification, UIResponder.keyboardDidHideNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.rescanSoon() }
            })
        }
        MarkRegistry.shared.changed = { [weak self] appearedOrWent in self?.marksChanged(appearedOrWent) }
        refresh()
        startShake()
    }

    /// Notato switched off: the overlays closed, and application accessibility put back.
    func detach() {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
        MarkRegistry.shared.changed = nil
        timer?.invalidate()
        timer = nil
        follower?.invalidate()
        follower = nil
        motion?.stopAccelerometerUpdates()
        motion = nil
        AccessibilityRuntime.restore()
        accessibilityWanted = false
        for session in sessions {
            session.scrolls.unwatch()
            session.close()
        }
        sessions = []
    }

    /// Starts the overlay's tick, or stops it when nothing it keeps up to date can be seen: the app is in the
    /// background, or the toolbar and the pins are hidden and nothing is being annotated or shown. Called as any of
    /// those changes.
    func refresh() {
        let foreground = UIApplication.shared.applicationState != .background
        let showing = notato.isToolbarVisible || notato.pinsVisible || notato.isAnnotating || sessions.contains { $0.model.sheet != nil }
        guard foreground, showing else {
            timer?.invalidate()
            timer = nil
            follower?.invalidate()
            follower = nil
            return
        }
        if notato.isAnnotating { _ = needAccessibility() }
        guard timer == nil else {
            tick()
            return
        }
        // In every run loop mode: a timer in the default mode does not fire while a scroll is tracked or slows down.
        let timer = Timer(timeInterval: Self.tickInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        tick()
    }

    /// Puts the overlay in each scene's window, and keeps each where the app is. A session whose scene went is closed
    /// first, so the scene can have a fresh one; one whose app window went or was hidden moves to the window the app
    /// shows now (or closes, when it shows none). Run on every tick as well, as not every change is announced.
    private func attachAll() {
        sessions.removeAll { session in
            guard let scene = session.scene, scene.activationState != .unattached else {
                session.close()
                return true
            }
            if let window = session.appWindow, !window.isHidden, window.windowScene === scene { return false }
            guard let replacement = Self.appWindow(in: scene) else {
                session.close()
                return true
            }
            session.follow(replacement)
            return false
        }
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes where scene.activationState != .unattached {
            if sessions.contains(where: { $0.scene === scene }) { continue }
            guard let appWindow = Self.appWindow(in: scene) else { continue }
            sessions.append(OverlaySession(scene: scene, appWindow: appWindow, hooks: self))
        }
    }

    /// The app's own window in a scene: the key one, else the first showing at the normal level (not a keyboard's or
    /// an alert's), else the first showing.
    private static func appWindow(in scene: UIWindowScene) -> UIWindow? {
        let showing = scene.windows.filter { !($0 is OverlayWindow) && !$0.isHidden }
        return showing.first { $0.isKeyWindow } ?? showing.first { $0.windowLevel == .normal } ?? showing.first
    }

    // ---- shake --------------------------------------------------------------------------------------------------

    private func startShake() {
        guard notato.configuration?.shakeToToggle == true else { return }
        let manager = CMMotionManager()
        guard manager.isAccelerometerAvailable else { return }
        manager.accelerometerUpdateInterval = 0.05
        manager.startAccelerometerUpdates(to: .main) { [weak self] data, _ in
            guard let a = data?.acceleration else { return }
            let force = sqrt(a.x * a.x + a.y * a.y + a.z * a.z)
            MainActor.assumeIsolated {
                guard let self, force > Self.shakeForce, Date().timeIntervalSince(self.lastShake) > Self.shakeInterval else { return }
                self.lastShake = Date()
                self.notato.setToolbar(!self.notato.isToolbarVisible)
            }
        }
        motion = manager
    }

    var shakeAvailable: Bool { notato.configuration?.shakeToToggle == true && motion != nil }

    // ---- the overlay's rhythm: pins follow their elements -----------------------------------------------------------

    private func tick() {
        attachAll()
        for session in sessions {
            let route = route(of: session)
            if route != session.route {
                session.route = route
                session.pins.reset()
                session.needsScan = true
            }
            let notes = notato.notes(onRoute: route)
            if session.model.count != notes.count { session.model.count = notes.count }
            placePins(session, notes.pinned)
            session.syncKeyWindow()
        }
    }

    /// The screen is read again for the pins as soon as it can be: something moved that cannot be followed.
    private func rescanSoon() {
        for session in sessions { session.needsScan = true }
        if timer != nil { tick() }
    }

    /// A marked view moved, or one appeared or went. Moving, the pins follow it (and whatever else moves with it);
    /// appearing or going, the screen may be another, which the next tick (on the next turn of the run loop, once the
    /// marks of the whole change are in) finds.
    private func marksChanged(_ appearedOrWent: Bool) {
        wake()
        guard appearedOrWent, !tickSoon, timer != nil else { return }
        tickSoon = true
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.tickSoon = false
                if self.timer != nil { self.tick() }
            }
        }
    }

    /// The notes on the session's screen, in pin order.
    func notes(on session: OverlaySession) -> ScreenNotes {
        notato.notes(onRoute: session.route.isEmpty ? route(of: session) : session.route)
    }

    /// Places the pins of the session's screen. The screen is read again (the accessibility tree, the costly part) only
    /// when it may show something else: another screen, a note added or gone, the end of a scroll, the keyboard, and
    /// every `rescanInterval` for whatever else moves. Otherwise the pins stay where they were put, and those that can
    /// be followed move with their elements (`wake`).
    private func placePins(_ session: OverlaySession, _ pinned: [(number: Int, record: NoteRecord)]) {
        guard notato.pinsVisible, !pinned.isEmpty, let window = session.appWindow else {
            if !session.model.pins.isEmpty || session.pins.follows {
                session.pins.reset()
                session.scrolls.unwatch()
                session.pinnedIds = []
                show([], in: session, animated: true)
            }
            return
        }
        // Read before the accessibility tree is built, the pins would go where their notes were made and jump after.
        if pinned.contains(where: { $0.record.markId == nil }), !needAccessibility() { return }
        let ids = pinned.map(\.record.id)
        if ids != session.pinnedIds {
            session.pinnedIds = ids
            session.needsScan = true
        }
        // While something moves the pins follow it; the screen is read once it has settled.
        guard follower == nil else {
            show(session.pins.pins(for: pinned, width: session.model.windowSize.width, scanned: false) { _ in nil }, in: session, animated: false)
            return
        }
        if Date().timeIntervalSince(session.lastScan) > Self.rescanInterval { session.needsScan = true }
        let scanned = session.needsScan
        session.needsScan = false
        show(placements(session, pinned, window: window, scanned: scanned), in: session, animated: scanned)
    }

    /// The pins, placed. With `scanned`, every note's element is looked for again: by its marked view, which is
    /// followed from then on; else in the accessibility tree (read now, only if a note needs it), and then followed in
    /// the scroll view it is in, if it is in one.
    private func placements(_ session: OverlaySession, _ pinned: [(number: Int, record: NoteRecord)], window: UIWindow,
                            scanned: Bool) -> [PinPlacement] {
        if scanned { session.lastScan = Date() }
        var elements: [ScreenElement]?
        // Each selector is looked for once however many notes share it, and the marked views' names are read once.
        var bySelector: [Selectors.Parsed: PinBoard.Located?] = [:]
        var marked: [String: UUID]?
        var scrollViews: [UIScrollView] = []
        let registry = MarkRegistry.shared
        let pins = session.pins.pins(for: pinned, width: session.model.windowSize.width, scanned: scanned) { (record: NoteRecord) -> PinBoard.Located? in
            if let markId = record.markId, let found = MarkAnchor(markId, in: window) {
                scrollViews += found.scrollViews
                return found.located
            }
            guard let selector = record.selector else { return nil }
            if let known = bySelector[selector] { return known }
            if elements == nil {
                elements = scanned || session.scanned.isEmpty ? scan(window) : session.scanned
                session.scanned = elements ?? []
            }
            var located: PinBoard.Located?
            if let frame = Selectors.first(selector, in: elements ?? [])?.frame {
                located = PinBoard.Located(rect: frame)
                if let anchor = ScrollAnchor(frame, in: window) {
                    scrollViews += anchor.scrollViews
                    located?.follow = { [weak window] in window.flatMap { anchor.rect(in: $0) } }
                }
            } else if let id = selector.id {
                // `#Name` also finds a `.notato("Name")` mark: the latest to appear of that name.
                if marked == nil {
                    marked = Dictionary(registry.all(.view, in: window).map { ($0.name, $0.id) }, uniquingKeysWith: { _, later in later })
                }
                if let markId = marked?[id], let found = MarkAnchor(markId, in: window) {
                    scrollViews += found.scrollViews
                    located = found.located
                }
            }
            bySelector[selector] = located
            return located
        }
        if scanned { session.scrolls.watch(scrollViews) { [weak self] in self?.wake() } }
        return pins
    }

    /// Puts the pins on screen: as they follow their elements, frame by frame, straight away; placed again after a
    /// scan, moving there (or, too far to be seen moving, fading out and in again).
    private func show(_ pins: [PinPlacement], in session: OverlaySession, animated: Bool) {
        let reduceMotion = UIAccessibility.isReduceMotionEnabled
        var before: [String: PinPlacement] = [:]
        for pin in session.model.pins { before[pin.id] = pin }
        var pins = pins
        for index in pins.indices {
            guard let old = before[pins[index].id] else { continue }
            pins[index].hop = old.hop
            let distance = hypot(pins[index].origin.x - old.origin.x, pins[index].origin.y - old.origin.y)
            // With Reduce Motion nothing slides: a pin placed elsewhere fades.
            if animated, distance > (reduceMotion ? 0.5 : Self.hopDistance) { pins[index].hop += 1 }
        }
        guard pins != session.model.pins else { return }
        guard animated else {
            session.model.pins = pins
            return
        }
        withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .spring(duration: 0.3)) { session.model.pins = pins }
    }

    /// Something on screen may be moving (a scroll view the pins are in scrolled, a marked view moved): the pins follow
    /// it on every frame until nothing has moved for `settleDelay`, and the screen is read again then.
    private func wake() {
        guard follower == nil, timer != nil, sessions.contains(where: { $0.pins.follows }) else { return }
        lastMove = CACurrentMediaTime()
        follower = FrameTicker.link { [weak self] time in self?.follow(at: time) ?? false }
    }

    /// One frame of following. Returns whether there are more.
    private func follow(at time: CFTimeInterval) -> Bool {
        var moved = false
        for session in sessions where session.pins.follows && session.pins.follow() {
            moved = true
            session.moved = true
            show(session.pins.placements(), in: session, animated: false)
        }
        if moved { lastMove = time }
        if moved || time - lastMove < Self.settleDelay { return true }
        follower = nil
        // Settled: what scrolled into sight is found, and every pin laid out again where it ended up.
        for session in sessions where session.moved {
            session.moved = false
            session.needsScan = true
        }
        if timer != nil { tick() }
        return false
    }

    /// Whether the accessibility tree can be read: application accessibility is on, and has been for long enough for
    /// the tree to be built. Switches it on the first time it is asked (it stays on until Notato is switched off, and is
    /// put back on as the app comes forward), and reads the tree once, on the next turn of the run loop, each time it
    /// is switched on, so that it is being built by the time it is read for real.
    @discardableResult
    func needAccessibility() -> Bool {
        guard notato.configuration?.readAccessibility != false else { return true }
        if !accessibilityWanted {
            accessibilityWanted = true
            AccessibilityRuntime.activate()
        }
        guard let since = AccessibilityRuntime.switchedOn else { return true }
        if primedFor != since {
            primedFor = since
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated {
                    for session in self?.sessions ?? [] {
                        if let window = session.appWindow { _ = AccessibilityScanner.elements(in: window) }
                    }
                }
            }
        }
        return Date().timeIntervalSince(since) > Self.accessibilityWarmUp
    }

    // ---- routes ------------------------------------------------------------------------------------------------

    /// The marked screens showing in the session's window, in the order they appeared (`/ProductList/ProductDetail`),
    /// else the view controllers.
    func route(of session: OverlaySession) -> String {
        let screens = MarkRegistry.shared.screens(in: session.appWindow).map(\.name)
        if !screens.isEmpty { return "/" + screens.joined(separator: "/") }
        return "/" + controllerChain(session).joined(separator: "/")
    }

    func controllerChain(_ session: OverlaySession) -> [String] {
        var names: [String] = []
        var vc = session.appWindow?.rootViewController
        while let current = vc {
            let name = String(describing: type(of: current)).components(separatedBy: "<").first ?? "View"
            if names.last != name { names.append(name) }
            if let nav = current as? UINavigationController { vc = nav.visibleViewController === current ? nil : nav.visibleViewController }
            else if let tabs = current as? UITabBarController { vc = tabs.selectedViewController }
            else { vc = current.presentedViewController }
        }
        return names
    }

    // ---- picking -----------------------------------------------------------------------------------------------

    private func area(_ rect: CGRect) -> CGFloat { rect.width * rect.height }

    /// Masks text fields unless the configuration says not to (or there is none yet).
    private var maskInputs: Bool { notato.configuration?.resolvedMaskInputs ?? true }

    /// What is on screen as it may be recorded: the accessibility tree with private views' text and masked fields'
    /// values taken out (`Privacy`), so no selector, identity, title or match for an agent's `:text()` can carry them.
    func scan(_ window: UIWindow) -> [ScreenElement] {
        let registry = MarkRegistry.shared
        return Privacy.apply(AccessibilityScanner.elements(in: window), masks: registry.all(.mask, in: window).map(\.frame),
                             optOuts: registry.all(.unmask, in: window).map(\.frame), maskInputs: maskInputs)
    }

    /// The window as it is now, with what must be covered in it as it is now: `elements` were scanned just before.
    func capture(_ window: UIWindow, elements: [ScreenElement]) -> CapturedScreen? {
        ScreenshotTaker.capture(window, elements: elements, privateViews: MarkRegistry.shared.all(.mask, in: window).map(\.frame),
                                maskInputs: maskInputs, maxScale: notato.configuration?.maxScreenshotScale ?? 4)
    }

    /// Selects what is under the finger and opens the note for it at once: the screen is read for it, and the
    /// picture (the costly part) is taken on the next frame, with the composer on its way.
    func pick(at point: CGPoint, in session: OverlaySession) {
        guard let window = session.appWindow else { return }
        needAccessibility()
        let scanned = scan(window)
        // The views the picker looks through, read once for every element.
        let ignored = MarkRegistry.shared.all(.ignore, in: window).map(\.frame)
        let all = ignored.isEmpty ? scanned : scanned.filter { element in
            let middle = CGPoint(x: element.frame.midX, y: element.frame.midY)
            return !ignored.contains { $0.contains(middle) }
        }
        var element = all.filter { $0.frame.contains(point) }.min { area($0.frame) < area($1.frame) }
        var markId: UUID?
        // A marked view smaller than the accessibility element under the finger is the more precise answer.
        if let mark = MarkRegistry.shared.around(CGRect(origin: point, size: .zero), kinds: [.view], in: window).last,
           element.map({ area(mark.frame) < area($0.frame) * 0.9 }) ?? true {
            element = ScreenElement(marked: mark)
            markId = mark.id
        }
        // Nothing is described there: note the spot itself.
        let kind = element == nil ? "area" : "element"
        let picked = element ?? ScreenElement(role: nil, label: nil, value: nil, identifier: nil,
                                              frame: CGRect(x: point.x - 32, y: point.y - 32, width: 64, height: 64).intersection(window.bounds),
                                              control: "Area")
        // The picture from the first tap is kept as another element is chosen, with its covers.
        let kept = session.selection?.screen
        select(SelectionState(elements: [picked], all: all, kind: kind, screen: kept, markId: markId), in: session)
        if kept == nil, notato.screenshotsOn { captureNextFrame(window, scanned: scanned, in: session) }
    }

    /// Takes the picture for the selection on the next frame. The app is not drawn over (Notato's window is its own),
    /// but it may still be moving (a scroll slowing down): the fields to cover, read as the finger came down, are
    /// followed in their scroll views to where they are as the picture is taken, and private views read again then.
    private func captureNextFrame(_ window: UIWindow, scanned: [ScreenElement], in session: OverlaySession) {
        let maskInputs = maskInputs
        var anchors: [Int: ScrollAnchor] = [:]
        for (index, element) in scanned.enumerated() where Privacy.hidesValue(element, maskInputs: maskInputs) {
            anchors[index] = ScrollAnchor(element.frame, in: window, clipped: false)
        }
        FrameTicker.nextFrame { [weak self, weak session, weak window] in
            guard let self, let session, let window, session.appWindow === window, session.selection != nil,
                  session.selection?.screen == nil else { return }
            var now = scanned
            for (index, anchor) in anchors { now[index].frame = anchor.rect(in: window) ?? now[index].frame }
            session.selection?.screen = self.capture(window, elements: now)
        }
    }

    func select(_ selection: SelectionState, in session: OverlaySession) {
        session.selection = selection
        let first = selection.elements[0]
        var title = first.control
        if let id = first.identifier { title += " #\(id)" }
        if let text = first.text, first.control != "View" { title += " “\(text.count > 28 ? String(text.prefix(27)) + "…" : text)”" }
        if first.isMasked { title += " (private)" }
        let identity = IdentityBuilder.describe(first, among: selection.all, maskInputs: maskInputs,
                                                sourceRoot: notato.configuration?.sourceRoot, window: session.appWindow)
        let screen = MarkRegistry.shared.around(first.frame, in: session.appWindow).last(where: { $0.kind == .screen })?.name
        var parts: [String] = []
        if let screen { parts.append("in \(screen)") }
        if let source = identity.source { parts.append("\((source.file as NSString).lastPathComponent):\(source.line)\(source.nearest == true ? " (around it)" : "")") }
        session.model.selection = SelectionView(rects: selection.elements.map(\.frame), title: title, subtitle: parts.isEmpty ? nil : parts.joined(separator: " · "))
        session.model.sheet = .composer
        session.model.sheetAtTop = (first.frame.midY > session.model.windowSize.height / 2)
    }

    func selectParent(in session: OverlaySession) {
        guard var selection = session.selection, let current = selection.elements.first else { return }
        let bigger = MarkRegistry.shared.around(current.frame, in: session.appWindow).filter { area($0.frame) > area(current.frame) * 1.02 }
        guard let parent = bigger.last else {
            toast("That is the whole screen.", in: session)
            return
        }
        selection.elements = [ScreenElement(marked: parent)]
        selection.markId = parent.id
        selection.kind = "element"
        select(selection, in: session)
    }

    func clearSelection() {
        for session in sessions {
            session.selection = nil
            session.model.selection = nil
            if session.model.sheet == .composer { session.model.sheet = nil }
        }
    }

    func toast(_ message: String, in session: OverlaySession? = nil) {
        (session ?? sessions.first)?.model.show(toast: message)
    }

    func toolbarPositionReset() {
        for session in sessions {
            session.model.toolbarFraction = session.model.defaultFraction
            session.model.setToolbarCollapsed(false)
        }
    }

    // ---- making notes ------------------------------------------------------------------------------------------

    func submit(comment: String, intent: String?, severity: String?, peopleOnly: Bool, in session: OverlaySession) async -> String? {
        guard let selection = session.selection else { return "Select something first." }
        // The composer closes now; the note's pin shows as soon as it is made, before its pictures are drawn.
        session.selection = nil
        session.model.selection = nil
        session.model.sheet = nil
        notato.stopAnnotating()
        let record = await create(selection, comment: comment, intent: intent, severity: severity, author: .human(notato.authorName),
                                  mode: notato.mode.rawValue, steps: nil, peopleOnly: peopleOnly, in: session)
        let outcome = await notato.send(record)
        toast(outcome.problem ?? (notato.hasServer ? "Sent" : "Saved on this device. Package it from the menu."), in: session)
        return nil
    }

    /// Makes a note of the selection. It is in the list (and its pin on screen) at once; its log is read and its
    /// pictures drawn off the main actor meanwhile, and it is kept on the device (and can be sent) once they are in.
    func create(_ selection: SelectionState, comment: String, intent: String?, severity: String?, author: Author, mode: String,
                steps: [AgentStep]?, peopleOnly: Bool = false, in session: OverlaySession) async -> NoteRecord {
        let configuration = notato.configuration!
        let limit = configuration.logLimit, since = notato.started
        let logs = configuration.captureLogs ? Task.detached { LogRecorder.recent(limit: limit, since: since) } : nil
        let route = self.route(of: session)
        let pin = notato.notes(onRoute: route).count + 1
        let targets = selection.elements.map(\.frame)
        var drawing: Task<ComposedScreenshots, Never>?
        if let screen = selection.screen, notato.screenshotsOn {
            // Covered where things were when the picture was taken, not where they are now.
            let maxScale = configuration.maxScreenshotScale
            drawing = Task.detached(priority: .userInitiated) {
                ScreenshotComposer.compose(screen, targets: targets, pin: pin, maxScale: maxScale)
            }
        }
        let identity = selection.elements.map {
            IdentityBuilder.describe($0, among: selection.all, maskInputs: configuration.resolvedMaskInputs, sourceRoot: configuration.sourceRoot, window: session.appWindow)
        }
        let union = targets.dropFirst().reduce(targets[0]) { $0.union($1) }

        var context: [String: JSONValue] = [
            "ios": .from(DeviceContext.describe(session: session, hooks: self, element: selection.elements[0], configuration: configuration)),
            "screenshot": .object(["pin": .number(Double(pin))]),
        ]
        let network = NotatoNetworkRecorder.snapshot()
        if !network.isEmpty { context["network"] = .from(network) }

        let size = session.appWindow?.bounds.size ?? .zero
        let annotation = Annotation(
            id: ULID.make(), projectId: configuration.project, bundleId: nil, author: author, mode: mode,
            createdAt: NotatoJSON.timestamp(),
            url: "ios://\(AppInfo.bundleId)\(route)", route: route,
            appName: AppInfo.name(configuration), appVersion: AppInfo.version(configuration),
            environment: EnvironmentInfo(userAgent: DeviceContext.userAgent(configuration), viewport: Viewport(w: size.width, h: size.height),
                                         dpr: Double(session.appWindow?.traitCollection.displayScale ?? 2), platform: Notato.platformName,
                                         sdk: SDKInfo(name: NotatoSDK.name, version: NotatoSDK.version)),
            target: Target(kind: selection.elements.count > 1 ? "multi" : selection.kind, identity: identity,
                           rect: PageRect(x: round2(union.minX), y: round2(union.minY), w: round2(union.width), h: round2(union.height))),
            comment: comment.trimmingCharacters(in: .whitespacesAndNewlines), severity: severity, intent: intent, variants: nil,
            screenshots: nil, steps: steps, context: context, status: Status.open, thread: [],
            peopleOnly: peopleOnly ? true : nil)
        let record = NoteRecord(annotation, pending: true, mine: true)
        record.markId = selection.markId
        // Not sent (by a connection coming back, say) before its pictures and its log are in.
        record.sending = true
        notato.insert([record])
        session.needsScan = true
        if timer != nil { tick() }

        let shots = await drawing?.value
        let console = await logs?.value
        record.sending = false
        if shots != nil || console?.isEmpty == false {
            var finished = record.annotation
            finished.screenshots = shots?.refs
            if let console, !console.isEmpty { finished.context["console"] = .from(console) }
            record.annotation = finished
        }
        // Deleted while its pictures were drawn: nothing of it is kept.
        guard !record.deleted else { return record }
        await notato.add(record, screenshots: shots?.assets ?? [:])
        return record
    }

    private func round2(_ value: CGFloat) -> Double { (Double(value) * 100).rounded() / 100 }

    /// The first element a selector finds, in any window: accessibility elements, then marked views by name.
    func find(_ selector: String) throws -> (OverlaySession, SelectionState)? {
        needAccessibility()
        for session in sessions {
            guard let window = session.appWindow else { continue }
            let all = scan(window)
            if let found = try Selectors.query(selector, in: all).first {
                return (session, SelectionState(elements: [found], all: all, kind: "element", screen: nil, markId: nil))
            }
            if let parsed = try? Selectors.parse(selector), let id = parsed.id,
               let mark = MarkRegistry.shared.all(.view, in: window).last(where: { $0.name == id }) {
                return (session, SelectionState(elements: [ScreenElement(marked: mark)], all: all, kind: "element", screen: nil, markId: mark.id))
            }
        }
        return nil
    }

    // ---- sharing a package ---------------------------------------------------------------------------------------

    /// Packages the notes, uploads the zip when a server is set, and opens the share sheet with it. A failed upload
    /// still shares the zip.
    func packageAndShare(in session: OverlaySession) async {
        let url: URL
        do {
            url = try await notato.writePackage()
        } catch {
            toast(error.localizedDescription, in: session)
            return
        }
        var uploadProblem: String?
        do {
            try await notato.uploadPackage(url)
        } catch {
            uploadProblem = error.localizedDescription
        }
        guard let presenter = session.appWindow?.rootViewController?.topPresented else { return }
        let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        share.popoverPresentationController?.sourceView = presenter.view
        share.popoverPresentationController?.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.maxY - 60, width: 1, height: 1)
        presenter.present(share, animated: true)
        let done = notato.server == nil ? "Packaged. Send the zip to the developer." : "Packaged and uploaded."
        toast(uploadProblem.map { "Packaged, but not uploaded: \($0)" } ?? done, in: session)
    }
}

/// An element's place in the scroll view it is in, so it can be found again as the scroll view scrolls without
/// reading the screen: its frame in the scroll view's content, converted to the window when asked.
@MainActor
struct ScrollAnchor {
    private weak var view: UIScrollView?
    private let local: CGRect
    private let clipped: Bool

    /// The scroll view at the middle of `rect` (as a touch there would find it) that `rect` is inside of, not the
    /// scroll view itself (a text view, a whole list); nil when there is none. With `clipped`, `rect(in:)` says nil
    /// once the element has scrolled out of the scroll view's sight.
    init?(_ rect: CGRect, in window: UIWindow, clipped: Bool = true) {
        guard rect.width.isFinite, rect.height.isFinite,
              var view = window.hitTest(CGPoint(x: rect.midX, y: rect.midY), with: nil) else { return nil }
        while true {
            if let scroll = view as? UIScrollView, !rect.insetBy(dx: -1, dy: -1).contains(scroll.convert(scroll.bounds, to: window)) {
                self.view = scroll
                local = scroll.convert(rect, from: window)
                self.clipped = clipped
                return
            }
            guard let parent = view.superview else { return nil }
            view = parent
        }
    }

    /// Where the element is in the window now; nil when its scroll view has left the window or (`clipped`) it has
    /// scrolled out of sight.
    func rect(in window: UIWindow) -> CGRect? {
        guard let view, view.window === window else { return nil }
        let now = view.convert(local, to: window)
        guard clipped else { return now }
        return now.intersects(view.convert(view.bounds, to: window)) ? now : nil
    }

    /// Its scroll view and those around it: a scroll of any of them moves the element.
    var scrollViews: [UIScrollView] { view.map(UIView.scrollViews(around:)) ?? [] }
}

/// A marked view's pin: found by its probe, followed by its probe (which is in the window wherever SwiftUI puts it), and
/// out of sight once it has scrolled out of the scroll view it is in.
@MainActor
struct MarkAnchor {
    let located: PinBoard.Located
    let scrollViews: [UIScrollView]

    /// Nil when the mark is not showing in `window`.
    init?(_ id: UUID, in window: UIWindow) {
        let registry = MarkRegistry.shared
        guard let frame = registry.frame(of: id, in: window) else { return nil }
        let around = registry.probe(of: id).map(UIView.scrollViews(around:)) ?? []
        let scroll = around.first
        located = PinBoard.Located(rect: frame) { [weak window, weak scroll] in
            guard let window, let now = registry.frame(of: id, in: window) else { return nil }
            if let scroll, !now.intersects(scroll.convert(scroll.bounds, to: window)) { return nil }
            return now
        }
        scrollViews = around
    }
}

extension UIView {
    /// The scroll views `view` is (or is in), innermost first.
    static func scrollViews(around view: UIView) -> [UIScrollView] {
        var found: [UIScrollView] = []
        var current: UIView? = view
        while let next = current {
            if let scroll = next as? UIScrollView { found.append(scroll) }
            current = next.superview
        }
        return found
    }
}
#else
/// No overlay outside UIKit: this build of the package is for the model and the client (and their tests).
@MainActor
final class PlatformHooks {
    static func make(_ notato: Notato) -> PlatformHooks? { nil }
    func attach() {}
    func detach() {}
    func clearSelection() {}
    func toast(_ message: String) {}
    func toolbarPositionReset() {}
}
#endif
