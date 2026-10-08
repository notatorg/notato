// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { ServerInfo } from "../src/ui/settings-panel.ts";
import type { ConnectionState } from "../src/ui/toolbar.ts";
import {
    button,
    checked,
    deferred,
    dialog,
    field,
    info,
    layer,
    links,
    mount,
    nameInput,
    openServer,
    panel,
    radios,
    root,
    settings,
    sw,
    text,
    tick,
    title,
    useSettingsPanel,
} from "./support/settings-panel.ts";

useSettingsPanel();

describe("the server view", () => {
    it("has no way into it when there is no server", () => {
        mount();
        panel.open();
        expect(root().querySelector(".snav")).toBeNull();
        expect(text()).not.toContain("Coding agent");
        expect(text()).not.toContain("npx notato init");
    });

    it("is reached from a row on the main view, and replaces it", async () => {
        mount({ server: links() });
        panel.open();
        expect(button("Server and agent")).toBeDefined();
        button("Server and agent").click();
        expect(title()).toBe("Server and agent");
        expect(root().querySelector('button[aria-label="Back"]')).not.toBeNull();
        expect(root().querySelector("input")).toBeNull();
        expect(root().querySelector('[role="switch"]')).toBeNull();
        expect(text()).toContain("npx notato init");
        await tick();
    });

    it("the back arrow returns to the main view", async () => {
        await openServer();
        root().querySelector<HTMLButtonElement>('button[aria-label="Back"]')?.click();
        expect(title()).toBe("Notato settings");
        expect(root().querySelector('button[aria-label="Back"]')).toBeNull();
        expect(nameInput()).not.toBeNull();
        expect(sw("Component names")).not.toBeNull();
        expect(dialog()).not.toBeNull();
    });

    it("the main view shows what was changed before going away and back", async () => {
        mount({ server: links() });
        panel.open();
        radios("Pin colour")
            .find((b) => b.getAttribute("aria-label") === "Orange")
            ?.click();
        sw("Component names").click();
        button("Server and agent").click();
        await tick();
        root().querySelector<HTMLButtonElement>('button[aria-label="Back"]')?.click();
        expect(checked("Pin colour")).toEqual(["Orange"]);
        expect(sw("Component names").getAttribute("aria-checked")).toBe("false");
    });

    it("can still be closed from the server view", async () => {
        await openServer();
        field<HTMLButtonElement>('button[aria-label="Close settings"]').click();
        expect(dialog()).toBeNull();
    });

    describe("connection", () => {
        it.each<[ConnectionState, string]>([
            ["connected", "Connected"],
            ["connecting", "Connecting…"],
            ["offline", "Cannot reach it"],
        ])("says %s as “%s”, and marks the dot with the state", async (state, word) => {
            await openServer({ connection: () => state });
            expect(field(".sdot").getAttribute("data-state")).toBe(state);
            expect(root().querySelector(".sfield .slabel")?.textContent?.trim()).toBe(word);
        });

        it("shows where the server is and which project this is", async () => {
            await openServer({ url: "http://localhost:5252", project: "marketing-site" });
            expect(text()).toContain("http://localhost:5252 · project marketing-site");
        });
    });

    describe("what the server says about itself", () => {
        it("shows that it is checking until the server answers", async () => {
            const answer = deferred<ServerInfo | null>();
            mount({ server: links({ status: () => answer.promise }) });
            panel.open();
            button("Server and agent").click();
            expect(text()).toContain("Checking…");
            answer.resolve(info());
            await tick();
            expect(text()).not.toContain("Checking…");
        });

        it("then lists the version, mode, pages and screenshots", async () => {
            await openServer();
            expect(text()).toContain(
                "Notato 0.3.1 · dev mode · 2 pages connected · screenshots on"
            );
        });

        it("says one page rather than one pages, and shows none as 0", async () => {
            await openServer({ status: async () => info({ pages: 1, screenshots: "off" }) });
            expect(text()).toContain("1 page connected · screenshots off");
            expect(text()).not.toContain("1 pages");
            panel.destroy();
            settings.destroy();
            await openServer({ status: async () => info({ pages: 0 }) });
            expect(text()).toContain("0 pages connected");
        });

        it("leaves out what the server did not tell", async () => {
            await openServer({ status: async () => ({ version: "0.3.1" }) });
            expect(text()).toContain("Notato 0.3.1");
            expect(text()).not.toContain("mode");
            expect(text()).not.toContain("connected ·");
            expect(text()).not.toContain("screenshots on");
        });

        it("says so when the server did not answer", async () => {
            await openServer({ status: async () => null });
            expect(text()).toContain("The server did not answer.");
            expect(text()).not.toContain("Checking…");
        });
    });

    describe("the coding agent", () => {
        // The last field of the server view is the agent's.
        const claude = () =>
            [...root().querySelectorAll<HTMLElement>(".sfield")].at(-1) as HTMLElement;

        it("says how to set Notato up for an agent until the server says one is there", async () => {
            const answer = deferred<ServerInfo | null>();
            mount({ server: links({ status: () => answer.promise }) });
            panel.open();
            button("Server and agent").click();
            expect(claude().textContent).toContain("npx notato init");
            answer.resolve(info());
            await tick();
            expect(claude().textContent).toContain("npx notato init");
            expect(claude().textContent).not.toContain("Connected");
        });

        it("says so when an agent is connected and watching, and how to keep things from it", async () => {
            await openServer({
                status: async () => info({ agent: { connected: true, watching: true } }),
            });
            expect(claude().querySelector(".shelp.ok")?.textContent).toBe(
                "Connected, and watching for notes."
            );
            expect(claude().textContent).toContain("Everything you write reaches it.");
            expect(claude().textContent).toContain("People only");
            expect(claude().textContent).not.toContain("@agent");
            expect(claude().textContent).not.toContain("npx notato init");
            expect(claude().textContent).not.toContain("Ask it to watch");
        });

        it("asks for a watch when an agent is connected but not watching", async () => {
            await openServer({
                status: async () => info({ agent: { connected: true, watching: false } }),
            });
            expect(claude().querySelector(".shelp.ok")?.textContent).toBe(
                "Connected, not watching for notes yet."
            );
            expect(claude().textContent).toContain(
                "Ask it to watch Notato, or use the notato skill."
            );
            expect(claude().textContent).toContain("Everything you write reaches it.");
        });

        it("shows how to register it when no agent is connected, or the server did not answer", async () => {
            await openServer({
                status: async () => info({ agent: { connected: false, watching: false } }),
            });
            expect(claude().textContent).toContain("npx notato init");
            expect(claude().textContent).not.toContain("Everything you write reaches it.");
            panel.destroy();
            settings.destroy();
            await openServer({ status: async () => null });
            expect(claude().textContent).toContain("npx notato init");
        });

        it("names the agents the server says are connected, and is a coding agent until it knows", async () => {
            await openServer({
                status: async () =>
                    info({ agent: { connected: true, watching: true, names: ["Codex"] } }),
            });
            expect(claude().querySelector(".slabel")?.textContent).toBe("Codex");
            panel.destroy();
            settings.destroy();
            await openServer({
                status: async () => info({ agent: { connected: false, watching: false } }),
            });
            expect(claude().querySelector(".slabel")?.textContent).toBe("Coding agent");
            expect(claude().textContent).toContain("Claude Code, Codex, Cursor");
        });

        it("has nothing about webhooks: they are set up on the server", async () => {
            await openServer({
                status: async () => info({ agent: { connected: true, watching: true } }),
            });
            expect(text().toLowerCase()).not.toContain("webhook");
        });
    });

    describe("leaving before the server has answered", () => {
        it("going back does not throw, and the answer does not land in the main view", async () => {
            const status = deferred<ServerInfo | null>();
            mount({ server: links({ status: () => status.promise }) });
            panel.open();
            button("Server and agent").click();
            const checking = [...root().querySelectorAll(".shelp")].find(
                (n) => n.textContent === "Checking…"
            ) as Element;
            expect(checking).toBeDefined();
            root().querySelector<HTMLButtonElement>('button[aria-label="Back"]')?.click();
            const before = root().innerHTML;

            status.resolve(info({ agent: { connected: true, watching: true } }));
            await tick();

            expect(checking.textContent).toBe("Checking…");
            expect(root().innerHTML).toBe(before);
            expect(title()).toBe("Notato settings");
            expect(text()).not.toContain("watching for notes");
        });

        it("closing the panel does not throw, and nothing is written into the page", async () => {
            const status = deferred<ServerInfo | null>();
            mount({ server: links({ status: () => status.promise }) });
            panel.open();
            button("Server and agent").click();
            const gone = root();
            panel.close();
            status.resolve(info({ agent: { connected: true, watching: true } }));
            await tick();
            expect(dialog()).toBeNull();
            expect(layer.childElementCount).toBe(0);
            expect(gone.textContent).not.toContain("Notato 0.3.1");
            expect(gone.textContent).not.toContain("watching for notes");
        });

        it("an answer that comes after leaving and coming back does not mix into the new view", async () => {
            const first = deferred<ServerInfo | null>();
            const second = deferred<ServerInfo | null>();
            const answers = [first, second];
            const status = vi.fn(() => (answers.shift() as typeof first).promise);
            mount({ server: links({ status }) });
            panel.open();
            button("Server and agent").click();
            root().querySelector<HTMLButtonElement>('button[aria-label="Back"]')?.click();
            button("Server and agent").click();
            expect(status).toHaveBeenCalledTimes(2);

            first.resolve(
                info({ version: "0.0.1-old", agent: { connected: true, watching: true } })
            );
            await tick();
            expect(text()).not.toContain("0.0.1-old");
            expect(text()).not.toContain("watching for notes");
            second.resolve(info({ version: "0.3.2" }));
            await tick();
            expect(text()).toContain("Notato 0.3.2");
            expect(text()).not.toContain("0.0.1-old");
            expect(text()).toContain("npx notato init");
        });
    });
});
