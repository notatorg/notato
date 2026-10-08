#if canImport(UIKit)
import UIKit
import SwiftUI

/// What the overlay shows of a selection.
struct SelectionView: Equatable {
    var rects: [CGRect]
    var title: String
    var subtitle: String?
}

/// The overlay's state in one window. Notato's own window reads `capturesTouch` to decide which touches are its own.
@MainActor
@Observable
final class OverlayModel {
    enum Sheet: Equatable {
        case composer
        /// A note's card; opened from the list of notes, it can go back there.
        case pin(String, fromList: Bool = false)
        case menu
        case settings
        case list
        case confirmClear

        /// A note's card opened from the list, which the menu opened.
        var fromList: Bool {
            if case .pin(_, true) = self { return true }
            return false
        }
    }

    var selection: SelectionView?
    var sheet: Sheet?
    /// The screens showing, as notes record them (`/ProductList/ProductDetail`).
    var route = ""
    var sheetAtTop = false
    var pins: [PinPlacement] = []
    /// How many notes are on this screen, for the toolbar's count: kept up to date by the overlay's tick, so the bar
    /// does not count them again on every frame of a fold.
    var count = 0
    var toast: String?
    var windowSize: CGSize = .zero
    var toolbarFraction: CGPoint
    let defaultFraction: CGPoint
    /// Folded into its round button or open, and the move between the two.
    private(set) var toolbarFold: ToolbarFold
    /// How the toolbar looks now: changed on every frame of a fold or an opening.
    private(set) var toolbarLook: ToolbarLook

    /// Where Notato's controls are, in window coordinates: touches there are Notato's, the rest go to the app.
    @ObservationIgnored var regions: [String: CGRect] = [:]
    /// Remembers a fold or an opening someone chose.
    @ObservationIgnored var saveCollapsed: (Bool) -> Void = { _ in }
    @ObservationIgnored private var toastTask: Task<Void, Never>?
    @ObservationIgnored private var frames: CADisplayLink?

    /// The open bar's parts as they move: the grip with Annotate (and its count), the menu, and the one that folds it.
    static let toolbarItems = 3

    init(defaultFraction: CGPoint, saved: CGPoint?, collapsed: Bool) {
        self.defaultFraction = defaultFraction
        let fraction = saved ?? defaultFraction
        self.toolbarFraction = fraction
        toolbarFold = ToolbarFold(collapsed: collapsed, items: Self.toolbarItems)
        toolbarLook = .resting(collapsed: collapsed, toward: ToolbarPlacement.heldRight(fraction) ? 1 : -1, items: Self.toolbarItems)
    }

    func show(toast message: String) {
        toast = message
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: message.count > 70 ? 5_000_000_000 : 2_800_000_000)
            if !Task.isCancelled { self?.toast = nil }
        }
    }

    // ---- the toolbar folding into its round button ---------------------------------------------------------------

    var toolbarCollapsed: Bool { toolbarFold.collapsed }
    var toolbarHeldRight: Bool { ToolbarPlacement.heldRight(toolbarFraction) }

    /// Someone folded or opened the toolbar (or the app did). Remembered.
    func setToolbarCollapsed(_ collapsed: Bool) {
        let time = CACurrentMediaTime()
        guard toolbarFold.set(collapsed, heldRight: toolbarHeldRight, at: time, animated: animates) else { return }
        saveCollapsed(collapsed)
        toolbarChanged(at: time)
    }

    /// Annotating started or stopped: a folded bar opens for it and folds again after. Not remembered, as it is not
    /// anyone's choice.
    func annotatingChanged(_ active: Bool) {
        let time = CACurrentMediaTime()
        guard toolbarFold.annotating(active, heldRight: toolbarHeldRight, at: time, animated: animates) else { return }
        toolbarChanged(at: time)
    }

    private var animates: Bool { !UIAccessibility.isReduceMotionEnabled }

    private func toolbarChanged(at time: CFTimeInterval) {
        // What was opened from the bar's buttons goes with it.
        if toolbarFold.collapsed, let open = sheet, [.menu, .settings, .list, .confirmClear].contains(open) || open.fromList { sheet = nil }
        toolbarLook = toolbarFold.look(at: time, heldRight: toolbarHeldRight)
        guard toolbarFold.morph != nil, frames == nil else { return }
        let ticker = FrameTicker { [weak self] time in self?.toolbarFrame(at: time) ?? false }
        let link = CADisplayLink(target: ticker, selector: #selector(FrameTicker.step(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common)
        frames = link
    }

    /// One frame of a fold or an opening. Returns whether there are more.
    private func toolbarFrame(at time: CFTimeInterval) -> Bool {
        let more = toolbarFold.moving(at: time)
        toolbarLook = toolbarFold.look(at: time, heldRight: toolbarHeldRight)
        if !more {
            toolbarFold.settle()
            frames = nil
        }
        return more
    }
}

