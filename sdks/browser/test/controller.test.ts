// @vitest-environment happy-dom
import { type Annotation, sampleAnnotation } from "@notato/schema";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createController, type NotatoController } from "../src/controller.ts";
import { hoverLabel } from "../src/labels.ts";
import type { EventStream } from "../src/net.ts";
import type { NotatoProps } from "../src/types.ts";

const SERVER = "http://localhost:4801";
const mounted: NotatoController[] = [];

function mount(props: Partial<NotatoProps> = {}) {
    const controller = createController({
        project: "shop",
        screenshots: false,
        persist: false,
        ...props,
    });
    mounted.push(controller);
    return controller;
}
/** What a reload does: this toolbar goes, with nothing carried over in memory, and a new one starts. */
function reload(props: Partial<NotatoProps>) {
    mounted.pop()?.destroy();
    window.__notatoUnsent = undefined;
    return mount(props);
}

const ui = () =>
    (document.querySelector("[data-notato-root]") as HTMLElement).shadowRoot as ShadowRoot;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const until = async (check: () => boolean, what = "it") => {
    for (let i = 0; i < 200; i++) {
        if (check()) return;
        await settle();
    }
    throw new Error(`waited too long for ${what}`);
};

/** A stand-in for the Notato server, reached the way the extension reaches it: through the transport. */
function fakeServer() {
    const notes = new Map<string, Annotation>();
    const posts: string[] = [];
    const deletes: string[] = [];
    /** How many times the page read the whole list. */
    const reads = { count: 0 };
    const streams: Array<{ emit(type: string, data: unknown): void }> = [];
    const state = { up: true, refuse: undefined as { status: number; error: string } | undefined };
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (!state.up) throw new TypeError("Failed to fetch");
        const method = init?.method ?? "GET";
        const path = new URL(url).pathname;
        if (method === "POST" && path === "/projects/shop/annotations") {
            const annotation = JSON.parse(
                (init?.body as FormData | undefined)?.get("annotation") as string
            ) as Annotation;
            posts.push(annotation.id);
            if (state.refuse)
                return Response.json(
                    { error: state.refuse.error },
                    { status: state.refuse.status }
                );
            notes.set(annotation.id, annotation);
            return Response.json({ annotation }, { status: 201 });
        }
        const replying = /^\/annotations\/([^/]+)\/replies$/.exec(path);
        if (method === "POST" && replying) {
            const note = notes.get(decodeURIComponent(replying[1] ?? ""));
            if (!note) return Response.json({ error: "not found" }, { status: 404 });
            const said = JSON.parse(init?.body as string) as { body: string };
            const updated: Annotation = {
                ...note,
                thread: [
                    ...note.thread,
                    {
                        id: `r${note.thread.length + 1}`,
                        author: { kind: "human" },
                        body: said.body,
                        createdAt: new Date().toISOString(),
                    },
                ],
            };
            notes.set(updated.id, updated);
            return Response.json({ seq: 1, annotation: updated }, { status: 201 });
        }
        if (method === "GET" && path === "/projects/shop/annotations") reads.count += 1;
        if (method === "GET" && path === "/projects/shop/annotations")
            return Response.json({
                items: [...notes.values()].map((annotation, i) => ({ seq: i + 1, annotation })),
            });
        if (method === "DELETE") {
            const id = decodeURIComponent(path.split("/").pop() ?? "");
            deletes.push(id);
            return new Response(null, { status: notes.delete(id) ? 204 : 404 });
        }
        return Response.json({ screenshots: true });
    });
    const events = (): EventStream => {
        const listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
        streams.push({
            emit(type, data) {
                for (const listener of listeners.get(type) ?? [])
                    listener(new MessageEvent(type, { data: JSON.stringify(data) }));
            },
        });
        return {
            addEventListener: (type, listener) =>
                listeners.set(type, [...(listeners.get(type) ?? []), listener]),
            onerror: null,
            close: () => {},
            readyState: 1,
        };
    };
    return {
        notes,
        posts,
        deletes,
        reads,
        streams,
        state,
        transport: { fetch, events },
        /** The stream says hello: the page reads the list and sends what is waiting. */
        async hello() {
            await until(() => streams.length > 0, "the stream to open");
            streams.at(-1)?.emit("hello", { projectId: "shop" });
            await settle();
            await settle();
        },
        say(type: string, data: unknown) {
            streams.at(-1)?.emit(type, data);
        },
    };
}

