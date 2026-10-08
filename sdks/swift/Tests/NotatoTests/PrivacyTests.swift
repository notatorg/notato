import Foundation
import SwiftUI
import Testing
@testable import Notato

@Suite("Privacy")
struct PrivacyTests {
    // A checkout screen: a private card (.notatoMask()) holding the number and the holder's name, a button whose label
    // reads out a private price, and text fields: plain, opted out (.notatoMask(false)), secure, and private and opted out.
    static let card = CGRect(x: 16, y: 160, width: 370, height: 80)
    static let price = CGRect(x: 300, y: 312, width: 70, height: 20)
    static let search = CGRect(x: 16, y: 440, width: 370, height: 44)
    static let password = CGRect(x: 16, y: 500, width: 370, height: 44)
    static let delivery = CGRect(x: 16, y: 560, width: 370, height: 44)
    static let masks = [card, price, delivery]
    static let optOuts = [search, password, delivery]

    let heading = ScreenElement(role: "heading", label: "Payment", value: nil, identifier: nil, frame: CGRect(x: 16, y: 120, width: 120, height: 30), control: "Text")
    let number = ScreenElement(role: "text", label: "4242 4242 4242 4242", value: nil, identifier: nil, frame: CGRect(x: 32, y: 172, width: 220, height: 20), control: "Text")
    let holder = ScreenElement(role: "text", label: "Ada Lovelace", value: nil, identifier: "CardHolder", frame: CGRect(x: 32, y: 204, width: 160, height: 20), control: "Text")
    let brand = ScreenElement(role: "text", label: "Visa", value: nil, identifier: nil, frame: CGRect(x: 16, y: 240, width: 60, height: 20), control: "Text")
    let jacket = ScreenElement(role: "button", label: "Summit Jacket, £179.00", value: nil, identifier: nil, frame: CGRect(x: 16, y: 280, width: 370, height: 85), control: "Button")
    let email = ScreenElement(role: "textbox", label: "Email", value: "dom@example.com", identifier: nil, frame: CGRect(x: 16, y: 380, width: 370, height: 44), control: "TextField", isTextInput: true)
    let query = ScreenElement(role: "textbox", label: "Search", value: "smoke detector", identifier: nil, frame: search, control: "TextField", isTextInput: true)
    let secret = ScreenElement(role: "textbox", label: "Password", value: "hunter2", identifier: nil, frame: password, control: "TextField", isTextInput: true, isSecure: true)
    let note = ScreenElement(role: "textbox", label: "Delivery note", value: "Ring twice", identifier: nil, frame: delivery, control: "TextField", isTextInput: true)

    var screen: [ScreenElement] { [heading, number, holder, brand, jacket, email, query, secret, note] }

    func applied(maskInputs: Bool) -> [ScreenElement] {
        Privacy.apply(screen, masks: Self.masks, optOuts: Self.optOuts, maskInputs: maskInputs)
    }

    @Test func aMarkAppliesWhenOneFrameLiesMostlyInsideTheOther() {
        #expect(Privacy.applies(Self.card, to: number.frame), "inside the private view")
        #expect(Privacy.applies(Self.price, to: jacket.frame), "holding the private view")
        #expect(!Privacy.applies(Self.card, to: brand.frame), "touching its edge")
        #expect(!Privacy.applies(Self.card, to: CGRect(x: 16, y: 235, width: 370, height: 44)), "overlapping it by a sliver")
        #expect(Privacy.applies(Self.card, to: CGRect(x: 16, y: 150, width: 370, height: 40)), "mostly inside it")
    }

    @Test func nothingAPrivateViewHoldsIsRecordedButItsNeighboursAre() {
        let out = applied(maskInputs: false)
        for element in [out[1], out[2]] {
            #expect(element.isMasked)
            #expect(element.label == nil && element.value == nil && element.text == nil)
        }
        #expect(out[2].identifier == "CardHolder", "the identifier is the app's, not the user's")
        #expect(out[2].role == "text" && out[2].frame == holder.frame)
        #expect(out[0].text == "Payment")
        #expect(out[3].text == "Visa")
    }

    @Test func aButtonThatReadsOutAPrivateTextHasNoText() {
        let button = applied(maskInputs: false)[4]
        #expect(button.isMasked)
        #expect(button.text == nil)
    }

