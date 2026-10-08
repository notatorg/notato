import Foundation
import OSLog
import SwiftUI
import Testing
@testable import Notato

enum Fixture {
    static func annotation(bundleId: String? = nil) -> Annotation {
        Annotation(
            id: "01M471ZCEXZ4AEZHN0YP8RGVW4", projectId: "swift-sample", bundleId: AlwaysPresent(bundleId), author: .human("Dom"),
            mode: "dev", createdAt: "2026-10-05T22:10:00.000Z", url: "ios://com.notato.swiftsample/ProductList", route: "/ProductList",
            appName: "Sample", appVersion: "1.0 (1)",
            environment: EnvironmentInfo(userAgent: "Sample/1.0 (iOS 26.5; iPhone18,1; simulator) SwiftUI", viewport: Viewport(w: 402, h: 874), dpr: 3, platform: "ios",
                                         sdk: SDKInfo(name: NotatoSDK.name, version: NotatoSDK.version)),
            target: Target(kind: "element", identity: [ElementIdentity(
                selector: "ProductList #PromoBanner", testId: "PromoBanner", role: "text", name: "Autumn sale", tag: "Text", classes: nil,
                text: "Autumn sale: 20% off jackets this week",
                source: SourceLocation(file: "swift/Example/ShopSample/ProductList.swift", line: 18, col: 29, nearest: nil),
                component: ComponentInfo(name: "PromoBanner", source: "swift/Example/ShopSample/ProductList.swift", path: ["ProductList", "PromoBanner"]),
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
}

@Suite("The schema contract")
struct ContractTests {
    @Test func anAnnotationAsSentPassesTheServersSchema() throws {
        let json = try NotatoJSON.encoder.encode(Fixture.annotation())
        guard let result = try Fixture.validate("annotation", json) else { return }
        #expect(result.ok, "\(result.output)")
    }

    @Test func theCheckIsRealABadAnnotationFails() throws {
        var bad = Fixture.annotation()
        bad.severity = "catastrophic"
        guard let result = try Fixture.validate("annotation", try NotatoJSON.encoder.encode(bad)) else { return }
        #expect(!result.ok)
    }

    @Test func bundleIdIsWrittenAsNullAndMissingOptionalsAreLeftOut() throws {
        var minimal = Fixture.annotation()
        minimal.severity = nil
        minimal.screenshots = nil
        let text = String(decoding: try NotatoJSON.encoder.encode(minimal), as: UTF8.self)
        #expect(text.contains("\"bundleId\":null"))
        #expect(!text.contains("\"severity\""))
        #expect(!text.contains("\"screenshots\""))
    }

    @Test func whatTheServerSendsReadsBackIncludingFieldsThisSDKDoesNotKnow() throws {
        var text = String(decoding: try NotatoJSON.encoder.encode(Fixture.annotation()), as: UTF8.self)
        text = text.replacingOccurrences(of: "\"status\":\"open\"", with: "\"status\":\"some_future_status\",\"newField\":{\"a\":1}")
        let read = try NotatoJSON.decoder.decode(Annotation.self, from: Data(text.utf8))
        #expect(read.status == "some_future_status")
        #expect(read.target.identity[0].source?.line == 18)
        #expect(read.bundleId.value == nil)
    }

    @Test func aPackagedBundlePassesTheSchemaAndUnzips() throws {
        // One screenshot kept in a file, as a note's are, one still in memory.
        let kept = FileManager.default.temporaryDirectory.appendingPathComponent("notato-\(UUID().uuidString).png")
        try Data([1, 2, 3]).write(to: kept)
        defer { try? FileManager.default.removeItem(at: kept) }
        let assets: [String: KeptAsset] = [String(repeating: "a", count: 64): .file(kept), String(repeating: "b", count: 64): .bytes(Data([4, 5]))]
        let (bundle, files) = BundleWriter.build([LocalAnnotation(annotation: Fixture.annotation(), assets: assets)],
                                                 project: "swift-sample", author: "Dom", appName: "Sample", appVersion: "1.0")
        #expect(bundle.annotations[0].bundleId.value == bundle.id)
        #expect(bundle.annotations[0].screenshots?.full.path == "shots/01-full.png")
        if let result = try Fixture.validate("bundle", try NotatoJSON.encoder.encode(bundle)) { #expect(result.ok, "\(result.output)") }

        let file = FileManager.default.temporaryDirectory.appendingPathComponent("notato-\(UUID().uuidString).zip")
        defer { try? FileManager.default.removeItem(at: file) }
        try BundleWriter.write(bundle, files: files, to: file)
        #if os(macOS)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
        process.arguments = ["-l", file.path]
        let pipe = Pipe()
        process.standardOutput = pipe
        try process.run()
        process.waitUntilExit()
        let listing = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        #expect(process.terminationStatus == 0)
        for name in ["feedback.md", "annotations.json", "shots/01-full.png", "shots/01-crop.png"] { #expect(listing.contains(name)) }
        #else
        #expect(try Data(contentsOf: file).count > 0)
        #endif
    }

    @Test func zipCRCsMatchTheStandard() {
        #expect(ZipWriter.crc32(Data("The quick brown fox jumps over the lazy dog".utf8)) == 0x414F_A339)
    }
}

@Suite("Selectors")
struct SelectorTests {
    let elements = [
        ScreenElement(role: "heading", label: "Shop", value: nil, identifier: nil, frame: CGRect(x: 180, y: 73, width: 41, height: 20), control: "Text"),
        ScreenElement(role: "text", label: "Autumn sale", value: nil, identifier: "PromoBanner", frame: CGRect(x: 16, y: 217, width: 370, height: 39), control: "Text"),
        ScreenElement(role: "button", label: "TR, Trail Runner, £89.00", value: nil, identifier: nil, frame: CGRect(x: 15, y: 268, width: 371, height: 85), control: "Button"),
        ScreenElement(role: "button", label: "SJ, Summit Jacket, £179.00", value: nil, identifier: nil, frame: CGRect(x: 15, y: 364, width: 371, height: 85), control: "Button"),
        ScreenElement(role: "button", label: "Add to cart", value: nil, identifier: nil, frame: CGRect(x: 15, y: 500, width: 100, height: 40), control: "Button"),
        ScreenElement(role: "button", label: "Add to cart", value: nil, identifier: nil, frame: CGRect(x: 15, y: 600, width: 100, height: 40), control: "Button"),
    ]

    @Test(arguments: ["#PromoBanner", "text#PromoBanner", "ProductList #PromoBanner", "text:text(\"autumn\")", "*:has-text('Autumn sale')"])
    func agentsCanFindAnElementSeveralWays(selector: String) throws {
        #expect(try Selectors.query(selector, in: elements).first?.identifier == "PromoBanner")
    }

    @Test func generatedSelectorsFindExactlyTheirElement() throws {
        for element in elements {
            let selector = Selectors.make(for: element, among: elements, screen: "ProductList")
            let found = try Selectors.query(selector, in: elements)
            #expect(found == [element], "\(selector)")
        }
    }

    @Test func anIdentifierMakesTheShortestSelector() {
        #expect(Selectors.make(for: elements[1], among: elements, screen: "ProductList") == "ProductList #PromoBanner")
        #expect(Selectors.make(for: elements[5], among: elements, screen: nil) == "button:text(\"Add to cart\"):nth(2)")
    }

    @Test(arguments: ["", "#", "button:hover(1)", "button:text(\"open", "button:nth(0)", "button?"])
    func badSelectorsSayWhatIsWrong(selector: String) {
        #expect(throws: Selectors.SelectorError.self) { try Selectors.parse(selector) }
    }
}

@Suite("Privacy")
struct PrivacyTests {
    // A checkout screen: a private card (.notatoMask()) holding the number and the holder's name, a button whose label
    // reads out a private price, and text fields: plain, opted out (.notatoMask(false)), secure, and private and opted out.
    static let card = CGRect(x: 16, y: 160, width: 370, height: 80)
    static let price = CGRect(x: 300, y: 312, width: 70, height: 20)
    static let search = CGRect(x: 16, y: 440, width: 370, height: 44)
    static let password = CGRect(x: 16, y: 500, width: 370, height: 44)
    static let delivery = CGRect(x: 16, y: 560, width: 370, height: 44)
    static let masks = [card, price, delivery]
    static let optOuts = [search, password, delivery]

    let heading = ScreenElement(role: "heading", label: "Payment", value: nil, identifier: nil, frame: CGRect(x: 16, y: 120, width: 120, height: 30), control: "Text")
    let number = ScreenElement(role: "text", label: "4242 4242 4242 4242", value: nil, identifier: nil, frame: CGRect(x: 32, y: 172, width: 220, height: 20), control: "Text")
    let holder = ScreenElement(role: "text", label: "Ada Lovelace", value: nil, identifier: "CardHolder", frame: CGRect(x: 32, y: 204, width: 160, height: 20), control: "Text")
    let brand = ScreenElement(role: "text", label: "Visa", value: nil, identifier: nil, frame: CGRect(x: 16, y: 240, width: 60, height: 20), control: "Text")
    let jacket = ScreenElement(role: "button", label: "Summit Jacket, £179.00", value: nil, identifier: nil, frame: CGRect(x: 16, y: 280, width: 370, height: 85), control: "Button")
    let email = ScreenElement(role: "textbox", label: "Email", value: "dom@example.com", identifier: nil, frame: CGRect(x: 16, y: 380, width: 370, height: 44), control: "TextField", isTextInput: true)
    let query = ScreenElement(role: "textbox", label: "Search", value: "smoke detector", identifier: nil, frame: search, control: "TextField", isTextInput: true)
    let secret = ScreenElement(role: "textbox", label: "Password", value: "hunter2", identifier: nil, frame: password, control: "TextField", isTextInput: true, isSecure: true)
    let note = ScreenElement(role: "textbox", label: "Delivery note", value: "Ring twice", identifier: nil, frame: delivery, control: "TextField", isTextInput: true)

    var screen: [ScreenElement] { [heading, number, holder, brand, jacket, email, query, secret, note] }

    func applied(maskInputs: Bool) -> [ScreenElement] {
        Privacy.apply(screen, masks: Self.masks, optOuts: Self.optOuts, maskInputs: maskInputs)
    }

    @Test func aMarkAppliesWhenOneFrameLiesMostlyInsideTheOther() {
        #expect(Privacy.applies(Self.card, to: number.frame), "inside the private view")
        #expect(Privacy.applies(Self.price, to: jacket.frame), "holding the private view")
        #expect(!Privacy.applies(Self.card, to: brand.frame), "touching its edge")
        #expect(!Privacy.applies(Self.card, to: CGRect(x: 16, y: 235, width: 370, height: 44)), "overlapping it by a sliver")
        #expect(Privacy.applies(Self.card, to: CGRect(x: 16, y: 150, width: 370, height: 40)), "mostly inside it")
    }

    @Test func nothingAPrivateViewHoldsIsRecordedButItsNeighboursAre() {
        let out = applied(maskInputs: false)
        for element in [out[1], out[2]] {
            #expect(element.isMasked)
            #expect(element.label == nil && element.value == nil && element.text == nil)
        }
        #expect(out[2].identifier == "CardHolder", "the identifier is the app's, not the user's")
        #expect(out[2].role == "text" && out[2].frame == holder.frame)
        #expect(out[0].text == "Payment")
        #expect(out[3].text == "Visa")
    }

    @Test func aButtonThatReadsOutAPrivateTextHasNoText() {
        let button = applied(maskInputs: false)[4]
        #expect(button.isMasked)
        #expect(button.text == nil)
    }

    @Test func aPrivateElementIsSelectedByRoleIdentifierAndPositionNeverByText() throws {
        let out = applied(maskInputs: false)
        let selector = Selectors.make(for: out[1], among: out, screen: "Checkout")
        #expect(selector == "Checkout text:nth(2)", "the heading is a Text too")
        #expect(try Selectors.query(selector, in: out) == [out[1]])
        #expect(Selectors.make(for: out[2], among: out, screen: "Checkout") == "Checkout #CardHolder")
        #expect(Selectors.make(for: out[4], among: out, screen: nil) == "button")
        // An agent cannot find a private element by its text.
        for text in ["4242", "Ada", "179"] { #expect(try Selectors.query("*:text(\"\(text)\")", in: out).isEmpty) }
    }

    @Test @MainActor func theNoteCarriesNoTextOfAPrivateElement() {
        let out = applied(maskInputs: false)
        for element in [out[1], out[2], out[4]] {
            let identity = IdentityBuilder.describe(element, among: out, maskInputs: false, sourceRoot: nil)
            #expect(identity.text == nil && identity.name == nil)
            #expect(!identity.selector.contains(":text("), "\(identity.selector)")
        }
        #expect(IdentityBuilder.describe(out[2], among: out, maskInputs: false, sourceRoot: nil).testId == "CardHolder")
        // Scrubbed again on the way in: an element marked private but not yet scrubbed still says nothing.
        var unscrubbed = number
        unscrubbed.isMasked = true
        let identity = IdentityBuilder.describe(unscrubbed, among: screen, maskInputs: false, sourceRoot: nil)
        #expect(identity.text == nil && identity.name == nil && !identity.selector.contains("4242"))
    }

    @Test @MainActor func maskedInputsKeepTheirLabelButNotWhatIsTyped() {
        let masked = applied(maskInputs: true)
        let identity = IdentityBuilder.describe(masked[5], among: masked, maskInputs: true, sourceRoot: nil)
        #expect(identity.text == "Email" && identity.name == "Email")
        #expect(!identity.selector.contains("dom@"), "\(identity.selector)")
        // In dev mode, inputs are not masked.
        #expect(applied(maskInputs: false)[5].value == "dom@example.com")
    }

    @Test @MainActor func aFieldCanOptOutOfMaskInputsButASecureFieldNeverCan() {
        let out = applied(maskInputs: true)
        #expect(out[6].optsOut)
        #expect(out[6].value == "smoke detector")
        #expect(IdentityBuilder.describe(out[6], among: out, maskInputs: true, sourceRoot: nil).text == "Search smoke detector")
        for maskInputs in [true, false] {
            let secure = applied(maskInputs: maskInputs)[7]
            #expect(secure.value == nil && secure.text == "Password")
        }
    }

    @Test func aPrivateViewWinsOverAFieldInsideItThatOptsOut() {
        let field = applied(maskInputs: true)[8]
        #expect(field.isMasked && field.optsOut)
        #expect(field.text == nil)
    }

    @Test func screenshotsCoverPrivateViewsSecureFieldsAndMaskedInputs() {
        let masked = applied(maskInputs: true)
        #expect(Privacy.covered(masked, masks: Self.masks, maskInputs: true) == Self.masks + [email.frame, Self.password])
        let dev = applied(maskInputs: false)
        #expect(Privacy.covered(dev, masks: Self.masks, maskInputs: false) == Self.masks + [Self.password])
    }

    @Test func scrubbingTwiceChangesNothing() {
        let once = applied(maskInputs: true)
        #expect(once.map { Privacy.scrub($0, maskInputs: true) } == once)
        #expect(Privacy.apply(once, masks: Self.masks, optOuts: Self.optOuts, maskInputs: true) == once)
    }

    @Test @MainActor func theMaskModifierStillTakesNoArgument() {
        // Compiles: `.notatoMask()` as before, and the opt-out.
        _ = Text("4242 4242 4242 4242").notatoMask()
        _ = TextField("Search", text: .constant("")).notatoMask(false)
    }
}

@Suite("The rest")
struct SupportTests {
    @Test func serverSentEventsSplitOnBlankLinesAndSkipComments() {
        var parser = ServerSentEventParser()
        let lines = ["event: hello", "data: {\"projectId\":\"p\"}", "", ": ping", "", "event: updated", "data: {\"a\":1,", "data: \"b\":2}", "", "data: plain", ""]
        let events = lines.compactMap { parser.feed($0) }
        #expect(events == [ServerSentEvent(event: "hello", data: "{\"projectId\":\"p\"}"),
                           ServerSentEvent(event: "updated", data: "{\"a\":1,\n\"b\":2}"),
                           ServerSentEvent(event: "message", data: "plain")])
    }

    @Test func ulidsAre26CrockfordCharactersAndSortByTime() {
        let earlier = ULID.make(at: Date(timeIntervalSince1970: 1_700_000_000))
        let later = ULID.make(at: Date(timeIntervalSince1970: 1_700_000_000.001))
        #expect(earlier.count == 26)
        #expect(earlier.range(of: "^[0-9A-HJKMNP-TV-Z]{26}$", options: .regularExpression) != nil)
        #expect(earlier < later)
        #expect(ULID.make() != ULID.make())
    }

    @Test func configurationReadsLooseValuesAndTheEnvironmentWins() {
        let configuration = NotatoConfiguration.from(
            ["Project": "shop-ios", "Mode": "Agent", "Server": "https://notato.example.com", "Enabled": false, "ToolbarPosition": "topLeading"],
            environment: ["NOTATO_SERVER": "http://localhost:4790", "NOTATO_MASK_INPUTS": "false"])
        #expect(configuration?.project == "shop-ios")
        #expect(configuration?.mode == .agent)
        #expect(configuration?.resolvedServer?.absoluteString == "http://localhost:4790")
        #expect(configuration?.enabled == false)
        #expect(configuration?.toolbarPosition == .topLeading)
        #expect(configuration?.resolvedMaskInputs == false)
        #expect(NotatoConfiguration.from(["Mode": "dev"]) == nil, "no project, no configuration")
    }

    @Test func modesDefaultTheServerAndMasking() {
        #expect(NotatoConfiguration(project: "a").resolvedServer == NotatoConfiguration.defaultServer)
        #expect(NotatoConfiguration(project: "a", mode: .test).resolvedServer == nil)
        #expect(NotatoConfiguration(project: "a", mode: .test).resolvedMaskInputs)
        #expect(NotatoConfiguration(project: "has spaces").problem != nil)
        var noServer = NotatoConfiguration(project: "a")
        noServer.noServer = true
        #expect(noServer.resolvedServer == nil)
    }

    @Test func theMultipartFormCarriesTheAnnotationAndEachScreenshot() throws {
        let annotation = Fixture.annotation()
        let body = try NotatoClient.form(annotation, assets: [String(repeating: "a", count: 64): Data([137, 80, 78, 71])], boundary: "B")
        let text = String(decoding: body, as: UTF8.self)
        #expect(text.hasPrefix("--B\r\nContent-Disposition: form-data; name=\"annotation\"\r\n\r\n{"))
        #expect(text.contains("name=\"asset:\(String(repeating: "a", count: 64))\""))
        #expect(!text.contains("asset:\(String(repeating: "b", count: 64))"), "a screenshot with no bytes is not sent")
        #expect(text.hasSuffix("--B--\r\n"))
    }

    @Test func sourcePathsAreGivenFromTheRepositoryRoot() {
        #expect(SourcePaths.relative("/work/repo/app/Views/List.swift", root: "/work/repo") == "app/Views/List.swift")
        let here = #filePath
        #expect(SourcePaths.relative(here, root: nil) == "sdks/swift/Tests/NotatoTests/NotatoTests.swift")
    }
}

@Suite("The toolbar's fold")
struct ToolbarFoldTests {
    private let phone = CGSize(width: 402, height: 800)
    /// The round button's diameter (and the bar's height).
    private let d = ToolbarMetrics.height

    /// `#expect` works on a copy of what it is given, which a mutating call cannot change.
    private func change(_ fold: inout ToolbarFold, _ body: (inout ToolbarFold) -> Bool) -> Bool { body(&fold) }

    @Test func theFoldIsRememberedNextToThePositionAndResetWithIt() {
        let defaults = UserDefaults.standard
        defer { for key in ["toolbar.collapsed", "toolbar.position"] { defaults.removeObject(forKey: "notato." + key) } }
        var state = RuntimeState(remember: true)
        state.toolbarPosition = CGPoint(x: 0.25, y: 0.5)
        state.toolbarCollapsed = true
        #expect(defaults.string(forKey: "notato.toolbar.collapsed") == "1")
        let relaunched = RuntimeState(remember: true)
        #expect(relaunched.toolbarCollapsed == true)
        #expect(relaunched.toolbarPosition == CGPoint(x: 0.25, y: 0.5))
        state.reset()
        #expect(RuntimeState(remember: true).toolbarCollapsed == nil)
        #expect(RuntimeState(remember: true).toolbarPosition == nil)

        var forgetful = RuntimeState(remember: false)
        forgetful.toolbarCollapsed = true
        #expect(forgetful.toolbarCollapsed == true)
        #expect(RuntimeState(remember: false).toolbarCollapsed == nil, "not kept across launches when told not to")
    }

    @Test func theChevronPointsToTheSideTheBarIsHeldTo() {
        // Never dragged: its corner's side.
        #expect(ToolbarPlacement.heldRight(ToolbarCorner.bottomTrailing.defaultFraction))
        #expect(ToolbarPlacement.heldRight(ToolbarCorner.topTrailing.defaultFraction))
        #expect(!ToolbarPlacement.heldRight(ToolbarCorner.bottomLeading.defaultFraction))
        #expect(!ToolbarPlacement.heldRight(ToolbarCorner.topLeading.defaultFraction))
        // Dragged: the half it was left in.
        #expect(ToolbarPlacement.heldRight(CGPoint(x: 0.5, y: 0.3)))
        #expect(!ToolbarPlacement.heldRight(CGPoint(x: 0.49, y: 0.3)))
    }

    @Test(arguments: [0, 0.2, 0.49, 0.5, 0.8, 1] as [CGFloat])
    func openingAndFoldingNeverMoveTheHeldEdge(x: CGFloat) {
        let fraction = CGPoint(x: x, y: 0.7)
        let right = ToolbarPlacement.heldRight(fraction)
        let edge = { (width: CGFloat) in
            let origin = ToolbarPlacement.origin(fraction, width: width, in: phone)
            return right ? origin.x + width : origin.x
        }
        // From the round button, through the spring's overshoot, to the open bar.
        for width in [d, 70, 96, 132, 138] as [CGFloat] {
            #expect(abs(edge(width) - edge(d)) < 1e-9)
            #expect(ToolbarPlacement.origin(fraction, width: width, in: phone).y == ToolbarPlacement.origin(fraction, width: d, in: phone).y)
        }
        // Dropped where it is, it stays there, folded or open. Folded, that is the same fraction; an open bar across
        // the middle can come back held to the other side, the half most of it is in, as the web toolbar's does.
        for width in [d, 132] as [CGFloat] {
            let origin = ToolbarPlacement.origin(fraction, width: width, in: phone)
            let back = ToolbarPlacement.fraction(of: origin, width: width, in: phone)
            let again = ToolbarPlacement.origin(back, width: width, in: phone)
            #expect(abs(again.x - origin.x) < 1e-9 && abs(again.y - origin.y) < 1e-9)
            #expect(ToolbarPlacement.heldRight(back) == (origin.x + width / 2 >= phone.width / 2))
            if width == d { #expect(abs(back.x - fraction.x) < 1e-9 && abs(back.y - fraction.y) < 1e-9) }
        }
    }

    @Test func aBarDroppedInTheLeftHalfIsHeldToTheLeft() {
        let left = ToolbarPlacement.fraction(of: CGPoint(x: 100, y: 300), width: 132, in: phone)
        #expect(!ToolbarPlacement.heldRight(left))
        #expect(abs(ToolbarPlacement.origin(left, width: 132, in: phone).x - 100) < 1e-9)
        let right = ToolbarPlacement.fraction(of: CGPoint(x: 160, y: 300), width: 132, in: phone)
        #expect(ToolbarPlacement.heldRight(right), "its middle, at 226, is in the right half")
        #expect(abs(ToolbarPlacement.origin(right, width: 132, in: phone).x - 160) < 1e-9)
        #expect(abs(ToolbarPlacement.origin(right, width: d, in: phone).x - (160 + 132 - d)) < 1e-9, "folded, it keeps the right edge")
    }

    /// Fold, open and fold again from just right of the middle of the narrowest iPhone (375 points), and of a window
    /// too narrow for the open bar to fit on its held side: the held side never changes, and each shape comes back to
    /// exactly where it was.
    @Test(arguments: [375, 160] as [CGFloat])
    func roundTripsComeBackExactlyAndKeepTheirSide(windowWidth: CGFloat) {
        let window = CGSize(width: windowWidth, height: 700)
        let bar: CGFloat = 132
        let fraction = CGPoint(x: 0.52, y: 0.4)
        var fold = ToolbarFold(collapsed: true, items: 3)
        let circle = ToolbarPlacement.placed(fraction, width: d, in: window)
        let open = ToolbarPlacement.placed(fraction, width: bar, in: window)
        #expect(open.x >= ToolbarMetrics.margin && open.x + bar <= windowWidth - ToolbarMetrics.margin || windowWidth < bar + 24)
        if windowWidth == 375 { #expect(abs(open.x + bar - (circle.x + d)) < 1e-9, "it fits, so the right edge is shared") }
        var time = 0.0
        for _ in 0..<3 {
            for next in [false, true] {
                #expect(change(&fold) { $0.set(next, heldRight: ToolbarPlacement.heldRight(fraction), at: time, animated: true) })
                // Every frame of the move keeps to the held side's edge, or to the margin when the bar cannot fit.
                for t in stride(from: time, through: time + 0.8, by: 1.0 / 60) {
                    let width = d + max(0, fold.look(at: t, heldRight: true).extent) * (bar - d)
                    let at = ToolbarPlacement.placed(fraction, width: width, in: window)
                    #expect(abs(at.x + width - (circle.x + d)) < 1e-9 || at.x == ToolbarMetrics.margin)
                }
                time += 1
                #expect(ToolbarPlacement.heldRight(fraction), "the side it is held to does not change")
                let rest = ToolbarPlacement.placed(fraction, width: next ? d : bar, in: window)
                #expect(rest == (next ? circle : open))
            }
        }
    }

    @Test func annotatingOpensAFoldedBarAndFoldsItAgainAfter() {
        var fold = ToolbarFold(collapsed: true, items: 3)
        #expect(change(&fold) { $0.annotating(true, heldRight: true, at: 0, animated: false) })
        #expect(!fold.collapsed && fold.openedForAnnotate)
        #expect(change(&fold) { $0.annotating(false, heldRight: true, at: 1, animated: false) })
        #expect(fold.collapsed && !fold.openedForAnnotate)

        // Folded and opened again by hand while annotating: it is someone's choice now, and stays open after.
        _ = fold.annotating(true, heldRight: true, at: 2, animated: false)
        #expect(change(&fold) { $0.set(true, heldRight: true, at: 3, animated: false) })
        #expect(change(&fold) { $0.set(false, heldRight: true, at: 4, animated: false) })
        #expect(!change(&fold) { $0.annotating(false, heldRight: true, at: 5, animated: false) })
        #expect(!fold.collapsed)

        // Open already: annotating changes nothing, then or after.
        #expect(!change(&fold) { $0.annotating(true, heldRight: true, at: 6, animated: false) })
        #expect(!fold.openedForAnnotate)
        #expect(!change(&fold) { $0.annotating(false, heldRight: true, at: 7, animated: false) })
        #expect(!fold.collapsed)
        #expect(!change(&fold) { $0.set(false, heldRight: true, at: 8, animated: false) }, "no change, no move")
    }

    @Test func itOpensOnASpringWithTheButtonsFollowingFromTheHeldSide() {
        var fold = ToolbarFold(collapsed: true, items: 3)
        #expect(change(&fold) { $0.set(false, heldRight: true, at: 10, animated: true) })
        let look = { (t: Double) in fold.look(at: 10 + t, heldRight: true) }
        #expect(look(0).extent == 0)
        let extents = stride(from: 0.0, through: 0.56, by: 0.002).map { look($0).extent }
        let peak = extents.max()!
        #expect(peak > 1.04 && peak < 1.065, "one overshoot of about 5%: \(peak)")
        #expect(abs(look(0.555).extent - 1) < 0.004, "settled by 560ms")
        #expect(extents.firstIndex { $0 > 0.8 }! < 75, "most of the way within 150ms")

        // Held right: the collapse button (the rightmost) leads; they come in from the right, a little small.
        let early = look(0.08)
        #expect(early.items[2].opacity > early.items[1].opacity && early.items[1].opacity > early.items[0].opacity)
        #expect(look(0.02).items == Array(repeating: ToolbarLook.Part(opacity: 0, offset: 10, scale: 0.94), count: 3))
        // The round button turns away anticlockwise as it fades, gone by 180ms.
        #expect(look(0.09).button.turn < 0 && look(0.09).button.scale < 1)
        #expect(look(0.18).button.opacity == 0)
        #expect(fold.moving(at: 10.3) && !fold.moving(at: 10.6))
        #expect(look(0.6) == .resting(collapsed: false, toward: 1, items: 3))
    }

    @Test func itFoldsOnTheSettleCurveFarButtonsFirstThenTheButtonTurnsIn() {
        var fold = ToolbarFold(collapsed: false, items: 3)
        #expect(change(&fold) { $0.set(true, heldRight: false, at: 0, animated: true) })
        let look = { (t: Double) in fold.look(at: t, heldRight: false) }
        let extents = stride(from: 0.0, through: 0.42, by: 0.01).map { look($0).extent }
        #expect(zip(extents, extents.dropFirst()).allSatisfy { $0 >= $1 }, "no overshoot")
        #expect(extents.last! < 0.001)
        // Held left: the rightmost goes first, toward the left, and smaller.
        let early = look(0.05)
        #expect(early.items[2].opacity < early.items[1].opacity && early.items[1].opacity < early.items[0].opacity)
        #expect(look(0.2).items.allSatisfy { $0.opacity == 0 && $0.offset == -8 && abs($0.scale - 0.92) < 1e-9 })
        // The round button waits for the edge, then turns in clockwise from a quarter turn back; the count pops last.
        #expect(look(0.16).button == ToolbarLook.Part(opacity: 0, scale: 0.5, turn: 90))
        #expect(look(0.3).button.opacity > 0.5 && look(0.3).button.turn > 0)
        #expect(look(0.39).badge == ToolbarLook.Part(opacity: 0, scale: 0.4))
        #expect(look(0.5).badge.scale > 0.4)
        #expect(look(0.8) == .resting(collapsed: true, toward: -1, items: 3))
    }

    @Test(arguments: [0.05, 0.2, 0.35, 0.5] as [Double])
    func aChangeOfMindTurnsAroundFromWhereItIs(after delay: Double) {
        for opening in [true, false] {
            var fold = ToolbarFold(collapsed: opening, items: 3)
            _ = fold.set(!opening, heldRight: true, at: 0, animated: true)
            let before = fold.look(at: delay, heldRight: true)
            #expect(change(&fold) { $0.set(opening, heldRight: true, at: delay, animated: true) })
            let after = fold.look(at: delay, heldRight: true)
            // Nothing that shows jumps: the width, and every part that can be seen.
            #expect(after.extent == before.extent)
            for (a, b) in zip([after.button, after.badge] + after.items, [before.button, before.badge] + before.items) {
                #expect(a.opacity == b.opacity)
                if b.opacity >= 0.01 { #expect(a == b) }
            }
            #expect(abs(fold.look(at: delay + 1.0 / 120, heldRight: true).extent - before.extent) < 0.12)
            #expect(fold.collapsed == opening)
        }
    }

    @Test func withoutAnimationItIsThereAtOnce() {
        var fold = ToolbarFold(collapsed: false, items: 3)
        #expect(change(&fold) { $0.set(true, heldRight: true, at: 0, animated: false) })
        #expect(fold.morph == nil && !fold.moving(at: 0))
        #expect(fold.look(at: 0, heldRight: true) == .resting(collapsed: true, toward: 1, items: 3))
        #expect(change(&fold) { $0.annotating(true, heldRight: true, at: 0, animated: false) })
        #expect(fold.look(at: 0, heldRight: true) == .resting(collapsed: false, toward: 1, items: 3))
    }

    @Test func theCurvesAreTheWebToolbars() {
        // cubic-bezier(0.32, 0.72, 0, 1) and ease-in, against values found by bisection elsewhere.
        #expect(abs(Motion.Curve.settle.progress(0.25) - 0.7791) < 0.0005)
        #expect(abs(Motion.Curve.settle.progress(0.5) - 0.9548) < 0.0005)
        #expect(abs(Motion.Curve.easeIn.progress(0.5) - 0.3154) < 0.0005)
        #expect(Motion.Curve.spring.progress(0) == 0 && Motion.Curve.spring.progress(1) == 1)
        #expect(abs(Motion.Curve.spring.progress(0.999) - 1) < 0.004, "close enough at the end that ending there shows no jump")
    }
}

@Suite("Ids and the files kept on the device")
struct LocalStoreTests {
    private func temporary() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("notato-store-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func note(_ id: String) -> Annotation {
        var annotation = Fixture.annotation()
        annotation.id = id
        return annotation
    }

    @Test(arguments: ["01M471ZCEXZ4AEZHN0YP8RGVW4", "3f2a6b1c-0d4e-4f5a-9b8c-7d6e5f4a3b2c", String(repeating: "a", count: 64), "a_b-C"])
    func idsTheSchemaAllowsAreSafe(id: String) {
        #expect(SafeIds.isSafe(id))
    }

    @Test(arguments: ["", "..", ".", "../..", "a/b", "a\\b", "a.b", "~", "é", String(repeating: "a", count: 129), "a b"])
    func anythingElseIsNot(id: String) {
        #expect(!SafeIds.isSafe(id))
    }

    @Test func aSafeProjectKeepsItsFolderAndAnythingElseGetsOneMadeFromItsBytes() {
        #expect(SafeIds.folder(forProject: "shop-ios") == "shop-ios", "existing folders are kept")
        #expect(SafeIds.folder(forProject: "a.b@c_d-e") == "a.b@c_d-e")
        #expect(SafeIds.folder(forProject: "..") == "p-2e2e")
        #expect(SafeIds.folder(forProject: ".") == "p-2e")
        #expect(SafeIds.folder(forProject: "a/b") == "p-612f62")
        #expect(SafeIds.folder(forProject: "café") == "p-636166c3a9")
        #expect(SafeIds.folder(forProject: String(repeating: "/", count: 128)).count == 66, "long ones are hashed")
    }

    @Test func projectIdsAreCheckedAsTheServerChecksThem() {
        for bad in [".", "..", "...", "café", "a/b", "has spaces", String(repeating: "a", count: 129)] {
            #expect(NotatoConfiguration(project: bad).problem != nil, "\(bad)")
        }
        for good in ["shop-ios", "a.b", "..a", "team@shop_2"] {
            #expect(NotatoConfiguration(project: good).problem == nil, "\(good)")
        }
    }

    @Test func anIdFromTheServerCannotDeleteAnythingOutsideTheStore() async throws {
        let base = try temporary()
        defer { try? FileManager.default.removeItem(at: base) }
        let sentinel = base.appendingPathComponent("keep.txt")
        try Data("keep".utf8).write(to: sentinel)
        let store = LocalStore(base: base.appendingPathComponent("notato"), project: "shop-ios")
        try await store.keep(note("01M471ZCEXZ4AEZHN0YP8RGVW4"))
        for id in ["../..", "..", "../../keep.txt", "/", ""] { await store.remove(id) }
        #expect(FileManager.default.fileExists(atPath: sentinel.path))
        #expect(await store.load().count == 1, "and nothing inside it either")
        await store.remove("01M471ZCEXZ4AEZHN0YP8RGVW4")
        #expect(await store.load().isEmpty)
    }

    @Test func badIdsAreNeverWrittenEither() async throws {
        let base = try temporary()
        defer { try? FileManager.default.removeItem(at: base) }
        let store = LocalStore(base: base.appendingPathComponent("notato"), project: "shop-ios")
        try await store.keep(note("../escaped"))
        try await store.keep(note("01M471ZCEXZ4AEZHN0YP8RGVW4"), screenshots: ["../../shot": Data([1]), String(repeating: "a", count: 64): Data([2])])
        #expect(!FileManager.default.fileExists(atPath: base.appendingPathComponent("notato/escaped").path))
        #expect(!FileManager.default.fileExists(atPath: base.appendingPathComponent("shot.png").path))
        #expect(await store.load().map { $0.assets.keys.sorted() } == [[String(repeating: "a", count: 64)]])
    }

    @Test func aProjectOfDotsClearsOnlyItsOwnFolder() async throws {
        let base = try temporary()
        defer { try? FileManager.default.removeItem(at: base) }
        let notato = base.appendingPathComponent("notato")
        let other = LocalStore(base: notato, project: "other")
        try await other.keep(note("01M471ZCEXZ4AEZHN0YP8RGVW4"))
        let dots = LocalStore(base: notato, project: "..")
        #expect(await dots.root.lastPathComponent == "p-2e2e")
        try await dots.keep(note("01M471ZCEXZ4AEZHN0YP8RGVW5"))
        await dots.clear()
        #expect(await dots.load().isEmpty)
        #expect(await other.load().count == 1)
        #expect(FileManager.default.fileExists(atPath: base.path))
    }

    @Test func aRefusalIsKeptForTheNextLaunch() async throws {
        let base = try temporary()
        defer { try? FileManager.default.removeItem(at: base) }
        let store = LocalStore(base: base, project: "shop-ios")
        try await store.keep(note("01M471ZCEXZ4AEZHN0YP8RGVW4"))
        try await store.keep(note("01M471ZCEXZ4AEZHN0YP8RGVW5"))
        await store.refuse("01M471ZCEXZ4AEZHN0YP8RGVW4", because: "annotation.target.identity.0.text: Too big")
        await store.refuse("../..", because: "never written")
        let relaunched = LocalStore(base: base, project: "shop-ios")
        #expect(await relaunched.load().map(\.refusal) == ["annotation.target.identity.0.text: Too big", nil])
    }
}

@Suite("Sending the queue")
@MainActor
struct QueueTests {
    private func records(_ count: Int) -> [NoteRecord] {
        (0..<count).map { n in
            var annotation = Fixture.annotation()
            annotation.id = "01M471ZCEXZ4AEZHN0YP8RGVW\(n)"
            return NoteRecord(annotation, pending: true, mine: true)
        }
    }

    @Test(arguments: [400, 409, 413, 415, 422])
    nonisolated func theseRefuseTheNoteItself(status: Int) {
        #expect(NotatoServerError(message: "no", status: status).refusesNote)
    }

    @Test(arguments: [0, 200, 401, 403, 404, 408, 429, 500, 502, 503])
    nonisolated func theseHoldTheQueue(status: Int) {
        #expect(!NotatoServerError(message: "not now", status: status).refusesNote)
    }

    @Test func aRefusedNoteIsPassedOverAndTheRestStillGo() async {
        let queue = records(4)
        var tried: [String] = []
        let stopped = await Notato.drain(queue) { record in
            tried.append(record.id)
            if record === queue[1] {
                record.error = "Too big"
                return .refused("Too big")
            }
            record.pending = false
            return .sent
        }
        #expect(stopped == nil)
        #expect(tried == queue.map(\.id))
        #expect(queue.filter(\.pending).map(\.id) == [queue[1].id])
        // On the next try (or launch, `LocalStore.refuse`) it is not sent again.
        tried = []
        _ = await Notato.drain(queue) { tried.append($0.id); return .sent }
        #expect(tried.isEmpty)
    }

    @Test func anythingElseStopsTheQueueWithEverythingStillQueued() async {
        let queue = records(4)
        var tried: [String] = []
        let unknown = NotatoServerError(message: "project \"x\" does not exist on this server: create it first", status: 404)
        let stopped = await Notato.drain(queue) { record in
            tried.append(record.id)
            if record === queue[1] { return .held(unknown) }
            record.pending = false
            return .sent
        }
        #expect(stopped == unknown)
        #expect(tried == [queue[0].id, queue[1].id])
        #expect(queue.filter(\.pending).count == 3)
        #expect(SendOutcome.held(unknown).problem == "Saved on this device, not sent: \(unknown.message)", "the server's words are shown")
        #expect(SendOutcome.held(NotatoServerError(message: "offline", status: 0)).problem == "Saved. It's sent when the server can be reached.")
    }

    @Test func aNoteDeletedWhileTheQueueIsSentIsNotSent() async {
        let queue = records(3)
        var tried: [String] = []
        _ = await Notato.drain(queue) { record in
            tried.append(record.id)
            queue[2].deleted = true
            return .sent
        }
        #expect(tried == [queue[0].id, queue[1].id])
    }

    @Test func onlyNotesTheServerHadBeforeTheLoadAndNoLongerListsAreForgotten() {
        let notes = records(4)
        notes[0].pending = false
        notes[1].pending = false
        // notes[2] is waiting to be sent, notes[3] was made (and sent) while the pages came.
        notes[3].pending = false
        let known: Set<String> = [notes[0].id, notes[1].id]
        var listed = StoredAnnotation(seq: 1, annotation: Fixture.annotation())
        listed.annotation.id = notes[0].id
        #expect(Notato.forgotten(known: known, listed: [listed], now: notes) == [notes[1].id])
        #expect(Notato.forgotten(known: known.union([notes[2].id]), listed: [listed], now: notes) == [notes[1].id], "never one waiting to be sent")
    }
}

/// Answers a test's requests in place of a server.
final class StubServer: URLProtocol, @unchecked Sendable {
    /// A request as the server got it.
    struct Seen: Sendable {
        var method: String
        var url: URL
        var body: Data
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var answer: @Sendable (URLRequest) -> (Int, Data) = { _ in (404, Data()) }
    nonisolated(unsafe) private static var seen: [Seen] = []

    static func client(_ answer: @escaping @Sendable (URLRequest) -> (Int, Data)) -> NotatoClient {
        lock.lock()
        self.answer = answer
        seen = []
        lock.unlock()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubServer.self]
        return NotatoClient(base: URL(string: "http://stub.test")!, token: nil, session: URLSession(configuration: configuration))
    }

    static var requests: [URL] { received.map(\.url) }

    static var received: [Seen] {
        lock.lock()
        defer { lock.unlock() }
        return seen
    }

    /// A body set on a request reaches a URLProtocol as a stream.
    static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        Self.lock.lock()
        Self.seen.append(Seen(method: request.httpMethod ?? "GET", url: request.url!, body: Self.body(of: request)))
        let answer = Self.answer
        Self.lock.unlock()
        let (status, body) = answer(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
}

@Suite("The client against a server", .serialized)
struct ClientTests {
    /// A project of `count` notes, served `limit` at a time as the server pages them.
    static func pages(_ count: Int, paging: Bool = true) -> @Sendable (URLRequest) -> (Int, Data) {
        { request in
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let limit = query.first { $0.name == "limit" }?.value.flatMap(Int.init) ?? count
            let after = query.first { $0.name == "afterSeq" }?.value.flatMap(Int.init) ?? 0
            let seqs = Array((after + 1)...max(after + 1, count)).prefix(limit).filter { $0 <= count }
            let items = seqs.map { seq -> StoredAnnotation in
                var annotation = Fixture.annotation()
                annotation.id = String(format: "note%05d", seq)
                return StoredAnnotation(seq: seq, annotation: annotation)
            }
            let next = paging && items.count == limit ? items.last?.seq : nil
            return (200, try! NotatoJSON.encoder.encode(AnnotationList(items: items, next: next)))
        }
    }

    @Test func everyPageIsReadNotJustTheFirst500() async throws {
        let client = StubServer.client(Self.pages(1_201))
        let items = try await client.list(project: "shop-ios")
        #expect(items.count == 1_201)
        #expect(items.last?.annotation.id == "note01201", "the newest notes are there")
        #expect(StubServer.requests.map { $0.query ?? "" } == ["limit=500", "limit=500&afterSeq=500", "limit=500&afterSeq=1000"])
    }

    @Test func aServerFromBeforePagingIsReadInOne() async throws {
        let client = StubServer.client(Self.pages(30, paging: false))
        #expect(try await client.list(project: "shop-ios").count == 30)
        #expect(StubServer.requests.count == 1)
    }

    @Test func aPageThatFailsFailsTheWholeList() async {
        let pages = Self.pages(1_201)
        let client = StubServer.client { request in
            request.url?.query?.contains("afterSeq=500") == true ? (503, Data("{\"error\":\"busy\"}".utf8)) : pages(request)
        }
        await #expect(throws: NotatoServerError.self) { try await client.list(project: "shop-ios") }
    }

    @Test func aCursorThatDoesNotMoveOnIsNotFollowedForEver() async {
        let client = StubServer.client { _ in
            (200, try! NotatoJSON.encoder.encode(AnnotationList(items: [StoredAnnotation(seq: 7, annotation: Fixture.annotation())], next: 7)))
        }
        await #expect(throws: NotatoServerError.self) { try await client.list(project: "shop-ios") }
        #expect(StubServer.requests.count == 2)
    }

    @Test func aRefusalAndAnUnknownProjectComeBackWithTheServersWords() async {
        let unknown = "project \"shop-ios\" does not exist on this server: ask its admin to create it"
        let client = StubServer.client { request in
            request.url?.path.hasPrefix("/projects/shop-ios/") == true
                ? (404, try! JSONEncoder().encode(["error": unknown]))
                : (422, Data("{\"error\":\"annotation.id: ids are 1 to 128 letters, digits, _ or -\"}".utf8))
        }
        var annotation = Fixture.annotation()
        annotation.projectId = "shop-ios"
        do {
            _ = try await client.post(annotation, assets: [:])
            Issue.record("expected the server to say no")
        } catch let error as NotatoServerError {
            #expect(error.status == 404 && !error.refusesNote && error.message == unknown)
        } catch {
            Issue.record("\(error)")
        }
        annotation.projectId = "other"
        await #expect(throws: NotatoServerError(message: "annotation.id: ids are 1 to 128 letters, digits, _ or -", status: 422)) {
            try await client.post(annotation, assets: [:])
        }
    }
}

extension ClientTests {
    static func stored(_ annotation: Annotation) -> Data {
        try! NotatoJSON.encoder.encode(StoredAnnotation(seq: 3, annotation: annotation))
    }

    @Test func peopleOnlyIsTurnedOnAndOffWithAPatchAsThePerson() async throws {
        let dom = Author.human("Dom")
        let on = Fixture.annotation().settingPeopleOnly(true, by: dom)
        let client = StubServer.client { request in
            (200, Self.stored(String(decoding: StubServer.body(of: request), as: UTF8.self).contains("true") ? on : Fixture.annotation()))
        }
        #expect(try await client.setPeopleOnly(id: on.id, true, author: dom).annotation.isPeopleOnly)
        #expect(try await !client.setPeopleOnly(id: on.id, false, author: dom).annotation.isPeopleOnly)
        let sent = StubServer.received
        #expect(sent.map(\.method) == ["PATCH", "PATCH"])
        #expect(sent.allSatisfy { $0.url.path == "/annotations/\(on.id)" })
        #expect(sent.map { String(decoding: $0.body, as: UTF8.self) } == [
            #"{"author":{"kind":"human","name":"Dom"},"peopleOnly":true}"#,
            #"{"author":{"kind":"human","name":"Dom"},"peopleOnly":false}"#,
        ])
    }

    @Test func onlyAPersonMayAndTheServersWordsSaySo() async {
        let words = "only a person can turn People only on or off: it is how people keep a note from the agent"
        let client = StubServer.client { _ in (403, try! JSONEncoder().encode(["error": words])) }
        await #expect(throws: NotatoServerError(message: words, status: 403)) {
            try await client.setPeopleOnly(id: "01M471ZCEXZ4AEZHN0YP8RGVW4", true, author: .agent("claude"))
        }
    }

    @Test func anAsideIsSentAsOneAndAPlainReplyLeavesTheKeyOut() async throws {
        let client = StubServer.client { _ in (201, Self.stored(Fixture.annotation())) }
        _ = try await client.reply(id: "n1", text: "Between us: check with design first", author: .human("Dom"), aside: true)
        _ = try await client.reply(id: "n1", text: "Thanks", author: .human("Dom"))
        let sent = StubServer.received
        #expect(sent.allSatisfy { $0.method == "POST" && $0.url.path == "/annotations/n1/replies" })
        #expect(sent.map { String(decoding: $0.body, as: UTF8.self) } == [
            #"{"aside":true,"author":{"kind":"human","name":"Dom"},"body":"Between us: check with design first"}"#,
            #"{"author":{"kind":"human","name":"Dom"},"body":"Thanks"}"#,
        ])
    }
}

/// Sending and connecting, against a stubbed server: in this suite, as `StubServer` is one for all.
extension ClientTests {
    @Test func theListIsReadAsASummary() async throws {
        let client = StubServer.client(Self.pages(3))
        _ = try await client.list(project: "shop-ios", summary: true)
        #expect(StubServer.requests.map { $0.query ?? "" } == ["limit=500&fields=summary"])
    }

    @Test @MainActor func onConnectingTheNotesWaitingGoBeforeTheListIsRead() async throws {
        let notato = NoteIndexTests.notato()
        let waiting = NoteRecord(NoteIndexTests.note(7), pending: true, mine: true)
        notato.insert([waiting])
        let listed = NoteIndexTests.note(8)
        notato.client = StubServer.client { request in
            switch (request.httpMethod ?? "GET", request.url!.path) {
            case ("POST", _): return (201, Self.stored(NoteIndexTests.note(7)))
            case ("GET", "/config"): return (200, Data("{}".utf8))
            default:
                var summary = listed
                summary.context = [:]
                return (200, try! NotatoJSON.encoder.encode(AnnotationList(items: [StoredAnnotation(seq: 1, annotation: NoteIndexTests.note(7)),
                                                                                  StoredAnnotation(seq: 2, annotation: summary)], next: nil)))
            }
        }
        await notato.handle(ServerSentEvent(event: "hello", data: "{}"), client: notato.client!)
        #expect(StubServer.received.map { "\($0.method) \($0.url.path)\($0.url.query.map { "?\($0)" } ?? "")" } == [
            "GET /config",
            "POST /projects/swift-sample/annotations",
            "GET /projects/swift-sample/annotations?limit=500&fields=summary",
        ])
        #expect(!waiting.pending)
        #expect(notato.records.map(\.id) == ["note00007", "note00008"], "the waiting note is not forgotten: it was sent first")
    }

    @Test @MainActor func aNewerCopyFromAnEventWinsOverTheAnswerToTheSend() async throws {
        let notato = NoteIndexTests.notato()
        let record = NoteRecord(NoteIndexTests.note(3), pending: true, mine: true)
        notato.insert([record])
        var acknowledged = NoteIndexTests.note(3)
        acknowledged.status = Status.acknowledged
        let newer = acknowledged
        notato.client = StubServer.client { _ in
            // While the POST is on its way the agent acknowledges the note, and the event for it lands first.
            DispatchQueue.main.sync { MainActor.assumeIsolated { notato.upsert(newer) } }
            return (201, Self.stored(NoteIndexTests.note(3)))
        }
        #expect(await notato.send(record) == .sent)
        #expect(!record.pending)
        #expect(record.annotation.status == Status.acknowledged, "the answer's older copy does not overwrite it")

        // With no event, the answer's copy is taken.
        let second = NoteRecord(NoteIndexTests.note(4), pending: true, mine: true)
        notato.insert([second])
        var stored = NoteIndexTests.note(4)
        stored.thread = [Reply(id: "r1", author: .agent("claude"), body: "On it", createdAt: stored.createdAt)]
        let answer = stored
        notato.client = StubServer.client { _ in (201, Self.stored(answer)) }
        #expect(await notato.send(second) == .sent)
        #expect(second.annotation.thread.count == 1)
    }

    @Test @MainActor func theTokenGoesOnlyToTheServerItWasConfiguredFor() {
        var configuration = NotatoConfiguration(project: "shop-ios", server: URL(string: "http://notato.example:4747"))
        configuration.token = "pft_secret"
        for (server, gets) in [("http://notato.example:4747", true), ("http://NOTATO.example:4747/", true),
                               ("https://notato.example:4747", false), ("http://notato.example", false),
                               ("http://notato.example:4748", false), ("http://evil.example:4747", false),
                               ("http://notato.example.evil.example:4747", false)] {
            #expect((Notato.token(for: URL(string: server)!, configuration: configuration) != nil) == gets, "\(server)")
        }
        var https = NotatoConfiguration(project: "shop-ios", server: URL(string: "https://notato.example"))
        https.token = "pft_secret"
        #expect(Notato.token(for: URL(string: "https://notato.example:443/")!, configuration: https) == "pft_secret", "the scheme's own port")
        let local = NotatoConfiguration(project: "shop-ios")
        #expect(Notato.token(for: NotatoConfiguration.defaultServer, configuration: local) == nil, "no token, none sent")

        // The clients Notato makes: the configured server's has the token, one typed into Settings has none.
        let notato = Notato(configuration: configuration)
        #expect(notato.client(for: URL(string: "http://notato.example:4747")!).token == "pft_secret")
        #expect(notato.client(for: URL(string: "http://typed.example:4747")!).token == nil)
    }

    @Test func aCancelledRequestIsACancellationNotAnUnreachableServer() {
        #expect(NotatoClient.isCancellation(URLError(.cancelled)))
        #expect(NotatoClient.isCancellation(CancellationError()))
        #expect(!NotatoClient.isCancellation(URLError(.cannotConnectToHost)))
    }
}

@Suite("The event stream")
struct EventStreamTests {
    private func feed(_ text: String, into reader: inout ServerSentEventReader) throws -> [ServerSentEvent] {
        try Data(text.utf8).compactMap { try reader.feed($0) }
    }

    @Test func eventsAreReadAByteAtATime() throws {
        var reader = ServerSentEventReader()
        let events = try feed(": ping\n\nevent: hello\r\ndata: {}\r\n\r\nevent: created\ndata: {\"a\":\ndata: 1}\n\n", into: &reader)
        #expect(events == [ServerSentEvent(event: "hello", data: "{}"), ServerSentEvent(event: "created", data: "{\"a\":\n1}")])
    }

    @Test func anEventPastTheLimitDropsTheStreamRatherThanGrowing() throws {
        var reader = ServerSentEventReader(maxEvent: 64)
        #expect(throws: NotatoServerError.self) { _ = try feed("data: " + String(repeating: "x", count: 100), into: &reader) }
        // Many lines of one event count together; pings between events do not.
        var lines = ServerSentEventReader(maxEvent: 64)
        #expect(throws: NotatoServerError.self) { _ = try feed(String(repeating: "data: 0123456789\n", count: 8), into: &lines) }
        var pings = ServerSentEventReader(maxEvent: 64)
        #expect(try feed(String(repeating: ": ping\n", count: 100) + "data: ok\n\n", into: &pings).map(\.data) == ["ok"])
        #expect(NotatoClient.maxEvent == 4 << 20)
    }
}

@Suite("Packages and the screenshots kept on the device")
struct PackageTests {
    private func temporary() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("notato-package-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    @Test func keptScreenshotsAreFilesAndReadOnlyWhenWanted() async throws {
        let base = try temporary()
        defer { try? FileManager.default.removeItem(at: base) }
        let store = LocalStore(base: base, project: "shop-ios")
        let shot = String(repeating: "a", count: 64)
        let kept = try await store.keep(Fixture.annotation(), screenshots: [shot: Data([137, 80, 78, 71])])
        guard case let .file(url)? = kept[shot] else {
            Issue.record("kept in memory: \(kept)")
            return
        }
        #expect(url.lastPathComponent == "\(shot).png")
        let loaded = await store.load()
        guard case let .file(listed)? = loaded.first?.assets[shot] else {
            Issue.record("a launch lists the files, it does not read them: \(loaded)")
            return
        }
        #expect(listed.resolvingSymlinksInPath() == url.resolvingSymlinksInPath())
        #expect(KeptAsset.read(loaded[0].assets) == [shot: Data([137, 80, 78, 71])])
        try FileManager.default.removeItem(at: url)
        #expect(KeptAsset.read(loaded[0].assets).isEmpty, "a file gone since is left out")
        #expect(BundleWriter.build(loaded, project: "shop-ios", author: nil, appName: nil, appVersion: nil).files.isEmpty)
    }

    @Test func aZipCountsUpTo65535EntriesAndRefusesTheNext() throws {
        let folder = try temporary()
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("full.zip")
        var writer = try ZipWriter(creating: file)
        for n in 0..<ZipWriter.maxEntries { try writer.add("e\(n)", Data()) }
        #expect(throws: NotatoError.self, "the 65,536th used to trap") { try writer.add("one too many", Data()) }
        try writer.finish()
        #if os(macOS)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/zipinfo")
        process.arguments = ["-t", file.path]
        let pipe = Pipe()
        process.standardOutput = pipe
        try process.run()
        let summary = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        process.waitUntilExit()
        #expect(summary.hasPrefix("65535 files"), "\(summary)")
        #endif
    }

    @Test func aPackageWithMoreFilesThanAZipCanCountIsRefusedBeforeAnythingIsWritten() throws {
        let folder = try temporary()
        defer { try? FileManager.default.removeItem(at: folder) }
        let bundle = BundleWriter.build([], project: "shop-ios", author: nil, appName: nil, appVersion: nil).bundle
        let files = Dictionary(uniqueKeysWithValues: (0..<ZipWriter.maxEntries - 1).map { ("shots/\($0).png", KeptAsset.bytes(Data())) })
        let file = folder.appendingPathComponent("too-many.zip")
        #expect(throws: NotatoError.self) { try BundleWriter.write(bundle, files: files, to: file) }
        #expect(!FileManager.default.fileExists(atPath: file.path))
    }

    @Test func aScreenshotThatCannotBeReadLeavesNoHalfWrittenPackage() throws {
        let folder = try temporary()
        defer { try? FileManager.default.removeItem(at: folder) }
        let bundle = BundleWriter.build([], project: "shop-ios", author: nil, appName: nil, appVersion: nil).bundle
        let file = folder.appendingPathComponent("broken.zip")
        #expect(throws: (any Error).self) {
            try BundleWriter.write(bundle, files: ["shots/01-full.png": .file(folder.appendingPathComponent("gone.png"))], to: file)
        }
        #expect(!FileManager.default.fileExists(atPath: file.path))
    }
}

@Suite("People only and asides")
struct PeopleOnlyTests {
    private let dom = Author.human("Dom")
    private let at = Date(timeIntervalSince1970: 1_791_360_000)

