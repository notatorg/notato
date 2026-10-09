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
    /// With Reduce Motion, what comes and goes fades rather than sliding or growing.
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let hint = notato.isAnnotating && model.selection == nil && model.sheet == nil
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
                PinsLayer(model: model).ignoresSafeArea().transition(.opacity)
            }
            VStack {
                if hint {
                    HintBar(done: { notato.stopAnnotating() })
                        .region("hint", model)
                        .transition(OverlayMotion.fromEdge(.top, reduceMotion))
                }
                Spacer()
            }
            .padding(.top, 8)
            ToolbarLayer(model: model, notato: notato)
            if let sheet = model.sheet {
                if sheet == .composer {
                    SheetContainer(atTop: model.sheetAtTop) {
                        sheetContent(sheet)
                    }
                    // Up from below, or down from above when it is held at the top.
                    .transition(OverlayMotion.nudged(model.sheetAtTop ? -36 : 36, reduceMotion))
                } else {
                    Palette.scrim.ignoresSafeArea().onTapGesture { close() }.transition(.opacity)
                    // One sheet, whose content changes as someone goes from the menu to what it opens and back.
                    BottomSheet(close: close) {
                        sheetContent(sheet)
                    }
                    .transition(OverlayMotion.fromEdge(.bottom, reduceMotion))
                }
            }
            if let toast = model.toast {
                ToastLayer(message: toast).allowsHitTesting(false).transition(.opacity)
            }
        }
        .onGeometryChange(for: CGSize.self) { $0.size } action: { model.windowSize = $0 }
        // Annotating from code (or a shortcut) while the toolbar is folded opens it, and folds it again after.
        .onChange(of: notato.isAnnotating, initial: true) { _, active in
            model.annotatingChanged(active)
            hooks.refresh()
        }
        // Hidden toolbar and pins: the overlay has nothing to keep up to date, and stops (`PlatformHooks.refresh`).
        .onChange(of: notato.isToolbarVisible) { hooks.refresh() }
        .onChange(of: notato.pinsVisible) { hooks.refresh() }
        .animation(OverlayMotion.sheet(reduceMotion), value: model.sheet)
        // Chosen again across the middle of the window, the note being written moves to the other end.
        .animation(OverlayMotion.sheet(reduceMotion), value: model.sheetAtTop)
        .animation(OverlayMotion.sheet(reduceMotion), value: hint)
        .animation(.easeOut(duration: 0.2), value: notato.pinsVisible)
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

/// The selection's outline, and a label saying what it is. It fades in, and moves to what is chosen next (with Reduce
/// Motion, fades out there and in here).
struct SelectionLayer: View {
    let selection: SelectionView?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.clear
            if let selection {
                ZStack(alignment: .topLeading) {
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
                .id(reduceMotion ? "\(selection.rects)" : "outline")
                .transition(.opacity)
            }
        }
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .spring(duration: 0.3), value: selection)
    }
}

/// The pins of the notes on this screen, each at its element. Given the model alone, so that it is drawn again only
/// when the pins change, not whenever the rest of the overlay is.
struct PinsLayer: View {
    let model: OverlayModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.clear.allowsHitTesting(false)
            // Placed by the overlay (`PinBoard`): nothing is worked out here, on every frame.
            ForEach(model.pins, id: \.key) { pin in
                Button { model.sheet = .pin(pin.id) } label: {
                    PinMark(number: pin.number, status: pin.status, pending: pin.pending)
                        .background { PinShadow() }
                        // Not found on screen: where the note was made, faded.
                        .opacity(pin.detached ? 0.55 : 1)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Note \(pin.number), \(pin.status.replacingOccurrences(of: "_", with: " "))")
                .region("pin.\(pin.key)", model)
                .offset(x: pin.origin.x, y: pin.origin.y)
                // Grows from its own middle: the anchor is in the unmoved frame's terms, as the offset is outside it.
                .transition(reduceMotion ? .opacity : .scale(scale: 0.4, anchor: UnitPoint(x: (pin.origin.x + 12) / 24, y: (pin.origin.y + 12) / 24))
                    .combined(with: .opacity))
            }
        }
    }
}

/// A pin's shadow, drawn as a soft ring under it rather than blurred: with up to 150 pins, a `.shadow` each is a
/// blur each, drawn off screen again whenever they move. Made to look like the shadow it replaces (radius 3, 2 down,
/// 30%), seen only outside the pin.
struct PinShadow: View {
    var body: some View {
        Circle()
            .fill(RadialGradient(stops: [
                .init(color: Palette.pinShadow.opacity(0.3), location: 0.6),
                .init(color: Palette.pinShadow.opacity(0.15), location: 0.79),
                .init(color: Palette.pinShadow.opacity(0.04), location: 0.9),
                .init(color: Palette.pinShadow.opacity(0), location: 1),
            ], center: .center, startRadius: 0, endRadius: 16.5))
            .frame(width: 33, height: 33)
            .offset(y: 2)
            .allowsHitTesting(false)
    }
}

/// How the overlay's pieces come and go, the same everywhere; with Reduce Motion, nothing slides or grows.
enum OverlayMotion {
    /// Sheets, the note being written, the hint: a spring of about 0.3 s, or a short fade.
    static func sheet(_ reduceMotion: Bool) -> Animation { reduceMotion ? .easeOut(duration: 0.2) : .spring(duration: 0.3) }

    /// In from an edge as it fades in.
    static func fromEdge(_ edge: Edge, _ reduceMotion: Bool) -> AnyTransition {
        reduceMotion ? .opacity : .move(edge: edge).combined(with: .opacity)
    }

    /// Moved a little up or down as it fades in.
    static func nudged(_ y: CGFloat, _ reduceMotion: Bool) -> AnyTransition {
        reduceMotion ? .opacity : .offset(y: y).combined(with: .opacity)
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
