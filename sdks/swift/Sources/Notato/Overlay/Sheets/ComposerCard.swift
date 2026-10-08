#if canImport(UIKit)
import SwiftUI

/// The note being written about what is selected: the comment, its intent and severity, People only, and Send.
struct ComposerCard: View {
    let selection: SelectionView?
    let screenshotsOff: Bool
    let parent: () -> Void
    let cancel: () -> Void
    let send: (String, String?, String?, Bool) async -> String?

    @State private var comment = ""
    @State private var intent: String?
    @State private var severity: String?
    @State private var peopleOnly = false
    @State private var busy = false
    @State private var problem: String?
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
                TextField("What should change?", text: $comment, axis: .vertical)
                    .lineLimit(3...6)
                    .focused($focused)
                    .field()
                    .accessibilityIdentifier("NotatoComment")
                Chips(options: [(Intent.fix, "Fix"), (Intent.change, "Change"), (Intent.question, "Question"), (Intent.approve, "Approve")], selected: $intent)
                Chips(options: [(Severity.blocker, "Blocker"), (Severity.major, "Major"), (Severity.minor, "Minor"), (Severity.nit, "Nit")], selected: $severity)
                FlagToggle(title: PeopleOnlyCopy.title, hint: PeopleOnlyCopy.hint, isOn: $peopleOnly)
                    .accessibilityIdentifier("NotatoPeopleOnly")
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
                            problem = await send(text, intent, severity, peopleOnly)
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

/// A row of choices, at most one on: tapping the one that is on turns it off.
struct Chips: View {
    let options: [(String, String)]
    @Binding var selected: String?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(options, id: \.0) { value, label in
                    let on = selected == value
                    Button { selected = on ? nil : value } label: {
                        Text(label)
                            .font(.system(size: 14, weight: .semibold))
                            .padding(.horizontal, 11).padding(.vertical, 6)
                            .foregroundStyle(on ? Color.white : Palette.text)
                            .background(on ? Palette.accent : Color.clear, in: Capsule())
                            .overlay(Capsule().strokeBorder(on ? Palette.accent : Palette.line))
                    }
                    .buttonStyle(.plain)
                }
            }
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
