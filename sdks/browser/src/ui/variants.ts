import type { Annotation } from "@notato/schema";
import { clip, messageOf } from "../text.ts";
import { h } from "./dom.ts";
import { createFrames, type FrameJob, type Frames } from "./frame.ts";
import { viewportRect } from "./frames.ts";
import { addSheet, type Sheet } from "./sheet.ts";

/**
 * Variants: several versions of one piece of UI, all written into the page by the agent, of which the person sees
 * one at a time and picks one. Nothing here knows about React or any framework. A version is any element with
 *
 *   data-notato-variant="header"          the group: the same on every version of the same thing
 *   data-notato-variant-name="Stacked"    which version this element is part of
 *
 * Elements of a group that share a name are one version, so a version can be several siblings. The page shows the
 * elements of the chosen version and hides the rest with a style rule, which also covers an element the app creates
 * later (a hot reload, a re-render), and a switcher sits over the group to flip between versions. When the markers
 * go away (the agent applied the pick and removed them) the rule and the switcher go with them.
 */
export const VARIANT_ATTR = "data-notato-variant";
export const VARIANT_NAME_ATTR = "data-notato-variant-name";
/** On the `<style>` element, where the browser needs one. */
export const VARIANTS_STYLE_MARKER = "data-notato-variants-style";
const MAX_NAME = 40;

export interface VariantGroupInfo {
    group: string;
    /** The versions' names, in the order they appear in the page. */
    options: string[];
    /** The version being shown. */
    active: string;
    /** The annotation this group was offered for, when there is one. */
    annotationId?: string;
    /** What the person has picked on that annotation, if anything. */
    chosen?: string;
}

export interface VariantsOptions {
    /** Where the switchers go. */
    layer: HTMLElement;
    /** The page's window and each same-origin iframe's. */
    windows(): Window[];
    /** What the server knows, to tell which group is for which annotation and what was picked. */
    annotations(): Annotation[];
    /** Keeps what was last shown for a group across a reload. */
    namespace: string;
    /**
     * Sends the person's pick (or, with `null`, takes it back). Passed only when there is a server for it to reach;
     * without it the switcher previews and offers no pick.
     */
    onChoose?(annotationId: string, name: string | null): Promise<void>;
    /** The connected agent's name when there is exactly one, so the switcher can say who applies the pick. */
    agentName?(): string | undefined;
    /** The frame the switchers are measured and placed in, shared with whatever else follows the page. */
    frames?: Frames;
}

export interface Variants {
    /** Looks at the page again: finds groups, applies the shown version and places the switchers. */
    update(): void;
    /** Same, at the next frame; many calls in one frame make one. */
    schedule(): void;
    /**
     * The page changed in a way that can have changed its versions: `found` when a version marker was added or changed,
     * otherwise only something removed, which matters only while there are versions. The page is looked through again
     * at the next frame when it can matter, and not otherwise: a page without versions is never searched for them.
     */
    pageChanged(found: boolean): void;
    /** What the server knows changed: the switchers there are are drawn again at the next frame. */
    redraw(): void;
    /** Something moved (a scroll, a resize): the switchers there are are placed again at the next frame. Cheap. */
    reposition(): void;
    list(): VariantGroupInfo[];
    /** Where the shown version of a group is on screen (its top-left corner, in the viewport), or null if it is not. */
    anchor(group: string): { left: number; top: number } | null;
    /** Shows a version. False when there is no such group or version. */
    select(group: string, name: string): boolean;
    /** Shows the next (or, with -1, the previous) version of a group; by default the one last used, or the first. */
    step(delta: number, group?: string): VariantGroupInfo | null;
    destroy(): void;
}

interface Version {
    name: string;
    elements: Element[];
}
interface Group {
    id: string;
    /** In the order first seen in the page. */
    versions: Version[];
}

/** A string safe inside a double-quoted CSS attribute selector. */
const cssString = (value: string) => value.replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\a ");

