// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { type PageWatch, watchPage } from "../src/page-watch.ts";

let page: PageWatch | undefined;
afterEach(() => {
    page?.destroy();
    page = undefined;
    document.body.replaceChildren();
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("watching the page for versions", () => {
    const watch = () => {
        const onVariantsChanged = vi.fn();
        page = watchPage({
            identityAttributes: ["id"],
            onMove: () => {},
            onElementsChanged: () => {},
            onRouteChange: () => {},
            onVariantsChanged,
        });
        return onVariantsChanged;
    };

    it("says nothing when what came holds no version", async () => {
        const heard = watch();
        const plain = document.createElement("section");
        plain.append(document.createElement("p"));
        document.body.append(plain);
        plain.className = "wide";
        await settle();
        expect(heard).not.toHaveBeenCalled();
    });

    it("says so when an element with a version came, or one changed its marker", async () => {
        const heard = watch();
        const wrapper = document.createElement("div");
        wrapper.innerHTML = '<div data-notato-variant="header" data-notato-variant-name="A"></div>';
        document.body.append(wrapper);
        await settle();
        expect(heard).toHaveBeenLastCalledWith(true);
        heard.mockClear();
        wrapper.firstElementChild?.setAttribute("data-notato-variant-name", "B");
        await settle();
        expect(heard).toHaveBeenLastCalledWith(true);
    });

    it("says something went, for the versions to look again only if they had any", async () => {
        const gone = document.createElement("p");
        document.body.append(gone);
        const heard = watch();
        gone.remove();
        await settle();
        expect(heard).toHaveBeenLastCalledWith(false);
    });
});
