import SwiftUI
import Notato

/// Notato at runtime: everything here goes through `Notato.shared`, which any view can observe.
struct FeedbackView: View {
    @State private var notato = Notato.shared
    @State private var message: String?

    var body: some View {
        List {
            Section {
                Toggle("Notato", isOn: Binding(get: { notato.isEnabled }, set: { $0 ? notato.enable() : notato.disable() }))
                    .accessibilityIdentifier("NotatoEnabled")
                Toggle("Toolbar", isOn: Binding(get: { notato.isToolbarVisible }, set: { $0 ? notato.showToolbar() : notato.hideToolbar() }))
                    .disabled(!notato.isEnabled)
                    .accessibilityIdentifier("NotatoToolbar")
                Text("\(notato.connection.rawValue)\(notato.connectionDetail.map { ": \($0)" } ?? "") · \(notato.annotations.count) note(s), \(notato.pendingCount) not sent")
                    .font(.footnote).foregroundStyle(.secondary)
                    .accessibilityIdentifier("NotatoStatus")
            } footer: {
                Text("On or off is remembered on this device. Shake to toggle the toolbar.")
            }
            Section {
                Button("Start annotating") { notato.startAnnotating() }.accessibilityIdentifier("StartAnnotating")
                Button("Select the banner below") { run { try notato.select("#DemoBanner") } }.accessibilityIdentifier("SelectBanner")
                Button("Annotate the banner from code") {
                    Task {
                        do {
                            let note = try await notato.annotate("#DemoBanner", comment: "Typo: \"recieve\" should be \"receive\".",
                                                                  options: AnnotateOptions(severity: Severity.minor, intent: Intent.fix))
                            message = "Made note \(note.id.suffix(6)) on \(note.target.identity[0].selector)"
                        } catch {
                            message = error.localizedDescription
                        }
                    }
                }
                .accessibilityIdentifier("AnnotateFromCode")
            }
            Section {
                Text("A banner with a typo: recieve 10% off")
                    .foregroundStyle(.white)
                    .padding()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.indigo, in: RoundedRectangle(cornerRadius: 12))
                    .accessibilityIdentifier("DemoBanner")
                    .notato("DemoBanner")
                Text("Private with .notatoMask(): covered in screenshots and left out of notes").padding(8).notatoMask()
            }
            Section {
                Button("Reset runtime choices") { notato.resetRuntimeState() }
            }
        }
        .navigationTitle("Feedback")
        .alert("Notato", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
            Button("OK") {}
        } message: {
            Text(message ?? "")
        }
        .notatoScreen()
    }

    private func run(_ action: () throws -> Void) {
        do { try action() } catch { message = error.localizedDescription }
    }
}
