import { describe, expect, it } from "vitest";
import { createEventParser } from "../src/events.ts";

describe("the event stream", () => {
    it("hands over each event once it is complete, however the text arrives", () => {
        const parse = createEventParser();
        let text =
            'event: hello\ndata: {"agent":{"connected":true,"names":["Claude"]}}\n\n: ping\n\nevent: upd';
        expect(parse(text)).toEqual([
            { event: "hello", data: { agent: { connected: true, names: ["Claude"] } } },
        ]);
        text += 'ated\ndata: {"id":"a1","seq":4}\n\n';
        expect(parse(text)).toEqual([{ event: "updated", data: { id: "a1", seq: 4 } }]);
        expect(parse(text)).toEqual([]);
    });

    it("joins data lines, and keeps text that is not JSON as it is", () => {
        const parse = createEventParser();
        expect(parse("data: first\ndata: second\n\n")).toEqual([
            { event: "message", data: "first\nsecond" },
        ]);
    });
});
