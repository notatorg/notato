#if canImport(UIKit)
import SwiftUI
import UIKit

/// Notato's colours: the web toolbar's (`sdks/browser/src/ui/styles.ts`), so the overlay reads as the same product
/// as the board. The bar is always dark; sheets and cards follow the app's light or dark.
enum Palette {
    // ---- the bar, the hint and the toast
    static let bar = Color(hex: 0x17181b)
    static let barText = Color(hex: 0xeceded)
    static let barMuted = Color(hex: 0x8b8f97)
    /// A pressed button on the bar, and the count's badge.
    static let barPressed = Color(hex: 0x2a2c31)
    static let barLine = Color(hex: 0x33353a)
    static let barAccent = Color(hex: 0x45bfa8)
    static let onBarAccent = Color(hex: 0x0b1f1b)

    // ---- sheets and cards
    static let background = Color(light: 0xffffff, dark: 0x1d1e21)
    static let text = Color(light: 0x1d1f22, dark: 0xe6e7ea)
    static let muted = Color(light: 0x686c72, dark: 0x8f939b)
    static let line = Color(light: 0xe4e4df, dark: 0x2f3136)
    /// Icon tiles and text fields.
    static let soft = Color(light: 0xf2f2ef, dark: 0x26272b)
    /// Behind a sheet.
    static let scrim = Color(hex: 0x121418, opacity: 0.32)
    /// The shadows under a pin and under the bar, each given its opacity where it is drawn.
    static let pinShadow = Color(hex: 0x141820)
    static let barShadow = Color(hex: 0x0f1114)

    // ---- the brand
    static let accent = Color(hex: 0x1f8a78)
    static let accentPressed = Color(hex: 0x187465)
    static let danger = Color(hex: 0xd6453d)
    static let selection = Color(hex: 0xe5484d)

    // ---- the server
    static let connected = Color(hex: 0x2e9a5b)
    static let connecting = Color(hex: 0xe9b44c)
    static let offline = Color(hex: 0xef6b5e)

    /// A pin's colour for its note's status.
    static func status(_ status: String) -> Color {
        switch status {
        case Status.acknowledged: return Color(hex: 0xd99a1e)
        case Status.resolved: return Color(hex: 0x2e9a5b)
        case Status.revertRequested: return Color(hex: 0x8b5cf6)
        case Status.variantChosen: return Color(hex: 0x0891b2)
        case Status.reverted: return Color(hex: 0x64748b)
        case Status.dismissed: return Color(hex: 0x9a9a9a)
        default: return accent
        }
    }
}

extension Color {
    fileprivate init(hex: UInt32, opacity: Double = 1) {
        self.init(.sRGB, red: Double(hex >> 16 & 0xff) / 255, green: Double(hex >> 8 & 0xff) / 255, blue: Double(hex & 0xff) / 255, opacity: opacity)
    }

    /// One colour in light mode and another in dark, as the overlay's colour scheme has it.
    fileprivate init(light: UInt32, dark: UInt32) {
        func ui(_ hex: UInt32) -> UIColor {
            UIColor(red: CGFloat(hex >> 16 & 0xff) / 255, green: CGFloat(hex >> 8 & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
        }
        let lightColor = ui(light), darkColor = ui(dark)
        self.init(uiColor: UIColor { $0.userInterfaceStyle == .dark ? darkColor : lightColor })
    }
}
#endif
