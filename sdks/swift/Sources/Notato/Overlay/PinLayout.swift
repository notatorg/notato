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
    // Spelled out step by step: as one expression it is too much for the Swift 6.1 type checker (Xcode 16).
    private static let tries: [CGPoint] = {
        let left: [CGFloat] = (1...sideways).map { (n: Int) -> CGFloat in -CGFloat(n) * step }
        let right: [CGFloat] = (1...sideways).map { (n: Int) -> CGFloat in CGFloat(n) * step }
        let offsets: [CGFloat] = [0] + left + right
        var places: [CGPoint] = []
        for row in 0..<rows {
            let y = CGFloat(row) * step
            places += offsets.map { (x: CGFloat) -> CGPoint in CGPoint(x: x, y: y) }
        }
        return places
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
    /// How many times it has jumped too far to be seen moving: it fades out where it was and in where it went instead.
    var hop = 0

    /// Who it is to the view drawing it: a pin that hops is another pin, which comes in as the old one goes.
    var key: String { "\(id)#\(hop)" }
}

/// One window's pins, kept from one placing to the next: where each note's element was found, how to follow it, and
/// where its pin went. The costly part (reading the screen, laying the pins out) is done again only when there is
/// something new to do it with: a scan of the screen, a note added or gone, another width. In between, a pin whose
/// element can be followed (a marked view, or an element in a scroll view) moves with it on every frame (`follow`), by
/// as much as the element moved since the pins were laid out. Every placing reads each note's status, so a pin turns
/// amber or green as soon as its note does.
@MainActor
final class PinBoard {
    /// Where a note's element was found, and how to read where it is now without reading the screen.
    struct Located {
        var rect: CGRect
        /// The element's frame now, or nil when it is out of sight (scrolled out of its scroll view, or gone with its
        /// marked view). None for an element only a scan of the screen can find again.
        var follow: (@MainActor () -> CGRect?)?

        init(rect: CGRect, follow: (@MainActor () -> CGRect?)? = nil) {
            self.rect = rect
            self.follow = follow
        }
    }

    private struct Found {
        var rect: CGRect
        var detached: Bool
        /// Out of sight: no pin.
        var hidden: Bool
        var follow: (@MainActor () -> CGRect?)?
    }

    private var found: [String: Found] = [:]
    /// The pins as last laid out: each one's top left, and its element's frame then.
    private var laidOut: (ids: [String], width: CGFloat, places: [String: (origin: CGPoint, rect: CGRect)])?
    /// The notes last placed, for `placements` after a `follow`.
    private var shown: (pinned: [(number: Int, record: NoteRecord)], width: CGFloat)?

    /// Whether any pin moves with its element between scans.
    var follows: Bool { found.values.contains { $0.follow != nil } }

    /// Forgets everything: the screen changed.
    func reset() {
        found = [:]
        laidOut = nil
        shown = nil
    }

    /// The pins of `pinned` (`Notato.notes(onRoute:)`). `scanned` says the screen was read again since the last call,
    /// so every element is looked for again; otherwise only a note not placed yet is. `locate` finds a note's element
    /// on screen, or nil, when it is not there and the pin goes where the note was made.
    func pins(for pinned: [(number: Int, record: NoteRecord)], width: CGFloat, scanned: Bool,
              locate: (NoteRecord) -> Located?) -> [PinPlacement] {
        var moved = scanned
        if scanned {
            var next: [String: Found] = [:]
            for (_, record) in pinned { next[record.id] = find(record, locate) }
            found = next
        } else {
            for (_, record) in pinned where found[record.id] == nil {
                found[record.id] = find(record, locate)
                moved = true
            }
        }
        let ids = pinned.map(\.record.id)
        if moved || laidOut == nil || laidOut?.ids != ids || laidOut?.width != width {
            let showing = ids.filter { found[$0]?.hidden == false }
            let rects = showing.map { found[$0]?.rect ?? .zero }
            let origins = PinLayout.place(rects, width: width)
            var places: [String: (origin: CGPoint, rect: CGRect)] = [:]
            for (index, id) in showing.enumerated() { places[id] = (origins[index], rects[index]) }
            laidOut = (ids, width, places)
        }
        shown = (pinned, width)
        return placements()
    }

    /// Where `locate` says, else (for an element followed out of sight since) nowhere, else where the note was made.
    private func find(_ record: NoteRecord, _ locate: (NoteRecord) -> Located?) -> Found {
        if let located = locate(record) { return Found(rect: located.rect, detached: false, hidden: false, follow: located.follow) }
        // Scrolled out of sight: its pin stays out of sight with it, rather than going back to where the note was made.
        if let known = found[record.id], let follow = known.follow, follow() == nil {
            return Found(rect: known.rect, detached: false, hidden: true, follow: follow)
        }
        return Found(rect: Self.stored(record), detached: true, hidden: false, follow: nil)
    }

    /// Reads again where each followed element is: cheap (a frame converted to the window), so it can be done on every
    /// frame of a scroll. Returns whether any pin moved, or went out of sight or came back into it.
    func follow() -> Bool {
        var moved = false
        for (id, entry) in found {
            guard let follow = entry.follow else { continue }
            let now = follow()
            guard (now == nil) != entry.hidden || (now != nil && now != entry.rect) else { continue }
            var next = entry
            if let now { next.rect = now }
            next.hidden = now == nil
            found[id] = next
            moved = true
        }
        return moved
    }

    /// The pins as they are now, for the notes last placed.
    func placements() -> [PinPlacement] {
        guard let shown else { return [] }
        return shown.pinned.compactMap { number, record in
            guard let place = found[record.id], !place.hidden else { return nil }
            let origin: CGPoint
            if let laid = laidOut?.places[record.id] {
                // Moved with its element since the pins were laid out: by as much as the element's top right moved.
                origin = CGPoint(x: laid.origin.x + place.rect.maxX - laid.rect.maxX, y: laid.origin.y + place.rect.minY - laid.rect.minY)
            } else {
                // Come into sight since: at its element, until the pins are next laid out.
                origin = PinLayout.place([place.rect], width: shown.width)[0]
            }
            return PinPlacement(id: record.id, number: number, status: record.annotation.status, rect: place.rect,
                                origin: origin, detached: place.detached, pending: record.pending)
        }
    }

    /// Where the note was made.
    private static func stored(_ record: NoteRecord) -> CGRect {
        let rect = record.annotation.target.rect
        return CGRect(x: rect.x, y: rect.y, width: rect.w, height: rect.h)
    }
}