    private func object(_ value: some Encodable) throws -> [String: Any] {
        try #require(try JSONSerialization.jsonObject(with: NotatoJSON.encoder.encode(value)) as? [String: Any])
    }

    @Test func turningPeopleOnlyOnSetsTheFlagAndRecordsItAsTheServerDoes() throws {
        let on = Fixture.annotation().settingPeopleOnly(true, by: dom, at: at)
        #expect(on.peopleOnly == true)
        let entry = try #require(on.thread.last)
        #expect(on.thread.count == 1)
        #expect(entry.author == dom)
        #expect(entry.automatic == true && entry.peopleOnly == true && entry.aside == nil)
        #expect(entry.body == "Made this people only: the agent won't see it.")
        #expect(entry.createdAt == NotatoJSON.timestamp(at))
        #expect(entry.id.range(of: "^[0-9A-HJKMNP-TV-Z]{26}$", options: .regularExpression) != nil)
        #expect(try object(on)["peopleOnly"] as? Bool == true)
        let written = try #require((try object(on)["thread"] as? [[String: Any]])?.first)
        #expect(written["automatic"] as? Bool == true && written["peopleOnly"] as? Bool == true && written["aside"] == nil)
    }

    @Test func turningItOffLeavesTheKeyOutAndRecordsThatToo() throws {
        let off = Fixture.annotation().settingPeopleOnly(true, by: dom, at: at).settingPeopleOnly(false, by: dom, at: at.addingTimeInterval(60))
        #expect(off.peopleOnly == nil)
        #expect(off.thread.map(\.peopleOnly) == [true, false])
        #expect(off.thread.map(\.body) == ["Made this people only: the agent won't see it.", "Shared this with the agent."])
        #expect(try object(off)["peopleOnly"] == nil, "off is not written, as the server leaves it out")
        let entries = try #require(try object(off)["thread"] as? [[String: Any]])
        #expect(entries[1]["peopleOnly"] as? Bool == false, "but the entry for turning it off says false")
    }

