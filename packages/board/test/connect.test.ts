import { describe, expect, it } from "bun:test";
import {
    type AgentClient,
    agentGuides,
    connectGuides,
    type Guide,
    type Platform,
    TOKEN_PLACEHOLDER,
} from "../src/connect.ts";

const guides = (...args: Parameters<typeof connectGuides>) =>
    Object.fromEntries(connectGuides(...args).map((g) => [g.id, g])) as Record<
        Platform,
        ReturnType<typeof connectGuides>[number]
    >;
const code = (g: Guide<string>) => g.steps.flatMap((s) => (s.code ? [s.code] : [])).join("\n");
const text = (g: Guide<string>) =>
    [...g.steps.map((s) => `${s.text} ${s.link?.href ?? ""}`), ...g.notes].join("\n");

describe("connecting an app to a shared server", () => {
    const g = guides({
        server: "https://notato.example.com",
        project: "checkout-web",
        needsToken: true,
        token: "pft_abc-123",
    });

    it("fills in the server, the project and the token in every SDK's own words", () => {
        expect(code(g.react)).toContain(
            '<Notato project="checkout-web" server="https://notato.example.com" token="pft_abc-123" enabled />'
        );
        expect(code(g.angular)).toContain(
            'provideNotato({ project: "checkout-web", server: "https://notato.example.com", token: "pft_abc-123", enabled: true })'
        );
        expect(code(g["react-native"])).toContain(
            '<Notato project="checkout-web" server="https://notato.example.com" token="pft_abc-123" enabled storage={expoStorage}>'
        );
        expect(code(g.maui)).toContain('options.Project = "checkout-web";');
        expect(code(g.maui)).toContain('options.Server = "https://notato.example.com";');
        expect(code(g.maui)).toContain('options.Token = "pft_abc-123";');
        expect(code(g.swift)).toContain(
            'NotatoConfiguration(project: "checkout-web", server: URL(string: "https://notato.example.com"))'
        );
        expect(code(g.swift)).toContain('notato.token = "pft_abc-123"');
        expect(code(g.android)).toContain(
            'NotatoConfig(project = "checkout-web", server = "https://notato.example.com", token = "pft_abc-123")'
        );
        expect(code(g.page)).toBe(
            '<script src="https://notato.example.com/inject.js?project=checkout-web&token=pft_abc-123"></script>'
        );
        expect(g.page.steps[0]?.link?.href).toBe(
            "/bookmarklet?project=checkout-web&token=pft_abc-123"
        );
    });

    it("puts a placeholder where the token goes when the board does not have it", () => {
        const later = guides({
            server: "https://notato.example.com",
            project: "checkout-web",
            needsToken: true,
            token: null,
        });
        expect(code(later.react)).toContain(`token="${TOKEN_PLACEHOLDER}"`);
        expect(code(later.maui)).toContain(`options.Token = "${TOKEN_PLACEHOLDER}";`);
        // A link never carries a placeholder: the bookmark page is told how to add one.
        expect(later.page.steps[0]?.link?.href).toBe("/bookmarklet?project=checkout-web");
        expect(text(later.page)).toContain("&token=<the token>");
    });
});

describe("the version a snippet asks for", () => {
    it("is the server's, which every SDK shares, and Gradle's newest when it is not known", () => {
        const at = (version?: string) =>
            code(
                guides({
                    server: "http://localhost:4747",
                    project: "shop",
                    needsToken: false,
                    token: null,
                    version,
                }).android
            );
        expect(at("0.2.0")).toContain('debugImplementation("dev.notato:notato-compose:0.2.0")');
        expect(at()).toContain('debugImplementation("dev.notato:notato-compose:+")');
    });
});

