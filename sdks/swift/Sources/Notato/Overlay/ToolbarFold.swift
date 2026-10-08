import Foundation

// The toolbar folds into one round button and opens out of it again, as the web toolbar does. This file is the part
// that needs no screen: where the bar goes, whether it is folded and why, and how it looks at any moment of the move
// between the two, worked out from the time alone. The overlay draws `ToolbarFold.look(at:)` on each frame.

/// The toolbar's sizes, in points.
enum ToolbarMetrics {
    /// The bar's height (its 44-point buttons and 5 points around them), and so the round button's diameter.
    static let height: CGFloat = 54
    /// The gap kept between the toolbar and the window's edges.
    static let margin: CGFloat = 12
}

extension ToolbarCorner {
    /// Where the toolbar sits until it is dragged, as fractions of the room it can move in.
    var defaultFraction: CGPoint {
        switch self {
        case .bottomLeading: CGPoint(x: 0, y: 0.86)
        case .topTrailing: CGPoint(x: 1, y: 0.06)
        case .topLeading: CGPoint(x: 0, y: 0.06)
        case .bottomTrailing: CGPoint(x: 1, y: 0.86)
        }
    }
}

/// Where the toolbar goes for a fraction. The fraction places the round button; the open bar shares its edge on the
/// side it is held to and reaches away from it, so opening and folding never move that edge, whatever the fraction.
/// Folding and opening never change the fraction (only moving the toolbar does), so the side it is held to cannot
/// change between them either, and folding always puts the round button back exactly where it was, even when the open
/// bar had to be pushed in from the window's edge. An undragged toolbar keeps its corner's fraction and stays undragged.
enum ToolbarPlacement {
    /// The side the bar is held to and folds toward: the right when the fraction is in the right half. Until it is
    /// dragged that is its corner's side, whose fractions are 0 or 1.
    static func heldRight(_ fraction: CGPoint) -> Bool { fraction.x >= 0.5 }

    /// The top left of a toolbar this wide.
    static func origin(_ fraction: CGPoint, width: CGFloat, in container: CGSize) -> CGPoint {
        let d = ToolbarMetrics.height, m = ToolbarMetrics.margin
        let button = m + max(0, container.width - 2 * m - d) * fraction.x
        return CGPoint(x: heldRight(fraction) ? button + d - width : button,
                       y: m + max(0, container.height - 2 * m - d) * fraction.y)
    }

    /// Where a toolbar this wide is drawn: at `origin`, moved by a drag in progress, and kept inside the margins
    /// (which only moves the held edge when the open bar does not fit on that side).
    static func placed(_ fraction: CGPoint, width: CGFloat, in container: CGSize, moved: CGSize = .zero) -> CGPoint {
        let d = ToolbarMetrics.height, m = ToolbarMetrics.margin
        let rest = origin(fraction, width: width, in: container)
        return CGPoint(x: min(max(m, rest.x + moved.width), max(m, container.width - m - width)),
                       y: min(max(m, rest.y + moved.height), max(m, container.height - m - d)))
    }

    /// The fraction of a toolbar this wide with its top left here: the inverse of `origin`. The side it is held to
    /// is the half its middle is in.
    static func fraction(of origin: CGPoint, width: CGFloat, in container: CGSize) -> CGPoint {
        let d = ToolbarMetrics.height, m = ToolbarMetrics.margin
        let room = CGSize(width: container.width - 2 * m - d, height: container.height - 2 * m - d)
        let button = origin.x + width / 2 >= container.width / 2 ? origin.x + width - d : origin.x
        let clamp = { (value: CGFloat) in min(max(value, 0), 1) }
        return CGPoint(x: room.width > 0 ? clamp((button - m) / room.width) : 1,
                       y: room.height > 0 ? clamp((origin.y - m) / room.height) : 1)
    }
}

/// How the toolbar looks at one moment.
struct ToolbarLook: Equatable {
    /// One thing drawn: faded, moved sideways, scaled and turned about its middle.
    struct Part: Equatable {
        var opacity: Double
        /// Points to the right.
        var offset: Double = 0
        var scale: Double = 1
        /// Degrees, clockwise.
        var turn: Double = 0
    }

    /// 0 is the round button, 1 the open bar. The spring that opens it goes a little past 1.
    var extent: Double
    /// The bar's buttons, left to right.
    var items: [Part]
    /// The round button, with the marks on it.
    var button: Part
    /// The count on the round button, on top of what `button` does.
    var badge: Part

    static func resting(collapsed: Bool, toward: Double, items: Int) -> ToolbarLook {
        collapsed
            ? ToolbarLook(extent: 0, items: Array(repeating: Motion.foldedItem(toward), count: items), button: Part(opacity: 1), badge: Part(opacity: 1))
            : ToolbarLook(extent: 1, items: Array(repeating: Part(opacity: 1), count: items), button: Motion.hiddenButton(toward), badge: Motion.hiddenBadge)
    }
}

