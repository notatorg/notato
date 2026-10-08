import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followEvents, listAnnotations } from "../src/client.ts";
import type { ServerEvent } from "../src/events.ts";
import { annotation } from "./fixtures.ts";
import { FakeXHR } from "./xhr.ts";

const conn = { server: "http://localhost:4799", project: "shop" };

let uninstall: () => void = () => undefined;
beforeEach(() => {
    uninstall = FakeXHR.install();
});
afterEach(() => {
    uninstall();
    vi.useRealTimers();
});

describe("listAnnotations", () => {
    it("reads every page, without what the app never shows", async () => {
        const a = annotation({ id: "a" });
        const b = annotation({ id: "b" });
        FakeXHR.answer = (req) => ({
            status: 200,
            text: JSON.stringify(
                req.url.includes("afterSeq=1")
                    ? { items: [{ seq: 2, annotation: b }] }
                    : { items: [{ seq: 1, annotation: a }], next: 1 }
            ),
        });
        const items = await listAnnotations(conn);
        expect(items.map((i) => i.annotation.id)).toEqual(["a", "b"]);
        expect(FakeXHR.made.map((r) => r.url)).toEqual([
            "http://localhost:4799/projects/shop/annotations?limit=500&fields=summary",
            "http://localhost:4799/projects/shop/annotations?limit=500&fields=summary&afterSeq=1",
        ]);
    });

    it("throws rather than give a list cut short: a page that does not move on, or too many pages", async () => {
        FakeXHR.answer = () => ({ status: 200, text: JSON.stringify({ items: [], next: 7 }) });
        await expect(listAnnotations(conn)).rejects.toThrow(/did not move on/);
        let next = 0;
        FakeXHR.answer = () => ({ status: 200, text: JSON.stringify({ items: [], next: ++next }) });
        await expect(listAnnotations(conn)).rejects.toThrow(/more notes than Notato reads/);
        expect(next).toBe(100);
    });
});

describe("followEvents", () => {
    const follow = () => {
        const events: ServerEvent[] = [];
        const states: string[] = [];
        const stream = followEvents(
            conn,
            false,
            (e) => events.push(e),
            (state, detail) => states.push(detail ? `${state}: ${detail}` : state)
        );
        return { events, states, stream };
    };
    const hello = 'event: hello\ndata: {"projectId":"shop"}\n\n';

    it("starts again when the stream says nothing for 45 seconds (the server pings every 15)", () => {
        vi.useFakeTimers();
        const { events, states, stream } = follow();
        const first = FakeXHR.made[0] as FakeXHR;
        first.stream(hello);
        vi.advanceTimersByTime(30_000);
        first.stream(": ping\n\n");
        vi.advanceTimersByTime(44_000);
        expect(first.aborted).toBe(false);
        vi.advanceTimersByTime(1_500);
        expect(first.aborted).toBe(true);
        expect(states).toEqual(["connecting", "offline: The server stopped answering."]);
        vi.advanceTimersByTime(1_000);
        expect(FakeXHR.made).toHaveLength(2);
        expect(events.map((e) => e.event)).toEqual(["hello"]);
        stream.stop();
    });

    it("gives up on a server that never answers at all, the same way", () => {
        vi.useFakeTimers();
        const { states, stream } = follow();
        vi.advanceTimersByTime(45_000);
        expect(states).toEqual(["connecting", "offline: The server stopped answering."]);
        stream.stop();
    });

    it("opens a fresh stream after 2 MB without saying the connection changed", () => {
        vi.useFakeTimers();
        const { states, stream } = follow();
        const first = FakeXHR.made[0] as FakeXHR;
        first.stream(hello);
        first.stream(`: ${"x".repeat(2_000_000)}\n\n`);
        expect(first.aborted).toBe(true);
        expect(FakeXHR.made).toHaveLength(2);
        expect(states).toEqual(["connecting"]);
        stream.stop();
    });

    it("says the server closed the connection when the stream ends cleanly, and starts again", () => {
        vi.useFakeTimers();
        const { states, stream } = follow();
        const first = FakeXHR.made[0] as FakeXHR;
        first.stream(hello);
        first.end();
        expect(states).toEqual(["connecting", "offline: The server closed the connection."]);
        vi.advanceTimersByTime(1_000);
        expect(FakeXHR.made).toHaveLength(2);
        stream.stop();
    });

    it("waits 10 seconds after the server refuses the app", () => {
        vi.useFakeTimers();
        const { states, stream } = follow();
        const first = FakeXHR.made[0] as FakeXHR;
        first.status = 401;
        first.responseText = JSON.stringify({ error: "a token is needed" });
        first.end();
        expect(states).toEqual(["connecting", "refused: a token is needed"]);
        vi.advanceTimersByTime(9_000);
        expect(FakeXHR.made).toHaveLength(1);
        vi.advanceTimersByTime(1_000);
        expect(FakeXHR.made).toHaveLength(2);
        stream.stop();
    });
});
