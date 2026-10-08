# Contributing to Notato

Thanks for helping. Bug reports, fixes, docs, new SDKs and ideas are all welcome.

- **A small fix** (a typo, a clear bug, a missing test): open a pull request.
- **Something bigger** (a feature, a new SDK, a change to the wire format, a new dependency): open an issue first, so we can agree on the shape before you spend time on it.
- **A security problem**: report it privately, as [SECURITY.md](SECURITY.md) says, not in an issue.

Everyone taking part agrees to the [code of conduct](CODE_OF_CONDUCT.md).

## Set up

You need [Bun](https://bun.sh) 1.x and Node 24 (the TypeScript tests run on Vitest under Node). The native SDKs need their own tools, but only for the SDK you work on (see [Each SDK](#each-sdk)).

```bash
git clone https://github.com/notatorg/notato
cd notato
bun install
bun run build:board      # the board UI, which the server serves
```

Run Notato from source, on a scratch port with a throwaway data folder:

```bash
bun packages/cli/src/main.ts --port 4799 --dir "$(mktemp -d)"
```

Keep development and tests off port 4747 and your own `.notato` folder. That is where a real server of yours may be running, and its webhooks would send your test notes on to Slack or Teams.

- `bun run --filter @notato/board dev` rebuilds the board as you change it.
- `bun packages/cli/src/main.ts <command>` runs any command, such as `init`, `doctor` or `export`, from source.
- [`sdks/react/example`](sdks/react/example) is a small Vite app with the toolbar. `VITE_NOTATO_SERVER=http://localhost:4799 bun run dev` in that folder sends its notes to the scratch server.

## The checks

CI runs these on every pull request. `bun run check` runs the first four together.

| Command                  | What it checks                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `bun run lint`           | Biome's lint and format rules. `bun run format` fixes what it can                                                          |
| `bun run typecheck`      | TypeScript, for the repository and for React Native (which has its own program)                                            |
| `bun run test`           | Vitest for the schema, core, the Vite plugin and every TypeScript SDK; `bun test` for the server, CLI, board and extension |
| `bun run build:site`     | The website, and the docs pages cut from the READMEs                                                                       |
| `bun scripts/version.ts` | Every package is at the same version                                                                                       |
| `bun run build:schema`   | Writes `packages/schema/schema.json` from the Zod schema. CI fails if the committed file is out of date                    |

CI also builds the `notato` binary on Linux, macOS and Windows and smoke-tests it, builds the example apps, installs the packed packages into a fresh Vite app, and builds the Docker image.

## Each SDK

The TypeScript SDKs (`browser`, `react`, `angular`, `react-native`) are covered by `bun run test`. The others have their own tools and their own workflow, which runs when their folder or the schema changes. Their contract tests run the server's own schema over the JSON they write, so they need `bun` installed.

**React and Angular examples**

```bash
cd sdks/react/example && bunx vite build
cd sdks/angular/example && npx ng build      # Node 24.15 or later
```

**React Native** (the example is an Expo app with its own `npm` install, outside the Bun workspace)

```bash
bunx vitest run sdks/react-native
cd sdks/react-native/example && npm ci && npx expo start
```

**Swift** (macOS and Xcode). The manifest is `Package.swift` at the repository root, so run these from there:

```bash
swift test
xcodebuild build -project sdks/swift/Example/ShopSample.xcodeproj -scheme ShopSample \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO
```

**Android** (JDK 21 and the Android SDK)

```bash
cd sdks/android
./gradlew test
./gradlew :notato:lintDebug :notato-compose:lintDebug :sample:assembleDebug
```

**.NET MAUI** (the .NET SDK in `sdks/dotnet/global.json`, and `dotnet workload install maui`)

```bash
cd sdks/dotnet
dotnet test tests/Notato.Maui.Tests
dotnet build src/Notato.Maui -c Release      # the iOS and Mac Catalyst targets build on macOS only
```

**Flutter** (Flutter 3.32 or later, stable channel)

```bash
cd sdks/flutter
flutter pub get
flutter analyze
dart format --output=none --set-exit-if-changed lib test example/lib
flutter test
```

Each SDK's README has a Development section with more: running its sample app, and its UI tests.

## Code style

- **TypeScript, JavaScript, JSON and CSS** follow [`biome.json`](biome.json): 4 spaces, double quotes, semicolons, lines up to 100 characters. `bun run format` applies it.
- **Every file** follows [`.editorconfig`](.editorconfig): LF line endings, a final newline, 4-space indents.
- **C#** follows [`sdks/dotnet/.editorconfig`](sdks/dotnet/.editorconfig): explicit types rather than `var`, explicit `private`, `_camelCase` private fields, braces always, file-scoped namespaces. `dotnet build -p:EnforceCodeStyleInBuild=true` reports anything that is off.
- **Kotlin** uses the official Kotlin style, and Android lint runs in CI. **Dart** uses `dart format` and `flutter_lints`. **Swift** uses 4 spaces and the style of the code around it.
- **Comments and docs** are plain English in full sentences. Say what the code does and why, not how it came to be: "was X, now Y" belongs in the commit message, not the code.
- **Markdown** tables are kept aligned. Prettier does that (`npx prettier --write --embedded-language-formatting off <file>`), if you have it.

## Things worth knowing

- **The wire format is the contract.** [`packages/schema`](packages/schema/src/index.ts) defines annotations and bundles for every SDK and the server. Change it there, run `bun run build:schema`, and commit `schema.json`. Add fields as optional, and read leniently, so a newer server never breaks an older app.
- **One version for everything.** Do not change version numbers by hand: a release sets them all (see [RELEASING.md](RELEASING.md)).
- **The docs are made from the READMEs.** [`site/docs.ts`](site/docs.ts) cuts the main README into pages by heading. Rename a heading there and update `PAGES` to match; `bun run build:site` fails until you do.
- **Adding an SDK** has a checklist in [sdks/README.md](sdks/README.md), and `bun run test` says which steps are missing.

## Pull requests

- Keep each one to a single change, with tests for it, and the READMEs updated to match.
- Say how you checked it: the commands you ran, and what you tried by hand (a browser, a simulator, a device).
- Write commit messages that say what changed and why.
- By sending a pull request you agree that your contribution is licensed under the project's licence ([LICENSE](LICENSE)).

Releases are made by maintainers, as [RELEASING.md](RELEASING.md) describes.
