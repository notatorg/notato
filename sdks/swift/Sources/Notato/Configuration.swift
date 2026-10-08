import Foundation

/// Who annotates, and where the notes go. The same three modes as every Notato SDK.
public enum NotatoMode: String, Sendable, Codable, CaseIterable {
    /// The developer, live to a local `notato dev` server that your coding agent reads over MCP.
    case dev
    /// A tester. Notes are kept on the device and packaged as a zip, and uploaded when a server is set.
    case test
    /// An AI agent driving the app. Like dev, and the app also takes `notato_annotate` requests.
    case agent
}

/// The corner the toolbar starts in, until someone drags it elsewhere.
public enum ToolbarCorner: String, Sendable, Codable, CaseIterable {
    case bottomTrailing, bottomLeading, topTrailing, topLeading
}

/// Settings for Notato. Set them in code, or load them from the app's Info.plist (a `Notato` dictionary) or a JSON
/// file, with `NOTATO_*` environment variables over either. Choices made at runtime (on or off, the toolbar, a name,
/// a server typed in) are remembered on the device and win over these until reset.
public struct NotatoConfiguration: Sendable, Equatable {
    /// What `notato dev` listens on.
    public static let defaultServer = URL(string: "http://localhost:4747")!

    /// Project id on the server. Letters, digits and `. _ - @`, but not only dots.
    public var project: String
    /// Whether Notato is on when the app starts. `Notato.shared.enable()` and `.disable()` change it at runtime.
    public var enabled: Bool = true
    /// Who annotates, and where the notes go.
    public var mode: NotatoMode = .dev
    /// The server. Defaults to `localhost:4747` in dev and agent mode and to none in test mode.
    public var server: URL?
    /// Leave the server out entirely, even in dev mode: notes stay on the device.
    public var noServer: Bool = false
    /// A project token (`notato_…`) for a shared `notato serve`. Sent only to `server` (the same scheme, host and port),
    /// never to a server typed into the toolbar's settings.
    public var token: String?
    /// The app's name and version, recorded on every note. They default to the bundle's display name and version.
    public var appName: String?
    public var appVersion: String?
    /// The name on this person's notes. They can change it in the toolbar's settings.
    public var author: String?
    /// Take screenshots. A server that has them off wins either way.
    public var screenshots: Bool = true
    /// Cover editable text fields in screenshots and leave what is typed in them out of notes. Defaults to on in test and
    /// agent mode. Secure fields always are; `.notatoMask(false)` opts a field out, `.notatoMask()` makes any view private.
    public var maskInputs: Bool?
    /// Whether the floating toolbar shows at launch. People can drag it and fold it; where they leave it is remembered.
    public var showToolbar: Bool = true
    /// The corner the toolbar starts in.
    public var toolbarPosition: ToolbarCorner = .bottomTrailing
    /// Shaking the device shows or hides the toolbar.
    public var shakeToToggle: Bool = true
    /// Remember runtime choices across launches.
    public var rememberRuntimeState: Bool = true
    /// Attach the app's recent log messages (its own os_log / Logger entries) to each note.
    public var captureLogs: Bool = true
    /// The most log messages a note carries: the latest.
    public var logLimit: Int = 50
    /// The scale screenshots are stored at, at most. Phones are 3x; 2x is plenty to read and half the size.
    public var maxScreenshotScale: Double = 2
    /// Read iOS's accessibility tree to describe what was tapped (role, label, identifier). This switches on
    /// application accessibility while Notato is on, as UI-testing tools do, and puts it back afterwards. Off leaves
    /// the system alone: elements are then known only through `.notato()` marks.
    public var readAccessibility: Bool = true
    /// The folder source paths are given from, usually the repository root. Found by looking for `.git` above each
    /// source file when the files can be read (the simulator, a Mac); set it for anything else.
    public var sourceRoot: String?

    /// A configuration for `project`, with every other setting at its default.
    public init(project: String, mode: NotatoMode = .dev, server: URL? = nil) {
        self.project = project
        self.mode = mode
        self.server = server
    }

    /// The server notes go to, or nil.
    public var resolvedServer: URL? {
        if noServer { return nil }
        if let server { return server }
        return mode == .test ? nil : Self.defaultServer
    }

    /// Whether text fields are masked: `maskInputs`, or on in test and agent mode when it is not set.
    public var resolvedMaskInputs: Bool { maskInputs ?? (mode != .dev) }

