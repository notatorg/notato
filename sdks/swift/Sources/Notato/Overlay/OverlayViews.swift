#if canImport(UIKit)
import SwiftUI
import UIKit

/// Notato's colours: the web toolbar's (`sdks/browser/src/ui/styles.ts`), so the overlay reads as the same product
/// as the board. The bar is always dark; sheets and cards follow the app's light or dark.
enum Palette {
    // ---- the bar, the hint and the toast
    static let bar = Color(hex: 0x17181b)
    static let barText = Color(hex: 0xeceded)
    static let barMuted = Color(hex: 0x8b8f97)
    /// A pressed button on the bar, and the count's badge.
    static let barPressed = Color(hex: 0x2a2c31)
    static let barLine = Color(hex: 0x33353a)
    static let barAccent = Color(hex: 0x45bfa8)
    static let onBarAccent = Color(hex: 0x0b1f1b)

    // ---- sheets and cards
    static let background = Color(light: 0xffffff, dark: 0x1d1e21)
    static let text = Color(light: 0x1d1f22, dark: 0xe6e7ea)
    static let muted = Color(light: 0x686c72, dark: 0x8f939b)
    static let line = Color(light: 0xe4e4df, dark: 0x2f3136)
    /// Icon tiles and text fields.
    static let soft = Color(light: 0xf2f2ef, dark: 0x26272b)
    /// Behind a sheet.
    static let scrim = Color(hex: 0x121418, opacity: 0.32)

    // ---- the brand
    static let accent = Color(hex: 0x1f8a78)
    static let accentPressed = Color(hex: 0x187465)
    static let danger = Color(hex: 0xd6453d)
    static let selection = Color(hex: 0xe5484d)

    // ---- the server
    static let connected = Color(hex: 0x2e9a5b)
    static let connecting = Color(hex: 0xe9b44c)
    static let offline = Color(hex: 0xef6b5e)

    /// A pin's colour for its note's status.
    static func status(_ status: String) -> Color {
        switch status {
        case Status.acknowledged: return Color(hex: 0xd99a1e)
        case Status.resolved: return Color(hex: 0x2e9a5b)
        case Status.revertRequested: return Color(hex: 0x8b5cf6)
        case Status.variantChosen: return Color(hex: 0x0891b2)
        case Status.reverted: return Color(hex: 0x64748b)
        case Status.dismissed: return Color(hex: 0x9a9a9a)
        default: return accent
        }
    }
}

extension Color {
    fileprivate init(hex: UInt32, opacity: Double = 1) {
        self.init(.sRGB, red: Double(hex >> 16 & 0xff) / 255, green: Double(hex >> 8 & 0xff) / 255, blue: Double(hex & 0xff) / 255, opacity: opacity)
    }

    /// One colour in light mode and another in dark, as the overlay's colour scheme has it.
    fileprivate init(light: UInt32, dark: UInt32) {
        func ui(_ hex: UInt32) -> UIColor {
            UIColor(red: CGFloat(hex >> 16 & 0xff) / 255, green: CGFloat(hex >> 8 & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
        }
        let lightColor = ui(light), darkColor = ui(dark)
        self.init(uiColor: UIColor { $0.userInterfaceStyle == .dark ? darkColor : lightColor })
    }
}

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
    fileprivate func region(_ key: String, _ model: OverlayModel) -> some View { modifier(Region(key: key, model: model)) }
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
                ToolbarLayer(model: model, notato: notato, hooks: hooks, session: session)
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
                VStack {
                    Text(toast)
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
                .allowsHitTesting(false)
                .transition(.opacity)
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
            VStack(alignment: .leading, spacing: 14) {
                SheetHeader(title: "Clear notes?", subtitle: notato.pendingCount == 1 ? "Removes the note on this device" : "Removes all \(notato.pendingCount) from this device") {
                    HeaderButton(.back, action: backToMenu)
                } trailing: {
                    HeaderButton(.close, action: close)
                }
                Text("A package you already shared keeps them.")
                    .font(.system(size: 13.5)).foregroundStyle(Palette.muted)
                    .padding(.horizontal, 4)
                HStack(spacing: 10) {
                    SheetButton("Keep them") { close() }
                    SheetButton("Clear", kind: .destructive) {
                        Task {
                            await notato.clearLocal()
                            close()
                            model.show(toast: "Notes cleared")
                        }
                    }
                }
            }
        }
    }

    private func backToMenu() { model.sheet = .menu }
}

