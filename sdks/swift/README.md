# Notato for SwiftUI

Figma-style comments for a running iOS app. Tap an element, write a note, and it reaches your coding agent (Claude Code, Codex, Cursor, Gemini CLI, Copilot and others) over MCP with a screenshot, the Swift file and line it was written at (for views you mark), what VoiceOver would call it, and the app's recent log. It is the iOS client of the same Notato server the web, Android, .NET MAUI, React Native and Flutter SDKs use: the notes, the board, the MCP tools and the status loop (open, acknowledged, resolved, revert) are the same.

SwiftUI and UIKit apps on iOS 17 and later (and Mac Catalyst), as a Swift package with no dependencies.

## Quick start

```bash
npx notato dev           # the server your agent reads, on http://localhost:4747
```

Add the package: in Xcode, File › Add Package Dependencies… with `https://github.com/notatorg/notato`, or in a `Package.swift`:

```swift
.package(url: "https://github.com/notatorg/notato", from: "0.1.0"),
```

with `.product(name: "Notato", package: "notato")` in your target's dependencies. Then start it as early as the app starts:

```swift
import SwiftUI
import Notato

@main
struct ShopApp: App {
    init() {
        #if DEBUG
        Notato.start(NotatoConfiguration(project: "shop-ios"))
        #endif
    }

    var body: some Scene {
        WindowGroup { RootView() }
    }
}
```

