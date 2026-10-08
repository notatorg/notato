import { describe, expect, it } from "bun:test";
import {
    analyzeFederation,
    classifyFederation,
    type FederatedApp,
    federationRole,
} from "../src/federation.ts";

// Shaped like a real Module Federation monorepo: a shell that loads its modules from a list, and modules
// that point back at the shell for its shared context.
const APP_SHELL = `
import federation from "@originjs/vite-plugin-federation";
export default defineConfig(({ mode }) => {
    // Generate remotes configuration from modules
    const remotes = Object.fromEntries(
        modules.map((module) => [module.id, env["VITE_" + module.id] || "http://localhost:5001/x.js"])
    );
    return {
        plugins: [
            federation({
                name: "appShell",
                remotes,
                exposes: {
                    "./permissions": "./src/contexts/PermissionContext.tsx",
                },
                shared: ["react", "react-dom"],
            }),
        ],
    };
});
`;

const ORDER_HISTORY = `
export default defineConfig({
    plugins: [
        federation({
            name: "orderHistory",
            filename: "remoteEntry.js",
            remotes: {
                appShell:
                    env.VITE_APP_SHELL_URL || "http://localhost:5000/assets/remoteEntry.js",
            },
            exposes: {
                "./App": "./src/App.tsx",
                "./routes": "./src/routes.tsx",
                "./pills": "./src/pills/index.ts",
            },
            shared: ["react"],
        }),
    ],
});
`;

const ACCOUNT_OVERVIEW = `
federation({
    name: "accountOverview",
    remotes: {
        // The shell's permissions context, which supplies the authenticated fetch
        // the organisations API is called through. {not a real brace
        appShell: env.URL || "http://localhost:5000/assets/remoteEntry.js",
    },
    exposes: {
        "./App": "./src/App.tsx",
        "./routes": "./src/routes.tsx",
    },
})
`;

const PUBLIC = `federation({ name: "publicPages", exposes: { "./App": "./src/App.tsx", "./routes": "./src/routes.tsx" } })`;

describe("analyzeFederation on real configs", () => {
    it("reads the shell: remotes are computed, so it loads a list of modules", () => {
        const info = analyzeFederation(APP_SHELL);
        expect(info).toEqual({
            present: true,
            dynamicRemotes: true,
            remoteKeys: [],
            exposes: ["./permissions"],
            name: "appShell",
        });
        expect(federationRole(info)).toBe("host");
    });

    it("reads a module that also declares the shell as its one remote: not a host", () => {
        const info = analyzeFederation(ORDER_HISTORY);
        expect(info).toEqual({
            present: true,
            dynamicRemotes: false,
            remoteKeys: ["appShell"],
            exposes: ["./App", "./routes", "./pills"],
            name: "orderHistory",
        });
        expect(federationRole(info)).toBe("remote");
    });

    it("is not fooled by an apostrophe or a brace inside a comment", () => {
        const info = analyzeFederation(ACCOUNT_OVERVIEW);
        expect(info.remoteKeys).toEqual(["appShell"]);
        expect(info.exposes).toEqual(["./App", "./routes"]);
        expect(federationRole(info)).toBe("remote");
    });

    it("a module that only exposes is a remote", () => {
        expect(federationRole(analyzeFederation(PUBLIC))).toBe("remote");
    });
});

