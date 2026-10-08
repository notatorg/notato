# Notato for Flutter

People tap a widget in your running Flutter app and write what should change, and the note reaches your coding agent (Claude Code, Codex, Cursor and others) over MCP through a Notato server. Each note has a screenshot with the widget outlined and numbered, a crop of it, its text and key, the app's recent errors, and exactly where it is written: the widget you wrote (`Text('£${product.price}')`), the file, line and column (`lib/main.dart:95:11`), and your widgets around it (`SpudShop › ShopScreen › ProductCard`).

It is the same client as the Swift, Android and .NET MAUI SDKs: the toolbar and its **⋯** menu, the three modes, threads and replies, People only and asides, revert, an offline queue, masking, and a runtime API. Variants are web-only.

Flutter 3.38.1 and later, on iOS, Android and macOS. On the web, notes are kept in memory and a package cannot be shared, only uploaded.

## Set up

```bash
flutter pub add notato
npx notato               # the server, the board and MCP for your agent
```

Wrap your app in it, in `main.dart`:

```dart
import 'package:notato/notato.dart';

void main() {
  runApp(const Notato(project: 'shop', appName: 'Shop', child: MyApp()));
}
```

And let it know the screens, so notes are filed under the route they were made on (a dialog, or a page pushed without a name, keeps the name of the screen under it):

```dart
MaterialApp(navigatorObservers: [Notato.navigatorObserver], ...)
```

A small dark toolbar appears in the corner. Drag it anywhere; it stays where you leave it, and its chevron folds it into a round button. Tap **Annotate**, tap a widget, write the note, and press **Send**. A numbered pin marks it, and turns amber when the agent is on it and green when it is resolved; tap a pin for the note's card. Then ask your agent to _"watch Notato and fix what comes in"_. Everything else is in the toolbar's **⋯** sheet: pins, the notes list, settings, hiding the toolbar or turning Notato off, and the server's state, with **Retry** when it cannot be reached.

Notes not sent yet, test-mode notes, their screenshots and people's choices (on or off, the toolbar's place, a name) are kept in the app's support folder (`path_provider`), so they survive a restart. A package is shared through the share sheet (`share_plus`).

**Reaching the server.** The default is `http://localhost:4747`. The iOS simulator and desktop apps reach it as it is. The Android emulator, and a phone plugged in over USB, reach it once the port is forwarded:

```bash
adb reverse tcp:4747 tcp:4747
```

A phone on Wi-Fi needs the server's [dev tunnel](../../README.md#phones-a-dev-tunnel): pass its URL as `server` and the device token as `token`, from the build (`--dart-define=NOTATO_SERVER=…`). A sandboxed macOS app needs the `com.apple.security.network.client` entitlement in its debug profile, as the example has.

## Options

| Option                           | Default                                      |                                                                                                                   |
| -------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `project`                        | (required)                                   | Project id on the server. Letters, digits and `. _ - @`, not only dots                                            |
| `mode`                           | `NotatoMode.dev`                             | `dev`, `test` or `agent` (see below)                                                                              |
| `server`                         | `http://localhost:4747` (none in test mode)  | `''` for no server: notes stay on the device                                                                      |
| `token`                          |                                              | A project token (`notato_…`) for a shared `notato serve`                                                          |
| `route`                          | the top named route `navigatorObserver` sees | A function that says the screen: notes are filed under it, and its pins shown on it                               |
| `enabled`                        | debug builds                                 | Whether Notato is on at launch. The app can switch it at runtime. Picking a widget needs a debug build either way |
| `showToolbar`, `toolbarPosition` | `true`, `bottomRight`                        | The toolbar and the corner it starts in. Where people drag it is remembered                                       |
| `author`                         |                                              | The name on this person's notes. They can change it in the settings                                               |
| `screenshots`                    | `true`                                       | A server that has screenshots off wins either way                                                                 |
| `maskInputs`                     | on in test and agent mode                    | Cover text fields in screenshots and leave their values out of notes (password fields always are)                 |
| `rememberRuntimeState`           | `true`                                       | Keep runtime choices across launches                                                                              |
| `captureLogs`, `logLimit`        | `true`, `50`                                 | Attach the app's recent errors (`FlutterError`, uncaught ones) and `debugPrint` messages                          |
| `appName`, `appVersion`          | `Flutter app`                                | Recorded on every note                                                                                            |
| `maxScreenshotScale`             | `2`                                          | Pixels per point screenshots are kept at. Phones are 2x to 3.5x; 2x is plenty                                     |
| `storage`                        | the app's support folder                     | Where notes and choices are kept: `(_) async => MemoryStorage()` keeps them for this run only                     |