beforeEach(() => {
    document.body.innerHTML = '<main><button id="pay">Pay</button><input id="q"></main>';
});
afterEach(() => {
    for (const controller of mounted.splice(0)) controller.destroy();
    window.__notatoUnsent = undefined;
    Reflect.deleteProperty(globalThis, "indexedDB");
    window.history.replaceState({}, "", "/");
    vi.restoreAllMocks();
});

describe("pin numbers", () => {
    it("are not handed out twice when an agent asks for two notes at once", async () => {
        // In view, so nothing waits for a scroll and the three really are made at the same time.
        for (const el of document.querySelectorAll("#pay, #q"))
            el.getBoundingClientRect = () =>
                ({ left: 10, top: 10, right: 60, bottom: 30, width: 50, height: 20 }) as DOMRect;
        const notato = mount({ mode: "agent" });
        const made = await Promise.all([
            notato.annotate({ target: "#pay", comment: "one" }),
            notato.annotate({ target: "#pay", comment: "two" }),
            notato.annotate({ target: "#q", comment: "three" }),
        ]);
        const pins = made.map((a) => (a.context.screenshot as { pin: number }).pin);
        expect(new Set(pins).size).toBe(3);
        expect(pins.sort()).toEqual([1, 2, 3]);
    });
});

describe("the URL a note records", () => {
    it("has secrets in the query and fragment blanked, and keeps the rest", async () => {
        window.history.replaceState(
            {},
            "",
            "/callback?code=4%2F0Ab&state=st8&tab=settings#access_token=ya29.secret"
        );
        const notato = mount({ mode: "agent" });
        const a = await notato.annotate({ target: "#pay", comment: "after login" });
        expect(a.url).toBe(
            `${window.location.origin}/callback?code=redacted&state=redacted&tab=settings#access_token=redacted`
        );
        expect(a.route).toBe("/callback"); // the route is as it always was
    });

    it("has secrets in a hash route blanked out of its route too", async () => {
        window.history.replaceState({}, "", "/#/reset?token=XYZ123abc&step=2");
        const notato = mount({ mode: "agent", hashRoutes: true });
        const a = await notato.annotate({ target: "#pay", comment: "reset page" });
        expect(a.route).toBe("/#/reset?token=redacted&step=2");
        expect(a.url).toContain("#/reset?token=redacted&step=2");
    });
});

describe("the label over what the pointer is on", () => {
    it("says what the element is, what it is called, and its test id, without the full identity", () => {
        document.body.innerHTML =
            '<button id="b" data-testid="pay-now">Pay now</button><p id="p">A short line</p>' +
            `<section id="s">${"long text ".repeat(20)}</section><input id="i" aria-label="Search">`;
        const at = (id: string) => document.getElementById(id) as Element;
        expect(hoverLabel(at("b"))).toBe("button “Pay now” · pay-now");
        expect(hoverLabel(at("p"))).toBe("p “A short line”");
        expect(hoverLabel(at("s"))).toBe("section"); // a container's whole text is noise
        expect(hoverLabel(at("i"))).toBe("textbox “Search”");
    });
});

describe("keyboard shortcuts", () => {
    const pressed = () => ui().querySelector(".tb-annotate")?.getAttribute("aria-pressed");
    const key = (target: EventTarget, init: KeyboardEventInit) => {
        const ev = new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            composed: true,
            ...init,
        });
        target.dispatchEvent(ev);
        return ev;
    };

    it("leave keys typed in the page's fields to the field", () => {
        mount();
        const field = document.querySelector("#q") as HTMLInputElement;
        const typed = key(field, { code: "KeyA", key: "Å", altKey: true, shiftKey: true });
        expect(typed.defaultPrevented).toBe(false);
        expect(pressed()).toBe("false");
        const editor = document.createElement("div");
        editor.setAttribute("contenteditable", "");
        document.body.append(editor);
        const selecting = key(editor, { code: "ArrowLeft", altKey: true, shiftKey: true });
        expect(selecting.defaultPrevented).toBe(false);
        // anywhere else, the shortcut is Notato's
        key(document.body, { code: "KeyA", altKey: true, shiftKey: true });
        expect(pressed()).toBe("true");
    });

    it("still work in a field when they have Ctrl or Cmd in them, which type nothing", () => {
        mount({ shortcut: "Ctrl+Shift+KeyY" });
        key(document.querySelector("#q") as Element, {
            code: "KeyY",
            ctrlKey: true,
            shiftKey: true,
        });
        expect(pressed()).toBe("true");
    });
});

