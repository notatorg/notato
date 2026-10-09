import type { AnnotationRecord } from "@notato/core";
import type { Annotation } from "@notato/schema";
import { resolveIdentity } from "../resolve.ts";
import { colorForName, initialsOf } from "../settings.ts";
import {
    type CardActions,
    type CardState,
    cardSignature,
    closeForms,
    drawCard,
    hasWorkInProgress,
    pruneForms,
} from "./card.ts";
import { h } from "./dom.ts";
import { createFrames, type FrameJob, type Frames } from "./frame.ts";
import { viewportRect } from "./frames.ts";
import { animateIn, animateOut, FADE, growIn, isLeaving, POP, settle } from "./motion.ts";

export interface Pins {
    /** Re-sync pins with the records (added, removed, status changed). */
    refresh(): void;
    /** Re-measure positions after scroll, resize or DOM changes. Throttled to one frame. */
    schedule(): void;
    /**
     * The page gained or lost elements, or one changed what it answers to (its id, its test id). At the next placing, a
     * pin whose element went, or no longer matches, looks for it again, and one whose element was not there looks in
     * `touched` (the elements added, and those changed): only there can it have appeared. Without `touched`, too much
     * changed to say, and those look in the whole page. Until then each pin keeps the element it found.
     */
    domChanged(touched?: Element[]): void;
    setVisible(visible: boolean): void;
    /**
     * A pin for a note still being made (its screenshot taken, its identity worked out), shown at once where the note
     * will be. When the note is made its own pin takes this one's place, without coming in again.
     */
    pending(pin: PendingPin): PendingHandle;
    destroy(): void;
}

export interface PendingPin {
    /** The number the note will have. */
    number: number;
    route: string;
    /** What the note is being made on, and where that was, in page coordinates, for when it has gone. */
    elements: Element[];
    rect: { x: number; y: number; w: number; h: number };
}

export interface PendingHandle {
    /** The note is made, with this id: its pin takes over at the next refresh. */
    done(id: string): void;
    /** It was not made after all: the pin goes. */
    cancel(): void;
}

/**
 * The most pins drawn on one page: the newest. A page with more notes than that would be covered in them, and each pin
 * costs a measurement every time the page scrolls. The toolbar's count, the copied Markdown and the board have every
 * note. The native SDKs draw the same number.
 */
export const MAX_PINS = 150;

interface PinsOptions extends CardActions {
    layer: HTMLElement;
    records(): AnnotationRecord[];
    currentRoute(): string;
    /**
     * Where to put the pin when the element it points at is not on screen. A request for variants points at one version,
     * and while another is shown that element is hidden; the pin then goes where the shown version is.
     */
    fallbackAnchor?(annotation: Annotation): { left: number; top: number } | null;
    /** The frame the pins are measured and placed in, shared with whatever else follows the page. */
    frames?: Frames;
}

/** The number on the pin. The screenshot plugin stores it so pin and screenshot always agree. */
export function pinNumber(annotation: Annotation, fallback: number): number {
    const shot = annotation.context.screenshot as { pin?: unknown } | undefined;
    return typeof shot?.pin === "number" ? shot.pin : fallback;
}

/** The next pin number for a new note: one past the highest so far. A loop: past ~65,000 notes a spread would throw. */
export function nextPinNumber(records: Iterable<AnnotationRecord>): number {
    let highest = 0;
    let index = 0;
    for (const record of records) {
        index += 1;
        const n = pinNumber(record.annotation, index);
        if (n > highest) highest = n;
    }
    return highest + 1;
}

/** Whether an element found before is still the one an identity means: still in the page, and still matching it. */
function stillMeans(el: Element, record: AnnotationRecord): boolean {
    if (!el.isConnected) return false;
    const selector = record.annotation.target.identity[0]?.selector;
    try {
        return selector ? el.matches(selector) : false;
    } catch {
        return false;
    }
}