    @Test func aPrivateElementIsSelectedByRoleIdentifierAndPositionNeverByText() throws {
        let out = applied(maskInputs: false)
        let selector = Selectors.make(for: out[1], among: out, screen: "Checkout")
        #expect(selector == "Checkout text:nth(2)", "the heading is a Text too")
        #expect(try Selectors.query(selector, in: out) == [out[1]])
        #expect(Selectors.make(for: out[2], among: out, screen: "Checkout") == "Checkout #CardHolder")
        #expect(Selectors.make(for: out[4], among: out, screen: nil) == "button")
        // An agent cannot find a private element by its text.
        for text in ["4242", "Ada", "179"] { #expect(try Selectors.query("*:text(\"\(text)\")", in: out).isEmpty) }
    }

    @Test @MainActor func theNoteCarriesNoTextOfAPrivateElement() {
        let out = applied(maskInputs: false)
        for element in [out[1], out[2], out[4]] {
            let identity = IdentityBuilder.describe(element, among: out, maskInputs: false, sourceRoot: nil)
            #expect(identity.text == nil && identity.name == nil)
            #expect(!identity.selector.contains(":text("), "\(identity.selector)")
        }
        #expect(IdentityBuilder.describe(out[2], among: out, maskInputs: false, sourceRoot: nil).testId == "CardHolder")
        // Scrubbed again on the way in: an element marked private but not yet scrubbed still says nothing.
        var unscrubbed = number
        unscrubbed.isMasked = true
        let identity = IdentityBuilder.describe(unscrubbed, among: screen, maskInputs: false, sourceRoot: nil)
        #expect(identity.text == nil && identity.name == nil && !identity.selector.contains("4242"))
    }

    @Test @MainActor func maskedInputsKeepTheirLabelButNotWhatIsTyped() {
        let masked = applied(maskInputs: true)
        let identity = IdentityBuilder.describe(masked[5], among: masked, maskInputs: true, sourceRoot: nil)
        #expect(identity.text == "Email" && identity.name == "Email")
        #expect(!identity.selector.contains("dom@"), "\(identity.selector)")
        // In dev mode, inputs are not masked.
        #expect(applied(maskInputs: false)[5].value == "dom@example.com")
    }

    @Test @MainActor func aFieldCanOptOutOfMaskInputsButASecureFieldNeverCan() {
        let out = applied(maskInputs: true)
        #expect(out[6].optsOut)
        #expect(out[6].value == "smoke detector")
        #expect(IdentityBuilder.describe(out[6], among: out, maskInputs: true, sourceRoot: nil).text == "Search smoke detector")
        for maskInputs in [true, false] {
            let secure = applied(maskInputs: maskInputs)[7]
            #expect(secure.value == nil && secure.text == "Password")
        }
    }

    @Test func aPrivateViewWinsOverAFieldInsideItThatOptsOut() {
        let field = applied(maskInputs: true)[8]
        #expect(field.isMasked && field.optsOut)
        #expect(field.text == nil)
    }

    @Test func screenshotsCoverPrivateViewsSecureFieldsAndMaskedInputs() {
        let masked = applied(maskInputs: true)
        #expect(Privacy.covered(masked, masks: Self.masks, maskInputs: true) == Self.masks + [email.frame, Self.password])
        let dev = applied(maskInputs: false)
        #expect(Privacy.covered(dev, masks: Self.masks, maskInputs: false) == Self.masks + [Self.password])
    }

    @Test func scrubbingTwiceChangesNothing() {
        let once = applied(maskInputs: true)
        #expect(once.map { Privacy.scrub($0, maskInputs: true) } == once)
        #expect(Privacy.apply(once, masks: Self.masks, optOuts: Self.optOuts, maskInputs: true) == once)
    }

    @Test @MainActor func theMaskModifierTakesNoArgumentOrFalse() {
        // Compiles: `.notatoMask()` to make a view private, and `.notatoMask(false)` to opt a field out.
        _ = Text("4242 4242 4242 4242").notatoMask()
        _ = TextField("Search", text: .constant("")).notatoMask(false)
    }
}

@Suite("Screenshots are covered as they were taken")
struct CapturedTests {
    @Test func theCoversAreWhereThingsWereWhenThePictureWasTaken() {
        let card = CGRect(x: 0, y: 100, width: 402, height: 80)
        let email = ScreenElement(role: "textbox", label: "Email", value: "dom@example.com", identifier: nil,
                                  frame: CGRect(x: 16, y: 300, width: 370, height: 44), control: "TextField", isTextInput: true)
        let shot = Captured("the picture", size: CGSize(width: 402, height: 874), elements: [email], privateViews: [card], maskInputs: true)
        #expect(shot.covers == [card, email.frame])
        // The list scrolls before Send: what is private is 200 points higher now, and covering that would cover the
        // wrong part of the picture. The picture's covers are still where it shows them.
        var scrolled = email
        scrolled.frame = email.frame.offsetBy(dx: 0, dy: -200)
        #expect(Privacy.covered([scrolled], masks: [card.offsetBy(dx: 0, dy: -200)], maskInputs: true) != shot.covers)
        #expect(shot.covers == [card, email.frame])
        #expect(Captured("", size: .zero, elements: [email], privateViews: [], maskInputs: false).covers.isEmpty, "dev mode leaves fields showing")
    }
}