describe("downloading a zip", () => {
    let clicked: string[];
    beforeEach(() => {
        clicked = [];
        URL.createObjectURL = vi.fn(() => "blob:zip");
        URL.revokeObjectURL = vi.fn();
        vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
            this: HTMLAnchorElement
        ) {
            clicked.push(this.download);
        });
    });
    const openZip = async () => {
        (ui().querySelector('button[title^="Export"]') as HTMLButtonElement).click();
        const zip = [...ui().querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) =>
            b.textContent?.includes("Download zip")
        );
        zip?.click();
        await settle();
        return ui().querySelector(".dialog");
    };
    const submit = async (clear: boolean) => {
        const box = ui().querySelector<HTMLInputElement>('.dialog input[type="checkbox"]');
        if (box) box.checked = clear;
        (
            [...ui().querySelectorAll<HTMLButtonElement>(".dialog button")].find(
                (b) => b.textContent === "Package"
            ) as HTMLButtonElement
        ).click();
        await until(() => !ui().querySelector(".dialog .status")?.textContent?.endsWith("…"));
        return ui().querySelector(".dialog .status")?.textContent ?? "";
    };

    it("in agent mode really downloads one, and only then removes the notes when asked", async () => {
        const notato = mount({ mode: "agent" });
        await notato.annotate({ target: "#pay", comment: "one" });
        expect(await openZip()).not.toBeNull();
        const said = await submit(true);
        expect(clicked).toHaveLength(1);
        expect(clicked[0]).toMatch(/^notato-shop-\d{8}-\d{4}\.zip$/);
        expect(said).toContain("Downloaded");
        expect(notato.list()).toEqual([]);
    });

    it("removes nothing when the download could not be made", async () => {
        URL.createObjectURL = vi.fn(() => {
            throw new Error("no blob URLs here");
        });
        const notato = mount({ mode: "agent" });
        await notato.annotate({ target: "#pay", comment: "one" });
        await openZip();
        const said = await submit(true);
        expect(said).toContain("no blob URLs here");
        expect(notato.list()).toHaveLength(1);
    });

    it("does not offer to remove notes that live on a server, which would only send them back", async () => {
        const server = fakeServer();
        const notato = mount({ mode: "agent", server: SERVER, transport: server.transport });
        await notato.annotate({ target: "#pay", comment: "one" });
        await openZip();
        expect(ui().querySelector('.dialog input[type="checkbox"]')).toBeNull();
    });
});

describe("notes kept in this browser, in agent mode", () => {
    beforeEach(() => {
        Object.assign(globalThis, { indexedDB: new IDBFactory() });
    });
    const props = (server: ReturnType<typeof fakeServer>): Partial<NotatoProps> => ({
        mode: "agent",
        server: SERVER,
        transport: server.transport,
        persist: true,
    });

    it("follow the server: a status it changes stays changed, and a note it deletes stays deleted", async () => {
        const server = fakeServer();
        let notato = mount(props(server));
        await server.hello();
        const a = await notato.annotate({ target: "#pay", comment: "kept" });
        expect(server.posts).toEqual([a.id]);
        await settle();

        server.say("updated", { annotation: { ...a, status: "resolved" } });
        await until(() => notato.list()[0]?.status === "resolved", "the update");
        await settle();
        server.state.up = false; // what this browser kept is all the next page has to start from
        notato = reload(props(server));
        await until(() => notato.list().length === 1, "the restore");
        expect(notato.list()[0]?.status).toBe("resolved");

        server.state.up = true;
        await server.hello();
        server.say("deleted", { id: a.id });
        await until(() => notato.list().length === 0, "the delete");
        await settle();
        server.state.up = false;
        notato = reload(props(server));
        await settle();
        await settle();
        expect(notato.list()).toEqual([]);
    });

    it("that had not reached the server are sent after a reload", async () => {
        const server = fakeServer();
        server.state.up = false;
        let notato = mount(props(server));
        const a = await notato.annotate({ target: "#pay", comment: "made offline" });
        expect(server.posts).toEqual([]);
        await settle();
        notato = reload(props(server));
        await until(() => notato.list().length === 1, "the restore");
        server.state.up = true;
        await server.hello();
        await until(() => server.posts.length === 1, "the upload");
        expect(server.posts).toEqual([a.id]);
        expect(notato.list().map((n) => n.id)).toEqual([a.id]); // and it is not dropped as gone from the server
    });

    it("that the server deleted while the page was closed are not brought back", async () => {
        const server = fakeServer();
        let notato = mount(props(server));
        await server.hello();
        const a = await notato.annotate({ target: "#pay", comment: "gone later" });
        await settle();
        server.notes.delete(a.id); // deleted on the board while nobody had the page open
        notato = reload(props(server));
        await until(() => notato.list().length === 1, "the restore");
        await server.hello();
        await until(() => notato.list().length === 0, "the reconcile");
        notato = reload({ ...props(server), transport: fakeServer().transport });
        await settle();
        await settle();
        expect(notato.list()).toEqual([]);
    });
});