// ---- pieces ------------------------------------------------------------------------------------------------------

/// The note being written floats away from what it is about, at the top or the bottom: a sheet's surface without the
/// grabber, as it is not pulled away.
struct Card<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(.top, 16).padding(.horizontal, 18).padding(.bottom, 18)
            .frame(maxWidth: 480, alignment: .leading)
            .foregroundStyle(Palette.text)
            .tint(Palette.accent)
            // The shadow is the surface's alone: on the whole card, every field, chip and button would cast one too.
            .background {
                RoundedRectangle(cornerRadius: 28, style: .continuous).fill(Palette.background)
                    .shadow(color: .black.opacity(0.25), radius: 20, y: 6)
            }
    }
}

// ---- the sheets: each is drawn as the ⋯ menu is --------------------------------------------------------------------

/// A floating bottom sheet, 8 points off the screen's edges, with a grabber. Pulled down far enough (by its grabber, or
/// anywhere that does not scroll), it closes.
struct BottomSheet<Content: View>: View {
    let close: () -> Void
    @ViewBuilder var content: Content
    @State private var pull: CGFloat = 0

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            VStack(spacing: 10) {
                Capsule().fill(Palette.line).frame(width: 36, height: 5).accessibilityHidden(true)
                content
            }
            .padding(.top, 10).padding(.horizontal, 18).padding(.bottom, 24)
            .foregroundStyle(Palette.text)
            .tint(Palette.accent)
            // The shadow is the surface's alone: on the whole sheet, every tile and line of text would cast one too.
            .background {
                RoundedRectangle(cornerRadius: 34, style: .continuous).fill(Palette.background)
                    .shadow(color: .black.opacity(0.25), radius: 20, y: -6)
            }
            .frame(maxWidth: 480)
            .offset(y: pull)
            .gesture(DragGesture(minimumDistance: 8)
                .onChanged { pull = max(0, $0.translation.height) }
                .onEnded { value in
                    if value.translation.height > 90 || value.predictedEndTranslation.height > 240 {
                        close()
                    } else {
                        withAnimation(.spring(duration: 0.3)) { pull = 0 }
                    }
                })
        }
        .padding(.horizontal, 8)
        .padding(.bottom, 8)
        // Floating 8 points off the screen's bottom edge, over the home indicator's strip, as iOS's own sheets do.
        .ignoresSafeArea(.container, edges: .bottom)
    }
}

/// A sheet's first line, as the menu's: the potato, a back button or the note's pin; the title and a line under it;
/// then the menu's connection, or a close button.
struct SheetHeader<Leading: View, Trailing: View>: View {
    let title: String
    let subtitle: String?
    @ViewBuilder var leading: Leading
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 12) {
            leading
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 20, weight: .bold)).tracking(-0.4).lineLimit(1)
                    .accessibilityAddTraits(.isHeader)
                if let subtitle {
                    Text(subtitle).font(.system(size: 12)).foregroundStyle(Palette.muted).lineLimit(1).truncationMode(.tail)
                }
            }
            Spacer(minLength: 8)
            trailing
        }
        .padding(EdgeInsets(top: 2, leading: 4, bottom: 6, trailing: 2))
    }
}

/// Back to the sheet this one was opened from (38 points, where the menu has its potato), or close.
struct HeaderButton: View {
    enum Kind { case back, close }

    let kind: Kind
    let action: () -> Void

    init(_ kind: Kind, action: @escaping () -> Void) {
        self.kind = kind
        self.action = action
    }

    var body: some View {
        let size: CGFloat = kind == .back ? 38 : 30
        Button(action: action) {
            Image(systemName: kind == .back ? "chevron.left" : "xmark")
                .font(.system(size: kind == .back ? 15 : 12, weight: .bold))
                .foregroundStyle(kind == .back ? Palette.text : Palette.muted)
                .frame(width: size, height: size)
                .background(Palette.soft, in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(kind == .back ? "Back" : "Close")
    }
}

/// A sheet's buttons: as wide as they can be, side by side.
struct SheetButton: View {
    enum Kind {
        case plain, primary
        /// Quiet, in red: deleting one note.
        case danger
        /// Filled red: confirming what cannot be undone.
        case destructive
    }

    let title: String
    let kind: Kind
    let action: () -> Void

    init(_ title: String, kind: Kind = .plain, action: @escaping () -> Void) {
        self.title = title
        self.kind = kind
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 15, weight: kind == .plain || kind == .danger ? .semibold : .bold))
                .lineLimit(1)
                .padding(.horizontal, 14)
                .frame(maxWidth: .infinity, minHeight: 50)
                .foregroundStyle(kind == .plain ? Palette.text : kind == .danger ? Palette.danger : Color.white)
                .contentShape(Rectangle())
        }
        .buttonStyle(SheetButtonStyle(kind: kind))
    }
}

