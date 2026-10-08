# Notato for React Native

People tap a view in your running React Native app and write what should change, and the note reaches your coding agent (Claude Code, Codex, Cursor and others) over MCP through a Notato server. Each note has a screenshot with the view outlined and numbered, a crop of the view, its text, test id and label, the app's recent warnings, and its component: the one you wrote, the components around it, and the file and line it is in (`ProductCard` in `App › Shop › ProductList › ProductCard`, at `src/App.tsx:18:1`).

It is the same client as the Swift, Android, Flutter and .NET MAUI SDKs: the toolbar and its **⋯** menu, the three modes, threads and replies, People only and asides, revert, an offline queue, masking, and a runtime API. Variants are web-only.

React Native 0.76 and later, with the New Architecture, in Expo (Expo Go included) or a bare app.

## Set up

```bash
npm i -D notato
npx expo install @notato/react-native react-native-view-shot expo-file-system expo-sharing
npx notato        # the server, the board and MCP for your agent
```

Wrap your app in it:

```tsx
import { Notato } from "@notato/react-native"
import { expoStorage } from "@notato/react-native/expo"

export default function App() {
    return (
        <Notato project="shop" appName="Shop" storage={expoStorage} route={() => navigationRef.getCurrentRoute()?.name}>
            <Navigation />
        </Notato>
    )
}
```

A small dark toolbar appears in the corner. Drag it anywhere; it stays where you leave it, and its chevron folds it into a round button. Tap **Annotate**, tap a view, write the note, and press **Send**. A numbered pin marks it, and turns amber when the agent is on it and green when it is resolved; tap a pin for the note's card. Then ask your agent to _"watch Notato and fix what comes in"_. Everything else is in the toolbar's **⋯** sheet: pins, the notes list, settings, hiding the toolbar or turning Notato off, and the server's state, with **Retry** when it cannot be reached. React Native's developer menu has **Notato: annotate** and **Notato: show or hide the toolbar**.

**Storage.** `storage={expoStorage}` keeps notes not sent yet, test-mode notes, their screenshots and people's choices (on or off, the toolbar's place, a name) in the app's documents folder, and shares a test-mode package through the share sheet. It needs `expo-file-system` and `expo-sharing`, which work in Expo Go and in any app with Expo modules. Without it, all of that lasts until the app restarts. A bare app without Expo modules can pass its own `StorageProvider`: its `open(project)` returns a `NotatoStorage`, and both types are exported.

**Reaching the server.** The default is `http://localhost:4747`. The iOS simulator reaches it as it is. The Android emulator, and a phone plugged in over USB, reach it once the port is forwarded:

```bash
adb reverse tcp:4747 tcp:4747
```

A phone on Wi-Fi needs the server's [dev tunnel](../../README.md#phones-a-dev-tunnel): pass its URL as `server` and the device token as `token`, from your app's environment (`EXPO_PUBLIC_NOTATO_SERVER` in Expo).

## Props

