import { createMemoryStore } from "@notato/core";
import { afterEach, describe, expect, it } from "vitest";
import { type EventStream, setTransport } from "../src/net.ts";
import { type AgentInfo, createServerSync } from "../src/sync.ts";

/** An event stream the test drives by hand. */
function fakeStream() {
    const listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
    const stream: EventStream = {
        addEventListener: (type, listener) =>
            listeners.set(type, [...(listeners.get(type) ?? []), listener]),
        onerror: null,
        close: () => {},
        readyState: 1,
    };
    const emit = (type: string, data: unknown) => {
        for (const listener of listeners.get(type) ?? [])
            listener(new MessageEvent(type, { data: JSON.stringify(data) }));
    };
    return { stream, emit };
}

afterEach(() => setTransport());

describe("which agent is on the other end", () => {
    it("is learned from the first event, and again each time it changes", () => {
        const { stream, emit } = fakeStream();
        setTransport({
            events: () => stream,
            fetch: async () => new Response(JSON.stringify({ items: [] })),
        });
        const heard: AgentInfo[] = [];
        const sync = createServerSync({
            baseUrl: "http://localhost:4747",
            project: "shop",
            store: createMemoryStore(),
            onState: () => {},
            onAgent: (agent) => heard.push(agent),
        });
        sync.start();
        emit("hello", {
            projectId: "shop",
            agent: { connected: true, sessions: 1, watching: false, names: ["Codex"] },
        });
        emit("agent", { connected: true, sessions: 2, watching: true, names: ["Claude", "Codex"] });
        // An older server says nothing about names.
        emit("agent", { connected: false, sessions: 0, watching: false });
        expect(heard).toEqual([
            { connected: true, watching: false, names: ["Codex"] },
            { connected: true, watching: true, names: ["Claude", "Codex"] },
            { connected: false, watching: false, names: [] },
        ]);
        sync.stop();
    });
});