Leaving `Notato.start` out of a build (as `#if DEBUG` does here) ships nothing of Notato in it. Run the app: a small dark toolbar appears in the corner. Tap **Annotate**, tap what you want to comment on, write a note, press **Send**. Ask your agent to _"watch Notato and fix what comes in"_. Everything people write reaches the agent, unless they keep it between people (see [People only and asides](#people-only-and-asides)).

The app has to be allowed plain `http` to your machine: in Info.plist, `NSAppTransportSecurity` → `NSAllowsLocalNetworking` = `YES`. The simulator shares the Mac's network, so `localhost` works there as it is.

### Where it is in the code

Mark the views you care about, and notes about them (or anything inside them) say exactly where they are written:

```swift
struct ProductList: View {
    var body: some View {
        List { … }
            .notatoScreen()                 // a screen: its name is the note's route
    }
}

struct ProductCard: View {
    var body: some View {
        HStack { … }
            .notato("ProductCard")          // ProductList.swift:52, filled in by the compiler
    }
}
```

The file and line come from `#filePath` and `#line`, so there is nothing to keep in step. Paths are given from the repository root (found by looking for `.git` above the source file, which the simulator and a Mac can read; set `sourceRoot` for a device). `.notatoMask()` makes a view private (see [What is never recorded](#what-is-never-recorded)); `.notatoIgnore()` makes the picker look through it.

## Configuration

In code, or from the app's Info.plist (a `Notato` dictionary) or a JSON file, with `NOTATO_*` environment variables over either (an Xcode scheme, or `SIMCTL_CHILD_NOTATO_SERVER=…` with `xcrun simctl launch`):

```swift
Notato.start()   // reads Info.plist and the environment
```

```xml
<key>Notato</key>
<dict>
    <key>Project</key><string>shop-ios</string>
    <key>Mode</key><string>dev</string>
    <key>Server</key><string>http://localhost:4747</string>
</dict>
```

| Key (`NotatoConfiguration`)      | Default                                     |                                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Project` (`project`)            | (required)                                  | Project id on the server. Letters, digits and `. _ - @`, not only dots                                                                                                                          |
| `Mode` (`mode`)                  | `dev`                                       | `dev`, `test` or `agent` (see below)                                                                                                                                                            |
| `Server` (`server`)              | `http://localhost:4747` (none in test mode) | An empty string means no server                                                                                                                                                                 |
| `Token` (`token`)                |                                             | A project token (`notato_…`) for a shared `notato serve`. Sent only to the configured server (the same scheme, host and port); a server typed into Settings gets no token                       |
| `Enabled` (`enabled`)            | `true`                                      | Whether Notato is on at launch. The app can switch it at runtime                                                                                                                                |
| `ShowToolbar`, `ToolbarPosition` | `true`, `bottomTrailing`                    | The floating toolbar. People can drag it, and fold it into one round button with its chevron (it opens again while they annotate); where they leave it, and whether it is folded, is remembered |
| `ShakeToToggle`                  | `true`                                      | Shaking the device shows or hides the toolbar (real devices)                                                                                                                                    |
| `Author`                         |                                             | The name on this person's notes. They can change it in the toolbar's settings                                                                                                                   |
| `Screenshots`                    | `true`                                      | A server that has screenshots off wins either way                                                                                                                                               |
| `MaskInputs`                     | on in test and agent mode                   | Cover text fields in screenshots and leave what is typed in them out of notes. Secure fields always are; `.notatoMask(false)` opts a field out                                                  |
| `RememberRuntimeState`           | `true`                                      | Keep runtime choices (on or off, toolbar, name, a server typed in) across launches                                                                                                              |
| `ReadAccessibility`              | `true`                                      | Read the accessibility tree to describe what was tapped (see below)                                                                                                                             |
| `CaptureLogs`, `LogLimit`        | `true`, `50`                                | Attach the app's own recent log messages (`Logger`, `os_log`)                                                                                                                                   |
| `SourceRoot`                     | found from `.git`                           | The folder source paths are given from                                                                                                                                                          |
| `AppName`, `AppVersion`          | from the bundle                             | Recorded on every note                                                                                                                                                                          |
| `MaxScreenshotScale`             | `2`                                         | Phones are 3x; 2x is plenty to read and half the size                                                                                                                                           |

## At runtime: `Notato.shared`

`Notato` is `@Observable`, so a view can show and change its state directly:

```swift
struct DeveloperSettings: View {
    @State private var notato = Notato.shared

    var body: some View {
        Toggle("Notato", isOn: Binding(get: { notato.isEnabled }, set: { $0 ? notato.enable() : notato.disable() }))
    }
}
```

|                                                                 |                                                                                                                                                                               |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enable()`, `disable()`, `isEnabled`                            | On and off. A choice made here wins over `enabled` in the configuration until `resetRuntimeState()`                                                                           |
| `showToolbar()`, `hideToolbar()`, `isToolbarVisible`            | The toolbar. Off still lets the app drive Notato from code                                                                                                                    |
| `startAnnotating()`, `stopAnnotating()`                         | The next tap selects what is under it                                                                                                                                         |
| `select("#AddToCart")`                                          | Select an element as if it had been tapped, and open the note for it                                                                                                          |
| `annotate("#AddToCart", comment:, options:)`                    | Make a note with no UI, as a person or (with `agentName`) an agent. Throws if the server refuses it. `AnnotateOptions(peopleOnly: true)` keeps a person's note from the agent |
| `annotations`, `pendingCount`, `connection`, `connectionDetail` | What Notato knows, for a status line or a badge                                                                                                                               |
| `packageNotes(upload:)`                                         | Test mode: the device's notes as a bundle zip, uploaded when a server is set                                                                                                  |

The sample's **Feedback** tab does each of these.

## What a note carries

The same schema as every Notato SDK (`environment.platform` is `ios`):

- **Which element**, from the accessibility tree: its role (`button`, `heading`, `text`, `textbox`, `switch`, …), its label, its accessibility identifier (as the test id), its value, and its frame. SwiftUI puts every control there with no work from the app; `.accessibilityIdentifier("AddToCart")` makes the steadiest selector.
- **Where it is in the code**: the marked view it is, or the nearest one around it (`"nearest": true`), as `swift/App/ProductList.swift:52:17`; the component path (`ProductList › ProductCard`); the screen and its file.
- **What was on screen**: the window with the element outlined and the pin's number drawn on, and a crop around it. Notato's own window is never in them.
- **Context** (`context.ios`): the screen and the screens showing, the view controllers, the device, iOS version, idiom, orientation, colour scheme, text size and locale.
- **The app's log** (`context.console`, the web SDK's shape): the app's own `Logger` / `os_log` messages since launch (from info up), read back from the unified log. Apple's frameworks are left out.
- **Network** (`context.network`, the latest 50 requests) when the app adds `NotatoNetworkRecorder` to a session's `protocolClasses` (see below). URLs are recorded without their query strings. Each request is made again through Notato's own session, which hands every part back to the app's session as it comes: the response, the body a piece at a time, redirects (which the app's session and its delegate follow or not, as they would without Notato) and authentication challenges, server trust included, which the app's delegate answers (so certificate pinning still applies). What a protocol cannot carry over is the app's session configuration: Notato's session has the system's defaults (the shared cookie store, cache and credentials) with each request's own headers, timeout and cache policy. Upload tasks (`upload(for:from:)`, whose body a protocol cannot read), streams and web sockets are not recorded and go to the network untouched.

To record a session's requests, put the recorder in front of its protocols when the session is made:

```swift
let configuration = URLSessionConfiguration.default
#if DEBUG
configuration.protocolClasses = [NotatoNetworkRecorder.self] + (configuration.protocolClasses ?? [])
#endif
let session = URLSession(configuration: configuration)
```

### What is never recorded

- **Secure fields** (`SecureField`), always: covered in every screenshot, and what is in them is never read.
- **Text fields**, with `MaskInputs` (on in test and agent mode): covered in screenshots, and what is typed in them left out of notes; the field's label still says which field it is. `.notatoMask(false)` on a field (or a view holding fields) opts it out, a search box say, so it is shown and recorded.
- **Anything marked `.notatoMask()`**, a customer's name, an address, a card number: covered in every screenshot, and neither its text nor the text of anything inside it goes into a note, whether as the element's text, its name, its selector, part of the label of a button around it, or a match for an agent's `:text()` selector. The note still says which element it is (its role, accessibility identifier, frame and where it is written), and its selector falls back to `#identifier` or the role and `:nth`. A private view wins over a field inside it that opts out.

```swift
TextField("Card number", text: $card).notatoMask()       // private in every mode
TextField("Search", text: $query).notatoMask(false)      // recorded even when MaskInputs is on
```

### Reading the accessibility tree

iOS builds an app's accessibility tree only when an assistive technology or a UI test asks for it. To read it, Notato does what UI-testing tools do: it loads UIKit's and SwiftUI's accessibility bundles into the app and switches on iOS's application accessibility. That setting belongs to the system, not the app, so Notato remembers what it was and puts it back when it is switched off or the app goes to the background (and on the next launch, if the app was killed first). It uses private system calls, which is fine for a debug tool and one more reason to keep Notato out of release builds. With `ReadAccessibility` off, Notato leaves the system alone and knows elements only through `.notato()` marks.

### Selectors

What a note's selector looks like, and what an agent passes to `notato_annotate` or `annotate(_:)`:

|                        |                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `#AddToCart`           | The accessibility identifier, or the name of a `.notato("AddToCart")` mark                                                      |
| `button`               | The role (`*` for any)                                                                                                          |
| `:text("Add to cart")` | The label or value contains this, ignoring case                                                                                 |
| `:nth(2)`              | The second match on screen, in reading order                                                                                    |
| `ProductDetail …`      | A leading screen name, for people; ignored when matching. A name that is not one capitalised word is quoted: `"My cart" button` |

## People only and asides

Everything people write reaches the agent: every note, and every reply on it. Two switches keep something between people:

- **People only**, on a note: the note and its whole thread are between people, and the agent never gets them. Switch it on in the note before sending it (_"Keep this between people: the agent won't see it."_), or turn it on or off at any time on the note's card, which shows a **People only** badge while it is on. Each change is recorded in the thread as an automatic entry (_"Made this people only: the agent won't see it."_, _"Shared this with the agent."_); turning it off hands the note to the agent. A note not sent yet (the server is down, or test mode) is changed on the device, with the same entry in its thread, so it is sent or packaged that way.
- **Aside**, on a reply: that one reply is for the people on the thread and kept from the agent (_"Just for people: the agent won't see this reply."_). Switch it on in the reply box before sending; it is off again for the next reply. An aside is marked in the thread. It is offered on a People only note too: an aside stays kept from the agent if the note is shared with it later.

## Modes

- **dev**: notes go live to `notato dev`, pins turn amber when the agent acknowledges them and green when it resolves them, and replies arrive in the pin's card. On a resolved pin, **Ask the agent to revert** asks for the change to be undone. A note made while the server is down is kept on the device and sent when it comes back. So is one the server will not take yet (a project a shared `notato serve` does not have, a token that may not write): the server's reason is shown, and it is sent again on the next connection or launch. A note the server refuses for good (it is malformed or too large) is marked failed with the server's reason and kept on the device to read or delete; the notes after it are still sent. On each connection the notes waiting go first, then the project's notes are read again (without their context and steps, which the overlay never shows). A note not sent yet keeps its screenshots in files on the device, not in memory.
- **test**: notes stay on the device (they survive a restart). **Package and share** in the toolbar's menu makes the bundle zip `notato_import_bundle` reads, opens the share sheet, and uploads it when a server is set.
- **agent**: like dev, and the app also takes `notato_annotate` requests: `notato_annotate { target: "button:text(\"Add to cart\")", comment: "…" }` is relayed to the app, which finds the element, takes the screenshot and files the note as the agent.

## The toolbar

The bar holds a grip (drag it, or the bar anywhere, to move it), **Annotate** with the count of notes on this screen, **⋯**, and a chevron that folds it into a round button showing the Notato potato, with the count on its corner. Everything else is in the **⋯** sheet: Annotate, hide or show pins, the notes list, Package and share and Clear notes (test mode), Settings, Hide toolbar and Turn Notato off. **Notes** lists the newest 50 on this screen in pin order, and says how many older ones are here and how many are on other screens (the board has them all). A note's card shows the last 4 entries of its thread, with how many earlier ones are on the board. The **⋯** sheet's header shows the mode, the server and whether it is connected; when the server cannot be reached a banner says so, and **Retry** tries again at once instead of waiting for the next attempt. A dot on **⋯** (or on the round button) shows only while connecting or offline. The sheets follow the app's light or dark appearance; the bar is always dark.

## Pins

A pin is drawn for each note on the screen at its element (found again as the screen changes, or where the note was made, faded, when it is not there). Only notes made on iOS are pinned: a web or Android note whose route has the same name is about another app's screen, and is in the Notes list but not on this one. A screen shows the pins of its newest 150 notes at most, as the React Native and Flutter SDKs do; the Notes list and the board have every note.

## How the overlay works

Notato draws its UI in SwiftUI, in a window of its own above the app's window in the same scene. Touches that are not on Notato's controls fall through to the app; while annotating, or while one of its sheets is open, Notato's window takes them. Being a separate window keeps it above sheets, full-screen covers, alerts and popovers, and out of the screenshots, which are taken of the app's window only. While a note is being written Notato's window has the keyboard, and gives it back after.

## Known limits

- An element is what VoiceOver sees: a `NavigationLink` or a `Button` that holds several texts is one element with all of them in its label, so tapping the price inside a card selects the card. Mark the view (`.notato()`) or give it an accessibility identifier to tell such places apart; **Parent** in the note widens to the marked view around.
- Without marks, a note has the screen's file at best. Swift has no runtime record of where an unmarked view was written.
- An accessibility element is not a view, so what `.notatoMask()` hides is told from frames: an element that lies mostly inside a private view, or holds one (a button whose label reads it out). Something that only partly overlaps a private view keeps its text, so mark the whole of what is private.
- iPad multi-window works per scene (each window's overlay reads only its own window's marks) but has had less testing. Shaking does not reach the simulator (use `Notato.shared.showToolbar()`).
- Verified on the iPhone 17 Pro simulator (iOS 26.5) against `notato dev`, with XCUITest driving real taps (`Example/ShopSampleUITests`). Not yet run: a physical device, Mac Catalyst, a `notato serve` server with a token.

## Development

The package's manifest is `Package.swift` at the repository root (SwiftPM finds a package only there), so `swift` and `xcodebuild` run from the root:

```bash
swift test                                       # model, client, selectors, privacy, zip, and the schema contract (needs bun)
xcodebuild test -scheme Notato -destination 'platform=iOS Simulator,name=iPhone 17 Pro'   # the same, and what needs UIKit
open sdks/swift/Example/ShopSample.xcodeproj     # the sample: a shop with a list, a detail page, a checkout sheet, a Feedback tab
npx notato dev --port 4799 --dir "$(mktemp -d)"  # a scratch server for the UI tests (in another terminal)
TEST_RUNNER_NOTATO_SERVER=http://localhost:4799 xcodebuild test -project sdks/swift/Example/ShopSample.xcodeproj \
  -scheme ShopSample -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
NOTATO_TEST_SERVER=http://localhost:4799 swift test   # also runs the tests that need a real server (skipped without it)
```

The UI tests post notes, so they talk to a scratch server on 4799 unless told otherwise, never to 4747, where a real server (and its webhooks) may be running.

The package's sources, in `Sources/Notato`:

|                         |                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `Notato.swift`          | The public `Notato` object: its state, on and off, the notes it knows and the queue that sends them    |
| `Notato+Server.swift`   | The connection to the server: its event stream, and what each event does                               |
| `Notato+Annotate.swift` | `annotate` and `select` from code                                                                      |
| `Configuration.swift`   | `NotatoConfiguration`, from code, Info.plist, JSON or the environment                                  |
| `Model/`                | The schema's types (`Annotation` and the rest), and a note as Notato keeps it (`NoteRecord`)           |
| `Net/`                  | The server's HTTP API and its event stream                                                             |
| `Inspection/`           | The accessibility tree, marks (`.notato()`), selectors, privacy, and the identity a note carries       |
| `Capture/`              | Screenshots, and the device's context                                                                  |
| `Runtime/`              | What is kept on the device (notes, runtime choices), the bundle zip, and the log and network recorders |
| `Overlay/`              | The overlay window, its toolbar, pins and model; `Overlay/Sheets/` holds the note card and the sheets  |

`swift test` runs on the Mac (the overlay is compiled only for UIKit); on the simulator the package's tests also cover marks per window and the device context, and skip the contract checks (no processes there). The contract tests run the server's own Zod schema over the JSON this package writes (`scripts/validate.ts`), and are skipped when `bun` is not installed.
