import Foundation
import Testing
@testable import Notato

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

    @Test func ulidsAre26CrockfordCharactersAndSortByTime() {
        let earlier = ULID.make(at: Date(timeIntervalSince1970: 1_700_000_000))
        let later = ULID.make(at: Date(timeIntervalSince1970: 1_700_000_000.001))
        #expect(earlier.count == 26)
        #expect(earlier.range(of: "^[0-9A-HJKMNP-TV-Z]{26}$", options: .regularExpression) != nil)
        #expect(earlier < later)
        #expect(ULID.make() != ULID.make())
    }
}