const storageKey = (ns: string, group: string) => `notato:variant:${ns}:${group}`;
const remembered = (ns: string, group: string): string | null => {
    try {
        return window.sessionStorage.getItem(storageKey(ns, group));
    } catch {
        return null;
    }
};
const remember = (ns: string, group: string, name: string) => {
    try {
        window.sessionStorage.setItem(storageKey(ns, group), name);
    } catch {
        // a browser that will not keep it: the version shown is lost on reload, nothing else
    }
};

/** The elements the page has, grouped. A group with one version is not a choice yet, so it is left out. */
function findGroups(docs: Document[]): Map<string, Group> {
    const groups = new Map<string, Group>();
    for (const doc of docs) {
        for (const el of Array.from(doc.querySelectorAll(`[${VARIANT_ATTR}]`))) {
            const id = el.getAttribute(VARIANT_ATTR)?.trim();
            if (!id) continue;
            let group = groups.get(id);
            if (!group) {
                group = { id, versions: [] };
                groups.set(id, group);
            }
            let name = el.getAttribute(VARIANT_NAME_ATTR)?.trim().slice(0, MAX_NAME);
            if (!name) {
                // An element with no name is a version of its own. It gets a name so the rule that hides it can address it.
                name = `Option ${group.versions.length + 1}`;
            }
            // The rule matches the attribute exactly, so a name that was padded or too long is written back as it is used.
            if (el.getAttribute(VARIANT_NAME_ATTR) !== name)
                el.setAttribute(VARIANT_NAME_ATTR, name);
            const known = group.versions.find((v) => v.name === name);
            if (known) known.elements.push(el);
            else group.versions.push({ name, elements: [el] });
        }
    }
    for (const [id, group] of groups) if (group.versions.length < 2) groups.delete(id);
    return groups;
}

/** The area an element takes up on screen. A wrapper with `display: contents` has none of its own, so its children's. */
function visualRect(
    el: Element,
    depth = 0
): { left: number; top: number; right: number; bottom: number } | null {
    const r = viewportRect(el);
    if (r.width > 0 || r.height > 0)
        return { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height };
    if (depth >= 3) return null;
    let out: { left: number; top: number; right: number; bottom: number } | null = null;
    for (const child of Array.from(el.children)) {
        const c = visualRect(child, depth + 1);
        if (!c) continue;
        out = out
            ? {
                  left: Math.min(out.left, c.left),
                  top: Math.min(out.top, c.top),
                  right: Math.max(out.right, c.right),
                  bottom: Math.max(out.bottom, c.bottom),
              }
            : c;
    }
    return out;
}

interface Switcher {
    el: HTMLElement;
    /** What it was last drawn from, so a redraw only happens when something changed. */
    drawn: string;
    /** Its size as last laid out, while it was shown; nothing before it has been. */
    size?: { w: number; h: number };
    busy: boolean;
    error?: string;
    errorTimer?: ReturnType<typeof setTimeout>;
}

