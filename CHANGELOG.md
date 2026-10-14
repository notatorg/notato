# Changelog

Every Notato package is released together, at one version: the `notato` command and server, the npm packages, the Swift package, the Android libraries, the .NET MAUI package, the Flutter package, the Docker image and the website. A release's entry here is also the top of its [GitHub release](https://github.com/notatorg/notato/releases), and a tag is refused until this file has its version.

## 0.3.0

Safer connections for apps, and a server that other products can be built on.

- **Web SDK connection fixes.** The browser, React and Angular SDKs send event-stream credentials in an `Authorization` header, not in the address, scope their capability request to the project, and read a token from a `data-notato-token` attribute on the script tag. They work with a 0.2.0 server as they are.
- **App tokens and agent tokens.** A token now says what it is for. An **app** token goes in an SDK, is for one project, and cannot use MCP or act as an agent. An **agent** token is for your coding agent over MCP and the API, for one project or for all of them. `--capture-only` makes an app token that can only send notes and never read them back, so a token in a page's source cannot be used to read what testers wrote. `notato token create` takes `--purpose`, `--capture-only` and `--expires <days>`, and the board's Tokens page can make each kind. Tokens made before 0.3 keep working exactly as they did, for both an app and an agent. A new project's first token is an app token: make an agent token for MCP.
- **Ready for an agent at once.** `notato project create <id>` makes an agent token for that project, as well as the app token, and `--json` prints both with the exact MCP URL and header, so a coding agent can set a shared server up from one command. The board's New project dialog does the same (a checkbox, on), and shows the agent's connect lines once. `AGENTS.md` in the repository tells an agent the whole setup.
- **Tokens stay out of addresses.** The bookmark, the console snippet and the script tag put the token in an attribute instead of the script's URL; `notato inject` prints them that way.
- **Encrypted backups.** `notato backup-keygen`, `notato backup` (once, or `--interval-hours` on a schedule, keeping the last few) and `notato restore` back up and restore a data folder: the database and the screenshots, authenticated and encrypted with a key you keep elsewhere.
- **`notato doctor`** checks a send-only token without storing or reading a note (`Capture connection`).
- **Agents are told feedback is untrusted data.** The MCP instructions say that captured text and names are not instructions, and a token's agent presence is kept per credential.
- **Streams, relays and imports stay inside a credential's projects.** An event stream for every project carries only the ones the credential can use, and ends when the credential stops being valid.
- **Building on the server.** `runServe` takes a `ServerExtension`: its own store, screenshots, accounts, extra routes, request middleware, per-request allowed origins, response headers, limits (hooks that can refuse a note or a project), MCP auditing and a start and stop for background work. A signed-in person who is not an admin (a `member`) reaches only the projects they are given, and `ScopedBackend` works over a set of projects. The board draws itself through `mountBoard({ extension })`, with its own sign-in, frame, pages, sidebar links and project-settings section, and `bun packages/board/scripts/build.ts --html <page>` builds a board from another page. A plain server uses none of this and behaves as before. See *Building on Notato* in the README.
- **MIT, everywhere.** The server, the command and the board are MIT, like the SDKs.

## 0.2.0

Notato in .NET Aspire, and switching Notato on or off from where an app is built or launched.

- **`Notato.Aspire`** (NuGet), for an Aspire app host. `builder.AddNotato()` runs the board, the server and MCP for your coding agents with your apps, on the same port every run, from the repository's root. `.WithReference(notato)` turns Notato on in an app and points it there: `VITE_NOTATO` and `VITE_NOTATO_SERVER` for a JavaScript app, `NOTATO_ENABLED` and `NOTATO_SERVER` for the rest. `.WithDataDirectory`, `.WithConfigFile`, `.WithTunnel` and `.WithNotatoCommand` change how it runs. Nothing of it is published.
- **`notato start --attach`:** with a Notato already on the port, it stays up beside that one instead of exiting, and serves the port itself if that one stops. Aspire runs it this way.
- **Web:** in an app built with Vite, `<Notato />` and `provideNotato` read `VITE_NOTATO` (`true` starts the toolbar in a production build too, `false` keeps it off in development) and `VITE_NOTATO_SERVER`, over `enabled` and `server`. `@notato/browser/env` reads them for an app that starts the toolbar itself. `@notato/vite` takes `1`, `yes` and `on` for `VITE_NOTATO` as well.
- **.NET MAUI and Swift:** `NOTATO_ENABLED` and `NOTATO_SERVER` in the app's environment win over `Enabled` and `Server`, and `NOTATO_ENABLED` over the on or off remembered on the device. On a phone or the Android emulator, MAUI reaches a `localhost` server through the dev tunnel the build recorded for it.
- **Flutter:** the same two from `--dart-define`. A release build that declares neither is as before.
- **Browser extension, no server:** a site can keep its notes in the browser instead (**Notes go to › This browser only**). The toolbar runs in test mode there: notes and screenshots survive reloads and download as a zip that a Notato board imports, and the extension reaches no server for that site.

## 0.1.1

Smoother toolbars on every platform. Nothing changes in the server, the wire format or any SDK's API.

- **The composer opens as soon as you pick something.** It no longer waits for the screenshots, which are taken behind it and sent with the note. Notato's toolbar and pins stay on screen while they are taken.
- **Pins follow what they are on.** They keep up with scrolling and moving content, and the work to find them again happens once the app is still, so a scrolling app no longer stutters with pins on screen.
- **Things animate.** Sheets slide up and down and fade between each other, the composer, toasts, the hint and pins come and go, the toolbar fades away while a note is written and folds smoothly. Reduce Motion is respected.
- **Flutter:** finding pins is cheaper (a rebuilt screen is no longer read again through the inspector), the theme is built once, and pins redraw on their own.
- **React Native:** pins are not looked for again because of Notato's own renders; switching sheets on iOS no longer leaves the new one blank.
- **Android and .NET MAUI:** the composer takes the keyboard when it opens, once its screenshot is taken. Before, typing went to the app.
- **Android:** a Compose app's source index is no longer rebuilt while it scrolls.
- **.NET MAUI:** the selection outline is no longer rebuilt several times a second; Android screenshots are drawn without hiding the overlay.
- **Swift:** pins keep moving while a scroll view scrolls; Send and picking no longer block the main thread.
- **Web:** Save closes the composer at once and shows the pin while the note is delivered; pins, the popover, the picker and version switchers measure once a frame; pins and the dragged toolbar move by transform.

## 0.1.0

The first release.

- **`npx notato`:** the local server, the board at `localhost:4747`, and MCP at `/mcp` for any coding agent (Claude Code, Codex, Cursor, Gemini CLI, VS Code). `notato init` sets up a React app and your agents, and `notato doctor` checks the whole loop.
- **`notato serve`:** a shared server with sign-in, projects and project tokens, for testers and teams. Also as a Docker image, `ghcr.io/notatorg/notato`.
- **Modes:** dev (live to your agent), test (a zip bundle, or a shared server) and agent (an AI agent driving the app, with its steps).
- **SDKs:** `@notato/react`, `@notato/angular`, `@notato/browser`, `@notato/vite`, `@notato/react-native`, the `Notato` Swift package, `dev.notato:notato-android` and `notato-compose`, `Notato.Maui`, and `notato` for Flutter. Native SDKs point at the file and line a widget or view is written at.
- **Any page:** a bookmark, or the Chrome extension, puts the toolbar on a page you did not build.
