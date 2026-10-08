import { type AnnotationRecord, agentLogoSvg, knownAgent } from "@notato/core";
import type { Annotation, Author } from "@notato/schema";
import { resolveIdentity } from "../resolve.ts";
import { colorForName, initialsOf } from "../settings.ts";
import { h, ICONS, icon } from "./dom.ts";
import { viewportRect } from "./frames.ts";
import { PEOPLE_ONLY_HINT } from "./popover.ts";

/** Said wherever a reply can be sent as an aside, in every SDK. */
export const ASIDE_HINT = "Just for people: the agent won't see this reply.";

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
    destroy(): void;
}

/**
 * The most pins drawn on one page: the newest. A page with more notes than that would be covered in them, and each pin
 * costs a measurement every time the page scrolls. The toolbar's count, the copied Markdown and the board have every
 * note. The native SDKs draw the same number.
 */
export const MAX_PINS = 150;

interface PinsOptions {
    layer: HTMLElement;
    records(): AnnotationRecord[];
    currentRoute(): string;
    /** Called when the person confirms deleting an annotation from its card. */
    onDelete?(id: string): void;
    /**
     * Asks the agent to undo the change it made for a resolved annotation. Only passed when there is a server
     * for the request to reach; without it a card offers no Revert. Rejects with a message to show.
     */
    onRequestRevert?(id: string, note: string): Promise<void>;
    /** Takes a revert request back before the agent has acted on it. */
    onCancelRevert?(id: string): Promise<void>;
    /**
     * Where to put the pin when the element it points at is not on screen. A request for variants points at one version,
     * and while another is shown that element is hidden; the pin then goes where the shown version is.
     */
    fallbackAnchor?(annotation: Annotation): { left: number; top: number } | null;
    /** Takes back the version the person picked, before the agent has acted on it. Only passed with a server. */
    onTakeBackVariant?(id: string): Promise<void>;
    /**
     * Writes in the annotation's thread as the person, for example to ask for different versions; an aside is for the
     * people on the thread, kept from the agent. Only passed with a server.
     */
    onReply?(id: string, note: string, aside?: boolean): Promise<void>;
    /** Turns People only on or off for an annotation. Left out where the change cannot be made now. */
    onPeopleOnly?(id: string, on: boolean): Promise<void>;
    /** The connected agent's name ("Codex") when there is exactly one, so the card can say who it is asking. */
    agentName?(): string | undefined;
    /** Why the server refused an annotation for good, when it did: said on its card and its pin. */
    refusal?(id: string): string | undefined;
}

/** The number on the pin. The screenshot plugin stores it so pin and screenshot always agree. */
export function pinNumber(annotation: Annotation, fallback: number): number {
    const shot = annotation.context.screenshot as { pin?: unknown } | undefined;
    return typeof shot?.pin === "number" ? shot.pin : fallback;
}

/**
 * The round badge by a reply: a person's initial in their colour, or an agent's own logo when Notato knows it
 * (Claude, Codex, Cursor…), else its initial in the accent colour.
 */
