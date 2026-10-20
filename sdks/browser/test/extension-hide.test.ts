// @vitest-environment happy-dom
import { type Annotation, sampleAnnotation } from "@notato/schema";
import { afterEach, expect, it, vi } from "vitest";
import {
    createPageTransport,
    type PageBus,
    toolbarProps,
} from "../../../packages/extension/src/page.ts";
import {
    CHANNEL,
    encodeResponse,
    type PageConfig,
    type ToPage,
} from "../../../packages/extension/src/protocol.ts";
import { createController, type NotatoController } from "../src/controller.ts";
import { reducedMotion } from "./support/motion.ts";

let controller: NotatoController | undefined;
afterEach(() => {
    controller?.destroy();
    controller = undefined;
    document.body.replaceChildren();
    localStorage.clear();
    vi.restoreAllMocks();
});

const until = async (check: () => boolean) => {
    for (let i = 0; i < 300; i++) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error("The extension toolbar did not update");
};

it("the extension's toolbar hides in bulk, remembers across reloads, reveals questions and restores", async () => {
    localStorage.clear();
    reducedMotion();
    document.body.innerHTML = '<main><button id="pay">Pay</button></main>';
    const notes: Annotation[] = [
        { ...sampleAnnotation, id: "done", route: "/", status: "resolved" },
        { ...sampleAnnotation, id: "reverted", route: "/", status: "reverted" },
        { ...sampleAnnotation, id: "elsewhere", route: "/elsewhere", status: "resolved" },
        { ...sampleAnnotation, id: "active", route: "/", status: "open" },
    ];
    const original = structuredClone(notes);
    const listeners = new Set<(message: ToPage) => void>();
    let stream = 0;
    const methods: string[] = [];
    const say = (message: ToPage) => {
        for (const listener of listeners) listener(message);
    };
    const bus: PageBus = {
        listen(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        post(message) {
            if (message.kind === "fetch") {
                methods.push(message.init.method ?? "GET");
                const path = new URL(message.url).pathname;
                const response = Response.json(
                    path === "/projects/shop/annotations"
                        ? { items: notes.map((annotation, seq) => ({ annotation, seq })) }
                        : { screenshots: false }
                );
                void encodeResponse(response).then((response) =>
                    say({ channel: CHANNEL, to: "page", kind: "fetched", id: message.id, response })
                );
            } else if (message.kind === "events") {
                stream = message.id;
                queueMicrotask(() =>
                    say({
                        channel: CHANNEL,
                        to: "page",
                        kind: "event",
                        id: message.id,
                        frame: { type: "hello", data: JSON.stringify({ projectId: "shop" }) },
                    })
                );
            }
        },
    };
    const config: PageConfig = {
        enabled: true,
        server: "http://localhost:4801",
        project: "shop",
        author: "Tester",
    };
    const transport = createPageTransport(bus);
    const mount = () => {
        const props = toolbarProps(config, window.location, transport);
        expect(props.persist).toBe(false);
        expect(props.token).toBeUndefined();
        controller = createController({ ...props, screenshots: false });
    };
    const root = () => document.querySelector("[data-notato-root]")?.shadowRoot;
    const count = () => root()?.querySelector(".tb-count")?.textContent;
    const button = (label: string) =>
        [...(root()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
            (b) => b.title === label || b.textContent?.includes(label)
        ) as HTMLButtonElement;

    mount();
    await until(() => count() === "3");
    button("Settings").click();
    button("Hide completed annotations (3)").click();
    await until(() => count() === "1");
    expect(controller?.list()).toEqual(original);
    expect(notes).toEqual(original);
    controller?.destroy();
    mount();
    await until(() => count() === "1");
    say({
        channel: CHANNEL,
        to: "page",
        kind: "event",
        id: stream,
        frame: {
            type: "updated",
            data: JSON.stringify({ annotation: { ...notes[0], status: "awaiting_response" } }),
        },
    });
    await until(() => count() === "2");
    button("Settings").click();
    button("Restore hidden annotations (3)").click();
    await until(() => count() === "3");
    expect(controller?.list()).toHaveLength(4);
    expect(methods.every((method) => method === "GET")).toBe(true);
});
