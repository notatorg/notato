import Foundation
import Testing
@testable import Notato

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
        #expect(read.bundleId == nil)
    }

    @Test func aPackagedBundlePassesTheSchemaAndUnzips() throws {
        // One screenshot kept in a file, as a note's are, one still in memory.
        let kept = FileManager.default.temporaryDirectory.appendingPathComponent("notato-\(UUID().uuidString).png")
        try Data([1, 2, 3]).write(to: kept)
        defer { try? FileManager.default.removeItem(at: kept) }
        let assets: [String: KeptAsset] = [String(repeating: "a", count: 64): .file(kept), String(repeating: "b", count: 64): .bytes(Data([4, 5]))]
        let (bundle, files) = BundleWriter.build([LocalAnnotation(annotation: Fixture.annotation(), assets: assets)],
                                                 project: "swift-sample", author: "Dom", appName: "Sample", appVersion: "1.0")
        #expect(bundle.annotations[0].bundleId == bundle.id)
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
