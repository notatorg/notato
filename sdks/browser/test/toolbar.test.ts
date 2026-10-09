// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
    createToolbar,
    fractionAt,
    loadToolbarCollapsed,
    loadToolbarFraction,
    placeAt,
    TOOLBAR_MARGIN,
    type Toolbar,
} from "../src/ui/toolbar.ts";

describe("where the toolbar goes", () => {
    const size = { w: 200, h: 40 };
    const viewport = { w: 1000, h: 800 };

    it("puts the corners the margin in from the edges, as the corner classes do", () => {
        expect(placeAt({ x: 0, y: 0 }, size, viewport)).toEqual({ left: 16, top: 16 });
        expect(placeAt({ x: 1, y: 1 }, size, viewport)).toEqual({
            left: 1000 - 200 - 16,
            top: 800 - 40 - 16,
        });
    });

    it("reads a position back as the fraction it came from", () => {
        const at = placeAt({ x: 0.25, y: 0.6 }, size, viewport);
        const back = fractionAt(at, size, viewport);
        // Positions are whole pixels, so the fraction comes back to within a pixel's worth.
        expect(back.x).toBeCloseTo(0.25, 2);
        expect(back.y).toBeCloseTo(0.6, 2);
    });

    it("keeps a toolbar on the edge it was dragged to when the window changes size", () => {
        const fraction = fractionAt({ left: 1000 - 200 - 16, top: 300 }, size, viewport);
        const narrower = placeAt(fraction, size, { w: 600, h: 800 });
        expect(narrower.left).toBe(600 - 200 - 16);
    });

    it("holds a toolbar wider than the window at the margin", () => {
        expect(placeAt({ x: 1, y: 1 }, { w: 1200, h: 40 }, viewport).left).toBe(TOOLBAR_MARGIN);
        expect(fractionAt({ left: 500, top: 500 }, { w: 1200, h: 900 }, viewport)).toEqual({
            x: 1,
            y: 1,
        });
    });
});