describe("notes not yet sent", () => {
    it("survive the toolbar being remounted, and are sent when the server is back", async () => {
        const server = fakeServer();
        server.state.up = false;
        const props = { server: SERVER, transport: server.transport };
        const first = mount(props);
        const a = await first.annotate({ target: "#pay", comment: "while it was down" });
        first.destroy();
        mounted.pop();
        const second = mount(props); // HMR or StrictMode: same page, new toolbar
        expect(second.list().map((n) => n.id)).toEqual([a.id]);
        server.state.up = true;
        await server.hello();
        await until(() => server.posts.length === 1, "the upload");
        expect(server.posts).toEqual([a.id]);
    });

    it("are never sent once deleted, and nothing is asked of the server for them", async () => {
        const server = fakeServer();
        server.state.up = false;
        const notato = mount({ server: SERVER, transport: server.transport });
        const a = await notato.annotate({ target: "#pay", comment: "never mind" });
        await settle();
        const pin = ui().querySelector(".pin") as HTMLButtonElement;
        pin.click();
        const del = ui().querySelector(".card .delete") as HTMLButtonElement;
        del.click();
        del.click(); // armed, then confirmed
        await until(() => notato.list().length === 0, "the delete");
        server.state.up = true;
        await server.hello();
        await settle();
        expect(server.posts).toEqual([]);
        expect(server.deletes).toEqual([]);
        expect(a.id).toBeTruthy();
    });

    it("say what the server said when it will not take them yet, and stay queued", async () => {
        const server = fakeServer();
        const said = 'project "shop" does not exist on this server: create it first';
        server.state.refuse = { status: 404, error: said };
        const notato = mount({ server: SERVER, transport: server.transport });
        await server.hello();
        await notato.annotate({ target: "#pay", comment: "too early" });
        await settle();
        expect(ui().querySelector(".tb-dot")?.getAttribute("title")).toContain(said);
        expect(ui().querySelector(".toast")?.textContent).toContain(said);
        server.state.refuse = undefined;
        await server.hello(); // reconnected: sent now
        await until(() => server.notes.size === 1, "the upload");
    });

    it("refused for good are shown as such and do not hold up the next", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const server = fakeServer();
        const notato = mount({ server: SERVER, transport: server.transport });
        await server.hello();
        server.state.refuse = { status: 413, error: "the screenshot is too large" };
        const refused = await notato.annotate({ target: "#pay", comment: "huge" });
        server.state.refuse = undefined;
        const next = await notato.annotate({ target: "#q", comment: "fine" });
        expect([...server.notes.keys()]).toEqual([next.id]);
        await server.hello(); // a reconnect neither drops it nor sends it again
        expect(notato.list().map((n) => n.id)).toContain(refused.id);
        expect(server.posts.filter((id) => id === refused.id)).toHaveLength(1);
        await settle();
        const pin = [...ui().querySelectorAll<HTMLElement>(".pin")].find(
            (p) => p.dataset.refused === "true"
        );
        expect(pin).toBeDefined();
    });
});

describe("the server's list", () => {
    it("is shown once it is all in, with the pins brought up to date once", async () => {
        const server = fakeServer();
        for (let i = 0; i < 40; i++) {
            const id = `01LIST${String(i).padStart(4, "0")}`;
            server.notes.set(id, { ...sampleAnnotation, id, route: "/" } as Annotation);
        }
        const notato = mount({ server: SERVER, transport: server.transport });
        await server.hello();
        await until(() => notato.list().length === 40, "the list");
        await settle();
        expect(ui().querySelectorAll(".pin")).toHaveLength(40);
        expect(ui().querySelector(".tb-count")?.textContent).toBe("40");
    });
});

