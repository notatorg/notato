// How to point each SDK at a project on this server: plain data, so what the board tells people can be tested. The
// option names are the SDKs' own, as their READMEs under sdks/ give them.

export type Platform =
    | "react"
    | "angular"
    | "react-native"
    | "flutter"
    | "page"
    | "maui"
    | "swift"
    | "android";

export interface Step {
    /** What to do. `code` in backticks is shown as code. */
    text: string;
    code?: string;
    /** A page on this server to open. */
    link?: { href: string; label: string };
}

export interface Guide<Id extends string = Platform> {
    id: Id;
    label: string;
    steps: Step[];
    notes: string[];
}

export interface ConnectTarget {
    /** The server's address, as this board reaches it. */
    server: string;
    project: string;
    /** Apps need a token to send here (a server with logins). */
    needsToken: boolean;
    /** The token, when the board has it to show; otherwise the snippets hold a placeholder. */
    token: string | null;
    /**
     * The server's version, which every SDK shares (one release, one version): what a snippet that names a version asks
     * for. Gradle takes the newest when it is not known.
     */
    version?: string;
}

export const TOKEN_PLACEHOLDER = "pft_…";
/** Where every SDK looks when it is given no server. */
const DEFAULT_SERVER = "http://localhost:4747";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The port to forward to a phone or an emulator, when the server is on this computer. */
function localPort(server: string): string | null {
    try {
        const url = new URL(server);
        if (!LOOPBACK.has(url.hostname)) return null;
        return url.port || (url.protocol === "https:" ? "443" : "80");
    } catch {
        return null;
    }
}

/** What anyone who can open a page can read, said wherever a web app is given a token. */
const PUBLIC_TOKEN_NOTE =
    "Anyone who can open the page can read the token: give each app its own, and revoke it when the testing is over.";

