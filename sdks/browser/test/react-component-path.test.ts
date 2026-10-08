// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
    componentPathOf,
    reactSourceIdentityPlugin,
} from "../src/plugins/identity-react-source.ts";

type Fiber = Parameters<typeof componentPathOf>[0];

/** A component type with this name, the way a function component carries it. */
const named = (name: string) => Object.defineProperty(() => null, "name", { value: name });
const component = (name: string, links: Partial<Fiber> = {}): Fiber => ({
    type: named(name),
    ...links,
});

/**
 * Components rendered one by another, outermost first, as React's development builds record it (`_debugOwner`). Returns the
 * innermost. Each is also the parent (`return`) of the one it rendered.
 */
const owned = (...names: string[]): Fiber => {
    let fiber: Fiber | undefined;
    for (const name of names)
        fiber = component(name, { _debugOwner: fiber ?? null, return: fiber ?? null });
    return fiber as Fiber;
};
/** A DOM element's fiber rendered by `owner`. */
const hostOf = (owner: Fiber, extra: Partial<Fiber> = {}): Fiber => ({
    type: "button",
    _debugOwner: owner,
    ...extra,
});

describe("componentPathOf", () => {
    it("lists the components that rendered the element, outermost first", () => {
        expect(componentPathOf(hostOf(owned("App", "Dashboard", "SubmitButton")))).toEqual([
            "App",
            "Dashboard",
            "SubmitButton",
        ]);
    });

    it("follows who rendered what, not what the element is nested inside", () => {
        const submit = owned("App", "Checkout", "SubmitButton");
        // A layout wraps the button in the tree, but it did not render it.
        const layout = component("Layout", { return: component("Sidebar") });
        expect(componentPathOf(hostOf(submit, { return: layout }))).toEqual([
            "App",
            "Checkout",
            "SubmitButton",
        ]);
    });

    it("stops at a component that nobody rendered, even if the tree continues above it", () => {
        const app = component("App", { _debugOwner: null, return: component("AppShell") });
        const page = component("Page", { _debugOwner: app });
        expect(componentPathOf(hostOf(page))).toEqual(["App", "Page"]);
    });

    it("falls back to the parents when no owner was recorded, as in a production build", () => {
        const app = component("App");
        const dashboard = component("Dashboard", { return: { type: "main", return: app } });
        const submit = component("SubmitButton", {
            return: { type: "div", return: { type: "div", return: dashboard } },
        });
        const host: Fiber = { type: "button", return: submit };
        expect(componentPathOf(host)).toEqual(["App", "Dashboard", "SubmitButton"]);
    });

    it("skips framework plumbing: boundaries, providers, routing and transitions", () => {
        const path = componentPathOf(
            hostOf(
                owned(
                    "App",
                    "StrictMode",
                    "ThemeProvider",
                    "AuthContext",
                    "QueryClientConsumer",
                    "BrowserRouter",
                    "Routes",
                    "Route",
                    "RenderedRoute",
                    "ErrorBoundary",
                    "Suspense",
                    "Fragment",
                    "Lazy",
                    "Outlet",
                    "CSSTransition",
                    "Settings",
                    "SaveButton"
                )
            ),
            20
        );
        expect(path).toEqual(["App", "Settings", "SaveButton"]);
    });

    it("keeps components that only have a plumbing word in their name", () => {
        expect(
            componentPathOf(hostOf(owned("AppRouter", "RouteGuard", "OutletFrame", "Pay")))
        ).toEqual(["AppRouter", "RouteGuard", "OutletFrame", "Pay"]);
    });

    it("skips anonymous components and DOM elements in the chain", () => {
        const anonymous: Fiber = { type: named(""), _debugOwner: owned("App", "Page") };
        expect(componentPathOf(hostOf(anonymous))).toEqual(["App", "Page"]);
        const dom: Fiber = { type: "section", _debugOwner: owned("App", "Page") };
        expect(componentPathOf(hostOf(dom))).toEqual(["App", "Page"]);
    });

    it("lists a component once when it appears twice in a row, as a memo wrapper and what it wraps do", () => {
        expect(componentPathOf(hostOf(owned("App", "Card", "Card", "Title")))).toEqual([
            "App",
            "Card",
            "Title",
        ]);
    });

    it("keeps the nearest eight by default, so a deep tree is cut at the top", () => {
        const names = Array.from({ length: 12 }, (_, i) => `C${i + 1}`);
        expect(componentPathOf(hostOf(owned(...names)))).toEqual(names.slice(4));
    });

    it("keeps the nearest `limit` when given one", () => {
        const names = ["A", "B", "C", "D", "E"];
        expect(componentPathOf(hostOf(owned(...names)), 3)).toEqual(["C", "D", "E"]);
    });

    it("does not count plumbing against the limit", () => {
        expect(
            componentPathOf(hostOf(owned("A", "B", "Suspense", "C", "Suspense", "D")), 3)
        ).toEqual(["B", "C", "D"]);
    });

    it("applies the limit to a path made of parents too", () => {
        const names = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
        let parent: Fiber | undefined;
        for (const name of names) parent = component(name, { return: parent ?? null });
        expect(componentPathOf({ type: "i", return: parent })).toEqual(names.slice(2));
    });

    it("is undefined when there is only one component to name", () => {
        expect(componentPathOf(hostOf(owned("Pay")))).toBeUndefined();
        expect(componentPathOf(hostOf(owned("Suspense", "Pay", "Fragment")))).toBeUndefined();
    });

    it("is undefined for a tree of DOM elements alone", () => {
        const host: Fiber = {
            type: "span",
            return: { type: "div", return: { type: "main", return: null } },
        };
        expect(componentPathOf(host)).toBeUndefined();
        expect(componentPathOf({ type: "span" })).toBeUndefined();
    });

    it("is undefined when everything around the element is plumbing", () => {
        expect(
            componentPathOf(hostOf(owned("Suspense", "ThemeProvider", "Routes")))
        ).toBeUndefined();
    });
});

describe("reactSourceIdentityPlugin: component path", () => {
    const plugin = reactSourceIdentityPlugin();
    const withFiber = (fiber: Fiber) => {
        const el = document.createElement("button");
        (el as unknown as Record<string, unknown>).__reactFiber$abc = fiber;
        return el;
    };

    it("reports the path next to the component's name", () => {
        const identity = plugin.resolve(withFiber(hostOf(owned("App", "Checkout", "PayButton"))));
        expect(identity).toEqual({
            component: { name: "PayButton", path: ["App", "Checkout", "PayButton"] },
        });
    });

    it("leaves the path out when there is only the one component", () => {
        const identity = plugin.resolve(withFiber(hostOf(owned("PayButton"))));
        expect(identity).toEqual({ component: { name: "PayButton" } });
    });
});
