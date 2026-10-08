import Foundation

/// Where pins go, worked out without a screen: each at its element's top right, and moved aside when another pin is
/// there already (several notes on one element, or on elements next to each other).
enum PinLayout {
    /// The most pins drawn on one screen: the newest, as the React Native and Flutter SDKs draw. The Notes list and the
    /// board have every note.
    static let maxPins = 150
    /// How far apart two pins' origins must be not to overlap (they are 24 points across).
    static let clearance: CGFloat = 20
    /// The step from one place tried to the next.
    static let step: CGFloat = 22
    /// Below the status bar.
    static let top: CGFloat = 50
    /// The least room between a pin and the window's sides.
    static let margin: CGFloat = 2
    /// Places tried to each side of the first, and rows of them, before a pin is let overlap another.
    static let sideways = 8
    static let rows = 4

    /// The places tried for a pin, from the first: leftward along its row, then rightward, then the same on the rows
    /// below. A fixed number (68), so a crowded or narrow window cannot keep it looking.
    private static let tries: [CGPoint] = {
        let offsets: [CGFloat] = [0] + (1...sideways).map { -CGFloat($0) * step } + (1...sideways).map { CGFloat($0) * step }
        return (0..<rows).flatMap { row in offsets.map { CGPoint(x: $0, y: CGFloat(row) * step) } }
    }()

    /// The top left of each pin, in order: the first to claim a place keeps it. Each place tried is checked against
    /// the pins near it only (`Grid`), so a screen of pins is laid out in time in proportion to their number.
    static func place(_ rects: [CGRect], width: CGFloat) -> [CGPoint] {
        var grid = Grid()
        var placed: [CGPoint] = []
        placed.reserveCapacity(rects.count)
        let maxX = max(margin, width.isFinite ? width - 26 : margin)
        for rect in rects {
            // A frame that is not a place (an empty one, from a broken accessibility element) goes to the top left.
            let usable = rect.minX.isFinite && rect.minY.isFinite && rect.maxX.isFinite ? rect : CGRect(x: 0, y: top, width: 0, height: 0)
            let first = CGPoint(x: min(max(margin, usable.maxX - 12), maxX), y: max(top, usable.minY - 12))
            let spot = tries.lazy
                .map { CGPoint(x: first.x + $0.x, y: first.y + $0.y) }
                .first { $0.x >= margin && $0.x <= maxX && grid.isFree($0) } ?? first
            grid.insert(spot)
            placed.append(spot)
        }
        return placed
    }

    /// The pins placed so far, in square cells `clearance` across. Two pins too close to each other are in the same
    /// cell or in cells next to each other, so a place is checked against the pins of nine cells, not all of them.
    struct Grid {
        private struct Cell: Hashable {
            let x: Int
            let y: Int
        }

        private var cells: [Cell: [CGPoint]] = [:]

        private static func index(_ value: CGFloat) -> Int {
            // Clamped, so a place far off the window still has a cell (and never traps on the way to an Int).
            Int(min(max((value / clearance).rounded(.down), -1e9), 1e9))
        }

        /// Its own cell first: any pin there is too close.
        private static let around = [(0, 0), (-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]

        func isFree(_ spot: CGPoint) -> Bool {
            let x = Self.index(spot.x), y = Self.index(spot.y)
            for (dx, dy) in Self.around {
                guard let near = cells[Cell(x: x + dx, y: y + dy)] else { continue }
                if near.contains(where: { abs($0.x - spot.x) < clearance && abs($0.y - spot.y) < clearance }) { return false }
            }
            return true
        }

        mutating func insert(_ point: CGPoint) {
            let cell = Cell(x: Self.index(point.x), y: Self.index(point.y))
            // A crowd let overlap lands on the same few places: one copy of each is all a check needs.
            if cells[cell]?.contains(point) == true { return }
            cells[cell, default: []].append(point)
        }
    }
}

/// A pin as the overlay draws it, placed: the overlay draws these and works nothing out.
struct PinPlacement: Identifiable, Equatable {
    let id: String
    let number: Int
    let status: String
    /// The frame of the element it is about: where it was found on screen, else where the note was made (`detached`).
    let rect: CGRect
    /// Its top left: at the element's top right, moved aside from the pins before it (`PinLayout`).
    let origin: CGPoint
    let detached: Bool
    let pending: Bool
}

/// One window's pins, kept from one tick of the overlay to the next: where each note's element was found and where its
/// pin went. The costly part (finding the elements, laying the pins out) is done again only when there is something
/// new to do it with: a scan of the screen, a note added or gone, another width. Every tick only reads each note's
/// status, so a pin turns amber or green as soon as its note does.
@MainActor
final class PinBoard {
    private var found: [String: (rect: CGRect, detached: Bool)] = [:]
    private var laidOut: (ids: [String], width: CGFloat, origins: [CGPoint])?

    /// Forgets everything: the screen changed.
    func reset() {
        found = [:]
        laidOut = nil
    }

    /// The pins of `pinned` (`Notato.notes(onRoute:)`). `scanned` says the screen was read again since the last call,
    /// so every element is looked for again; otherwise only a note not placed yet is. `locate` finds a note's element
    /// on screen, or nil, when it is not there and the pin goes where the note was made.
    func pins(for pinned: [(number: Int, record: NoteRecord)], width: CGFloat, scanned: Bool,
              locate: (NoteRecord) -> CGRect?) -> [PinPlacement] {
        if scanned { found = [:] }
        var moved = scanned
        for (_, record) in pinned where found[record.id] == nil {
            let rect = locate(record)
            found[record.id] = (rect ?? Self.stored(record), rect == nil)
            moved = true
        }
        let ids = pinned.map(\.record.id)
        let origins: [CGPoint]
        if !moved, let laidOut, laidOut.ids == ids, laidOut.width == width {
            origins = laidOut.origins
        } else {
            origins = PinLayout.place(ids.map { found[$0]?.rect ?? .zero }, width: width)
            laidOut = (ids, width, origins)
        }
        return pinned.enumerated().map { index, pin in
            let place = found[pin.record.id] ?? (Self.stored(pin.record), true)
            return PinPlacement(id: pin.record.id, number: pin.number, status: pin.record.annotation.status, rect: place.rect,
                                origin: origins[index], detached: place.detached, pending: pin.record.pending)
        }
    }

    /// Where the note was made.
    private static func stored(_ record: NoteRecord) -> CGRect {
        let rect = record.annotation.target.rect
        return CGRect(x: rect.x, y: rect.y, width: rect.w, height: rect.h)
    }
}
