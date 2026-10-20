# Notato for .NET MAUI

Figma-style comments for a running .NET MAUI app. Tap an element, write a note, and it reaches your coding agent (Claude Code, Codex, Cursor, Gemini CLI, Copilot and others) over MCP with a screenshot, the XAML file and line the element was written at, its page, its view model, and the app's recent log. It is the MAUI client of the same Notato server every other Notato SDK uses: the notes, the board, the MCP tools and the status loop (open, acknowledged, resolved, revert) are the same.

Works on iOS, Android and Mac Catalyst with .NET 10 and later. Windows builds, but has no overlay yet.

**Screenshot size.** New captures prefer WebP at quality 85 when it is smaller than PNG, after privacy masking and at the same dimensions. PNG remains a fallback, and existing queues and bundles stay readable. See [screenshot storage](../../docs/screenshot-storage.md).

## Quick start

```bash
npx notato dev           # the server your agent reads, on http://localhost:4747
```

Add the package to the app (`dotnet add package Notato.Maui`), and in `MauiProgram.cs`:

```csharp
using Notato.Maui;

var builder = MauiApp.CreateBuilder();
builder.UseMauiApp<App>();
#if DEBUG
builder.UseNotato(options => options.Project = "checkout-app");
#endif
```

Leaving `UseNotato` out of a build ships nothing of Notato in it. Run the app: a small dark toolbar appears in the corner. Tap **Annotate**, tap what you want to comment on, write a note, press **Send**. The number on **Annotate** is how many notes the screen has; the chevron folds the toolbar into a round button, and **⋯** opens Notato's menu (notes, settings, packaging in test mode, hiding the toolbar), whose header shows the server and whether it is connected. Ask your agent to _"watch Notato and fix what comes in"_.

The app has to be allowed to talk plain `http` to the development machine:

