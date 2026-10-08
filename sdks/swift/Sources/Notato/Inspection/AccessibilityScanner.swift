#if canImport(UIKit)
import UIKit

/// Switches on the accessibility tree that `AccessibilityScanner` reads. iOS builds the accessibility tree of an app
/// (what VoiceOver reads) only when an assistive technology or a UI test asks for it. Notato reads that tree to describe what was tapped, so while it is on it loads UIKit's and SwiftUI's
/// accessibility bundles into the app and switches on application accessibility, as UI-testing tools do. The setting is
/// the system's, not the app's: Notato remembers what it was and puts it back when it is switched off or the app goes
/// to the background. `NotatoConfiguration.readAccessibility = false` leaves it alone (identity then comes from
/// `.notato()` marks only).
@MainActor
enum AccessibilityRuntime {
    private typealias Getter = @convention(c) () -> Bool
    private typealias Setter = @convention(c) (Bool) -> Void
    private static var bundlesLoaded = false
    /// What application accessibility was before Notato turned it on; nil when Notato has not changed it.
    private static var previous: Bool?
    private static var observers: [NSObjectProtocol] = []
    private static let changedKey = "notato.accessibility.changed"

    private static func library() -> UnsafeMutableRawPointer? { dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW) }

    static func activate() {
        observe()
        // Launched in the background (a push, a fetch, a location update): there is nothing on screen to read, and no
        // move to the background would come to put the setting back. It is switched on when the app comes forward.
        guard UIApplication.shared.applicationState != .background else { return }
        loadBundles()
        guard let handle = library(), let get = dlsym(handle, "_AXSApplicationAccessibilityEnabled"),
              let set = dlsym(handle, "_AXSApplicationAccessibilitySetEnabled") else { return }
        let enabled = unsafeBitCast(get, to: Getter.self)()
        // A run that was killed (Xcode's stop button) could not put it back: the marker says it was off before Notato.
        if UserDefaults.standard.bool(forKey: changedKey) { previous = false }
        if !enabled {
            if previous == nil { previous = false }
            UserDefaults.standard.set(true, forKey: changedKey)
            unsafeBitCast(set, to: Setter.self)(true)
        }
    }

    private static func observe() {
        guard observers.isEmpty else { return }
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { restore(keepObserving: true) }
        })
        for name in [UIApplication.willEnterForegroundNotification, UIApplication.didBecomeActiveNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { activate() }
            })
        }
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { restore(keepObserving: false) }
        })
    }

    /// With `readAccessibility` off Notato never turns the setting on, but a run that had it on and was killed may
    /// have left it on: put it back.
    static func undoKilledRun() {
        guard UserDefaults.standard.bool(forKey: changedKey) else { return }
        previous = false
        restore()
    }

    /// Puts application accessibility back the way it was.
    static func restore(keepObserving: Bool = false) {
        if let previous, let handle = library(), let set = dlsym(handle, "_AXSApplicationAccessibilitySetEnabled") {
            unsafeBitCast(set, to: Setter.self)(previous)
        }
        previous = nil
        UserDefaults.standard.removeObject(forKey: changedKey)
        if !keepObserving {
            for observer in observers { NotificationCenter.default.removeObserver(observer) }
            observers = []
        }
    }

    private static func loadBundles() {
        guard !bundlesLoaded else { return }
        bundlesLoaded = true
        let root = ProcessInfo.processInfo.environment["IPHONE_SIMULATOR_ROOT"] ?? ""
        for name in ["UIKit", "SwiftUI"] {
            if let bundle = Bundle(path: root + "/System/Library/AccessibilityBundles/\(name).axbundle"), !bundle.isLoaded {
                _ = bundle.load()
            }
        }
    }
}

/// Reads what is on screen from the accessibility tree: every control SwiftUI (or UIKit) draws reports its role,
/// label, identifier, value and frame there, which is what makes elements identifiable without the app marking them.
@MainActor
enum AccessibilityScanner {
    /// Every accessibility element in the window, in reading order, in window coordinates. Content under a modal
    /// presentation (what VoiceOver could not reach either) is left out.
    static func elements(in window: UIWindow) -> [ScreenElement] {
        var out: [ScreenElement] = []
        var seen = Set<ObjectIdentifier>()
        visit(window, window: window, out: &out, seen: &seen, depth: 0)
        return out
    }