describe("connecting an app on this computer", () => {
    it("needs no token, and no server where the SDKs already look", () => {
        const g = guides({
            server: "http://localhost:4747",
            project: "shop",
            needsToken: false,
            token: null,
        });
        const all = Object.values(g).map(code).join("\n");
        expect(all).not.toContain("token");
        expect(all).not.toContain("Token");
        expect(code(g.react)).toContain(
            '{import.meta.env.DEV && <Notato project="shop" server="http://localhost:4747" />}'
        );
        expect(code(g.angular)).toContain('provideNotato({ project: "shop" })');
        expect(code(g["react-native"])).toContain('<Notato project="shop" storage={expoStorage}>');
        expect(code(g.flutter)).toContain("runApp(Notato(project: 'shop', child: const MyApp()));");
        expect(text(g["react-native"])).toContain("adb reverse tcp:4747 tcp:4747");
        expect(code(g.maui)).toContain('builder.UseNotato(options => options.Project = "shop");');
        expect(code(g.swift)).toContain('Notato.start(NotatoConfiguration(project: "shop"))');
        expect(code(g.android)).toContain('Notato.start(this, NotatoConfig(project = "shop"))');
        expect(text(g.android)).toContain("adb reverse tcp:4747 tcp:4747");
    });

    it("says where the server is when it is on another port, and forwards that port", () => {
        const g = guides({
            server: "http://localhost:4802/",
            project: "shop",
            needsToken: false,
            token: null,
        });
        expect(code(g.maui)).toContain('options.Server = "http://localhost:4802";');
        expect(code(g.swift)).toContain('server: URL(string: "http://localhost:4802")');
        expect(code(g.android)).toContain('server = "http://localhost:4802"');
        expect(text(g.android)).toContain("adb reverse tcp:4802 tcp:4802");
        // The tunnel only takes over when Server is left out.
        expect(text(g.maui)).toContain("leave `Server` out");
        expect(code(g.page)).toBe(
            '<script src="http://localhost:4802/inject.js?project=shop"></script>'
        );
    });
});

describe("connecting a coding agent", () => {
    const byId = (...args: Parameters<typeof agentGuides>) =>
        Object.fromEntries(agentGuides(...args).map((g) => [g.id, g])) as Record<
            AgentClient,
            ReturnType<typeof agentGuides>[number]
        >;
    const local = byId({ url: "http://localhost:4747/mcp", needsToken: false });
    const shared = byId({ url: "https://notato.example.com/mcp", needsToken: true });

    it("says how to keep an agent to one app's notes, except where one list serves every folder", () => {
        for (const id of ["claude", "cursor", "gemini", "vscode", "other"] as const)
            expect(text(local[id])).toContain("`http://localhost:4747/mcp?project=shop`");
        expect(text(local.codex)).not.toContain("?project=");
    });

    it("gives each agent the address in its own words, with no token on this computer", () => {
        expect(code(local.claude)).toBe(
            "claude mcp add --transport http --scope user notato http://localhost:4747/mcp"
        );
        expect(code(local.codex)).toBe('[mcp_servers.notato]\nurl = "http://localhost:4747/mcp"');
        expect(JSON.parse(code(local.cursor))).toEqual({
            mcpServers: { notato: { url: "http://localhost:4747/mcp" } },
        });
        expect(JSON.parse(code(local.gemini))).toEqual({
            mcpServers: { notato: { httpUrl: "http://localhost:4747/mcp" } },
        });
        expect(JSON.parse(code(local.vscode))).toEqual({
            servers: { notato: { type: "http", url: "http://localhost:4747/mcp" } },
        });
        expect(code(local.other)).toBe("http://localhost:4747/mcp");
        for (const g of Object.values(local)) expect(text(g)).not.toContain(TOKEN_PLACEHOLDER);
    });

    it("adds the token on a shared server, kept out of Codex's file", () => {
        expect(code(shared.claude)).toContain(
            `--header "Authorization: Bearer ${TOKEN_PLACEHOLDER}"`
        );
        expect(code(shared.codex)).toContain('bearer_token_env_var = "NOTATO_TOKEN"');
        expect(code(shared.codex)).not.toContain(TOKEN_PLACEHOLDER);
        for (const id of ["cursor", "gemini", "vscode"] as const) {
            const parsed = JSON.parse(code(shared[id])) as Record<
                string,
                { notato: { headers?: Record<string, string> } }
            >;
            const server = (parsed.mcpServers ?? parsed.servers)?.notato;
            expect(server?.headers, id).toEqual({
                Authorization: `Bearer ${TOKEN_PLACEHOLDER}`,
            });
        }
        expect(code(shared.other)).toContain(`Authorization: Bearer ${TOKEN_PLACEHOLDER}`);
    });
});
