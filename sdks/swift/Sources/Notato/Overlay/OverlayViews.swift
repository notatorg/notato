#if canImport(UIKit)
import SwiftUI
import UIKit

/// Reports a control's frame so Notato's window knows the touches there are its own.
private struct Region: ViewModifier {
    let key: String
    let model: OverlayModel

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { model.regions[key] = $0 }
            .onDisappear { model.regions[key] = nil }
    }
}

extension View {
    /// Marks a control as Notato's: touches on it go to Notato's window, not the app's.
    func region(_ key: String, _ model: OverlayModel) -> some View { modifier(Region(key: key, model: model)) }
}

/// Everything Notato draws over the app.
struct OverlayRoot: View {
    @Bindable var model: OverlayModel
    let notato: Notato
    let hooks: PlatformHooks
    let session: WeakSession
    /// Read so that the overlay draws again when the system switches between light and dark.
    @Environment(\.colorScheme) private var systemScheme

    var body: some View {
        ZStack {
            if notato.isAnnotating {
                // Takes the taps that pick; Notato's own controls sit above it.
                Color.white.opacity(0.001)
                    .contentShape(Rectangle())
                    .onTapGesture(coordinateSpace: .global) { point in
                        if let session = session.value { hooks.pick(at: point, in: session) }
                    }
                    .ignoresSafeArea()
            }
            SelectionLayer(selection: model.selection).allowsHitTesting(false).ignoresSafeArea()
            if notato.pinsVisible {
                PinsLayer(model: model, open: { id in model.sheet = .pin(id) }).ignoresSafeArea()
            }
            if notato.isAnnotating, model.selection == nil, model.sheet == nil {
                VStack {
                    HintBar(done: { notato.stopAnnotating() }).region("hint", model)
                    Spacer()
                }
                .padding(.top, 8)
            }
            if notato.isToolbarVisible {
                ToolbarLayer(model: model, notato: notato)
            }
            if let sheet = model.sheet {
                if sheet == .composer {
                    SheetContainer(atTop: model.sheetAtTop) {
                        sheetContent(sheet)
                    }
                } else {
                    Palette.scrim.ignoresSafeArea().onTapGesture { close() }
                    // One sheet, whose content changes as someone goes from the menu to what it opens and back.
                    BottomSheet(close: close) {
                        sheetContent(sheet)
                    }
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            if let toast = model.toast {
                ToastLayer(message: toast).allowsHitTesting(false).transition(.opacity)
            }
        }
        .onGeometryChange(for: CGSize.self) { $0.size } action: { model.windowSize = $0 }
        // Annotating from code (or a shortcut) while the toolbar is folded opens it, and folds it again after.
        .onChange(of: notato.isAnnotating, initial: true) { _, active in model.annotatingChanged(active) }
        .animation(.easeOut(duration: 0.15), value: model.sheet)
        .animation(.easeOut(duration: 0.15), value: model.toast)
        .environment(\.colorScheme, scheme)
    }

    /// The app's window's light or dark, which the app may have chosen for itself; the system's otherwise.
    private var scheme: ColorScheme {
        let system = systemScheme
        switch (session.value?.appWindow ?? hooks.sessions.first?.appWindow)?.traitCollection.userInterfaceStyle {
        case .dark: return .dark
        case .light: return .light
        default: return system
        }
    }

    private func close() {
        let wasComposer = model.sheet == .composer
        model.sheet = nil
        if wasComposer { notato.stopAnnotating() }
    }

    @ViewBuilder
    private func sheetContent(_ sheet: OverlayModel.Sheet) -> some View {
        switch sheet {
        case .composer:
            ComposerCard(selection: model.selection, screenshotsOff: !notato.screenshotsOn,
                         parent: { if let s = session.value { hooks.selectParent(in: s) } },
                         cancel: close,
                         send: { comment, intent, severity, peopleOnly in
                             guard let s = session.value else { return "The window went away." }
                             return await hooks.submit(comment: comment, intent: intent, severity: severity, peopleOnly: peopleOnly, in: s)
                         })
        case let .pin(id, fromList):
            if let session = session.value, let record = notato.record(id) {
                // Its number among the notes on this screen; none when it is on another.
                let number = hooks.notes(on: session).all.firstIndex { $0 === record }.map { $0 + 1 } ?? 0
                PinCard(record: record, number: number, notato: notato, back: fromList ? { model.sheet = .list } : nil,
                        close: close, done: { message in model.show(toast: message) })
            }
        case .menu:
            MenuSheet(model: model, notato: notato, hooks: hooks, session: session)
        case .settings:
            SettingsSheet(notato: notato, back: backToMenu, close: close)
        case .list:
            NotesSheet(notato: notato, hooks: hooks, session: session,
                       open: { model.sheet = .pin($0, fromList: true) },
                       annotate: {
                           model.sheet = nil
                           notato.startAnnotating()
                       },
                       back: backToMenu, close: close)
        case .confirmClear:
            ClearNotesSheet(notato: notato, back: backToMenu, close: close, done: { model.show(toast: $0) })
        }
    }

    private func backToMenu() { model.sheet = .menu }
}

/// Holds the note being written at the top or the bottom of the window, away from what it is about.
struct SheetContainer<Content: View>: View {
    let atTop: Bool
    @ViewBuilder var content: Content

    var body: some View {
        VStack {
            if !atTop { Spacer(minLength: 0) }
            content.padding(.horizontal, 10)
            if atTop { Spacer(minLength: 0) }
        }
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity)
    }
}

/// What to do while annotating, and Done to stop.
struct HintBar: View {
    let done: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Text("Tap what you want to comment on").font(.system(size: 14, weight: .semibold)).foregroundStyle(Palette.barText)
            Button(action: done) {
                Text("Done").font(.system(size: 14, weight: .bold)).foregroundStyle(Palette.onBarAccent)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(Palette.barAccent, in: Capsule())
            }
            .buttonStyle(.plain)
        }
        .padding(.leading, 16).padding(.trailing, 6).padding(.vertical, 6)
        .background(Palette.bar, in: Capsule())
        .overlay(Capsule().strokeBorder(Palette.barLine))
        .shadow(color: .black.opacity(0.28), radius: 12, y: 4)
    }
}

