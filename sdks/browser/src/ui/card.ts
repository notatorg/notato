import { agentLogoSvg, knownAgent } from "@notato/core";
import type { Annotation, Author } from "@notato/schema";
import { colorForName } from "../settings.ts";
import { capitalize, messageOf } from "../text.ts";
import { h, ICONS, icon } from "./dom.ts";
import { PEOPLE_ONLY_HINT } from "./popover.ts";

/** Said wherever a reply can be sent as an aside, in every SDK. */
export const ASIDE_HINT = "Just for people: the agent won't see this reply.";

/** A form on a card: what has been typed in it, whether it is being sent, and why it could not be. */
interface FormState {
    note: string;
    busy: boolean;
    error?: string;
}

/** What a pin's card keeps between draws: whether it is held open, and the forms open on it. */
export interface CardState {
    /** Shown until clicked away: reachable with the keyboard and by touch. */
    pinned: boolean;
    /** The Revert form is open on the card, with what has been typed in it so far. */
    reverting?: FormState;
    /** The "ask for different versions" form, likewise. */
    asking?: FormState;
    /** The reply line, with what has been typed in it so far, and whether it goes as an aside. */
    replying?: FormState & { aside?: boolean };
    /** People only is being changed, or could not be. */
    sharing?: { busy: boolean; error?: string };
}

/** What a card can ask for on a note. Each is left out where it cannot be done now. */
export interface CardActions {
    /** Called when the person confirms deleting an annotation from its card. */
    onDelete?(id: string): void;
    /**
     * Asks the agent to undo the change it made for a resolved annotation. Only passed when there is a server
     * for the request to reach; without it a card offers no Revert. Rejects with a message to show.
     */
    onRequestRevert?(id: string, note: string): Promise<void>;
    /** Takes a revert request back before the agent has acted on it. */
    onCancelRevert?(id: string): Promise<void>;
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

/** One card being drawn: where, from what, and how to draw it again. */
export interface CardDraw {
    card: HTMLElement;
    state: CardState;
    /** The annotation as the card is drawn from it. */
    annotation: Annotation;
    /** The annotation as it is now, which may have moved on since the card was drawn. */
    current(): Annotation;
    /** The number on its pin. */
    number: string;
    /** Draws the card again now. */
    draw(): void;
    /** After something finished in the background: an open card shows it now, a closed one when it next opens. */
    redraw(): void;
    /** The card's close button was pressed. */
    close(): void;
}

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

/** How long Delete waits for the second click that confirms it. */
const DELETE_ARMED_MS = 3000;

/** What a card shows of an annotation: when none of it changes there is nothing to redraw. */
export const cardSignature = (a: Annotation, refused = "") =>
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

/** Whether there are versions to choose between on the annotation now. */
const offersVersions = (a: Annotation) =>
    Boolean(a.variants) && (a.status === "acknowledged" || a.status === "variant_chosen");

/** A form left open for a state the annotation has moved on from would hide the reply line for nothing. */
export function pruneForms(state: CardState, a: Annotation, actions: CardActions): void {
    if (
        state.reverting &&
        !state.reverting.busy &&
        !(a.status === "resolved" && actions.onRequestRevert)
    )
        state.reverting = undefined;
    if (state.asking && !state.asking.busy && !(offersVersions(a) && actions.onReply))
        state.asking = undefined;
}

/** A card nobody is looking at keeps only a form being sent, and a reply with something typed in it. */
export function closeForms(state: CardState): void {
    if (!state.reverting?.busy) state.reverting = undefined;
    if (!state.asking?.busy) state.asking = undefined;
    if (!state.replying?.busy && !state.replying?.note) state.replying = undefined;
}

/** Whether a card has something in it to lose: held open, a reply typed, or a request under way. */
export const hasWorkInProgress = (state: CardState): boolean =>
    state.pinned ||
    Boolean(state.replying?.busy || state.replying?.note) ||
    Boolean(state.reverting?.busy || state.asking?.busy || state.sharing?.busy);

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

/** Who wrote something, for a card: their name, or what they are. */
const nameOf = (author: Author) => author.name ?? (author.kind === "agent" ? "Agent" : "Someone");

/** The card's fields, by what they are for: what is typed in them, and which has focus, outlive a redraw. */
const FIELD_STATE = {
    reply: (state: CardState) => state.replying,
    revert: (state: CardState) => state.reverting,
    ask: (state: CardState) => state.asking,
} as const;

/**
 * Draws a card's contents from where its annotation is now. A server update can redraw the card while someone types in
 * it: their text, their caret and their focus are kept.
 */
export function drawCard(draw: CardDraw, actions: CardActions): void {
    const { card, state } = draw;
    const fields = [
        ...card.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-field]"),
    ];
    for (const field of fields) {
        const form = FIELD_STATE[field.dataset.field as keyof typeof FIELD_STATE]?.(state);
        if (form && !form.busy) form.note = field.value;
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

    card.replaceChildren(...cardContents(draw, actions));

    const again =
        caret &&
        card.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-field="${caret.field}"]`);
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
}

function cardContents(draw: CardDraw, actions: CardActions): HTMLElement[] {
    const { state, annotation: a } = draw;
    const refused = actions.refusal?.(a.id);
    const close = h(
        "button",
        { class: "card-x", type: "button", "aria-label": "Close", title: "Close" },
        icon(ICONS.close)
    );
    close.addEventListener("click", () => {
        close.blur();
        draw.close();
    });
    const revert = revertControls(draw, actions);
    const peopleOnly = peopleOnlyControl(draw, actions);
    const del = actions.onDelete ? deleteButton(() => actions.onDelete?.(a.id)) : null;
    return [
        h(
            "div",
            { class: "card-head" },
            h("span", { class: "badge status", "data-v": a.status }, STATUS_LABEL[a.status]),
            a.intent
                ? h(
                      "span",
                      { class: "badge", "data-v": `intent-${a.intent}` },
                      capitalize(a.intent)
                  )
                : null,
            a.severity
                ? h("span", { class: "badge sev", "data-v": a.severity }, capitalize(a.severity))
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
                ? h("span", { class: "who", style: { background: colorForName(a.author.name) } })
                : null,
            h("b", {}, nameOf(a.author)),
            ` · ${a.route} · #${draw.number}`
        ),
        h("div", { class: "body" }, a.comment),
        ...(refused ? [h("div", { class: "err refused" }, `Not sent: ${refused}`)] : []),
        ...a.thread.map((r) => {
            const name = nameOf(r.author);
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
        ...replyControls(draw, actions),
        ...variantControls(draw, actions),
        ...(revert.box ? [revert.box] : []),
        ...(state.sharing?.error ? [h("div", { class: "say-err" }, state.sharing.error)] : []),
        ...(revert.lead.length || peopleOnly || del
            ? [h("div", { class: "card-foot" }, ...revert.lead, peopleOnly, del)]
            : []),
    ];
}

