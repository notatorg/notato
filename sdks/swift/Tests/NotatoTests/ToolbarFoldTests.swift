import Foundation
import Testing
@testable import Notato

@Suite("The toolbar's fold")
struct ToolbarFoldTests {
    private let phone = CGSize(width: 402, height: 800)
    /// The round button's diameter (and the bar's height).
    private let d = ToolbarMetrics.height

    /// `#expect` works on a copy of what it is given, which a mutating call cannot change.
    private func change(_ fold: inout ToolbarFold, _ body: (inout ToolbarFold) -> Bool) -> Bool { body(&fold) }

    @Test func theFoldIsRememberedNextToThePositionAndResetWithIt() {
        let defaults = UserDefaults.standard
        defer { for key in ["toolbar.collapsed", "toolbar.position"] { defaults.removeObject(forKey: "notato." + key) } }
        var state = RuntimeState(remember: true)
        state.toolbarPosition = CGPoint(x: 0.25, y: 0.5)
        state.toolbarCollapsed = true
        #expect(defaults.string(forKey: "notato.toolbar.collapsed") == "1")
        let relaunched = RuntimeState(remember: true)
        #expect(relaunched.toolbarCollapsed == true)
        #expect(relaunched.toolbarPosition == CGPoint(x: 0.25, y: 0.5))
        state.reset()
        #expect(RuntimeState(remember: true).toolbarCollapsed == nil)
        #expect(RuntimeState(remember: true).toolbarPosition == nil)

        var forgetful = RuntimeState(remember: false)
        forgetful.toolbarCollapsed = true
        #expect(forgetful.toolbarCollapsed == true)
        #expect(RuntimeState(remember: false).toolbarCollapsed == nil, "not kept across launches when told not to")
    }

    @Test func theChevronPointsToTheSideTheBarIsHeldTo() {
        // Never dragged: its corner's side.
        #expect(ToolbarPlacement.heldRight(ToolbarCorner.bottomTrailing.defaultFraction))
        #expect(ToolbarPlacement.heldRight(ToolbarCorner.topTrailing.defaultFraction))
        #expect(!ToolbarPlacement.heldRight(ToolbarCorner.bottomLeading.defaultFraction))
        #expect(!ToolbarPlacement.heldRight(ToolbarCorner.topLeading.defaultFraction))
        // Dragged: the half it was left in.
        #expect(ToolbarPlacement.heldRight(CGPoint(x: 0.5, y: 0.3)))
        #expect(!ToolbarPlacement.heldRight(CGPoint(x: 0.49, y: 0.3)))
    }

