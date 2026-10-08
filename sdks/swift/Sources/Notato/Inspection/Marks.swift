import Foundation
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// A view the app marked for Notato: a name, and where it is written in the source (filled in by the compiler).
struct Mark: Identifiable, Equatable {
    /// `mask` is a private view (`.notatoMask()`), `unmask` one whose text fields opt out of `maskInputs`
    /// (`.notatoMask(false)`).
    enum Kind: Equatable { case view, screen, mask, unmask, ignore }

    let id: UUID
    var kind: Kind
    var name: String
    var file: String
    var line: Int
    var column: Int
    /// In window coordinates.
    var frame: CGRect
    #if canImport(UIKit)
    /// A plain view behind the marked one: asked for its position in the window, which is right in sheets and
    /// popovers too (SwiftUI's global coordinates are each hosting controller's own).
    weak var probe: UIView?
    #endif
    /// The order marks appeared in: screens pushed later are on top.
    var order: Int
}

/// The marks currently on screen. Modifiers add themselves when they appear (again: a page popped back to, a tab
/// chosen again) and leave when they disappear. Each mark is in one window; with several (iPad), a window's overlay
/// asks only for its own.
@MainActor
final class MarkRegistry {
    static let shared = MarkRegistry()

    private(set) var marks: [UUID: Mark] = [:]
    private var counter = 0

    func upsert(id: UUID, kind: Mark.Kind, name: String, file: String, line: Int, column: Int, frame: CGRect) {
        if var existing = marks[id] {
            existing.frame = frame
            existing.name = name
            // `.notatoMask(isPrivate)` can change its mind while the view is showing.
            existing.kind = kind
            marks[id] = existing
        } else {
            counter += 1
            marks[id] = Mark(id: id, kind: kind, name: name, file: file, line: line, column: column, frame: frame, order: counter)
        }
    }

    func remove(id: UUID) {
        marks[id] = nil
        #if canImport(UIKit)
        // The probe stays with its view, which comes back with the mark when the view does; gone views are let go.
        probes = probes.filter { $0.value.view != nil }
        #endif
    }

    #if canImport(UIKit)
    private final class WeakView { weak var view: UIView?; init(_ view: UIView) { self.view = view } }
    /// Probes can be made before their mark has a frame: kept here and joined up when asked.
    private var probes: [UUID: WeakView] = [:]

    func attach(probe: UIView, to id: UUID) {
        probes[id] = WeakView(probe)
    }
    #endif

    /// Brings every mark's frame up to date from its probe, in window coordinates; marks not in a window are dropped
    /// from the answer (they are on a screen that is not showing). With `window`, only the marks in that window, and
    /// those whose probe is not made yet (for a moment as they appear), which cannot say: a private view is covered
    /// sooner rather than later.
    private func current(in window: AnyObject? = nil) -> [Mark] {
        marks.values.compactMap { current($0, in: window) }
    }

    /// One mark as it is now, or nil when it is not showing (in `window`, with one).
    private func current(_ mark: Mark, in window: AnyObject?) -> Mark? {
        #if canImport(UIKit)
        guard let probe = mark.probe ?? probes[mark.id]?.view else { return mark }
        guard let home = probe.window, !probe.isHiddenInHierarchy, window == nil || home === window else { return nil }
        var updated = mark
        updated.frame = probe.convert(probe.bounds, to: nil)
        return updated
        #else
        return mark
        #endif
    }

    func frame(of id: UUID, in window: AnyObject? = nil) -> CGRect? { marks[id].flatMap { current($0, in: window) }?.frame }

    func all(_ kind: Mark.Kind, in window: AnyObject? = nil) -> [Mark] {
        current(in: window).filter { $0.kind == kind && $0.frame.width > 0 && $0.frame.height > 0 }.sorted { $0.order < $1.order }
    }

    /// Screens showing, in the order they appeared: a navigation stack's pages, a sheet over its presenter.
    func screens(in window: AnyObject? = nil) -> [Mark] { all(.screen, in: window) }

    /// The marks whose frame holds `rect`, outermost first: screens in the order they appeared, then views from the
    /// largest to the smallest. With `window`, only that window's marks, and of those only the ones in the same
    /// presentation as what is at the middle of `rect`, so a sheet's screen is not mistaken for the page underneath it.
    func around(_ rect: CGRect, kinds: Set<Mark.Kind> = [.view, .screen], in window: AnyObject? = nil) -> [Mark] {
        var found = current(in: window).filter { kinds.contains($0.kind) && $0.frame.insetBy(dx: -1, dy: -1).contains(rect) }
        #if canImport(UIKit)
        if let window = window as? UIWindow, let hit = window.hitTest(CGPoint(x: rect.midX, y: rect.midY), with: nil),
           let layer = Self.presentation(of: hit) {
            let same = found.filter { mark in
                guard let probe = mark.probe ?? probes[mark.id]?.view else { return true }
                return Self.presentation(of: probe) === layer
            }
            if !same.isEmpty { found = same }
        }
        #endif
        let screens = found.filter { $0.kind == .screen }.sorted { $0.order < $1.order }
        let views = found.filter { $0.kind != .screen }
            .sorted { ($0.frame.width * $0.frame.height, $1.order) > ($1.frame.width * $1.frame.height, $0.order) }
        return screens + views
    }