describe("moving the toolbar", () => {
    let toolbar: Toolbar;
    let annotate: Mock<() => void>;

    const pointer = (target: Element, type: string, x: number, y: number) =>
        target.dispatchEvent(
            new PointerEvent(type, {
                bubbles: true,
                composed: true,
                clientX: x,
                clientY: y,
                button: 0,
                isPrimary: true,
                pointerId: 1,
            })
        );
    const annotateButton = () =>
        toolbar.el.querySelector<HTMLButtonElement>("button") as HTMLButtonElement;
    const grip = () => toolbar.el.querySelector<HTMLElement>(".tb-grip") as HTMLElement;
    const key = (target: Element, k: string, shiftKey = false) =>
        target.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true }));
    // happy-dom lays nothing out: the toolbar is 0 by 0, so its room is the window less the two margins.
    const room = () => ({
        w: window.innerWidth - 2 * TOOLBAR_MARGIN,
        h: window.innerHeight - 2 * TOOLBAR_MARGIN,
    });

    const mount = () => {
        annotate = vi.fn<() => void>();
        toolbar = createToolbar({
            position: "bottom-right",
            onToggleAnnotate: annotate,
            onTogglePins: () => {},
        });
        document.body.append(toolbar.el);
    };

    beforeEach(() => {
        window.localStorage.clear();
    });
    afterEach(() => {
        toolbar.destroy();
        toolbar.el.remove();
    });

    it("starts in its corner, placed by the corner class alone", () => {
        mount();
        expect(toolbar.el.classList.contains("bottom-right")).toBe(true);
        expect(toolbar.el.style.left).toBe("");
    });

    it("follows a drag, remembers where it was left, and does not press the button the drag started on", () => {
        mount();
        pointer(annotateButton(), "pointerdown", 100, 100);
        pointer(annotateButton(), "pointermove", 140, 160);
        pointer(annotateButton(), "pointerup", 140, 160);
        annotateButton().click();

        expect(annotate).not.toHaveBeenCalled();
        expect(toolbar.el.style.left).toBe("40px");
        expect(toolbar.el.style.top).toBe("60px");
        expect(toolbar.el.style.right).toBe("auto");
        expect(loadToolbarFraction()).toEqual(
            fractionAt(
                { left: 40, top: 60 },
                { w: 0, h: 0 },
                { w: window.innerWidth, h: window.innerHeight }
            )
        );
    });

    it("follows a drag whose moves land on the page rather than the bar", () => {
        mount();
        pointer(annotateButton(), "pointerdown", 100, 100);
        pointer(document.body, "pointermove", 300, 50);
        pointer(document.body, "pointerup", 300, 50);
        expect(toolbar.el.style.left).toBe("200px");
        expect(toolbar.el.style.top).toBe(`${TOOLBAR_MARGIN}px`);
        expect(loadToolbarFraction()).not.toBeNull();
    });

    it("is still a click when the pointer barely moves", () => {
        mount();
        pointer(annotateButton(), "pointerdown", 100, 100);
        pointer(annotateButton(), "pointermove", 102, 101);
        pointer(annotateButton(), "pointerup", 102, 101);
        annotateButton().click();
        expect(annotate).toHaveBeenCalledOnce();
        expect(loadToolbarFraction()).toBeNull();
    });

    it("comes back where it was left", () => {
        window.localStorage.setItem("notato:toolbar-position", JSON.stringify({ x: 0.5, y: 0 }));
        mount();
        window.dispatchEvent(new Event("resize"));
        expect(toolbar.el.style.left).toBe(`${Math.round(TOOLBAR_MARGIN + room().w * 0.5)}px`);
        expect(toolbar.el.style.top).toBe(`${TOOLBAR_MARGIN}px`);
    });

    it("ignores a stored position that is not one", () => {
        window.localStorage.setItem("notato:toolbar-position", JSON.stringify({ x: "left", y: 2 }));
        expect(loadToolbarFraction()).toBeNull();
        window.localStorage.setItem("notato:toolbar-position", JSON.stringify({ x: -1, y: 2 }));
        expect(loadToolbarFraction()).toEqual({ x: 0, y: 1 });
    });

    it("moves with the arrow keys on its grip, further with Shift, and Home puts it back in its corner", () => {
        window.localStorage.setItem("notato:toolbar-position", JSON.stringify({ x: 0, y: 0 }));
        mount();
        key(grip(), "ArrowRight");
        expect(toolbar.el.style.left).toBe(`${TOOLBAR_MARGIN + 16}px`);
        key(grip(), "ArrowDown", true);
        expect(toolbar.el.style.top).toBe(`${TOOLBAR_MARGIN + 64}px`);
        expect(loadToolbarFraction()).not.toBeNull();

        key(grip(), "Home");
        expect(toolbar.el.style.left).toBe("");
        expect(loadToolbarFraction()).toBeNull();
    });

    it("goes back to its corner when the grip is double-clicked", () => {
        window.localStorage.setItem("notato:toolbar-position", JSON.stringify({ x: 0.2, y: 0.2 }));
        mount();
        window.dispatchEvent(new Event("resize"));
        expect(toolbar.el.style.left).not.toBe("");
        grip().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        expect(toolbar.el.style.left).toBe("");
        expect(loadToolbarFraction()).toBeNull();
    });

    it("follows a drag by a transform, once a frame, and writes its place only when let go", async () => {
        mount();
        pointer(annotateButton(), "pointerdown", 100, 100);
        pointer(annotateButton(), "pointermove", 140, 160);
        pointer(annotateButton(), "pointermove", 150, 170);
        window.dispatchEvent(new Event("resize")); // the window changing meanwhile does not put it back
        expect(toolbar.el.style.left).toBe("");
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        expect(toolbar.el.style.transform).toBe("translate3d(50px, 70px, 0)");
        expect(toolbar.el.style.left).toBe("");
        pointer(annotateButton(), "pointerup", 150, 170);
        expect(toolbar.el.style.transform).toBe("");
        expect([toolbar.el.style.left, toolbar.el.style.top]).toEqual(["50px", "70px"]);
    });

    it("slides back to its corner when put back there, rather than jumping", () => {
        window.localStorage.setItem("notato:toolbar-position", JSON.stringify({ x: 0.2, y: 0.2 }));
        mount();
        window.dispatchEvent(new Event("resize"));
        const from = [
            Number.parseInt(toolbar.el.style.left, 10),
            Number.parseInt(toolbar.el.style.top, 10),
        ] as const;
        // happy-dom lays nothing out: in its corner, say it is at 900, 700.
        toolbar.el.getBoundingClientRect = () => {
            const dragged = toolbar.el.style.left !== "";
            const left = dragged ? from[0] : 900;
            const top = dragged ? from[1] : 700;
            return { left, top, right: left, bottom: top, width: 0, height: 0 } as DOMRect;
        };
        const animate = vi.spyOn(toolbar.el, "animate");
        grip().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        expect(toolbar.el.style.left).toBe("");
        expect(animate.mock.calls[0]?.[0]).toEqual([
            { transform: `translate(${from[0] - 900}px, ${from[1] - 700}px)` },
            { transform: "translate(0, 0)" },
        ]);
    });

    it("never leaves the window", () => {
        mount();
        pointer(annotateButton(), "pointerdown", 100, 100);
        pointer(annotateButton(), "pointermove", -5000, 99_999);
        pointer(annotateButton(), "pointerup", -5000, 99_999);
        expect(toolbar.el.style.left).toBe(`${TOOLBAR_MARGIN}px`);
        expect(toolbar.el.style.top).toBe(`${window.innerHeight - TOOLBAR_MARGIN}px`);
        expect(loadToolbarFraction()).toEqual({ x: 0, y: 1 });
    });
});

