import Foundation

/// Writes a tester's notes as the bundle zip the rest of Notato reads (packages/core/src/bundle.ts):
/// `annotations.json`, a `feedback.md` to read top to bottom, and the screenshots in `shots/`.
enum BundleWriter {
    /// The bundle, and the screenshots that go in its `shots/` folder: where each is kept, by its path in the zip. A
    /// screenshot whose file has gone since is left out, as one never taken is.
    static func build(_ items: [LocalAnnotation], project: String, author: String?, appName: String?, appVersion: String?)
        -> (bundle: FeedbackBundle, files: [String: KeptAsset]) {
        let id = ULID.make()
        var files: [String: KeptAsset] = [:]
        var annotations: [Annotation] = []
        for (index, item) in items.enumerated() {
            var annotation = item.annotation
            let n = String(format: "%02d", index + 1)
            if let shots = annotation.screenshots, let full = item.assets[shots.full.id], full.isThere {
                var fullRef = shots.full
                let fullPath = "shots/\(n)-full.png"
                fullRef.path = fullPath
                files[fullPath] = full
                var cropRef: AssetRef?
                if var crop = shots.crop, let kept = item.assets[crop.id], kept.isThere {
                    let cropPath = "shots/\(n)-crop.png"
                    crop.path = cropPath
                    files[cropPath] = kept
                    cropRef = crop
                }
                annotation.screenshots = Screenshots(full: fullRef, crop: cropRef)
            } else {
                annotation.screenshots = nil
            }
            annotation.bundleId = id
            annotation.mode = NotatoMode.test.rawValue
            annotations.append(annotation)
        }
        let bundle = FeedbackBundle(id: id, projectId: project, createdAt: NotatoJSON.timestamp(), author: .init(name: author),
                                    appName: appName, appVersion: appVersion, annotations: annotations)
        return (bundle, files)
    }

    /// Writes the bundle zip to `url`: `feedback.md`, `annotations.json`, then each screenshot, read from its file as
    /// it is written, so only one is in memory at a time. Refuses (before writing anything) a package with more files
    /// than a zip can count; a failure part way leaves no file behind.
    static func write(_ bundle: FeedbackBundle, files: [String: KeptAsset], to url: URL) throws {
        let entries = 2 + files.count
        guard entries <= ZipWriter.maxEntries else {
            throw NotatoError(message: "Too many notes to package at once: a package holds at most \(ZipWriter.maxEntries) files, and these need \(entries).")
        }
        var writer = try ZipWriter(creating: url)
        do {
            try writer.add("feedback.md", Data(markdown(bundle).utf8))
            try writer.add("annotations.json", try NotatoJSON.encoder.encode(bundle))
            for (name, asset) in files.sorted(by: { $0.key < $1.key }) { try writer.add(name, try asset.read()) }
            try writer.finish()
        } catch {
            writer.abandon()
            try? FileManager.default.removeItem(at: url)
            throw error
        }
    }

    private static func oneLine(_ text: String) -> String {
        text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    static func markdown(_ bundle: FeedbackBundle) -> String {
        var lines = ["# Feedback\(bundle.appName.map { " for \($0)" } ?? "")\(bundle.appVersion.map { " \($0)" } ?? "")", ""]
        lines.append("Project `\(bundle.projectId)` · bundle `\(bundle.id)` · \(bundle.author.name.map { "from \($0) · " } ?? "")\(bundle.createdAt) · \(bundle.annotations.count) annotation\(bundle.annotations.count == 1 ? "" : "s")")
        for (index, a) in bundle.annotations.enumerated() {
            lines += ["", "## \(index + 1). \(a.route)\(a.severity.map { " — \($0)" } ?? "")", ""]
            lines += a.comment.split(separator: "\n", omittingEmptySubsequences: false).map { "> \($0)" }
            lines.append("")
            if let path = a.screenshots?.full.path { lines.append("![Full screenshot, target outlined](\(path))") }
            if let path = a.screenshots?.crop?.path { lines.append("![Crop of the target](\(path))") }
            lines.append("")
            for (n, id) in a.target.identity.enumerated() {
                let said = (id.name ?? id.text).map { " “\(String(oneLine($0).prefix(80)))”" } ?? ""
                lines.append("- Target\(a.target.identity.count > 1 ? " \(n + 1)" : "") (\(a.target.kind)): \(id.role ?? id.tag)\(said)")
                lines.append("  - Selector: `\(id.selector)`")
                if let testId = id.testId { lines.append("  - Test id: `\(testId)`") }
                if let source = id.source { lines.append("  - Written at: `\(source.file):\(source.line):\(source.col)`\(source.nearest == true ? " (the nearest marked view around it)" : "")") }
                if let component = id.component { lines.append("  - Component: \(component.name)\(component.source.map { " (`\($0)`)" } ?? "")") }
            }
            lines.append("- Page: \(a.url)")
            lines.append("- Viewport: \(a.environment.viewport.w)×\(a.environment.viewport.h) @\(a.environment.dpr)x · \(a.author.name ?? a.author.kind) · \(a.createdAt)")
            if let steps = a.steps, !steps.isEmpty {
                lines += ["", "Steps taken:"]
                for (n, step) in steps.enumerated() {
                    lines.append("\(n + 1). \(step.action)\(step.target.map { " `\($0)`" } ?? "")\(step.value.map { " = \(oneLine($0))" } ?? "")")
                }
            }
        }
        return lines.joined(separator: "\n") + "\n"
    }
}