/** Delete, which asks for a second click to be sure. */
function deleteButton(onDelete: () => void): HTMLButtonElement {
    let armed = false;
    const del = h("button", { class: "link delete", type: "button" }, "Delete");
    del.addEventListener("click", () => {
        if (armed) return onDelete();
        armed = true;
        del.textContent = "Click again to delete";
        del.classList.add("armed");
        setTimeout(() => {
            armed = false;
            del.textContent = "Delete";
            del.classList.remove("armed");
        }, DELETE_ARMED_MS);
    });
    return del;
}

/**
 * Sends what a form asks for: busy while it goes, closed once it has gone, and with the reason on it if it could not.
 * The card is drawn again as each of those happens.
 */
function send(
    draw: CardDraw,
    form: FormState,
    request: () => Promise<void>,
    sent: () => void
): void {
    form.busy = true;
    form.error = undefined;
    draw.draw();
    request().then(
        () => {
            sent();
            draw.redraw();
        },
        (error: unknown) => {
            form.busy = false;
            form.error = messageOf(error);
            draw.redraw();
        }
    );
}

/** A note to write and send, in a box of its own on the card: the Revert form, and the one asking for new versions. */
function noteForm(options: {
    className: string;
    hint: HTMLElement;
    form: FormState;
    field: keyof typeof FIELD_STATE;
    placeholder: string;
    label: string;
    sendLabel: string;
    onCancel(): void;
    onSend(): void;
}): HTMLElement {
    const { form } = options;
    const note = h("textarea", {
        rows: "2",
        placeholder: options.placeholder,
        "aria-label": options.label,
        "data-field": options.field,
    });
    note.value = form.note;
    note.disabled = form.busy;
    note.addEventListener("input", () => {
        form.note = note.value;
    });
    const sendButton = h(
        "button",
        { class: "btn primary small", type: "button" },
        options.sendLabel
    );
    sendButton.disabled = form.busy;
    sendButton.addEventListener("click", options.onSend);
    const cancel = h("button", { class: "btn small", type: "button" }, "Cancel");
    cancel.disabled = form.busy;
    cancel.addEventListener("click", options.onCancel);
    return h(
        "div",
        { class: options.className },
        options.hint,
        note,
        form.error ? h("div", { class: "err" }, form.error) : null,
        h("div", { class: "foot" }, cancel, sendButton)
    );
}

