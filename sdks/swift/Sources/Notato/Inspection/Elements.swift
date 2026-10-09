import Foundation

/// One thing on screen as Notato sees it: an accessibility element (what VoiceOver would read), or a marked view.
struct ScreenElement: Equatable {
    /// `button`, `text`, `heading`, `textbox`, `image`, `switch`, `slider`, `link`, `tab`, `searchbox`, or nil.
    var role: String?
    /// The accessibility label.
    var label: String?
    /// The accessibility value (a text field's text, a slider's position).
    var value: String?
    /// The accessibility identifier.
    var identifier: String?
    /// In window coordinates.
    var frame: CGRect
    /// The kind of control as SwiftUI names it, when it can be told: `Button`, `Text`, `TextField`, `Toggle`, `Image`.
    var control: String
    /// A secure or editable text field: its value is never recorded when inputs are masked.
    var isTextInput: Bool = false
    var isSecure: Bool = false
    /// Inside a private view (`.notatoMask()`), or holding one: nothing it says is recorded. Set by `Privacy.apply`.
    var isMasked: Bool = false
    /// A text field marked `.notatoMask(false)`: shown and recorded even when inputs are masked. Set by `Privacy.apply`.
    var optsOut: Bool = false

    /// What it says, for selectors and the note: the label, else the value.
    var text: String? {
        var parts: [String] = []
        for part in [label, isSecure ? nil : value] {
            guard let part = part?.trimmingCharacters(in: .whitespacesAndNewlines), !part.isEmpty, !parts.contains(part) else { continue }
            parts.append(part)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }
}

extension ScreenElement {
    /// A marked view as an element: known by its name, which is also how a selector finds it (`#Name`).
    init(marked mark: Mark) {
        self.init(role: nil, label: mark.name, value: nil, identifier: mark.name, frame: mark.frame,
                  control: mark.kind == .screen ? "Screen" : "View")
    }
}

/// What Notato must not record, by the same rules as the web and MAUI SDKs. A private view (`.notatoMask()`) is
/// covered in screenshots, and neither its text nor that of anything inside it goes into a note: not as an element's
/// text, name or selector, nor as part of the label of a button around it. A secure field never is either. With
/// `maskInputs`, editable text fields are covered and what is typed in them left out, unless they say
/// `.notatoMask(false)`. A private view wins over a field inside it that opts out.
///
/// An accessibility element is not a view, so which marks apply to it is told from frames, in window coordinates:
/// a mark applies to an element when one of them lies mostly inside the other.
enum Privacy {
    /// How much of `rect` lies inside `region`, from 0 to 1.
    static func share(of rect: CGRect, in region: CGRect) -> CGFloat {
        let common = rect.intersection(region)
        guard !common.isNull, rect.width > 0, rect.height > 0 else { return 0 }
        return (common.width * common.height) / (rect.width * rect.height)
    }

    /// The element lies mostly inside the marked view (a text in a private card), or the marked view lies mostly inside
    /// the element (a button whose label reads out a private price with the rest). Neighbours that touch or overlap by
    /// a sliver are left alone.
    static func applies(_ mark: CGRect, to frame: CGRect) -> Bool {
        share(of: frame, in: mark) >= 0.5 || share(of: mark, in: frame) >= 0.5
    }

    /// The elements as they may be recorded. `masks` are the frames of private views, `optOuts` those of
    /// `.notatoMask(false)` views.
    static func apply(_ elements: [ScreenElement], masks: [CGRect], optOuts: [CGRect], maskInputs: Bool) -> [ScreenElement] {
        elements.map { element in
            var element = element
            element.isMasked = masks.contains { applies($0, to: element.frame) }
            element.optsOut = element.isTextInput && optOuts.contains { applies($0, to: element.frame) }
            return scrub(element, maskInputs: maskInputs)
        }
    }

    /// Takes out what may not be recorded: all of a masked element's text, and the value of a secure field or (with
    /// `maskInputs`) of a text field that has not opted out. Doing it twice changes nothing.
    static func scrub(_ element: ScreenElement, maskInputs: Bool) -> ScreenElement {
        var element = element
        if element.isMasked {
            element.label = nil
            element.value = nil
        } else if hidesValue(element, maskInputs: maskInputs) {
            element.value = nil
        }
        return element
    }

    /// A secure field always, a text field with `maskInputs` unless it opted out.
    static func hidesValue(_ element: ScreenElement, maskInputs: Bool) -> Bool {
        element.isSecure || (maskInputs && element.isTextInput && !element.optsOut)
    }

    /// What to cover in a screenshot: every private view, and the fields whose value is hidden.
    static func covered(_ elements: [ScreenElement], masks: [CGRect], maskInputs: Bool) -> [CGRect] {
        masks + elements.filter { hidesValue($0, maskInputs: maskInputs) }.map(\.frame)
    }
}

/// A picture of the app's window and what must be covered in it, taken together. The covers are where the private
/// views and the fields were when the picture was taken: worked out later (when the note is sent, after a scroll or a
/// keyboard moved things), they would cover whatever is there by then and leave what they hide showing in the picture.
struct Captured<Picture> {
    let picture: Picture
    /// In points.
    let size: CGSize
    let covers: [CGRect]

    /// `elements` and `privateViews` as they are now, as the picture is taken.
    init(_ picture: Picture, size: CGSize, elements: [ScreenElement], privateViews: [CGRect], maskInputs: Bool) {
        self.picture = picture
        self.size = size
        covers = Privacy.covered(elements, masks: privateViews, maskInputs: maskInputs)
    }
}

/// A picture (a `UIImage`, which does not change) and the frames over it can go to be drawn off the main actor.
extension Captured: Sendable where Picture: Sendable {}