/** How each SDK is told about a project on this server, with its token where one is needed. */
export function connectGuides(t: ConnectTarget): Guide[] {
    const server = t.server.replace(/\/+$/, "");
    const token = t.needsToken ? (t.token ?? TOKEN_PLACEHOLDER) : null;
    const p = t.project;
    /** The SDKs default to `notato dev` on 4747; anything else has to be said. */
    const otherServer = server !== DEFAULT_SERVER || token !== null;
    /** Makes this server localhost on the Android emulator or a USB phone. */
    const port = localPort(server) ?? "4747";
    const adbReverse = `adb reverse tcp:${port} tcp:${port}`;
    // Tokens are URL-safe as they are (base64url), and so are project ids.
    const bookmarkPage = `/bookmarklet?project=${p}${token && t.token ? `&token=${t.token}` : ""}`;
    const script = `${server}/inject.js?project=${p}${token ? `&token=${token}` : ""}`;

    const react: Guide = {
        id: "react",
        label: "React",
        steps: [
            { text: "Add the package to the app:", code: "npm i -D @notato/react" },
            {
                text: "Render it once, near the root of the app:",
                code: token
                    ? `import { Notato } from "@notato/react";\n\n<Notato project="${p}" server="${server}" token="${token}" enabled />`
                    : `import { Notato } from "@notato/react";\n\n{import.meta.env.DEV && <Notato project="${p}" server="${server}" />}`,
            },
        ],
        notes: token
            ? [
                  "`enabled` keeps it on in a production build, such as a staging site; leave it out to have it in development builds only.",
                  PUBLIC_TOKEN_NOTE,
              ]
            : [
                  `\`npx notato init\` adds this for you and sets up your coding agent too; check that its \`project\` is \`${p}\`.`,
              ],
    };

    const angularOptions = [
        `project: "${p}"`,
        ...(otherServer ? [`server: "${server}"`] : []),
        ...(token ? [`token: "${token}"`, "enabled: true"] : []),
    ];
    const angular: Guide = {
        id: "angular",
        label: "Angular",
        steps: [
            { text: "Add the package to the app:", code: "npm i -D @notato/angular" },
            {
                text: "Add it to the app's providers, in `app.config.ts`:",
                code: `import { provideNotato } from "@notato/angular";\n\nexport const appConfig: ApplicationConfig = {\n    providers: [provideNotato({ ${angularOptions.join(", ")} })],\n};`,
            },
        ],
        notes: token
            ? [
                  "`enabled: true` keeps it on in a production build, such as a staging site; leave it out to have it in development builds only.",
                  PUBLIC_TOKEN_NOTE,
              ]
            : [
                  "It runs in development builds only (`isDevMode()`): the toolbar is a separate chunk that a production build never loads.",
              ],
    };

    const reactNative: Guide = {
        id: "react-native",
        label: "React Native",
        steps: [
            {
                text: "Add the package, the screenshot library it uses, and Expo's file and share modules, where notes wait to be sent:",
                code: "npx expo install @notato/react-native react-native-view-shot expo-file-system expo-sharing",
            },
            {
                text: "Wrap your app in it:",
                code: `import { Notato } from "@notato/react-native";\nimport { expoStorage } from "@notato/react-native/expo";\n\n<Notato project="${p}"${otherServer ? ` server="${server}"` : ""}${token ? ` token="${token}" enabled` : ""} storage={expoStorage}>\n    <App />\n</Notato>`,
            },
        ],
        notes: [
            ...(token
                ? [
                      "`enabled` keeps it on in a release build; picking a view still needs a development build, which has React Native's inspector.",
                  ]
                : [
                      "Development builds only: in a release build it renders your app and nothing else.",
                      `The iOS simulator reaches this server as it is; \`${adbReverse}\` makes it localhost on the Android emulator or a USB phone.`,
                  ]),
            "A bare app without Expo modules: `npm i @notato/react-native react-native-view-shot`, then `pod install` in `ios/`, and leave `storage` out (notes are then kept until the app restarts).",
        ],
    };

    const flutterOptions = [
        `project: '${p}'`,
        ...(otherServer ? [`server: '${server}'`] : []),
        ...(token ? [`token: '${token}'`, "enabled: true"] : []),
    ];
    const flutter: Guide = {
        id: "flutter",
        label: "Flutter",
        steps: [
            { text: "Add the package:", code: "flutter pub add notato" },
            {
                text: "Wrap your app in it, in `main.dart`:",
                code: `import 'package:notato/notato.dart';\n\nrunApp(Notato(${flutterOptions.join(", ")}, child: const MyApp()));`,
            },
        ],
        notes: [
            ...(token
                ? [
                      "`enabled: true` keeps it on in a release build; picking a widget still needs a debug build, which records where widgets are written.",
                  ]
                : [
                      "Debug builds only: in a release build it is your app and nothing else.",
                      `The iOS simulator and desktop apps reach this server as it is; \`${adbReverse}\` makes it localhost on the Android emulator or a USB phone.`,
                  ]),
            "Add `Notato.navigatorObserver` to your app's `navigatorObservers` for notes to know the screen they were made on.",
        ],
    };

    const page: Guide = {
        id: "page",
        label: "Any page",
        steps: [
            {
                text: "Open the bookmark page, drag its button to your bookmarks bar, and click it on the page you want to annotate.",
                link: { href: bookmarkPage, label: "Open the bookmark page" },
            },
            {
                text: "Or put this in the page's HTML while you work on it:",
                code: `<script src="${script}"></script>`,
            },
        ],
        notes: [
            "Nothing to install or rebuild: it is the same toolbar as the SDK, for any framework or none.",
            "Pages on this computer and on local networks work as they are. Another site needs the server started with `--cors-origin <its origin>`, or the browser extension.",
            ...(token && !t.token
                ? [
                      `Add \`&token=<the token>\` to the bookmark page's address, as the script tag has it.`,
                  ]
                : []),
        ],
    };

    const mauiOptions = [
        `    options.Project = "${p}";`,
        ...(otherServer ? [`    options.Server = "${server}";`] : []),
        ...(token ? [`    options.Token = "${token}";`] : []),
    ];
    const maui: Guide = {
        id: "maui",
        label: ".NET MAUI",
        steps: [
            {
                text: "Add the `Notato.Maui` package, then in `MauiProgram.cs`:",
                code: `using Notato.Maui;\n\n#if DEBUG\n${
                    mauiOptions.length === 1
                        ? `builder.UseNotato(options => options.Project = "${p}");`
                        : `builder.UseNotato(options =>\n{\n${mauiOptions.join("\n")}\n});`
                }\n#endif`,
            },
        ],
        notes: token
            ? [
                  "Or put `Project`, `Server` and `Token` in the `Notato` section of the app's configuration.",
              ]
            : [
                  `iOS and Mac Catalyst: allow \`NSAllowsLocalNetworking\` in Info.plist. Android: allow cleartext to localhost, then \`${adbReverse}\`.`,
                  `On a phone, start the server with \`--tunnel\`${otherServer ? " and leave `Server` out" : ""}: debug builds then read its address and the device token from \`.notato/device.json\` by themselves.`,
              ],
    };

    const swiftConfig = otherServer
        ? `NotatoConfiguration(project: "${p}", server: URL(string: "${server}"))`
        : `NotatoConfiguration(project: "${p}")`;
    const swift: Guide = {
        id: "swift",
        label: "SwiftUI",
        steps: [
            {
                text: "Add the Swift package, then start it in your `App`'s `init()`:",
                code: token
                    ? `import Notato\n\n#if DEBUG\nvar notato = ${swiftConfig}\nnotato.token = "${token}"\nNotato.start(notato)\n#endif`
                    : `import Notato\n\n#if DEBUG\nNotato.start(${swiftConfig})\n#endif`,
            },
        ],
        notes: token
            ? ["Or set `Project`, `Server` and `Token` in a `Notato` dictionary in Info.plist."]
            : [
                  "Allow plain http to your Mac: `NSAppTransportSecurity` → `NSAllowsLocalNetworking` = YES in Info.plist.",
                  "The simulator shares this Mac's network, so localhost works there; a phone cannot reach it.",
              ],
    };

    const android: Guide = {
        id: "android",
        label: "Android",
        steps: [
            {
                text: "Add it to debug builds, in `app/build.gradle.kts`:",
                code: `dependencies {\n    debugImplementation("dev.notato:notato-compose:${t.version ?? "+"}") // notato-android for Views only\n}`,
            },
            {
                text: "Start it in your `Application`'s `onCreate()`:",
                code: `Notato.start(this, NotatoConfig(project = "${p}"${otherServer ? `, server = "${server}"` : ""}${token ? `, token = "${token}"` : ""}))`,
            },
        ],
        notes: token
            ? []
            : [
                  `\`${adbReverse}\` makes this server localhost on the emulator or a USB phone. A debug network security config has to allow cleartext to localhost.`,
              ],
    };

    return [react, angular, reactNative, flutter, page, maui, swift, android];
}