    @Test func settingItTheWayItIsChangesNothing() {
        let note = Fixture.annotation()
        #expect(note.settingPeopleOnly(false, by: dom) == note)
        let on = note.settingPeopleOnly(true, by: dom)
        #expect(on.settingPeopleOnly(true, by: dom) == on)
    }

    @Test func isPeopleOnlyNeverWritesFalse() throws {
        var note = Fixture.annotation()
        #expect(try object(note)["peopleOnly"] == nil)
        note.isPeopleOnly = true
        #expect(note.peopleOnly == true)
        #expect(try object(note)["peopleOnly"] as? Bool == true)
        note.isPeopleOnly = false
        #expect(note.peopleOnly == nil)
        #expect(try object(note)["peopleOnly"] == nil)
    }

    @Test func aReplyWritesAsideOnlyWhenItIsOne() throws {
        let plain = Reply(id: "01M471ZCEXZ4AEZHN0YP8RGVW4", author: dom, body: "Thanks", createdAt: "2026-10-07T08:00:00.000Z")
        #expect(Set(try object(plain).keys) == ["id", "author", "body", "createdAt"])
        var aside = plain
        aside.aside = true
        #expect(try object(aside)["aside"] as? Bool == true)
    }

    @Test func whatTheServerWritesReadsBack() throws {
        let json = #"{"id":"01M471ZCEXZ4AEZHN0YP8RGVW4","author":{"kind":"human","name":"Dom"},"body":"Shared this with the agent.","createdAt":"2026-10-07T08:00:00.000Z","automatic":true,"peopleOnly":false}"#
        let reply = try NotatoJSON.decoder.decode(Reply.self, from: Data(json.utf8))
        #expect(reply.automatic == true && reply.peopleOnly == false && reply.aside == nil)
        var text = String(decoding: try NotatoJSON.encoder.encode(Fixture.annotation()), as: UTF8.self)
        text = text.replacingOccurrences(of: "\"thread\":[]", with: "\"peopleOnly\":true,\"thread\":[{\"id\":\"r1\",\"author\":{\"kind\":\"human\"},\"body\":\"psst\",\"createdAt\":\"2026-10-07T08:00:00.000Z\",\"aside\":true}]")
        let note = try NotatoJSON.decoder.decode(Annotation.self, from: Data(text.utf8))
        #expect(note.isPeopleOnly)
        #expect(note.thread.first?.aside == true)
    }

