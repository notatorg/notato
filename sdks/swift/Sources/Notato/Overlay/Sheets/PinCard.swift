#if canImport(UIKit)
import SwiftUI

/// One note, opened from its pin or from the Notes list: what it says and where it stands, its thread, and what the
/// person can do with it (reply, ask for a revert, delete, People only).
struct PinCard: View {
    let record: NoteRecord
    let number: Int
    let notato: Notato
    /// Back to the list of notes, when it was opened from there.
    let back: (() -> Void)?
    let close: () -> Void
    let done: (String) -> Void

    @State private var reply = ""
    @State private var aside = false
    @State private var problem: String?
    @State private var busy = false
    /// People only as just asked for, until the server (or the device) has it.
    @State private var askedPeopleOnly: Bool?

    var body: some View {
        let a = record.annotation
        VStack(alignment: .leading, spacing: 14) {
            SheetHeader(title: number > 0 ? "Note \(number)" : "Note", subtitle: byline(a)) {
                if let back {
                    HeaderButton(.back, action: back)
                } else {
                    SheetTile(icon: .pin(number: number, status: a.status, pending: record.pending), size: 38)
                }
            } trailing: {
                HeaderButton(.close, action: close)
            }
            // A long thread scrolls; the header and the buttons stay.
            SheetScroll {
                VStack(alignment: .leading, spacing: 12) {
                    // People only goes under the other badges when they leave no room for it.
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 5) {
                            badges(a)
                            if a.isPeopleOnly { peopleOnlyBadge }
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 5) { badges(a) }
                            if a.isPeopleOnly { peopleOnlyBadge }
                        }
                    }
                    Text(a.comment).font(.system(size: 16)).fixedSize(horizontal: false, vertical: true)
                    if let target = target(a) {
                        Text(target).font(.system(size: 12.5)).foregroundStyle(Palette.muted).lineLimit(2)
                    }
                    if record.pending && !notato.hasServer {
                        // Test mode, or no server: nothing is waiting to be sent, the note goes out in a package.
                        Text(CardCopy.keptHere).font(.system(size: 12.5)).foregroundStyle(Palette.muted)
                    } else if record.pending {
                        Text(record.error.map { "Not sent: \($0)" } ?? "Not sent yet: \(record.notice ?? "it goes when the server can be reached.")")
                            .font(.system(size: 12.5)).foregroundStyle(Palette.status(Status.acknowledged))
                    }
                    FlagToggle(title: PeopleOnlyCopy.title, hint: PeopleOnlyCopy.hint,
                               isOn: Binding(get: { askedPeopleOnly ?? a.isPeopleOnly }, set: { setPeopleOnly($0) }))
                        .disabled(askedPeopleOnly != nil)
                        .accessibilityIdentifier("NotatoNotePeopleOnly")
                    ForEach(a.thread.suffix(4)) { ThreadEntry(reply: $0) }
                    if a.thread.count > 4 {
                        // The card shows the latest of a long thread: say the rest is there.
                        Text("\(a.thread.count - 4) earlier on the board.")
                            .font(.system(size: 12.5)).foregroundStyle(Palette.muted)
                            .padding(.horizontal, 10)
                            .accessibilityIdentifier("NotatoEarlierReplies")
                    }
                    if notato.hasServer, !record.pending {
                        TextField(a.status == Status.resolved ? "Reply, or say what was wrong" : "Reply", text: $reply, axis: .vertical)
                            .lineLimit(1...4)
                            .field()
                            .accessibilityIdentifier("NotatoReply")
                        FlagToggle(title: PeopleOnlyCopy.aside, hint: PeopleOnlyCopy.asideHint, isOn: $aside)
                            .accessibilityIdentifier("NotatoAside")
                    }
                }
                .padding(.horizontal, 4)
            }
            // Side by side while they fit; one above the other when they do not.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { actions(a) }
                VStack(spacing: 8) { actions(a) }
            }
            if let problem { Text(problem).font(.system(size: 12.5)).foregroundStyle(Palette.danger).padding(.horizontal, 4) }
        }
    }

    @ViewBuilder
    private func actions(_ a: Annotation) -> some View {
        if notato.hasServer, !record.pending {
            if a.status == Status.resolved {
                SheetButton("Ask the agent to revert") { run({ try await notato.requestRevert(a.id, reason: reply) }, "Asked the agent to undo that change") }
            }
            if a.status == Status.revertRequested {
                SheetButton("Cancel request") { run({ try await notato.cancelRevert(a.id) }, "Revert request taken back") }
            }
            if record.mine, a.status == Status.open {
                SheetButton("Delete", kind: .danger) { run({ try await notato.delete(a.id) }, "Note deleted") }
            }
            SheetButton("Reply", kind: .primary) {
                let text = reply.trimmingCharacters(in: .whitespacesAndNewlines)
                let asAside = aside
                if text.isEmpty {
                    problem = "Write a reply first."
                } else {
                    run({
                        try await notato.reply(a.id, text, aside: asAside)
                        aside = false
                    }, asAside ? "Aside sent" : "Reply sent")
                }
            }
            .accessibilityIdentifier("NotatoSendReply")
        } else {
            SheetButton("Delete", kind: .danger) { run({ try await notato.delete(a.id) }, "Note deleted") }
        }
    }

    @ViewBuilder
    private func badges(_ a: Annotation) -> some View {
        Badge(text: a.status, color: Palette.status(a.status))
        if let intent = a.intent { Badge(text: intent, color: Palette.muted) }
        if let severity = a.severity { Badge(text: severity, color: severity == Severity.blocker ? Palette.danger : Palette.muted) }
    }

    /// As the web toolbar draws it: no fill, a hairline, small muted capitals. It is not a status, so it has no colour.
    private var peopleOnlyBadge: some View {
        Text(PeopleOnlyCopy.title)
            .font(.caption2.weight(.bold))
            .textCase(.uppercase)
            .kerning(0.4)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .foregroundStyle(Palette.muted)
            .overlay(Capsule().strokeBorder(Palette.line, lineWidth: 1))
            .accessibilityIdentifier("NotatoPeopleOnlyBadge")
    }

    /// The card stays open: the badge and the thread's new entry show the change.
    private func setPeopleOnly(_ on: Bool) {
        guard askedPeopleOnly == nil, on != record.annotation.isPeopleOnly else { return }
        askedPeopleOnly = on
        problem = nil
        Task {
            do {
                try await notato.setPeopleOnly(record.annotation.id, on)
            } catch {
                problem = error.localizedDescription
            }
            askedPeopleOnly = nil
        }
    }

    /// Who wrote it and when: "Dom · 2h ago".
    private func byline(_ a: Annotation) -> String? {
        let parts = [a.author.name ?? (a.author.kind == "agent" ? "An agent" : nil), Ago.text(a.createdAt)].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// What it is about: `text "Summit Jacket"`.
    private func target(_ a: Annotation) -> String? {
        a.target.identity.first.map { id in
            id.tag + (id.testId.map { " #\($0)" } ?? "") + (id.text.map { " “\($0.count > 30 ? String($0.prefix(29)) + "…" : $0)”" } ?? "")
        }
    }

    private func run(_ action: @escaping () async throws -> Void, _ message: String) {
        guard !busy else { return }
        busy = true
        Task {
            do {
                try await action()
                close()
                done(message)
            } catch {
                problem = error.localizedDescription
            }
            busy = false
        }
    }
}