/** A button that opens one of the card's forms, holds the card open, and puts the cursor in it. */
function opensForm(draw: CardDraw, label: string, className: string, open: () => void) {
    const button = h("button", { class: className, type: "button" }, label);
    button.addEventListener("click", () => {
        open();
        draw.state.pinned = true; // keep the card up while someone types in it
        draw.draw();
        draw.card.querySelector("textarea")?.focus();
    });
    return button;
}

/** People only, on or off, for a note already made: anyone on the thread can change it, and it is recorded there. */
function peopleOnlyControl(draw: CardDraw, actions: CardActions): HTMLElement | null {
    const { onPeopleOnly } = actions;
    if (!onPeopleOnly) return null;
    const { state, annotation: a } = draw;
    const on = Boolean(a.peopleOnly);
    const toggle = h(
        "button",
        {
            class: "chip people",
            type: "button",
            "aria-pressed": String(on),
            title: on ? "Share this with the agent again" : PEOPLE_ONLY_HINT,
        },
        "People only"
    );
    toggle.disabled = Boolean(state.sharing?.busy);
    toggle.addEventListener("click", () => {
        state.sharing = { busy: true };
        draw.redraw();
        onPeopleOnly(a.id, !on).then(
            () => {
                state.sharing = undefined;
                draw.redraw();
            },
            (error: unknown) => {
                state.sharing = { busy: false, error: messageOf(error) };
                draw.redraw();
            }
        );
    });
    return toggle;
}

/** A line to write in the thread, where there is a server for it to go to. */
function replyControls(draw: CardDraw, actions: CardActions): HTMLElement[] {
    const { onReply } = actions;
    const { state, annotation: a } = draw;
    // While a form of its own is open, the card asks one thing at a time.
    if (!onReply || state.asking || state.reverting) return [];
    state.replying ??= { note: "", busy: false };
    const reply = state.replying;
    const say = h("input", {
        class: "say",
        type: "text",
        placeholder: "Reply…  Enter to send",
        "aria-label": "Reply",
        "data-field": "reply",
    });
    say.value = reply.note;
    say.disabled = reply.busy;
    say.addEventListener("input", () => {
        reply.note = say.value;
    });
    say.addEventListener("focus", () => {
        state.pinned = true; // keep the card up while someone types in it
    });
    say.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" || ev.isComposing || !reply.note.trim() || reply.busy) return;
        ev.preventDefault();
        reply.busy = true;
        reply.error = undefined;
        say.disabled = true;
        onReply(a.id, reply.note.trim(), Boolean(reply.aside)).then(
            () => {
                // The next reply is for the agent again unless they say otherwise.
                state.replying = undefined;
                draw.redraw();
            },
            (error: unknown) => {
                reply.busy = false;
                reply.error = messageOf(error);
                draw.redraw();
            }
        );
    });
    // On a People only note too: an aside stays from the agent even if the note is later shared with it.
    const aside = h(
        "button",
        {
            class: "chip aside",
            type: "button",
            "aria-pressed": String(Boolean(reply.aside)),
            title: ASIDE_HINT,
        },
        "Aside"
    );
    aside.addEventListener("click", () => {
        reply.aside = !reply.aside;
        aside.setAttribute("aria-pressed", String(reply.aside));
        state.pinned = true;
    });
    return [
        h("div", { class: "say-row" }, say, aside),
        ...(reply.error ? [h("div", { class: "say-err" }, reply.error)] : []),
    ];
}

