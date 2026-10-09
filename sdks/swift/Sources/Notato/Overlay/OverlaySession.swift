#if canImport(UIKit)
import SwiftUI
import UIKit

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

    private var appTop: UIViewController? { appWindow?.rootViewController?.topPresented }

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
    /// The app's window as the accessibility tree last described it for pins, and when.
    var scanned: [ScreenElement] = []
    var lastScan = Date.distantPast
    /// The screen must be read again before the pins are next placed: another screen, a note added or gone, the end
    /// of a scroll.
    var needsScan = true
    /// The notes pinned when the pins were last placed.
    var pinnedIds: [String] = []
    /// Pins followed their elements since the screen was last read.
    var moved = false
    /// Where this window's pins were put.
    let pins = PinBoard()
    /// The scroll views the pins are in, watched so that a scroll wakes the pins up to follow it.
    let scrolls = ScrollWatcher()
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
        needsScan = true
        pins.reset()
        scrolls.unwatch()
    }

    func close() {
        if window.isKeyWindow { appWindow?.makeKey() }
        window.isHidden = true
        window.rootViewController = nil
    }
}

/// Watches scroll views scroll (their `contentOffset`, which UIKit sets on every frame of a scroll, on the main thread).
@MainActor
final class ScrollWatcher {
    private var watching: [ObjectIdentifier: NSKeyValueObservation] = [:]

    /// Watches these scroll views, and stops watching the rest: `scrolled` is called as any of them scrolls.
    func watch(_ scrollViews: [UIScrollView], scrolled: @escaping @MainActor @Sendable () -> Void) {
        var next: [ObjectIdentifier: NSKeyValueObservation] = [:]
        for scroll in scrollViews {
            let key = ObjectIdentifier(scroll)
            if next[key] != nil { continue }
            next[key] = watching.removeValue(forKey: key) ?? scroll.observe(\.contentOffset) { _, _ in
                MainActor.assumeIsolated { scrolled() }
            }
        }
        for observation in watching.values { observation.invalidate() }
        watching = next
    }

    func unwatch() {
        for observation in watching.values { observation.invalidate() }
        watching = [:]
    }
}

/// Lets the SwiftUI root reach its session without a retain cycle.
@MainActor
final class WeakSession {
    weak var value: OverlaySession?
}

extension UIViewController {
    /// The controller showing on top of this one: the last one presented, not counting one on its way out.
    var topPresented: UIViewController {
        var top = self
        while let presented = top.presentedViewController, !presented.isBeingDismissed { top = presented }
        return top
    }
}
#endif