interface PinView extends CardState {
    pin: HTMLButtonElement;
    /** Made the first time the card is opened: most pins are never opened. */
    card?: HTMLElement;
    record: AnnotationRecord;
    /** Its note is on this page and among the newest: the pin is drawn. A pin not drawn is kept only for its card. */
    here: boolean;
    /** The element the pin points at as last found. Null: looked for, and not in the page. Undefined: not looked for. */
    el?: Element | null;
    /** What the pin last said, and where it was last put: nothing is written to it while neither changes. */
    says?: string;
    placed?: string;
    /** The pin's centre on screen, as last placed, for its card to go beside. */
    at?: { left: number; top: number };
    /** The open card's height as last laid out, read with everything else so placing it does not lay the page out. */
    cardHeight?: number;
    /** Just made: it grows in the first time it is placed. */
    fresh?: boolean;
    /** Shown because the pointer is over the pin or the card. */
    hovered: boolean;
    /** Focus is on the pin or in its card: kept up while someone tabs through it. */
    focused: boolean;
    /** The card is being redrawn: focus lost with the old contents is not focus leaving the card. */
    redrawing?: boolean;
    hideTimer?: ReturnType<typeof setTimeout>;
    /** What the card on screen was drawn from. A card is only redrawn when this changes, so a click is never lost to a redraw. */
    drawn?: string;
}

const CARD_WIDTH = 320;
/** Past this many elements added or changed before the next placing, pins whose element was missing look everywhere. */
const MAX_TOUCHED = 500;
/** How long a card stays after the pointer leaves, so the pointer can travel from the pin onto it. */
const HIDE_DELAY_MS = 160;

/** A pin for a note being made (see `Pins.pending`). */
interface Ghost extends PendingPin {
    pin: HTMLButtonElement;
    /** Set once the note is made: the note's pin takes this one over. */
    id?: string;
    placed?: string;
}

/** Where a pin goes on screen: its centre, by a transform, which moves it without laying the page out. */
const moveTo = (pin: HTMLElement, left: number, top: number) => {
    pin.style.transform = `translate3d(${left}px, ${top}px, 0)`;
};

