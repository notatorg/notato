import { describe, expect, it } from "vitest";
import { serial } from "../src/serial.ts";

describe("serial", () => {
    it("runs tasks one at a time, and says when the last is done, even when one fails", async () => {
        const log: string[] = [];
        const run = serial(() => log.push("idle"));
        const task =
            (name: string, fail = false) =>
            async () => {
                log.push(`start ${name}`);
                await new Promise((r) => setTimeout(r, 5));
                log.push(`end ${name}`);
                if (fail) throw new Error(name);
                return name;
            };
        const results = await Promise.allSettled([
            run(task("a")),
            run(task("b", true)),
            run(task("c")),
        ]);
        expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
        expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c", "idle"]);
    });
});
