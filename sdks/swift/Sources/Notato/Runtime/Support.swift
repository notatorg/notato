import Foundation
import CryptoKit

/// Universally unique, lexicographically sortable ids: 48 bits of milliseconds and 80 random bits, in Crockford base32.
enum ULID {
    private static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    static func make(at date: Date = Date()) -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        var ms = UInt64(max(0, date.timeIntervalSince1970 * 1000))
        for i in stride(from: 5, through: 0, by: -1) {
            bytes[i] = UInt8(ms & 0xFF)
            ms >>= 8
        }
        for i in 6..<16 { bytes[i] = UInt8.random(in: 0...255) }
        // 128 bits as 26 characters of 5 bits, the first carrying only the top 3.
        var out = [Character](repeating: "0", count: 26)
        var high = bytes[0..<8].reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
        var low = bytes[8..<16].reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
        for i in stride(from: 25, through: 0, by: -1) {
            out[i] = alphabet[Int(low & 31)]
            low = (low >> 5) | ((high & 31) << 59)
            high >>= 5
        }
        return String(out)
    }
}

enum Hash {
    /// Content address of a screenshot, as the web SDK names them.
    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

/// A ZIP writer that stores entries uncompressed: enough for the bundle format (screenshots are compressed already),
/// with no dependency. The server reads it with fflate. It writes straight to a file, an entry at a time, so a package
/// of many screenshots is never held in memory whole. Plain ZIP, not ZIP64: at most 65,535 entries and 4 GB, and it
/// refuses to go past either rather than write a broken file.
struct ZipWriter {
    /// The most entries a plain ZIP can count.
    static let maxEntries = Int(UInt16.max)
    /// Written out whenever this much has gathered, so thousands of small entries are not thousands of writes.
    private static let chunk = 1 << 20

    private let handle: FileHandle
    private var pending = Data()
    private var written: UInt64 = 0
    private var central = Data()
    private(set) var count = 0

    /// Starts an empty file at `url`, replacing what is there.
    init(creating url: URL) throws {
        guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
            throw NotatoError(message: "Could not create \(url.lastPathComponent).")
        }
        handle = try FileHandle(forWritingTo: url)
    }

    private static let table: [UInt32] = (0..<256).map { n in
        var c = UInt32(n)
        for _ in 0..<8 { c = (c & 1) != 0 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
        return c
    }

    static func crc32(_ bytes: Data) -> UInt32 {
        var crc: UInt32 = 0xFFFF_FFFF
        for byte in bytes { crc = table[Int((crc ^ UInt32(byte)) & 0xFF)] ^ (crc >> 8) }
        return crc ^ 0xFFFF_FFFF
    }

    private static func le16(_ value: UInt16) -> Data { withUnsafeBytes(of: value.littleEndian) { Data($0) } }
    private static func le32(_ value: UInt32) -> Data { withUnsafeBytes(of: value.littleEndian) { Data($0) } }

    private var offset: UInt64 { written + UInt64(pending.count) }

    private mutating func write(_ bytes: Data) throws {
        pending += bytes
        if pending.count >= Self.chunk { try flush() }
    }

    private mutating func flush() throws {
        guard !pending.isEmpty else { return }
        try handle.write(contentsOf: pending)
        written += UInt64(pending.count)
        pending.removeAll(keepingCapacity: true)
    }

    mutating func add(_ name: String, _ bytes: Data) throws {
        guard count < Self.maxEntries else {
            throw NotatoError(message: "A package holds at most \(Self.maxEntries) files: \(name) is one too many.")
        }
        let nameBytes = Data(name.utf8)
        // The entry, and the central directory and end record still to come, must all be within 4 GB.
        guard bytes.count < UInt32.max, nameBytes.count < UInt16.max,
              offset + UInt64(30 + nameBytes.count + bytes.count) + UInt64(central.count + 46 + nameBytes.count + 22) <= UInt64(UInt32.max) else {
            throw NotatoError(message: "The package would be larger than a zip can be (4 GB).")
        }
        let crc = Self.crc32(bytes)
        let size = UInt32(bytes.count)
        let start = UInt32(offset)
        // Local file header: version 2.0, UTF-8 names (bit 11), stored (method 0), no date.
        var header = Self.le32(0x0403_4B50) + Self.le16(20) + Self.le16(0x0800) + Self.le16(0) + Self.le16(0) + Self.le16(0x21)
        header += Self.le32(crc) + Self.le32(size) + Self.le32(size)
        header += Self.le16(UInt16(nameBytes.count)) + Self.le16(0) + nameBytes
        try write(header)
        try write(bytes)
        central += Self.le32(0x0201_4B50) + Self.le16(20) + Self.le16(20) + Self.le16(0x0800) + Self.le16(0) + Self.le16(0) + Self.le16(0x21)
        central += Self.le32(crc) + Self.le32(size) + Self.le32(size)
        central += Self.le16(UInt16(nameBytes.count)) + Self.le16(0) + Self.le16(0) + Self.le16(0) + Self.le16(0) + Self.le32(0)
        central += Self.le32(start) + nameBytes
        count += 1
    }

    /// Writes the central directory and closes the file.
    mutating func finish() throws {
        let start = UInt32(offset)
        let entries = UInt16(count)
        try write(central)
        var end = Self.le32(0x0605_4B50) + Self.le16(0) + Self.le16(0) + Self.le16(entries) + Self.le16(entries)
        end += Self.le32(UInt32(central.count)) + Self.le32(start) + Self.le16(0)
        try write(end)
        try flush()
        try handle.close()
    }

    /// Lets the file go without finishing it (after a failure; the caller deletes it).
    func abandon() {
        try? handle.close()
    }
}

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
}