    private static func visit(_ object: NSObject, window: UIWindow, out: inout [ScreenElement], seen: inout Set<ObjectIdentifier>, depth: Int) {
        guard depth < 60, seen.insert(ObjectIdentifier(object)).inserted else { return }
        if let view = object as? UIView {
            if view.isHidden || view.alpha < 0.01 || view.accessibilityElementsHidden { return }
        } else if object.accessibilityElementsHidden {
            return
        }
        if object.isAccessibilityElement {
            if let element = describe(object, window: window) { out.append(element) }
            return
        }
        if let children = object.accessibilityElements as? [NSObject], !children.isEmpty {
            for child in children { visit(child, window: window, out: &out, seen: &seen, depth: depth + 1) }
            return
        }
        let count = object.accessibilityElementCount()
        if count != NSNotFound, count > 0 {
            for index in 0..<count {
                if let child = object.accessibilityElement(at: index) as? NSObject {
                    visit(child, window: window, out: &out, seen: &seen, depth: depth + 1)
                }
            }
            return
        }
        guard let view = object as? UIView else { return }
        // A modal presentation hides its siblings from VoiceOver: only the topmost modal one is reachable.
        let subviews = view.subviews
        if let modal = subviews.last(where: { $0.accessibilityViewIsModal && !$0.isHidden }) {
            visit(modal, window: window, out: &out, seen: &seen, depth: depth + 1)
            return
        }
        for child in subviews { visit(child, window: window, out: &out, seen: &seen, depth: depth + 1) }
    }

    private static func describe(_ object: NSObject, window: UIWindow) -> ScreenElement? {
        let screenFrame = object.accessibilityFrame
        guard screenFrame.width > 0, screenFrame.height > 0 else { return nil }
        let frame = window.convert(screenFrame, from: window.screen.coordinateSpace)
        guard frame.intersects(window.bounds) else { return nil }
        let traits = object.accessibilityTraits
        // SwiftUI's accessibility nodes answer accessibilityIdentifier without declaring the protocol.
        let identifier = (object as? UIAccessibilityIdentification)?.accessibilityIdentifier
            ?? (object.responds(to: NSSelectorFromString("accessibilityIdentifier")) ? object.value(forKey: "accessibilityIdentifier") as? String : nil)
        let textField = object as? UITextField ?? (object as? UIView)?.firstSubview(of: UITextField.self)
        let textView = object as? UITextView
        let isSecure = textField?.isSecureTextEntry == true
        let isTextInput = textField != nil || textView != nil || traits.contains(.searchField)
        let (role, control) = kind(traits: traits, object: object, isTextInput: textField != nil || textView != nil)
        return ScreenElement(
            role: role,
            label: clean(object.accessibilityLabel),
            value: isSecure ? nil : clean(object.accessibilityValue),
            identifier: clean(identifier),
            frame: frame,
            control: control,
            isTextInput: isTextInput,
            isSecure: isSecure)
    }

    private static func clean(_ text: String?) -> String? {
        guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return text.clipped(toScalars: ElementIdentity.textLimit)
    }

    /// The role in the web's vocabulary, and the control as SwiftUI calls it.
    private static func kind(traits: UIAccessibilityTraits, object: NSObject, isTextInput: Bool) -> (String?, String) {
        // UIAccessibilityTraitToggle (iOS 17) has no public constant in every SDK: bit 53, as UIKit defines it.
        let toggle = UIAccessibilityTraits(rawValue: 1 << 53)
        if isTextInput || traits.contains(.searchField) { return (traits.contains(.searchField) ? "searchbox" : "textbox", "TextField") }
        if traits.contains(toggle) || object is UISwitch { return ("switch", "Toggle") }
        if traits.contains(.adjustable) { return ("slider", object is UIStepper ? "Stepper" : "Slider") }
        if traits.contains(.link) { return ("link", "Link") }
        if traits.contains(.tabBar) { return ("tablist", "TabView") }
        if traits.contains(.button) { return ("button", "Button") }
        if traits.contains(.header) { return ("heading", "Text") }
        if traits.contains(.image) { return ("img", "Image") }
        if traits.contains(.staticText) { return ("text", "Text") }
        if object is UITableViewCell || object is UICollectionViewCell { return ("listitem", "List row") }
        return (nil, String(describing: type(of: object)).components(separatedBy: "<").first ?? "View")
    }
}

extension UIView {
    func firstSubview<T: UIView>(of type: T.Type) -> T? {
        for view in subviews {
            if let match = view as? T { return match }
            if let match = view.firstSubview(of: type) { return match }
        }
        return nil
    }
}
#endif
