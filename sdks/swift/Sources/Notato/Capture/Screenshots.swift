#if canImport(UIKit)
import UIKit

/// The app's window as it was on screen, with what to cover in it. Notato's own window is separate, so it is never in it.
typealias CapturedScreen = Captured<UIImage>

/// The two pictures a note carries: the window with the target outlined, and a crop around it.
struct ComposedScreenshots {
    let refs: Screenshots
    let assets: [String: Data]
}

@MainActor
enum ScreenshotTaker {
    /// The window now, and what to cover in it now: `elements` (scanned just before) and the private views.
    static func capture(_ window: UIWindow, elements: [ScreenElement], privateViews: [CGRect], maskInputs: Bool) -> CapturedScreen? {
        let bounds = window.bounds
        guard bounds.width > 0, bounds.height > 0 else { return nil }
        let format = UIGraphicsImageRendererFormat()
        format.scale = window.traitCollection.displayScale > 0 ? window.traitCollection.displayScale : 2
        format.opaque = true
        let image = UIGraphicsImageRenderer(bounds: bounds, format: format).image { _ in
            _ = window.drawHierarchy(in: bounds, afterScreenUpdates: false)
        }
        return CapturedScreen(image, size: bounds.size, elements: elements, privateViews: privateViews, maskInputs: maskInputs)
    }
}

enum ScreenshotComposer {
    private static let outline = UIColor(red: 0.937, green: 0.267, blue: 0.267, alpha: 1)
    private static let maskColor = UIColor(red: 0.612, green: 0.639, blue: 0.686, alpha: 1)
    private static let pinColor = UIColor(red: 0.145, green: 0.388, blue: 0.922, alpha: 1)
    private static let cropPadding: CGFloat = 24

    /// The two pictures, covered where `screen` says: what was private when it was taken.
    static func compose(_ screen: CapturedScreen, targets: [CGRect], pin: Int?, maxScale: Double) -> ComposedScreenshots {
        let masks = screen.covers
        let scale = max(1, min(screen.picture.scale, CGFloat(maxScale)))
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        format.opaque = true
        let bounds = CGRect(origin: .zero, size: screen.size)

        func draw(_ context: CGContext, offset: CGPoint) {
            screen.picture.draw(in: bounds.offsetBy(dx: -offset.x, dy: -offset.y))
            maskColor.setFill()
            for mask in masks { context.fill(mask.offsetBy(dx: -offset.x, dy: -offset.y)) }
            outline.setStroke()
            context.setLineWidth(2)
            for target in targets { context.stroke(target.offsetBy(dx: -offset.x, dy: -offset.y).insetBy(dx: 1, dy: 1)) }
        }

        let full = UIGraphicsImageRenderer(bounds: bounds, format: format).pngData { renderer in
            draw(renderer.cgContext, offset: .zero)
            if let pin, let first = targets.first { drawPin(pin, at: first) }
        }
        var refs = Screenshots(full: AssetRef(id: Hash.sha256(full), mime: "image/png",
                                              w: Int((screen.size.width * scale).rounded()), h: Int((screen.size.height * scale).rounded())))
        var assets = [refs.full.id: full]

        if let union = targets.dropFirst().reduce(targets.first, { $0?.union($1) }) {
            let area = union.insetBy(dx: -cropPadding, dy: -cropPadding).intersection(bounds)
            if area.width >= 4, area.height >= 4 {
                let crop = UIGraphicsImageRenderer(size: area.size, format: format).pngData { renderer in
                    draw(renderer.cgContext, offset: area.origin)
                }
                let ref = AssetRef(id: Hash.sha256(crop), mime: "image/png", w: Int((area.width * scale).rounded()), h: Int((area.height * scale).rounded()))
                refs.crop = ref
                assets[ref.id] = crop
            }
        }
        return ComposedScreenshots(refs: refs, assets: assets)
    }

    private static func drawPin(_ number: Int, at target: CGRect) {
        let radius: CGFloat = 12
        let center = CGPoint(x: target.maxX - 2, y: max(radius, target.minY))
        let circle = UIBezierPath(arcCenter: center, radius: radius, startAngle: 0, endAngle: .pi * 2, clockwise: true)
        pinColor.setFill()
        circle.fill()
        UIColor.white.setStroke()
        circle.lineWidth = 2
        circle.stroke()
        let text = "\(number)" as NSString
        let attributes: [NSAttributedString.Key: Any] = [.font: UIFont.boldSystemFont(ofSize: 12), .foregroundColor: UIColor.white]
        let size = text.size(withAttributes: attributes)
        text.draw(at: CGPoint(x: center.x - size.width / 2, y: center.y - size.height / 2), withAttributes: attributes)
    }
}
#endif
