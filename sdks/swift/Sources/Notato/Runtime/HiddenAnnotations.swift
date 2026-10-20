import Foundation

/// A device preference, scoped without persisting the credential. Feedback itself is never changed.
struct HiddenAnnotations {
    private var signature: [String?]?
    private var key = ""
    private var groups: [String: [String]] = [:]
    private(set) var encoded: String?
    private(set) var ids: Set<String> = []

    static func isCompleted(_ status: String) -> Bool {
        [Status.resolved, Status.reverted, Status.dismissed].contains(status)
    }

    mutating func select(_ parts: [String?], saved: String?) -> Bool {
        guard signature != parts || encoded != saved else { return false }
        signature = parts
        encoded = saved
        key = Hash.sha256((try? JSONEncoder().encode(parts)) ?? Data())
        groups = saved.flatMap { $0.data(using: .utf8) }.flatMap { try? JSONDecoder().decode([String: [String]].self, from: $0) } ?? [:]
        ids = Set(groups[key] ?? [])
        return true
    }

    func contains(_ annotation: Annotation) -> Bool {
        Self.isCompleted(annotation.status) && ids.contains(annotation.id)
    }

    @discardableResult
    mutating func hide(_ annotations: [Annotation]) -> Bool {
        let before = ids.count
        for a in annotations where Self.isCompleted(a.status) { ids.insert(a.id) }
        guard ids.count != before else { return false }
        save()
        return true
    }

    mutating func clear() {
        ids = []
        save()
    }

    private mutating func save() {
        groups[key] = Array(ids)
        encoded = (try? JSONEncoder().encode(groups)).flatMap { String(data: $0, encoding: .utf8) }
    }
}