export function createPins(options: PinsOptions): Pins {
    const { layer, records, currentRoute, fallbackAnchor, refusal } = options;
    const frames = options.frames ?? createFrames();
    const views = new Map<string, PinView>();
    const ghosts = new Set<Ghost>();
    let visible = true;
    /** What changed in the page since the pins were last placed (see `domChanged`); null for nothing. */
    let changed: { all: boolean; touched: Element[] } | null = null;

    /** Focus really is on the pin or in its card. A card redrawn under the focused button loses it without a word. */
    const focusWithin = (view: PinView) => {
        const active = (view.pin.getRootNode() as Document | ShadowRoot).activeElement;
        return active !== null && (active === view.pin || Boolean(view.card?.contains(active)));
    };
    const isOpen = (view: PinView) =>
        view.hovered || view.pinned || (view.focused && focusWithin(view));
    const drawnFrom = (view: PinView) =>
        cardSignature(view.record.annotation, refusal?.(view.record.annotation.id));

    const renderCard = (view: PinView) => {
        const card = cardOf(view);
        const annotation = view.record.annotation;
        pruneForms(view, annotation, options);
        view.drawn = drawnFrom(view);
        view.cardHeight = undefined;
        view.redrawing = true;
        try {
            drawCard(
                {
                    card,
                    state: view,
                    annotation,
                    current: () => view.record.annotation,
                    number: view.pin.textContent ?? "",
                    draw: () => renderCard(view),
                    redraw: () => redraw(view),
                    close: () => {
                        view.pinned = false;
                        view.hovered = false;
                        view.focused = false;
                        syncCard(view);
                    },
                },
                options
            );
        } finally {
            view.redrawing = false;
        }
    };

    /** After something finished in the background: an open card shows it now, a closed one when it next opens. */
    const redraw = (view: PinView) => {
        if (!views.has(view.record.annotation.id)) return;
        if (isOpen(view)) renderCard(view);
        else view.drawn = undefined;
    };

    /** Focus moving to somewhere that is not this pin or its card. */
    const leaving = (view: PinView, ev: FocusEvent) => {
        const to = ev.relatedTarget as Node | null;
        return !to || (to !== view.pin && !view.card?.contains(to));
    };

    /** The card of a pin, made the first time it is wanted and kept right after its pin. */
    const cardOf = (view: PinView): HTMLElement => {
        if (view.card) return view.card;
        const id = view.pin.getAttribute("aria-controls") ?? "";
        const card = h("div", {
            class: "card",
            id,
            role: "dialog",
            tabindex: "-1",
            "aria-label": view.pin.getAttribute("aria-label") ?? "Note",
        });
        card.addEventListener("mouseenter", () => setHover(view, true));
        card.addEventListener("mouseleave", () => setHover(view, false));
        card.addEventListener("focusin", () => setFocus(view, true));
        card.addEventListener("focusout", (ev) => {
            if (!view.redrawing && leaving(view, ev)) setFocus(view, false);
        });
        view.card = card;
        view.pin.after(card);
        return card;
    };

    const placeCard = (view: PinView) => {
        const card = view.card;
        if (!card) return;
        // Beside the pin, which is 24px across and centred where it was placed.
        const pin = view.at
            ? { left: view.at.left - 12, right: view.at.left + 12, top: view.at.top - 12 }
            : view.pin.getBoundingClientRect();
        const left =
            pin.right + 10 + CARD_WIDTH < window.innerWidth
                ? pin.right + 10
                : Math.max(8, pin.left - 10 - CARD_WIDTH);
        // Measured with the pins when it was open already; just opened or redrawn, it has to be measured now.
        const height = view.cardHeight ?? card.offsetHeight;
        card.style.left = `${left}px`;
        card.style.top = `${Math.min(Math.max(8, pin.top - 8), Math.max(8, window.innerHeight - height - 8))}px`;
    };

    const expanded = (view: PinView, open: boolean) => {
        const value = String(open);
        if (view.pin.getAttribute("aria-expanded") !== value)
            view.pin.setAttribute("aria-expanded", value);
    };

    /** Fades a card away, and hides it once it has gone. */
    const closeCard = (card: HTMLElement) => {
        if (card.style.display !== "block" || isLeaving(card)) return;
        animateOut(
            card,
            () => {
                card.style.display = "none";
            },
            POP
        );
    };
    /** Hides a card at once: its pin went too. */
    const dropCard = (card: HTMLElement) => {
        settle(card);
        if (card.style.display !== "none") card.style.display = "none";
    };

    const syncCard = (view: PinView) => {
        if (!isOpen(view)) {
            if (view.card) closeCard(view.card);
            expanded(view, false);
            view.drawn = undefined;
            closeForms(view);
            return;
        }
        showCard(view);
    };

    /**
     * Hover and focus changes show the card all the time, and replacing it under the pointer would eat a click: it is
     * redrawn only when what it shows has changed, or it was closed (and so may have missed changes) since.
     */
    const showCard = (view: PinView) => {
        if (view.drawn !== drawnFrom(view)) renderCard(view);
        const card = cardOf(view);
        // Opened now, or opened again on its way out: it comes in (from where it got to). Open already, it only moves.
        const coming = card.style.display !== "block" || isLeaving(card);
        card.style.display = "block";
        expanded(view, true);
        placeCard(view);
        if (coming) animateIn(card, POP);
    };

    const unpinOthers = (keep: PinView) => {
        for (const other of views.values()) {
            if (other !== keep && other.pinned) {
                other.pinned = false;
                syncCard(other);
            }
        }
    };

    const setHover = (view: PinView, hovered: boolean) => {
        if (view.hideTimer) clearTimeout(view.hideTimer);
        if (hovered) {
            view.hovered = true;
            syncCard(view);
            return;
        }
        // A short grace period lets the pointer travel from the pin onto its card.
        view.hideTimer = setTimeout(() => {
            view.hovered = false;
            syncCard(view);
        }, HIDE_DELAY_MS);
    };

    const setFocus = (view: PinView, focused: boolean) => {
        view.focused = focused;
        syncCard(view);
    };

    /** Out of sight for now (pins hidden, another page, scrolled away). A pinned card comes back with its pin. */
    const hide = (view: PinView) => {
        if (view.placed !== "") {
            view.pin.style.display = "none";
            view.placed = "";
        }
        view.at = undefined;
        if (view.card) dropCard(view.card);
        // No pointer can be over a pin that is not there; it never hears the pointer leave.
        if (view.hideTimer) clearTimeout(view.hideTimer);
        view.hovered = false;
        expanded(view, false);
    };

    /** Looks for a pin's element in the whole page. */
    const find = (view: PinView): Element | null => {
        const identity = view.record.annotation.target.identity[0];
        view.el = identity ? resolveIdentity(identity) : null;
        return view.el;
    };

    /**
     * The element a pin points at. Looking it up by its identity can mean searching the whole page, so what was found is
     * kept, and looked for again only as far as what changed in the page since (`look`) makes necessary.
     */
    const elementOf = (view: PinView, look: typeof changed): Element | null => {
        const record = view.record;
        // Made in this page: the element itself, while it is in the page.
        const live = record.elements?.find((e) => e.isConnected);
        if (live) return live;
        const known = view.el;
        // Never looked for, or its element has left the page.
        if (known === undefined || (known && !known.isConnected)) return find(view);
        if (!look) return known; // nothing changed since
        if (known) return stillMeans(known, record) ? known : find(view);
        // Not there before: it can only have come with what was added or changed.
        const identity = record.annotation.target.identity[0];
        if (!identity) return null;
        if (look.all || identity.within?.length) return find(view);
        for (const node of look.touched) {
            if (!node.isConnected || node.getRootNode() !== document) continue;
            try {
                const hit = node.matches(identity.selector)
                    ? node
                    : node.querySelector(identity.selector);
                if (hit) {
                    view.el = hit;
                    return hit;
                }
            } catch {
                return null; // a selector the browser cannot read finds nothing anywhere
            }
        }
        return null;
    };

    /**
     * Where a pin goes, in the viewport, or null when it is not to be shown. Only reads the page: nothing is written
     * until every pin has been measured, so the page is laid out once for all of them.
     */
    const measure = (
        view: PinView,
        screen: { sx: number; sy: number; w: number; h: number },
        look: typeof changed
    ): { left: number; top: number; detached: boolean } | null => {
        const a = view.record.annotation;
        const el = elementOf(view, look);
        let left: number;
        let top: number;
        if (el) {
            const r = viewportRect(el);
            if (r.width === 0 && r.height === 0) {
                const moved = fallbackAnchor?.(a);
                if (!moved) return null;
                left = moved.left;
                top = moved.top;
            } else {
                left = r.left;
                top = r.top;
            }
        } else {
            left = a.target.rect.x - screen.sx;
            top = a.target.rect.y - screen.sy;
        }
        const offscreen = top < -12 || left < -12 || top > screen.h + 12 || left > screen.w + 12;
        return offscreen ? null : { left, top, detached: !el };
    };

    type Places = {
        screen: { w: number; h: number };
        pins: Array<[PinView, ReturnType<typeof measure>]>;
        ghosts: Array<[Ghost, { left: number; top: number } | null]>;
    };

    /** Where a pending pin goes: on its element while that is in the page, else where it was. */
    const measureGhost = (
        ghost: Ghost,
        screen: { sx: number; sy: number; w: number; h: number }
    ): { left: number; top: number } | null => {
        const el = ghost.elements.find((e) => e.isConnected);
        const r = el ? viewportRect(el) : null;
        const { left, top } =
            r && (r.width > 0 || r.height > 0)
                ? r
                : { left: ghost.rect.x - screen.sx, top: ghost.rect.y - screen.sy };
        const offscreen = top < -12 || left < -12 || top > screen.h + 12 || left > screen.w + 12;
        return offscreen ? null : { left, top };
    };

    /** Read: where every pin goes, and how tall the open cards are. Nothing is written. */
    const measureAll = (): Places => {
        const route = currentRoute();
        const screen = {
            sx: window.scrollX,
            sy: window.scrollY,
            w: window.innerWidth,
            h: window.innerHeight,
        };
        const look = changed;
        changed = null;
        const pins: Places["pins"] = [];
        for (const view of views.values()) {
            const shown = visible && view.here && view.record.annotation.route === route;
            // A pin not measured now misses what changed: it looks in the whole page when it is shown again.
            if (!shown && look) view.el = undefined;
            pins.push([view, shown ? measure(view, screen, look) : null]);
            if (view.card?.style.display === "block") view.cardHeight = view.card.offsetHeight;
        }
        const pending: Places["ghosts"] = [];
        for (const ghost of ghosts)
            pending.push([
                ghost,
                visible && ghost.route === route ? measureGhost(ghost, screen) : null,
            ]);
        return { screen, pins, ghosts: pending };
    };

    /** Writes a pin's place, and its being shown, only when they changed. */
    const place = (
        target: { pin: HTMLButtonElement; placed?: string },
        at: { left: number; top: number },
        screen: { w: number; h: number },
        detached: boolean
    ) => {
        const left = Math.min(Math.max(at.left, 12), screen.w - 12);
        const top = Math.min(Math.max(at.top, 12), screen.h - 12);
        const placed = `${left},${top},${detached}`;
        if (target.placed !== placed) {
            if (!target.placed) target.pin.style.display = "block";
            target.placed = placed;
            moveTo(target.pin, left, top);
            target.pin.dataset.detached = String(detached);
        }
        return { left, top };
    };

    /** Write: the pins, then the open cards beside them. */
    const placeAll = ({ screen, pins, ghosts: pending }: Places) => {
        for (const [view, at] of pins) {
            const fresh = view.fresh;
            view.fresh = false;
            if (!at) {
                hide(view);
                continue;
            }
            view.at = place(view, at, screen, at.detached);
            if (fresh) growIn(view.pin);
        }
        for (const [view, at] of pins) if (at && isOpen(view)) showCard(view);
        for (const [ghost, at] of pending) {
            if (at) place(ghost, at, screen, false);
            else if (ghost.placed !== "") {
                ghost.pin.style.display = "none";
                ghost.placed = "";
            }
        }
    };

    let measured: Places | null = null;
    const job: FrameJob = {
        read: () => {
            measured = measureAll();
        },
        write: () => {
            const places = measured;
            measured = null;
            if (places) placeAll(places);
        },
    };

    /** Measures and places every pin now. */
    const position = () => {
        frames.cancel(job);
        measured = null;
        placeAll(measureAll());
    };

    const schedule = () => frames.schedule(job);

    const remove = (id: string, view: PinView) => {
        if (view.hideTimer) clearTimeout(view.hideTimer);
        view.pin.remove();
        if (view.card) settle(view.card);
        view.card?.remove();
        views.delete(id);
    };

    /** A pending pin taken off: faded out, or at once (`now`). */
    const dropGhost = (ghost: Ghost, now = false) => {
        ghosts.delete(ghost);
        if (now || ghost.placed === "" || !ghost.placed) ghost.pin.remove();
        else animateOut(ghost.pin, () => ghost.pin.remove(), FADE);
    };

    /** The pin of a note: a new one, which grows in, or the pending pin that stood for it while it was made. */
    const makeView = (record: AnnotationRecord, from?: Ghost): PinView => {
        const pin = from?.pin ?? h("button", { class: "pin", type: "button" });
        delete pin.dataset.pending;
        pin.setAttribute("aria-haspopup", "dialog");
        pin.setAttribute("aria-expanded", "false");
        pin.setAttribute("aria-controls", `notato-card-${record.annotation.id}`);
        const view: PinView = {
            pin,
            record,
            here: true,
            hovered: false,
            focused: false,
            pinned: false,
            fresh: !from,
            placed: from?.placed,
        };
        pin.addEventListener("mouseenter", () => setHover(view, true));
        pin.addEventListener("mouseleave", () => setHover(view, false));
        pin.addEventListener("focus", () => setFocus(view, true));
        pin.addEventListener("blur", (ev) => {
            if (leaving(view, ev)) setFocus(view, false);
        });
        pin.addEventListener("click", () => {
            view.pinned = !view.pinned;
            if (view.pinned) unpinOthers(view);
            // Closing it is meant: focus left on the pin, or in the card, does not hold it open.
            else view.focused = false;
            syncCard(view);
        });
        if (!from) layer.append(pin);
        return view;
    };

    return {
        refresh() {
            const current = records();
            const route = currentRoute();
            // With more than one person's notes on the page, each pin says whose it is. With one, it would only be noise.
            const people = new Set<string>();
            /** Where the notes on this page are in the list: a note's number falls back to its place among all of them. */
            const here: number[] = [];
            for (let i = 0; i < current.length; i++) {
                const a = (current[i] as AnnotationRecord).annotation;
                if (a.author.kind === "human" && a.author.name) people.add(a.author.name);
                if (a.route === route) here.push(i);
            }
            const drawn = new Map<string, { record: AnnotationRecord; number: number }>();
            for (const i of here.slice(-MAX_PINS)) {
                const record = current[i] as AnnotationRecord;
                drawn.set(record.annotation.id, {
                    record,
                    number: pinNumber(record.annotation, i + 1),
                });
            }
            let all: Map<string, AnnotationRecord> | undefined;
            for (const [id, view] of [...views]) {
                if (drawn.has(id)) continue;
                all ??= new Map(current.map((r) => [r.annotation.id, r]));
                const record = all.get(id);
                // Taken off the page, a pin keeps its view only while its card has something in it to lose.
                if (record && hasWorkInProgress(view)) {
                    view.record = record;
                    view.here = false;
                } else remove(id, view);
            }
            for (const [id, { record, number }] of drawn) {
                const a = record.annotation;
                let view = views.get(id);
                if (!view) {
                    const ghost = [...ghosts].find((g) => g.id === id);
                    if (ghost) ghosts.delete(ghost);
                    view = makeView(record, ghost);
                    views.set(id, view);
                }
                view.here = true;
                view.record = record;
                const refused = refusal?.(a.id);
                const by = a.author.kind === "human" && people.size > 1 ? a.author.name : undefined;
                const says = [
                    number,
                    a.status,
                    refused ?? "",
                    by ?? "",
                    a.comment.slice(0, 80),
                ].join("\u0000");
                if (view.says !== says) {
                    view.says = says;
                    view.pin.textContent = String(number);
                    view.pin.dataset.status = a.status;
                    if (refused) view.pin.dataset.refused = "true";
                    else delete view.pin.dataset.refused;
                    if (by) {
                        view.pin.dataset.by = initialsOf(by);
                        view.pin.style.setProperty("--by", colorForName(by));
                    } else {
                        delete view.pin.dataset.by;
                        view.pin.style.removeProperty("--by");
                    }
                    const label = `Annotation ${number}: ${a.comment.slice(0, 80)}`;
                    view.pin.setAttribute("aria-label", label);
                    view.card?.setAttribute("aria-label", label);
                }
                if (isOpen(view) && view.drawn !== drawnFrom(view)) renderCard(view);
            }
            // A note made, but not drawn here (another page by now, or not among the shown): its pending pin goes.
            for (const ghost of [...ghosts]) if (ghost.id) dropGhost(ghost);
            position();
        },
        schedule,
        domChanged(touched) {
            const next = changed ?? { all: false, touched: [] };
            if (!touched || next.touched.length + touched.length > MAX_TOUCHED) {
                next.all = true;
                next.touched = [];
            } else if (!next.all) next.touched.push(...touched);
            changed = next;
            schedule();
        },
        setVisible(next) {
            visible = next;
            position();
        },
        pending(init) {
            const ghost: Ghost = {
                ...init,
                pin: h(
                    "button",
                    {
                        class: "pin",
                        type: "button",
                        "data-pending": "true",
                        "aria-label": `Annotation ${init.number}: saving`,
                    },
                    String(init.number)
                ),
            };
            ghosts.add(ghost);
            layer.append(ghost.pin);
            position();
            growIn(ghost.pin);
            return {
                done(id) {
                    if (ghosts.has(ghost)) ghost.id = id;
                },
                cancel() {
                    if (ghosts.has(ghost)) dropGhost(ghost);
                },
            };
        },
        destroy() {
            frames.cancel(job);
            measured = null;
            for (const [id, view] of [...views]) remove(id, view);
            for (const ghost of [...ghosts]) dropGhost(ghost, true);
        },
    };
}
