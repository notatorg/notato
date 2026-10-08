# Notato for Android

Figma-style comments for a running Android app. Tap an element, write a note, and it reaches your coding agent (Claude Code, Codex, Cursor, Gemini CLI, Copilot and others) over MCP with a screenshot, the file and line it was written at, what TalkBack would call it, and the app's recent warnings from logcat. It is the native Android client of the same Notato server the web, .NET MAUI and SwiftUI SDKs use: the notes, the board, the MCP tools and the status loop (open, acknowledged, resolved, revert) are the same.

Android 7 (API 24) and later, for apps built with Views, Jetpack Compose, or both. Two artifacts:

- `dev.notato:notato-android`: the overlay, the client and View inspection. Kotlin, no UI dependencies beyond AndroidX core.
- `dev.notato:notato-compose`: Compose support. With it on the classpath, Notato reads composables through their semantics and finds where each is written from Compose's inspection data, as Android Studio's Layout Inspector does.

## Quick start

```bash
npx notato dev                      # the server your agent reads, on http://localhost:4747
adb reverse tcp:4747 tcp:4747        # makes it localhost on the emulator or a USB device too
```

Add the artifacts to debug builds only, so release builds ship nothing of Notato. Until they are published, `./gradlew publishToMavenLocal` in this folder puts them in `~/.m2` (add `mavenLocal()` to the app's repositories):

```kotlin
dependencies {
    debugImplementation("dev.notato:notato-compose:0.1.0")   // or notato-android for a Views-only app
}
```

Then start it from the manifest, with no code at all, in `src/debug/AndroidManifest.xml` (the debug build's manifest, merged over the main one):

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application>
        <meta-data android:name="notato.project" android:value="shop-android" />
    </application>
</manifest>
```

Every setting has a `notato.<key>` (see [Configuration](#configuration)). That is all a debug-only setup needs: code in `src/main` that names `Notato` would not compile in a release build, which does not have it.

To start it from code instead (to pick settings at runtime), do it in an `Application` subclass in `src/debug`, and name it in `src/debug/AndroidManifest.xml`:

```kotlin
// src/debug/java/com/example/shop/DebugShopApp.kt
class DebugShopApp : ShopApp() {        // ShopApp made `open`; or Application(), if the app has none of its own
    override fun onCreate() {
        super.onCreate()
        Notato.start(this, NotatoConfig(project = "shop-android"))
    }
}
```

```xml
<!-- src/debug/AndroidManifest.xml. tools:replace is needed only when the main manifest names an Application of its own. -->
<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools">
    <application android:name=".DebugShopApp" tools:replace="android:name" />
</manifest>
```

Code in `src/main` that marks what is private (`Notato.mask`, `Modifier.notatoMask`) goes through a small function of the app's own, with the real one in `src/debug` and one that does nothing in `src/release`. The sample does exactly that (`sample/src/debug/…/NotatoHooks.kt` and `sample/src/release/…/NotatoHooks.kt`), and its release build has no Notato in it. An app that wants Notato's API in every build can use `implementation` instead; it does nothing until it is started.

Run the debug build: a small dark toolbar appears in the corner (drag it anywhere; it stays where you leave it, and its chevron folds it into one round button that remembers being folded). Tap **Annotate**, tap what you want to comment on, write a note, press **Send**. Ask your agent to _"watch Notato and fix what comes in"_: everything people write reaches it, unless they keep it between themselves (see [People only and asides](#people-only-and-asides)). Everything else is in the toolbar's **⋯** sheet: pins, the notes list, settings, hiding the toolbar or turning Notato off, and the server's state, with **Retry** when it cannot be reached.

The app has to be allowed plain `http` to the server. A debug `network_security_config` that permits cleartext to `localhost` is enough (see `sample/src/main/res/xml/network_security_config.xml`).

### Where it is in the code

Nothing to mark:

- **Compose**: the file and line of the call that made the element (`ShopScreens.kt:95`, the `Text(product.price)` in `ProductRow`), the composable it is (`Text`, `Button`), the composables around it written in the app (`ShopTheme › SampleRoot › ShopScreen › ProductRow`), and the screen (the innermost one named `…Screen`, `…Page`, `…Route`, `…Dialog` or `…Sheet`). This joins lazy lists' items and dialogs to the screens they are on. Compose records the line but not the column, so the column is always 1.
- **Views**: the resource id (`#save`), the layout file it was inflated from (`res/layout/fragment_account.xml`, Android 10 and later), the Fragment and Activity it is in, and the views around it.

## Configuration

In code (`NotatoConfig`), or as `<meta-data android:name="notato.<key>">` in the manifest, with `debug.notato.<key>` system properties over either, so a build can be pointed elsewhere without rebuilding it (`adb shell setprop debug.notato.server http://localhost:4790`, then restart the app):

| Key                              | Default                                     |                                                                                                                                                          |
| -------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project`                        | (required)                                  | Project id on the server. Letters, digits and `. _ - @`, not only dots                                                                                   |
| `mode`                           | `dev`                                       | `dev`, `test` or `agent` (see below)                                                                                                                     |
| `server`                         | `http://localhost:4747` (none in test mode) | An empty value (`none` as a system property) means no server                                                                                             |
| `token`                          |                                             | A project token (`pft_…`) for a shared `notato serve`. Sent only to the configured server (its scheme, host and port), never to one typed into Settings  |
| `enabled`                        | `true`                                      | Whether Notato is on at launch. The app can switch it at runtime                                                                                         |
| `showToolbar`, `toolbarPosition` | `true`, `BOTTOM_END`                        | The floating toolbar and the corner it starts in. People can drag it; where they leave it is remembered                                                  |
| `shakeToToggle`                  | `true`                                      | Shaking the device shows or hides the toolbar (listened for only while the app is in the foreground)                                                     |
| `author`                         |                                             | The name on this person's notes. They can change it in the toolbar's settings                                                                            |
| `screenshots`                    | `true`                                      | A server that has screenshots off wins either way                                                                                                        |
| `maskInputs`                     | on in test and agent mode                   | Cover text fields in screenshots and leave their values out of notes (password fields always are). See [What is never recorded](#what-is-never-recorded) |
| `rememberRuntimeState`           | `true`                                      | Keep runtime choices (on or off, toolbar, name, a server typed in, the toolbar's place) across launches                                                  |
| `captureLogs`, `logLimit`        | `true`, `50`                                | Attach the app's own warnings and errors from logcat                                                                                                     |
| `composeSourceInfo`              | `true`                                      | Turn on Compose's inspection data (file and line for composables)                                                                                        |
| `appName`, `appVersion`          | the app's label and version                 | Recorded on every note                                                                                                                                   |
| `maxScreenshotScale`             | `2`                                         | Pixels per dp screenshots are kept at. Phones are 2.6x to 3.5x; 2x is plenty                                                                             |

## At runtime: `Notato`

|                                          |                                                                                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Notato.state`                           | A `StateFlow<NotatoState>`: on or off, toolbar, annotating, connection, notes, how many are not sent yet. Notes read from the server's list come without their `context` and `steps` (see [Pins](#pins))      |
| `enable()`, `disable()`, `setEnabled(…)` | On and off. A choice made here wins over `enabled` in the configuration until `resetRuntimeState()`                                                                                                           |
| `showToolbar()`, `hideToolbar()`         | The toolbar. Off still lets the app drive Notato from code                                                                                                                                                    |
| `startAnnotating()`, `stopAnnotating()`  | The next tap selects what is under it                                                                                                                                                                         |
| `select(view)`, `select("#save")`        | Select an element as if it had been tapped, and open the note for it                                                                                                                                          |
| `annotate("#save", comment, options)`    | Make a note with no UI (a suspend function), as a person or (with `agentName`) an agent. `peopleOnly = true` keeps a person's note from the agent                                                             |
| `packageNotes(upload)`                   | Test mode: the device's notes as a bundle zip                                                                                                                                                                 |
| `mask(view, true / false / null)`        | Mark a view private (covered in screenshots, none of its text recorded), not private (a field recorded even with `maskInputs`), or back to the default. See [What is never recorded](#what-is-never-recorded) |
| `recordRequest(entry)`                   | Add an HTTP request to the `network` context of later notes                                                                                                                                                   |

```kotlin
val state by Notato.state.collectAsState()
Switch(checked = state.isEnabled, onCheckedChange = { Notato.setEnabled(it) })
```

The sample's **Feedback** tab does each of these.

## What a note carries

The same schema as the other SDKs (`environment.platform` is `android`):

- **Which element**: for a composable, its semantics (role, text, content description, test tag as the test id); for a View, its class, resource id, text and content description. Plus its size, and for Views the colours, text size, padding and margins it has. None of the text of anything private (below).
- **Where it is in the code**, as above.
- **What was on screen**: the window with the element outlined and the pin's number drawn on, and a crop around it. Notato's overlay is hidden while the window is copied.
- **Context** (`context.android`): the screen, Activity and Fragments, the device, Android version and API level, emulator or not, orientation, dark mode, font scale, density and locale.
- **The app's log** (`context.console`, the web SDK's shape): this process's warnings and errors from logcat since Notato started.
- **Network** (`context.network`) when the app calls `Notato.recordRequest` (from an OkHttp interceptor, say).

### What is never recorded

- **Password fields**, always: covered in screenshots, and their value is never recorded.
- **Text fields** when `maskInputs` is on (by default in test and agent mode): covered, and their value left out. Their hint or label is still recorded, so a note can say which field it is.
- **Anything marked private, and everything inside it**: covered in screenshots, and none of its text is recorded anywhere. Not as its text, label or content description, not in the text of a container around it, and not in its selector, which is its id or test tag, else its role and place (`text:nth(3)`), never `:text("…")`. A selector cannot find it by its text either. For a composable, what it is set to (on or off, selected, progress) is left out too.

```kotlin
// Views
Notato.mask(cardNumber)                  // private: this view and every view in it
Notato.mask(searchField, false)          // not private: a field recorded even when maskInputs is on
Notato.mask(cardNumber, null)            // back to the default

// Compose (notato-compose): the same rules
Text(user.email, Modifier.notatoMask())
Column(Modifier.notatoMask()) { /* everything in it */ }
OutlinedTextField(query, onQueryChange, Modifier.notatoMask(false))
```

`false` opts a text field out of `maskInputs` (on a container, the fields in it). Password fields stay masked whatever the mark, and a private view or composable around a field marked `false` wins over it: what is inside something private is always private. `Modifier.notatoMask` only adds a semantics property, as `testTag` does, so TalkBack reads the same. This is the web SDK's `data-notato-mask`.

### Selectors

What a note's selector looks like, and what an agent passes to `notato_annotate` or `Notato.annotate`:

|                        |                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `#save`                | The View's resource id name, or the composable's test tag (`Modifier.testTag("save")`)                                                 |
| `button`               | The role (`button`, `text`, `heading`, `textbox`, `switch`, `checkbox`, `img`, …) or the class (`MaterialButton`, `Text`); `*` for any |
| `:text("Add to cart")` | The text or label contains this, ignoring case                                                                                         |
| `:nth(2)`              | The second match on screen, in drawing order                                                                                           |
| `ProductScreen …`      | A leading screen name, for people; ignored when matching                                                                               |

## Modes

- **dev**: notes go live to `notato dev`, pins turn amber when the agent acknowledges them and green when it resolves them, and replies arrive in the pin's card. On a resolved pin, **Ask the agent to revert** asks for the change to be undone. A note made while the server is down is kept on the device and sent when it comes back.
- **test**: notes stay on the device (they survive a restart). **Package and share** in the toolbar's menu makes the bundle zip `notato_import_bundle` reads, opens the share sheet, and uploads it when a server is set.
- **agent**: like dev, and the app also takes `notato_annotate` requests: `notato_annotate { target: "#add_to_basket", comment: "…" }` is relayed to the app, which finds the element, takes the screenshot and files the note as the agent.

## People only and asides

Everything people write reaches the agent: new notes and every reply. Two switches keep something between people instead:

- **People only**, for a whole note. In the composer, the **People only** switch (_"Keep this between people: the agent won't see it."_, off by default) keeps the note and its whole thread from the agent. The note's card shows a **People only** chip, and the same switch there turns it on or off at any time, for anyone on the thread. Each change is recorded in the thread as an automatic entry (_"Made this people only: the agent won't see it."_ or _"Shared this with the agent."_); turning it off hands the note to the agent. From code: `AnnotateOptions(peopleOnly = true)`.
- **Aside**, for one reply. Under the reply field, the **Aside** switch (_"Just for people: the agent won't see this reply."_) keeps that reply from the agent; it is off again for the next one. Asides show in the thread muted and outlined, labelled **Aside**.

A note the server has is changed through the server, which records the change. A note still on the device (test mode, or one made while the server was down) is changed on the device, with the same entry added to its thread, so a package carries the history. If the switch is flipped while such a note is on its way to the server, the server is told once it has the note.

## Pins

Each note made on Android has a pin on its screen, on the element it is about: the view it was made on while that view still shows the same element (the same id and words; a list's recycled row shows another item, so it is let go of), else whatever its selector finds now, else where the element was. A screen draws the pins of its newest 150 notes made on Android. Notes made on the web, iOS or anywhere else have no pin (their elements are not this app's): the **Notes** list in the **⋯** sheet shows them, after the screen's first ten notes, so every note on a screen can be opened from its row or its pin. On a screen crowded past that (more than 40 notes without a pin), the list says how many more are on the board.

Pins cost nothing on a still screen: they are placed again only after the window has drawn (a scroll, a layout, a recomposition) or a note has changed, and the screen is read at most twice a second. The route (which Activity, Fragment and screen composable shows) is worked out again the same way. When the app connects, it reads the project's notes as summaries (`fields=summary`: without each note's `context` and `steps`, which are most of a note's size and which only the board and the agent use) and matches them by id, so a project with thousands of notes stays quick; a server that does not know `fields` sends them whole.

Notes made here are kept on the device, their screenshots as files, until the server has them: nothing is held in memory but the note, and a test-mode package is written to its file as it goes. Each file is written whole or not at all, and a note that cannot be read back is said in the log and skipped, never the others.

## How the overlay works

Notato's UI is plain Views in a layer added to the top window of the resumed Activity. The layer passes touches through to the app except on its own controls, and while annotating, when it takes the next tap. A dialog is a window of its own on Android, so while a full-screen one shows (a Compose `Dialog` with `usePlatformDefaultWidth = false`, a full-screen DialogFragment) the layer moves into it. Notato finds the app's windows the way Espresso does, through the window manager's list of views.

## Known limits

- Small dialogs, popups and dropdown menus are windows smaller than the screen: the toolbar stays in the window below, so what is in them cannot be picked. A full-screen dialog works.
- An element is what the semantics tree has. A composable with no semantics (a plain `Box` or `Row` with nothing to say) is not an element of its own: **Parent** steps out to the nearest one that is. Tapping a button's label selects the button.
- Compose source information is in debug builds; R8 removes it from release builds, where notes still have the element but not its file and line.
- Android's reflection limits: reading the window list and system properties uses non-SDK interfaces that Android allows today (Espresso relies on the same). If a future version blocks them, dialogs stop being covered and `debug.notato.*` stops being read; nothing else changes.
- WebViews are one element: what is inside them is not inspected.
- Verified on a Pixel 7 emulator (Android 16, API 36) against `notato dev`, with real taps through `adb shell input`: Compose and View screens, a full-screen Compose dialog, a second Activity with a Fragment, live status over SSE, reply and revert, agent relay, test-mode packaging and sharing, on and off at runtime, and the toolbar dragged and remembered. Not yet run: a physical device, API levels below 34, a `notato serve` server with a token. The changes for large projects (pins, the summary list, screenshots kept as files) are covered by the unit tests and have not been run on a device yet.

## Development

```bash
cd sdks/android
./gradlew test                       # selectors, pins, masking, config, the token rule, SSE, the store, the zip, People only, and the schema contract (needs bun)
./gradlew :sample:installDebug       # the sample: a Compose shop, a View/Fragment account screen, a Feedback tab
adb reverse tcp:4747 tcp:4747
```

The contract tests run the server's own Zod schema over the JSON this library writes (`scripts/validate.ts`), and are skipped when `bun` is not installed.