| Prop                             | Default                                     |                                                                                                                                    |
| -------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `project`                        | (required)                                  | Project id on the server. Letters, digits and `. _ - @`, not only dots                                                             |
| `mode`                           | `dev`                                       | `dev`, `test` or `agent` (see below)                                                                                               |
| `server`                         | `http://localhost:4747` (none in test mode) | `null` for no server: notes stay on the device                                                                                     |
| `token`                          |                                             | A project token (`pft_…`) for a shared `notato serve`                                                                              |
| `storage`                        | in memory                                   | `expoStorage`, or your own `StorageProvider`                                                                                       |
| `route`                          | `/`                                         | The screen, or a function that says it: notes are filed under it, and its pins shown on it                                         |
| `enabled`                        | development builds (`__DEV__`)              | Whether Notato is on at launch. The app can switch it at runtime. Picking a view needs a development build either way              |
| `showToolbar`, `toolbarPosition` | `true`, `bottom-right`                      | The toolbar and the corner it starts in (`bottom-left`, `top-right`, `top-left`). Where people drag it is remembered               |
| `author`                         |                                             | The name on this person's notes. They can change it in the settings                                                                |
| `screenshots`                    | `true`                                      | A server that has screenshots off wins either way                                                                                  |
| `maskInputs`                     | on in test and agent mode                   | Cover text fields in screenshots and leave their values out of notes (password fields always are). See [What is never recorded](#what-is-never-recorded) |
| `rememberRuntimeState`           | `true`                                      | Keep runtime choices (on or off, toolbar, name, a server typed in, the toolbar's place) across launches, with `storage`            |
| `captureLogs`, `logLimit`        | `true`, `50`                                | Attach the app's recent `console.warn` and `console.error` messages                                                                |
| `appName`, `appVersion`          | `React Native app`                          | Recorded on every note                                                                                                             |
| `maxScreenshotScale`             | `2`                                         | Pixels per point screenshots are kept at. Phones are 2x to 3.5x; 2x is plenty                                                      |

In a release build `<Notato>` is your app and nothing else, unless `enabled` is `true` when it mounts (that is decided once, so the app is never mounted again because Notato came or went). Mounting `<Notato>` again with the same props, as React's StrictMode does, leaves Notato running, with the notes it had.

## At runtime: `notato`

|                                          |                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `useNotato()`                            | A hook with Notato's state: on or off, toolbar, annotating, connection, the notes, how many are not sent yet         |
| `enable()`, `disable()`, `setEnabled(on)` | On and off. A choice made here wins over `enabled` until `resetRuntimeState()`                                      |
| `showToolbar()`, `hideToolbar()`         | The toolbar. Off still lets the app drive Notato from code                                                          |
| `startAnnotating()`, `stopAnnotating()`  | The next tap selects what is under it                                                                               |
| `select(ref)`, `select("#save")`         | Select a view (a ref, or a selector) as if it had been tapped, and open the note for it                             |
| `annotate("#save", comment, options)`    | Make a note with no UI, as a person or (with `agentName`) an agent. `peopleOnly: true` keeps a person's note from the agent |
| `packageNotes({ upload })`               | Test mode: the device's notes as a bundle zip                                                                       |
| `recordRequest(entry)`                   | Add an HTTP request (`method`, `url`, `status`, `durationMs`) to the `network` context of later notes               |

```tsx
import { notato, useNotato } from "@notato/react-native"

const state = useNotato()
<Switch value={state.enabled} onValueChange={(on) => (on ? notato.enable() : notato.disable())} />
```

The example's **Feedback** card switches Notato and its toolbar, and annotates a price from code.

## What the agent gets

A view is picked the way React Native's own Element Inspector picks one, through the development build's inspector, so it is the view under your finger: the innermost one. **Parent** in the composer steps out to the view around it. The note says:

- **The view**: what kind it is (`Text`, `View`, `Image`, `TextInput`…), its text, `testID` (as the test id, when it is at most 100 letters, digits and `_ - . @ /`, which a selector can name), `accessibilityLabel`, `accessibilityRole` and `nativeID`, and a selector made of those (`ProductCard > View#pay`). Nothing of a private view's text or ids (below).
- **The component**: the innermost component of yours that rendered it, and the ones around it, outermost first. React Native's, React Navigation's and Expo's own components are left out.
- **Where it is written**: Metro maps the component stack back to your files, so the note gives the file and line of the component the view belongs to. The path is the one on your machine, where the agent works.
- **Screenshots**: the screen as the person saw it, with the view outlined and numbered, the toolbar left out and private views covered, and a crop of the view.
- **Context**: the device (the platform `react-native`, OS and version, React Native's version, the window's size and pixel ratio), the app's recent warnings and errors (`context.console`), and requests the app recorded (`context.network`).

### What is never recorded

- **Password fields** (`secureTextEntry`), always: covered in screenshots, and their value is never recorded.
- **Text fields** when `maskInputs` is on (by default in test and agent mode): covered, and their value left out. Their placeholder and label are still recorded, so a note can say which field it is.
- **Anything inside `<NotatoMask>`**: covered in screenshots, and none of its text is recorded anywhere: not as its text or label, and not in its selector. Its `testID` and `nativeID` are left out too (an app may make them of what it shows). A selector cannot find it by its text either. A private `<Text>` inside another `<Text>` has no place of its own on screen, so the `<Text>` around it is covered. A crop that would show any of it is left out.

```tsx
import { NotatoMask } from "@notato/react-native"

<NotatoMask><Text>{user.email}</Text></NotatoMask>                  // private: this and everything in it
<NotatoMask private={false}><TextInput placeholder="Search" /></NotatoMask>   // recorded even with maskInputs
```

Password fields stay masked whatever the mark, and a private mark around a `private={false}` one wins over it. `<NotatoMask>` renders its children and nothing else. It is the web SDK's `data-notato-mask`.

### Selectors

What a note's selector looks like, and what an agent passes to `notato_annotate` or `notato.annotate`:

|                        |                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `#save`                | The view's `testID`                                                                             |
| `Text`, `button`       | The view's kind (`Text`, `View`, `TextInput`), its role, or the component that rendered it; `*` for any |
| `[label="Pay now"]`    | The accessibility label, exactly                                                                |
| `:text("Add to cart")` | The text or label contains this, ignoring case                                                  |
| `:nth(2)`              | The second match, in drawing order                                                              |
| `ProductCard > …`      | Leading names are the components around it; one the app does not have (a screen's name) is ignored |

## Modes

- **dev**: notes go live to `notato dev`, pins turn amber when the agent acknowledges them and green when it resolves them, and replies arrive in the pin's card. On a resolved pin, **Ask the agent to revert** asks for the change to be undone. A note made while the server is down is kept on the device and sent when it comes back; one the server refuses for good (too large, say) is marked failed and kept, and the notes after it still go.
- **test**: notes stay on the device (with `storage`, they survive a restart). **Package and share** in the toolbar's menu makes the bundle zip `notato_import_bundle` reads, uploads it when a server is set, and opens the share sheet.
- **agent**: like dev, and the app also takes `notato_annotate` requests: `notato_annotate { target: "#add-to-basket:nth(3)", comment: "…" }` is relayed to the app, which finds the view, takes the screenshot and files the note as the agent. Requests are taken one at a time. The agent hears the note is filed only once the server has it; one kept on the device (the server could not be reached, or would not take it) is reported as not filed, with the reason.

## People only and asides

Everything people write reaches the agent: new notes and every reply. Two switches keep something between people instead:

- **People only**, for a whole note: the composer's switch (_"Keep this between people: the agent won't see it."_), and the same switch on the note's card, at any time, for anyone on the thread. Each change is recorded in the thread. A note still on the device (test mode, or not sent yet) is changed on the device, with the same entry, so a package carries the history.
- **Aside**, for one reply: under the reply field (_"Just for people: the agent won't see this reply."_). Asides show in the thread outlined and labelled **Aside**.

## Known limits

- Picking needs a development build: release builds do not have React Native's inspector. In one, the toolbar says so.
- The file and line are where the component is declared, not the line of the view inside it: React Native's component stacks give one place per component. They need the Metro server that served the bundle.
- A view is what the inspector finds under the finger, so a tap on a button's label picks the label. **Parent** selects the button; the note's component and selector say which button either way.
- Pins are placed again every 0.6 seconds by finding their views with their selectors; of several alike (a list's rows), the one nearest where the note was made. The app's tree is read again only after React has committed something; in between, only where the views are now is asked (a scroll moves them without a commit). A view scrolled out of sight takes its pin with it; one that cannot be found keeps its pin where it was, dimmed. At most 150 pins are drawn on one screen (the newest); the Notes list has every note on the screen, newest first.
- Only notes made in a React Native app get pins. A note from another platform filed under the same screen (the web's, iOS's) is in the Notes list, with its number, and no pin: its selector names something this app does not have.
- The screen is read as Notato draws, and checked twice a second besides, so moving to a screen with no pins is noticed too.
- The connection to the server is watched: the server says something at least every 15 seconds, and a stream silent for 45 is closed and opened again. A stream that has run for hours is replaced by a fresh one without a change in the connection's state.
- Notes not sent yet are written to `storage` once a burst of changes is over (after 0.3 seconds), whole, then moved over the old file, so a crash part way never leaves half a file.
- The safe areas are estimated (React Native has no API for them without react-native-safe-area-context), so on an unusual device the toolbar may start a little close to an edge. Drag it.
- There is no shake to bring the toolbar back: in a development build a shake opens React Native's developer menu, which has **Notato: show or hide the toolbar**.
- Verified in Expo Go 57 with React Native 0.86 on the iOS simulator (iPhone 17 Pro, iOS 26.5): picking, masking, both screenshots, the component and its file, the composer, the ⋯ menu, live status, replies and asides, People only, revert, annotating from code, the agent relay through `notato_annotate`, and test mode's package uploaded and shared. Not yet verified at this version on the Android emulator, on a physical device, or in a bare app.

## Development

```bash
bun install                           # at the repository root
bunx vitest run sdks/react-native     # selectors, masking, the runtime (modes, queue, relay, remounts), the client (paging, the stream's watchdog), storage, the zip, the note against the server's schema
cd sdks/react-native/example && npm install
EXPO_PUBLIC_NOTATO_SERVER=http://localhost:4799 EXPO_PUBLIC_NOTATO_MODE=test npx expo start   # the example, sending to a scratch server
```

The example is an Expo app outside the repository's Bun workspace (its own `npm install`), so Expo stays out of every other install. Its `metro.config.js` runs the SDK from `../src` and makes the SDK's imports of React, React Native and the Expo modules use the app's own copies.

The toolbar's icons are white PNGs tinted where they are drawn, made from the Android SDK's path data by `swift scripts/icons/render.swift` (macOS 14 or later), which writes them into this SDK and the Flutter one.