function replyAvatar(author: Author, name: string): HTMLSpanElement {
    const known = author.kind === "agent" ? knownAgent(author.name) : undefined;
    if (known) {
        const ink = known.background === "ink";
        const av = h("span", {
            class: ink ? "av brand ink" : "av brand",
            style: ink ? {} : { background: known.background, color: known.color },
            "aria-hidden": "true",
        });
        // Static markup from Notato's own list of logos: nothing in it comes from the note.
        av.innerHTML = agentLogoSvg(known, 13);
        return av;
    }
    return h(
        "span",
        {
            class: author.kind === "agent" ? "av agent" : "av",
            style:
                author.kind === "human" && author.name
                    ? { background: colorForName(author.name) }
                    : {},
            "aria-hidden": "true",
        },
        name.trim()[0]?.toUpperCase() ?? "?"
    );
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

interface PinView {
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
    /** Shown because the pointer is over the pin or the card. */
    hovered: boolean;
    /** Focus is on the pin or in its card: kept up while someone tabs through it. */
    focused: boolean;
    /** The card is being redrawn: focus lost with the old contents is not focus leaving the card. */
    redrawing?: boolean;
    /** Shown until clicked away: reachable with the keyboard and by touch. */
    pinned: boolean;
    hideTimer?: ReturnType<typeof setTimeout>;
    /** The Revert form is open on the card, with what has been typed in it so far. */
    reverting?: { note: string; busy: boolean; error?: string };
    /** The "ask for different versions" form, likewise. */
    asking?: { note: string; busy: boolean; error?: string };
    /** The reply line, with what has been typed in it so far, and whether it goes as an aside. */
    replying?: { note: string; busy: boolean; error?: string; aside?: boolean };
    /** People only is being changed, or could not be. */
    sharing?: { busy: boolean; error?: string };
    /** What the card on screen was drawn from. A card is only redrawn when this changes, so a click is never lost to a redraw. */
    drawn?: string;
}

/** What a card shows of an annotation: when none of it changes there is nothing to redraw. */
const signature = (a: Annotation, refused = "") =>
    [
        refused,
        a.status,
        a.comment,
        a.severity ?? "",
        a.variants?.offeredAt ?? "",
        a.variants?.chosen ?? "",
        a.peopleOnly ? "people" : "",
        ...a.thread.map((r) => r.id),
    ].join("\u0000");

const CARD_WIDTH = 320;
/** Past this many elements added or changed before the next placing, pins whose element was missing look everywhere. */
const MAX_TOUCHED = 500;

/** How a status reads on a card. */
const STATUS_LABEL: Record<Annotation["status"], string> = {
    open: "Open",
    acknowledged: "Acknowledged",
    variant_chosen: "Variant chosen",
    resolved: "Resolved",
    revert_requested: "Revert requested",
    reverted: "Reverted",
    dismissed: "Dismissed",
};
const cap = (s: string) => `${s[0]?.toUpperCase() ?? ""}${s.slice(1)}`;
const HIDE_DELAY_MS = 160;

export function createPins({
    layer,
    records,
    currentRoute,
    onDelete,
    onRequestRevert,
    onCancelRevert,
    onTakeBackVariant,
    onReply,
    onPeopleOnly,
    fallbackAnchor,
    agentName,
    refusal,
}: PinsOptions): Pins {
    const views = new Map<string, PinView>();
    /** Who does the work: the agent by name when one is connected, otherwise "the agent". */
    const who = () => agentName?.() ?? "the agent";
    const Who = () => agentName?.() ?? "The agent";
    let visible = true;
    let frame = 0;
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
        signature(view.record.annotation, refusal?.(view.record.annotation.id));

    /** A form left open for a state the annotation has moved on from would hide the reply line for nothing. */
    const pruneForms = (view: PinView, a: Annotation) => {
        if (view.reverting && !view.reverting.busy && !(a.status === "resolved" && onRequestRevert))
            view.reverting = undefined;
        const versions =
            a.variants && (a.status === "acknowledged" || a.status === "variant_chosen");
        if (view.asking && !view.asking.busy && !(versions && onReply)) view.asking = undefined;
    };

    /** The card's fields, by what they are for: what is typed in them, and which has focus, outlive a redraw. */
    const FIELD_STATE = {
        reply: (view: PinView) => view.replying,
        revert: (view: PinView) => view.reverting,
        ask: (view: PinView) => view.asking,
    } as const;

    const renderCard = (view: PinView) => {
        const a = view.record.annotation;
        const card = cardOf(view);
        pruneForms(view, a);
        // A server update can redraw the card while someone types in it: keep their text, their caret and their focus.
        const fields = [
            ...card.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-field]"),
        ];
        for (const field of fields) {
            const state = FIELD_STATE[field.dataset.field as keyof typeof FIELD_STATE]?.(view);
            if (state && !state.busy) state.note = field.value;
        }
        const root = card.getRootNode() as Document | ShadowRoot;
        const focused = fields.find((f) => f === root.activeElement);
        const hadFocus = root.activeElement !== null && card.contains(root.activeElement);
        const caret = focused
            ? {
                  field: focused.dataset.field,
                  start: focused.selectionStart,
                  end: focused.selectionEnd,
                  direction: focused.selectionDirection ?? undefined,
              }
            : undefined;
        view.drawn = drawnFrom(view);
        const refused = refusal?.(a.id);
        const author = a.author.name ?? (a.author.kind === "agent" ? "Agent" : "Someone");
        let armed = false;
        const del = h("button", { class: "link delete", type: "button" }, "Delete");
        del.addEventListener("click", () => {
            if (!armed) {
                armed = true;
                del.textContent = "Click again to delete";
                del.classList.add("armed");
                setTimeout(() => {
                    armed = false;
                    del.textContent = "Delete";
                    del.classList.remove("armed");
                }, 3000);
                return;
            }
            onDelete?.(a.id);
        });
        const close = h(
            "button",
            { class: "card-x", type: "button", "aria-label": "Close", title: "Close" },
            icon(ICONS.close)
        );
        close.addEventListener("click", () => {
            view.pinned = false;
            view.hovered = false;
            view.focused = false;
            close.blur();
            syncCard(view);
        });
        const revert = revertControls(view, a);
        const lead = revert.lead;
        view.redrawing = true;
        card.replaceChildren(
            h(
                "div",
                { class: "card-head" },
                h("span", { class: "badge status", "data-v": a.status }, STATUS_LABEL[a.status]),
                a.intent
                    ? h("span", { class: "badge", "data-v": `intent-${a.intent}` }, cap(a.intent))
                    : null,
                a.severity
                    ? h("span", { class: "badge sev", "data-v": a.severity }, cap(a.severity))
                    : null,
                a.peopleOnly
                    ? h("span", { class: "badge people", title: PEOPLE_ONLY_HINT }, "People only")
                    : null,
                close
            ),
            h(
                "div",
                { class: "meta" },
                a.author.kind === "human" && a.author.name
                    ? h("span", {
                          class: "who",
                          style: { background: colorForName(a.author.name) },
                      })
                    : null,
                h("b", {}, author),
                ` · ${a.route} · #${view.pin.textContent}`
            ),
            h("div", { class: "body" }, a.comment),
            ...(refused ? [h("div", { class: "err refused" }, `Not sent: ${refused}`)] : []),
            ...a.thread.map((r) => {
                const name = r.author.name ?? (r.author.kind === "agent" ? "Agent" : "Someone");
                return h(
                    "div",
                    { class: "reply" },
                    replyAvatar(r.author, name),
                    h(
                        "div",
                        { class: r.aside ? "bubble aside" : "bubble" },
                        h(
                            "b",
                            {},
                            name,
                            r.aside
                                ? h("span", { class: "aside-tag", title: ASIDE_HINT }, "Aside")
                                : null
                        ),
                        r.body
                    )
                );
            }),
            ...replyControls(view, a),
            ...variantControls(view, a),
            ...(revert.box ? [revert.box] : []),
            ...(view.sharing?.error ? [h("div", { class: "say-err" }, view.sharing.error)] : []),
            ...(lead.length || onDelete || onPeopleOnly
                ? [
                      h(
                          "div",
                          { class: "card-foot" },
                          ...lead,
                          peopleOnlyControl(view, a),
                          onDelete ? del : null
                      ),
                  ]
                : [])
        );
        view.redrawing = false;
        const again =
            caret &&
            card.querySelector<HTMLInputElement | HTMLTextAreaElement>(
                `[data-field="${caret.field}"]`
            );
        if (again && !again.disabled) {
            again.focus({ preventScroll: true });
            try {
                again.setSelectionRange(caret.start, caret.end, caret.direction);
            } catch {
                // a field that has no caret to put back
            }
        } else if (hadFocus) {
            // What had focus is gone with the old contents: the card keeps it, so the keyboard is not sent to the page.
            card.focus({ preventScroll: true });
        }
    };

    /** After something finished in the background: an open card shows it now, a closed one when it next opens. */
    const redraw = (view: PinView) => {
        if (!views.has(view.record.annotation.id)) return;
        if (isOpen(view)) renderCard(view);
        else view.drawn = undefined;
    };

    /** People only, on or off, for a note already made: anyone on the thread can change it, and it is recorded there. */
    const peopleOnlyControl = (view: PinView, a: Annotation): HTMLElement | null => {
        if (!onPeopleOnly) return null;
        const on = Boolean(a.peopleOnly);
        const busy = Boolean(view.sharing?.busy);
        const toggle = h(
            "button",
            {
                class: "chip people",
                type: "button",
                "aria-pressed": String(on),
                title: on ? "Share this with the agent again" : PEOPLE_ONLY_HINT,
            },
            "People only"
        ) as HTMLButtonElement;
        toggle.disabled = busy;
        toggle.addEventListener("click", () => {
            view.sharing = { busy: true };
            redraw(view);
            onPeopleOnly(a.id, !on).then(
                () => {
                    view.sharing = undefined;
                    redraw(view);
                },
                (error: unknown) => {
                    view.sharing = {
                        busy: false,
                        error: error instanceof Error ? error.message : String(error),
                    };
                    redraw(view);
                }
            );
        });
        return toggle;
    };

    /** A line to write in the thread, where there is a server for it to go to. */
    const replyControls = (view: PinView, a: Annotation): HTMLElement[] => {
        // While a form of its own is open, the card asks one thing at a time.
        if (!onReply || view.asking || view.reverting) return [];
        if (!view.replying) view.replying = { note: "", busy: false };
        const state = view.replying;
        const say = h("input", {
            class: "say",
            type: "text",
            placeholder: "Reply…  Enter to send",
            "aria-label": "Reply",
            "data-field": "reply",
        }) as HTMLInputElement;
        say.value = state.note;
        say.disabled = state.busy;
        say.addEventListener("input", () => {
            state.note = say.value;
        });
        say.addEventListener("focus", () => {
            view.pinned = true; // keep the card up while someone types in it
        });
        say.addEventListener("keydown", (ev) => {
            if (ev.key !== "Enter" || ev.isComposing || !state.note.trim() || state.busy) return;
            ev.preventDefault();
            state.busy = true;
            state.error = undefined;
            say.disabled = true;
            onReply(a.id, state.note.trim(), Boolean(state.aside)).then(
                () => {
                    // The next reply is for the agent again unless they say otherwise.
                    view.replying = undefined;
                    redraw(view);
                },
                (error: unknown) => {
                    state.busy = false;
                    state.error = error instanceof Error ? error.message : String(error);
                    redraw(view);
                }
            );
        });
        // On a People only note too: an aside stays from the agent even if the note is later shared with it.
        const aside = h(
            "button",
            {
                class: "chip aside",
                type: "button",
                "aria-pressed": String(Boolean(state.aside)),
                title: ASIDE_HINT,
            },
            "Aside"
        ) as HTMLButtonElement;
        aside.addEventListener("click", () => {
            state.aside = !state.aside;
            aside.setAttribute("aria-pressed", String(state.aside));
            view.pinned = true;
        });
        return [
            h("div", { class: "say-row" }, say, aside),
            ...(state.error ? [h("div", { class: "say-err" }, state.error)] : []),
        ];
    };

    /** What a card says and offers about versions to choose between. */
    const variantControls = (view: PinView, a: Annotation): HTMLElement[] => {
        const v = a.variants;
        if (!v || (a.status !== "acknowledged" && a.status !== "variant_chosen")) return [];
        const picked = a.status === "variant_chosen" ? v.chosen : undefined;
        const names = v.options.map((o) => o.name);
        const say = h(
            "div",
            { class: "hint variants-hint" },
            picked
                ? `You picked “${picked}”. Waiting for ${who()} to apply it.`
                : `Versions ready: ${names.join(", ")}. Switch between them in the page, then press “Use this”.`
        );
        const takeBack =
            picked && onTakeBackVariant
                ? h("button", { class: "link plain", type: "button" }, "Take back")
                : null;
        takeBack?.addEventListener("click", () => {
            takeBack.setAttribute("disabled", "");
            void onTakeBackVariant?.(a.id).catch(() => takeBack.removeAttribute("disabled"));
        });
        if (!onReply)
            return [
                h(
                    "div",
                    { class: "revert versions" },
                    say,
                    takeBack ? h("div", { class: "foot start" }, takeBack) : null
                ),
            ];

        const state = view.asking;
        if (!state) {
            const open = h(
                "button",
                { class: "link plain", type: "button" },
                "Ask for different versions…"
            );
            open.addEventListener("click", () => {
                view.asking = { note: "", busy: false };
                view.pinned = true;
                renderCard(view);
                view.card?.querySelector("textarea")?.focus();
            });
            return [
                h(
                    "div",
                    { class: "revert versions" },
                    say,
                    h("div", { class: "foot start" }, open, takeBack)
                ),
            ];
        }
        const note = h("textarea", {
            rows: "2",
            placeholder:
                "What should be different? e.g. bolder, or one more with the image on the right",
            "aria-label": "What to change about the versions",
            "data-field": "ask",
        }) as HTMLTextAreaElement;
        note.value = state.note;
        note.disabled = state.busy;
        note.addEventListener("input", () => {
            state.note = note.value;
        });
        const send = h(
            "button",
            { class: "btn primary small", type: "button" },
            `Send to ${who()}`
        );
        send.disabled = state.busy;
        const cancel = h("button", { class: "btn small", type: "button" }, "Cancel");
        cancel.disabled = state.busy;
        cancel.addEventListener("click", () => {
            view.asking = undefined;
            renderCard(view);
        });
        send.addEventListener("click", () => {
            if (!state.note.trim()) {
                state.error = "Write what should be different first.";
                renderCard(view);
                return;
            }
            state.busy = true;
            state.error = undefined;
            renderCard(view);
            onReply(a.id, state.note.trim()).then(
                () => {
                    view.asking = undefined;
                    redraw(view);
                },
                (error: unknown) => {
                    state.busy = false;
                    state.error = error instanceof Error ? error.message : String(error);
                    redraw(view);
                }
            );
        });
        return [
            h(
                "div",
                { class: "revert versions" },
                say,
                note,
                state.error ? h("div", { class: "err" }, state.error) : null,
                h("div", { class: "foot" }, cancel, send)
            ),
        ];
    };

    /**
     * What a card offers about undoing a change, by where the annotation is in its life: a form in a box of its own,
     * and what goes at the start of the card's last line.
     */
    const revertControls = (
        view: PinView,
        a: Annotation
    ): { box: HTMLElement | null; lead: HTMLElement[] } => {
        if (a.status === "resolved" && onRequestRevert) {
            const state = view.reverting;
            if (!state) {
                const open = h(
                    "button",
                    { class: "link violet", type: "button" },
                    "Revert this change…"
                );
                open.addEventListener("click", () => {
                    view.reverting = { note: "", busy: false };
                    view.pinned = true; // keep the card up while someone types in it
                    renderCard(view);
                    view.card?.querySelector("textarea")?.focus();
                });
                return { box: null, lead: [open] };
            }
            const note = h("textarea", {
                rows: "2",
                placeholder: "What is wrong with it? (optional)",
                "aria-label": "Why this change should be reverted",
                "data-field": "revert",
            }) as HTMLTextAreaElement;
            note.value = state.note;
            note.disabled = state.busy;
            note.addEventListener("input", () => {
                state.note = note.value;
            });
            const send = h(
                "button",
                { class: "btn primary small", type: "button" },
                `Ask ${who()} to revert`
            );
            send.disabled = state.busy;
            const cancel = h("button", { class: "btn small", type: "button" }, "Cancel");
            cancel.disabled = state.busy;
            cancel.addEventListener("click", () => {
                view.reverting = undefined;
                renderCard(view);
            });
            send.addEventListener("click", () => {
                // Drawn for a resolved note; if it has moved on since, say what it is now instead of acting on that.
                if (view.record.annotation.status !== "resolved") return renderCard(view);
                state.busy = true;
                state.error = undefined;
                renderCard(view);
                onRequestRevert(a.id, state.note.trim()).then(
                    () => {
                        view.reverting = undefined;
                        redraw(view);
                    },
                    (error: unknown) => {
                        state.busy = false;
                        state.error = error instanceof Error ? error.message : String(error);
                        redraw(view);
                    }
                );
            });
            return {
                box: h(
                    "div",
                    { class: "revert" },
                    h(
                        "div",
                        { class: "hint" },
                        `${Who()} will be asked to undo what it changed for this.`
                    ),
                    note,
                    state.error ? h("div", { class: "err" }, state.error) : null,
                    h("div", { class: "foot" }, cancel, send)
                ),
                lead: [],
            };
        }
        if (a.status === "revert_requested") {
            const cancel = onCancelRevert
                ? h("button", { class: "link", type: "button" }, "Cancel request")
                : null;
            cancel?.addEventListener("click", () => {
                // Only a request still waiting can be taken back: once the agent has acted, this would undo its answer.
                if (view.record.annotation.status !== "revert_requested") return renderCard(view);
                cancel.setAttribute("disabled", "");
                void onCancelRevert?.(a.id).catch(() => cancel.removeAttribute("disabled"));
            });
            return {
                box: null,
                lead: [
                    h("span", { class: "hint" }, `Waiting for ${who()} to undo it.`),
                    ...(cancel ? [cancel] : []),
                ],
            };
        }
        return { box: null, lead: [] };
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
        card.style.left = `${left}px`;
        card.style.top = `${Math.min(Math.max(8, pin.top - 8), Math.max(8, window.innerHeight - card.offsetHeight - 8))}px`;
    };

    const expanded = (view: PinView, open: boolean) => {
        const value = String(open);
        if (view.pin.getAttribute("aria-expanded") !== value)
            view.pin.setAttribute("aria-expanded", value);
    };

    const syncCard = (view: PinView) => {
        if (!isOpen(view)) {
            if (view.card && view.card.style.display !== "none") view.card.style.display = "none";
            expanded(view, false);
            view.drawn = undefined;
            if (!view.reverting?.busy) view.reverting = undefined; // a form nobody is looking at is not kept
            if (!view.asking?.busy) view.asking = undefined;
            if (!view.replying?.busy && !view.replying?.note) view.replying = undefined;
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
        card.style.display = "block";
        expanded(view, true);
        placeCard(view);
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
        if (view.card && view.card.style.display !== "none") view.card.style.display = "none";
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

    const position = () => {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        const route = currentRoute();
        // Read: where every pin goes.
        const screen = {
            sx: window.scrollX,
            sy: window.scrollY,
            w: window.innerWidth,
            h: window.innerHeight,
        };
        const look = changed;
        changed = null;
        const places: Array<[PinView, ReturnType<typeof measure>]> = [];
        for (const view of views.values()) {
            const shown = visible && view.here && view.record.annotation.route === route;
            // A pin not measured now misses what changed: it looks in the whole page when it is shown again.
            if (!shown && look) view.el = undefined;
            places.push([view, shown ? measure(view, screen, look) : null]);
        }
        // Write: the pins, then the open cards beside them.
        for (const [view, at] of places) {
            if (!at) {
                hide(view);
                continue;
            }
            const left = Math.min(Math.max(at.left, 12), screen.w - 12);
            const top = Math.min(Math.max(at.top, 12), screen.h - 12);
            view.at = { left, top };
            const placed = `${left},${top},${at.detached}`;
            if (view.placed === placed) continue;
            view.placed = placed;
            view.pin.style.display = "block";
            view.pin.style.left = `${left}px`;
            view.pin.style.top = `${top}px`;
            view.pin.dataset.detached = String(at.detached);
        }
        for (const [view, at] of places) if (at && isOpen(view)) showCard(view);
    };

    const schedule = () => {
        if (!frame) frame = requestAnimationFrame(position);
    };

    const remove = (id: string, view: PinView) => {
        if (view.hideTimer) clearTimeout(view.hideTimer);
        view.pin.remove();
        view.card?.remove();
        views.delete(id);
    };

    /** A pin taken off the page keeps its view only while there is something in it to lose: a pinned card, a reply typed. */
    const worthKeeping = (view: PinView) =>
        view.pinned ||
        Boolean(view.replying?.busy || view.replying?.note) ||
        Boolean(view.reverting?.busy || view.asking?.busy || view.sharing?.busy);

    const makeView = (record: AnnotationRecord): PinView => {
        const pin = h("button", {
            class: "pin",
            type: "button",
            "aria-haspopup": "dialog",
            "aria-expanded": "false",
            "aria-controls": `notato-card-${record.annotation.id}`,
        });
        const view: PinView = {
            pin,
            record,
            here: true,
            hovered: false,
            focused: false,
            pinned: false,
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
        layer.append(pin);
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
                if (record && worthKeeping(view)) {
                    view.record = record;
                    view.here = false;
                } else remove(id, view);
            }
            for (const [id, { record, number }] of drawn) {
                const a = record.annotation;
                let view = views.get(id);
                if (!view) {
                    view = makeView(record);
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
        destroy() {
            if (frame) cancelAnimationFrame(frame);
            frame = 0;
            for (const [id, view] of [...views]) remove(id, view);
        },
    };
}