/** What a card says and offers about versions to choose between. */
function variantControls(draw: CardDraw, actions: CardActions): HTMLElement[] {
    const { state, annotation: a } = draw;
    const v = a.variants;
    if (!v || !offersVersions(a)) return [];
    const who = actions.agentName?.() ?? "the agent";
    const picked = a.status === "variant_chosen" ? v.chosen : undefined;
    const say = h(
        "div",
        { class: "hint variants-hint" },
        picked
            ? `You picked “${picked}”. Waiting for ${who} to apply it.`
            : `Versions ready: ${v.options.map((o) => o.name).join(", ")}. Switch between them in the page, then press “Use this”.`
    );
    const { onTakeBackVariant, onReply } = actions;
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

    const asking = state.asking;
    if (!asking) {
        const open = opensForm(draw, "Ask for different versions…", "link plain", () => {
            state.asking = { note: "", busy: false };
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
    return [
        noteForm({
            className: "revert versions",
            hint: say,
            form: asking,
            field: "ask",
            placeholder:
                "What should be different? e.g. bolder, or one more with the image on the right",
            label: "What to change about the versions",
            sendLabel: `Send to ${who}`,
            onCancel: () => {
                state.asking = undefined;
                draw.draw();
            },
            onSend: () => {
                if (!asking.note.trim()) {
                    asking.error = "Write what should be different first.";
                    draw.draw();
                    return;
                }
                send(
                    draw,
                    asking,
                    () => onReply(a.id, asking.note.trim()),
                    () => {
                        state.asking = undefined;
                    }
                );
            },
        }),
    ];
}

/**
 * What a card offers about undoing a change, by where the annotation is in its life: a form in a box of its own,
 * and what goes at the start of the card's last line.
 */
function revertControls(
    draw: CardDraw,
    actions: CardActions
): { box: HTMLElement | null; lead: HTMLElement[] } {
    const { state, annotation: a } = draw;
    const { onRequestRevert, onCancelRevert } = actions;
    const who = actions.agentName?.() ?? "the agent";
    if (a.status === "resolved" && onRequestRevert) {
        const reverting = state.reverting;
        if (!reverting) {
            const open = opensForm(draw, "Revert this change…", "link violet", () => {
                state.reverting = { note: "", busy: false };
            });
            return { box: null, lead: [open] };
        }
        const box = noteForm({
            className: "revert",
            hint: h(
                "div",
                { class: "hint" },
                `${actions.agentName?.() ?? "The agent"} will be asked to undo what it changed for this.`
            ),
            form: reverting,
            field: "revert",
            placeholder: "What is wrong with it? (optional)",
            label: "Why this change should be reverted",
            sendLabel: `Ask ${who} to revert`,
            onCancel: () => {
                state.reverting = undefined;
                draw.draw();
            },
            onSend: () => {
                // Drawn for a resolved note; if it has moved on since, say what it is now instead of acting on that.
                if (draw.current().status !== "resolved") return draw.draw();
                send(
                    draw,
                    reverting,
                    () => onRequestRevert(a.id, reverting.note.trim()),
                    () => {
                        state.reverting = undefined;
                    }
                );
            },
        });
        return { box, lead: [] };
    }
    if (a.status === "revert_requested") {
        const cancel = onCancelRevert
            ? h("button", { class: "link", type: "button" }, "Cancel request")
            : null;
        cancel?.addEventListener("click", () => {
            // Only a request still waiting can be taken back: once the agent has acted, this would undo its answer.
            if (draw.current().status !== "revert_requested") return draw.draw();
            cancel.setAttribute("disabled", "");
            void onCancelRevert?.(a.id).catch(() => cancel.removeAttribute("disabled"));
        });
        return {
            box: null,
            lead: [
                h("span", { class: "hint" }, `Waiting for ${who} to undo it.`),
                ...(cancel ? [cancel] : []),
            ],
        };
    }
    return { box: null, lead: [] };
}