/// The curves and timings, the web toolbar's.
enum Motion {
    enum Curve: Equatable {
        case bezier(Double, Double, Double, Double)
        /// A spring, damping ratio 0.68: one overshoot of about 5%, settled (within 0.3%) by the end of its duration.
        case spring

        /// Quick off the mark, then a long settle.
        static let settle = Curve.bezier(0.32, 0.72, 0, 1)
        static let easeIn = Curve.bezier(0.42, 0, 1, 1)

        /// Progress at `p`, 0 to 1 of the duration.
        func progress(_ p: Double) -> Double {
            if p <= 0 { return 0 }
            if p >= 1 { return 1 }
            switch self {
            case let .bezier(x1, y1, x2, y2): return Self.bezier(p, x1, y1, x2, y2)
            case .spring:
                let zeta = 0.68
                let omega = 6 / zeta
                let damped = omega * (1 - zeta * zeta).squareRoot()
                return 1 - exp(-zeta * omega * p) * (cos(damped * p) + zeta / (1 - zeta * zeta).squareRoot() * sin(damped * p))
            }
        }

        /// A CSS cubic-bézier: finds where the curve is at `x` (Newton, then halving if that strays), returns its y.
        private static func bezier(_ x: Double, _ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) -> Double {
            func at(_ s: Double, _ a: Double, _ b: Double) -> Double { 3 * (1 - s) * (1 - s) * s * a + 3 * (1 - s) * s * s * b + s * s * s }
            func slope(_ s: Double, _ a: Double, _ b: Double) -> Double { 3 * (1 - s) * (1 - s) * a + 6 * (1 - s) * s * (b - a) + 3 * s * s * (1 - b) }
            var s = x
            for _ in 0..<8 {
                let error = at(s, x1, x2) - x
                if abs(error) < 1e-7 { return at(s, y1, y2) }
                let d = slope(s, x1, x2)
                if abs(d) < 1e-6 { break }
                s -= error / d
            }
            var low = 0.0, high = 1.0
            s = x
            for _ in 0..<40 {
                let value = at(s, x1, x2)
                if abs(value - x) < 1e-7 { break }
                if value < x { low = s } else { high = s }
                s = (low + high) / 2
            }
            return at(s, y1, y2)
        }
    }

    /// One value on its way from where it is to where it goes.
    struct Track: Equatable {
        var from: Double
        var to: Double
        var delay: Double = 0
        var duration: Double
        var curve: Curve

        var end: Double { delay + duration }

        func value(at t: Double) -> Double {
            from + (to - from) * curve.progress((t - delay) / duration)
        }
    }

    /// A part's four values, on the same timing.
    struct PartTrack: Equatable {
        var opacity, offset, scale, turn: Track

        init(from: ToolbarLook.Part, to: ToolbarLook.Part, delay: Double = 0, duration: Double, curve: Curve) {
            func track(_ a: Double, _ b: Double) -> Track { Track(from: a, to: b, delay: delay, duration: duration, curve: curve) }
            opacity = track(from.opacity, to.opacity)
            offset = track(from.offset, to.offset)
            scale = track(from.scale, to.scale)
            turn = track(from.turn, to.turn)
        }

        var end: Double { opacity.end }

        func value(at t: Double) -> ToolbarLook.Part {
            ToolbarLook.Part(opacity: min(max(opacity.value(at: t), 0), 1), offset: offset.value(at: t), scale: scale.value(at: t), turn: turn.value(at: t))
        }
    }

    // Where the parts start and finish. `toward` is +1 when the bar is held to the right, -1 to the left.
    static func foldedItem(_ toward: Double) -> ToolbarLook.Part { .init(opacity: 0, offset: 8 * toward, scale: 0.92) }
    static func arrivingItem(_ toward: Double) -> ToolbarLook.Part { .init(opacity: 0, offset: 10 * toward, scale: 0.94) }
    static func hiddenButton(_ toward: Double) -> ToolbarLook.Part { .init(opacity: 0, scale: 0.5, turn: -90 * toward) }
    static let hiddenBadge = ToolbarLook.Part(opacity: 0, scale: 0.4)
}

/// The move from open to folded or back, from wherever the toolbar was when it started.
struct ToolbarMorph: Equatable {
    let start: Double
    let extent: Motion.Track
    /// Left to right, as `ToolbarLook.items`.
    let items: [Motion.PartTrack]
    let button: Motion.PartTrack
    let badge: Motion.PartTrack