    @Test func aNewNoteSentPeopleOnlySaysSoInTheForm() throws {
        var note = Fixture.annotation()
        note.isPeopleOnly = true
        let text = String(decoding: try NotatoClient.form(note, assets: [:], boundary: "B"), as: UTF8.self)
        #expect(text.contains("\"peopleOnly\":true"))
    }

    @Test func aPeopleOnlyNoteWithAnAsideAndItsHistoryPassesTheServersSchema() throws {
        var note = Fixture.annotation().settingPeopleOnly(true, by: dom, at: at)
        note.thread.append(Reply(id: ULID.make(at: at), author: dom, body: "Between us: check with design first.", createdAt: NotatoJSON.timestamp(at), aside: true))
        note = note.settingPeopleOnly(false, by: dom, at: at.addingTimeInterval(60))
        guard let result = try Fixture.validate("annotation", try NotatoJSON.encoder.encode(note)) else { return }
        #expect(result.ok, "\(result.output)")
        note.isPeopleOnly = true
        #expect(try Fixture.validate("annotation", try NotatoJSON.encoder.encode(note))?.ok == true)
    }

    @Test func aPackageCarriesPeopleOnlyAndItsHistory() throws {
        let note = Fixture.annotation().settingPeopleOnly(true, by: dom, at: at)
        let (bundle, _) = BundleWriter.build([LocalAnnotation(annotation: note, assets: [:])], project: "swift-sample", author: "Dom",
                                             appName: "Sample", appVersion: "1.0")
        #expect(bundle.annotations[0].isPeopleOnly)
        #expect(bundle.annotations[0].thread.map(\.peopleOnly) == [true])
        if let result = try Fixture.validate("bundle", try NotatoJSON.encoder.encode(bundle)) { #expect(result.ok, "\(result.output)") }
    }
}

/// `Notato.setPeopleOnly` where no server is needed: a note this device has not sent yet.
@Suite("People only on the device")
@MainActor
struct PeopleOnlyOnTheDeviceTests {
    private func note(pending: Bool) -> NoteRecord {
        var annotation = Fixture.annotation()
        annotation.id = ULID.make()
        let record = NoteRecord(annotation, pending: pending, mine: true)
        Notato.shared.insert([record])
        return record
    }