describe("folding the toolbar", () => {
    let toolbar: Toolbar;
    let onCollapse: Mock<() => void>;

    const mount = (position: "bottom-right" | "bottom-left" = "bottom-right") => {
        onCollapse = vi.fn<() => void>();
        toolbar = createToolbar({
            position,
            onToggleAnnotate: () => {},
            onTogglePins: () => {},
            onCollapse,
        });
        document.body.append(toolbar.el);
    };
    const part = <T extends HTMLElement>(selector: string) =>
        toolbar.el.querySelector<T>(selector) as T;
    const pointer = (target: Element, type: string, x: number, y: number) =>
        target.dispatchEvent(
            new PointerEvent(type, {
                bubbles: true,
                clientX: x,
                clientY: y,
                button: 0,
                isPrimary: true,
                pointerId: 1,
            })
        );

    beforeEach(() => {
        window.localStorage.clear();
    });
    afterEach(() => {
        toolbar.destroy();
        toolbar.el.remove();
    });

    it("folds into one button and opens out of it again, remembering which it was left as", () => {
        mount();
        part<HTMLButtonElement>(".tb-collapse").click();
        expect(toolbar.collapsed).toBe(true);
        expect(toolbar.el.classList.contains("collapsed")).toBe(true);
        expect(loadToolbarCollapsed()).toBe(true);

        part<HTMLButtonElement>(".tb-fab").click();
        expect(toolbar.collapsed).toBe(false);
        expect(toolbar.el.classList.contains("collapsed")).toBe(false);
        expect(loadToolbarCollapsed()).toBe(false);
    });

    it("comes back folded", () => {
        window.localStorage.setItem("notato:toolbar-collapsed", "1");
        mount();
        expect(toolbar.collapsed).toBe(true);
        expect(toolbar.el.classList.contains("collapsed")).toBe(true);
    });

    it("closes what was opened from its buttons as it folds, and only then", () => {
        mount();
        toolbar.setCollapsed(true);
        toolbar.setCollapsed(true);
        toolbar.setCollapsed(false);
        expect(onCollapse).toHaveBeenCalledOnce();
    });

    it("opens when annotating starts while it is folded, and folds again when it stops", () => {
        mount();
        toolbar.setCollapsed(true);
        toolbar.setActive(true);
        expect(toolbar.collapsed).toBe(false);
        // Only open while annotating: a reload now comes back folded.
        expect(loadToolbarCollapsed()).toBe(true);
        toolbar.setActive(false);
        expect(toolbar.collapsed).toBe(true);
    });

    it("stays open after annotating when it was open already, or opened by hand", () => {
        mount();
        toolbar.setActive(true);
        toolbar.setActive(false);
        expect(toolbar.collapsed).toBe(false);

        toolbar.setCollapsed(true);
        toolbar.setActive(true);
        part<HTMLButtonElement>(".tb-fab").click();
        toolbar.setActive(false);
        expect(toolbar.collapsed).toBe(false);
    });

    it("shows the count on the folded button, and the server only when something is wrong", () => {
        mount();
        const count = part(".tb-fab-count");
        const dot = part(".tb-fab-dot");
        expect(count.hidden).toBe(true);
        toolbar.setCount(3);
        expect([count.hidden, count.textContent]).toEqual([false, "3"]);
        toolbar.setCount(120);
        expect(count.textContent).toBe("99+");
        toolbar.setCount(0);
        expect(count.hidden).toBe(true);

        toolbar.setConnection("connected");
        expect(dot.hidden).toBe(true);
        toolbar.setConnection("offline");
        expect([dot.hidden, dot.dataset.state]).toEqual([false, "offline"]);
        toolbar.setConnection(null);
        expect(dot.hidden).toBe(true);
    });

    it("is dragged, not opened, by a drag that starts on the folded button", () => {
        mount();
        toolbar.setCollapsed(true);
        const fab = part<HTMLButtonElement>(".tb-fab");
        pointer(fab, "pointerdown", 100, 100);
        pointer(fab, "pointermove", 160, 40);
        pointer(fab, "pointerup", 160, 40);
        fab.click();
        expect(toolbar.collapsed).toBe(true);
        expect(loadToolbarFraction()).not.toBeNull();
    });

    it("points its chevron at the side it folds to", () => {
        mount("bottom-left");
        expect(part(".tb-collapse path").getAttribute("d")).toBe("M15 6l-6 6 6 6");
        toolbar.destroy();
        toolbar.el.remove();
        mount("bottom-right");
        expect(part(".tb-collapse path").getAttribute("d")).toBe("M9 6l6 6-6 6");
    });
});
