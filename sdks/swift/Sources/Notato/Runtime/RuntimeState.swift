import Foundation

/// What a person chose on the device, kept in UserDefaults: each unset value falls back to the configuration.
struct RuntimeState {
    let remember: Bool
    private static let prefix = "notato."
    private var memory: [String: String] = [:]

    init(remember: Bool) { self.remember = remember }

    private func get(_ key: String) -> String? {
        remember ? UserDefaults.standard.string(forKey: Self.prefix + key) : memory[key]
    }

    private mutating func set(_ key: String, _ value: String?) {
        memory[key] = value
        guard remember else { return }
        if let value { UserDefaults.standard.set(value, forKey: Self.prefix + key) } else { UserDefaults.standard.removeObject(forKey: Self.prefix + key) }
    }

    private func bool(_ key: String) -> Bool? { get(key).map { $0 == "1" } }
    private mutating func setBool(_ key: String, _ value: Bool?) { set(key, value.map { $0 ? "1" : "0" }) }

    var enabled: Bool? { get { bool("enabled") } set { setBool("enabled", newValue) } }
    var toolbarVisible: Bool? { get { bool("toolbar") } set { setBool("toolbar", newValue) } }
    var screenshots: Bool? { get { bool("screenshots") } set { setBool("screenshots", newValue) } }
    var pinsVisible: Bool? { get { bool("pins") } set { setBool("pins", newValue) } }
    /// The name on this person's notes; blank is none.
    var author: String? {
        get { get("author") }
        set { set("author", Self.nonBlank(newValue)) }
    }
    /// A server typed into Settings, used instead of the configured one; blank is none.
    var server: String? {
        get { get("server") }
        set { set("server", Self.nonBlank(newValue)) }
    }

    private static func nonBlank(_ text: String?) -> String? {
        guard let trimmed = text?.trimmingCharacters(in: .whitespaces), !trimmed.isEmpty else { return nil }
        return trimmed
    }

    /// Where the toolbar was dragged to, as fractions of the window so it survives rotation.
    var toolbarPosition: CGPoint? {
        get {
            guard let parts = get("toolbar.position")?.split(separator: ","), parts.count == 2,
                  let x = Double(parts[0]), let y = Double(parts[1]) else { return nil }
            return CGPoint(x: min(max(x, 0), 1), y: min(max(y, 0), 1))
        }
        set { set("toolbar.position", newValue.map { "\($0.x),\($0.y)" }) }
    }

    /// Whether the toolbar was left folded into its round button.
    var toolbarCollapsed: Bool? { get { bool("toolbar.collapsed") } set { setBool("toolbar.collapsed", newValue) } }

    mutating func reset() {
        for key in ["enabled", "toolbar", "screenshots", "pins", "author", "server", "toolbar.position", "toolbar.collapsed"] { set(key, nil) }
    }
}
