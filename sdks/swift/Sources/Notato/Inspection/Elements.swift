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
    /// `.notatoMask(false)` views, `fields` the text fields found in the app's views (`InputFields`), which the
    /// accessibility tree may not say are fields: an element that is one of them is taken as a field, and what is typed
    /// in one whose value is hidden is taken out of the element around it (a combined one) or in it.
    static func apply(_ elements: [ScreenElement], masks: [CGRect], optOuts: [CGRect], fields: [InputField] = [],
                      maskInputs: Bool) -> [ScreenElement] {
        let hidden = fields.filter { hides($0, optOuts: optOuts, maskInputs: maskInputs) }
        return elements.map { element in
            var element = element
            for field in hidden where applies(field.frame, to: element.frame) {
                // Much the same frame: the element is the field.
                if share(of: field.frame, in: element.frame) >= 0.8, share(of: element.frame, in: field.frame) >= 0.8 {
                    element.isTextInput = true
                    element.isSecure = element.isSecure || field.isSecure
                }
                element.label = without(field.text, in: element.label)
                element.value = without(field.text, in: element.value)
            }
            element.isMasked = masks.contains { applies($0, to: element.frame) }
            element.optsOut = element.isTextInput && optOuts.contains { applies($0, to: element.frame) }
            return scrub(element, maskInputs: maskInputs)
        }
    }

    /// Whether what is typed in a field is hidden: a secure field's always, any other's with `maskInputs` unless it
    /// opted out.
    static func hides(_ field: InputField, optOuts: [CGRect], maskInputs: Bool) -> Bool {
        field.isSecure || (maskInputs && !optOuts.contains { applies($0, to: field.frame) })
    }

    /// `text` without `typed` (and, typed over several lines, without each of them), and the commas and spaces left
    /// where it was; nil when nothing else is left.
    static func without(_ typed: String?, in text: String?) -> String? {
        guard var text, let typed else { return text }
        let parts = [typed] + typed.components(separatedBy: .newlines)
        for part in parts.map({ $0.trimmingCharacters(in: .whitespacesAndNewlines) }) where !part.isEmpty {
            text = text.replacingOccurrences(of: part, with: "")
        }
        text = text.replacingOccurrences(of: #"(\s*,\s*){2,}"#, with: ", ", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: ",").union(.whitespacesAndNewlines))
        return text.isEmpty ? nil : text
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

    /// What to cover in a screenshot: every private view, and the fields whose value is hidden, whether the
    /// accessibility tree has them (`elements`) or only the app's views do (`fields`).
    static func covered(_ elements: [ScreenElement], masks: [CGRect], fields: [InputField] = [], optOuts: [CGRect] = [],
                        maskInputs: Bool) -> [CGRect] {
        masks + elements.filter { hidesValue($0, maskInputs: maskInputs) }.map(\.frame)
            + fields.filter { hides($0, optOuts: optOuts, maskInputs: maskInputs) }.map(\.frame)
    }
}

/// A text field as the app's views have it (`InputFields`), whatever the accessibility tree says of it: where it is, in
/// window coordinates, whether it is secure, and what is typed in it, which is never recorded, only looked for in what
/// else the screen says so it can be taken out (none is read from a secure field).
struct InputField: Equatable {
    var frame: CGRect
    var isSecure: Bool
    var text: String?
}

/// A picture of the app's window and what must be covered in it, taken together. The covers are where the private
/// views and the fields were when the picture was taken: worked out later (when the note is sent, after a scroll or a
/// keyboard moved things), they would cover whatever is there by then and leave what they hide showing in the picture.
struct Captured<Picture> {
    let picture: Picture
    /// In points.
    let size: CGSize
    let covers: [CGRect]

    /// `elements`, `privateViews` and `fields` as they are now, as the picture is taken.
    init(_ picture: Picture, size: CGSize, elements: [ScreenElement], privateViews: [CGRect], fields: [InputField] = [],
         optOuts: [CGRect] = [], maskInputs: Bool) {
        self.picture = picture
        self.size = size
        covers = Privacy.covered(elements, masks: privateViews, fields: fields, optOuts: optOuts, maskInputs: maskInputs)
    }
}

/// A picture (a `UIImage`, which does not change) and the frames over it can go to be drawn off the main actor.
extension Captured: Sendable where Picture: Sendable {}
