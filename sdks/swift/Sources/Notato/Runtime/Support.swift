import CryptoKit
import Foundation

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
