# SDKs

What goes into an app. Each SDK is one folder here, in whatever language it is written in, built with its own tools, and released with everything else at the same version (see [RELEASING.md](../RELEASING.md)).

| Folder                       | For                                          | Package                                               | `platform`     |
| ---------------------------- | -------------------------------------------- | ----------------------------------------------------- | -------------- |
| [browser](browser)           | Any web page, any framework: the toolbar     | `@notato/browser` (npm)                               | `web`          |
| [react](react)               | React: `<Notato />` around `@notato/browser` | `@notato/react` (npm)                                 | `web`          |
| [angular](angular)           | Angular: `provideNotato()` around it         | `@notato/angular` (npm)                               | `web`          |
| [swift](swift)               | SwiftUI and UIKit                            | `Notato` (SwiftPM, from `Package.swift` at the root)  | `ios`          |
| [android](android)           | Android Views and Jetpack Compose            | `dev.notato:notato-android`, `notato-compose` (Maven) | `android`      |
| [dotnet](dotnet)             | .NET MAUI                                    | `Notato.Maui` (NuGet)                                 | `maui`         |
| [react-native](react-native) | React Native, Expo or bare                   | `@notato/react-native` (npm)                          | `react-native` |
| [flutter](flutter)           | Flutter: iOS, Android, macOS, web            | `notato` (pub.dev)                                    | `flutter`      |

Every SDK speaks the same wire format to the same server: annotations and bundles as [`packages/schema`](../packages/schema/src/index.ts) defines them, with [`schema.json`](../packages/schema/schema.json) generated from it for languages without Zod.

## Adding one

Flutter, React Native, Angular, Vue: the steps are the same. [`scripts/repo.test.ts`](../scripts/repo.test.ts) checks the ones marked ✓ for every folder here, so `bun run test` says what is missing.

1. ✓ **A folder, `sdks/<name>/`,** with the SDK's own project files at its root, an example app inside it, and a **README.md** written for app developers: setup, options, known limits, and a Development section. The README is the package's page on its registry and a page of the docs site.
2. **The wire format.** Send what `packages/schema` describes, with `environment.platform` (a new kind of app gets a new value: add it to `KNOWN_PLATFORMS` there and to the board's labels in `packages/board/src/Detail.tsx`) and `environment.sdk`, the package's registry name and version. Read leniently: ignore fields you do not know, and keep enumerations (status, intent, kind) as strings, so a newer server never breaks an older app.
3. **A contract test** that runs what the SDK writes through the server's own schema: `bun sdks/<name>/scripts/validate.ts` as Swift and Android do, or `schema.json` as .NET does. It is what keeps the SDKs and the server agreeing.
4. ✓ **One version.** Where the SDK writes its version (a manifest, or a constant it reports as `environment.sdk`) goes in `SDK_STAMPS` in [`scripts/version.ts`](../scripts/version.ts). An npm package needs nothing: its `package.json` is found.
5. ✓ **CI:** `.github/workflows/sdk-<name>.yml`, run on changes to `sdks/<name>/**` and `packages/schema/**`, with the tests, the contract test and the example's build. An npm package is covered by `ci.yml` already.
6. **Release:** a job in [`release.yml`](../.github/workflows/release.yml) behind its own `PUBLISH_<REGISTRY>` switch that always builds the package and only uploads it when the switch is on. npm packages are published by the npm job already.
7. ✓ **Docs:** a page in `site/docs.ts` (`PAGES`, made from the README), and a guide in the board's Connect panel (`packages/board/src/connect.ts`).

**A web framework** (Angular, Vue, Svelte) is a small npm package that depends on `@notato/browser` and starts `createController` the framework's way, as `sdks/react` does. Reading component names belongs in `@notato/browser`, not in the wrapper: its identity plugins read what a framework's development build leaves on the DOM (React's fibers today; Angular's `ng.getComponent` would sit beside it), so the script tag and the browser extension name components on any page too.

**A native toolkit** (Flutter, React Native) draws its own views, so like `swift` and `android` it has its own overlay, element identity and screenshots, and shares only the wire format. React Native can take `@notato/schema` and `@notato/core` from npm.

### What every native SDK does

The native SDKs (`swift`, `android`, `dotnet`, `react-native`, `flutter`) have one feature set, drawn the same way, so a tester moving between apps finds the same thing. A new one is done when it has all of it:

- **The toolbar**: grip, Annotate with the count of notes on the screen, ⋯ and a fold chevron; it drags, and folds into a round button with the potato. The ⋯ sheet has the header (mode and host, the connection's pill), a banner with **Retry** when the server cannot be reached, and the rows: Annotate, Hide or Show pins, Notes, (test mode) Package and share and Clear notes, Settings, Hide toolbar, Turn Notato off. Notes, Settings, Clear and a note's card open in the same sheet, with Back. Words and colours are the Swift SDK's (`OverlayViews.swift`); the icons are `scripts/icons/render.swift`'s.
- **Picking**: a tap selects what is under it, **Parent** steps out; the composer has intents, severities and **People only**.
- **The three modes**: dev (live, with an offline queue: refused notes are marked failed and passed over, anything else holds the queue), test (kept on the device across launches, packaged as the bundle zip, uploaded when a server is set, shared through the share sheet), agent (answers `annotate-request` events and reports to `/relay/:id/result`).
- **A note's card**: its thread (automatic entries quiet, asides outlined), reply and **Aside**, People only at any time (recorded in the thread on the device when the note is not sent yet), **Ask the agent to revert**, **Cancel request**, Delete.
- **Masking**: password fields always, text fields with `maskInputs` (on in test and agent mode), and a private mark (`NotatoMask` in React Native and Flutter, `.notatoMask()` in Swift, `Notato.mask` / `Modifier.notatoMask` on Android) that covers what is inside in screenshots and keeps its text out of notes and selectors; `false` opts a field back in.
- **Selectors**: `#id`, a type or role, `[label="…"]`, `:text("…")`, `:nth(n)`, and leading names for the components around it; pins are found again by them.
- **A runtime API**: on and off, the toolbar, start and stop annotating, select, annotate from code (as a person or an agent), package, record a request; runtime choices remembered until reset.
- **Context**: the app's recent warnings and errors (`context.console`) and recorded requests (`context.network`).