    #if canImport(UIKit)
    /// The view controller a view is presented in: a sheet's, or the window's root for everything pushed or tabbed.
    static func presentation(of view: UIView) -> UIViewController? {
        var responder: UIResponder? = view
        while let current = responder, !(current is UIViewController) { responder = current.next }
        var controller = responder as? UIViewController
        while let parent = controller?.parent { controller = parent }
        return controller
    }
    #endif
}

private struct MarkModifier: ViewModifier {
    let kind: Mark.Kind
    let name: String
    let file: String
    let line: Int
    let column: Int
    @State private var id = UUID()
    @State private var frame = CGRect.zero

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame in
                self.frame = frame
                MarkRegistry.shared.upsert(id: id, kind: kind, name: name, file: file, line: line, column: column, frame: frame)
            }
            #if canImport(UIKit)
            .background(MarkProbe(id: id).allowsHitTesting(false).accessibilityHidden(true))
            #endif
            // Back on screen (a page popped back to, a tab chosen again), a view whose geometry did not change is not
            // told so by `onGeometryChange`: put the mark back here, or the screen is missing from routes and pins.
            .onAppear { MarkRegistry.shared.upsert(id: id, kind: kind, name: name, file: file, line: line, column: column, frame: frame) }
            .onDisappear { MarkRegistry.shared.remove(id: id) }
    }
}

#if canImport(UIKit)
/// An empty UIKit view the size of the marked view, so its place in the window can be asked of UIKit.
private struct MarkProbe: UIViewRepresentable {
    let id: UUID

    func makeUIView(context: Context) -> UIView {
        let view = ProbeView()
        view.isUserInteractionEnabled = false
        view.isAccessibilityElement = false
        view.accessibilityElementsHidden = true
        view.onWindow = { [id] view in MarkRegistry.shared.attach(probe: view, to: id) }
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        MarkRegistry.shared.attach(probe: view, to: id)
    }

    final class ProbeView: UIView {
        var onWindow: ((UIView) -> Void)?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if window != nil { onWindow?(self) }
        }
    }
}

extension UIView {
    var isHiddenInHierarchy: Bool {
        var view: UIView? = self
        while let current = view {
            if current.isHidden || current.alpha < 0.01 { return true }
            view = current.superview
        }
        return false
    }
}
#endif

/// What a mark is called when it is not given a name: the type it is written in (read from the source where the
/// source can be read, the simulator and a Mac), else the file's name.
@MainActor
private func defaultName(_ path: String, _ line: Int) -> String {
    SourcePaths.enclosingType(path, line: line) ?? ((path as NSString).lastPathComponent as NSString).deletingPathExtension
}

public extension View {
    /// Marks this view for Notato, so a note about it (or anything inside it) says where it is written:
    /// `ProductCard.swift:24`. The name is how selectors and the component path refer to it.
    func notato(_ name: String? = nil, file: String = #filePath, line: Int = #line, column: Int = #column) -> some View {
        modifier(MarkModifier(kind: .view, name: name ?? defaultName(file, line), file: file, line: line, column: column))
    }

    /// Marks a screen: the root view of a page. Its name (the file's, unless given) becomes the note's route, and
    /// anything on it that is not marked itself is located in this file.
    func notatoScreen(_ name: String? = nil, file: String = #filePath, line: Int = #line, column: Int = #column) -> some View {
        modifier(MarkModifier(kind: .screen, name: name ?? defaultName(file, line), file: file, line: line, column: column))
    }

    /// Makes this view private: a customer's name, an address, a card number. It is covered with a grey box in every
    /// screenshot, and neither its text nor that of anything inside it goes into a note (as the element's text, its
    /// name, its selector or the label of a button around it).
    ///
    /// `.notatoMask(false)` opts a text field (or the fields inside this view) out of `maskInputs`, a search box say:
    /// it is shown in screenshots and what is typed in it recorded. It does not undo a private view around it, and a
    /// secure field is never shown or recorded.
    func notatoMask(_ masked: Bool = true) -> some View {
        modifier(MarkModifier(kind: masked ? .mask : .unmask, name: masked ? "mask" : "unmask", file: "", line: 0, column: 0))
    }

    /// The picker looks through this view: a debug banner, a watermark.
    func notatoIgnore() -> some View {
        modifier(MarkModifier(kind: .ignore, name: "ignore", file: "", line: 0, column: 0))
    }
}
