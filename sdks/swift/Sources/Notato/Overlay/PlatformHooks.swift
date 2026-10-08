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
    /// How often the overlay catches up with the app: its windows, its screen, the pins.
    private static let tickInterval: TimeInterval = 0.25
    /// The least time between two reads of the accessibility tree for pins, the costly part of a tick.
    private static let scanInterval: TimeInterval = 0.5
    /// How hard a shake must be, in g, and how long after one before another counts.
    private static let shakeForce = 2.6
    private static let shakeInterval: TimeInterval = 1

    let notato: Notato
    var sessions: [OverlaySession] = []
    private var observers: [NSObjectProtocol] = []
    private var timer: Timer?
    private var motion: CMMotionManager?
    private var lastShake = Date.distantPast

    init(_ notato: Notato) { self.notato = notato }

    static func make(_ notato: Notato) -> PlatformHooks? { PlatformHooks(notato) }

    // ---- windows -----------------------------------------------------------------------------------------------

    /// Notato switched on: an overlay over each of the app's windows, kept up to date until `detach`.
    func attach() {
        if notato.configuration?.readAccessibility != false {
            AccessibilityRuntime.activate()
        } else {
            AccessibilityRuntime.undoKilledRun()
        }
        attachAll()
        // A scene connected or came to the front: put the overlay in its window.
        for name in [UIScene.didActivateNotification, UIWindow.didBecomeKeyNotification, UIScene.willEnterForegroundNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.attachAll() }
            })
        }
        timer = Timer.scheduledTimer(withTimeInterval: Self.tickInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        startShake()
    }

    /// Notato switched off: the overlays closed, and application accessibility put back.
    func detach() {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
        timer?.invalidate()
        timer = nil
        motion?.stopAccelerometerUpdates()
        motion = nil
        AccessibilityRuntime.restore()
        for session in sessions { session.close() }
        sessions = []
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
                session.lastScan = .distantPast
                session.pins.reset()
            }
            let notes = notato.notes(onRoute: route)
            if session.model.count != notes.count { session.model.count = notes.count }
            let pins = notato.pinsVisible ? placements(session, notes.pinned) : []
            if pins != session.model.pins { session.model.pins = pins }
            session.syncKeyWindow()
        }
    }

    /// The notes on the session's screen, in pin order.
    func notes(on session: OverlaySession) -> ScreenNotes {
        notato.notes(onRoute: session.route.isEmpty ? route(of: session) : session.route)
    }

    /// The pins, placed. Reading the accessibility tree is the costly part: at most twice a second, and only when there
    /// are pins to place; between reads, the pins stay where they were put (`PinBoard`).
    private func placements(_ session: OverlaySession, _ pinned: [(number: Int, record: NoteRecord)]) -> [PinPlacement] {
        guard !pinned.isEmpty, let window = session.appWindow else { return [] }
        let scanned = Date().timeIntervalSince(session.lastScan) > Self.scanInterval
        if scanned {
            session.scanned = scan(window)
            session.lastScan = Date()
        }
        let elements = session.scanned
        // Each selector is looked for once however many notes share it, and the marked views' names are read once.
        var bySelector: [Selectors.Parsed: CGRect?] = [:]
        var marked: [String: CGRect]?
        return session.pins.pins(for: pinned, width: session.model.windowSize.width, scanned: scanned) { record in
            if let markId = record.markId, let frame = MarkRegistry.shared.frame(of: markId, in: window) { return frame }
            guard let selector = record.selector else { return nil }
            if let known = bySelector[selector] { return known }
            var frame = Selectors.first(selector, in: elements)?.frame
            if frame == nil, let id = selector.id {
                // `#Name` also finds a `.notato("Name")` mark: the latest to appear of that name.
                if marked == nil {
                    marked = Dictionary(MarkRegistry.shared.all(.view, in: window).map { ($0.name, $0.frame) }, uniquingKeysWith: { _, later in later })
                }
                frame = marked?[id]
            }
            bySelector[selector] = frame
            return frame
        }
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

    private func ignored(_ element: ScreenElement, in window: UIWindow) -> Bool {
        MarkRegistry.shared.all(.ignore, in: window).contains { $0.frame.contains(CGPoint(x: element.frame.midX, y: element.frame.midY)) }
    }

    /// The window as it is now, with what must be covered in it as it is now: `elements` were scanned just before.
    func capture(_ window: UIWindow, elements: [ScreenElement]) -> CapturedScreen? {
        ScreenshotTaker.capture(window, elements: elements, privateViews: MarkRegistry.shared.all(.mask, in: window).map(\.frame),
                                maskInputs: maskInputs)
    }

    func pick(at point: CGPoint, in session: OverlaySession) {
        guard let window = session.appWindow else { return }
        let scanned = scan(window)
        let all = scanned.filter { !ignored($0, in: window) }
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
        let screen = session.selection?.screen ?? (notato.screenshotsOn ? capture(window, elements: scanned) : nil)
        select(SelectionState(elements: [picked], all: all, kind: kind, screen: screen, markId: markId), in: session)
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
        let record = await create(selection, comment: comment, intent: intent, severity: severity, author: .human(notato.authorName),
                                  mode: notato.mode.rawValue, steps: nil, peopleOnly: peopleOnly, in: session)
        session.selection = nil
        session.model.selection = nil
        session.model.sheet = nil
        notato.stopAnnotating()
        let outcome = await notato.send(record)
        toast(outcome.problem ?? (notato.hasServer ? "Sent" : "Saved on this device. Package it from the menu."), in: session)
        return nil
    }

    func create(_ selection: SelectionState, comment: String, intent: String?, severity: String?, author: Author, mode: String,
                steps: [AgentStep]?, peopleOnly: Bool = false, in session: OverlaySession) async -> NoteRecord {
        let configuration = notato.configuration!
        // The log is read off the main actor while the rest of the note is put together here.
        let limit = configuration.logLimit, since = notato.started
        let logs = configuration.captureLogs ? Task.detached { LogRecorder.recent(limit: limit, since: since) } : nil
        let route = self.route(of: session)
        let pin = notato.notes(onRoute: route).count + 1
        let identity = selection.elements.map {
            IdentityBuilder.describe($0, among: selection.all, maskInputs: configuration.resolvedMaskInputs, sourceRoot: configuration.sourceRoot, window: session.appWindow)
        }
        let union = selection.elements.dropFirst().reduce(selection.elements[0].frame) { $0.union($1.frame) }

        var shots: ComposedScreenshots?
        if let screen = selection.screen, notato.screenshotsOn {
            // Covered where things were when the picture was taken, not where they are now.
            shots = ScreenshotComposer.compose(screen, targets: selection.elements.map(\.frame), pin: pin,
                                               maxScale: configuration.maxScreenshotScale)
        }

        var context: [String: JSONValue] = [
            "ios": .from(DeviceContext.describe(session: session, hooks: self, element: selection.elements[0], configuration: configuration)),
            "screenshot": .object(["pin": .number(Double(pin))]),
        ]
        if let logs = await logs?.value, !logs.isEmpty { context["console"] = .from(logs) }
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
            screenshots: shots?.refs, steps: steps, context: context, status: Status.open, thread: [],
            peopleOnly: peopleOnly ? true : nil)
        let record = NoteRecord(annotation, pending: true, mine: true)
        record.markId = selection.markId
        await notato.add(record, screenshots: shots?.assets ?? [:])
        return record
    }

    private func round2(_ value: CGFloat) -> Double { (Double(value) * 100).rounded() / 100 }

    /// The first element a selector finds, in any window: accessibility elements, then marked views by name.
    func find(_ selector: String) throws -> (OverlaySession, SelectionState)? {
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