// ---- coding agents: MCP over HTTP at /mcp ------------------------------------------------------------------------

export type AgentClient = "claude" | "codex" | "cursor" | "gemini" | "vscode" | "other";

export interface AgentTarget {
    /** Where agents reach the MCP: `http://localhost:4747/mcp` in dev mode, the board's own address on a shared server. */
    url: string;
    /** A shared server: an agent sends a token (an agent token for every project, or one project's). */
    needsToken: boolean;
}

const jsonBlock = (value: unknown) => JSON.stringify(value, null, 2);

/** How to point each coding agent at this server's MCP, in each one's own words (its CLI or its config file). */
export function agentGuides(t: AgentTarget): Guide<AgentClient>[] {
    const url = t.url;
    const bearer = `Bearer ${TOKEN_PLACEHOLDER}`;
    const headers = t.needsToken ? { headers: { Authorization: bearer } } : {};
    const tokenNote = t.needsToken
        ? [
              `Put a token where it says \`${TOKEN_PLACEHOLDER}\`: an agent token (for every project) from Tokens, or one project's token to give the agent only that project.`,
          ]
        : [];

    const claude: Guide<AgentClient> = {
        id: "claude",
        label: "Claude Code",
        steps: [
            {
                text: "Add it once, for every project on this computer:",
                code: `claude mcp add --transport http --scope user notato ${url}${t.needsToken ? ` --header "Authorization: ${bearer}"` : ""}`,
            },
        ],
        notes: [
            ...tokenNote,
            "Leave out `--scope user` to add it to the current project only. Then ask Claude to watch Notato and fix what comes in.",
        ],
    };

    const codex: Guide<AgentClient> = {
        id: "codex",
        label: "Codex",
        steps: [
            {
                text: "Add it to `~/.codex/config.toml`:",
                code: `[mcp_servers.notato]\nurl = "${url}"${t.needsToken ? '\nbearer_token_env_var = "NOTATO_TOKEN"' : ""}`,
            },
        ],
        notes: t.needsToken
            ? [
                  "Set `NOTATO_TOKEN` to the token where Codex runs, so it is not written in the file.",
                  "Codex keeps one list of MCP servers for every project.",
              ]
            : ["Codex keeps one list of MCP servers for every project."],
    };

    const cursor: Guide<AgentClient> = {
        id: "cursor",
        label: "Cursor",
        steps: [
            {
                text: "Add it to `~/.cursor/mcp.json` for every project, or `.cursor/mcp.json` for one:",
                code: jsonBlock({ mcpServers: { notato: { url, ...headers } } }),
            },
        ],
        notes: [
            ...tokenNote,
            "A file that already lists other servers keeps them: add `notato` beside them.",
        ],
    };

    const gemini: Guide<AgentClient> = {
        id: "gemini",
        label: "Gemini CLI",
        steps: [
            {
                text: "Add it to `~/.gemini/settings.json` for every project, or `.gemini/settings.json` for one:",
                code: jsonBlock({ mcpServers: { notato: { httpUrl: url, ...headers } } }),
            },
        ],
        notes: [
            ...tokenNote,
            "`httpUrl` is Gemini CLI's name for an MCP server over HTTP (`url` would be the older SSE kind).",
        ],
    };

    const vscode: Guide<AgentClient> = {
        id: "vscode",
        label: "VS Code",
        steps: [
            {
                text: "For GitHub Copilot, add it to `.vscode/mcp.json` in the project:",
                code: jsonBlock({ servers: { notato: { type: "http", url, ...headers } } }),
            },
        ],
        notes: [
            ...tokenNote,
            "Or run MCP: Add Server… from the command palette, choose HTTP, and give it the address.",
        ],
    };

    const other: Guide<AgentClient> = {
        id: "other",
        label: "Other",
        steps: [
            {
                text: "Any agent whose MCP client speaks streamable HTTP takes this address:",
                code: url,
            },
            ...(t.needsToken
                ? [{ text: "With this header:", code: `Authorization: ${bearer}` }]
                : []),
        ],
        notes: [
            ...tokenNote,
            "An agent that only starts MCP servers as commands can run `npx notato dev` instead: it uses this server when it is running, and starts one when it is not.",
        ],
    };

    // Several repositories can share one server: an agent added for one of them is kept to its own app.
    const scopeNote = `Several apps on this server? Add the agent in each repository with \`?project=<id>\` on the address (\`${url}?project=shop\`), so it is handed only that project's notes.`;
    const guides = [claude, codex, cursor, gemini, vscode, other];
    for (const guide of guides) if (guide.id !== "codex") guide.notes.push(scopeNote);
    return guides;
}
