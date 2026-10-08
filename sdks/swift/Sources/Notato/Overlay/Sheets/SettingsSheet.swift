#if canImport(UIKit)
import SwiftUI

/// The person's name on their notes, a server to use instead of the configured one, and screenshots on or off.
struct SettingsSheet: View {
    let notato: Notato
    let back: () -> Void
    let close: () -> Void
    @State private var name = ""
    @State private var server = ""
    @State private var screenshots = true

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SheetHeader(title: "Settings", subtitle: "Project \(notato.configuration?.project ?? "") · \(notato.mode.rawValue.capitalized) mode") {
                HeaderButton(.back, action: back)
            } trailing: {
                HeaderButton(.close, action: close)
            }
            // The fields scroll when the keyboard leaves too little room for all of it; the header and buttons stay.
            SheetScroll {
                VStack(alignment: .leading, spacing: 14) {
                    VStack(alignment: .leading, spacing: 6) {
                        FieldLabel("Your name")
                        TextField("Your name, on your notes", text: $name)
                            .textInputAutocapitalization(.words)
                            .field()
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        FieldLabel("Server")
                        TextField(notato.configuration?.resolvedServer?.absoluteString ?? "No server: notes stay on this device", text: $server)
                            .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                            .field()
                        Text(notato.describeConnection()).font(.system(size: 12)).foregroundStyle(Palette.muted).padding(.horizontal, 4)
                    }
                    ToggleRow(icon: .symbol("camera"), title: "Screenshots",
                              detail: notato.serverScreenshots ? "Each note takes one of the screen" : "The server has them turned off",
                              isOn: $screenshots)
                }
            }
            HStack(spacing: 10) {
                SheetButton("Reset") {
                    notato.resetRuntimeState()
                    close()
                }
                SheetButton("Save", kind: .primary) {
                    notato.saveSettings(name: name, screenshots: screenshots, server: server)
                    close()
                }
            }
        }
        .onAppear {
            name = notato.authorName ?? ""
            server = notato.state.server ?? ""
            screenshots = notato.screenshotsWanted
        }
    }
}

/// A row with a switch at its end: tapping anywhere on it flips the switch.
private struct ToggleRow: View {
    let icon: SheetTile.Icon
    let title: String
    let detail: String
    @Binding var isOn: Bool

    var body: some View {
        Toggle(isOn: $isOn) {
            HStack(spacing: 14) {
                SheetTile(icon: icon)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 15.5, weight: .semibold))
                    Text(detail).font(.system(size: 12.5)).foregroundStyle(Palette.muted).lineLimit(2)
                }
            }
        }
        .tint(Palette.accent)
        .padding(.vertical, 7).padding(.horizontal, 4)
        .frame(minHeight: 58)
    }
}

/// A label over a text field in a sheet.
private struct FieldLabel: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Palette.muted).padding(.horizontal, 4)
    }
}
#endif