/// One entry in a note's thread. Something Notato recorded (People only turned on or off) is a quiet line; an aside is
/// marked, and drawn outlined rather than filled.
struct ThreadEntry: View {
    let reply: Reply

    var body: some View {
        let name = reply.author.name ?? (reply.author.kind == "agent" ? "Agent" : "You")
        if reply.automatic == true {
            (Text(name).bold() + Text(" · \(reply.body)"))
                .font(.caption)
                .foregroundStyle(Palette.muted)
                .padding(.horizontal, 10).padding(.vertical, 2)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            let aside = reply.aside == true
            let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
            VStack(alignment: .leading, spacing: 2) {
                if aside {
                    Label(PeopleOnlyCopy.aside, systemImage: "eye.slash")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(Palette.muted)
                        .accessibilityLabel("Aside, kept from the agent")
                }
                (Text("\(name): ").bold() + Text(reply.body))
                    .font(.subheadline)
                    .foregroundStyle(aside ? Palette.muted : Palette.text)
            }
            .padding(.horizontal, 10).padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(aside ? Color.clear : Palette.soft, in: shape)
            .overlay(shape.strokeBorder(aside ? Palette.line : Color.clear, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
        }
    }
}

/// How long ago a timestamp was, as the card says it: `just now`, `5m ago`, `2h ago`, `3d ago`.
enum Ago {
    static func text(_ iso: String) -> String? {
        guard let date = NotatoJSON.date(iso) else { return nil }
        let seconds = Date().timeIntervalSince(date)
        if seconds < 60 { return "just now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m ago" }
        if seconds < 86400 { return "\(Int(seconds / 3600))h ago" }
        return "\(Int(seconds / 86400))d ago"
    }
}

/// A note's status, intent or severity, in its colour.
struct Badge: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text.replacingOccurrences(of: "_", with: " "))
            .font(.caption2.weight(.bold))
            .padding(.horizontal, 7).padding(.vertical, 2)
            .foregroundStyle(color)
            .background(color.opacity(0.14), in: Capsule())
    }
}
#endif