private struct SheetButtonStyle: ButtonStyle {
    let kind: SheetButton.Kind

    func makeBody(configuration: Configuration) -> some View {
        let fill: Color = switch kind {
        case .plain, .danger: configuration.isPressed ? Palette.line : Palette.soft
        case .primary: configuration.isPressed ? Palette.accentPressed : Palette.accent
        case .destructive: Palette.danger.opacity(configuration.isPressed ? 0.85 : 1)
        }
        configuration.label.background(fill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

/// A sheet's 40-point tile: an icon, or a note's pin as the screen shows it.
struct SheetTile: View {
    enum Icon {
        case crosshair
        case symbol(String)
        case pin(number: Int, status: String, pending: Bool)
    }

    enum Style { case plain, primary, danger }

    let icon: Icon
    var style: Style = .plain
    var size: CGFloat = 40

    var body: some View {
        Group {
            switch icon {
            case .crosshair:
                CrosshairGlyph().stroke(style: StrokeStyle(lineWidth: 1.6, lineCap: .round)).frame(width: 19, height: 19)
            case let .symbol(name):
                Image(systemName: name).font(.system(size: 17, weight: .medium))
            case let .pin(number, status, pending):
                Text(number > 0 ? "\(number)" : "")
                    .font(.system(size: 12, weight: .heavy))
                    .foregroundStyle(.white)
                    .frame(width: 24, height: 24)
                    .background(Palette.status(status), in: Circle())
                    .overlay(Circle().stroke(pending ? Palette.connecting : Color.white, lineWidth: 2))
                    .shadow(color: Color(hex: 0x141820, opacity: 0.25), radius: 2, y: 1)
            }
        }
        .foregroundStyle(style == .primary ? Color.white : style == .danger ? Palette.danger : Palette.text)
        .frame(width: size, height: size)
        .background(style == .primary ? Palette.accent : Palette.soft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityHidden(true)
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

/// What does not fit scrolls; what fits is as tall as it is.
private struct SheetScroll<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        FitHeight {
            ScrollView { content }.scrollBounceBehavior(.basedOnSize)
        }
    }
}

/// As tall as what it holds would like to be, up to the room it is offered, in the same layout pass (a measured height
/// kept in state would be a frame late, and the sheet would jump while it animates).
private struct FitHeight: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        let ideal = child.sizeThatFits(ProposedViewSize(width: proposal.width, height: nil))
        return CGSize(width: proposal.width ?? ideal.width, height: min(ideal.height, proposal.height ?? .infinity))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
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

struct PinsLayer: View {
    let model: OverlayModel
    let open: (String) -> Void

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.clear.allowsHitTesting(false)
            // Placed by the overlay's tick (`PinBoard`): nothing is worked out here, on every frame.
            ForEach(model.pins) { pin in
                Button { open(pin.id) } label: {
                    Text("\(pin.number)")
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundStyle(.white)
                        .frame(width: 24, height: 24)
                        .background(Palette.status(pin.status), in: Circle())
                        // Not sent yet: amber instead of white.
                        .overlay(Circle().stroke(pin.pending ? Palette.connecting : Color.white, lineWidth: 2))
                        .shadow(color: Color(hex: 0x141820, opacity: 0.3), radius: 3, y: 2)
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

// ---- the toolbar -------------------------------------------------------------------------------------------------

struct ToolbarLayer: View {
    let model: OverlayModel
    let notato: Notato
    let hooks: PlatformHooks
    let session: WeakSession
    @State private var drag: CGSize = .zero
    /// The open bar's width, measured once its parts are laid out (about this with a count under 10).
    @State private var openWidth: CGFloat = 252

    /// The notes on this screen, as the overlay's tick last counted them.
    private func count() -> Int { model.count }

    var body: some View {
        GeometryReader { geometry in
            let d = ToolbarMetrics.height
            let look = model.toolbarLook
            // The width on screen now, from the round button's to the open bar's (a little past it as the spring opens).
            // The position comes from the same width in the same frame, so the held edge cannot lag behind it.
            let width = d + max(0, look.extent) * max(0, openWidth - d)
            let container = geometry.size
            let origin = ToolbarPlacement.placed(model.toolbarFraction, width: width, in: container, moved: drag)
            bar(look: look, width: width)
                .position(x: origin.x + width / 2, y: origin.y + d / 2)
                .gesture(DragGesture(minimumDistance: 6)
                    .onChanged { drag = $0.translation }
                    .onEnded { value in
                        let dropped = ToolbarPlacement.placed(model.toolbarFraction, width: width, in: container, moved: value.translation)
                        let fraction = ToolbarPlacement.fraction(of: dropped, width: width, in: container)
                        model.toolbarFraction = fraction
                        notato.state.toolbarPosition = fraction
                        drag = .zero
                    })
        }
        // Placed by its left and right edges, not by leading and trailing.
        .environment(\.layoutDirection, .leftToRight)
    }

    /// The bar, clipped to the width it has now. Its parts and the round button stay put on the side it is held to
    /// while the far edge sweeps over them; its corners go from fully round to the open bar's 16 as it widens.
    private func bar(look: ToolbarLook, width: CGFloat) -> some View {
        let d = ToolbarMetrics.height
        let collapsed = model.toolbarCollapsed
        let side: Alignment = model.toolbarHeldRight ? .trailing : .leading
        let n = count()
        let shape = RoundedRectangle(cornerRadius: d / 2 - (d / 2 - 16) * min(1, max(0, look.extent)), style: .circular)
        // What cannot be seen is left out, so VoiceOver and UI tests find only the controls that are there.
        let showItems = !collapsed || look.items.contains { $0.opacity > 0.001 }
        let showButton = collapsed || look.button.opacity > 0.001
        return ZStack(alignment: side) {
            if showItems {
                items(look: look, count: n)
                    .allowsHitTesting(!collapsed)
                    .accessibilityHidden(collapsed)
            }
            if showButton {
                Button { model.setToolbarCollapsed(false) } label: {
                    Potato(size: 40)
                        .frame(width: d, height: d)
                        .contentShape(Circle())
                }
                .accessibilityLabel("Show the Notato toolbar")
                .accessibilityValue(n > 0 ? "\(n) on this screen" : "")
                .part(look.button)
                .allowsHitTesting(collapsed)
                .accessibilityHidden(!collapsed)
            }
        }
        .buttonStyle(.plain)
        .frame(width: width, height: d, alignment: side)
        .clipShape(shape)
        .background(shape.fill(Palette.bar).shadow(color: Color(hex: 0x0f1114, opacity: 0.45), radius: 14, y: 10))
        .overlay(shape.strokeBorder(Palette.barLine, lineWidth: 1).allowsHitTesting(false))
        // The marks on the round button stand out of it, so they are drawn over the clip, turning with the button.
        .overlay(alignment: side) {
            if showButton {
                FoldMarks(count: n, dot: problemDot, badge: look.badge)
                    .frame(width: d, height: d)
                    .part(look.button)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        .region("toolbar", model)
    }

    /// The open bar: grip, Annotate with its count, the menu and the chevron that folds it, at their natural width
    /// (measured, as the width the bar opens to). The grip only shows where to hold it: the whole bar drags.
    private func items(look: ToolbarLook, count n: Int) -> some View {
        let annotating = notato.isAnnotating
        return HStack(spacing: 2) {
            // The grip moves with Annotate, so a fold and an opening keep their three parts and their timing.
            HStack(spacing: 2) {
                GripGlyph()
                    .fill(Palette.barMuted)
                    .frame(width: 14, height: 14)
                    .frame(width: 20, height: 44)
                    .accessibilityHidden(true)
                Button { annotating ? notato.stopAnnotating() : notato.startAnnotating() } label: {
                    HStack(spacing: 8) {
                        CrosshairGlyph()
                            .stroke(style: StrokeStyle(lineWidth: 1.65, lineCap: .round))
                            .frame(width: 18, height: 18)
                        Text("Annotate").font(.system(size: 15, weight: .bold))
                        Text(n > 99 ? "99+" : "\(n)")
                            .font(.system(size: 12.5, weight: .bold))
                            .monospacedDigit()
                            .padding(.horizontal, 7).padding(.vertical, 1)
                            .frame(minWidth: 22)
                            .background(annotating ? Palette.onBarAccent.opacity(0.16) : Palette.barPressed, in: Capsule())
                    }
                    .foregroundStyle(annotating ? Palette.onBarAccent : Palette.barText)
                    .padding(.leading, 12).padding(.trailing, 10)
                    .frame(height: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(BarButtonStyle(active: annotating))
                .accessibilityLabel("Annotate")
                .accessibilityValue("\(n) on this screen")
            }
            .part(look.items[0])
            Button { model.sheet = .menu } label: {
                DotsGlyph()
                    .fill(Palette.barText)
                    .frame(width: 18, height: 18)
                    .frame(width: 44, height: 44)
                    // The server's state shows only when something is wrong.
                    .overlay(alignment: .topTrailing) {
                        if let dot = problemDot {
                            Circle().fill(dot).frame(width: 8, height: 8)
                                .overlay(Circle().stroke(Palette.bar, lineWidth: 1.5))
                                .padding(9)
                        }
                    }
                    .contentShape(Rectangle())
            }
            .buttonStyle(BarButtonStyle())
            .accessibilityLabel("Notato menu")
            .accessibilityValue(problemDot == nil ? "" : notato.describeConnection())
            .part(look.items[1])
            Button { model.setToolbarCollapsed(true) } label: {
                // Points the way it folds.
                ChevronGlyph(right: model.toolbarHeldRight)
                    .stroke(Palette.barMuted, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
                    .frame(width: 16, height: 16)
                    .frame(width: 28, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(BarButtonStyle())
            .accessibilityLabel("Collapse the toolbar")
            .accessibilityIdentifier(model.toolbarHeldRight ? "chevron.right" : "chevron.left")
            .part(look.items[2])
        }
        .padding(5)
        .fixedSize()
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { openWidth = $0 }
    }

    /// Connecting or unreachable: a dot on the menu button, or on the round button when folded. Connected, or with
    /// no server, nothing.
    private var problemDot: Color? {
        switch notato.connection {
        case .connecting: return Palette.connecting
        case .offline, .refused: return Palette.offline
        default: return nil
        }
    }
}

/// A button on the bar: rounded 12, darker while pressed, teal while it is on.
private struct BarButtonStyle: ButtonStyle {
    var active = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(active ? Palette.barAccent : configuration.isPressed ? Palette.barPressed : Color.clear,
                        in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// The count of notes on this screen and the server's state, on the round button's corners.
private struct FoldMarks: View {
    let count: Int
    let dot: Color?
    let badge: ToolbarLook.Part

    var body: some View {
        ZStack {
            if count > 0 {
                Text(count > 99 ? "99+" : "\(count)")
                    .font(.system(size: 11, weight: .heavy))
                    .monospacedDigit()
                    .foregroundStyle(Palette.onBarAccent)
                    .padding(.horizontal, 5)
                    .frame(minWidth: 18, minHeight: 18, maxHeight: 18)
                    .background(Palette.barAccent, in: Capsule())
                    .padding(2)
                    .background(Palette.bar, in: Capsule())
                    .part(badge)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                    .offset(x: 6, y: -6)
            }
            if let dot {
                Circle().fill(dot).frame(width: 10, height: 10)
                    .padding(2)
                    .background(Palette.bar, in: Circle())
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
            }
        }
    }
}

/// The Notato potato, tilted as on the web toolbar.
struct Potato: View {
    let size: CGFloat

    /// From the package's resources (`notato@2x.png`, `notato@3x.png`).
    @MainActor private static let image = UIImage(named: "notato", in: Foundation.Bundle.module, compatibleWith: nil)

    var body: some View {
        Group {
            if let image = Self.image {
                Image(uiImage: image).resizable().interpolation(.high).scaledToFit()
            } else {
                NoteGlyph().stroke(Palette.barText, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round)).padding(size * 0.25)
            }
        }
        .frame(width: size, height: size)
        .rotationEffect(.degrees(-8))
        .accessibilityHidden(true)
    }
}

// ---- glyphs, drawn in a 24-point box as the web toolbar's are ------------------------------------------------------

extension Path {
    /// From a 24-point box to `rect`.
    fileprivate func fitted(to rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / 24
        return applying(CGAffineTransform(translationX: rect.minX, y: rect.minY).scaledBy(x: scale, y: scale))
    }
}

/// Six dots: where to hold the bar.
struct GripGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        for (x, y) in [(9, 6), (15, 6), (9, 12), (15, 12), (9, 18), (15, 18)] as [(CGFloat, CGFloat)] {
            path.addEllipse(in: CGRect(x: x - 1.6, y: y - 1.6, width: 3.2, height: 3.2))
        }
        return path.fitted(to: rect)
    }
}

/// Annotate's crosshair: a ring with four ticks across it.
struct CrosshairGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.addEllipse(in: CGRect(x: 4, y: 4, width: 16, height: 16))
        for (from, to) in [((12, 1.5), (12, 6)), ((12, 18), (12, 22.5)), ((1.5, 12), (6, 12)), ((18, 12), (22.5, 12))] as [((CGFloat, CGFloat), (CGFloat, CGFloat))] {
            path.move(to: CGPoint(x: from.0, y: from.1))
            path.addLine(to: CGPoint(x: to.0, y: to.1))
        }
        return path.fitted(to: rect)
    }
}

/// The menu's three dots.
struct DotsGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        for x in [5, 12, 19] as [CGFloat] { path.addEllipse(in: CGRect(x: x - 1.8, y: 10.2, width: 3.6, height: 3.6)) }
        return path.fitted(to: rect)
    }
}

/// The fold's chevron, pointing right or left.
struct ChevronGlyph: Shape {
    let right: Bool

    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: right ? 9 : 15, y: 6))
        path.addLine(to: CGPoint(x: right ? 15 : 9, y: 12))
        path.addLine(to: CGPoint(x: right ? 9 : 15, y: 18))
        return path.fitted(to: rect)
    }
}

/// A note with its corner folded over: drawn where the potato cannot be loaded.
struct NoteGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        // The outline, with the bottom right corner cut off where it folds.
        path.move(to: CGPoint(x: 15, y: 21))
        path.addLine(to: CGPoint(x: 5, y: 21))
        path.addArc(tangent1End: CGPoint(x: 3, y: 21), tangent2End: CGPoint(x: 3, y: 3), radius: 2)
        path.addArc(tangent1End: CGPoint(x: 3, y: 3), tangent2End: CGPoint(x: 21, y: 3), radius: 2)
        path.addArc(tangent1End: CGPoint(x: 21, y: 3), tangent2End: CGPoint(x: 21, y: 21), radius: 2)
        path.addLine(to: CGPoint(x: 21, y: 15))
        path.closeSubpath()
        // The fold.
        path.move(to: CGPoint(x: 15, y: 21))
        path.addLine(to: CGPoint(x: 15, y: 17))
        path.addArc(tangent1End: CGPoint(x: 15, y: 15), tangent2End: CGPoint(x: 21, y: 15), radius: 2)
        path.addLine(to: CGPoint(x: 21, y: 15))
        // Two lines of writing.
        path.move(to: CGPoint(x: 7.5, y: 8))
        path.addLine(to: CGPoint(x: 16.5, y: 8))
        path.move(to: CGPoint(x: 7.5, y: 12))
        path.addLine(to: CGPoint(x: 12.5, y: 12))
        return path.fitted(to: rect)
    }
}

extension View {
    /// Draws one part of the toolbar as a fold or an opening has it at this moment.
    fileprivate func part(_ part: ToolbarLook.Part) -> some View {
        scaleEffect(part.scale)
            .rotationEffect(.degrees(part.turn))
            .offset(x: part.offset)
            .opacity(part.opacity)
    }
}

// ---- the note being written ----------------------------------------------------------------------------------------

/// A text field's look in a card.
private struct FieldBackground: ViewModifier {
    func body(content: Content) -> some View {
        content
            .font(.system(size: 15))
            .padding(.horizontal, 12).padding(.vertical, 11)
            .background(Palette.soft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

extension View {
    fileprivate func field() -> some View { modifier(FieldBackground()) }
}

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

/// The words every Notato SDK uses for keeping things from the agent.
enum PeopleOnlyCopy {
    static let title = "People only"
    static let hint = "Keep this between people: the agent won't see it."
    static let aside = "Aside"
    static let asideHint = "Just for people: the agent won't see this reply."
}

enum CardCopy {
    /// A note's card with no server to send it to (test mode): where the note is, and how it leaves.
    static let keptHere = "Kept on this device. Package it from the menu to share it."
}

/// A switch for a note or a reply, with a line under its name saying what it does.
struct FlagToggle: View {
    let title: String
    let hint: String
    @Binding var isOn: Bool

    var body: some View {
        Toggle(isOn: $isOn) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 15, weight: .semibold))
                Text(hint).font(.system(size: 12.5)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
        .tint(Palette.accent)
    }
}

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

// ---- one note ---------------------------------------------------------------------------------------------------

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

// ---- the ⋯ menu: what a bottom sheet opens with --------------------------------------------------------------------

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

/// A row of a sheet, as the menu's: a tile, a title with a line under it, and a chevron when it opens another sheet.
struct MenuRow: View {
    let icon: SheetTile.Icon
    let title: String
    let detail: String
    var style: SheetTile.Style = .plain
    /// A note's comment may take two lines; everything else is one.
    var titleLines = 1
    /// Opens another sheet: a chevron says so.
    var opens = false
    /// The first of a group: a rule above it.
    var separated = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                SheetTile(icon: icon, style: style)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 15.5, weight: .semibold)).foregroundStyle(style == .danger ? Palette.danger : Palette.text)
                        .lineLimit(titleLines).multilineTextAlignment(.leading)
                    Text(detail).font(.system(size: 12.5)).foregroundStyle(Palette.muted).lineLimit(1)
                }
                Spacer(minLength: 0)
                if opens {
                    Text("›").font(.system(size: 18)).foregroundStyle(Palette.muted).accessibilityHidden(true)
                }
            }
            .padding(.vertical, 7).padding(.horizontal, 4)
            .frame(minHeight: 58)
            .contentShape(Rectangle())
        }
        .buttonStyle(MenuRowStyle())
        // A group starts after a little room, with the rule in the middle of it.
        .padding(.top, separated ? 9 : 0)
        .overlay(alignment: .top) {
            if separated { Rectangle().fill(Palette.line).frame(height: 1).padding(.top, 4).allowsHitTesting(false) }
        }
    }
}

