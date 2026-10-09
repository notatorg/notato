# Changelog

Every Notato package is released together, at one version: the `notato` command and server, the npm packages, the Swift package, the Android libraries, the .NET MAUI package, the Flutter package, the Docker image and the website. A release's entry here is also the top of its [GitHub release](https://github.com/notatorg/notato/releases), and a tag is refused until this file has its version.

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