describe("a change the person makes on a note", () => {
    it("is shown from the server's answer, without reading every note again", async () => {
        const server = fakeServer();
        const id = "01REPLY00000000000000000001";
        server.notes.set(id, { ...sampleAnnotation, id, route: "/", thread: [] } as Annotation);
        const notato = mount({ server: SERVER, transport: server.transport });
        await server.hello();
        await until(() => notato.list().length === 1, "the list");
        const reads = server.reads.count;
        await until(() => Boolean(ui().querySelector(".pin")), "the pin");
        (ui().querySelector(".pin") as HTMLButtonElement).click();
        const say = ui().querySelector(".card .say") as HTMLInputElement;
        say.value = "Looks better now";
        say.dispatchEvent(new Event("input"));
        say.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        await until(() => notato.list()[0]?.thread.length === 1, "the reply");
        expect(notato.list()[0]?.thread[0]?.body).toBe("Looks better now");
        expect(server.reads.count).toBe(reads);
    });
});

describe("screenshots of notes made here", () => {
    /** A capture plugin with a screenshot, and a sink that keeps hold of what it was given, to look at later. */
    const withShot = () => {
        const held: { assets?: ReadonlyMap<string, Blob> } = {};
        const plugins: NotatoProps["plugins"] = [
            {
                id: "shot",
                async capture(draft) {
                    const full = await draft.putAsset(new Blob(["png"], { type: "image/png" }), {
                        w: 1,
                        h: 1,
                    });
                    return { screenshots: { full } };
                },
            },
            {
                id: "peek",
                async deliver(_note, assets) {
                    held.assets = assets;
                },
            },
        ];
        return { held, plugins };
    };

    it("are let go of in dev mode once the server has them, as nothing in the page shows them again", async () => {
        const server = fakeServer();
        const { held, plugins } = withShot();
        const notato = mount({ server: SERVER, transport: server.transport, plugins });
        await server.hello();
        await notato.annotate({ target: "#pay", comment: "sent" });
        expect(server.posts).toHaveLength(1);
        expect(held.assets?.size).toBe(0);
    });

    it("are kept while the server does not have them yet, and let go of once it does", async () => {
        const server = fakeServer();
        server.state.up = false;
        const { held, plugins } = withShot();
        const notato = mount({ server: SERVER, transport: server.transport, plugins });
        await notato.annotate({ target: "#pay", comment: "waiting" });
        expect(held.assets?.size).toBe(1);
        server.state.up = true;
        await server.hello();
        await until(() => server.posts.length === 1, "the upload");
        await until(() => held.assets?.size === 0, "the screenshot let go");
    });

    it("are kept in agent mode, for the zip", async () => {
        const server = fakeServer();
        const { held, plugins } = withShot();
        const notato = mount({
            mode: "agent",
            server: SERVER,
            transport: server.transport,
            plugins,
        });
        await server.hello();
        await notato.annotate({ target: "#pay", comment: "kept" });
        expect(server.posts).toHaveLength(1);
        expect(held.assets?.size).toBe(1);
    });
});

describe("watching the page for changes", () => {
    /** Frames asked for since the last call, ignoring the ones already waiting. */
    const framesAsked = () => {
        const asked = vi.spyOn(window, "requestAnimationFrame");
        return () => asked.mock.calls.length;
    };

    it("ignores an attribute that moves nothing, and follows one that can", async () => {
        mount();
        await settle();
        const asked = framesAsked();
        const pay = document.querySelector("#pay") as HTMLElement;
        pay.setAttribute("data-state", "busy");
        pay.setAttribute("aria-busy", "true");
        await settle();
        expect(asked()).toBe(0);
        pay.setAttribute("class", "wide");
        await settle();
        expect(asked()).toBeGreaterThan(0);
    });
});

describe("People only with no server", () => {
    it("is kept with the note and recorded in its thread, so a zip carries it", async () => {
        const notato = mount({ mode: "test" });
        const a = await notato.annotate({ target: "#pay", comment: "between us" });
        await until(() => Boolean(ui().querySelector(".pin")), "the pin");
        (ui().querySelector(".pin") as HTMLButtonElement).click();
        const toggle = () =>
            ui().querySelector(".card-foot .chip.people") as HTMLButtonElement | null;
        expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
        toggle()?.click();
        await until(() => notato.list()[0]?.peopleOnly === true, "People only");
        const kept = notato.list().find((n) => n.id === a.id) as Annotation;
        expect(kept.thread.at(-1)).toMatchObject({
            automatic: true,
            peopleOnly: true,
            author: { kind: "human" },
            body: "Made this people only: the agent won't see it.",
        });
        await until(() => toggle()?.getAttribute("aria-pressed") === "true", "the card");
        toggle()?.click();
        await until(() => notato.list()[0]?.peopleOnly === undefined, "shared again");
        expect(notato.list()[0]?.thread.map((r) => r.peopleOnly)).toEqual([true, false]);
    });
});
