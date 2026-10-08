import type { IdentityPlugin } from "@notato/core";
import type { AnimationInfo } from "./plugins/animations.ts";
import {
    accessibleName,
    DEFAULT_TEST_ID_ATTRIBUTES,
    roleOf,
    safeText,
    testIdOf,
} from "./plugins/identity-dom.ts";
import { clip } from "./text.ts";
import type { Selection } from "./ui/picker.ts";

/** An element's text names it only up to this long: a container's whole text is noise in a one-line label. */
const NAMING_TEXT_MAX = 60;
/** A name in a label is shortened past this. */
const NAME_MAX = 40;

/**
 * The label over the element the pointer is on, worked out for every element the pointer crosses: only what is cheap
 * to read (its role, its name, its test id), never the full identity, which is worked out for what is picked.
 */
export function hoverLabel(el: Element, testIdAttributes = DEFAULT_TEST_ID_ATTRIBUTES): string {
    const kind = roleOf(el) ?? el.tagName.toLowerCase();
    const named = accessibleName(el);
    const text = named
        ? undefined
        : safeText(el, NAMING_TEXT_MAX + 1)
              .replace(/\s+/g, " ")
              .trim();
    const name = named ?? (text && text.length <= NAMING_TEXT_MAX ? text : undefined);
    const testId = testIdOf(el, testIdAttributes);
    const base = name ? `${kind} “${clip(name, NAME_MAX)}”` : kind;
    return testId ? `${base} · ${clip(testId, NAME_MAX)}` : base;
}

/**
 * A line in the popover for a picked element, from its full identity: what it is, what it is called, and the
 * component it belongs to (`button “Pay now” in <CheckoutForm>`).
 */
export function describeElement(el: Element, identity: IdentityPlugin[]): string {
    const id: Record<string, unknown> = {};
    for (const plugin of identity) {
        try {
            Object.assign(id, plugin.resolve(el));
        } catch {
            // a failing plugin only costs the label some detail
        }
    }
    const kind = (id.role as string | undefined) ?? el.tagName.toLowerCase();
    const text = id.text as string | undefined;
    const name =
        (id.name as string | undefined) ??
        (text && text.length <= NAMING_TEXT_MAX ? text : undefined);
    const component = (id.component as { name: string } | undefined)?.name;
    const base = name ? `${kind} “${clip(name, NAME_MAX)}”` : kind;
    return component ? `${base} in <${component}>` : base;
}

/** The popover's title for what is picked, and a line for each part of it. */
export function selectionSummary(
    sel: Selection,
    describe: (el: Element) => string
): { title: string; targets: string[] } {
    const targets = sel.elements.map(describe);
    if (sel.kind === "text")
        return {
            title: "Text selection",
            targets: [`“${clip(sel.selectedText ?? "", NAMING_TEXT_MAX)}”`, ...targets],
        };
    if (sel.kind === "area") return { title: "Area", targets: [`in ${targets[0] ?? "page"}`] };
    return {
        title: sel.elements.length > 1 ? `${sel.elements.length} elements` : "1 element",
        targets,
    };
}

/** How many of the animations on what is picked the popover names. */
const ANIMATIONS_NAMED = 3;

/** `fade 300ms (running at 25%)`: an animation as the popover names it. */
const animationLabel = (a: AnimationInfo) =>
    [
        a.name ?? a.property ?? a.kind,
        a.duration !== undefined ? ` ${Math.round(a.duration)}ms` : "",
        a.progress !== undefined ? ` (${a.state} at ${Math.round(a.progress * 100)}%)` : "",
    ].join("");

/**
 * The small print under what is picked: how to add to it, what on it is moving (worth pausing first), and whether a
 * screenshot will be taken. Undefined when there is nothing to say.
 */
export function pickHint(options: {
    kind: Selection["kind"];
    animations: AnimationInfo[];
    frozen: boolean;
    screenshotsOff: boolean;
}): string | undefined {
    const { kind, animations, frozen, screenshotsOff } = options;
    const moving = animations.slice(0, ANIMATIONS_NAMED);
    const lines = [
        kind === "element" || kind === "multi"
            ? "Cmd/Ctrl-click adds or removes elements."
            : undefined,
        moving.length
            ? `Animating: ${moving.map(animationLabel).join(", ")}.${frozen ? "" : " Pause first to annotate a frame."}`
            : undefined,
        screenshotsOff ? "No screenshot will be taken: they are turned off." : undefined,
    ];
    return lines.filter(Boolean).join(" ") || undefined;
}
