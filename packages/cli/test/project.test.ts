import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Authenticator, runServe, type ServeRuntime, SqliteStore } from "@notato/server";
import { runProjectCommand } from "../src/commands/project.ts";
import { runTokenCommand } from "../src/commands/token.ts";
import { removeTempDirs, tempDir } from "./helpers.ts";

const serves: ServeRuntime[] = [];
let out: string[] = [];
let err: string[] = [];
beforeEach(() => {
    out = [];
    err = [];
    spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        out.push(args.join(" "));
    });
    spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        err.push(args.join(" "));
    });
});
afterEach(async () => {
    (console.log as unknown as { mockRestore(): void }).mockRestore();
    (console.error as unknown as { mockRestore(): void }).mockRestore();
    for (const s of serves.splice(0)) await s.stop();
    removeTempDirs();
});

const tmp = () => tempDir("notato-project-");

/** Reads the data directory the way a server would. */
async function inStore<T>(dir: string, read: (store: SqliteStore) => Promise<T>): Promise<T> {
    const store = new SqliteStore(join(dir, "notato.db"));
    try {
        return await read(store);
    } finally {
        store.close();
    }
}

describe("notato project", () => {
    it("creates a project and prints its first app token, which a shared server accepts", async () => {
        const dir = tmp();
        expect(
            await runProjectCommand(["create", "checkout-web", "--name", "Checkout", "-d", dir])
        ).toBe(0);
        const token = out[0] ?? "";
        expect(token).toMatch(/^pft_/);
        expect(err.join()).toContain("shown once");

        const rt = await runServe({
            port: 0,
            dir,
            version: "t",
            adminPassword: "pw",
            log: () => {},
        });
        serves.push(rt);
        expect((await rt.store.getProject("checkout-web"))?.name).toBe("Checkout");
        const me = await fetch(`http://127.0.0.1:${rt.port}/auth/me`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(await me.json()).toMatchObject({ authenticated: true, projectId: "checkout-web" });
    });

    it("refuses an id the server would not take, and one that exists", async () => {
        const dir = tmp();
        await expect(runProjectCommand(["create", "..", "-d", dir])).rejects.toThrow("project id");
        await expect(runProjectCommand(["create", "a/b", "-d", dir])).rejects.toThrow("project id");
        await runProjectCommand(["create", "shop", "-d", dir]);
        await expect(runProjectCommand(["create", "shop", "-d", dir])).rejects.toThrow(
            "notato token create shop"
        );
    });

    it("lists projects, empty ones included, and renames one", async () => {
        const dir = tmp();
        await runProjectCommand(["list", "-d", dir]);
        expect(out).toEqual(["no projects"]);
        out = [];
        await runProjectCommand(["create", "shop", "-d", dir]);
        out = [];
        expect(await runProjectCommand(["rename", "shop", "The", "Shop", "-d", dir])).toBe(0);
        await runProjectCommand(["list", "-d", dir]);
        expect(out[0]).toContain('shop\t"The Shop"\t0 notes (0 open)');
        await expect(runProjectCommand(["rename", "nope", "x", "-d", dir])).rejects.toThrow(
            'no project "nope"'
        );
    });

    it("deletes a project with its notes and tokens, after saying what goes", async () => {
        const dir = tmp();
        await runProjectCommand(["create", "shop", "-d", dir]);
        const token = out[0] ?? "";
        const rt = await runServe({
            port: 0,
            dir,
            version: "t",
            adminPassword: "pw",
            log: () => {},
        });
        serves.push(rt);
        const { sampleAnnotation } = await import("@notato/schema");
        await rt.backend.ingest(
            { ...sampleAnnotation, projectId: "shop", screenshots: undefined },
            new Map()
        );
        await rt.stop();
        serves.length = 0;

        const asked: string[] = [];
        const no = await runProjectCommand(["delete", "shop", "-d", dir], {
            confirm: async (q) => {
                asked.push(q);
                return false;
            },
        });
        expect(no).toBe(1);
        expect(asked[0]).toContain("1 note (1 open)");
        expect(asked[0]).toContain("its token will stop working");
        expect(await inStore(dir, (s) => s.getProject("shop"))).not.toBeNull();

        expect(
            await runProjectCommand(["delete", "shop", "-d", dir], { confirm: async () => true })
        ).toBe(0);
        expect(await inStore(dir, (s) => s.getProject("shop"))).toBeNull();
        expect(await inStore(dir, (s) => s.listAnnotations())).toEqual([]);
        const url = "http://127.0.0.1/annotations";
        const who = await inStore(dir, (s) =>
            new Authenticator(s).identify(
                new Request(url, { headers: { Authorization: `Bearer ${token}` } }),
                new URL(url)
            )
        );
        expect(who).toBeNull();
        expect(
            (await inStore(dir, (s) => s.listTokens())).every((t) => t.revokedAt !== undefined)
        ).toBe(true);
    });

    it("will not delete without asking unless told --yes", async () => {
        const dir = tmp();
        await runProjectCommand(["create", "shop", "-d", dir]);
        // No terminal here to ask in.
        await expect(runProjectCommand(["delete", "shop", "-d", dir])).rejects.toThrow("--yes");
        expect(await runProjectCommand(["delete", "shop", "--yes", "-d", dir])).toBe(0);
        expect(await inStore(dir, (s) => s.getProject("shop"))).toBeNull();
        await expect(runProjectCommand(["delete", "shop", "--yes", "-d", dir])).rejects.toThrow(
            'no project "shop"'
        );
    });
});

describe("notato token", () => {
    it("refuses a project that does not exist, and says how to create it", async () => {
        const dir = tmp();
        await expect(runTokenCommand(["create", "shop", "-d", dir])).rejects.toThrow(
            "notato project create shop"
        );
        await runProjectCommand(["create", "shop", "-d", dir]);
        out = [];
        expect(await runTokenCommand(["create", "shop", "-d", dir])).toBe(0);
        expect(out[0]).toMatch(/^pft_/);
        expect(await runTokenCommand(["create", "*", "-d", dir])).toBe(0);
    });

    it("rejects an unknown command before it opens, or creates, the data directory", async () => {
        const dir = join(tmp(), "data");
        await expect(runTokenCommand(["crate", "shop", "-d", dir])).rejects.toThrow(
            'unknown token command "crate"'
        );
        expect(existsSync(dir)).toBe(false);
    });
});