/// Calls back on every frame the display shows, until told there are no more. The display link keeps it, not the
/// model, so a model that goes away mid-move is let go. The link runs on the main run loop.
@MainActor
private final class FrameTicker: NSObject {
    private let tick: (CFTimeInterval) -> Bool

    init(_ tick: @escaping (CFTimeInterval) -> Bool) { self.tick = tick }

    @objc func step(_ link: CADisplayLink) {
        // When this frame will be on screen, so the move is drawn where it is then.
        if !tick(link.targetTimestamp) { link.invalidate() }
    }
}

/// A window that keeps only the touches that land on Notato's controls (or all of them while annotating or while
/// a sheet is open); every other touch goes to the app's window underneath.
final class OverlayWindow: UIWindow {
    var capturesTouch: (CGPoint) -> Bool = { _ in false }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard capturesTouch(point) else { return nil }
        return super.hitTest(point, with: event)
    }
}

/// Lets the app keep deciding the status bar and rotation while Notato's window is on top.
final class OverlayHostingController<Content: View>: UIHostingController<Content> {
    weak var appWindow: UIWindow?

    private var appTop: UIViewController? {
        var vc = appWindow?.rootViewController
        while let presented = vc?.presentedViewController, !presented.isBeingDismissed { vc = presented }
        return vc
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { appTop?.preferredStatusBarStyle ?? .default }
    override var prefersStatusBarHidden: Bool { appTop?.prefersStatusBarHidden ?? false }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { appTop?.supportedInterfaceOrientations ?? .all }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
    }
}

/// Notato in one of the app's window scenes.
@MainActor
final class OverlaySession {
    weak var scene: UIWindowScene?
    weak var appWindow: UIWindow?
    let window: OverlayWindow
    let model: OverlayModel
    var selection: SelectionState?
    /// Kept in the model, so what counts the notes on this screen (the toolbar) is drawn again when it changes.
    var route: String {
        get { model.route }
        set { model.route = newValue }
    }
    var tick = 0
    var scanned: [ScreenElement] = []
    var lastScan = Date.distantPast
    /// Where this window's pins were put.
    let pins = PinBoard()
    private weak var controller: OverlayHostingController<OverlayRoot>?

    init(scene: UIWindowScene, appWindow: UIWindow, hooks: PlatformHooks) {
        self.scene = scene
        self.appWindow = appWindow
        let notato = hooks.notato
        model = OverlayModel(defaultFraction: (notato.configuration?.toolbarPosition ?? .bottomTrailing).defaultFraction,
                             saved: notato.state.toolbarPosition, collapsed: notato.state.toolbarCollapsed ?? false)
        model.saveCollapsed = { notato.state.toolbarCollapsed = $0 ? true : nil }
        window = OverlayWindow(windowScene: scene)
        window.frame = appWindow.frame
        // Above alerts too: a note can be about an alert.
        window.windowLevel = .alert + 1
        window.backgroundColor = .clear
        let root = OverlayRoot(model: model, notato: notato, hooks: hooks, session: WeakSession())
        let controller = OverlayHostingController(rootView: root)
        controller.appWindow = appWindow
        window.rootViewController = controller
        self.controller = controller
        root.session.value = self
        window.capturesTouch = { [weak self] point in
            guard let self else { return false }
            return MainActor.assumeIsolated {
                if notato.isAnnotating || self.model.sheet != nil { return true }
                return self.model.regions.values.contains { $0.insetBy(dx: -4, dy: -4).contains(point) }
            }
        }
        window.isHidden = false
    }

