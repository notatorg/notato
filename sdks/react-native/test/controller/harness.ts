import type { Annotation } from "@notato/schema";
import { vi } from "vitest";
import {
    type Connection,
    NotatoError,
    type StoredAnnotation,
    type StreamState,
    type Transport,
} from "../../src/client.ts";
import { type Host, NotatoController } from "../../src/controller.ts";
import type { ServerEvent } from "../../src/events.ts";
import type { Picked } from "../../src/inspect.ts";
import type { NotatoStorage, StorageProvider } from "../../src/storage.ts";

/** The smallest PNG header Notato reads a size from: 4 by 2. */
export const PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4,
    0, 0, 0, 2,
]);

/**
 * Long enough for the controller to apply the server's changes, which it gathers for a frame (16 ms), and for the
 * promises a change sets off to settle.
 */
export const settle = () => new Promise((r) => setTimeout(r, 30));

/** A fake Notato server: what it has, what it was asked, and a stream the test drives. */
export function fakeServer() {
    const stored = new Map<string, Annotation>();
    let seq = 0;
    const calls: string[] = [];
    let onEvent: ((e: ServerEvent) => void) | undefined;
    let onState: ((s: StreamState, d?: string) => void) | undefined;
    let fail: NotatoError | undefined;
    const store = (a: Annotation): StoredAnnotation => {
        stored.set(a.id, a);
        return { seq: ++seq, annotation: a };
    };
    const transport: Transport = {
        send: vi.fn(async (_c: Connection, a: Annotation, files) => {
            calls.push(`send ${a.id} ${files.length}`);
            if (fail) throw fail;
            return store(a);
        }),
        list: vi.fn(async () =>
            [...stored.values()].map((annotation, i) => ({ seq: i + 1, annotation }))
        ),
        reply: vi.fn(async (_c, id, body, author, aside) => {
            const a = stored.get(id) as Annotation;
            return store({
                ...a,
                thread: [
                    ...a.thread,
                    {
                        id: `r${seq}`,
                        author,
                        body,
                        createdAt: new Date().toISOString(),
                        ...(aside ? { aside } : {}),
                    },
                ],
            });
        }),
        setStatus: vi.fn(async (_c, id, status) =>
            store({ ...(stored.get(id) as Annotation), status })
        ),
        setPeopleOnly: vi.fn(async (_c, id, on) =>
            store({ ...(stored.get(id) as Annotation), peopleOnly: on })
        ),
        remove: vi.fn(async (_c, id) => {
            calls.push(`delete ${id}`);
            stored.delete(id);
        }),
        relayResult: vi.fn(async () => undefined),
        uploadBundle: vi.fn(async () => ({ bundleId: "b1", imported: 1 })),
        config: vi.fn(async () => ({ screenshots: true })),
        follow: vi.fn((_c, _agent, e, s) => {
            onEvent = e;
            onState = s;
            return { stop: vi.fn(), retry: vi.fn() };
        }),
    };
    return {
        transport,
        stored,
        calls,
        /** The server greets the app, and the controller sends what it kept and reads the list. */
        hello: async () => {
            onEvent?.({
                event: "hello",
                data: { projectId: "shop", agent: { connected: true, names: ["Claude"] } },
            });
            await settle();
        },
        /** An event, applied before this resolves. */
        event: async (event: string, data: unknown) => {
            onEvent?.({ event, data });
            await settle();
        },
        /** An event, with no wait for it to be applied. */
        send: (event: string, data: unknown) => onEvent?.({ event, data }),
        drop: () => onState?.("offline", "cannot reach it"),
        /** Every note sent from now on fails with this, until it is cleared. */
        failWith: (e?: NotatoError) => {
            fail = e;
        },
    };
}

export type FakeServer = ReturnType<typeof fakeServer>;

/** What the overlay reports for a tap on a product's price. */
export function picked(over: Partial<Picked> = {}): Picked {
    return {
        names: ["App", "ProductCard", "Text", "RCTText"],
        props: { children: "£1.45" },
        frame: { left: 10, top: 100, width: 60, height: 20 },
        componentStack: "",
        element: {
            fiber: {} as never,
            tag: "Text",
            text: "£1.45",
            path: ["App", "ProductCard"],
            private: false,
            input: false,
            shown: false,
        },
        view: {},
        ...over,
    };
}

/** An overlay that finds every target but `#missing`, takes a one-shot screenshot, and keeps its toasts. */
export function fakeHost(route = "/shop"): Host & { toasts: string[] } {
    const toasts: string[] = [];
    return {
        toasts,
        resolve: async (target) => {
            if (target === "#missing")
                throw new NotatoError('Nothing on this screen matches "#missing".');
            return picked();
        },
        capture: async (_p, _pin, id) => ({
            full: { bytes: PNG, ref: { id: `${id}-full`, mime: "image/png", w: 4, h: 2 } },
        }),
        select: () => undefined,
        route: () => route,
        device: () => ({ os: "ios", osVersion: "26.5", viewport: { w: 402, h: 874 }, dpr: 3 }),
        toast: (m) => toasts.push(m),
    };
}

/** A controller on a fake server, with an overlay, configured and on. */
export function start(
    config: Parameters<NotatoController["configure"]>[0],
    server = fakeServer(),
    storage?: NotatoStorage
) {
    const notato = new NotatoController(server.transport);
    notato.attachHost(fakeHost());
    const provider: StorageProvider | undefined = storage
        ? { open: () => storage, share: async () => true }
        : undefined;
    notato.configure({
        enabled: true,
        captureLogs: false,
        ...config,
        ...(provider ? { storage: provider } : {}),
    });
    return { notato, server };
}

/** Makes the server's `send` wait until the test lets it answer, with the answer it would have given. */
export function holdSends(server: FakeServer, order: "before" | "after" = "before") {
    let release: () => void = () => undefined;
    const send = server.transport.send;
    const wait = () =>
        new Promise<void>((r) => {
            release = r;
        });
    server.transport.send = vi.fn(async (c, a, f) => {
        if (order === "before") {
            await wait();
            return send(c, a, f);
        }
        const stored = await send(c, a, f);
        await wait();
        return stored;
    });
    return () => release();
}
