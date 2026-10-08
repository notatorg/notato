import Foundation
import Testing
@testable import Notato

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
        #expect(throws: NotatoError.self, "the 65,536th is refused, not counted past what a zip can hold") { try writer.add("one too many", Data()) }
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