    /// While a note is being written Notato's window has the keyboard; otherwise the app's window keeps it.
    func syncKeyWindow() {
        if window.frame != appWindow?.frame, let frame = appWindow?.frame { window.frame = frame }
        let typing = model.sheet != nil
        if typing, !window.isKeyWindow { window.makeKey() }
        if !typing, window.isKeyWindow { appWindow?.makeKey() }
    }

    /// The app now shows another window in this scene (the one the overlay was over went away or was hidden): follow
    /// it. What was selected was in the other window, and is let go.
    func follow(_ appWindow: UIWindow) {
        self.appWindow = appWindow
        controller?.appWindow = appWindow
        window.frame = appWindow.frame
        selection = nil
        model.selection = nil
        if model.sheet == .composer { model.sheet = nil }
        scanned = []
        lastScan = .distantPast
        pins.reset()
    }

    func close() {
        if window.isKeyWindow { appWindow?.makeKey() }
        window.isHidden = true
        window.rootViewController = nil
    }
}

/// Lets the SwiftUI root reach its session without a retain cycle.
@MainActor
final class WeakSession {
    weak var value: OverlaySession?
}

/// What the agent is told about the device and the app, as `context.ios`.
struct DeviceInfoContext: Codable, Sendable {
    var screen: String?
    var screenFile: String?
    var screens: [String]?
    var marked: [String]?
    var controllers: [String]?
    var system: String
    var device: String
    var idiom: String
    var simulator: Bool
    var orientation: String
    var colorScheme: String
    var contentSize: String
    var locale: String
    var bundleId: String
}

@MainActor
enum DeviceContext {
    static var model: String {
        var info = utsname()
        uname(&info)
        let machine = withUnsafeBytes(of: &info.machine) { raw in String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self) }
        return ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] ?? machine
    }

    static var simulator: Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        return false
        #endif
    }

    static func userAgent(_ configuration: NotatoConfiguration) -> String {
        let device = UIDevice.current
        return "\(AppInfo.name(configuration))/\(AppInfo.version(configuration) ?? "") (\(device.systemName) \(device.systemVersion); \(model)\(simulator ? "; simulator" : "")) SwiftUI"
    }

    /// The kind of device, by name: the raw values have a gap (there is no 4), so they cannot index a list.
    static func idiom(_ idiom: UIUserInterfaceIdiom) -> String {
        switch idiom {
        case .phone: return "phone"
        case .pad: return "pad"
        case .tv: return "tv"
        case .carPlay: return "carPlay"
        case .mac: return "mac"
        case .vision: return "vision"
        case .unspecified: return "unspecified"
        @unknown default: return "unspecified"
        }
    }

    static func describe(session: OverlaySession, hooks: PlatformHooks, element: ScreenElement, configuration: NotatoConfiguration) -> DeviceInfoContext {
        let around = MarkRegistry.shared.around(element.frame, in: session.appWindow)
        let screens = MarkRegistry.shared.screens(in: session.appWindow)
        let screen = around.last(where: { $0.kind == .screen }) ?? screens.last
        let traits = session.appWindow?.traitCollection
        return DeviceInfoContext(
            screen: screen?.name,
            screenFile: screen.map { SourcePaths.relative($0.file, root: configuration.sourceRoot) + ":\($0.line)" },
            screens: screens.map(\.name).nilIfEmpty,
            marked: around.map(\.name).nilIfEmpty,
            controllers: hooks.controllerChain(session).nilIfEmpty,
            system: "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)",
            device: model,
            idiom: idiom(UIDevice.current.userInterfaceIdiom),
            simulator: simulator,
            orientation: (session.scene?.interfaceOrientation.isLandscape ?? false) ? "landscape" : "portrait",
            colorScheme: traits?.userInterfaceStyle == .dark ? "dark" : "light",
            contentSize: traits?.preferredContentSizeCategory.rawValue ?? "",
            locale: Locale.current.identifier,
            bundleId: AppInfo.bundleId)
    }
}

extension Array {
    var nilIfEmpty: [Element]? { isEmpty ? nil : self }
}
#endif