    /// Why this configuration cannot be used, or nil. `Notato.start` logs it and stays off.
    public var problem: String? {
        if project.isEmpty { return "Notato needs a project id: set Project in the Notato configuration." }
        // As the server checks it (`[\w.@-]` in JavaScript is ASCII only), and so always a safe folder name.
        if project.range(of: #"^(?!\.+$)[A-Za-z0-9_.@-]{1,128}$"#, options: .regularExpression) == nil {
            return "Notato's project id \"\(project)\" may only use letters, digits and . _ - @ (at most 128), and not only dots."
        }
        if let server = resolvedServer, !["http", "https"].contains(server.scheme ?? "") {
            return "Notato's server \"\(server.absoluteString)\" is not an http(s) URL."
        }
        if !(1...4).contains(maxScreenshotScale) { return "Notato's maxScreenshotScale must be between 1 and 4." }
        return nil
    }

    // ---- loading ----------------------------------------------------------------------------------------------

    /// Reads the `Notato` dictionary of the app's Info.plist (keys as in the README: `Project`, `Mode`, `Server`, …),
    /// then the environment. Nil when there is no project anywhere.
    public static func fromInfoPlist(_ bundle: Bundle = .main, key: String = "Notato",
                                     environment: [String: String] = ProcessInfo.processInfo.environment) -> NotatoConfiguration? {
        let values = bundle.object(forInfoDictionaryKey: key) as? [String: Any] ?? [:]
        return from(values, environment: environment)
    }

    /// Reads a JSON file of the same keys (for example one bundled per build configuration), then the environment.
    public static func fromJSON(_ url: URL, environment: [String: String] = ProcessInfo.processInfo.environment) throws -> NotatoConfiguration? {
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
        var values = object as? [String: Any] ?? [:]
        if let nested = values["Notato"] as? [String: Any] { values = nested }
        return from(values, environment: environment)
    }

    /// Builds a configuration from loose values (Info.plist, JSON), with `NOTATO_<KEY>` environment variables over them.
    public static func from(_ values: [String: Any], environment: [String: String] = [:]) -> NotatoConfiguration? {
        var merged: [String: Any] = [:]
        for (key, value) in values { merged[key.lowercased()] = value }
        for (key, value) in environment where key.hasPrefix("NOTATO_") {
            merged[String(key.dropFirst("NOTATO_".count)).replacingOccurrences(of: "_", with: "").lowercased()] = value
        }
        func string(_ key: String) -> String? {
            switch merged[key] {
            case let value as String: return value.trimmingCharacters(in: .whitespaces)
            case let value as NSNumber: return value.stringValue
            default: return nil
            }
        }
        func bool(_ key: String) -> Bool? {
            switch merged[key] {
            case let value as Bool: return value
            case let value as NSNumber: return value.boolValue
            case let value as String: return ["1", "true", "yes", "on"].contains(value.lowercased()) ? true
                : ["0", "false", "no", "off"].contains(value.lowercased()) ? false : nil
            default: return nil
            }
        }
        func double(_ key: String) -> Double? { string(key).flatMap(Double.init) }

        guard let project = string("project"), !project.isEmpty else { return nil }
        var configuration = NotatoConfiguration(project: project)
        if let mode = string("mode").flatMap({ NotatoMode(rawValue: $0.lowercased()) }) { configuration.mode = mode }
        if let server = string("server") {
            if server.isEmpty { configuration.noServer = true } else { configuration.server = URL(string: server) }
        }
        configuration.token = string("token").flatMap { $0.isEmpty ? nil : $0 }
        configuration.appName = string("appname")
        configuration.appVersion = string("appversion")
        configuration.author = string("author")
        configuration.sourceRoot = string("sourceroot")
        if let value = bool("enabled") { configuration.enabled = value }
        if let value = bool("screenshots") { configuration.screenshots = value }
        if let value = bool("maskinputs") { configuration.maskInputs = value }
        if let value = bool("showtoolbar") { configuration.showToolbar = value }
        if let value = bool("shaketotoggle") { configuration.shakeToToggle = value }
        if let value = bool("rememberruntimestate") { configuration.rememberRuntimeState = value }
        if let value = bool("capturelogs") { configuration.captureLogs = value }
        if let value = bool("readaccessibility") { configuration.readAccessibility = value }
        // `inf`, `nan` or 1e300 would trap when made an Int.
        if let value = double("loglimit"), value.isFinite { configuration.logLimit = Int(min(max(value, 0), 10_000)) }
        if let value = double("maxscreenshotscale") { configuration.maxScreenshotScale = value }
        if let corner = string("toolbarposition").flatMap({ raw in ToolbarCorner.allCases.first { $0.rawValue.lowercased() == raw.lowercased() } }) {
            configuration.toolbarPosition = corner
        }
        return configuration
    }
}
