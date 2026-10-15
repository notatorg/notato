import Foundation

/// Ids that can be used as file and folder names. Notes are kept on disk under their annotation id and screenshots
/// under their asset id; both can come from the server, so nothing that does not fit is ever joined into a path.
enum SafeIds {
    /// An annotation or screenshot id, as the schema allows them (`SafeId`): ULIDs, UUIDs and sha256 hex all fit.
    static func isSafe(_ id: String) -> Bool {
        id.range(of: #"^[A-Za-z0-9_-]{1,128}$"#, options: .regularExpression) != nil
    }

    /// The folder a project's notes are kept in: its id, when that is a safe name (as every id kept so far is), else a
    /// name made from its bytes, which can never reach outside the folder it is in.
    static func folder(forProject project: String) -> String {
        if project != ".", project != "..", project.range(of: #"^[A-Za-z0-9_.@-]{1,128}$"#, options: .regularExpression) != nil {
            return project
        }
        let hex = Data(project.utf8).map { String(format: "%02x", $0) }.joined()
        return "p-" + (hex.count <= 128 ? hex : Hash.sha256(Data(project.utf8)))
    }

    /// Whether `url` is strictly inside `folder`, after `.` and `..` are resolved.
    static func isInside(_ url: URL, _ folder: URL) -> Bool {
        let path = url.standardizedFileURL.path
        let base = folder.standardizedFileURL.path
        return path.hasPrefix(base.hasSuffix("/") ? base : base + "/") && path.count > base.count + 1
    }
}

/// A screenshot of a note not sent yet. It is kept in a file on the device and read only when the note is sent or
/// packaged; its bytes are held in memory only until they are written, or when they could not be.
enum KeptAsset: Sendable, Equatable {
    case file(URL)
    case bytes(Data)

    func read() throws -> Data {
        switch self {
        case let .file(url): try Data(contentsOf: url)
        case let .bytes(data): data
        }
    }

    /// Whether it can still be read: its file is there.
    var isThere: Bool {
        switch self {
        case let .file(url): FileManager.default.isReadableFile(atPath: url.path)
        case .bytes: true
        }
    }

    /// The bytes of each that can still be read, by id. A file gone since is left out, as a screenshot never taken is.
    static func read(_ assets: [String: KeptAsset]) -> [String: Data] {
        assets.compactMapValues { try? $0.read() }
    }

