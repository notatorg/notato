import Foundation
@testable import Notato

/// The notes, screens and checks the tests share.
enum Fixture {
    /// A whole note about the sample's promo banner, as the SDK makes one: every part of the schema filled in.
    static func annotation() -> Annotation {
        Annotation(
            id: "01M471ZCEXZ4AEZHN0YP8RGVW4", projectId: "swift-sample", bundleId: nil, author: .human("Dom"),
            mode: "dev", createdAt: "2026-10-05T22:10:00.000Z", url: "ios://com.notato.swiftsample/ProductList", route: "/ProductList",
            appName: "Sample", appVersion: "1.0 (1)",
            environment: EnvironmentInfo(userAgent: "Sample/1.0 (iOS 26.5; iPhone18,1; simulator) SwiftUI", viewport: Viewport(w: 402, h: 874), dpr: 3, platform: "ios",
                                         sdk: SDKInfo(name: NotatoSDK.name, version: NotatoSDK.version)),
            target: Target(kind: "element", identity: [ElementIdentity(
                selector: "ProductList #PromoBanner", testId: "PromoBanner", role: "text", name: "Autumn sale", tag: "Text", classes: nil,
                text: "Autumn sale: 20% off jackets this week",
                source: SourceLocation(file: "sdks/swift/Example/ShopSample/ProductList.swift", line: 18, col: 29, nearest: nil),
                component: ComponentInfo(name: "PromoBanner", source: "sdks/swift/Example/ShopSample/ProductList.swift", path: ["ProductList", "PromoBanner"]),
                styles: ["width": "370", "height": "39.67"], ancestors: ["ProductList"], platformId: "PromoBanner")],
                           rect: PageRect(x: 16, y: 217, w: 370, h: 39.67), selectedText: nil),
            comment: "The sale text is almost invisible.", severity: Severity.major, intent: Intent.fix, variants: nil,
            screenshots: Screenshots(full: AssetRef(id: String(repeating: "a", count: 64), mime: "image/png", w: 804, h: 1748, path: nil),
                                     crop: AssetRef(id: String(repeating: "b", count: 64), mime: "image/png", w: 804, h: 172, path: nil)),
            steps: [AgentStep(action: "tap", target: "#PromoBanner", at: "2026-10-05T22:09:58.000Z")],
            context: ["console": .array([.object(["level": .string("error"), "message": .string("boom"), "at": .string("2026-10-05T22:09:00.000Z")])])],
            status: Status.open, thread: [])
    }

    /// The repository, found from this file: the first folder above it with packages/schema, which the contract test needs.
    static var repository: URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while dir.path != "/" && !FileManager.default.fileExists(atPath: dir.appendingPathComponent("packages/schema").path) {
            dir = dir.deletingLastPathComponent()
        }
        return dir
    }

    /// Where bun is installed, if it is.
    static func bun() -> String? {
        let candidates = [ProcessInfo.processInfo.environment["HOME"].map { "\($0)/.bun/bin/bun" }, "/opt/homebrew/bin/bun", "/usr/local/bin/bun"].compactMap { $0 }
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// Runs the server's own Zod schema over JSON this SDK wrote. Nil when bun is not installed (or on the simulator,
    /// which cannot start processes).
    static func validate(_ kind: String, _ data: Data) throws -> (ok: Bool, output: String)? {
        #if os(macOS)
        guard let bun = bun() else { return nil }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("notato-\(UUID().uuidString).json")
        try data.write(to: file)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: bun)
        process.arguments = ["sdks/swift/scripts/validate.ts", kind, file.path]
        process.currentDirectoryURL = repository
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        process.waitUntilExit()
        let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        return (process.terminationStatus == 0, output)
        #else
        return nil
        #endif
    }

    /// A note on a screen, made at a time of its own so the order of several is known: `note00007`.
    static func note(_ n: Int, route: String = "/ProductList", platform: String = "ios") -> Annotation {
        var annotation = annotation()
        annotation.id = String(format: "note%05d", n)
        annotation.createdAt = NotatoJSON.timestamp(Date(timeIntervalSince1970: 1_791_360_000 + Double(n)))
        annotation.route = route
        annotation.environment.platform = platform
        return annotation
    }

    /// A Notato of its own with nothing running, for the project the fixtures are in.
    @MainActor
    static func notato() -> Notato { Notato(configuration: NotatoConfiguration(project: "swift-sample", server: URL(string: "http://stub.test"))) }

    /// The shop's list as the accessibility tree describes it: a heading, a banner with an identifier, two product
    /// cards and two buttons with the same label.
    static let productList = [
        ScreenElement(role: "heading", label: "Shop", value: nil, identifier: nil, frame: CGRect(x: 180, y: 73, width: 41, height: 20), control: "Text"),
        ScreenElement(role: "text", label: "Autumn sale", value: nil, identifier: "PromoBanner", frame: CGRect(x: 16, y: 217, width: 370, height: 39), control: "Text"),
        ScreenElement(role: "button", label: "TR, Trail Runner, £89.00", value: nil, identifier: nil, frame: CGRect(x: 15, y: 268, width: 371, height: 85), control: "Button"),
        ScreenElement(role: "button", label: "SJ, Summit Jacket, £179.00", value: nil, identifier: nil, frame: CGRect(x: 15, y: 364, width: 371, height: 85), control: "Button"),
        ScreenElement(role: "button", label: "Add to cart", value: nil, identifier: nil, frame: CGRect(x: 15, y: 500, width: 100, height: 40), control: "Button"),
        ScreenElement(role: "button", label: "Add to cart", value: nil, identifier: nil, frame: CGRect(x: 15, y: 600, width: 100, height: 40), control: "Button"),
    ]
}

/// Set from an observation's `onChange`, which may not capture a variable.
final class Flag: @unchecked Sendable {
    var raised = false
}

/// A real server for the tests that need one: `NOTATO_TEST_SERVER=http://localhost:4799 swift test`, with a scratch
/// server (`npx notato dev --port 4799 --dir "$(mktemp -d)"`). Those tests are skipped without one.
enum LiveServer {
    static let url = ProcessInfo.processInfo.environment["NOTATO_TEST_SERVER"].flatMap(URL.init(string:))
}