    private func forget(_ record: NoteRecord) { Notato.shared.forget { $0 === record } }

    @Test func aNoteNotSentYetIsChangedHereWithTheSameEntryTheServerWrites() async throws {
        let record = note(pending: true)
        defer { forget(record) }
        try await Notato.shared.setPeopleOnly(record.id, true)
        #expect(record.annotation.isPeopleOnly)
        let entry = try #require(record.annotation.thread.last)
        #expect(entry.automatic == true && entry.peopleOnly == true && entry.author.kind == "human")
        #expect(entry.body == "Made this people only: the agent won't see it.")
        try await Notato.shared.setPeopleOnly(record.id, true)
        #expect(record.annotation.thread.count == 1, "no change, no entry")
        try await Notato.shared.setPeopleOnly(record.id, false)
        #expect(!record.annotation.isPeopleOnly)
        #expect(record.annotation.thread.map(\.peopleOnly) == [true, false])
        #expect(record.pending, "still to be sent, with the flag")
    }

    @Test func oneTheServerHasIsChangedOnlyThere() async {
        let record = note(pending: false)
        defer { forget(record) }
        await #expect(throws: NotatoError.self) { try await Notato.shared.setPeopleOnly(record.id, true) }
        #expect(!record.annotation.isPeopleOnly && record.annotation.thread.isEmpty)
    }

