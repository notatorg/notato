#if canImport(UIKit)
import UIKit

/// What the agent is told about the device and the app, as `context.ios`.
struct DeviceInfoContext: Codable, Sendable {
    var screen: String?
    var screenFile: String?
    var screens: [String]?
    var marked: [String]?
    var controllers: [String]?
    var system: String
    var device: String
    var idiom: String
    var simulator: Bool
    var orientation: String
    var colorScheme: String
    var contentSize: String
    var locale: String
    var bundleId: String
}

@MainActor
enum DeviceContext {
    static var model: String {
        var info = utsname()
        uname(&info)
        let machine = withUnsafeBytes(of: &info.machine) { raw in String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self) }
        return ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] ?? machine
    }

    static var simulator: Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        return false
        #endif
    }

    static func userAgent(_ configuration: NotatoConfiguration) -> String {
        let device = UIDevice.current
        return "\(AppInfo.name(configuration))/\(AppInfo.version(configuration) ?? "") (\(device.systemName) \(device.systemVersion); \(model)\(simulator ? "; simulator" : "")) SwiftUI"
    }

    /// The kind of device, by name: the raw values have a gap (there is no 4), so they cannot index a list.
    static func idiom(_ idiom: UIUserInterfaceIdiom) -> String {
        switch idiom {
        case .phone: return "phone"
        case .pad: return "pad"
        case .tv: return "tv"
        case .carPlay: return "carPlay"
        case .mac: return "mac"
        case .vision: return "vision"
        case .unspecified: return "unspecified"
        @unknown default: return "unspecified"
        }
    }

    static func describe(session: OverlaySession, hooks: PlatformHooks, element: ScreenElement, configuration: NotatoConfiguration) -> DeviceInfoContext {
        let around = MarkRegistry.shared.around(element.frame, in: session.appWindow)
        let screens = MarkRegistry.shared.screens(in: session.appWindow)
        let screen = around.last(where: { $0.kind == .screen }) ?? screens.last
        let traits = session.appWindow?.traitCollection
        return DeviceInfoContext(
            screen: screen?.name,
            screenFile: screen.map { SourcePaths.relative($0.file, root: configuration.sourceRoot) + ":\($0.line)" },
            screens: screens.map(\.name).nilIfEmpty,
            marked: around.map(\.name).nilIfEmpty,
            controllers: hooks.controllerChain(session).nilIfEmpty,
            system: "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)",
            device: model,
            idiom: idiom(UIDevice.current.userInterfaceIdiom),
            simulator: simulator,
            orientation: (session.scene?.interfaceOrientation.isLandscape ?? false) ? "landscape" : "portrait",
            colorScheme: traits?.userInterfaceStyle == .dark ? "dark" : "light",
            contentSize: traits?.preferredContentSizeCategory.rawValue ?? "",
            locale: Locale.current.identifier,
            bundleId: AppInfo.bundleId)
    }
}

extension Array {
    var nilIfEmpty: [Element]? { isEmpty ? nil : self }
}
#endif
