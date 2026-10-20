#if canImport(UIKit)
import UIKit

/// The text fields in a window, found from its views rather than from the accessibility tree, which can leave fields
/// out: under a sheet or an alert (`accessibilityViewIsModal` hides what is beside it), in a subtree hidden from
/// accessibility or a container that lists its own elements, inside a combined element, or all of them while the tree
/// is still being built. Everything drawn is looked at: every `UITextField` (SwiftUI's `TextField` and `SecureField`
/// are ones underneath), every editable `UITextView` (a `TextField` with a vertical axis, a `TextEditor`), and any
/// other view that says its entry is secure. Covering one too many is fine; leaving one showing is not.
@MainActor
enum InputFields {
    static func find(in window: UIWindow) -> [InputField] {
        var found: [InputField] = []
        // A list of views still to look at rather than recursion, however deep the app's views go.
        var views: [UIView] = [window]
        while let view = views.popLast() {
            // What is hidden is not drawn, nor is anything in it.
            guard !view.isHidden, view.alpha >= 0.01 else { continue }
            if let field = field(view, in: window) {
                found.append(field)
            } else {
                views.append(contentsOf: view.subviews.reversed())
            }
        }
        return found
    }

    /// The view as a field, or nil when it is not one or is not in the window's bounds.
    private static func field(_ view: UIView, in window: UIWindow) -> InputField? {
        let isSecure: Bool
        let text: String?
        switch view {
        case let field as UITextField:
            isSecure = field.isSecureTextEntry
            text = field.text
        case let field as UITextView where field.isEditable:
            isSecure = field.isSecureTextEntry
            text = field.text
        default:
            guard (view as? UITextInputTraits)?.isSecureTextEntry == true else { return nil }
            isSecure = true
            text = nil
        }
        let frame = view.convert(view.bounds, to: window)
        guard frame.width > 0, frame.height > 0, frame.intersects(window.bounds) else { return nil }
        // A secure field's text is never read: it is not shown anywhere else to be taken out.
        return InputField(frame: frame, isSecure: isSecure, text: isSecure ? nil : text)
    }
}
#endif
