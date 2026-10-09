#if canImport(UIKit)
import SwiftUI

/// The floating toolbar: the open bar or the round button it folds into, wherever it was dragged to. Shown and hidden
/// (`Notato.showToolbar()`, a shake) by growing in and shrinking away where it is, or with Reduce Motion by fading.
struct ToolbarLayer: View {
    let model: OverlayModel
    let notato: Notato
    @State private var drag: CGSize = .zero
    /// The open bar's width, measured once its parts are laid out (about this with a count under 10).
    @State private var openWidth: CGFloat = 252
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { geometry in
            let d = ToolbarMetrics.height
            let look = model.toolbarLook
            // The width on screen now, from the round button's to the open bar's (a little past it as the spring opens).
            // The position comes from the same width in the same frame, so the held edge cannot lag behind it.
            let width = d + max(0, look.extent) * max(0, openWidth - d)
            let container = geometry.size
            let origin = ToolbarPlacement.placed(model.toolbarFraction, width: width, in: container, moved: drag)
            // Placed as a whole, so the bar grows from its own middle as it comes in.
            ZStack {
                if notato.isToolbarVisible {
                    bar(look: look, width: width)
                        .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
                }
            }
            .animation(reduceMotion ? .easeOut(duration: 0.2) : .spring(duration: 0.3, bounce: 0.2), value: notato.isToolbarVisible)
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
        // The notes on this screen, as the overlay's tick last counted them.
        let n = model.count
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
        .background(shape.fill(Palette.bar).shadow(color: Palette.barShadow.opacity(0.45), radius: 14, y: 10))
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
                        Text(countLabel(n))
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
                Text(countLabel(count))
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

/// A count as the bar shows it: up to 99, then 99+.
private func countLabel(_ count: Int) -> String { count > 99 ? "99+" : "\(count)" }

extension View {
    /// Draws one part of the toolbar as a fold or an opening has it at this moment.
    fileprivate func part(_ part: ToolbarLook.Part) -> some View {
        scaleEffect(part.scale)
            .rotationEffect(.degrees(part.turn))
            .offset(x: part.offset)
            .opacity(part.opacity)
    }
}
#endif
