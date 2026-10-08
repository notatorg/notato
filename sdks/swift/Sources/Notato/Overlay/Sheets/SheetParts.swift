#if canImport(UIKit)
import SwiftUI

// The pieces every sheet and card is built from, drawn as the ⋯ menu is.

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
                PinMark(number: number, status: status, pending: pending)
                    .shadow(color: Palette.pinShadow.opacity(0.25), radius: 2, y: 1)
            }
        }
        .foregroundStyle(style == .primary ? Color.white : style == .danger ? Palette.danger : Palette.text)
        .frame(width: size, height: size)
        .background(style == .primary ? Palette.accent : Palette.soft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityHidden(true)
    }
}

/// What does not fit scrolls; what fits is as tall as it is.
struct SheetScroll<Content: View>: View {
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
    /// The look of a text field in a sheet or a card.
    func field() -> some View { modifier(FieldBackground()) }
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
#endif