/// A short message at the top of the window, in the bar's colours.
struct ToastLayer: View {
    let message: String

    var body: some View {
        VStack {
            Text(message)
                .font(.system(size: 13.5, weight: .semibold))
                .multilineTextAlignment(.center)
                .foregroundStyle(Palette.barText)
                .padding(.horizontal, 16).padding(.vertical, 9)
                .background(Palette.bar, in: Capsule())
                .overlay(Capsule().strokeBorder(Palette.barLine))
                .shadow(color: .black.opacity(0.28), radius: 12, y: 4)
                .padding(.top, 54)
                .padding(.horizontal, 16)
            Spacer()
        }
    }
}

/// The selection's outline, and a label saying what it is.
struct SelectionLayer: View {
    let selection: SelectionView?

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.clear
            if let selection {
                ForEach(Array(selection.rects.enumerated()), id: \.offset) { _, rect in
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Palette.selection.opacity(0.08))
                        .overlay(RoundedRectangle(cornerRadius: 4).stroke(Palette.selection, lineWidth: 2))
                        .frame(width: rect.width, height: rect.height)
                        .offset(x: rect.minX, y: rect.minY)
                }
                if let first = selection.rects.first {
                    Text(selection.title)
                        .font(.caption)
                        .lineLimit(1)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(Palette.selection, in: RoundedRectangle(cornerRadius: 6))
                        .fixedSize()
                        .offset(x: max(8, first.minX), y: first.minY > 90 ? first.minY - 24 : first.maxY + 4)
                }
            }
        }
    }
}

/// The pins of the notes on this screen, each at its element.
struct PinsLayer: View {
    let model: OverlayModel
    let open: (String) -> Void

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.clear.allowsHitTesting(false)
            // Placed by the overlay's tick (`PinBoard`): nothing is worked out here, on every frame.
            ForEach(model.pins) { pin in
                Button { open(pin.id) } label: {
                    PinMark(number: pin.number, status: pin.status, pending: pin.pending)
                        .shadow(color: Palette.pinShadow.opacity(0.3), radius: 3, y: 2)
                        // Not found on screen: where the note was made, faded.
                        .opacity(pin.detached ? 0.55 : 1)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Note \(pin.number), \(pin.status.replacingOccurrences(of: "_", with: " "))")
                .region("pin.\(pin.id)", model)
                .offset(x: pin.origin.x, y: pin.origin.y)
            }
        }
    }
}

/// A note's pin: its number on its status's colour, ringed in amber instead of white while it is not sent.
struct PinMark: View {
    let number: Int
    let status: String
    let pending: Bool

    var body: some View {
        Text(number > 0 ? "\(number)" : "")
            .font(.system(size: 12, weight: .heavy))
            .foregroundStyle(.white)
            .frame(width: 24, height: 24)
            .background(Palette.status(status), in: Circle())
            .overlay(Circle().stroke(pending ? Palette.connecting : Color.white, lineWidth: 2))
    }
}
#endif