describe("federationRole", () => {
    const role = (config: string) => federationRole(analyzeFederation(config));

    it("an app with no federation is standalone", () => {
        expect(role("export default { plugins: [react()] }")).toBe("standalone");
        expect(analyzeFederation("export default {}").present).toBe(false);
    });

    it("a consumer that exposes nothing is a host; one that also exposes routes is a module", () => {
        expect(role(`federation({ name: "s", remotes: { a: "x" } })`)).toBe("host");
        expect(
            role(`federation({ name: "s", remotes: { a: "x" }, exposes: { "./r": "y" } })`)
        ).toBe("remote");
        expect(
            role(`federation({ name: "s", remotes: { a: "x", b: "y" }, exposes: { "./r": "y" } })`)
        ).toBe("remote");
    });

    it("array remotes and remotes computed by a call are understood", () => {
        expect(role(`federation({ remotes: [{ name: "a" }, { name: "b" }] })`)).toBe("host");
        expect(role(`federation({ remotes: buildRemotes(env), exposes: { "./r": "y" } })`)).toBe(
            "host"
        );
    });

    it("a federation call with nothing declared is standalone", () => {
        expect(role("federation({ name: 'x', shared: ['react'] })")).toBe("standalone");
    });

    it("ignores the word 'remotes' outside the call", () => {
        expect(
            role(
                `const remotes = {}\n// remotes everywhere\nfederation({ name: "x", exposes: { "./a": "b" } })`
            )
        ).toBe("remote");
    });

    it("survives strings and quoted keys with commas and braces", () => {
        const info = analyzeFederation(
            `federation({ remotes: { "a-b": "http://x/{id},y", 'c': \`t\${1}\` }, exposes: {} })`
        );
        expect(info.remoteKeys).toEqual(["a-b", "c"]);
        expect(info.exposes).toEqual([]);
    });
});

describe("classifyFederation across several apps", () => {
    const app = (dirName: string, config: string): FederatedApp => ({
        id: dirName,
        dirName,
        info: analyzeFederation(config),
    });
    const module_ = (name: string, remotes: string[]) =>
        `federation({ name: "${name}", remotes: { ${remotes.map((r) => `${r}: "u"`).join(", ")} }, exposes: { "./routes": "r" } })`;

    it("in a bidirectional setup the shell is the one every module points at", () => {
        const roles = classifyFederation([
            app("app-shell", APP_SHELL),
            app("order-history", ORDER_HISTORY),
            app("account-overview", ACCOUNT_OVERVIEW),
            // A module that depends on two remotes must not look like the shell.
            app("organisation-management", module_("orgs", ["appShell", "orderHistory"])),
            app("public", PUBLIC),
            app("developer-portal", "export default {}"),
        ]);
        expect([...roles.entries()]).toEqual([
            ["app-shell", "host"],
            ["order-history", "remote"],
            ["account-overview", "remote"],
            ["organisation-management", "remote"],
            ["public", "remote"],
            ["developer-portal", "standalone"],
        ]);
    });

    it("in the classic setup the shell lists its modules and they list nothing", () => {
        const roles = classifyFederation([
            app("shell", `federation({ name: "shell", remotes: { billing: "u", reports: "u" } })`),
            app("billing", `federation({ name: "billing", exposes: { "./App": "a" } })`),
            app("reports", `federation({ name: "reports", exposes: { "./App": "a" } })`),
        ]);
        expect(roles.get("shell")).toBe("host");
        expect(roles.get("billing")).toBe("remote");
        expect(roles.get("reports")).toBe("remote");
    });

    it("matches remote keys to apps by federation name as well as folder name", () => {
        const roles = classifyFederation([
            app(
                "zeta",
                `federation({ name: "theShell", remotes: { mod: "u" }, exposes: { "./x": "y" } })`
            ),
            app(
                "alpha",
                `federation({ name: "mod", remotes: { theShell: "u" }, exposes: { "./x": "y" } })`
            ),
            app(
                "beta",
                `federation({ name: "b", remotes: { theShell: "u" }, exposes: { "./x": "y" } })`
            ),
        ]);
        expect(roles.get("zeta")).toBe("host");
    });

    it("does not guess when two apps tie: each keeps what its own config suggests", () => {
        const roles = classifyFederation([
            app("a", module_("a", ["b"])),
            app("b", module_("b", ["a"])),
        ]);
        expect([...roles.values()]).toEqual(["remote", "remote"]);
    });

    it("a single federated app, or none, uses its own config", () => {
        expect(
            classifyFederation([app("shell", APP_SHELL), app("plain", "export default {}")]).get(
                "shell"
            )
        ).toBe("host");
        expect(classifyFederation([app("m", PUBLIC)]).get("m")).toBe("remote");
        expect([...classifyFederation([app("plain", "export default {}")]).values()]).toEqual([
            "standalone",
        ]);
    });
});