    @Test func oneOnItsWayToTheServerIsLeftAlone() async {
        let record = note(pending: true)
        record.sending = true
        defer { forget(record) }
        await #expect(throws: NotatoError.self) { try await Notato.shared.setPeopleOnly(record.id, true) }
        #expect(!record.annotation.isPeopleOnly && record.annotation.thread.isEmpty)
    }
}

@Suite("Text clipped to the schema")
struct ClipTests {
    @Test func aShortTextIsLeftAlone() {
        #expect("Add to cart".clipped(toScalars: 200) == "Add to cart")
        #expect(String(repeating: "a", count: 200).clipped(toScalars: 200).count == 200)
    }

    @Test func emojiWithSkinTonesAreCountedAsTheServerCountsThem() {
        let thumbs = String(repeating: "👍🏽", count: 120)
        #expect(thumbs.count == 120, "fits by Swift's count")
        let clipped = thumbs.clipped(toScalars: 200)
        #expect(clipped.unicodeScalars.count <= 200)
        #expect(clipped == String(repeating: "👍🏽", count: 99) + "…", "no emoji is split from its tone")
    }

    @Test func aHindiSentenceIsCutBetweenSyllables() {
        let sentence = String(repeating: "हिन्दी में लिखा गया वाक्य ", count: 9)
        #expect(sentence.count <= 200 && sentence.unicodeScalars.count > 200)
        let clipped = sentence.clipped(toScalars: 200)
        #expect(clipped.unicodeScalars.count <= 200)
        #expect(sentence.hasPrefix(String(clipped.dropLast())), "whole characters only")
        #expect(clipped.hasSuffix("…"))
    }

    @Test func oneCharacterLongerThanTheLimitIsCutInside() {
        let pile = "a" + String(repeating: "\u{0301}", count: 300)
        #expect(pile.count == 1)
        #expect(pile.clipped(toScalars: 200).unicodeScalars.count == 200)
    }

    @Test @MainActor func anIdentityOfLongEmojiAndHindiPassesTheServersSchema() throws {
        for label in [String(repeating: "👍🏽", count: 120), String(repeating: "हिन्दी में लिखा गया वाक्य ", count: 9)] {
            let element = ScreenElement(role: "button", label: label, value: nil, identifier: nil, frame: CGRect(x: 0, y: 0, width: 100, height: 40), control: "Button")
            let identity = IdentityBuilder.describe(element, among: [element], maskInputs: false, sourceRoot: nil)
            #expect((identity.text?.unicodeScalars.count ?? 0) <= ElementIdentity.textLimit)
            var annotation = Fixture.annotation()
            annotation.target.identity = [identity]
            guard let result = try Fixture.validate("annotation", try NotatoJSON.encoder.encode(annotation)) else { continue }
            #expect(result.ok, "\(result.output)")
            // Clipped by Swift's count, as it was, the server refuses it.
            annotation.target.identity[0].text = label.count > 200 ? String(label.prefix(199)) + "…" : label
            #expect(try Fixture.validate("annotation", try NotatoJSON.encoder.encode(annotation))?.ok == false)
        }
    }
}

@Suite("Pins")
struct PinLayoutTests {
    private func noOverlap(_ points: [CGPoint]) -> Bool {
        for (i, a) in points.enumerated() {
            for b in points[(i + 1)...] where abs(a.x - b.x) < PinLayout.clearance && abs(a.y - b.y) < PinLayout.clearance { return false }
        }
        return true
    }

    @Test func twoNotesOnAnElementAtTheLeftEdgeSitSideBySide() {
        // The element's right edge is under 34 points: the second pin used to be pushed left for ever.
        let rect = CGRect(x: 0, y: 300, width: 30, height: 30)
        let points = PinLayout.place([rect, rect], width: 402)
        #expect(points.count == 2 && noOverlap(points))
        #expect(points[0] == CGPoint(x: 18, y: 288))
    }

    @Test(arguments: [2, 5, 12, 40])
    func manyNotesNearTheLeftEdgeAllFindAPlace(count: Int) {
        let rect = CGRect(x: 4, y: 400, width: 60, height: 44)
        let points = PinLayout.place(Array(repeating: rect, count: count), width: 402)
        #expect(points.count == count)
        #expect(points.allSatisfy { $0.x >= PinLayout.margin && $0.x <= 402 - 26 })
        if count <= 12 { #expect(noOverlap(points)) }
    }

    @Test func beforeTheWindowsWidthIsKnownItStillEnds() {
        let rect = CGRect(x: 100, y: 200, width: 80, height: 40)
        let points = PinLayout.place(Array(repeating: rect, count: 6), width: 0)
        #expect(points.count == 6)
        #expect(noOverlap(Array(points.prefix(PinLayout.rows))), "rows below, then on top of each other")
    }

    @Test func aCrowdTooBigForTheRoomOverlapsRatherThanHangs() {
        let rect = CGRect(x: 0, y: 60, width: 20, height: 20)
        let points = PinLayout.place(Array(repeating: rect, count: 300), width: 120)
        #expect(points.count == 300)
    }

    @Test func notesOnDifferentElementsStayAtTheirElements() {
        let points = PinLayout.place([CGRect(x: 16, y: 217, width: 370, height: 40), CGRect(x: 16, y: 300, width: 370, height: 40)], width: 402)
        #expect(points == [CGPoint(x: 374, y: 205), CGPoint(x: 374, y: 288)])
    }
}

@Suite("Selectors with any screen name")
struct ScreenNameTests {
    let elements = [
        ScreenElement(role: "button", label: "Add to cart", value: nil, identifier: nil, frame: CGRect(x: 15, y: 500, width: 100, height: 40), control: "Button"),
        ScreenElement(role: "text", label: "Total", value: nil, identifier: "Total", frame: CGRect(x: 15, y: 560, width: 100, height: 20), control: "Text"),
    ]

    @Test(arguments: ["ProductList", "My cart", "settings", "Ünïcode Screen", "Say \"hi\"", "back\\slash", "Cart#2", "a:b", "日本語", "it's", "x(y)", "Product.List-2", ""])
    func whatIsWrittenReadsBack(screen: String) throws {
        for element in elements {
            let selector = Selectors.make(for: element, among: elements, screen: screen)
            let parsed = try Selectors.parse(selector)
            #expect(parsed.screen == screen, "\(selector)")
            #expect(try Selectors.query(selector, in: elements) == [element], "\(selector)")
        }
    }

    @Test func aCapitalisedWordStaysBareAndAnythingElseIsQuoted() {
        #expect(Selectors.make(for: elements[1], among: elements, screen: "Checkout") == "Checkout #Total")
        #expect(Selectors.make(for: elements[1], among: elements, screen: "My cart") == "\"My cart\" #Total")
        #expect(Selectors.make(for: elements[0], among: elements, screen: "settings") == "\"settings\" button:text(\"Add to cart\")")
    }

