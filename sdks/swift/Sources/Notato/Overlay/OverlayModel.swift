#if canImport(UIKit)
import SwiftUI
import UIKit

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
            // Long enough to read: a long message stays longer.
            try? await Task.sleep(for: .seconds(message.count > 70 ? 5 : 2.8))
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
#endif