In a release build `Notato` is your app and nothing else, unless `enabled` is `true` when it mounts (that is decided once, so the app is never built again from scratch because Notato came or went). A `Notato` that takes the place of another (a parent rebuilt it with a new key) leaves Notato running.

## At runtime: `notato`

|                                          |                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `notato` (a `Listenable`)                | Listen to it for its state: `isEnabled`, `isToolbarVisible`, `isAnnotating`, `mode`, `connection`, `agents`, `notes`, `pendingCount` |
| `enable()`, `disable()`, `setEnabled(…)` | On and off. A choice made here wins over `enabled` until `resetRuntimeState()`                                                       |
| `showToolbar()`, `hideToolbar()`         | The toolbar. Off still lets the app drive Notato from code                                                                           |
| `startAnnotating()`, `stopAnnotating()`  | The next tap selects what is under it                                                                                                |
| `select(key)`, `select('#save')`         | Select a widget (a `GlobalKey`, an `Element`, or a selector) as if it had been tapped, and open the note for it                      |
| `annotate('#save', comment, …)`          | Make a note with no UI, as a person or (with `agentName`) an agent. `peopleOnly: true` keeps a person's note from the agent          |
| `packageNotes(upload: …)`                | Test mode: the device's notes as a bundle zip                                                                                        |
| `recordRequest(…)`                       | Add an HTTP request to the `network` context of later notes                                                                          |

```dart
ListenableBuilder(
  listenable: notato,
  builder: (context, _) => Switch(value: notato.isEnabled, onChanged: (on) => notato.setEnabled(on)),
)
```

The example's **Feedback** card switches Notato and its toolbar, and makes a note from code.

## What the agent gets

A tap hit-tests your app's render tree, as Flutter's own widget inspector does, and follows the render object it lands on back to the widgets that made it. **Parent** in the composer steps out to the widget around it. The note says:

- **The widget**: the nearest one written in your code (the `Text` you wrote, not the `RichText` Flutter builds inside it), its type, text, key (as the test id: a `ValueKey` of a string, a number or an enum, at most 100 letters, digits and `_ - . @ /`, which a selector can name), `Semantics` identifier and label, `Tooltip` message, and whether it is a button, a field or a switch. Nothing of a private widget's text or key (below).
- **Where it is written**: the file, line and column of that widget, from Flutter's widget creation tracking, which debug builds have by default. The path is the one on your machine, where the agent works.
- **The widgets around it**: your own widget classes, outermost first. Flutter's (`Card`, `Padding`) and builders that only hand on your widgets (`Builder`, `StreamBuilder`, providers) are left out.
- **A selector** made of those: `ProductCard > FilledButton#add-to-basket > Text`.
- **Screenshots**: the screen as the person saw it, with the widget outlined and numbered, the toolbar left out and private widgets covered, and a crop of the widget.
- **Context**: the platform (`flutter`), OS and version, Dart's version, the window's size and pixel ratio, the app's recent errors (`context.console`), and requests the app recorded (`context.network`).

### What is never recorded

- **Password fields** (`obscureText`), always: covered in screenshots, and their value is never recorded.
- **Text fields** when `maskInputs` is on (by default in test and agent mode): covered, and their value left out. Their hint is still recorded, so a note can say which field it is.
- **Anything inside `NotatoMask`**: covered in screenshots, and none of its text is recorded anywhere: not as its text or label, not in the text of a widget around it, and not in its selector. Its key is left out too (an app may key a widget with what it shows: `ValueKey(email)`). A selector cannot find it by its text or its key either.

```dart
NotatoMask(child: Text(user.email))                                         // private: this and everything in it
NotatoMask(private: false, child: TextField(decoration: InputDecoration(hintText: 'Search')))   // recorded even with maskInputs
```

Password fields stay masked whatever the mark, and a private mark around a `private: false` one wins over it. `NotatoMask` paints its child and nothing else. It is the web SDK's `data-notato-mask`.

### Selectors

What a note's selector looks like, and what an agent passes to `notato_annotate` or `notato.annotate`:

