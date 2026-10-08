import { type Annotation, type Status, sampleAnnotation } from "@notato/schema";
import { afterEach, beforeEach, type Mock, vi } from "vitest";
import { sheetsIn } from "../../src/ui/sheet.ts";
import {
    createVariants,
    VARIANT_ATTR,
    VARIANT_NAME_ATTR,
    VARIANTS_STYLE_MARKER,
    type Variants,
    type VariantsOptions,
} from "../../src/ui/variants.ts";

// What the variants tests share: a page to put versions in, the layer the switchers go in, and the annotations the
// server knows. A test file calls `useVariantsPage()` once, and each of its tests starts with them afresh.

export let layer: HTMLElement;
export let page: HTMLElement;
/** What the server knows: `setAnnotations` changes it. */
export let annotations: Annotation[];
/** What a pick is sent with. It resolves unless a test says otherwise. */
export let onChoose: Mock<NonNullable<VariantsOptions["onChoose"]>>;
let created: Variants[];

export const setAnnotations = (next: Annotation[]) => {
    annotations = next;
};

export function useVariantsPage(): void {
    beforeEach(() => {
        vi.useFakeTimers();
        layer = document.createElement("div");
        page = document.createElement("main");
        document.body.append(page, layer);
        annotations = [];
        onChoose = vi.fn(async () => {});
        created = [];
        window.sessionStorage.clear();
    });
    afterEach(() => {
        for (const v of created) v.destroy();
        for (const style of document.querySelectorAll(`style[${VARIANTS_STYLE_MARKER}]`))
            style.remove();
        document.adoptedStyleSheets = [];
        layer.remove();
        page.remove();
        window.sessionStorage.clear();
        vi.useRealTimers();
    });
}

/** Variants over the page, already looked at once. `onChoose` is passed unless the test says `onChoose: undefined`. */
export const make = (options: Partial<VariantsOptions> = {}): Variants => {
    const v = createVariants({
        layer,
        windows: () => [window],
        annotations: () => annotations,
        namespace: "ns",
        onChoose,
        ...options,
    });
    created.push(v);
    v.update();
    return v;
};

/** One element of a version. `name` left out means the element has no name attribute at all. */
export const version = (group: string, name?: string, parent: Element = page): HTMLElement => {
    const el = document.createElement("div");
    el.setAttribute(VARIANT_ATTR, group);
    if (name !== undefined) el.setAttribute(VARIANT_NAME_ATTR, name);
    parent.append(el);
    return el;
};
export const versions = <N extends string[]>(group: string, ...names: N) =>
    names.map((name) => version(group, name)) as { [K in keyof N]: HTMLElement };

/** An annotation the versions of `group` were offered for. */
export const offer = (
    group: string,
    extra: { id?: string; status?: Status; chosen?: string; offeredAt?: string } = {}
): Annotation => ({
    ...sampleAnnotation,
    id: extra.id ?? "a1",
    status: extra.status ?? "acknowledged",
    thread: [],
    variants: {
        group,
        options: [
            { name: "Original", summary: "As it is today" },
            { name: "Stacked", summary: "Logo above the links" },
        ],
        offeredAt: extra.offeredAt ?? "2026-10-05T10:00:00.000Z",
        chosen: extra.chosen,
    },
});

export const display = (el: Element) => getComputedStyle(el).display;
/** The rules that hide what is not shown, however the browser took them (a constructed sheet, or a style element). */
export const styleTags = () => sheetsIn(document, VARIANTS_STYLE_MARKER);
export const styleText = () => styleTags()[0] ?? "";
export const pills = () => [...layer.querySelectorAll<HTMLElement>(".vpill")];
export const pill = () => pills()[0] as HTMLElement;
export const tabs = () => [...layer.querySelectorAll<HTMLButtonElement>(".vopt")];
export const tabName = (tab: Element) => tab.firstChild?.textContent;
export const tab = (name: string) => tabs().find((t) => tabName(t) === name) as HTMLButtonElement;
export const selectedTabs = () =>
    tabs()
        .filter((t) => t.getAttribute("aria-selected") === "true")
        .map(tabName);
export const button = (label: string) =>
    [...layer.querySelectorAll("button")].find((b) => b.textContent?.includes(label)) as
        | HTMLButtonElement
        | undefined;
export const use = () => button("Use “");
export const takeBack = () => button("Take back");
export const state = () => layer.querySelector(".vstate")?.textContent;
export const deferred = () => {
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
};
/** Lets promises settle and the frame the switcher redraws in go by. */
export const frame = () => vi.advanceTimersByTimeAsync(20);

/** Pretends the browser laid `el` out here; elements in happy-dom have no size of their own. */
export const lay = (el: Element, left: number, top: number, width: number, height: number) => {
    el.getBoundingClientRect = () =>
        ({
            left,
            top,
            width,
            height,
            right: left + width,
            bottom: top + height,
            x: left,
            y: top,
        }) as DOMRect;
};