    @Test(arguments: [0, 0.2, 0.49, 0.5, 0.8, 1] as [CGFloat])
    func openingAndFoldingNeverMoveTheHeldEdge(x: CGFloat) {
        let fraction = CGPoint(x: x, y: 0.7)
        let right = ToolbarPlacement.heldRight(fraction)
        let edge = { (width: CGFloat) in
            let origin = ToolbarPlacement.origin(fraction, width: width, in: phone)
            return right ? origin.x + width : origin.x
        }
        // From the round button, through the spring's overshoot, to the open bar.
        for width in [d, 70, 96, 132, 138] as [CGFloat] {
            #expect(abs(edge(width) - edge(d)) < 1e-9)
            #expect(ToolbarPlacement.origin(fraction, width: width, in: phone).y == ToolbarPlacement.origin(fraction, width: d, in: phone).y)
        }
        // Dropped where it is, it stays there, folded or open. Folded, that is the same fraction; an open bar across
        // the middle can come back held to the other side, the half most of it is in, as the web toolbar's does.
        for width in [d, 132] as [CGFloat] {
            let origin = ToolbarPlacement.origin(fraction, width: width, in: phone)
            let back = ToolbarPlacement.fraction(of: origin, width: width, in: phone)
            let again = ToolbarPlacement.origin(back, width: width, in: phone)
            #expect(abs(again.x - origin.x) < 1e-9 && abs(again.y - origin.y) < 1e-9)
            #expect(ToolbarPlacement.heldRight(back) == (origin.x + width / 2 >= phone.width / 2))
            if width == d { #expect(abs(back.x - fraction.x) < 1e-9 && abs(back.y - fraction.y) < 1e-9) }
        }
    }

    @Test func aBarDroppedInTheLeftHalfIsHeldToTheLeft() {
        let left = ToolbarPlacement.fraction(of: CGPoint(x: 100, y: 300), width: 132, in: phone)
        #expect(!ToolbarPlacement.heldRight(left))
        #expect(abs(ToolbarPlacement.origin(left, width: 132, in: phone).x - 100) < 1e-9)
        let right = ToolbarPlacement.fraction(of: CGPoint(x: 160, y: 300), width: 132, in: phone)
        #expect(ToolbarPlacement.heldRight(right), "its middle, at 226, is in the right half")
        #expect(abs(ToolbarPlacement.origin(right, width: 132, in: phone).x - 160) < 1e-9)
        #expect(abs(ToolbarPlacement.origin(right, width: d, in: phone).x - (160 + 132 - d)) < 1e-9, "folded, it keeps the right edge")
    }

    /// Fold, open and fold again from just right of the middle of the narrowest iPhone (375 points), and of a window
    /// too narrow for the open bar to fit on its held side: the held side never changes, and each shape comes back to
    /// exactly where it was.
    @Test(arguments: [375, 160] as [CGFloat])
    func roundTripsComeBackExactlyAndKeepTheirSide(windowWidth: CGFloat) {
        let window = CGSize(width: windowWidth, height: 700)
        let bar: CGFloat = 132
        let fraction = CGPoint(x: 0.52, y: 0.4)
        var fold = ToolbarFold(collapsed: true, items: 3)
        let circle = ToolbarPlacement.placed(fraction, width: d, in: window)
        let open = ToolbarPlacement.placed(fraction, width: bar, in: window)
        #expect(open.x >= ToolbarMetrics.margin && open.x + bar <= windowWidth - ToolbarMetrics.margin || windowWidth < bar + 24)
        if windowWidth == 375 { #expect(abs(open.x + bar - (circle.x + d)) < 1e-9, "it fits, so the right edge is shared") }
        var time = 0.0
        for _ in 0..<3 {
            for next in [false, true] {
                #expect(change(&fold) { $0.set(next, heldRight: ToolbarPlacement.heldRight(fraction), at: time, animated: true) })
                // Every frame of the move keeps to the held side's edge, or to the margin when the bar cannot fit.
                for t in stride(from: time, through: time + 0.8, by: 1.0 / 60) {
                    let width = d + max(0, fold.look(at: t, heldRight: true).extent) * (bar - d)
                    let at = ToolbarPlacement.placed(fraction, width: width, in: window)
                    #expect(abs(at.x + width - (circle.x + d)) < 1e-9 || at.x == ToolbarMetrics.margin)
                }
                time += 1
                #expect(ToolbarPlacement.heldRight(fraction), "the side it is held to does not change")
                let rest = ToolbarPlacement.placed(fraction, width: next ? d : bar, in: window)
                #expect(rest == (next ? circle : open))
            }
        }
    }

    @Test func annotatingOpensAFoldedBarAndFoldsItAgainAfter() {
        var fold = ToolbarFold(collapsed: true, items: 3)
        #expect(change(&fold) { $0.annotating(true, heldRight: true, at: 0, animated: false) })
        #expect(!fold.collapsed && fold.openedForAnnotate)
        #expect(change(&fold) { $0.annotating(false, heldRight: true, at: 1, animated: false) })
        #expect(fold.collapsed && !fold.openedForAnnotate)

        // Folded and opened again by hand while annotating: it is someone's choice now, and stays open after.
        _ = fold.annotating(true, heldRight: true, at: 2, animated: false)
        #expect(change(&fold) { $0.set(true, heldRight: true, at: 3, animated: false) })
        #expect(change(&fold) { $0.set(false, heldRight: true, at: 4, animated: false) })
        #expect(!change(&fold) { $0.annotating(false, heldRight: true, at: 5, animated: false) })
        #expect(!fold.collapsed)

        // Open already: annotating changes nothing, then or after.
        #expect(!change(&fold) { $0.annotating(true, heldRight: true, at: 6, animated: false) })
        #expect(!fold.openedForAnnotate)
        #expect(!change(&fold) { $0.annotating(false, heldRight: true, at: 7, animated: false) })
        #expect(!fold.collapsed)
        #expect(!change(&fold) { $0.set(false, heldRight: true, at: 8, animated: false) }, "no change, no move")
    }

    @Test func itOpensOnASpringWithTheButtonsFollowingFromTheHeldSide() {
        var fold = ToolbarFold(collapsed: true, items: 3)
        #expect(change(&fold) { $0.set(false, heldRight: true, at: 10, animated: true) })
        let look = { (t: Double) in fold.look(at: 10 + t, heldRight: true) }
        #expect(look(0).extent == 0)
        let extents = stride(from: 0.0, through: 0.56, by: 0.002).map { look($0).extent }
        let peak = extents.max()!
        #expect(peak > 1.04 && peak < 1.065, "one overshoot of about 5%: \(peak)")
        #expect(abs(look(0.555).extent - 1) < 0.004, "settled by 560ms")
        #expect(extents.firstIndex { $0 > 0.8 }! < 75, "most of the way within 150ms")

        // Held right: the collapse button (the rightmost) leads; they come in from the right, a little small.
        let early = look(0.08)
        #expect(early.items[2].opacity > early.items[1].opacity && early.items[1].opacity > early.items[0].opacity)
        #expect(look(0.02).items == Array(repeating: ToolbarLook.Part(opacity: 0, offset: 10, scale: 0.94), count: 3))
        // The round button turns away anticlockwise as it fades, gone by 180ms.
        #expect(look(0.09).button.turn < 0 && look(0.09).button.scale < 1)
        #expect(look(0.18).button.opacity == 0)
        #expect(fold.moving(at: 10.3) && !fold.moving(at: 10.6))
        #expect(look(0.6) == .resting(collapsed: false, toward: 1, items: 3))
    }

    @Test func itFoldsOnTheSettleCurveFarButtonsFirstThenTheButtonTurnsIn() {
        var fold = ToolbarFold(collapsed: false, items: 3)
        #expect(change(&fold) { $0.set(true, heldRight: false, at: 0, animated: true) })
        let look = { (t: Double) in fold.look(at: t, heldRight: false) }
        let extents = stride(from: 0.0, through: 0.42, by: 0.01).map { look($0).extent }
        #expect(zip(extents, extents.dropFirst()).allSatisfy { $0 >= $1 }, "no overshoot")
        #expect(extents.last! < 0.001)
        // Held left: the rightmost goes first, toward the left, and smaller.
        let early = look(0.05)
        #expect(early.items[2].opacity < early.items[1].opacity && early.items[1].opacity < early.items[0].opacity)
        #expect(look(0.2).items.allSatisfy { $0.opacity == 0 && $0.offset == -8 && abs($0.scale - 0.92) < 1e-9 })
        // The round button waits for the edge, then turns in clockwise from a quarter turn back; the count pops last.
        #expect(look(0.16).button == ToolbarLook.Part(opacity: 0, scale: 0.5, turn: 90))
        #expect(look(0.3).button.opacity > 0.5 && look(0.3).button.turn > 0)
        #expect(look(0.39).badge == ToolbarLook.Part(opacity: 0, scale: 0.4))
        #expect(look(0.5).badge.scale > 0.4)
        #expect(look(0.8) == .resting(collapsed: true, toward: -1, items: 3))
    }

    @Test(arguments: [0.05, 0.2, 0.35, 0.5] as [Double])
    func aChangeOfMindTurnsAroundFromWhereItIs(after delay: Double) {
        for opening in [true, false] {
            var fold = ToolbarFold(collapsed: opening, items: 3)
            _ = fold.set(!opening, heldRight: true, at: 0, animated: true)
            let before = fold.look(at: delay, heldRight: true)
            #expect(change(&fold) { $0.set(opening, heldRight: true, at: delay, animated: true) })
            let after = fold.look(at: delay, heldRight: true)
            // Nothing that shows jumps: the width, and every part that can be seen.
            #expect(after.extent == before.extent)
            for (a, b) in zip([after.button, after.badge] + after.items, [before.button, before.badge] + before.items) {
                #expect(a.opacity == b.opacity)
                if b.opacity >= 0.01 { #expect(a == b) }
            }
            #expect(abs(fold.look(at: delay + 1.0 / 120, heldRight: true).extent - before.extent) < 0.12)
            #expect(fold.collapsed == opening)
        }
    }

    @Test func withoutAnimationItIsThereAtOnce() {
        var fold = ToolbarFold(collapsed: false, items: 3)
        #expect(change(&fold) { $0.set(true, heldRight: true, at: 0, animated: false) })
        #expect(fold.morph == nil && !fold.moving(at: 0))
        #expect(fold.look(at: 0, heldRight: true) == .resting(collapsed: true, toward: 1, items: 3))
        #expect(change(&fold) { $0.annotating(true, heldRight: true, at: 0, animated: false) })
        #expect(fold.look(at: 0, heldRight: true) == .resting(collapsed: false, toward: 1, items: 3))
    }

    @Test func theCurvesAreTheWebToolbars() {
        // cubic-bezier(0.32, 0.72, 0, 1) and ease-in, against values found by bisection elsewhere.
        #expect(abs(Motion.Curve.settle.progress(0.25) - 0.7791) < 0.0005)
        #expect(abs(Motion.Curve.settle.progress(0.5) - 0.9548) < 0.0005)
        #expect(abs(Motion.Curve.easeIn.progress(0.5) - 0.3154) < 0.0005)
        #expect(Motion.Curve.spring.progress(0) == 0 && Motion.Curve.spring.progress(1) == 1)
        #expect(abs(Motion.Curve.spring.progress(0.999) - 1) < 0.004, "close enough at the end that ending there shows no jump")
    }
}
