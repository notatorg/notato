# Notato for Aspire

Notato in your Aspire app host. `AddNotato()` runs the Notato board, the server your apps' notes go to, and MCP for your coding agent (Claude Code, Codex, Cursor and others) with the rest of your apps, and `WithReference(notato)` turns Notato on in each app that uses it and points it there. Nothing in the apps' code has to know which machine or port that is.

## Quick start

In the app host project:

```bash
dotnet add package Notato.Aspire
```

```csharp
var builder = DistributedApplication.CreateBuilder(args);

var notato = builder.AddNotato();

builder.AddViteApp("web", "../web")
    .WithReference(notato);

builder.Build().Run();
```

A file-based app host takes it as `#:package Notato.Aspire@<version>`. Run the app host as usual (`aspire run`): the dashboard lists **notato** with a **Board** link, and its details have the MCP address. Give that to your coding agent once; on your own machine it needs no token:

```bash
claude mcp add --transport http --scope user notato http://localhost:4747/mcp
```

The board's **Settings › Agents** has the line for Codex, Cursor, Gemini CLI and VS Code. Put the toolbar in the app as usual (`npx notato init` for a React app, `provideNotato` for Angular, `UseNotato` for .NET MAUI); `WithReference` does the rest.

## What it runs

`AddNotato()` runs `npx --yes notato@<version> start --attach --port 4747`, the `notato` npm package of the same release as this one, so Node.js has to be installed. It runs in the repository's root folder (the one with `.git`, above the app host), so the notes and screenshots are in `.notato` there, as with `npx notato`, and `notato.config.json` there is its settings file. `npx notato init` adds `.notato/` to `.gitignore`; without it, add it yourself.

- **The same port every run.** Coding agents are given its address once, and phone builds bake it in, so it is not behind Aspire's proxy and does not move. The dashboard marks it healthy once `/health` answers.
- **One already running is used.** A Notato already on the port (the one your agent's `notato dev` started, another app host's, one you keep running) is used rather than refused: the resource stays running beside it, and serves the port itself if that one stops. Its console says which.
- **Stopping the app host stops it.**
- **Never published.** Notato is a development tool: it is left out of what the app host publishes, and `WithReference` sets nothing then, so a deployed build never has Notato switched on by it.

| Call                                   |                                                                                                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AddNotato(name, port)`                | Default `"notato"` and `4747`                                                                                                                                         |
| `.WithDataDirectory(path)`             | Keep the data somewhere else (`--dir`), such as `"~/.notato"` to share it between repositories. Relative to the app host's folder; `~` is your home folder            |
| `.WithConfigFile(path)`                | Another settings file (`--config`): screenshots, MCP, webhooks (see `notato config`)                                                                                  |
| `.WithTunnel()`                        | Also a [dev tunnel](https://github.com/notatorg/notato#phones-a-dev-tunnel), so phones reach it (`--tunnel`). Needs the devtunnel CLI, signed in once                 |
| `.WithNotatoCommand(command, args...)` | Run it some other way: `("notato")` for one that is installed, `("npx", "--yes", "notato@latest")` for another version. Relative paths start at the repository's root |

## What an app is given

`WithReference(notato)` adds the app to Notato's references on the dashboard and sets two environment variables:

| The app                                                               | Variables                                                      |
| --------------------------------------------------------------------- | -------------------------------------------------------------- |
| A JavaScript app: `AddViteApp`, `AddJavaScriptApp`, `AddNodeApp`      | `VITE_NOTATO=true`, `VITE_NOTATO_SERVER=http://localhost:4747` |
| Anything else: a .NET MAUI app, an executable, a project, a container | `NOTATO_ENABLED=true`, `NOTATO_SERVER=http://localhost:4747`   |

`WithReference(notato, enabled: false)` gives `false` instead, which keeps Notato off in that app, in development too: handy behind a setting of your own.

What reads them:

- **`<Notato />` and `provideNotato`**, in an app built with Vite (or a framework on it): `VITE_NOTATO` decides whether the toolbar starts, over the `enabled` prop, in a production build too. So an app that Aspire runs as `vite build --watch` with `vite preview` has the toolbar, and the same build made anywhere else does not. `VITE_NOTATO_SERVER` wins over the `server` prop. [`@notato/vite`](https://www.npmjs.com/package/@notato/vite) records source positions under the same switch, and the guard `npx notato init` writes checks it too.
- **[Notato.Maui](https://www.nuget.org/packages/Notato.Maui)** (`AddMauiProject`): `NOTATO_ENABLED` wins over `Enabled` and over the on or off remembered on the device, and `NOTATO_SERVER` over `Server`. Aspire hands them to the iOS and Android builds itself. A phone or the Android emulator cannot reach `localhost`: with `.WithTunnel()`, a debug build reaches the server through the tunnel instead (it reads `.notato/device.json` at the repository's root when it is built; give `<NotatoDataDirectory>` with `.WithDataDirectory`).
- **The Swift package** reads the same two from the process's environment, and **Flutter** from `--dart-define`.
- **Next.js and other bundlers** do not pass `VITE_` variables to the page: give `enabled` and `server` from your own.

## Development

The package is in [`sdks/dotnet/src/Notato.Aspire`](https://github.com/notatorg/notato/tree/main/sdks/dotnet/src/Notato.Aspire), with its tests in `sdks/dotnet/tests/Notato.Aspire.Tests` (`dotnet test` there). To try a change to Notato itself from an app host, run it from a checkout: `.WithNotatoCommand("bun", "/path/to/notato/packages/cli/src/main.ts")`.