    @Test func aLowercaseScreenWordIsReadToo() throws {
        #expect(try Selectors.parse("settings button").screen == "settings")
        #expect(try Selectors.parse("settings button").role == "button")
    }
}

@Suite("Configuration edge cases")
struct ConfigurationEdgeTests {
    @Test(arguments: ["inf", "-inf", "nan", "1e300", "-5", "20"])
    func aLogLimitThatIsNotANumberOfLinesDoesNotCrash(value: String) {
        let configuration = NotatoConfiguration.from(["Project": "a"], environment: ["NOTATO_LOG_LIMIT": value])
        let limit = configuration?.logLimit ?? -1
        #expect((0...10_000).contains(limit))
        if value == "20" { #expect(limit == 20) }
        if value == "inf" || value == "nan" { #expect(limit == 50, "left at the default") }
    }
}

/// Set from an observation's `onChange`, which may not capture a variable.
final class Flag: @unchecked Sendable {
    var raised = false
}

@Suite("The notes, by id and by screen")
@MainActor
struct NoteIndexTests {
    nonisolated static func note(_ n: Int, route: String = "/ProductList", platform: String = "ios") -> Annotation {
        var annotation = Fixture.annotation()
        annotation.id = String(format: "note%05d", n)
        annotation.createdAt = NotatoJSON.timestamp(Date(timeIntervalSince1970: 1_791_360_000 + Double(n)))
        annotation.route = route
        annotation.environment.platform = platform
        return annotation
    }

    static func notato() -> Notato { Notato(configuration: NotatoConfiguration(project: "swift-sample", server: URL(string: "http://stub.test"))) }

    @Test func tenThousandListedNotesMergeIntoTenThousandRecordsInOnePass() {
        let notato = Self.notato()
        notato.insert((0..<10_000).map { NoteRecord(Self.note($0)) })
        // The server lists them as a summary (no context, no steps), every tenth acknowledged since.
        let listed = (0..<10_000).map { n -> Annotation in
            var annotation = Self.note(n)
            annotation.context = [:]
            annotation.steps = nil
            if n % 10 == 0 { annotation.status = Status.acknowledged }
            return annotation
        }
        let changed = Flag(), unchanged = Flag()
        withObservationTracking { _ = notato.record("note00000")?.annotation } onChange: { changed.raised = true }
        withObservationTracking { _ = notato.record("note00001")?.annotation } onChange: { unchanged.raised = true }

        let elapsed = ContinuousClock().measure { notato.merge(listed, summary: true) }
        print("Merged 10,000 listed notes into 10,000 records in \(elapsed)")
        #expect(elapsed < .seconds(1), "\(elapsed); well under 100 ms in a release build")
        #expect(notato.records.count == 10_000)
        #expect(notato.record("note00010")?.annotation.status == Status.acknowledged)
        #expect(notato.record("note00011")?.annotation.status == Status.open)
        #expect(notato.record("note00011")?.annotation.context.isEmpty == false, "a summary keeps the context known here")
        #expect(notato.record("note00011")?.annotation.steps?.count == 1)
        #expect(changed.raised && !unchanged.raised, "only a note that changed is set again, so only its views are drawn again")
    }

    @Test func aListAddsWhatIsNewAndSendsWhatWasWaiting() {
        let notato = Self.notato()
        let waiting = NoteRecord(Self.note(1), pending: true, mine: true, assets: ["shot": .bytes(Data([1]))])
        notato.insert([NoteRecord(Self.note(0)), waiting])
        var other = Self.note(9)
        other.projectId = "another-project"
        notato.merge([Self.note(1), Self.note(2), Self.note(2), other], summary: true)
        #expect(notato.records.map(\.id) == ["note00000", "note00001", "note00002"], "once each, and only this project's")
        #expect(!waiting.pending && waiting.assets == nil, "the server has it: it is not sent again")
        #expect(notato.record("note00002") != nil && notato.record("note00009") == nil)
    }

    @Test func forgettingANoteTakesItOutOfTheIndexAndTheScreens() {
        let notato = Self.notato()
        notato.insert((0..<5).map { NoteRecord(Self.note($0)) })
        #expect(notato.notes(onRoute: "/ProductList").count == 5)
        let before = notato.generation
        notato.forget { $0.id == "note00002" }
        #expect(notato.generation != before)
        #expect(notato.record("note00002") == nil && notato.records.count == 4)
        #expect(notato.notes(onRoute: "/ProductList").all.map(\.id) == ["note00000", "note00001", "note00003", "note00004"])
        notato.insert([NoteRecord(Self.note(2))])
        #expect(notato.notes(onRoute: "/ProductList").all.map(\.id).last == "note00004", "in pin order, not the order they came")
    }

    @Test func aScreensPinsAreTheNewest150MadeOnThisPlatformNumberedAmongAllItsNotes() {
        let notato = Self.notato()
        // 220 notes on one screen, of which 20 from a web page whose route has the same name, and 5 on another screen.
        let here = (0..<220).map { NoteRecord(Self.note($0, platform: $0 % 11 == 5 ? "web" : "ios")) }
        notato.insert((here + (220..<225).map { NoteRecord(Self.note($0, route: "/Checkout")) }).shuffled())
        let screen = notato.notes(onRoute: "/ProductList")
        #expect(screen.count == 220)
        #expect(screen.all.map(\.id) == here.map(\.id), "oldest first, so each keeps its number")
        #expect(screen.pinned.count == PinLayout.maxPins)
        #expect(screen.pinned.map(\.record.id) == here.filter { $0.platform == "ios" }.suffix(PinLayout.maxPins).map(\.id))
        #expect(screen.pinned.allSatisfy { screen.all[$0.number - 1] === $0.record }, "numbered as the Notes list numbers them")
        #expect(notato.notes(onRoute: "/Checkout").count == 5)
        #expect(screen.newest(50).map(\.number) == Array(171...220), "the Notes list: the newest 50, in pin order")
    }

    @Test func pinsAreLookedForAgainOnlyWhenTheScreenIsReadAgainOrANoteIsNew() {
        let notato = Self.notato()
        notato.insert((0..<3).map { NoteRecord(Self.note($0)) })
        let board = PinBoard()
        var looked: [String] = []
        let locate: (NoteRecord) -> CGRect? = { record in
            looked.append(record.id)
            return record.id == "note00002" ? nil : CGRect(x: 16, y: 200, width: 370, height: 40)
        }
        let first = board.pins(for: notato.notes(onRoute: "/ProductList").pinned, width: 402, scanned: true, locate: locate)
        #expect(looked.count == 3)
        #expect(first.map(\.number) == [1, 2, 3])
        #expect(first[2].detached && first[2].rect == CGRect(x: 16, y: 217, width: 370, height: 39.67), "not found: where it was made")
        #expect(first.map(\.origin) == PinLayout.place(first.map(\.rect), width: 402))

        // A tick with nothing new: nothing looked for, the pins where they were.
        #expect(board.pins(for: notato.notes(onRoute: "/ProductList").pinned, width: 402, scanned: false, locate: locate) == first)
        #expect(looked.count == 3)

        // A note's status changes: its pin shows it at once, without looking.
        notato.record("note00000")?.annotation.status = Status.resolved
        #expect(board.pins(for: notato.notes(onRoute: "/ProductList").pinned, width: 402, scanned: false, locate: locate)[0].status == Status.resolved)
        #expect(looked.count == 3)

        // A new note: only it is looked for.
        notato.insert([NoteRecord(Self.note(3))])
        #expect(board.pins(for: notato.notes(onRoute: "/ProductList").pinned, width: 402, scanned: false, locate: locate).count == 4)
        #expect(looked == ["note00000", "note00001", "note00002", "note00003"])

        // The screen read again: every one is.
        _ = board.pins(for: notato.notes(onRoute: "/ProductList").pinned, width: 402, scanned: true, locate: locate)
        #expect(looked.count == 8)
    }

    @Test func aNoteRecordParsesItsSelectorOnce() {
        let record = NoteRecord(Self.note(0))
        #expect(record.selector?.id == "PromoBanner")
        record.annotation.target.identity[0].selector = "button:text(\"Add to cart\")"
        #expect(record.selector?.text == "Add to cart", "parsed again when the server changes it")
        let elements = SelectorTests().elements
        for selector in ["button:text(\"Add to cart\"):nth(2)", "button", "#PromoBanner", "button:nth(9)"] {
            #expect(Selectors.first(try! Selectors.parse(selector), in: elements) == (try! Selectors.query(selector, in: elements)).first, "\(selector)")
        }
    }
}

@Suite("Pin layout at scale")
struct PinGridTests {
    /// The layout as it was before the grid: every place checked against every pin.
    private func reference(_ rects: [CGRect], width: CGFloat) -> [CGPoint] {
        var placed: [CGPoint] = []
        let maxX = max(PinLayout.margin, width - 26)
        let offsets: [CGFloat] = [0] + (1...PinLayout.sideways).map { -CGFloat($0) * PinLayout.step } + (1...PinLayout.sideways).map { CGFloat($0) * PinLayout.step }
        for rect in rects {
            let first = CGPoint(x: min(max(PinLayout.margin, rect.maxX - 12), maxX), y: max(PinLayout.top, rect.minY - 12))
            var found: CGPoint?
            search: for row in 0..<PinLayout.rows {
                for offset in offsets {
                    let spot = CGPoint(x: first.x + offset, y: first.y + CGFloat(row) * PinLayout.step)
                    guard spot.x >= PinLayout.margin, spot.x <= maxX else { continue }
                    if !placed.contains(where: { abs($0.x - spot.x) < PinLayout.clearance && abs($0.y - spot.y) < PinLayout.clearance }) {
                        found = spot
                        break search
                    }
                }
            }
            placed.append(found ?? first)
        }
        return placed
    }

    @Test func theGridPlacesEveryPinWhereCheckingEveryPinWould() {
        var generator = SystemRandomNumberGenerator()
        for _ in 0..<20 {
            let rects = (0..<300).map { _ in
                CGRect(x: CGFloat.random(in: -20...420, using: &generator).rounded(), y: CGFloat.random(in: 0...900, using: &generator).rounded(),
                       width: CGFloat.random(in: 0...200, using: &generator).rounded(), height: 40)
            }
            #expect(PinLayout.place(rects, width: 402) == reference(rects, width: 402))
        }
        let crowd = Array(repeating: CGRect(x: 100, y: 300, width: 40, height: 40), count: 400)
        #expect(PinLayout.place(crowd, width: 402) == reference(crowd, width: 402))
    }

    @Test func aThousandPinsOnOneSpotAreLaidOutInTimeInProportionToTheirNumber() {
        // Each place tried looks at nine cells, not at every pin placed: checking every pin took seconds here.
        let crowd = Array(repeating: CGRect(x: 100, y: 300, width: 40, height: 40), count: 1_000)
        let elapsed = ContinuousClock().measure { _ = PinLayout.place(crowd, width: 402) }
        #expect(elapsed < .seconds(2), "\(elapsed)")
    }

    @Test func aFrameThatIsNoPlaceStillGetsOne() {
        let points = PinLayout.place([.null, .infinite, CGRect(x: CGFloat.nan, y: 0, width: 1, height: 1), CGRect(x: 0, y: 1e300, width: 1, height: 1)], width: 402)
        #expect(points.count == 4)
        #expect(points.allSatisfy { $0.x.isFinite && $0.y.isFinite })
    }
}

@Suite("Screenshots are covered as they were taken")
struct CapturedTests {
    @Test func theCoversAreWhereThingsWereWhenThePictureWasTaken() {
        let card = CGRect(x: 0, y: 100, width: 402, height: 80)
        let email = ScreenElement(role: "textbox", label: "Email", value: "dom@example.com", identifier: nil,
                                  frame: CGRect(x: 16, y: 300, width: 370, height: 44), control: "TextField", isTextInput: true)
        let shot = Captured("the picture", size: CGSize(width: 402, height: 874), elements: [email], privateViews: [card], maskInputs: true)
        #expect(shot.covers == [card, email.frame])
        // The list scrolls before Send: what is private is 200 points higher now, and covering that would cover the
        // wrong part of the picture. The picture's covers are still where it shows them.
        var scrolled = email
        scrolled.frame = email.frame.offsetBy(dx: 0, dy: -200)
        #expect(Privacy.covered([scrolled], masks: [card.offsetBy(dx: 0, dy: -200)], maskInputs: true) != shot.covers)
        #expect(shot.covers == [card, email.frame])
        #expect(Captured("", size: .zero, elements: [email], privateViews: [], maskInputs: false).covers.isEmpty, "dev mode leaves fields showing")
    }
}

@Suite("The app's log")
struct LogTests {
    private struct Line {
        let date: Date
        let text: String
    }

    private let start = Date(timeIntervalSince1970: 1_791_360_000)

    private func lines(_ count: Int) -> [Line] {
        (0..<count).map { Line(date: start.addingTimeInterval(Double($0)), text: "line \($0)") }
    }

    @Test func readNewestFirstItStopsAtTheLimit() {
        var looked = 0
        let found = LogRecorder.last(5, of: lines(10_000).reversed(), since: start, date: \.date) { line in
            looked += 1
            return LogEntry(level: "info", message: line.text, at: "")
        }
        #expect(found.map(\.message) == (9_995..<10_000).map { "line \($0)" }, "the newest, newest last")
        #expect(looked == 5, "not one more than it needs")
    }

    @Test func readOldestFirstItKeepsOnlyTheLastOnTheWay() {
        let found = LogRecorder.last(5, of: lines(10_000), since: start.addingTimeInterval(9_000), date: \.date) { line in
            line.text.hasSuffix("7") ? nil : LogEntry(level: "info", message: line.text, at: "")
        }
        #expect(found.map(\.message) == ["line 9993", "line 9994", "line 9995", "line 9996", "line 9998", "line 9999"].suffix(5))
    }

    @Test func nothingBeforeTheStartIsTaken() {
        let found = LogRecorder.last(50, of: lines(20).reversed(), since: start.addingTimeInterval(15), date: \.date) {
            LogEntry(level: "info", message: $0.text, at: "")
        }
        #expect(found.map(\.message) == (15..<20).map { "line \($0)" })
    }

    @Test func aRingKeepsTheLastInOrder() {
        var ring = Ring<Int>(capacity: 3)
        for n in 1...7 { ring.append(n) }
        #expect(ring.inOrder == [5, 6, 7])
    }

    /// The real unified log (slow on macOS: a few seconds to open it).
    @Test func theAppsOwnMessagesAreReadBackNewestLast() async throws {
        let since = Date()
        let logger = Logger(subsystem: "com.example.notato-tests", category: "Log")
        let apple = Logger(subsystem: "com.apple.notato-tests", category: "x")
        for n in 0..<20 {
            logger.error("app message \(n, privacy: .public)")
            apple.error("framework message \(n, privacy: .public)")
        }
        try await Task.sleep(nanoseconds: 300_000_000)
        // Some machines cannot read this process's log back at all (logd refuses, or delivers late): with nothing of
        // ours there to read, there is nothing to test, and the rest of the suite covers the reading logic.
        let readable = (try? OSLogStore(scope: .currentProcessIdentifier).getEntries())?
            .contains { ($0 as? OSLogEntryLog)?.subsystem == "com.example.notato-tests" } ?? false
        guard readable else { return }
        let found = LogRecorder.recent(limit: 5, since: since)
        #expect(found.map(\.message) == (15..<20).map { "[Log] app message \($0)" })
        #expect(found.allSatisfy { $0.level == "error" })
    }
}

/// The network a recorded request is made again on, in place of a server: `/stream` answers in pieces, `/old`
/// redirects to `/new`, and `/private` asks who is asking.
final class RelayNetwork: URLProtocol, URLAuthenticationChallengeSender, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    /// Answers in pieces a tenth of a second apart, from this thread's run loop as a server's bytes would come.
    private func answer(_ status: Int, _ body: [String], headers: [String: String] = [:]) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        let rest = Pieces(body)
        let mode = RunLoop.current.currentMode ?? .default
        let timer = Timer(timeInterval: 0.1, repeats: true) { [self] timer in
            if let piece = rest.next() {
                client?.urlProtocol(self, didLoad: Data(piece.utf8))
            } else {
                timer.invalidate()
                client?.urlProtocolDidFinishLoading(self)
            }
        }
        RunLoop.current.add(timer, forMode: mode)
    }

    override func startLoading() {
        switch request.url!.path {
        case "/stream": answer(200, ["one ", "two ", "three"])
        case "/old":
            // As the system's own loading does: the redirect, then (for a session that does not follow it) its response.
            let response = HTTPURLResponse(url: request.url!, statusCode: 302, httpVersion: "HTTP/1.1", headerFields: ["Location": "/new"])!
            client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: URL(string: "http://app.test/new")!), redirectResponse: response)
            answer(302, ["moved"], headers: ["Location": "/new"])
        case "/new": answer(200, ["arrived"])
        case "/private":
            let space = URLProtectionSpace(host: "app.test", port: 80, protocol: "http", realm: "shop", authenticationMethod: NSURLAuthenticationMethodHTTPBasic)
            client?.urlProtocol(self, didReceive: URLAuthenticationChallenge(protectionSpace: space, proposedCredential: nil, previousFailureCount: 0,
                                                                             failureResponse: nil, error: nil, sender: self))
        default: answer(404, [])
        }
    }

    func use(_ credential: URLCredential, for challenge: URLAuthenticationChallenge) { answer(200, ["welcome \(credential.user ?? "?")"]) }
    func continueWithoutCredential(for challenge: URLAuthenticationChallenge) { answer(401, ["who?"]) }
    func cancel(_ challenge: URLAuthenticationChallenge) { client?.urlProtocol(self, didFailWithError: URLError(.userCancelledAuthentication)) }
    func performDefaultHandling(for challenge: URLAuthenticationChallenge) { answer(401, ["who?"]) }
    func rejectProtectionSpaceAndContinue(with challenge: URLAuthenticationChallenge) { answer(401, ["who?"]) }
}

/// What is left of an answer, handed out a piece at a time.
final class Pieces: @unchecked Sendable {
    private var rest: [String]
    init(_ pieces: [String]) { rest = pieces }
    func next() -> String? { rest.isEmpty ? nil : rest.removeFirst() }
}

/// The app's session's delegate, keeping what it is told.
final class AppSessionDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var _pieces: [Data] = []
    private var _redirects: [String] = []
    private var _challenges: [String] = []
    private var finished: CheckedContinuation<(URLResponse?, Error?), Never>?
    private var response: URLResponse?
    let follow: Bool

    init(follow: Bool = true) { self.follow = follow }

    var pieces: [Data] { lock.withLock { _pieces } }
    var redirects: [String] { lock.withLock { _redirects } }
    var challenges: [String] { lock.withLock { _challenges } }

