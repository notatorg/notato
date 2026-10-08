// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    deferred,
    display,
    frame,
    lay,
    layer,
    make,
    offer,
    onChoose,
    pill,
    pills,
    selectedTabs,
    setAnnotations,
    state,
    tab,
    tabName,
    tabs,
    takeBack,
    use,
    useVariantsPage,
    version,
    versions,
} from "./support/variants.ts";

useVariantsPage();

describe("the switcher", () => {
    it("is one pill for each group, in the layer", () => {
        versions("header", "Original", "Stacked");
        versions("footer", "Original", "Wide");
        make();
        expect(pills().map((p) => p.parentElement)).toEqual([layer, layer]);
        expect(pills().map((p) => p.getAttribute("aria-label"))).toEqual([
            "Variants of header",
            "Variants of footer",
        ]);
    });

    it("has a tab for each version, with the shown one selected", () => {
        versions("header", "Original", "Stacked", "Wide");
        setAnnotations([offer("header", { status: "variant_chosen", chosen: "Stacked" })]);
        make();
        expect(tabs().map(tabName)).toEqual(["Original", "Stacked", "Wide"]);
        expect(tabs().every((t) => t.getAttribute("role") === "tab")).toBe(true);
        expect(selectedTabs()).toEqual(["Stacked"]);
    });

    it("shows a version when its tab is clicked", () => {
        const [a, b, c] = versions("header", "Original", "Stacked", "Wide");
        const v = make();
        tab("Wide").click();
        expect(selectedTabs()).toEqual(["Wide"]);
        expect(v.list()[0]?.active).toBe("Wide");
        expect([a, b, c].map(display)).toEqual(["none", "none", "block"]);
        tab("Original").click();
        expect(selectedTabs()).toEqual(["Original"]);
        expect([a, b, c].map(display)).toEqual(["block", "none", "none"]);
    });

    it("titles a tab with what the agent said about the version, or else its name", () => {
        versions("header", "Original", "Stacked", "Wide");
        setAnnotations([offer("header")]);
        make();
        expect(tab("Original").title).toBe("As it is today");
        expect(tab("Stacked").title).toBe("Logo above the links");
        expect(tab("Wide").title).toBe("Wide");
    });

    it("does not rebuild itself for an update that changes nothing it shows", () => {
        versions("header", "Original", "Stacked");
        setAnnotations([offer("header")]);
        const v = make();
        const [stacked, useButton] = [tab("Stacked"), use()];
        v.update();
        expect(tab("Stacked")).toBe(stacked);
        expect(use()).toBe(useButton);
    });

    it("follows the annotation when the server changes it", () => {
        versions("header", "Original", "Stacked");
        setAnnotations([offer("header")]);
        const v = make();
        expect(state()).toBeUndefined();
        setAnnotations([offer("header", { status: "variant_chosen", chosen: "Stacked" })]);
        v.update();
        expect(state()).toBe("Picked “Stacked”.");
    });

    describe("Use", () => {
        it("is offered for the shown version once the agent has offered the versions", () => {
            versions("header", "Original", "Stacked");
            setAnnotations([offer("header")]);
            make();
            expect(use()?.textContent).toBe("Use “Original”");
            tab("Stacked").click();
            expect(use()?.textContent).toBe("Use “Stacked”");
        });

        it("is offered while a pick is still up to the person, and after one has been made", () => {
            versions("header", "Original", "Stacked");
            for (const status of ["acknowledged", "variant_chosen"] as const) {
                setAnnotations([
                    offer("header", {
                        status,
                        chosen: status === "variant_chosen" ? "Stacked" : undefined,
                    }),
                ]);
                const v = make();
                tab("Original").click(); // not the picked one, if there is one
                expect(use(), status).toBeDefined();
                v.destroy();
            }
        });

        it.each(["open", "resolved", "revert_requested", "reverted", "dismissed"] as const)(
            "is not offered when the annotation is %s",
            (status) => {
                versions("header", "Original", "Stacked");
                setAnnotations([offer("header", { status })]);
                make();
                expect(use()).toBeUndefined();
                expect(takeBack()).toBeUndefined();
            }
        );

        it("is not offered when nothing can send the pick", () => {
            versions("header", "Original", "Stacked");
            setAnnotations([offer("header")]);
            make({ onChoose: undefined });
            expect(use()).toBeUndefined();
            expect(tabs()).toHaveLength(2); // it still previews
        });

        it("is not offered for the version that is already the pick", () => {
            versions("header", "Original", "Stacked");
            setAnnotations([offer("header", { status: "variant_chosen", chosen: "Stacked" })]);
            make();
            expect(selectedTabs()).toEqual(["Stacked"]);
            expect(use()).toBeUndefined();

            tab("Original").click();
            expect(use()?.textContent).toBe("Use “Original”");
            tab("Stacked").click();
            expect(use()).toBeUndefined();
        });

        it("shortens a long version name on the button", () => {
            versions("header", "Original", "A really long version name");
            setAnnotations([offer("header")]);
            make();
            tab("A really long version name").click();
            expect(use()?.textContent).toBe("Use “A really long ver…”");
        });

        it("sends the annotation and the version, and is disabled until that is done", async () => {
            versions("header", "Original", "Stacked");
            setAnnotations([offer("header", { id: "a7" })]);
            make();
            tab("Stacked").click();
            const pending = deferred();
            onChoose.mockReturnValueOnce(pending.promise);

            use()?.click();
            expect(onChoose).toHaveBeenCalledExactlyOnceWith("a7", "Stacked");
            expect(use()?.disabled).toBe(true);
            use()?.click();
            expect(onChoose).toHaveBeenCalledTimes(1);

            pending.resolve();
            await frame();
            expect(use()?.disabled).toBe(false);
            expect(layer.querySelector(".verr")).toBeNull();
        });

        it("shows why it failed, and takes the message away after five seconds", async () => {
            versions("header", "Original", "Stacked");
            setAnnotations([offer("header")]);
            make();
            onChoose.mockRejectedValueOnce(new Error("Cannot reach the Notato server."));

            use()?.click();
            await frame();
            const error = layer.querySelector(".verr");
            expect(error?.textContent).toBe("Cannot reach the Notato server.");
            expect(error?.getAttribute("role")).toBe("alert");
            expect(use()?.disabled).toBe(false); // it can be tried again

            await vi.advanceTimersByTimeAsync(4800);
            expect(layer.querySelector(".verr")?.textContent).toBe(
                "Cannot reach the Notato server."
            );
            await vi.advanceTimersByTimeAsync(400);
            expect(layer.querySelector(".verr")).toBeNull();
        });

        it("shows a rejection that is not an Error as it is", async () => {
            versions("header", "Original", "Stacked");
            setAnnotations([offer("header")]);
            make();
            onChoose.mockRejectedValueOnce("offline");
            use()?.click();
            await frame();
            expect(layer.querySelector(".verr")?.textContent).toBe("offline");
        });

        it("starts the five seconds again when a later attempt fails", async () => {
            versions("header", "Original", "Stacked");
            setAnnotations([offer("header")]);
            make();
            onChoose
                .mockRejectedValueOnce(new Error("first"))
                .mockRejectedValueOnce(new Error("second"));
            use()?.click();
            await frame();
            await vi.advanceTimersByTimeAsync(3000);
            use()?.click();
            await frame();
            expect(layer.querySelector(".verr")?.textContent).toBe("second");
            await vi.advanceTimersByTimeAsync(3000); // past the first one's five seconds
            expect(layer.querySelector(".verr")?.textContent).toBe("second");
            await vi.advanceTimersByTimeAsync(2100);
            expect(layer.querySelector(".verr")).toBeNull();
        });
    });

    describe("after a pick", () => {
        it("says what was picked, and that the agent is applying it when that is the version shown", () => {
            versions("header", "Original", "Stacked");
            setAnnotations([offer("header", { status: "variant_chosen", chosen: "Stacked" })]);
            make();
            expect(state()).toBe("Picked. The agent is applying “Stacked”.");
            tab("Original").click();
            expect(state()).toBe("Picked “Stacked”.");
        });

        it("offers Take back, which sends null for the annotation", async () => {
            versions("header", "Original", "Stacked");
            setAnnotations([
                offer("header", { id: "a3", status: "variant_chosen", chosen: "Stacked" }),
            ]);
            make();
            const pending = deferred();
            onChoose.mockReturnValueOnce(pending.promise);

            takeBack()?.click();
            expect(onChoose).toHaveBeenCalledExactlyOnceWith("a3", null);
            expect(takeBack()?.disabled).toBe(true);
            pending.resolve();
            await frame();
            expect(takeBack()?.disabled).toBe(false);
        });

        it("shows why a Take back failed", async () => {
            versions("header", "Original", "Stacked");
            setAnnotations([offer("header", { status: "variant_chosen", chosen: "Stacked" })]);
            make();
            onChoose.mockRejectedValueOnce(new Error("Already applied."));
            takeBack()?.click();
            await frame();
            expect(layer.querySelector(".verr")?.textContent).toBe("Already applied.");
        });

        it("still says it, with no Take back, when nothing can send it", () => {
            versions("header", "Original", "Stacked");
            setAnnotations([offer("header", { status: "variant_chosen", chosen: "Stacked" })]);
            make({ onChoose: undefined });
            expect(state()).toBe("Picked. The agent is applying “Stacked”.");
            expect(takeBack()).toBeUndefined();
            expect(use()).toBeUndefined();
        });

        it("does not say it before there is a pick", () => {
            versions("header", "Original", "Stacked");
            setAnnotations([offer("header")]);
            make();
            expect(state()).toBeUndefined();
            expect(takeBack()).toBeUndefined();
        });

        it("marks the version that was picked with a tick, and only that tab", () => {
            versions("header", "Original", "Stacked", "Wide");
            setAnnotations([offer("header", { status: "variant_chosen", chosen: "Stacked" })]);
            make();
            const ticked = tabs().filter((t) => t.querySelector(".vmark"));
            expect(ticked.map(tabName)).toEqual(["Stacked"]);
            expect(ticked[0]?.querySelector(".vmark")?.textContent).toContain("✓");
            expect(ticked[0]?.querySelector(".vmark")?.getAttribute("aria-label")).toBe("picked");
        });

        it("marks no tab before a pick", () => {
            versions("header", "Original", "Stacked");
            setAnnotations([offer("header")]);
            make();
            expect(layer.querySelector(".vmark")).toBeNull();
        });
    });

    describe("with no annotation for the group", () => {
        it("says Preview, and offers no way to pick", () => {
            versions("header", "Original", "Stacked");
            make();
            expect(state()).toBe("Preview");
            expect(use()).toBeUndefined();
            expect(takeBack()).toBeUndefined();
            expect(tabs()).toHaveLength(2);
        });

        it("says it for a group whose annotation was offered for another group", () => {
            versions("header", "Original", "Stacked");
            setAnnotations([offer("footer")]);
            make();
            expect(state()).toBe("Preview");
        });

        it("does not say it once there is an annotation", () => {
            versions("header", "Original", "Stacked");
            setAnnotations([offer("header")]);
            make();
            expect(layer.textContent).not.toContain("Preview");
        });
    });
});

