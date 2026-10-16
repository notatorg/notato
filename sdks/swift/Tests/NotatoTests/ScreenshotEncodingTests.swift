#if canImport(CoreGraphics)
import Foundation
import Testing
import CoreGraphics
import ImageIO
@testable import Notato

@Suite("Efficient screenshot encoding")
struct ScreenshotEncodingTests {
    @Test func webpIsSmallerAndKeepsTheImageDimensions() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let file = root.appendingPathComponent("assets/notato.png")
        let source = try #require(CGImageSourceCreateWithURL(file as CFURL, nil))
        let image = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
        let encoded = try #require(ScreenshotEncoding.encode(image))
        #expect(encoded.mime == "image/webp")
        #expect(encoded.bytes.count < (try Data(contentsOf: file)).count)
        let decoded = try #require(CGImageSourceCreateWithData(encoded.bytes as CFData, nil))
        let restored = try #require(CGImageSourceCreateImageAtIndex(decoded, 0, nil))
        #expect(restored.width == image.width)
        #expect(restored.height == image.height)
        #expect(encoded.bytes.prefix(4) == Data("RIFF".utf8))
    }
}
#endif
