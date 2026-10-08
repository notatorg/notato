#if canImport(UIKit)
import SwiftUI
import UIKit

/// The ⋯ menu: who and how Notato is connected, then everything it can do, in groups.
struct MenuSheet: View {
    let model: OverlayModel
    let notato: Notato
    let hooks: PlatformHooks
    let session: WeakSession

    var body: some View {
        VStack(spacing: 10) {
            header
            if let problem = connectionProblem { banner(problem) }
            // A short window (a phone on its side) scrolls the rows; the header stays.
            ViewThatFits(in: .vertical) {
                rows
                ScrollView { rows }.scrollBounceBehavior(.basedOnSize)
            }
        }
    }

    // ---- header: who, how, and the server's state

    private var header: some View {
        SheetHeader(title: "Notato", subtitle: subline) {
            Potato(size: 38)
        } trailing: {
            if let pill {
                HStack(spacing: 6) {
                    Circle().fill(pill.color).frame(width: 7, height: 7)
                    Text(pill.label).font(.system(size: 12, weight: .bold))
                }
                .padding(.horizontal, 10).padding(.vertical, 4)
                .background(pill.color.opacity(0.14), in: Capsule())
                .fixedSize()
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("NotatoConnection")
            }
        }
    }

    /// `Dev mode · localhost:4747`, or where the notes stay when there is no server.
    private var subline: String {
        let mode = notato.mode.rawValue.capitalized + " mode"
        if let host = notato.serverHost { return "\(mode) · \(host)" }
        return "\(mode) · notes stay on this \(Self.device)"
    }

    private static var device: String {
        switch UIDevice.current.userInterfaceIdiom {
        case .phone: return "phone"
        case .pad: return "iPad"
        case .mac: return "Mac"
        default: return "device"
        }
    }

    /// The server's state, when the app keeps a connection to one (not in test mode, which only uploads packages).
    private var pill: (label: String, color: Color)? {
        guard notato.hasServer else { return nil }
        switch notato.connection {
        case .connected: return ("Connected", Palette.connected)
        case .connecting: return ("Connecting…", Palette.status(Status.acknowledged))
        case .offline: return ("Offline", Palette.offline)
        case .refused: return ("Refused", Palette.offline)
        default: return nil
        }
    }

    // ---- the server cannot be reached: say so, and offer to try again now

    private struct Problem {
        let title: String
        let detail: String
    }

    private var connectionProblem: Problem? {
        guard notato.hasServer else { return nil }
        let host = notato.serverHost ?? "The server"
        switch notato.connection {
        case .offline:
            return Problem(title: "Can't reach the server", detail: "\(host) isn't answering. Notes stay on this \(Self.device) and send when it's back.")
        case .refused:
            return Problem(title: "The server refused this app", detail: notato.connectionDetail ?? "\(host) did not accept this app's token or project.")
        default:
            return nil
        }
    }

    private func banner(_ problem: Problem) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(problem.title).bold()
                Text(problem.detail).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            }
            .font(.system(size: 13))
            .lineSpacing(1.5)
            .frame(maxWidth: .infinity, alignment: .leading)
            Button { notato.retryConnection() } label: {
                Text("Retry")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Palette.background)
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .background(Palette.text, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("NotatoRetry")
        }
        .padding(.horizontal, 12).padding(.vertical, 11)
        .background(Palette.offline.opacity(0.12), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    // ---- the rows, in groups

    private var rows: some View {
        let here = session.value.map { hooks.notes(on: $0).count } ?? 0
        let pending = notato.pendingCount
        return VStack(spacing: 0) {
            MenuRow(icon: .crosshair, title: "Annotate", detail: "Tap an element, write a note", style: .primary) {
                run { notato.startAnnotating() }
            }
            MenuRow(icon: .symbol(notato.pinsVisible ? "eye.slash" : "eye"), title: notato.pinsVisible ? "Hide pins" : "Show pins",
                    detail: here == 0 ? "No pins on this screen" : here == 1 ? "1 pin on this screen" : "\(here) pins on this screen") {
                run { notato.togglePins() }
            }
            MenuRow(icon: .symbol("list.bullet"), title: "Notes", detail: "\(here) on this screen · \(notato.records.count) in all", opens: true) {
                run { model.sheet = .list }
            }
            if notato.mode == .test, pending > 0 {
                MenuRow(icon: .symbol("shippingbox"), title: "Package and share", detail: "Zip with screenshots, share anywhere", opens: true, separated: true) {
                    run { if let s = session.value { Task { await hooks.packageAndShare(in: s) } } }
                }
                MenuRow(icon: .symbol("trash"), title: "Clear notes", detail: pending == 1 ? "Removes the note on this device" : "Removes all \(pending) from this device", style: .danger) {
                    run { model.sheet = .confirmClear }
                }
            }
            MenuRow(icon: .symbol("slider.vertical.3"), title: "Settings", detail: "Your name, screenshots, server", opens: true, separated: true) {
                run { model.sheet = .settings }
            }
            MenuRow(icon: .symbol("arrow.down.right.and.arrow.up.left"), title: "Hide toolbar",
                    detail: hooks.shakeAvailable ? "Shake to bring it back" : "The app can bring it back", separated: true) {
                run { notato.hideToolbar() }
            }
            MenuRow(icon: .symbol("power"), title: "Turn Notato off", detail: "Until the app turns it on again", style: .danger) {
                run { notato.disable() }
            }
        }
    }

    /// Closes the menu, then does what the row is for (which may open another sheet).
    private func run(_ action: () -> Void) {
        model.sheet = nil
        action()
    }
}

/// Test mode's Clear notes, confirmed: the notes kept on this device are removed.
struct ClearNotesSheet: View {
    let notato: Notato
    let back: () -> Void
    let close: () -> Void
    /// Says it is done, once the sheet has closed.
    let done: (String) -> Void

    var body: some View {
        let count = notato.pendingCount
        VStack(alignment: .leading, spacing: 14) {
            SheetHeader(title: "Clear notes?", subtitle: count == 1 ? "Removes the note on this device" : "Removes all \(count) from this device") {
                HeaderButton(.back, action: back)
            } trailing: {
                HeaderButton(.close, action: close)
            }
            Text("A package you already shared keeps them.")
                .font(.system(size: 13.5)).foregroundStyle(Palette.muted)
                .padding(.horizontal, 4)
            HStack(spacing: 10) {
                SheetButton("Keep them", action: close)
                SheetButton("Clear", kind: .destructive) {
                    Task {
                        await notato.clearLocal()
                        close()
                        done("Notes cleared")
                    }
                }
            }
        }
    }
}
#endif
