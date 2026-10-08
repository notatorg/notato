import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { describeApp, discoverApps, findGitRoot, findHostAbove } from "../src/discover.ts";
import { federatedRepo, INDEX, reactPkg } from "./federated-repo.ts";
import { removeTempDirs } from "./helpers.ts";

afterEach(removeTempDirs);

describe("discoverApps", () => {
    it("finds React apps and tells a federation host from its modules", () => {
        const root = federatedRepo();
        const apps = discoverApps(root);
        expect(apps.map((a) => [a.rel, a.role, a.framework])).toEqual([
            ["app-shell", "host", "vite"],
            ["developer-portal", "standalone", "vite"],
            ["order-history", "remote", "vite"],
        ]);
        expect(apps.find((a) => a.rel === "app-shell")?.hasNotato).toBe(false);
    });

    it("skips libraries without an index.html, node_modules and build output", () => {
        const root = federatedRepo({
            "dist/index.html": INDEX,
            "dist/package.json": reactPkg("built"),
        });
        expect(discoverApps(root).map((a) => a.rel)).not.toContain("packages/federation");
        expect(
            discoverApps(root)
                .map((a) => a.rel)
                .join()
        ).not.toContain("node_modules");
        expect(discoverApps(root).map((a) => a.rel)).not.toContain("dist");
    });

    it("finds apps inside workspace-style folders, and does not descend into an app", () => {
        const root = federatedRepo({
            "apps/billing/package.json": reactPkg("billing"),
            "apps/billing/index.html": INDEX,
            "app-shell/examples/nested/package.json": reactPkg("nested"),
            "app-shell/examples/nested/index.html": INDEX,
        });
        const rels = discoverApps(root).map((a) => a.rel);
        expect(rels).toContain("apps/billing");
        expect(rels).not.toContain("app-shell/examples/nested");
    });

    it("describes Next.js apps, and ignores a package without react", () => {
        const root = federatedRepo({
            "web/package.json": JSON.stringify({
                name: "web",
                dependencies: { react: "^19", next: "^15" },
            }),
            "tool/package.json": JSON.stringify({ name: "tool", devDependencies: { vite: "^7" } }),
            "tool/index.html": INDEX,
        });
        expect(describeApp(join(root, "web"))?.framework).toBe("next");
        expect(describeApp(join(root, "tool"))).toBeNull();
    });

    it("finds the git root and a host above a module", () => {
        const root = federatedRepo();
        expect(findGitRoot(join(root, "order-history/src"))).toBe(root);
        expect(findHostAbove(join(root, "order-history"))?.rel).toBe("app-shell");
        expect(findHostAbove(join(root, "developer-portal"))?.rel).toBe("app-shell");
    });
});
