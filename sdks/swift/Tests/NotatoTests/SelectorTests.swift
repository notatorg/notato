import Foundation
import Testing
@testable import Notato

@Suite("Selectors")
struct SelectorTests {
    let elements = Fixture.productList

    @Test(arguments: ["#PromoBanner", "text#PromoBanner", "ProductList #PromoBanner", "text:text(\"autumn\")", "*:has-text('Autumn sale')"])
    func agentsCanFindAnElementSeveralWays(selector: String) throws {
        #expect(try Selectors.query(selector, in: elements).first?.identifier == "PromoBanner")
    }

    @Test func generatedSelectorsFindExactlyTheirElement() throws {
        for element in elements {
            let selector = Selectors.make(for: element, among: elements, screen: "ProductList")
            let found = try Selectors.query(selector, in: elements)
            #expect(found == [element], "\(selector)")
        }
    }

    @Test func anIdentifierMakesTheShortestSelector() {
        #expect(Selectors.make(for: elements[1], among: elements, screen: "ProductList") == "ProductList #PromoBanner")
        #expect(Selectors.make(for: elements[5], among: elements, screen: nil) == "button:text(\"Add to cart\"):nth(2)")
    }

    @Test(arguments: ["", "#", "button:hover(1)", "button:text(\"open", "button:nth(0)", "button?"])
    func badSelectorsSayWhatIsWrong(selector: String) {
        #expect(throws: Selectors.SelectorError.self) { try Selectors.parse(selector) }
    }
}

@Suite("Selectors with any screen name")
struct ScreenNameTests {
    let elements = [
        ScreenElement(role: "button", label: "Add to cart", value: nil, identifier: nil, frame: CGRect(x: 15, y: 500, width: 100, height: 40), control: "Button"),
        ScreenElement(role: "text", label: "Total", value: nil, identifier: "Total", frame: CGRect(x: 15, y: 560, width: 100, height: 20), control: "Text"),
    ]

    @Test(arguments: ["ProductList", "My cart", "settings", "Ünïcode Screen", "Say \"hi\"", "back\\slash", "Cart#2", "a:b", "日本語", "it's", "x(y)", "Product.List-2", ""])
    func whatIsWrittenReadsBack(screen: String) throws {
        for element in elements {
            let selector = Selectors.make(for: element, among: elements, screen: screen)
            let parsed = try Selectors.parse(selector)
            #expect(parsed.screen == screen, "\(selector)")
            #expect(try Selectors.query(selector, in: elements) == [element], "\(selector)")
        }
    }

    @Test func aCapitalisedWordStaysBareAndAnythingElseIsQuoted() {
        #expect(Selectors.make(for: elements[1], among: elements, screen: "Checkout") == "Checkout #Total")
        #expect(Selectors.make(for: elements[1], among: elements, screen: "My cart") == "\"My cart\" #Total")
        #expect(Selectors.make(for: elements[0], among: elements, screen: "settings") == "\"settings\" button:text(\"Add to cart\")")
    }

    @Test func aLowercaseScreenWordIsReadToo() throws {
        #expect(try Selectors.parse("settings button").screen == "settings")
        #expect(try Selectors.parse("settings button").role == "button")
    }
}