|                        |                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `#save`                | The widget's key (`ValueKey('save')`, `ValueKey(42)`, `ValueKey(Tab.home)`), or its `Semantics` identifier |
| `Text`, `button`       | The widget's type, its role (`button`, `textbox`, `switch`, `img`…), or your widget class; `*` for any     |
| `[label="Pay now"]`    | The semantics label, exactly                                                                               |
| `:text("Add to cart")` | The text or label contains this, ignoring case                                                             |
| `:nth(2)`              | The second match, in painting order                                                                        |
| `ProductCard > …`      | Leading names are your widgets around it; one the app does not have (a screen's name) is ignored           |

## Modes

- **dev**: notes go live to `notato dev`, pins turn amber when the agent acknowledges them and green when it resolves them, and replies arrive in the pin's card. On a resolved pin, **Ask the agent to revert** asks for the change to be undone. A note made while the server is down is kept on the device and sent when it comes back; one the server refuses for good (too large, say) is marked failed and kept, and the notes after it still go.
- **test**: notes stay on the device, and survive a restart. **Package and share** in the toolbar's menu makes the bundle zip `notato_import_bundle` reads, uploads it when a server is set, and opens the share sheet.
- **agent**: like dev, and the app also takes `notato_annotate` requests: `notato_annotate { target: "ProductCard > #add-to-basket:nth(2)", comment: "…" }` is relayed to the app, which finds the widget, takes the screenshot and files the note as the agent. Requests are taken one at a time. The agent hears the note is filed only once the server has it; one kept on the device (the server could not be reached, or would not take it) is reported as not filed, with the reason.

## People only and asides

Everything people write reaches the agent: new notes and every reply. Two switches keep something between people instead:

- **People only**, for a whole note: the composer's switch (_"Keep this between people: the agent won't see it."_), and the same switch on the note's card, at any time, for anyone on the thread. Each change is recorded in the thread. A note still on the device is changed on the device, with the same entry, so a package carries the history.
- **Aside**, for one reply: under the reply field (_"Just for people: the agent won't see this reply."_). Asides show in the thread outlined and labelled **Aside**.

## Known limits

- Picking needs a debug build: release and profile builds do not record where widgets come from. In one, the toolbar says so.
- A widget is what the hit test finds under the finger, so a tap on a button's label picks the label. **Parent** selects the button; the note's selector and component say which button either way.
- Pins are placed again twice a second by finding their widgets with their selectors; of several alike (a list's rows), the one nearest where the note was made. An app at rest draws no frames, and its pins are not looked for again until it does. A widget scrolled out of sight takes its pin with it; one that cannot be found keeps its pin where it was, dimmed. At most 150 pins are drawn on one screen (the newest); the Notes list has every note on the screen, newest first.
- Only notes made in a Flutter app get pins. A note from another platform filed under the same screen (the web's, iOS's) is in the Notes list, with its number, and no pin: its selector names something this app does not have.
- The screen is read as Notato draws, and checked twice a second besides, so moving to a screen with no pins is noticed too, whether `route` or `navigatorObserver` says it.
- The connection to the server is watched: the server says something at least every 15 seconds, and a stream silent for 45 is closed and opened again. Every request has a time limit on all of it, the wait for the answer to start included.
- Notes not sent yet and people's choices are written to the support folder once a burst of changes is over (after 0.3 seconds), off the UI thread, whole, then moved over the old file, so a crash part way never leaves half a file.
- There is no shake to bring the toolbar back (it would need a sensor plugin): the app brings it back with `notato.showToolbar()`.
- Platform views (a map, a web view) are one widget, with nothing inside them.
- Verified on the iOS simulator (iPhone 17 Pro, iOS 26.5) with Flutter 3.47: picking, Parent, masking, both screenshots, the widget's file and line, the composer, the ⋯ menu, live status and the agent's replies, People only, the agent relay through `notato_annotate`, annotating from code, and test mode's package uploaded and shared. Not yet run on Android, a physical device, macOS or the web.

## Development

```bash
flutter test                         # selectors, masking, the runtime (modes, queue, relay, remounts, packages), the client (paging, time limits, the stream's watchdog), storage, the note against the server's schema (needs bun)
cd example && flutter run --dart-define=NOTATO_SERVER=http://localhost:4799 --dart-define=NOTATO_MODE=test   # the example, sending to a scratch server
```

The contract tests run the server's own Zod schema over the JSON this package writes (`scripts/validate.ts`), and are skipped when `bun` is not installed. The toolbar's icons are white PNGs tinted where they are drawn, made by `swift scripts/icons/render.swift` at the repository's root.