    /// `from` is the look on screen when it starts, so a change of mind turns around from there. Parts that cannot be
    /// seen start from where this move would have them start, which cannot show as a jump.
    init(from now: ToolbarLook, folding: Bool, toward: Double, at time: Double) {
        start = time
        let n = now.items.count
        // Index from the side the bar is held to: the edge sweeps from there when it opens, and toward it when it folds.
        let fromHeld = { (index: Int) in toward > 0 ? n - 1 - index : index }
        let hidden = { (part: ToolbarLook.Part, instead: ToolbarLook.Part) in part.opacity < 0.01 ? instead : part }
        if folding {
            extent = Motion.Track(from: now.extent, to: 0, duration: 0.42, curve: .settle)
            // The far buttons go first, as the edge comes in over them, then the button they fold into turns in.
            items = now.items.indices.map { i in
                Motion.PartTrack(from: now.items[i], to: Motion.foldedItem(toward), delay: 0.016 * Double(n - 1 - fromHeld(i)), duration: 0.16, curve: .easeIn)
            }
            button = Motion.PartTrack(from: hidden(now.button, Motion.hiddenButton(toward)), to: .init(opacity: 1), delay: 0.17, duration: 0.46, curve: .spring)
            badge = Motion.PartTrack(from: hidden(now.badge, Motion.hiddenBadge), to: .init(opacity: 1), delay: 0.4, duration: 0.38, curve: .spring)
        } else {
            extent = Motion.Track(from: now.extent, to: 1, duration: 0.56, curve: .spring)
            // Nearest the held side first, close behind the edge, which covers most of the way in the first 150ms.
            items = now.items.indices.map { i in
                Motion.PartTrack(from: hidden(now.items[i], Motion.arrivingItem(toward)), to: .init(opacity: 1), delay: 0.025 + 0.018 * Double(fromHeld(i)), duration: 0.28, curve: .settle)
            }
            button = Motion.PartTrack(from: now.button, to: Motion.hiddenButton(toward), duration: 0.18, curve: .easeIn)
            badge = Motion.PartTrack(from: now.badge, to: Motion.hiddenBadge, duration: 0.18, curve: .easeIn)
        }
    }

    /// When the last part arrives.
    var end: Double { start + ([extent.end, button.end, badge.end] + items.map(\.end)).max()! }

    func look(at time: Double) -> ToolbarLook {
        let t = time - start
        return ToolbarLook(extent: extent.value(at: t), items: items.map { $0.value(at: t) }, button: button.value(at: t), badge: badge.value(at: t))
    }
}

/// Whether the toolbar is folded, why it was opened, and the move it is making.
struct ToolbarFold: Equatable {
    private(set) var collapsed: Bool
    /// Opened because annotating started while it was folded: it folds again when annotating stops.
    private(set) var openedForAnnotate = false
    private(set) var morph: ToolbarMorph?
    /// How many buttons the open bar has.
    let items: Int

    init(collapsed: Bool, items: Int) {
        self.collapsed = collapsed
        self.items = items
    }

    /// A person (or the app) folded or opened it, which forgets that annotating opened it. Returns whether it changed.
    mutating func set(_ collapsed: Bool, heldRight: Bool, at time: Double, animated: Bool) -> Bool {
        openedForAnnotate = false
        return change(collapsed, heldRight: heldRight, at: time, animated: animated)
    }

    /// Annotating started or stopped. Started while folded, the bar opens so it shows; it folds again when annotating
    /// stops, unless someone folded or opened it in between. Returns whether it changed.
    mutating func annotating(_ active: Bool, heldRight: Bool, at time: Double, animated: Bool) -> Bool {
        if active, collapsed {
            let changed = change(false, heldRight: heldRight, at: time, animated: animated)
            openedForAnnotate = true
            return changed
        }
        if !active, openedForAnnotate {
            openedForAnnotate = false
            return change(true, heldRight: heldRight, at: time, animated: animated)
        }
        return false
    }

    private mutating func change(_ next: Bool, heldRight: Bool, at time: Double, animated: Bool) -> Bool {
        guard next != collapsed else { return false }
        let now = look(at: time, heldRight: heldRight)
        collapsed = next
        morph = animated ? ToolbarMorph(from: now, folding: next, toward: heldRight ? 1 : -1, at: time) : nil
        return true
    }

    /// Whether it is still on its way at `time`.
    func moving(at time: Double) -> Bool { morph.map { time < $0.end } ?? false }

    func look(at time: Double, heldRight: Bool) -> ToolbarLook {
        if let morph, time < morph.end { return morph.look(at: time) }
        return .resting(collapsed: collapsed, toward: heldRight ? 1 : -1, items: items)
    }

    /// The move is over: forget it.
    mutating func settle() { morph = nil }
}
