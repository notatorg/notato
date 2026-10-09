import { afterEach, describe, expect, it } from "vitest";
import { commitCount, elementAt, watchApp } from "../src/inspect.ts";
import { type Fiber, HOST_COMPONENT } from "../src/tree.ts";

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

describe("watchApp", () => {
    const global = globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown };
    afterEach(() => {
        delete global.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    });

    /** A fiber, with what watchApp reads. */
    const fiber = (over: Partial<Fiber> = {}): Fiber => ({
        tag: HOST_COMPONENT,
        type: "RCTView",
        memoizedProps: {},
        return: null,
        child: null,
        sibling: null,
        ...over,
    });

    /**
     * React's tree around <Notato>: the root, the view the app and the overlay share, the app's view with the app in
     * it, and the overlay beside them. `commit` builds the next copy of it, as React does, and tells the hook.
     */
    function tree() {
        const fiberRoot: { current?: Fiber } = {};
        const appNode = { canonical: { nativeTag: 2 } };
        const outerNode = { canonical: { nativeTag: 1 } };
        let screen = fiber({ type: () => null, tag: 0, memoizedState: { n: 0 } });
        let overlay = fiber({ type: () => null, tag: 0, memoizedState: { n: 0 } });
        let appView = fiber({ stateNode: appNode, child: screen });
        const build = () => {
            const root = fiber({ tag: 3, stateNode: fiberRoot as Fiber["stateNode"] });
            const outer = fiber({ stateNode: outerNode, return: root, child: appView });
            root.child = outer;
            appView.return = outer;
            appView.sibling = overlay;
            screen.return = appView;
            overlay.return = outer;
            fiberRoot.current = root;
        };
        build();
        const instance = { __internalInstanceHandle: appView };
        const hook = global.__REACT_DEVTOOLS_GLOBAL_HOOK__ as {
            onCommitFiberRoot(...args: unknown[]): unknown;
        };
        const commit = (what: "overlay" | "app" | "app view") => {
            if (what === "overlay")
                overlay = fiber({ type: overlay.type, tag: 0, memoizedState: { n: 1 } });
            // The app's view drawn again with the same children: a copy, holding what the old one held.
            appView = fiber({ stateNode: appNode, child: appView.child });
            if (what === "app") screen = fiber({ ...screen, memoizedState: { n: 2 } });
            if (what === "app") appView.child = screen;
            build();
            hook.onCommitFiberRoot(1, fiberRoot);
        };
        return { instance, commit, other: () => hook.onCommitFiberRoot(1, {}) };
    }

    it("is told of the app's commits, and not of the overlay's or another root's", () => {
        global.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { onCommitFiberRoot: () => undefined };
        const t = tree();
        let changes = 0;
        const stop = watchApp(
            () => t.instance,
            () => changes++
        );
        expect(stop).toBeTypeOf("function");
        t.commit("overlay");
        t.commit("app view");
        t.other();
        expect(changes).toBe(0);
        t.commit("app");
        expect(changes).toBe(1);
        t.commit("overlay");
        expect(changes).toBe(1);
        stop?.();
        t.commit("app");
        expect(changes).toBe(1);
    });

    it("cannot tell without React's DevTools hook", () => {
        expect(
            watchApp(
                () => null,
                () => undefined
            )
        ).toBeUndefined();
    });
});

describe("elementAt", () => {
    it("finds a tapped view and the views around it, as the full walk does", () => {
        const text = {
            tag: HOST_COMPONENT,
            type: "RCTText",
            memoizedProps: { children: "Hi" },
            return: null,
            child: null,
            sibling: null,
            stateNode: { node: {}, canonical: { nativeTag: 7 } },
        } as Fiber;
        const card = {
            tag: HOST_COMPONENT,
            type: "RCTView",
            memoizedProps: { testID: "card" },
            return: null,
            child: text,
            sibling: null,
            stateNode: { node: {}, canonical: { nativeTag: 6 } },
        } as Fiber;
        text.return = card;
        const app = {
            tag: HOST_COMPONENT,
            type: "RCTView",
            memoizedProps: {},
            return: null,
            child: card,
            sibling: null,
            stateNode: { node: {}, canonical: { nativeTag: 5 } },
        } as Fiber;
        card.return = app;
        const instance = { __internalInstanceHandle: app };
        const found = elementAt(instance, 7, false);
        expect(found?.tag).toBe("Text");
        expect(found?.text).toBe("Hi");
        expect(found?.parent?.testId).toBe("card");
        expect(found?.parent?.parent).toBeUndefined();
        expect(elementAt(instance, 99, false)).toBeUndefined();
    });
});