    /// As `read`, for a note about to be sent, but a file that is there and cannot be read now (the device is locked:
    /// `LocalStore` keeps them protected) throws, so the note waits for it rather than going without its screenshots.
    static func readToSend(_ assets: [String: KeptAsset]) throws -> [String: Data] {
        var bytes: [String: Data] = [:]
        for (id, asset) in assets {
            do {
                bytes[id] = try asset.read()
            } catch {
                if case let .file(url) = asset, FileManager.default.fileExists(atPath: url.path) { throw error }
            }
        }
        return bytes
    }
}

/// An annotation made on this device, and where its screenshots are.
struct LocalAnnotation: Sendable {
    var annotation: Annotation
    var assets: [String: KeptAsset]
    /// Why the server refused it for good, when it did: it is not sent again.
    var refusal: String?
}

/// Notes made on this device, on disk until the server has them: one folder per note, `annotation.json` written last.
/// What is kept here (screenshots of the app, what was typed in it) is left out of the device's backups and, on an
/// iPhone or iPad, can be read only while the device is unlocked: a file being written when it locks is finished, and
/// one made then can be written, but none is opened again until it is unlocked.
actor LocalStore {
    /// Where every project's folder is (`Application Support/notato`).
    let base: URL
    let root: URL
    /// Ids already logged as unusable, so each is logged once.
    private var warned: Set<String> = []
    /// `base` has been left out of backups.
    private var excluded = false

    /// Whether what is kept is protected while the device is locked: on an iPhone or iPad. A Mac (Mac Catalyst, an iPad
    /// app on a Mac, the macOS build the tests run on) does not open a file of that class again once it is closed, so
    /// there files keep the system's default.
    static let protects: Bool = {
        #if os(iOS) && !targetEnvironment(macCatalyst)
        return !ProcessInfo.processInfo.isiOSAppOnMac
        #else
        return false
        #endif
    }()

    /// How every file is written, and the class every folder is made with (so files put in it get it too).
    static var writing: Data.WritingOptions { protects ? [.atomic, .completeFileProtectionUnlessOpen] : .atomic }
    static var folderAttributes: [FileAttributeKey: Any]? { protects ? [.protectionKey: FileProtectionType.completeUnlessOpen] : nil }

    init(base: URL, project: String) {
        self.base = base
        self.root = base.appendingPathComponent(SafeIds.folder(forProject: project), isDirectory: true)
    }

    /// The folder of a note, or nil (logged once) when its id cannot be a folder name.
    private func folder(_ id: String) -> URL? {
        let folder = root.appendingPathComponent(id, isDirectory: true)
        guard SafeIds.isSafe(id), SafeIds.isInside(folder, root) else {
            if warned.insert(id).inserted {
                log.warning("Notato keeps no file for the id \"\(id, privacy: .public)\": ids are 1 to 128 letters, digits, _ or -.")
            }
            return nil
        }
        return folder
    }

    /// Keeps a note: each screenshot in a file of its own, then `annotation.json`. Returns where the screenshots now
    /// are (one whose id cannot be a file name stays in memory). Called again with the annotation alone (it changed),
    /// it leaves the screenshots as they are.
    @discardableResult
    func keep(_ annotation: Annotation, screenshots: [String: Data] = [:]) throws -> [String: KeptAsset] {
        guard let folder = folder(annotation.id) else { return screenshots.mapValues { .bytes($0) } }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: Self.folderAttributes)
        excludeFromBackup()
        var kept: [String: KeptAsset] = [:]
        for (id, bytes) in screenshots {
            guard SafeIds.isSafe(id) else {
                kept[id] = .bytes(bytes)
                continue
            }
            let mime = [annotation.screenshots?.full, annotation.screenshots?.crop].compactMap { $0 }.first { $0.id == id }?.mime
            let file = folder.appendingPathComponent("\(id).\(mime == "image/webp" ? "webp" : "png")")
            try bytes.write(to: file, options: Self.writing)
            kept[id] = .file(file)
        }
        try NotatoJSON.encoder.encode(annotation).write(to: folder.appendingPathComponent("annotation.json"), options: Self.writing)
        return kept
    }

    /// Remembers that the server refused a note for good, so it is not sent again on the next launch.
    func refuse(_ id: String, because message: String) {
        guard let folder = folder(id), FileManager.default.fileExists(atPath: folder.path) else { return }
        try? Data(message.utf8).write(to: folder.appendingPathComponent("refused.txt"), options: Self.writing)
    }

    /// Leaves every project's notes (`base`) out of the device's backups, once it is there: an iCloud or computer
    /// backup, and a move to a new device, would otherwise take their screenshots along.
    private func excludeFromBackup() {
        guard !excluded, FileManager.default.fileExists(atPath: base.path) else { return }
        var base = self.base
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        do {
            try base.setResourceValues(values)
            excluded = true
        } catch {
            log.error("Notato could not leave its notes out of backups: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// The notes kept, oldest first. Their screenshots are not read: each is where its file is.
    func load() -> [LocalAnnotation] {
        // Notes kept by a version from before it was done are left out of backups from now on too.
        excludeFromBackup()
        guard let folders = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return [] }
        var items: [LocalAnnotation] = []
        for folder in folders {
            guard let json = try? Data(contentsOf: folder.appendingPathComponent("annotation.json")),
                  let annotation = try? NotatoJSON.decoder.decode(Annotation.self, from: json) else { continue }
            var assets: [String: KeptAsset] = [:]
            for file in (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [] where ["png", "webp"].contains(file.pathExtension) {
                assets[file.deletingPathExtension().lastPathComponent] = .file(file)
            }
            let refusal = (try? Data(contentsOf: folder.appendingPathComponent("refused.txt"))).map { String(decoding: $0, as: UTF8.self) }
            items.append(LocalAnnotation(annotation: annotation, assets: assets, refusal: refusal))
        }
        return items.sorted { ($0.annotation.createdAt, $0.annotation.id) < ($1.annotation.createdAt, $1.annotation.id) }
    }

    func remove(_ id: String) {
        guard let folder = folder(id) else { return }
        try? FileManager.default.removeItem(at: folder)
    }

    func clear() {
        guard SafeIds.isInside(root, base) else { return }
        try? FileManager.default.removeItem(at: root)
    }
}