export function createVariants(options: VariantsOptions): Variants {
    const { layer, namespace } = options;
    const selected = new Map<string, string>();
    const switchers = new Map<string, Switcher>();
    let groups = new Map<string, Group>();
    /** The group most recently used, which the keyboard shortcut acts on. */
    let lastGroup: string | undefined;
    const frames = options.frames ?? createFrames();
    /** The page has to be looked through for versions again, or the switchers drawn again, at the next frame. */
    let rescan = true;
    let redraw = false;
    /** A pick that settles after destroy() asks for a redraw; that must not put the rule and the switchers back. */
    let destroyed = false;
    /** The documents that have our style rule, so one that no longer needs it can lose it. */
    const styled = new Map<Document, Sheet>();

    const annotationFor = (id: string): Annotation | undefined =>
        options
            .annotations()
            .filter((a) => a.variants?.group === id)
            .sort((a, b) =>
                (b.variants?.offeredAt ?? "").localeCompare(a.variants?.offeredAt ?? "")
            )[0];

    /** What to show: what was shown before, else the original, else the first. */
    const activeOf = (group: Group): string => {
        const names = group.versions.map((v) => v.name);
        const keep = selected.get(group.id);
        if (keep && names.includes(keep)) return keep;
        const stored = remembered(namespace, group.id);
        if (stored && names.includes(stored)) return stored;
        const picked = annotationFor(group.id)?.variants?.chosen;
        if (picked && names.includes(picked)) return picked;
        return names.find((n) => /^original$/i.test(n)) ?? names[0] ?? "";
    };

    const infoOf = (group: Group): VariantGroupInfo => {
        const annotation = annotationFor(group.id);
        return {
            group: group.id,
            options: group.versions.map((v) => v.name),
            active: activeOf(group),
            annotationId: annotation?.id,
            chosen: annotation?.variants?.chosen,
        };
    };

    // ---- hiding what is not shown ------------------------------------------------------------------------
    /** One rule per group: everything in it that is not the shown version is hidden. It reaches elements made later too. */
    function applyStyles(docs: Document[]) {
        const wanted = new Map<Document, string[]>();
        for (const group of groups.values()) {
            const active = activeOf(group);
            for (const doc of new Set(
                group.versions.flatMap((v) => v.elements.map((e) => e.ownerDocument))
            )) {
                const rules = wanted.get(doc) ?? [];
                rules.push(
                    `[${VARIANT_ATTR}="${cssString(group.id)}"]:not([${VARIANT_NAME_ATTR}="${cssString(active)}"]){display:none !important}`
                );
                wanted.set(doc, rules);
            }
        }
        for (const doc of docs) {
            const existing = styled.get(doc);
            const rules = wanted.get(doc);
            if (!rules) {
                existing?.remove();
                styled.delete(doc);
                continue;
            }
            const css = rules.join("\n");
            if (existing) existing.set(css);
            else styled.set(doc, addSheet(doc, css, VARIANTS_STYLE_MARKER));
        }
        // A document no longer watched (its frame went away, or navigated) is not looked after any more.
        for (const [doc, sheet] of [...styled]) {
            if (docs.includes(doc)) continue;
            sheet.remove();
            styled.delete(doc);
        }
    }

    // ---- the switcher over a group -----------------------------------------------------------------------
    function drawSwitcher(group: Group, info: VariantGroupInfo, sw: Switcher) {
        const annotation = annotationFor(group.id);
        const status = annotation?.status;
        const chosen = annotation?.variants?.chosen;
        const canPick = Boolean(
            options.onChoose &&
                annotation &&
                (status === "acknowledged" || status === "variant_chosen")
        );
        const signature = JSON.stringify([
            info.options,
            info.active,
            annotation?.id,
            status,
            chosen,
            canPick,
            sw.busy,
            sw.error,
        ]);
        if (sw.drawn === signature) return;
        sw.drawn = signature;

        const names = info.options;
        const pick = async (name: string | null) => {
            if (!annotation || !options.onChoose || sw.busy) return;
            sw.busy = true;
            sw.error = undefined;
            drawSwitcher(group, infoOf(group), sw);
            try {
                await options.onChoose(annotation.id, name);
            } catch (error) {
                sw.error = messageOf(error);
                if (sw.errorTimer) clearTimeout(sw.errorTimer);
                sw.errorTimer = setTimeout(() => {
                    sw.error = undefined;
                    schedule();
                }, 5000);
            } finally {
                sw.busy = false;
                sw.drawn = "";
                schedule();
            }
        };

        const tabs = names.map((name) => {
            const tab = h(
                "button",
                {
                    class: "vopt",
                    type: "button",
                    role: "tab",
                    "aria-selected": String(name === info.active),
                    title:
                        annotation?.variants?.options.find((o) => o.name === name)?.summary ?? name,
                },
                name,
                name === chosen ? h("span", { class: "vmark", "aria-label": "picked" }, " ✓") : null
            );
            tab.addEventListener("click", () => {
                lastGroup = group.id;
                api.select(group.id, name);
            });
            return tab;
        });

        const useLabel = `Use “${clip(info.active, 18)}”`;
        sw.el.replaceChildren(
            h("span", { class: "vtag" }, "Variants"),
            h("div", { class: "vtabs", role: "tablist", "aria-label": "Versions" }, ...tabs),
            ...(canPick && info.active !== chosen
                ? [
                      (() => {
                          const use = h("button", { class: "vuse", type: "button" }, useLabel);
                          use.disabled = sw.busy;
                          use.addEventListener("click", () => void pick(info.active));
                          return use;
                      })(),
                  ]
                : []),
            ...(chosen && status === "variant_chosen"
                ? [
                      h(
                          "span",
                          { class: "vstate" },
                          info.active === chosen
                              ? `Picked. ${options.agentName?.() ?? "The agent"} is applying “${chosen}”.`
                              : `Picked “${chosen}”.`
                      ),
                      ...(options.onChoose
                          ? [
                                (() => {
                                    const undo = h(
                                        "button",
                                        { class: "vundo", type: "button" },
                                        "Take back"
                                    );
                                    undo.disabled = sw.busy;
                                    undo.addEventListener("click", () => void pick(null));
                                    return undo;
                                })(),
                            ]
                          : []),
                  ]
                : []),
            ...(!annotation
                ? [
                      h(
                          "span",
                          {
                              class: "vstate",
                              title: "Ask your agent to offer these with notato_variants_ready to be able to pick one.",
                          },
                          "Preview"
                      ),
                  ]
                : []),
            ...(sw.error ? [h("span", { class: "verr", role: "alert" }, sw.error)] : [])
        );
    }

    /** The area the shown version takes up. */
    function shownArea(group: Group) {
        const active = activeOf(group);
        const shown = group.versions.find((v) => v.name === active);
        let area: { left: number; top: number; right: number; bottom: number } | null = null;
        for (const el of shown?.elements ?? []) {
            const r = visualRect(el);
            if (!r) continue;
            area = area
                ? {
                      left: Math.min(area.left, r.left),
                      top: Math.min(area.top, r.top),
                      right: Math.max(area.right, r.right),
                      bottom: Math.max(area.bottom, r.bottom),
                  }
                : r;
        }
        return area;
    }

    /** Where a switcher goes: over the shown version, or nowhere (null) while that is off screen. Only reads. */
    function measureSwitcher(group: Group, sw: Switcher) {
        const area = shownArea(group);
        const view = { w: window.innerWidth, h: window.innerHeight };
        if (!area || area.bottom < 0 || area.top > view.h || area.right < 0 || area.left > view.w)
            return null;
        // Hidden, it has no size: the one it had when last shown, or a guess, put right at the next frame.
        const shown = sw.el.style.display === "flex";
        if (shown && sw.el.offsetWidth) sw.size = { w: sw.el.offsetWidth, h: sw.el.offsetHeight };
        const width = sw.size?.w || 260;
        const height = sw.size?.h || 32;
        // Past where a pin for the annotation on this group would sit, at the top-left corner.
        const left = Math.min(Math.max(8, area.left + 34), Math.max(8, view.w - width - 8));
        // Above the group; when there is no room, over its top edge so it stays reachable.
        const above = area.top - height - 8;
        const top =
            above >= 8
                ? above
                : Math.min(Math.max(8, area.top + 8), Math.max(8, view.h - height - 8));
        return { left, top, guessed: !shown };
    }

    function placeSwitcher(sw: Switcher, at: ReturnType<typeof measureSwitcher>) {
        if (!at) {
            if (sw.el.style.display !== "none") sw.el.style.display = "none";
            return;
        }
        sw.el.style.display = "flex";
        sw.el.style.left = `${at.left}px`;
        sw.el.style.top = `${at.top}px`;
        // Placed by a guess at its size: placed again from its real size once it has one.
        if (at.guessed) frames.schedule(job);
    }

    // ---- looking at the page -----------------------------------------------------------------------------
    /** Finds the groups, applies the shown versions, and makes and drops switchers to match. */
    function scan() {
        const docs = options.windows().map((w) => w.document);
        groups = findGroups(docs);
        for (const group of groups.values()) selected.set(group.id, activeOf(group));
        for (const id of [...selected.keys()]) if (!groups.has(id)) selected.delete(id);
        applyStyles(docs);

        for (const [id, sw] of switchers) {
            if (groups.has(id)) continue;
            if (sw.errorTimer) clearTimeout(sw.errorTimer);
            sw.el.remove();
            switchers.delete(id);
        }
        for (const group of groups.values()) {
            if (switchers.has(group.id)) continue;
            const el = h("div", {
                class: "vpill",
                role: "group",
                "aria-label": `Variants of ${group.id}`,
            });
            layer.append(el);
            switchers.set(group.id, { el, drawn: "", busy: false });
        }
    }

    let measured: Array<[Switcher, ReturnType<typeof measureSwitcher>]> = [];
    /**
     * Read: where each switcher goes. A frame that has to look through the page, or draw the switchers again, does that
     * first; that changes the page, but only when versions come, go or are picked, not as it scrolls.
     */
    const job: FrameJob = {
        read() {
            if (destroyed) return;
            if (rescan) {
                rescan = false;
                redraw = true;
                scan();
            }
            if (redraw) {
                redraw = false;
                for (const group of groups.values()) {
                    const sw = switchers.get(group.id);
                    if (sw) drawSwitcher(group, infoOf(group), sw);
                }
            }
            measured = [];
            for (const group of groups.values()) {
                const sw = switchers.get(group.id);
                if (sw) measured.push([sw, measureSwitcher(group, sw)]);
            }
        },
        write() {
            const now = measured;
            measured = [];
            for (const [sw, at] of now) placeSwitcher(sw, at);
        },
    };

    // ---- the public surface ------------------------------------------------------------------------------
    function update() {
        if (destroyed) return;
        frames.cancel(job);
        rescan = true;
        job.read?.();
        job.write?.();
    }

    function schedule() {
        if (destroyed) return;
        rescan = true;
        frames.schedule(job);
    }

    const api: Variants = {
        update,
        schedule,
        pageChanged(found) {
            if (found || groups.size > 0) schedule();
        },
        redraw() {
            if (destroyed || groups.size === 0) return;
            redraw = true;
            frames.schedule(job);
        },
        reposition() {
            if (!destroyed && groups.size > 0) frames.schedule(job);
        },
        list: () => [...groups.values()].map(infoOf),
        anchor(id) {
            const group = groups.get(id);
            const area = group ? shownArea(group) : null;
            return area ? { left: area.left, top: area.top } : null;
        },
        select(id, name) {
            const group = groups.get(id);
            if (!group?.versions.some((v) => v.name === name)) return false;
            selected.set(id, name);
            remember(namespace, id, name);
            lastGroup = id;
            update();
            return true;
        },
        step(delta, id) {
            const target =
                (id ? groups.get(id) : undefined) ??
                (lastGroup ? groups.get(lastGroup) : undefined) ??
                [...groups.values()][0];
            if (!target) return null;
            const names = target.versions.map((v) => v.name);
            const at = names.indexOf(activeOf(target));
            const next = names[(at + delta + names.length) % names.length];
            if (next === undefined) return null;
            api.select(target.id, next);
            return infoOf(target);
        },
        destroy() {
            destroyed = true;
            frames.cancel(job);
            for (const sw of switchers.values()) {
                if (sw.errorTimer) clearTimeout(sw.errorTimer);
                sw.el.remove();
            }
            switchers.clear();
            for (const sheet of styled.values()) sheet.remove();
            styled.clear();
            groups = new Map();
        },
    };
    return api;
}
