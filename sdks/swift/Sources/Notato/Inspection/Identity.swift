import Foundation

/// The app's name and version, and source paths from the repository root.
enum AppInfo {
    static func name(_ configuration: NotatoConfiguration) -> String {
        configuration.appName
            ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
            ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String
            ?? "app"
    }

    static func version(_ configuration: NotatoConfiguration) -> String? {
        if let version = configuration.appVersion { return version }
        let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        switch (short, build) {
        case let (s?, b?): return "\(s) (\(b))"
        case let (s?, nil): return s
        case let (nil, b?): return b
        default: return nil
        }
    }

    static var bundleId: String { Bundle.main.bundleIdentifier ?? "app" }
}

/// Turns the compiler's absolute `#filePath` into a path from the repository root, the way the agent sees the code.
enum SourcePaths {
    nonisolated(unsafe) private static var roots: [String: String] = [:]
    private static let lock = NSLock()

    nonisolated(unsafe) private static var types: [String: [(line: Int, name: String)]] = [:]
    /// A line that opens a type (or an extension of one), and its name.
    private static let declaration = try! NSRegularExpression(
        pattern: #"^\s*(?:@\w+\s+)*(?:(?:public|internal|private|fileprivate|final|open)\s+)*(?:struct|class|enum|actor|extension)\s+([A-Za-z_]\w*)"#)

    /// The struct, class or enum `line` is inside, read from the source file when it can be read.
    static func enclosingType(_ path: String, line: Int) -> String? {
        lock.lock()
        defer { lock.unlock() }
        if types[path] == nil {
            var found: [(line: Int, name: String)] = []
            if let text = try? String(contentsOfFile: path, encoding: .utf8) {
                for (index, row) in text.components(separatedBy: "\n").enumerated() {
                    let range = NSRange(row.startIndex..., in: row)
                    if let match = declaration.firstMatch(in: row, range: range), let name = Range(match.range(at: 1), in: row) {
                        found.append((index + 1, String(row[name])))
                    }
                }
            }
            types[path] = found
        }
        return types[path]?.last { $0.line <= line }?.name
    }

    static func relative(_ path: String, root configured: String?) -> String {
        guard path.hasPrefix("/") else { return path }
        if let configured {
            let prefix = configured.hasSuffix("/") ? configured : configured + "/"
            return path.hasPrefix(prefix) ? String(path.dropFirst(prefix.count)) : path
        }
        let directory = (path as NSString).deletingLastPathComponent
        lock.lock()
        defer { lock.unlock() }
        if let known = roots[directory] { return known.isEmpty ? path : String(path.dropFirst(known.count + 1)) }
        // The simulator and Mac Catalyst can read the Mac's files: find the repository above the source file.
        var candidate = directory
        var found = ""
        while candidate.count > 1 {
            if FileManager.default.fileExists(atPath: candidate + "/.git/HEAD") {
                found = candidate
                break
            }
            candidate = (candidate as NSString).deletingLastPathComponent
        }
        roots[directory] = found
        return found.isEmpty ? path : String(path.dropFirst(found.count + 1))
    }
}

/// Builds the schema's identity for an element: selector, role, name, where it is written, the views around it.
@MainActor
enum IdentityBuilder {
    /// `element` and `all` should have been through `Privacy.apply`; they are scrubbed again here, so nothing that may
    /// not be recorded gets into the identity whatever the caller did.
    static func describe(_ element: ScreenElement, among all: [ScreenElement], maskInputs: Bool, sourceRoot: String?, window: AnyObject? = nil) -> ElementIdentity {
        let element = Privacy.scrub(element, maskInputs: maskInputs)
        let all = all.map { Privacy.scrub($0, maskInputs: maskInputs) }
        let registry = MarkRegistry.shared
        let around = registry.around(element.frame, in: window)
        let screen = around.last(where: { $0.kind == .screen }) ?? registry.screens(in: window).last
        // A mark exactly the element's size is the element itself, not something around it.
        let views = around.filter { $0.kind == .view }
        let own = views.last { abs($0.frame.width - element.frame.width) < 2.5 && abs($0.frame.height - element.frame.height) < 2.5 }
        let containers = around.filter { $0.id != own?.id }
        // The element's own mark, else the innermost marked view around it, else (a navigation title, a toolbar button)
        // the screen it is on.
        let located = own ?? views.last ?? screen
        let source = located.map {
            SourceLocation(file: SourcePaths.relative($0.file, root: sourceRoot), line: $0.line, col: max(1, $0.column), nearest: $0.id == own?.id ? nil : true)
        }
        let path = around.map(\.name).reduce(into: [String]()) { names, name in if names.last != name { names.append(name) } }
        let component = located.map { mark in
            ComponentInfo(name: mark.name, source: SourcePaths.relative(mark.file, root: sourceRoot), path: path.count >= 2 ? path : nil)
        }
        let text = element.text
        return ElementIdentity(
            selector: Selectors.make(for: element, among: all, screen: screen?.name),
            testId: element.identifier,
            role: element.role,
            name: element.label,
            tag: element.control,
            classes: nil,
            text: text.map { $0.clipped(toScalars: ElementIdentity.textLimit) },
            source: source,
            component: component,
            styles: ["width": format(element.frame.width), "height": format(element.frame.height)],
            ancestors: containers.isEmpty ? nil : containers.map(\.name),
            platformId: element.identifier)
    }

    private static func format(_ value: CGFloat) -> String {
        let rounded = (Double(value) * 100).rounded() / 100
        return rounded == rounded.rounded() ? String(Int(rounded)) : String(rounded)
    }
}
