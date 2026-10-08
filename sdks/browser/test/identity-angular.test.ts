// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { angularComponentName, angularIdentityPlugin } from "../src/plugins/identity-angular.ts";

/** A component instance of a class with this name, as Angular's development builds keep it. */
const instanceOf = (name: string): object => {
    const Class = { [name]: class {} }[name] as new () => object;
    return new Class();
};

/**
 * An Angular app as `window.ng` describes it: `App` renders `<product-list>`, whose template renders `<product-card>`,
 * whose template has a button. Returns the button.
 */
function angularPage(): HTMLElement {
    const app = instanceOf("App");
    const list = instanceOf("ProductList");
    const card = instanceOf("_ProductCard");
    const appHost = document.createElement("app-root");
    const listHost = document.createElement("product-list");
    const cardHost = document.createElement("product-card");
    const button = document.createElement("button");
    appHost.append(listHost);
    listHost.append(cardHost);
    cardHost.append(button);
    document.body.append(appHost);
    const hosts = new Map<object, Element>([
        [app, appHost],
        [list, listHost],
        [card, cardHost],
    ]);
    const owners = new Map<Element, object>([
        [listHost, app],
        [cardHost, list],
        [button, card],
    ]);
    (window as unknown as { ng: unknown }).ng = {
        getOwningComponent: (el: Element) => owners.get(el) ?? null,
        getComponent: (el: Element) => [...hosts].find(([, host]) => host === el)?.[0] ?? null,
        getHostElement: (component: object) => hosts.get(component) ?? null,
    };
    return button;
}

afterEach(() => {
    delete (window as unknown as { ng?: unknown }).ng;
    document.body.innerHTML = "";
});

describe("angularIdentityPlugin", () => {
    it("names the component whose template the element is in, and the components around it", () => {
        const button = angularPage();
        expect(angularIdentityPlugin().resolve(button)).toEqual({
            component: { name: "ProductCard", path: ["App", "ProductList", "ProductCard"] },
        });
    });

    it("names a component's host element after that component", () => {
        angularPage();
        const host = document.querySelector("product-list") as Element;
        expect(angularIdentityPlugin().resolve(host).component?.name).toBe("ProductList");
    });

    it("says nothing on a page that is not an Angular app in development, and never throws", () => {
        const el = document.createElement("div");
        expect(angularIdentityPlugin().resolve(el)).toEqual({});
        (window as unknown as { ng: unknown }).ng = {
            getOwningComponent: () => {
                throw new Error("detached");
            },
        };
        expect(angularIdentityPlugin().resolve(el)).toEqual({});
    });

    it("keeps class names as written, without what a bundler adds", () => {
        expect(angularComponentName(instanceOf("_Checkout"))).toBe("Checkout");
        expect(angularComponentName(instanceOf("Checkout$1"))).toBe("Checkout");
        expect(angularComponentName({})).toBeUndefined();
        expect(angularComponentName(null)).toBeUndefined();
    });
});
