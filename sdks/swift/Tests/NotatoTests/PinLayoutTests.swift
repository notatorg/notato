import Foundation
import Testing
@testable import Notato

@Suite("Pins")
struct PinLayoutTests {
    private func noOverlap(_ points: [CGPoint]) -> Bool {
        for (i, a) in points.enumerated() {
            for b in points[(i + 1)...] where abs(a.x - b.x) < PinLayout.clearance && abs(a.y - b.y) < PinLayout.clearance { return false }
        }
        return true
    }

    @Test func twoNotesOnAnElementAtTheLeftEdgeSitSideBySide() {
        // The element's right edge is under 34 points: the second pin cannot go left of the first, so it goes right.
        let rect = CGRect(x: 0, y: 300, width: 30, height: 30)
        let points = PinLayout.place([rect, rect], width: 402)
        #expect(points.count == 2 && noOverlap(points))
        #expect(points[0] == CGPoint(x: 18, y: 288))
    }

    @Test(arguments: [2, 5, 12, 40])
    func manyNotesNearTheLeftEdgeAllFindAPlace(count: Int) {
        let rect = CGRect(x: 4, y: 400, width: 60, height: 44)
        let points = PinLayout.place(Array(repeating: rect, count: count), width: 402)
        #expect(points.count == count)
        #expect(points.allSatisfy { $0.x >= PinLayout.margin && $0.x <= 402 - 26 })
        if count <= 12 { #expect(noOverlap(points)) }
    }

    @Test func beforeTheWindowsWidthIsKnownItStillEnds() {
        let rect = CGRect(x: 100, y: 200, width: 80, height: 40)
        let points = PinLayout.place(Array(repeating: rect, count: 6), width: 0)
        #expect(points.count == 6)
        #expect(noOverlap(Array(points.prefix(PinLayout.rows))), "rows below, then on top of each other")
    }

    @Test func aCrowdTooBigForTheRoomOverlapsRatherThanHangs() {
        let rect = CGRect(x: 0, y: 60, width: 20, height: 20)
        let points = PinLayout.place(Array(repeating: rect, count: 300), width: 120)
        #expect(points.count == 300)
    }

    @Test func notesOnDifferentElementsStayAtTheirElements() {
        let points = PinLayout.place([CGRect(x: 16, y: 217, width: 370, height: 40), CGRect(x: 16, y: 300, width: 370, height: 40)], width: 402)
        #expect(points == [CGPoint(x: 374, y: 205), CGPoint(x: 374, y: 288)])
    }
}

@Suite("Pin layout at scale")
struct PinGridTests {
    /// The layout worked out the simple way, to compare with: every place checked against every pin.
    private func reference(_ rects: [CGRect], width: CGFloat) -> [CGPoint] {
        var placed: [CGPoint] = []
        let maxX = max(PinLayout.margin, width - 26)
        let left: [CGFloat] = (1...PinLayout.sideways).map { (n: Int) -> CGFloat in -CGFloat(n) * PinLayout.step }
        let right: [CGFloat] = (1...PinLayout.sideways).map { (n: Int) -> CGFloat in CGFloat(n) * PinLayout.step }
        let offsets: [CGFloat] = [0] + left + right
        for rect in rects {
            let first = CGPoint(x: min(max(PinLayout.margin, rect.maxX - 12), maxX), y: max(PinLayout.top, rect.minY - 12))
            var found: CGPoint?
            search: for row in 0..<PinLayout.rows {
                for offset in offsets {
                    let spot = CGPoint(x: first.x + offset, y: first.y + CGFloat(row) * PinLayout.step)
                    guard spot.x >= PinLayout.margin, spot.x <= maxX else { continue }
                    if !placed.contains(where: { abs($0.x - spot.x) < PinLayout.clearance && abs($0.y - spot.y) < PinLayout.clearance }) {
                        found = spot
                        break search
                    }
                }
            }
            placed.append(found ?? first)
        }
        return placed
    }

    @Test func theGridPlacesEveryPinWhereCheckingEveryPinWould() {
        var generator = SystemRandomNumberGenerator()
        for _ in 0..<20 {
            let rects = (0..<300).map { _ in
                CGRect(x: CGFloat.random(in: -20...420, using: &generator).rounded(), y: CGFloat.random(in: 0...900, using: &generator).rounded(),
                       width: CGFloat.random(in: 0...200, using: &generator).rounded(), height: 40)
            }
            #expect(PinLayout.place(rects, width: 402) == reference(rects, width: 402))
        }
        let crowd = Array(repeating: CGRect(x: 100, y: 300, width: 40, height: 40), count: 400)
        #expect(PinLayout.place(crowd, width: 402) == reference(crowd, width: 402))
    }

    @Test func aThousandPinsOnOneSpotAreLaidOutInTimeInProportionToTheirNumber() {
        // Each place tried looks at nine cells, not at every pin placed: checking every pin takes seconds here.
        let crowd = Array(repeating: CGRect(x: 100, y: 300, width: 40, height: 40), count: 1_000)
        let elapsed = ContinuousClock().measure { _ = PinLayout.place(crowd, width: 402) }
        #expect(elapsed < .seconds(2), "\(elapsed)")
    }

    @Test func aFrameThatIsNoPlaceStillGetsOne() {
        let points = PinLayout.place([.null, .infinite, CGRect(x: CGFloat.nan, y: 0, width: 1, height: 1), CGRect(x: 0, y: 1e300, width: 1, height: 1)], width: 402)
        #expect(points.count == 4)
        #expect(points.allSatisfy { $0.x.isFinite && $0.y.isFinite })
    }
}
