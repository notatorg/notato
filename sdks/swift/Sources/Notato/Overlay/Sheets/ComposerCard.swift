#if canImport(UIKit)
import SwiftUI

/// The note being written about what is selected: the comment, its intent and severity, People only, and Send.
struct ComposerCard: View {
    let selection: SelectionView?
    let screenshotsOff: Bool
    var sharedByDefault = false
    let parent: () -> Void
    let cancel: () -> Void
    let send: (String, String?, String?, Bool, Bool) async -> String?

    @State private var comment = ""
    @State private var intent: String?
    @State private var severity: String?
    @State private var peopleOnly = false
    @State private var sharedOverride: Bool?
    @State private var busy = false
    @State private var problem: String?
    /// Whether the two visibility switches show under their button; closed each time the composer opens.
    @State private var visibilityOpen = false
    @FocusState private var focused: Bool

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .center, spacing: 8) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(selection?.title ?? "").font(.headline).lineLimit(1)
                        if let subtitle = selection?.subtitle { Text(subtitle).font(.caption).foregroundStyle(Palette.muted).lineLimit(2) }
                    }
                    Spacer(minLength: 4)
                    Button(action: parent) {
                        Label("Parent", systemImage: "arrow.up").font(.system(size: 13.5, weight: .semibold))
                            .padding(.horizontal, 11).frame(height: 30)
                            .background(Palette.soft, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Select the view around this one")
                    HeaderButton(.close, action: cancel)
                        .accessibilityLabel("Cancel")
                }
                // The kind of note first, as the web composer has it: it shapes what is written under it.
                Chips(options: [(Intent.fix, "Fix"), (Intent.change, "Change"), (Intent.question, "Question"), (Intent.approve, "Approve")], selected: $intent)
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel("Feedback type")
                TextField("What should change?", text: $comment, axis: .vertical)
                    .lineLimit(3...6)
                    .focused($focused)
                    .field()
                    .accessibilityIdentifier("NotatoComment")
                Chips(options: [(Severity.blocker, "Blocker"), (Severity.major, "Major"), (Severity.minor, "Minor"), (Severity.nit, "Nit")], selected: $severity, dots: true)
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel("Severity")
                VisibilityButton(shared: shared, peopleOnly: peopleOnly, open: $visibilityOpen)
                if visibilityOpen {
                    VStack(alignment: .leading, spacing: 10) {
                        FlagToggle(title: "Share with project", hint: "Project members can see this feedback.", isOn: Binding(get: { shared }, set: { sharedOverride = $0 }))
                        FlagToggle(title: PeopleOnlyCopy.title, hint: PeopleOnlyCopy.hint, isOn: $peopleOnly)
                            .accessibilityIdentifier("NotatoPeopleOnly")
                    }
                }
                if let problem { Text(problem).font(.caption).foregroundStyle(Palette.danger) }
                HStack(spacing: 10) {
                    Text(screenshotsOff ? "No screenshot: they are turned off." : "Tap another element to change what this note is about.")
                        .font(.caption).foregroundStyle(Palette.muted)
                    Spacer(minLength: 0)
                    CardButton(busy ? "Sending…" : "Send") {
                        let text = comment.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !busy, !text.isEmpty else { return }
                        busy = true
                        Task {
                            problem = await send(text, intent, severity, peopleOnly, shared)
                            busy = false
                        }
                    }
                    .opacity(comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy ? 0.45 : 1)
                    .accessibilityIdentifier("NotatoSend")
                }
            }
        }
    }
}

extension ComposerCard {
    private var shared: Bool { sharedOverride ?? sharedByDefault }
}

/// Who can see the note, in a few words on a capsule, as the web composer has it; tapping it shows the two switches.
struct VisibilityButton: View {
    let shared: Bool
    let peopleOnly: Bool
    @Binding var open: Bool

    /// The words on the button, the same in every SDK.
    static func summary(shared: Bool, peopleOnly: Bool) -> String {
        switch (shared, peopleOnly) {
        case (false, false): return "You and your agent"
        case (true, false): return "Shared with project"
        case (false, true): return "Only you"
        case (true, true): return "Project, not agent"
        }
    }

    var body: some View {
        let summary = Self.summary(shared: shared, peopleOnly: peopleOnly)
        Button { withAnimation(.easeOut(duration: 0.18)) { open.toggle() } } label: {
            HStack(spacing: 6) {
                Image(systemName: shared ? "person.2" : "lock").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.muted)
                Text(summary).font(.system(size: 13.5, weight: .semibold)).foregroundStyle(Palette.text).lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 10.5, weight: .bold)).foregroundStyle(Palette.muted)
                    .rotationEffect(.degrees(open ? 180 : 0))
            }
            .padding(.horizontal, 12).frame(height: 34)
            .background(open ? Palette.soft : Color.clear, in: Capsule())
            .overlay(Capsule().strokeBorder(Palette.line))
            .contentShape(Capsule())
        }
        .buttonStyle(VisibilityButtonStyle())
        .accessibilityIdentifier("NotatoVisibility")
        .accessibilityLabel("Visibility: \(summary)")
        .accessibilityValue(open ? "Expanded" : "Collapsed")
    }
}

private struct VisibilityButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.background(configuration.isPressed ? Palette.soft : Color.clear, in: Capsule())
    }
}

/// A row of equal choices, at most one on: tapping the one that is on turns it off. The one that is on is filled with
/// the text colour, as on the web; `dots` puts the severity's colour beside each label.
struct Chips: View {
    let options: [(String, String)]
    @Binding var selected: String?
    var dots = false

    var body: some View {
        HStack(spacing: 6) {
            ForEach(options, id: \.0) { value, label in
                let on = selected == value
                Button { selected = on ? nil : value } label: {
                    HStack(spacing: 5) {
                        if dots { Circle().fill(Self.dot(value)).frame(width: 7, height: 7) }
                        Text(label).lineLimit(1).minimumScaleFactor(0.8)
                    }
                    .font(.system(size: 14, weight: .semibold))
                    .frame(maxWidth: .infinity, minHeight: 38)
                    .foregroundStyle(on ? Palette.background : Palette.text)
                    .background(on ? Palette.text : Color.clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(on ? Palette.text : Palette.line))
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
    }

    /// The severity's colour, the web composer's.
    private static func dot(_ severity: String) -> Color {
        switch severity {
        case Severity.blocker: return Palette.danger
        case Severity.major: return Color(red: 0xd9 / 255, green: 0x9a / 255, blue: 0x1e / 255)
        case Severity.minor: return Color(red: 0x2f / 255, green: 0x6f / 255, blue: 0xde / 255)
        default: return Color(red: 0x9a / 255, green: 0x9a / 255, blue: 0x9a / 255)
        }
    }
}

/// The note being written's Send: a teal pill beside a line of help, not a sheet's full-width button.
struct CardButton: View {
    let title: String
    let action: () -> Void

    init(_ title: String, action: @escaping () -> Void) {
        self.title = title
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 14, weight: .bold))
                .padding(.horizontal, 14).padding(.vertical, 9)
                .foregroundStyle(Color.white)
        }
        .buttonStyle(CardButtonStyle())
    }
}

private struct CardButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Palette.accentPressed : Palette.accent, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}
#endif