- **iOS and Mac Catalyst**: in `Platforms/iOS/Info.plist` (and `MacCatalyst`), `NSAppTransportSecurity` → `NSAllowsLocalNetworking` = `true`.
- **Android**: a network security config that permits cleartext to `localhost` (see the sample's `Platforms/Android/Resources/xml/network_security_config.xml`, referenced from `AndroidManifest.xml`). Then `adb reverse tcp:4747 tcp:4747`, so `localhost:4747` on the emulator or a USB-connected phone is the server on your machine. (`10.0.2.2` does not work: `notato dev` only answers to loopback names.)

The iOS simulator shares the Mac's network, so `localhost` works there as it is.

### On a phone

A phone cannot reach your machine's `localhost` (and iOS has no `adb reverse`). Start the server with a dev tunnel, `notato dev --tunnel` (see [Phones: a dev tunnel](https://github.com/notatorg/notato#phones-a-dev-tunnel); one `devtunnel user login` first), and there is nothing else to do: it writes the tunnel's https URL and a device token to `.notato/device.json` at the repository root, and this package's build targets record them in **debug** builds. When `Server` is not set, an iPhone, an Android phone and the Android emulator then use the tunnel, sending the device token, and the iOS simulator and Mac Catalyst the server's local address (its port included). Build again after the tunnel's URL changes; Visual Studio's up-to-date check knows the file.

- `<NotatoDataDirectory>` points the build at another data folder; `<NotatoDeviceAccess>false</NotatoDeviceAccess>` turns it off, `true` turns it on in other configurations too (the token then ships in that build).
- The device token opens `notato dev` on your machine to whoever has it, and anyone with a debug build can read it out of the build. Keep debug builds to yourself; a build for testers goes to a shared server with a capture-only token ([below](#physical-devices-and-shared-servers)).
- A `Server` from configuration, or one typed in the toolbar's settings, wins over the tunnel.

## Configuration

`UseNotato()` binds the `Notato` section of `builder.Configuration` when there is one, then applies the delegate. Any configuration source works; the sample embeds an `appsettings.json` and adds environment variables over it:

```json
{
  "Notato": {
    "Project": "checkout-app",
    "Mode": "Dev",
    "Server": "http://localhost:4747"
  }
}
```

```csharp
builder.Configuration.AddJsonStream(appsettingsStream);
builder.UseNotato();                                                   // the "Notato" section
builder.UseNotato(builder.Configuration.GetSection("Feedback"));       // or another section
builder.UseNotato(o => o.AppVersion = "2.1-beta");                     // the section, then code
```

| Option                                               | Default                                     |                                                                                                                                                                        |
| ---------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Project`                                            | (required)                                  | Project id on the server. Letters, digits and `. _ - @`                                                                                                                |
| `Mode`                                               | `Dev`                                       | `Dev`, `Test` or `Agent` (see below)                                                                                                                                   |
| `Server`                                             | `http://localhost:4747` (none in test mode) | An empty string means no server. `NOTATO_SERVER` wins over it (below)                                                                                                  |
| `Token`                                              |                                             | A project token (`notato_…`) for a shared `notato serve`, sent only to the server configured here. A build for testers: a capture-only token (below)                   |
| `Enabled`                                            | `true`                                      | Whether Notato is on at start-up. The app can switch it at runtime. `NOTATO_ENABLED` wins over both (below)                                                            |
| `ShowToolbar`, `ToolbarPosition`, `ToolbarCollapsed` | `true`, `BottomRight`, `false`              | The floating toolbar. People can drag it anywhere and fold it into one round button (it opens by itself while annotating); where they leave it, and how, is remembered |
| `ShakeToToggle`                                      | `true`                                      | Shaking the device shows or hides the toolbar (real devices). It shares the accelerometer if the app reads it too, and only stops it if it started it                  |
| `Author`                                             |                                             | The name on this person's notes. They can change it in the toolbar's settings                                                                                          |
| `Screenshots`                                        | `true`                                      | With a server set (test mode's too), none is taken until it says it takes them, and its "off" wins either way                                                          |
| `CaptureSecureWindows`                               | `false`                                     | Screenshot Android windows marked `FLAG_SECURE` (one-time codes, card entry) too. Off, a note made on one goes without a screenshot                                    |
| `MaskInputs`                                         | on in test and agent mode                   | Cover inputs (Entry, Editor, SearchBar) in screenshots and leave what is typed out of notes. Password entries always are                                               |
| `RememberRuntimeState`                               | `true`                                      | Keep runtime choices (on or off, toolbar, name, a server typed in) across launches                                                                                     |
| `XamlSourceInfo`                                     | `true`                                      | Turn on MAUI's XAML source info, so notes say which file and line (Debug builds)                                                                                       |
| `ProjectPath`                                        | worked out at build time (Debug builds)     | The app project's folder from the repository root, put in front of XAML paths                                                                                          |
| `CaptureLogs`, `LogLimit`                            | `true`, `50`                                | Attach the app's recent `ILogger` messages and unhandled exceptions                                                                                                    |
| `AppName`, `AppVersion`                              | from the app                                | Recorded on every note                                                                                                                                                 |
| `MaxScreenshotScale`                                 | `2`                                         | Phones are 3x; 2x is plenty to read and half the size                                                                                                                  |

The configuration is read through `IOptionsMonitor`, so a source that reloads takes effect without a restart.

### For one launch: `NOTATO_ENABLED` and `NOTATO_SERVER`

Two environment variables are read whatever the configuration is, after it and after the code in `MauiProgram`, so whoever launches the app decides for that launch without changing it: [Aspire](https://github.com/notatorg/notato/tree/main/sdks/dotnet/src/Notato.Aspire#readme) sets them for an app it runs (`WithReference(notato)`), and so can an IDE's launch profile, or `xcrun simctl launch` with the `SIMCTL_CHILD_` prefix.

```bash
SIMCTL_CHILD_NOTATO_ENABLED=false xcrun simctl launch booted com.example.checkout
```

|                  |                                                                                                                                                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOTATO_ENABLED` | `true`, `1`, `yes` or `on`, or `false`, `0`, `no` or `off`, in any case. Wins over `Enabled`, and over on or off chosen at runtime in an earlier launch. Anything else is ignored                                                        |
| `NOTATO_SERVER`  | The server, such as `http://localhost:4747`, over `Server`. A phone or the Android emulator reaches a `localhost` server through the dev tunnel the build recorded for it (above), so Aspire's address works there too. Blank is ignored |

`Enable()` and `Disable()` still work during the launch and are remembered as before, but the next launch with `NOTATO_ENABLED` set goes by it again. A server typed into the toolbar's settings still wins over `NOTATO_SERVER`, as it does over `Server`. They only matter where `UseNotato` is in the build: behind `#if DEBUG`, a release build has nothing of Notato for them to switch on.

## At runtime: `INotato`

Take `INotato` from DI (or `Feedback.Current` where there is no DI) to switch Notato on and off, and to select things:

```csharp
public partial class DeveloperSettingsPage(INotato notato) : ContentPage
{
    void OnNotatoToggled(object? sender, ToggledEventArgs e)
    {
        if (e.Value) notato.Enable();   // remembered across launches
        else notato.Disable();          // removes the overlay and closes the connection
    }
}
```

|                                                                            |                                                                                                                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Enable()`, `Disable()`, `IsEnabled`                                       | On and off. A choice made here wins over `Enabled` in configuration until `ResetRuntimeState()`; a launch with `NOTATO_ENABLED` set goes by that |
| `ShowToolbar()`, `HideToolbar()`, `IsToolbarVisible`                       | The toolbar. Off still lets the app drive Notato from code                                                                                       |
| `StartAnnotating()`, `StopAnnotating()`                                    | The next tap selects what is under it                                                                                                            |
| `SelectAsync(element)`                                                     | Select an element as if it had been tapped, and open the note for it                                                                             |
| `AnnotateAsync(element, comment, options)`                                 | Make a note with no UI, as a person (`PeopleOnly` keeps it from the agent) or (with `AgentName`) an agent                                        |
| `AnnotateAsync("#SignIn", comment, options)`                               | The same, finding the element with a selector                                                                                                    |
| `Annotations`, `PendingCount`, `Connection`, `ConnectionDetail`, `Changed` | What Notato knows, for a status line or a badge. Safe to read from any thread                                                                    |
| `PackageAsync()`                                                           | Test mode: the device's notes as a bundle zip                                                                                                    |

The sample's **Feedback** tab does each of these.

## What a note carries

Everything the web SDK sends, in the same schema (`environment.platform` is `maui`), so the board, the Markdown and the MCP tools need nothing new:

- **Where it is in the code.** The XAML file, line and column the element was written at (`src/App/Views/ProductCard.xaml:17:14`), from MAUI's own XAML diagnostics, with the path from the repository root. Elements made in C# get the nearest element around them that has a location. The **component path** is the chain of the app's own pages and views around it (`AppShell › ProductsPage › ProductCard`), with the component's XAML file.
- **Which element.** A selector (below), its `AutomationId` (as the test id), `x:Name`, accessible role and name (from `SemanticProperties`), its visible text (a container's is the text inside it), and the elements around it.
- **How it looks.** The values it actually has: colours as hex, font, size, margin, padding, corner radius, stroke, spacing, options, opacity. Defaults are left out.
- **What was on screen.** The whole window with the element outlined and the pin's number drawn on, and a crop around it. Notato's own toolbar is never in them.
- **Context** (`context.maui`): the page and its XAML file, the element's and the page's `BindingContext` type (usually the view model), the Shell location, the navigation and modal stacks, the device, OS, idiom, orientation, theme, culture and font scale, and the MAUI and .NET versions.
- **The app's log** (`context.console`, the web SDK's shape): recent `ILogger` messages from Information up, and unhandled exceptions.
- **Network** (`context.network`), when the app adds `NotatoNetworkHandler` to its HttpClients: `services.AddHttpClient("api").AddHttpMessageHandler(() => new NotatoNetworkHandler())`. URLs are recorded without their query strings, or a user name and password in front of the host.

Mark things up in XAML with `xmlns:notato="clr-namespace:Notato.Maui;assembly=Notato.Maui"`: `notato:Feedback.Mask="True"` makes an element private, and `notato:Feedback.Ignore="True"` makes the picker look through it.

**Feedback is private to its creator by default in Dev mode.** The agent starts with that person's notes; choose Shared or All to include project feedback (see [the feedback visibility guide](https://github.com/notatorg/notato/blob/main/docs/team-feedback.md)). People only notes and asides remain hidden from agents:

- **People only**, on a note. The composer has a **People only** switch, off by default ("Keep this between people: the agent won't see it."). A People only note and its whole thread never reach the agent. Its card shows a **People only** badge, and the same switch there turns it on or off for an existing note: anyone on the thread can, and the server records each change in the thread ("Made this people only: the agent won't see it." or "Shared this with the agent."). Without a server, or before the note has been sent, the change is made on the device with the same thread entry: the note is sent that way, and a test-mode package carries the history. From code, `AnnotateOptions.PeopleOnly` makes a person's note People only.
- **Aside**, on a reply. The reply box has an **Aside** switch ("Just for people: the agent won't see this reply."), off again after each reply. An aside is for the people on the thread, is marked **Aside** in it, and is never sent to the agent.

`@name` calls one of the server's [mention plugins](https://github.com/notatorg/notato#-mentions-plugins-on-the-server). None is built in and none is needed to reach the agent, so the composer and the reply box show no chips unless the server adds a plugin.

What a note never carries:

- **Password entries**, always: covered in every screenshot, and what is in them is never read.
- **Android windows marked `FLAG_SECURE`** (one-time codes, card entry): no screenshot is taken of them, unless `CaptureSecureWindows` is set. The note still says which element it is.
- **Inputs**, with `MaskInputs` (on in test and agent mode): the same for every Entry, Editor and SearchBar. `notato:Feedback.Mask="False"` opts one out, a search box say, so it is shown and recorded.
- **Anything marked private** with `notato:Feedback.Mask="True"`: covered in every screenshot, and neither its text nor the text of anything inside it goes into a note, whether as its text, its accessible name, a container's text or a match for an agent's `:text()` selector. The note still says which element it is (its type, `AutomationId`, `x:Name` and where it is written). A private container wins over an input inside it that opts out. With `MaskInputs`, what is typed into an input is no match for `:text()` either.

### Selectors

A selector is a path through the visual tree, written like CSS so it reads at a glance and the agent can turn it into a search: `LoginPage VerticalStackLayout#Form > Button:nth-of-type(2)`.

|                    |                                                                     |
| ------------------ | ------------------------------------------------------------------- |
| `Button`           | The control's type (`*` for any)                                    |
| `#SignIn`          | Its `AutomationId` (or `[AutomationId="Sign in"]`)                  |
| `[x:Name=Email]`   | Its `x:Name`                                                        |
| `.primary`         | A `StyleClass`                                                      |
| `:nth-of-type(2)`  | The second child of its parent with that type                       |
| `:text("Sign in")` | Its text contains this, ignoring case (for agents; never generated) |
| space, `>`         | Somewhere inside, directly inside                                   |

Notato writes the shortest selector that finds only that element on its page, and uses selectors to put pins back on elements after a restart. An `AutomationId` makes the steadiest one.

### Pins

A pin sits on the element its note was made on, follows it as the page scrolls, and goes faint where the element cannot be found (at the place the note was made). Only notes made with this package get a pin: a note from a web page or another SDK is in the **Notes** list but has no pin, because its selector means nothing here. A screen shows at most the newest 150 pins (as the React Native and Flutter SDKs do); the **Notes** list has every note. Pins are looked for together, in one pass over the page about once a second while one is missing, and drawn again only when one moved or changed.

## Modes

- **Dev**: notes go live to `notato dev`, pins turn amber when the agent acknowledges them and green when it resolves them, and replies arrive in the pin's card. On a resolved pin, **Ask the agent to revert** asks for the change to be undone. A note made while the server is down (or that the server cannot take yet: an unknown project, a missing credential, a busy server) is kept on the device, screenshots and all, and sent when it can be, in order, before the project's notes are read again; its pin's card shows what the server said, the menu says when the server cannot be reached, and **Retry** tries it again at once. A note the server refuses outright (too large, or not valid) says why on its pin's card and does not hold up the ones after it. On connecting, the app reads the project's notes without what only the agent needs (their `context` and `steps`), page by page.
- **Test**: feedback defaults to shared and is sent live into a review session when a server is configured. Notes also stay on the device (they survive a restart), out of the device's backups: in Android's no-backup folder, and on iOS and Mac Catalyst in a folder marked to be left out of them (on iOS, also unreadable while the device is locked unless open). **Package and share** in the toolbar's menu makes the bundle zip `notato_import_bundle` reads (`feedback.md`, `annotations.json`, `shots/`), opens the share sheet, and uploads it when a server is set. With a server set, the zip has the screenshots only while the server says it takes them. A zip over the server's 100 MB limit is shared but not uploaded, and the menu says so.
- **Agent**: like dev, and the app also takes `notato_annotate` requests from the agent: `notato_annotate { target: "#PromoBanner", comment: "…" }` is relayed to the app, which finds the element by its selector, takes the screenshot and files the note as the agent.

## How the overlay works

Notato draws its UI with MAUI controls, in a layer of its own above the app, so it needs nothing from the app's pages and works over Shell, tabs, navigation, modal pages, popups and alerts:

- **iOS and Mac Catalyst**: a transparent window above the app's window in the same scene. Touches that are not on Notato's controls go to the app. Being a separate window keeps the overlay above modal pages and alerts and out of the screenshots, which are taken of the app's window only.
- **Android**: a view in the decor view of the window that is on top. MAUI shows a modal page in a dialog window of its own, and the overlay moves into it while it shows. A screenshot is the window drawn with the overlay left out, so the overlay never disappears; only a window it cannot be drawn from that way (a SurfaceView or TextureView, such as a camera or a map, or a hardware bitmap) is copied from the screen instead, with the overlay hidden while it is.

Notato's controls carry explicit styles, so the app's implicit styles do not reach them, and its handler customisations apply only to the app's own controls.

The picker hit-tests the visual tree with the native views' real positions (scroll views and clipping included), topmost first. **Parent** in the note widens the selection to the element around it.

## Physical devices and shared servers

`notato dev` listens on loopback only. Your own phones reach it through a dev tunnel ([On a phone](#on-a-phone)), and a USB-connected Android phone also with `adb reverse`. For testers elsewhere, run a shared server (`notato serve`, see the main README) and give the app its address and a project token in configuration. The token only ever goes to that server (its scheme, host and port): a server typed into the toolbar's settings gets no token, so a note sent there goes without one.

A build you hand out (TestFlight, an internal track, a device farm) holds whatever is in it, and anyone with it can read that out. Give it a **capture-only** token, which can send notes and nothing else, so one read out of the app cannot read, change or delete anyone's feedback:

```bash
npx notato token create checkout-app --purpose app --capture-only --expires 30
```

Notato asks the server what the token may do before it connects. With a capture-only token it sends notes (and those kept on the device) without following the project, the notes' cards point to the board for replies, status and revert, and a test-mode package uploads its captured notes when a server is configured.

## Known limits

- Windows has no overlay yet: the package builds there, and `INotato` calls that need a window fail with a message.
- XAML line numbers need MAUI's XAML diagnostics, which are on in Debug builds. A Release build gets the component and its XAML file where the XAML compiler records it (from the project's folder, unless `ProjectPath` is set), and selectors.
- Items in a `CollectionView` are recycled, so a selector to one item can point at another after scrolling. A pin in a list stays on its element only while that element still shows the note's item (the same `BindingContext`, or the same text); when a row is reused for another item, the pin is looked for again, and goes faint where it was until its item is back on screen.
- Variants (comparing versions in the page) are web only.
- Shaking does not reach the iOS simulator. Use `INotato.ShowToolbar()` there.
- Verified on the iPhone 17 Pro simulator (iOS 26.5) and an Android 16 emulator, against `notato dev`, by tapping and typing through the whole loop on both. Not yet run: Mac Catalyst, physical devices, a `notato serve` server with a token.

## Hiding completed annotations

On a resolved or reverted note, open **More options → Hide from this app** to hide
its pin and card on this device. In **Settings**, **Hide completed annotations**
hides completed notes across every screen at once, including notes beyond the
150 drawn pins. **Restore hidden annotations** brings them back.

Hiding keeps the feedback, screenshots and thread in the dashboard and exports.
It never changes the note on the server. Reopened tasks and new agent questions
remain visible. The preference is scoped to the server, project, mode, credential
and name, and survives app restarts when runtime preferences are remembered.

## Development

```bash
cd sdks/dotnet
dotnet test tests/Notato.Maui.Tests                     # includes a contract test against packages/schema/schema.json
dotnet test tests/Notato.Aspire.Tests                   # AddNotato and WithReference (src/Notato.Aspire)
dotnet build src/Notato.Maui -p:EnforceCodeStyleInBuild=true   # every target, with .editorconfig's rules
dotnet build samples/Notato.Maui.Sample -t:Run -f net10.0-ios
dotnet build samples/Notato.Maui.Sample -t:Run -f net10.0-android
dotnet pack src/Notato.Maui -c Release -o artifacts
```

The code, in `src/Notato.Maui`:

- `INotato.cs`, `NotatoOptions.cs`, `Feedback.cs`, `NotatoAppBuilderExtensions.cs`: the public API. `Model/` is the schema's shapes, which `INotato.Annotations` returns.
- `NotatoController.cs` and its `NotatoController.*.cs` parts: the running Notato, one file per job (windows, toolbar, pins, selection, making notes, sending them, the server connection, merging the server's copies, acting on a note, test mode's package). `RecordSet` holds the notes.
- `Overlay/`: what Notato draws, from MAUI controls (`NotatoOverlay` and its parts, the sheets and cards, `Ui` for the look). The rules that need no drawing (`ToolbarFold`, `PinLayout`, `MenuText`) are apart from it, so they are tested on plain `net10.0`.
- `Native/`: the overlay's host on each platform (a window of its own on iOS and Mac Catalyst, a view in the top window on Android), and the screenshot.
- `Inspection/`: reading the app's visual tree (hit-testing, selectors, text, privacy, XAML source info). `Capture/` draws the screenshots, `Net/` is the HTTP API, `Runtime/` what is kept on the device and recorded from the app.

The sample is a small Shell shop with a modal checkout and a **Feedback** tab that drives `INotato`. Point it at another server with an environment variable (`Notato__Server=http://localhost:4790`; on the simulator, `SIMCTL_CHILD_Notato__Server` with `xcrun simctl launch`). Build it with `-p:NotatoSampleDevFlow=true` to include the MAUI DevFlow agent, for driving it from a terminal.

`src/Notato.Maui/build/Notato.Maui.targets` ships in the package (`buildTransitive`) and records each assembly's project path from the repository root, in Debug builds only (the repository's absolute path names your machine and user: `<NotatoSourceInfo>true</NotatoSourceInfo>` records it in other configurations too, `false` in none); a project reference imports it by hand, as the sample does.

Capture-only uploads and retries follow the [shared capture contract](../../docs/capture-contract.md). With a server configured, screenshots require an explicit `screenshots: true` policy; unknown or unavailable initial policy means text-only capture. Local-only capture continues without a policy request.

### Feedback ownership and review sessions

Dev feedback defaults to personal; Test defaults to shared. The composer’s **Share with project** switch overrides the default for that note. **People only** separately keeps agents out. With a server configured, Test feedback is sent live and grouped into a review session from the start of the run; without one, device storage and zip packaging still work. Use the board’s **Review sessions** to name a run, set its focus and discuss it. Each developer uses their own credentials with the same project ID. See the [team feedback guide](../../docs/team-feedback.md).