/// An annotation made on this device, and where its screenshots are.
struct LocalAnnotation: Sendable {
    var annotation: Annotation
    var assets: [String: KeptAsset]
    /// Why the server refused it for good, when it did: it is not sent again.
    var refusal: String?
}

/// Notes made on this device, on disk until the server has them: one folder per note, `annotation.json` written last.
actor LocalStore {
    /// Where every project's folder is (`Application Support/notato`).
    let base: URL
    let root: URL
    /// Ids already logged as unusable, so each is logged once.
    private var warned: Set<String> = []

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
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var kept: [String: KeptAsset] = [:]
        for (id, bytes) in screenshots {
            guard SafeIds.isSafe(id) else {
                kept[id] = .bytes(bytes)
                continue
            }
            let file = folder.appendingPathComponent("\(id).png")
            try bytes.write(to: file, options: .atomic)
            kept[id] = .file(file)
        }
        try NotatoJSON.encoder.encode(annotation).write(to: folder.appendingPathComponent("annotation.json"), options: .atomic)
        return kept
    }

    /// Remembers that the server refused a note for good, so it is not sent again on the next launch.
    func refuse(_ id: String, because message: String) {
        guard let folder = folder(id), FileManager.default.fileExists(atPath: folder.path) else { return }
        try? Data(message.utf8).write(to: folder.appendingPathComponent("refused.txt"), options: .atomic)
    }

    /// The notes kept, oldest first. Their screenshots are not read: each is where its file is.
    func load() -> [LocalAnnotation] {
        guard let folders = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return [] }
        var items: [LocalAnnotation] = []
        for folder in folders {
            guard let json = try? Data(contentsOf: folder.appendingPathComponent("annotation.json")),
                  let annotation = try? NotatoJSON.decoder.decode(Annotation.self, from: json) else { continue }
            var assets: [String: KeptAsset] = [:]
            for file in (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [] where file.pathExtension == "png" {
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

/// What a person chose on the device, kept in UserDefaults: each unset value falls back to the configuration.
struct RuntimeState {
    let remember: Bool
    private static let prefix = "notato."
    private var memory: [String: String] = [:]

    init(remember: Bool) { self.remember = remember }

    private func get(_ key: String) -> String? {
        remember ? UserDefaults.standard.string(forKey: Self.prefix + key) : memory[key]
    }

    private mutating func set(_ key: String, _ value: String?) {
        memory[key] = value
        guard remember else { return }
        if let value { UserDefaults.standard.set(value, forKey: Self.prefix + key) } else { UserDefaults.standard.removeObject(forKey: Self.prefix + key) }
    }

    private func bool(_ key: String) -> Bool? { get(key).map { $0 == "1" } }
    private mutating func setBool(_ key: String, _ value: Bool?) { set(key, value.map { $0 ? "1" : "0" }) }

    var enabled: Bool? { get { bool("enabled") } set { setBool("enabled", newValue) } }
    var toolbarVisible: Bool? { get { bool("toolbar") } set { setBool("toolbar", newValue) } }
    var screenshots: Bool? { get { bool("screenshots") } set { setBool("screenshots", newValue) } }
    var pinsVisible: Bool? { get { bool("pins") } set { setBool("pins", newValue) } }
    var author: String? {
        get { get("author") }
        set { set("author", newValue?.trimmingCharacters(in: .whitespaces).isEmpty == false ? newValue?.trimmingCharacters(in: .whitespaces) : nil) }
    }
    var server: String? {
        get { get("server") }
        set { set("server", newValue?.trimmingCharacters(in: .whitespaces).isEmpty == false ? newValue : nil) }
    }

    /// Where the toolbar was dragged to, as fractions of the window so it survives rotation.
    var toolbarPosition: CGPoint? {
        get {
            guard let parts = get("toolbar.position")?.split(separator: ","), parts.count == 2,
                  let x = Double(parts[0]), let y = Double(parts[1]) else { return nil }
            return CGPoint(x: min(max(x, 0), 1), y: min(max(y, 0), 1))
        }
        set { set("toolbar.position", newValue.map { "\($0.x),\($0.y)" }) }
    }

    /// Whether the toolbar was left folded into its round button.
    var toolbarCollapsed: Bool? { get { bool("toolbar.collapsed") } set { setBool("toolbar.collapsed", newValue) } }

    mutating func reset() {
        for key in ["enabled", "toolbar", "screenshots", "pins", "author", "server", "toolbar.position", "toolbar.collapsed"] { set(key, nil) }
    }
}