private struct MenuRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Palette.soft : Color.clear, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
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

// ---- what the menu opens -----------------------------------------------------------------------------------------

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

struct NotesSheet: View {
    let notato: Notato
    let hooks: PlatformHooks
    let session: WeakSession
    let open: (String) -> Void
    let annotate: () -> Void
    let back: () -> Void
    let close: () -> Void

    /// The notes listed: the newest on this screen. The board has every one.
    static let shown = 50

    var body: some View {
        let notes = session.value.map { hooks.notes(on: $0) } ?? ScreenNotes()
        VStack(spacing: 10) {
            SheetHeader(title: "Notes", subtitle: "\(notes.count) on this screen · \(notato.records.count) in all") {
                HeaderButton(.back, action: back)
            } trailing: {
                HeaderButton(.close, action: close)
            }
            // One scroll view, not ViewThatFits: measuring the scrolling choice builds the rows on SwiftUI's render
            // thread during the sheet's animation, off the main actor, which Swift 6 stops the app for.
            SheetScroll { rows(notes) }
        }
    }

    /// The newest `shown`, in pin order (so the newest is last, as its pin's number is the highest), built as they
    /// scroll into view; then how many more there are, here and on other screens.
    private func rows(_ notes: ScreenNotes) -> some View {
        let newest = notes.newest(Self.shown)
        let older = notes.count - newest.count
        let others = notato.records.count - notes.count
        let more = [older > 0 ? "\(older) older on this screen." : nil, others > 0 ? "\(others) more on other screens." : nil].compactMap { $0 }
        return LazyVStack(alignment: .leading, spacing: 0) {
            if notes.all.isEmpty {
                MenuRow(icon: .crosshair, title: "Annotate", detail: "No notes on this screen yet", style: .primary, action: annotate)
            }
            ForEach(newest, id: \.record.id) { number, record in
                let a = record.annotation
                MenuRow(icon: .pin(number: number, status: a.status, pending: record.pending), title: a.comment,
                        detail: [a.status.replacingOccurrences(of: "_", with: " "), a.isPeopleOnly ? PeopleOnlyCopy.title : nil, Ago.text(a.createdAt)]
                            .compactMap { $0 }.joined(separator: " · "),
                        titleLines: 2, opens: true) { open(a.id) }
            }
            if !more.isEmpty {
                Text(more.joined(separator: " "))
                    .font(.system(size: 12.5)).foregroundStyle(Palette.muted)
                    .padding(.horizontal, 4).padding(.top, 14).padding(.bottom, 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(alignment: .top) { Rectangle().fill(Palette.line).frame(height: 1).padding(.top, 4) }
            }
        }
    }
}
#endif