    func load(_ path: String, through protocols: [AnyClass] = [NotatoNetworkRecorder.self]) async -> (response: HTTPURLResponse?, body: String, error: Error?) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = protocols
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let (response, error) = await withCheckedContinuation { continuation in
            lock.withLock { finished = continuation }
            session.dataTask(with: URL(string: "http://app.test\(path)?secret=1")!).resume()
        }
        return (response as? HTTPURLResponse, String(decoding: pieces.reduce(Data(), +), as: UTF8.self), error)
    }

    /// Starts a load and leaves it going (one that never ends, say).
    func start(_ url: URL) -> (URLSession, URLSessionDataTask) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [NotatoNetworkRecorder.self]
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        let task = session.dataTask(with: url)
        task.resume()
        return (session, task)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void) {
        lock.withLock { self.response = response }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.withLock { _pieces.append(data) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        lock.withLock { _redirects.append(request.url?.path ?? "") }
        completionHandler(follow ? request : nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        lock.withLock { _challenges.append(challenge.protectionSpace.realm ?? "") }
        completionHandler(.useCredential, URLCredential(user: "dom", password: "pw", persistence: .none))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let (continuation, response) = lock.withLock {
            defer { finished = nil }
            return (finished, self.response ?? task.response)
        }
        continuation?.resume(returning: (response, error))
    }
}

@Suite("Recording the app's requests", .serialized)
struct NetworkRecorderTests {
    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RelayNetwork.self]
        NotatoNetworkRecorder.useRelay(NotatoNetworkRecorder.Relay(configuration: configuration))
    }

    private func recorded(_ path: String) -> [NetworkEntry] {
        NotatoNetworkRecorder.snapshot().filter { $0.url == "http://app.test\(path)" }
    }

    @Test func theBodyReachesTheAppAPieceAtATimeAndTheRequestIsRecorded() async {
        let app = AppSessionDelegate()
        let (response, body, error) = await app.load("/stream")
        #expect(error == nil && response?.statusCode == 200)
        #expect(body == "one two three")
        #expect(recorded("/stream").last?.status == 200, "recorded, without its query")
    }

    @Test func aRedirectIsTheAppsSessionsToFollow() async {
        let app = AppSessionDelegate()
        let (response, body, error) = await app.load("/old")
        #expect(app.redirects == ["/new"], "the app's delegate was asked")
        #expect(error == nil && response?.statusCode == 200 && body == "arrived")
        #expect(recorded("/old").last?.status == 302 && recorded("/new").last?.status == 200)
    }

    @Test func aRedirectTheAppRefusesIsNotFollowed() async {
        let app = AppSessionDelegate(follow: false)
        let (response, body, error) = await app.load("/old")
        #expect(app.redirects == ["/new"])
        #expect(error == nil && response?.statusCode == 302 && body == "moved", "the redirect's own answer, as without Notato")
    }

    @Test func aChallengeIsTheAppsSessionsToAnswer() async {
        let app = AppSessionDelegate()
        let (response, body, error) = await app.load("/private")
        #expect(app.challenges == ["shop"], "the app's delegate was asked")
        #expect(error == nil && response?.statusCode == 200 && body == "welcome dom")
    }

    /// A real server's event stream never ends: the app sees its first event only if each piece is handed on as it
    /// comes (a stub's pieces are handed over together, so this needs a server).
    @Test(.enabled(if: LiveServer.url != nil))
    func aStreamThatNeverEndsReachesTheAppAsItComes() async throws {
        NotatoNetworkRecorder.useRelay(NotatoNetworkRecorder.Relay(configuration: .ephemeral))
        let app = AppSessionDelegate()
        let (session, task) = app.start(LiveServer.url!.appendingPathComponent("projects/swift-recorder/events"))
        defer { session.invalidateAndCancel() }
        for _ in 0..<50 where app.pieces.isEmpty { try await Task.sleep(nanoseconds: 100_000_000) }
        #expect(String(decoding: app.pieces.reduce(Data(), +), as: UTF8.self).hasPrefix("event: hello"))
        #expect(task.state == .running, "still going")
    }

    @Test func uploadTasksAndSocketsAreLeftToTheNetwork() {
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let request = URLRequest(url: URL(string: "http://app.test/upload")!)
        #expect(NotatoNetworkRecorder.canInit(with: session.dataTask(with: request)))
        #expect(!NotatoNetworkRecorder.canInit(with: session.uploadTask(with: request, from: Data([1]))))
        #expect(!NotatoNetworkRecorder.canInit(with: session.webSocketTask(with: URL(string: "ws://app.test/live")!)))
        #expect(!NotatoNetworkRecorder.canInit(with: URLRequest(url: URL(string: "ftp://app.test/file")!)))
    }
}

/// A real server for the tests that need one: `NOTATO_TEST_SERVER=http://localhost:4799 swift test`, with a scratch
/// server (`npx notato dev --port 4799 --dir "$(mktemp -d)"`). Those tests are skipped without one.
enum LiveServer {
    static let url = ProcessInfo.processInfo.environment["NOTATO_TEST_SERVER"].flatMap(URL.init(string:))
}

@Suite("Against a real server", .serialized, .enabled(if: LiveServer.url != nil))
struct LiveServerTests {
    static var server: URL? { LiveServer.url }

    private func note(project: String) -> Annotation {
        var annotation = Fixture.annotation()
        annotation.id = ULID.make()
        annotation.projectId = project
        annotation.screenshots = nil
        return annotation
    }

    @Test func theListIsASummaryAndAPackageGoesUpFromItsFile() async throws {
        let project = "swift-live-\(UUID().uuidString.prefix(8).lowercased())"
        let client = NotatoClient(base: Self.server!, token: nil)
        let sent = note(project: project)
        _ = try await client.post(sent, assets: [:])
        let summary = try await client.list(project: project, summary: true)
        #expect(summary.map(\.annotation.id) == [sent.id])
        #expect(summary.first?.annotation.context.isEmpty == true && summary.first?.annotation.steps == nil, "no context, no steps")
        #expect(summary.first?.annotation.comment == sent.comment && summary.first?.annotation.target == sent.target)
        #expect(try await client.list(project: project).first?.annotation.context.isEmpty == false, "asked whole, it is whole")

        let packaged = note(project: project)
        let (bundle, files) = BundleWriter.build([LocalAnnotation(annotation: packaged, assets: [:])], project: project, author: "Dom",
                                                 appName: "Sample", appVersion: "1.0")
        let zip = FileManager.default.temporaryDirectory.appendingPathComponent("notato-live-\(UUID().uuidString).zip")
        defer { try? FileManager.default.removeItem(at: zip) }
        try BundleWriter.write(bundle, files: files, to: zip)
        try await client.uploadBundle(project: project, file: zip)
        #expect(try await client.list(project: project, summary: true).map(\.annotation.id).contains(packaged.id))
    }

    @Test @MainActor func onConnectingANoteWaitingGoesFirstAndTheListKeepsItsContext() async throws {
        let project = "swift-live-\(UUID().uuidString.prefix(8).lowercased())"
        let notato = Notato(configuration: NotatoConfiguration(project: project, server: Self.server))
        let client = notato.client(for: Self.server!)
        notato.client = client
        let waiting = NoteRecord(note(project: project), pending: true, mine: true)
        notato.insert([waiting])
        let elsewhere = note(project: project)
        _ = try await client.post(elsewhere, assets: [:])
        await notato.handle(ServerSentEvent(event: "hello", data: "{}"), client: client)
        #expect(!waiting.pending)
        #expect(Set(notato.records.map(\.id)) == [waiting.id, elsewhere.id])
        #expect(waiting.annotation.context.isEmpty == false, "the list's summary did not take the context away")
    }

    @Test func theEventStreamFollowsTheProject() async throws {
        let project = "swift-live-\(UUID().uuidString.prefix(8).lowercased())"
        let client = NotatoClient(base: Self.server!, token: nil)
        var seen: [String] = []
        for try await event in client.events(project: project, agent: false) {
            seen.append(event.event)
            if event.event == "hello" { _ = try await client.post(note(project: project), assets: [:]) }
            if event.event == "created" { break }
        }
        #expect(seen == ["hello", "created"])
    }
}

#if canImport(UIKit)
import UIKit

/// What needs UIKit: run on the simulator with `xcodebuild test -scheme Notato -destination 'platform=iOS Simulator,…'`.
@Suite("On iOS")
@MainActor
struct UIKitTests {
    private func window(_ x: CGFloat) -> UIWindow {
        let window = UIWindow(frame: CGRect(x: x, y: 0, width: 400, height: 800))
        window.isHidden = false
        return window
    }

    private func probe(in window: UIWindow, _ frame: CGRect) -> UIView {
        let view = UIView(frame: frame)
        window.addSubview(view)
        return view
    }

    @Test func idiomsAreToldByNameNotByPlaceInAList() {
        #expect(DeviceContext.idiom(.mac) == "mac", "a Mac was reported as vision")
        #expect(DeviceContext.idiom(.vision) == "vision")
        #expect(DeviceContext.idiom(.phone) == "phone")
        #expect(DeviceContext.idiom(.pad) == "pad")
        #expect(DeviceContext.idiom(.carPlay) == "carPlay")
        #expect(DeviceContext.idiom(.unspecified) == "unspecified")
    }

    @Test func eachWindowSeesOnlyItsOwnMarks() {
        let registry = MarkRegistry.shared
        let left = window(0), right = window(400)
        let inbox = UUID(), compose = UUID(), banner = UUID()
        let everything = CGRect(x: 0, y: 0, width: 400, height: 800)
        registry.upsert(id: inbox, kind: .screen, name: "Inbox", file: "Inbox.swift", line: 1, column: 1, frame: everything)
        registry.attach(probe: probe(in: left, everything), to: inbox)
        registry.upsert(id: compose, kind: .screen, name: "Compose", file: "Compose.swift", line: 1, column: 1, frame: everything)
        registry.attach(probe: probe(in: right, everything), to: compose)
        registry.upsert(id: banner, kind: .mask, name: "mask", file: "", line: 0, column: 0, frame: CGRect(x: 0, y: 100, width: 400, height: 50))
        registry.attach(probe: probe(in: right, CGRect(x: 0, y: 100, width: 400, height: 50)), to: banner)
        defer { for id in [inbox, compose, banner] { registry.remove(id: id) } }

        #expect(registry.screens(in: left).map(\.name) == ["Inbox"])
        #expect(registry.screens(in: right).map(\.name) == ["Compose"])
        #expect(registry.around(CGRect(x: 10, y: 10, width: 20, height: 20), in: left).map(\.name) == ["Inbox"])
        #expect(registry.all(.mask, in: left).isEmpty)
        #expect(registry.all(.mask, in: right).count == 1)
        #expect(Set(registry.screens().map(\.name)).isSuperset(of: ["Inbox", "Compose"]), "unscoped, every window's")
    }

    /// The colour of one point of a PNG drawn at 1x.
    private func pixel(_ png: Data, _ x: Int, _ y: Int) throws -> [UInt8] {
        let image = try #require(UIImage(data: png)?.cgImage)
        var bytes = [UInt8](repeating: 0, count: 4)
        let context = try #require(CGContext(data: &bytes, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                             space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(image, in: CGRect(x: -x, y: y - image.height + 1, width: image.width, height: image.height))
        return Array(bytes.prefix(3))
    }

    @Test func aScreenshotIsCoveredWhereThingsWereWhenItWasTaken() throws {
        let home = window(0)
        home.backgroundColor = .white
        let card = CGRect(x: 0, y: 100, width: 400, height: 80)
        let field = ScreenElement(role: "textbox", label: "Email", value: "dom@example.com", identifier: nil,
                                  frame: CGRect(x: 16, y: 300, width: 368, height: 44), control: "TextField", isTextInput: true)
        let shot = try #require(ScreenshotTaker.capture(home, elements: [field], privateViews: [card], maskInputs: true))
        #expect(shot.covers == [card, field.frame])
        // Whatever moves before Send, the picture is covered where the card and the field were in it.
        let composed = try #require(ScreenshotComposer.compose(shot, targets: [CGRect(x: 10, y: 600, width: 50, height: 50)], pin: nil, maxScale: 1))
        let full = try #require(composed.assets[composed.refs.full.id])
        let grey: [UInt8] = [156, 163, 175]
        #expect(try pixel(full, 200, 140).enumerated().allSatisfy { abs(Int($0.element) - Int(grey[$0.offset])) <= 2 }, "the card")
        #expect(try pixel(full, 200, 320).enumerated().allSatisfy { abs(Int($0.element) - Int(grey[$0.offset])) <= 2 }, "the field")
        #expect(try pixel(full, 200, 240) != grey, "and nothing else")
    }

    @Test func aMarkPutBackWithoutNewGeometryFindsItsFrameAgain() {
        let registry = MarkRegistry.shared
        let home = window(0)
        let card = CGRect(x: 16, y: 120, width: 370, height: 80)
        let id = UUID()
        registry.upsert(id: id, kind: .screen, name: "ProductList", file: "ProductList.swift", line: 1, column: 1, frame: card)
        registry.attach(probe: probe(in: home, card), to: id)
        // A page pushed over it, then popped: it disappears, and appears again with no geometry change.
        registry.remove(id: id)
        #expect(registry.screens(in: home).isEmpty)
        registry.upsert(id: id, kind: .screen, name: "ProductList", file: "ProductList.swift", line: 1, column: 1, frame: card)
        defer { registry.remove(id: id) }
        #expect(registry.screens(in: home).map(\.name) == ["ProductList"])
        #expect(registry.frame(of: id, in: home) == card)
    }
}
#endif
