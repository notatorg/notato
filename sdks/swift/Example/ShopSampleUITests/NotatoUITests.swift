import XCTest

/// Drives Notato's overlay the way a person does, with real taps and typing. Needs a scratch Notato server: the tests post
/// notes to it, so it is never the default 4747, where a real one (with its webhooks) may be running. Start one with
/// `npx notato --port 4799 --dir "$(mktemp -d)"`, or give another as NOTATO_SERVER
/// (`TEST_RUNNER_NOTATO_SERVER=… xcodebuild test`).
@MainActor
final class NotatoUITests: XCTestCase {
    private var app: XCUIApplication!
    private let environment = ProcessInfo.processInfo.environment

    override func setUp() async throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchEnvironment["NOTATO_SERVER"] = environment["NOTATO_SERVER"] ?? "http://localhost:4799"
        app.launchEnvironment["NOTATO_PROJECT"] = "swift-uitest"
        app.launch()
        ensureEnabled()
    }

    /// A screenshot in the test's results, and in NOTATO_UITEST_OUT when set (to look at outside Xcode).
    private func shot(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let out = environment["NOTATO_UITEST_OUT"] {
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: out).appendingPathComponent("\(name).png"))
        }
    }

    /// An earlier run may have left Notato off, or its toolbar folded: switch it back on from the sample's Feedback
    /// tab, and open it.
    private func ensureEnabled() {
        let toolbar = app.buttons.matching(NSPredicate(format: "label == 'Annotate' OR label == %@", Self.fabLabel)).firstMatch
        if !toolbar.waitForExistence(timeout: 6) {
            tab("Feedback")
            let toggle = app.switches["NotatoEnabled"]
            XCTAssertTrue(toggle.waitForExistence(timeout: 5))
            if (toggle.value as? String) != "1" { flip(toggle) }
            let shown = app.switches["NotatoToolbar"]
            if (shown.value as? String) != "1" { flip(shown) }
            tab("Shop")
            XCTAssertTrue(toolbar.waitForExistence(timeout: 5))
        }
        if fab.exists {
            fab.tap()
            settle()
        }
        XCTAssertTrue(app.buttons["Annotate"].waitForExistence(timeout: 5))
    }

    private static let fabLabel = "Show the Notato toolbar"
    /// The round button the toolbar folds into.
    private var fab: XCUIElement { app.buttons[Self.fabLabel] }
    private var collapse: XCUIElement { app.buttons["Collapse the toolbar"] }

    /// Lets a fold or an opening finish (they take under 0.8s).
    private func settle() { Thread.sleep(forTimeInterval: 0.9) }

    /// The open bar's edges: 5 points around its parts, and the 20-point grip (2 from Annotate) on the left.
    private var barLeft: CGFloat { app.buttons["Annotate"].frame.minX - 27 }
    private var barRight: CGFloat { collapse.frame.maxX + 5 }

    private func fold() {
        collapse.tap()
        XCTAssertTrue(fab.waitForExistence(timeout: 3), "the round button should show")
        settle()
        XCTAssertFalse(app.buttons["Annotate"].exists, "the bar's buttons should be gone")
    }

    private var comment: XCUIElement { app.descendants(matching: .any)["NotatoComment"] }

    private func tab(_ name: String) {
        let button = app.tabBars.buttons[name].exists ? app.tabBars.buttons[name] : app.buttons[name]
        button.tap()
    }

    /// A SwiftUI Toggle's switch sits at the trailing end of its row.
    private func flip(_ toggle: XCUIElement) {
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
    }

    /// Menu items read as "Settings, Your name, screenshots, server".
    private func item(_ title: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", title, title + ",")).firstMatch
    }

    func testAnnotateAnElementAndSendIt() throws {
        app.buttons["Annotate"].tap()
        XCTAssertTrue(app.staticTexts["Tap what you want to comment on"].waitForExistence(timeout: 3))
        shot("01-annotating")

        // The price on the right of the first card. In annotate mode the tap lands on Notato's window, which picks.
        let card = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Trail Runner'")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        card.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        XCTAssertTrue(comment.waitForExistence(timeout: 5))
        shot("02-selected")

        comment.tap()
        comment.typeText("The price should line up with the title")
        app.buttons["Fix"].tap()
        app.buttons["Minor"].tap()
        shot("03-composer")
        app.buttons["NotatoSend"].tap()
        XCTAssertTrue(app.staticTexts["Sent"].waitForExistence(timeout: 10))
        shot("04-sent")
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Note '")).firstMatch.waitForExistence(timeout: 5))
        XCTAssertNotEqual(app.buttons["Annotate"].value as? String, "0 on this screen", "Annotate counts the notes on this screen")
    }

    /// A page pushed over the list and popped again: the list's notes keep their pins and their count, which are
    /// looked up by the list's route (the screen's mark must be back when the screen is), and the count follows.
    func testPinsComeBackAfterGoingBackToAScreen() throws {
        let annotate = app.buttons["Annotate"]
        annotate.tap()
        let banner = app.staticTexts["PromoBanner"]
        XCTAssertTrue(banner.waitForExistence(timeout: 5))
        banner.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(comment.waitForExistence(timeout: 5))
        comment.tap()
        comment.typeText("Still here after going back?")
        app.buttons["NotatoSend"].tap()
        XCTAssertTrue(app.staticTexts["Sent"].waitForExistence(timeout: 10))
        let count = try XCTUnwrap(annotate.value as? String)
        XCTAssertTrue(count.hasSuffix("on this screen"), count)
        let pins = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Note '"))
        XCTAssertTrue(pins.firstMatch.waitForExistence(timeout: 3))
        let pinCount = pins.count

        let card = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Summit Jacket'")).firstMatch
        card.tap()
        XCTAssertTrue(app.buttons["AddToCart"].waitForExistence(timeout: 5))
        let other = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value != %@", count), object: annotate)
        wait(for: [other], timeout: 4)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        let same = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", count), object: annotate)
        wait(for: [same], timeout: 4)
        shot("19-pins-after-going-back")
        XCTAssertTrue(pins.firstMatch.waitForExistence(timeout: 3), "the list's pins are back")
        XCTAssertEqual(pins.count, pinCount)
    }

    /// A note sent People only shows it on its card; turning it off there is recorded in the thread; a reply sent as an
    /// aside is marked, and the Aside switch is off again for the next one.
    func testPeopleOnlyAndAnAside() throws {
        app.buttons["Annotate"].tap()
        let banner = app.staticTexts["PromoBanner"]
        XCTAssertTrue(banner.waitForExistence(timeout: 5))
        banner.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5)).tap()
        XCTAssertTrue(comment.waitForExistence(timeout: 5))
        comment.tap()
        comment.typeText("Between us: is this the final copy?")
        let peopleOnly = app.switches["NotatoPeopleOnly"]
        XCTAssertTrue(peopleOnly.exists)
        XCTAssertEqual(peopleOnly.value as? String, "0", "off by default")
        XCTAssertTrue(app.staticTexts["Keep this between people: the agent won't see it."].exists)
        flip(peopleOnly)
        XCTAssertEqual(peopleOnly.value as? String, "1")
        shot("20-people-only-composer")
        app.buttons["NotatoSend"].tap()
        XCTAssertTrue(app.staticTexts["Sent"].waitForExistence(timeout: 10))

        // The newest note on the screen has the highest number.
        let pins = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Note '"))
        XCTAssertTrue(pins.firstMatch.waitForExistence(timeout: 5))
        let newest = pins.allElementsBoundByIndex.max { number($0) < number($1) }
        try XCTUnwrap(newest).tap()
        let badge = app.descendants(matching: .any)["NotatoPeopleOnlyBadge"]
        XCTAssertTrue(badge.waitForExistence(timeout: 5), "the card says People only")
        let onCard = app.switches["NotatoNotePeopleOnly"]
        XCTAssertEqual(onCard.value as? String, "1")
        XCTAssertTrue(app.switches["NotatoAside"].exists, "an aside is offered on a People only note too: it stays hidden if the note is shared later")
        shot("21-people-only-card")

        flip(onCard)
        let shared = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Shared this with the agent.'")).firstMatch
        XCTAssertTrue(shared.waitForExistence(timeout: 10), "the server records the change in the thread")
        XCTAssertTrue(badge.waitForNonExistence(timeout: 3))
        XCTAssertEqual(onCard.value as? String, "0")
        shot("22-shared-again")

        let replyField = app.descendants(matching: .any)["NotatoReply"]
        XCTAssertTrue(replyField.exists)
        replyField.tap()
        replyField.typeText("Checking with design first")
        let aside = app.switches["NotatoAside"]
        XCTAssertEqual(aside.value as? String, "0", "off by default")
        XCTAssertTrue(app.staticTexts["Just for people: the agent won't see this reply."].exists)
        flip(aside)
        XCTAssertEqual(aside.value as? String, "1")
        shot("23-aside-reply")
        app.buttons["NotatoSendReply"].tap()
        XCTAssertTrue(app.staticTexts["Aside sent"].waitForExistence(timeout: 10))

        try XCTUnwrap(pins.allElementsBoundByIndex.max { number($0) < number($1) }).tap()
        XCTAssertTrue(app.descendants(matching: .any)["Aside, kept from the agent"].waitForExistence(timeout: 5), "the aside is marked")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Checking with design first'")).firstMatch.exists)
        XCTAssertEqual(app.switches["NotatoAside"].value as? String, "0", "and the switch is off for the next reply")
        shot("24-aside-in-thread")
        app.buttons["Close"].firstMatch.tap()
    }

    /// Test mode keeps notes on the device: People only is turned on there, with the same entry in the thread the server
    /// would write, so a package carries it.
    func testPeopleOnlyOnANoteKeptOnTheDevice() throws {
        app.terminate()
        app.launchEnvironment["NOTATO_MODE"] = "test"
        app.launchEnvironment["NOTATO_PROJECT"] = "swift-uitest-people-only"
        app.launch()
        ensureEnabled()
        app.buttons["Annotate"].tap()
        let card = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Camp Mug'")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        card.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        XCTAssertTrue(comment.waitForExistence(timeout: 5))
        comment.tap()
        comment.typeText("Ask the client about the mug photo")
        app.buttons["NotatoSend"].tap()
        XCTAssertTrue(app.staticTexts["Saved on this device. Package it from the menu."].waitForExistence(timeout: 10))

        let pins = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Note '"))
        XCTAssertTrue(pins.firstMatch.waitForExistence(timeout: 5))
        try XCTUnwrap(pins.allElementsBoundByIndex.max { number($0) < number($1) }).tap()
        let onCard = app.switches["NotatoNotePeopleOnly"]
        XCTAssertTrue(onCard.waitForExistence(timeout: 5))
        XCTAssertEqual(onCard.value as? String, "0")
        XCTAssertFalse(app.switches["NotatoAside"].exists, "no replies until the server has the note")
        flip(onCard)
        XCTAssertTrue(app.descendants(matching: .any)["NotatoPeopleOnlyBadge"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Made this people only: the agent won't see it.")).firstMatch.exists)
        shot("25-people-only-on-the-device")
        app.buttons["Close"].firstMatch.tap()

        app.buttons["Notato menu"].tap()
        XCTAssertTrue(item("Clear notes").waitForExistence(timeout: 3))
        item("Clear notes").tap()
        app.buttons["Clear"].tap()
        XCTAssertTrue(app.staticTexts["Notes cleared"].waitForExistence(timeout: 5))
    }

    /// A pin's number, from its label ("Note 3, open").
    private func number(_ pin: XCUIElement) -> Int {
        Int(pin.label.dropFirst("Note ".count).prefix { $0.isNumber }) ?? 0
    }

    func testTouchesPassThroughToTheAppWhenNotAnnotating() throws {
        let card = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Summit Jacket'")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        card.tap()
        XCTAssertTrue(app.buttons["AddToCart"].waitForExistence(timeout: 5), "the tap should have opened the product")
    }

    func testAnnotatingInsideASheet() throws {
        app.buttons.matching(NSPredicate(format: "label CONTAINS 'Camp Mug'")).firstMatch.tap()
        app.buttons["Checkout"].tap()
        let pay = app.buttons["PayButton"]
        XCTAssertTrue(pay.waitForExistence(timeout: 5))
        app.buttons["Annotate"].tap()
        pay.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(comment.waitForExistence(timeout: 5))
        comment.tap()
        comment.typeText("Show the total on the button")
        shot("05-sheet-composer")
        app.buttons["NotatoSend"].tap()
        XCTAssertTrue(app.staticTexts["Sent"].waitForExistence(timeout: 10))
        shot("06-sheet-sent")
    }

    func testTheAppsLogGoesWithTheNote() throws {
        tab("Account")
        let signIn = app.buttons["SignIn"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 5))
        signIn.tap() // logs an error, which the note should carry
        app.buttons["Annotate"].tap()
        signIn.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(comment.waitForExistence(timeout: 5))
        comment.tap()
        comment.typeText("Sign in fails with no message")
        app.buttons["NotatoSend"].tap()
        XCTAssertTrue(app.staticTexts["Sent"].waitForExistence(timeout: 10))
    }

    func testMenuAndSettings() throws {
        app.buttons["Notato menu"].tap()
        XCTAssertTrue(item("Settings").waitForExistence(timeout: 3))
        shot("07-menu")
        item("Settings").tap()
        XCTAssertTrue(app.staticTexts["Settings"].waitForExistence(timeout: 3))
        shot("08-settings")
        app.buttons["Save"].tap()
    }

    /// The ⋯ sheet: the header with the server's state, and the rows in their groups. Package and share and Clear notes
    /// are test mode's only.
    func testTheMenuSheet() throws {
        app.buttons["Notato menu"].tap()
        XCTAssertTrue(app.staticTexts["Notato"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Dev mode · '")).firstMatch.exists)
        let status = app.descendants(matching: .any)["NotatoConnection"]
        XCTAssertTrue(status.waitForExistence(timeout: 5))
        XCTAssertTrue(NSPredicate(format: "label CONTAINS 'Connected'").evaluate(with: status) || status.label.contains("Connecting"), status.label)
        XCTAssertFalse(app.buttons["NotatoRetry"].exists, "no banner while the server answers")
        for title in ["Annotate, Tap an element", "Notes, ", "Settings, ", "Hide toolbar, ", "Turn Notato off, "] {
            XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch.exists, title)
        }
        XCTAssertTrue(item("Hide pins").exists || item("Show pins").exists)
        XCTAssertFalse(item("Package and share").exists, "test mode only")
        shot("17-menu-sheet")
        // Closed by tapping above it.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
        XCTAssertTrue(app.staticTexts["Notato"].waitForNonExistence(timeout: 3))
    }

    /// What the menu opens is drawn in the same sheet: Back goes to the menu, Close closes it.
    func testTheMenusSheetsGoBackToIt() throws {
        app.buttons["Notato menu"].tap()
        XCTAssertTrue(item("Notes").waitForExistence(timeout: 3))
        item("Notes").tap()
        XCTAssertTrue(app.staticTexts["Notes"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label ENDSWITH ' in all'")).firstMatch.exists)
        shot("26-notes-sheet")
        app.buttons["Back"].tap()
        XCTAssertTrue(app.staticTexts["Notato"].waitForExistence(timeout: 3), "Back reopens the menu")

        item("Settings").tap()
        XCTAssertTrue(app.staticTexts["Your name"].waitForExistence(timeout: 3))
        shot("27-settings-sheet")
        app.buttons["Back"].tap()
        XCTAssertTrue(item("Settings").waitForExistence(timeout: 3))

        item("Settings").tap()
        XCTAssertTrue(app.buttons["Close"].waitForExistence(timeout: 3))
        app.buttons["Close"].tap()
        XCTAssertTrue(app.staticTexts["Your name"].waitForNonExistence(timeout: 3), "Close closes it")
        XCTAssertFalse(app.staticTexts["Notato"].exists)
    }

    func testTestModeAddsPackageAndClearToTheMenu() throws {
        app.terminate()
        app.launchEnvironment["NOTATO_MODE"] = "test"
        app.launchEnvironment["NOTATO_PROJECT"] = "swift-uitest-testmode"
        app.launch()
        ensureEnabled()
        app.buttons["Annotate"].tap()
        let card = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Camp Mug'")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        card.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        XCTAssertTrue(comment.waitForExistence(timeout: 5))
        comment.tap()
        comment.typeText("The mug has no photo")
        app.buttons["NotatoSend"].tap()
        XCTAssertTrue(app.staticTexts["Saved on this device. Package it from the menu."].waitForExistence(timeout: 10))

        app.buttons["Notato menu"].tap()
        XCTAssertTrue(item("Package and share").waitForExistence(timeout: 3))
        XCTAssertTrue(item("Clear notes").exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Test mode · '")).firstMatch.exists)
        XCTAssertFalse(app.descendants(matching: .any)["NotatoConnection"].exists, "test mode keeps no connection to show")
        shot("18-test-mode-menu")
        item("Clear notes").tap()
        app.buttons["Clear"].tap()
        XCTAssertTrue(app.staticTexts["Notes cleared"].waitForExistence(timeout: 5))
        app.buttons["Notato menu"].tap()
        XCTAssertTrue(item("Settings").waitForExistence(timeout: 3))
        XCTAssertFalse(item("Clear notes").exists, "nothing left to clear")
    }

    func testSwitchingNotatoOffAndOnAtRuntime() throws {
        tab("Feedback")
        let toggle = app.switches["NotatoEnabled"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        flip(toggle)
        XCTAssertFalse(app.buttons["Annotate"].waitForExistence(timeout: 2), "the toolbar should be gone")
        shot("09-off")
        flip(toggle)
        XCTAssertTrue(app.buttons["Annotate"].waitForExistence(timeout: 5), "the toolbar should be back")
    }

    // ---- folding the toolbar ----------------------------------------------------------------------------------

    func testFoldingTheToolbarAndOpeningItAgain() throws {
        // Never dragged, it is held to its corner's side (bottom right here) and folds toward it.
        let edge = barRight
        shot("11-open")
        fold()
        shot("12-folded")
        XCTAssertEqual(fab.frame.maxX, edge, accuracy: 1, "the edge it is held to does not move")
        XCTAssertEqual(fab.frame.width, 54, accuracy: 1, "a circle the bar's height")
        fab.tap()
        XCTAssertTrue(app.buttons["Annotate"].waitForExistence(timeout: 3))
        settle()
        XCTAssertFalse(fab.exists)
        XCTAssertEqual(barRight, edge, accuracy: 1, "nor when it opens")
    }

    func testTheFoldIsRememberedAcrossLaunches() throws {
        fold()
        app.terminate()
        app.launch()
        XCTAssertTrue(fab.waitForExistence(timeout: 8), "it should come back folded")
        XCTAssertFalse(app.buttons["Annotate"].exists)
        fab.tap()
        XCTAssertTrue(app.buttons["Annotate"].waitForExistence(timeout: 3))
        settle()
        app.terminate()
        app.launch()
        XCTAssertTrue(app.buttons["Annotate"].waitForExistence(timeout: 8), "and open, once opened")
        XCTAssertFalse(fab.exists)
    }

    func testDraggingTheFoldedButtonMovesItAndDoesNotOpenIt() throws {
        addTeardownBlock { @MainActor in self.resetRuntimeChoices() }
        fold()
        let before = fab.frame
        let start = fab.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: -220, dy: -320)))
        settle()
        XCTAssertTrue(fab.exists, "a drag should not open it")
        XCTAssertFalse(app.buttons["Annotate"].exists)
        let after = fab.frame
        XCTAssertEqual(after.midX, before.midX - 220, accuracy: 4)
        XCTAssertEqual(after.midY, before.midY - 320, accuracy: 4)
        shot("13-folded-dragged")

        // Now in the left half it is held to the left: it opens rightward out of the button, chevron pointing left.
        fab.tap()
        XCTAssertTrue(app.buttons["Annotate"].waitForExistence(timeout: 3))
        settle()
        XCTAssertEqual(barLeft, after.minX, accuracy: 1, "its left edge stays put")
        XCTAssertGreaterThan(collapse.frame.minX, after.maxX)
        shot("14-open-held-left")
        fold()
        XCTAssertEqual(fab.frame.minX, after.minX, accuracy: 1, "and folds back into the same place")
    }

    /// Folded just right of the middle, the open bar is mostly left of it; it still folds back to the right, into the
    /// same place, however often it is opened and folded.
    func testFoldingAndOpeningComeBackToTheSamePlaceFromJustRightOfTheMiddle() throws {
        addTeardownBlock { @MainActor in self.resetRuntimeChoices() }
        fold()
        let middle = app.windows.firstMatch.frame.midX
        let start = fab.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: middle + 14 - fab.frame.midX, dy: -200)))
        settle()
        let circle = fab.frame
        XCTAssertGreaterThan(circle.midX, middle)
        fab.tap()
        XCTAssertTrue(app.buttons["Annotate"].waitForExistence(timeout: 3))
        settle()
        let open = (left: barLeft, right: barRight)
        // Held to the right, it opens leftward from the button's right edge; on a phone the open bar is wider than the
        // room left of there, so it is pushed in from the margin instead (12 points).
        if circle.maxX - (open.right - open.left) >= 12 {
            XCTAssertEqual(open.right, circle.maxX, accuracy: 1, "held to the right, it opens leftward")
        } else {
            XCTAssertEqual(open.left, 12, accuracy: 1, "too wide to open leftward from there: pushed in from the margin")
        }
        XCTAssertLessThan((open.left + open.right) / 2, middle, "most of it left of the middle")
        XCTAssertEqual(collapse.label, "Collapse the toolbar")
        XCTAssertEqual(collapse.identifier, "chevron.right", "and still folds to the right")
        shot("16-open-from-just-right-of-middle")
        for _ in 0..<2 {
            fold()
            XCTAssertEqual(fab.frame.minX, circle.minX, accuracy: 0.5)
            XCTAssertEqual(fab.frame.minY, circle.minY, accuracy: 0.5)
            fab.tap()
            XCTAssertTrue(app.buttons["Annotate"].waitForExistence(timeout: 3))
            settle()
            XCTAssertEqual(barLeft, open.left, accuracy: 0.5)
            XCTAssertEqual(barRight, open.right, accuracy: 0.5)
        }
    }

    /// Back to the corner, open, for the other tests, even when a test that moved the toolbar failed.
    private func resetRuntimeChoices() {
        if app.staticTexts["Notato"].exists { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap() }
        tab("Feedback")
        app.buttons["Reset runtime choices"].tap()
        tab("Shop")
    }

    func testAnnotatingFromCodeOpensTheFoldedToolbarAndFoldsItAgain() throws {
        fold()
        tab("Feedback")
        app.buttons["StartAnnotating"].tap()
        XCTAssertTrue(app.buttons["Annotate"].waitForExistence(timeout: 3), "annotating should open the bar")
        settle()
        XCTAssertFalse(fab.exists)
        shot("15-opened-for-annotating")
        app.buttons["Done"].tap()
        XCTAssertTrue(fab.waitForExistence(timeout: 3), "and fold it again after")
        settle()

        // Selecting from code too, until the note is cancelled.
        app.buttons["SelectBanner"].tap()
        XCTAssertTrue(comment.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Annotate"].exists)
        app.buttons["Cancel"].tap()
        XCTAssertTrue(fab.waitForExistence(timeout: 3))
        settle()

        // Folded and opened by hand while annotating, it is someone's choice and stays open after.
        app.buttons["StartAnnotating"].tap()
        XCTAssertTrue(collapse.waitForExistence(timeout: 3))
        settle()
        collapse.tap()
        XCTAssertTrue(fab.waitForExistence(timeout: 3))
        settle()
        fab.tap()
        XCTAssertTrue(app.buttons["Annotate"].waitForExistence(timeout: 3))
        settle()
        app.buttons["Done"].tap()
        settle()
        XCTAssertTrue(app.buttons["Annotate"].exists, "opened by hand, it stays open")
        XCTAssertFalse(fab.exists)
    }

    func testSelectingAnElementFromCode() throws {
        tab("Feedback")
        app.buttons["SelectBanner"].tap()
        XCTAssertTrue(comment.waitForExistence(timeout: 5))
        shot("10-select-from-code")
        app.buttons["Cancel"].tap()
    }
}