describe("where a version is on screen", () => {
    describe("anchor", () => {
        it("is the top-left corner of the area the shown version takes up", () => {
            const [a1, a2, b] = [
                version("header", "Original"),
                version("header", "Original"),
                version("header", "Stacked"),
            ];
            lay(a1, 100, 50, 200, 40);
            lay(a2, 80, 120, 300, 30);
            lay(b, 10, 15, 400, 100);
            const v = make();
            expect(v.anchor("header")).toEqual({ left: 80, top: 50 });
        });

        it("follows the version that is shown, not the hidden ones", () => {
            const [a, b] = versions("header", "Original", "Stacked");
            lay(a, 100, 50, 200, 40);
            lay(b, 10, 15, 400, 100);
            const v = make();
            v.select("header", "Stacked");
            expect(v.anchor("header")).toEqual({ left: 10, top: 15 });
        });

        it("uses the children of a wrapper with display: contents, which has no area of its own", () => {
            const wrapper = version("header", "Original");
            wrapper.style.display = "contents";
            lay(wrapper, 0, 0, 0, 0);
            const first = document.createElement("p");
            const second = document.createElement("p");
            wrapper.append(first, second);
            lay(first, 40, 200, 100, 20);
            lay(second, 60, 180, 50, 50);
            version("header", "Stacked");
            expect(make().anchor("header")).toEqual({ left: 40, top: 180 });
        });

        it("looks through wrappers inside wrappers", () => {
            const outer = version("header", "Original");
            const inner = document.createElement("div");
            const leaf = document.createElement("p");
            outer.append(inner);
            inner.append(leaf);
            lay(leaf, 25, 75, 100, 20);
            version("header", "Stacked");
            expect(make().anchor("header")).toEqual({ left: 25, top: 75 });
        });

        it("takes a wrapper's own area when it has one, whatever is inside", () => {
            const box = version("header", "Original");
            const child = document.createElement("p");
            box.append(child);
            lay(box, 100, 100, 300, 60);
            lay(child, 5, 5, 10, 10);
            version("header", "Stacked");
            expect(make().anchor("header")).toEqual({ left: 100, top: 100 });
        });

        it("is null when the shown version takes up no area, even if a hidden one does", () => {
            const [, b] = versions("header", "Original", "Stacked");
            lay(b, 10, 15, 400, 100);
            expect(make().anchor("header")).toBeNull();
        });

        it("is null for a group that is not there", () => {
            versions("header", "Original", "Stacked");
            expect(make().anchor("nope")).toBeNull();
        });
    });

    describe("placement of the switcher", () => {
        const view = { w: window.innerWidth, h: window.innerHeight };
        beforeEach(() => Object.assign(window, { innerWidth: 1000, innerHeight: 700 }));
        afterEach(() => Object.assign(window, { innerWidth: view.w, innerHeight: view.h }));

        const shownAt = (left: number, top: number, width: number, height: number) => {
            const [a] = versions("header", "Original", "Stacked");
            lay(a as HTMLElement, left, top, width, height);
            return make();
        };

        it("sits above the shown version, past where a pin would be", () => {
            shownAt(200, 100, 300, 50);
            expect(pill().style.display).toBe("flex");
            expect(pill().style.left).toBe("234px");
            expect(pill().style.top).toBe("60px");
        });

        it("sits over the top edge when there is no room above, so it stays reachable", () => {
            shownAt(200, 10, 300, 50);
            expect(pill().style.top).toBe("18px");
        });

        it("stays inside the right edge of the viewport", () => {
            shownAt(950, 100, 300, 50);
            expect(pill().style.left).toBe("732px"); // 1000 less the pill's 260 (happy-dom has no width) and a margin of 8
        });

        it.each([
            ["above the viewport", 100, -100, 300, 40],
            ["below it", 100, 800, 300, 40],
            ["left of it", -400, 100, 100, 40],
            ["right of it", 1200, 100, 300, 40],
        ])("is hidden when the shown version is entirely %s", (_, left, top, width, height) => {
            const v = shownAt(left, top, width, height);
            expect(pill().style.display).toBe("none");
            expect(v.anchor("header")).not.toBeNull(); // it has an area, just not one on screen
        });

        it("is shown when only part of the version is on screen", () => {
            shownAt(-200, -20, 300, 100);
            expect(pill().style.display).toBe("flex");
        });

        it("is hidden when the shown version takes up no area", () => {
            versions("header", "Original", "Stacked");
            make();
            expect(pill().style.display).toBe("none");
        });

        it("comes back at the next update once the version is on screen", () => {
            const [a] = versions("header", "Original", "Stacked");
            lay(a as HTMLElement, 100, 900, 300, 40);
            const v = make();
            expect(pill().style.display).toBe("none");
            lay(a as HTMLElement, 100, 300, 300, 40);
            v.update();
            expect(pill().style.display).toBe("flex");
            expect(pill().style.top).toBe("260px");
        });

        it("moves with the version that is shown", () => {
            const [a, b] = versions("header", "Original", "Stacked");
            lay(a as HTMLElement, 100, 300, 300, 40);
            lay(b as HTMLElement, 500, 500, 300, 40);
            const v = make();
            expect(pill().style.left).toBe("134px");
            v.select("header", "Stacked");
            expect(pill().style.left).toBe("534px");
            expect(pill().style.top).toBe("460px");
        });
    });
});
