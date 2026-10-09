import { afterEach, describe, expect, it, vi } from "vitest";
import { NotatoError } from "../../src/client.ts";
import { NotatoController } from "../../src/controller.ts";
import { memoryStorage } from "../../src/storage.ts";
import { fakeHost, fakeServer, start } from "./harness.ts";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("runtime choices", () => {
    it("are remembered across launches (on, off, the toolbar, a name), until reset", () => {
        const storage = memoryStorage();
        const first = start({ project: "shop" }, fakeServer(), storage).notato;
        first.disable();
        first.hideToolbar();
        expect(
            first.saveSettings({ name: "Dom", screenshots: false, server: "ftp://nope" })
        ).toMatch(/not an http/);
        const second = start({ project: "shop" }, fakeServer(), storage).notato;
        expect(second.getState()).toMatchObject({
            enabled: false,
            toolbarVisible: false,
            author: "Dom",
            screenshots: false,
        });
        second.resetRuntimeState();
        expect(second.getState()).toMatchObject({
            enabled: true,
            toolbarVisible: true,
            screenshots: true,
        });
        expect(second.getState().author).toBeUndefined();
    });

    it("leave Notato off when a server is typed in while it is off", () => {
        const { notato, server } = start({ project: "shop" });
        notato.disable();
        const follows = vi.mocked(server.transport.follow).mock.calls.length;
        notato.saveSettings({ name: "", screenshots: true, server: "http://localhost:4798" });
        expect(notato.getState()).toMatchObject({
            enabled: false,
            connection: "disabled",
            server: "http://localhost:4798",
        });
        expect(server.transport.follow).toHaveBeenCalledTimes(follows);
        notato.enable();
        expect(vi.mocked(server.transport.follow).mock.calls.at(-1)?.[0].server).toBe(
            "http://localhost:4798"
        );
    });
});

describe("configuration", () => {
    it("keeps Notato off with a project id the server would refuse", () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const { notato } = start({ project: "../etc" });
        expect(notato.getState()).toMatchObject({ enabled: false });
        expect(notato.getState().problem).toMatch(/may only use letters/);
    });

    it("wraps the console only while captureLogs asks for it, as the option changes", () => {
        const original = console.warn;
        const { notato } = start({ project: "shop", captureLogs: true });
        expect(console.warn).not.toBe(original);
        notato.configure({ project: "shop", enabled: true, captureLogs: false });
        expect(console.warn).toBe(original);
        notato.configure({ project: "shop", enabled: true, captureLogs: true });
        expect(console.warn).not.toBe(original);
        notato.disable();
        expect(console.warn).toBe(original);
    });

    it("keeps notes in memory when the app's storage cannot be opened", async () => {
        const notato = new NotatoController(fakeServer().transport);
        notato.attachHost(fakeHost());
        notato.configure({
            project: "shop",
            mode: "test",
            enabled: true,
            captureLogs: false,
            storage: {
                open: () => {
                    throw new Error("no documents folder");
                },
            },
        });
        await notato.annotate("Text", "Kept anyway");
        expect(notato.getState()).toMatchObject({ enabled: true, pendingCount: 1 });
    });
});

describe("the token", () => {
    it("goes only to the configured server, never to one typed into the settings", () => {
        const server = fakeServer();
        const { notato } = start(
            { project: "shop", server: "http://localhost:4799", token: "notato_secret" },
            server
        );
        const follow = vi.mocked(server.transport.follow);
        expect(follow.mock.calls.at(-1)?.[0]).toMatchObject({
            server: "http://localhost:4799",
            token: "notato_secret",
        });
        notato.saveSettings({ name: "", screenshots: true, server: "http://evil.example.com" });
        expect(follow.mock.calls.at(-1)?.[0].server).toBe("http://evil.example.com");
        expect(follow.mock.calls.at(-1)?.[0].token).toBeUndefined();
    });
});

describe("mounting", () => {
    const config = { project: "shop", enabled: true, captureLogs: false };

    it("starts again when <Notato> mounts again with the same options, as React's StrictMode does", () => {
        const notato = new NotatoController(fakeServer().transport);
        const first = notato.attach();
        notato.configure(config);
        expect(notato.getState().enabled).toBe(true);
        // StrictMode: the effects' clean-up, then the effects again.
        notato.detach(first);
        expect(notato.getState()).toMatchObject({ enabled: false, connection: "disabled" });
        const second = notato.attach();
        notato.configure(config);
        expect(notato.getState()).toMatchObject({ enabled: true, connection: "connecting" });
        // The first one going again changes nothing; the one mounted now does.
        notato.detach(first);
        expect(notato.getState().enabled).toBe(true);
        notato.detach(second);
        expect(notato.getState().enabled).toBe(false);
    });

    it("leaves Notato to a <Notato> mounted before the old one went, and keeps the notes it had", async () => {
        const server = fakeServer();
        server.failWith(new NotatoError("cannot reach the Notato server"));
        const notato = new NotatoController(server.transport);
        notato.attachHost(fakeHost());
        const old = notato.attach();
        notato.configure(config);
        await notato.annotate("Text", "Kept");
        const replacement = notato.attach();
        notato.configure(config);
        notato.detach(old);
        expect(notato.getState()).toMatchObject({ enabled: true, pendingCount: 1 });
        // Unmounted, then mounted again: the note not sent yet is still there, in memory storage too.
        notato.detach(replacement);
        notato.attach();
        notato.configure(config);
        expect(notato.getState()).toMatchObject({ enabled: true, pendingCount: 1 });
    });

    it("forgets an overlay only when it is still the one attached", async () => {
        const notato = new NotatoController(fakeServer().transport);
        const old = fakeHost();
        notato.attachHost(old);
        notato.attachHost(fakeHost());
        notato.detachHost(old);
        notato.configure(config);
        await expect(notato.annotate("Text", "Still here")).resolves.toMatchObject({
            comment: "Still here",
        });
    });
});

describe("the toolbar's state", () => {
    it("is the same object until the toolbar moves, and a fold can move it across in the same change", () => {
        const { notato } = start({ project: "shop" }, fakeServer());
        const before = notato.getState().toolbar;
        notato.startAnnotating();
        notato.stopAnnotating();
        expect(notato.getState().toolbar).toBe(before);
        let draws = 0;
        const stop = notato.subscribe(() => draws++);
        notato.setFolded(true, 0.8);
        stop();
        expect(draws).toBe(1);
        expect(notato.getState().toolbar).toEqual({ x: 0.8, folded: true });
        expect(notato.getState().toolbar).not.toBe(before);
    });
});
