#if canImport(UIKit)
import Foundation
import Testing
import UIKit
@testable import Notato

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
        #expect(DeviceContext.idiom(.mac) == "mac", "not the idiom after it by raw value (vision)")
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
        let composed = ScreenshotComposer.compose(shot, targets: [CGRect(x: 10, y: 600, width: 50, height: 50)], pin: nil, maxScale: 1)
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
