import { afterEach, describe, expect, it } from "vitest";
import { commitCount } from "../src/inspect.ts";

describe("commitCount", () => {
    const global = globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown };
    afterEach(() => {
        delete global.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    });

    it("counts React's commits through its DevTools hook, passing each one on", () => {
        expect(commitCount()).toBeUndefined();
        const seen: unknown[] = [];
        const hook: { onCommitFiberRoot?: (...args: unknown[]) => unknown } = {
            onCommitFiberRoot: (...args) => seen.push(args),
        };
        global.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
        const start = commitCount() as number;
        hook.onCommitFiberRoot?.(1, "root");
        expect(commitCount()).toBe(start + 1);
        expect(seen).toEqual([[1, "root"]]);
        expect(commitCount()).toBe(start + 1);
        // Something else taking the hook's place is listened through too, and counts as a change.
        hook.onCommitFiberRoot = () => undefined;
        expect(commitCount()).toBe(start + 2);
    });
});
