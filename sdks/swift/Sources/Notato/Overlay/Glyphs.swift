#if canImport(UIKit)
import SwiftUI
import UIKit

// The overlay's icons, drawn in a 24-point box as the web toolbar's are, and the Notato potato.

/// The Notato potato, tilted as on the web toolbar.
struct Potato: View {
    let size: CGFloat

    /// From the package's resources (`notato@2x.png`, `notato@3x.png`).
    @MainActor private static let image = UIImage(named: "notato", in: Bundle.module, compatibleWith: nil)

    var body: some View {
        Group {
            if let image = Self.image {
                Image(uiImage: image).resizable().interpolation(.high).scaledToFit()
            } else {
                NoteGlyph().stroke(Palette.barText, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round)).padding(size * 0.25)
            }
        }
        .frame(width: size, height: size)
        .rotationEffect(.degrees(-8))
        .accessibilityHidden(true)
    }
}

extension Path {
    /// From a 24-point box to `rect`.
    fileprivate func fitted(to rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / 24
        return applying(CGAffineTransform(translationX: rect.minX, y: rect.minY).scaledBy(x: scale, y: scale))
    }
}

/// Six dots: where to hold the bar.
struct GripGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        for (x, y) in [(9, 6), (15, 6), (9, 12), (15, 12), (9, 18), (15, 18)] as [(CGFloat, CGFloat)] {
            path.addEllipse(in: CGRect(x: x - 1.6, y: y - 1.6, width: 3.2, height: 3.2))
        }
        return path.fitted(to: rect)
    }
}

/// Annotate's crosshair: a ring with four ticks across it.
struct CrosshairGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.addEllipse(in: CGRect(x: 4, y: 4, width: 16, height: 16))
        for (from, to) in [((12, 1.5), (12, 6)), ((12, 18), (12, 22.5)), ((1.5, 12), (6, 12)), ((18, 12), (22.5, 12))] as [((CGFloat, CGFloat), (CGFloat, CGFloat))] {
            path.move(to: CGPoint(x: from.0, y: from.1))
            path.addLine(to: CGPoint(x: to.0, y: to.1))
        }
        return path.fitted(to: rect)
    }
}

/// The menu's three dots.
struct DotsGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        for x in [5, 12, 19] as [CGFloat] { path.addEllipse(in: CGRect(x: x - 1.8, y: 10.2, width: 3.6, height: 3.6)) }
        return path.fitted(to: rect)
    }
}

/// The fold's chevron, pointing right or left.
struct ChevronGlyph: Shape {
    let right: Bool

    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: right ? 9 : 15, y: 6))
        path.addLine(to: CGPoint(x: right ? 15 : 9, y: 12))
        path.addLine(to: CGPoint(x: right ? 9 : 15, y: 18))
        return path.fitted(to: rect)
    }
}

/// A note with its corner folded over: drawn where the potato cannot be loaded.
struct NoteGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        // The outline, with the bottom right corner cut off where it folds.
        path.move(to: CGPoint(x: 15, y: 21))
        path.addLine(to: CGPoint(x: 5, y: 21))
        path.addArc(tangent1End: CGPoint(x: 3, y: 21), tangent2End: CGPoint(x: 3, y: 3), radius: 2)
        path.addArc(tangent1End: CGPoint(x: 3, y: 3), tangent2End: CGPoint(x: 21, y: 3), radius: 2)
        path.addArc(tangent1End: CGPoint(x: 21, y: 3), tangent2End: CGPoint(x: 21, y: 21), radius: 2)
        path.addLine(to: CGPoint(x: 21, y: 15))
        path.closeSubpath()
        // The fold.
        path.move(to: CGPoint(x: 15, y: 21))
        path.addLine(to: CGPoint(x: 15, y: 17))
        path.addArc(tangent1End: CGPoint(x: 15, y: 15), tangent2End: CGPoint(x: 21, y: 15), radius: 2)
        path.addLine(to: CGPoint(x: 21, y: 15))
        // Two lines of writing.
        path.move(to: CGPoint(x: 7.5, y: 8))
        path.addLine(to: CGPoint(x: 16.5, y: 8))
        path.move(to: CGPoint(x: 7.5, y: 12))
        path.addLine(to: CGPoint(x: 12.5, y: 12))
        return path.fitted(to: rect)
    }
}
#endif
