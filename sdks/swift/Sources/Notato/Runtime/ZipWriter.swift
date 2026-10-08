import Foundation

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
    /// The parts one after another. A function rather than a chain of `+`, which older type checkers take too long on.
    private static func joined(_ parts: Data...) -> Data { parts.reduce(into: Data()) { $0.append($1) } }

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
        let header = Self.joined(
            Self.le32(0x0403_4B50), Self.le16(20), Self.le16(0x0800), Self.le16(0), Self.le16(0), Self.le16(0x21),
            Self.le32(crc), Self.le32(size), Self.le32(size),
            Self.le16(UInt16(nameBytes.count)), Self.le16(0), nameBytes
        )
        try write(header)
        try write(bytes)
        central += Self.joined(
            Self.le32(0x0201_4B50), Self.le16(20), Self.le16(20), Self.le16(0x0800), Self.le16(0), Self.le16(0), Self.le16(0x21),
            Self.le32(crc), Self.le32(size), Self.le32(size),
            Self.le16(UInt16(nameBytes.count)), Self.le16(0), Self.le16(0), Self.le16(0), Self.le16(0), Self.le32(0),
            Self.le32(start), nameBytes
        )
        count += 1
    }

    /// Writes the central directory and closes the file.
    mutating func finish() throws {
        let start = UInt32(offset)
        let entries = UInt16(count)
        try write(central)
        let end = Self.joined(
            Self.le32(0x0605_4B50), Self.le16(0), Self.le16(0), Self.le16(entries), Self.le16(entries),
            Self.le32(UInt32(central.count)), Self.le32(start), Self.le16(0)
        )
        try write(end)
        try flush()
        try handle.close()
    }

    /// Lets the file go without finishing it (after a failure; the caller deletes it).
    func abandon() {
        try? handle.close()
    }
}
