import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
import ImageIO
import libwebp

/// Compresses already-masked pixels. PNG remains a fallback and wins whenever it is smaller.
enum ScreenshotEncoding {
    static func encode(_ image: CGImage) -> (bytes: Data, mime: String)? {
        let png = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(png, "public.png" as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        let fallback = (bytes: png as Data, mime: "image/png")
        let width = image.width, height = image.height
        guard width > 0, height > 0, width <= 16383, height <= 16383,
              width * height <= 16_000_000 else { return fallback }
        let stride = width * 4
        var pixels = [UInt8](repeating: 0, count: stride * height)
        return pixels.withUnsafeMutableBytes { raw in
            guard let context = CGContext(data: raw.baseAddress, width: width, height: height,
                                          bitsPerComponent: 8, bytesPerRow: stride,
                                          space: CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return fallback }
            context.setFillColor(CGColor(gray: 1, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            var output: UnsafeMutablePointer<UInt8>?
            let count = WebPEncodeRGBA(raw.bindMemory(to: UInt8.self).baseAddress,
                                       Int32(width), Int32(height), Int32(stride), 85, &output)
            guard let output else { return fallback }
            defer { WebPFree(output) }
            guard count > 0, count < png.length else { return fallback }
            return (bytes: Data(bytes: output, count: count), mime: "image/webp")
        }
    }
}
#endif
