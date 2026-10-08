import Foundation
import Testing
@testable import Notato

@Suite("Text clipped to the schema")
struct ClipTests {
    @Test func aShortTextIsLeftAlone() {
        #expect("Add to cart".clipped(toScalars: 200) == "Add to cart")
        #expect(String(repeating: "a", count: 200).clipped(toScalars: 200).count == 200)
    }

    @Test func emojiWithSkinTonesAreCountedAsTheServerCountsThem() {
        let thumbs = String(repeating: "👍🏽", count: 120)
        #expect(thumbs.count == 120, "fits by Swift's count")
        let clipped = thumbs.clipped(toScalars: 200)
        #expect(clipped.unicodeScalars.count <= 200)
        #expect(clipped == String(repeating: "👍🏽", count: 99) + "…", "no emoji is split from its tone")
    }

    @Test func aHindiSentenceIsCutBetweenSyllables() {
        let sentence = String(repeating: "हिन्दी में लिखा गया वाक्य ", count: 9)
        #expect(sentence.count <= 200 && sentence.unicodeScalars.count > 200)
        let clipped = sentence.clipped(toScalars: 200)
        #expect(clipped.unicodeScalars.count <= 200)
        #expect(sentence.hasPrefix(String(clipped.dropLast())), "whole characters only")
        #expect(clipped.hasSuffix("…"))
    }

    @Test func oneCharacterLongerThanTheLimitIsCutInside() {
        let pile = "a" + String(repeating: "\u{0301}", count: 300)
        #expect(pile.count == 1)
        #expect(pile.clipped(toScalars: 200).unicodeScalars.count == 200)
    }

    @Test @MainActor func anIdentityOfLongEmojiAndHindiPassesTheServersSchema() throws {
        for label in [String(repeating: "👍🏽", count: 120), String(repeating: "हिन्दी में लिखा गया वाक्य ", count: 9)] {
            let element = ScreenElement(role: "button", label: label, value: nil, identifier: nil, frame: CGRect(x: 0, y: 0, width: 100, height: 40), control: "Button")
            let identity = IdentityBuilder.describe(element, among: [element], maskInputs: false, sourceRoot: nil)
            #expect((identity.text?.unicodeScalars.count ?? 0) <= ElementIdentity.textLimit)
            var annotation = Fixture.annotation()
            annotation.target.identity = [identity]
            guard let result = try Fixture.validate("annotation", try NotatoJSON.encoder.encode(annotation)) else { continue }
            #expect(result.ok, "\(result.output)")
            // Clipped by Swift's count of characters instead, the server would refuse it.
            annotation.target.identity[0].text = label.count > 200 ? String(label.prefix(199)) + "…" : label
            #expect(try Fixture.validate("annotation", try NotatoJSON.encoder.encode(annotation))?.ok == false)
        }
    }
}
