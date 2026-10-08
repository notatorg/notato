import { DETAILS, type Detail } from "@notato/core";
import { MARKER_COLORS, type SettingsStore } from "../settings.ts";
import { plural } from "../text.ts";
import { dismissOnOutside, h } from "./dom.ts";
import type { ConnectionState } from "./toolbar.ts";

export interface ServerInfo {
    version?: string;
    mode?: string;
    /** Pages with a live connection to the server. */
    pages?: number;
    screenshots?: "on" | "off";
    /**
     * Whether a coding agent (Claude Code, Codex, Cursor… through Notato's MCP) is connected, whether it is waiting for
     * notes, and what the connected agents are called.
     */
    agent?: { connected: boolean; watching: boolean; names?: string[] };
}

/**
 * Where the server is, and what the page asks it. Nothing about webhooks: they are set up on the server (its config
 * file, or `npx notato config webhook`), and a page never sees them.
 */
export interface ServerLinks {
    url: string;
    project: string;
    connection(): ConnectionState;
    status(): Promise<ServerInfo | null>;
}

export interface SettingsPanelOptions {
    layer: HTMLElement;
    settings: SettingsStore;
    /** Where the toolbar's settings button is: the panel sits above it, or below it when the toolbar is near the top. */
    anchor(): { left: number; top: number; width: number; height?: number };
    /** Present when there is a server to show. */
    server?: ServerLinks;
    /** Whether the server lets this page take screenshots. */
    serverScreenshots(): boolean;
    /** Hides Notato until the page is reloaded. */
    onHide(): void;
    /** The panel opened or closed, however it happened (the toolbar shows its button pressed while it is open). */
    onToggle?(open: boolean): void;
    /** The button that opens and closes the panel: a press on it is left to its click, which closes the panel. */
    owner?(): Element | null;
}

export interface SettingsPanel {
    open(): void;
    close(): void;
    toggle(): void;
    readonly isOpen: boolean;
    destroy(): void;
}

const BLURB: Record<Detail, string> = {
    compact: "A line each",
    standard: "Enough to find and fix it",
    detailed: "Plus styles and position",
    forensic: "Everything captured",
};

export function createSettingsPanel(options: SettingsPanelOptions): SettingsPanel {
    const { layer, settings } = options;
    let el: HTMLElement | null = null;
    let view: "main" | "server" = "main";
    let off: (() => void) | undefined;
    /** Saves a name typed but not yet saved: the panel can close, or move on, without the field being left first. */
    let commitName: (() => void) | undefined;

    const close = () => {
        const was = el !== null;
        commitName?.();
        commitName = undefined;
        off?.();
        off = undefined;
        el?.remove();
        el = null;
        view = "main";
        if (was) options.onToggle?.(false);
    };

    /** A labelled on/off switch. `locked` says why it cannot be changed right now, or nothing when it can. */
    function toggle(
        label: string,
        help: string,
        key: "components" | "styles" | "screenshots" | "mineOnly",
        locked: () => string | undefined = () => undefined
    ) {
        const on = () => settings.get()[key];
        const sw = h("button", {
            class: "sw",
            type: "button",
            role: "switch",
            "aria-label": label,
        });
        const note = h("div", { class: "shelp" });
        /** Brings the switch in line with its setting and with whether it can be changed. */
        const refresh = () => {
            const why = locked();
            sw.disabled = Boolean(why);
            sw.setAttribute("aria-checked", String(on() && !why));
            note.textContent = why ?? help;
        };
        sw.addEventListener("click", () => {
            settings.set({ [key]: !on() });
            refresh();
        });
        refresh();
        return {
            row: h(
                "div",
                { class: "srow" },
                h("div", { class: "stext" }, h("div", { class: "slabel" }, label), note),
                sw
            ),
            refresh,
        };
    }

    function mainView(): HTMLElement[] {
        const s = settings.get();
        const name = h("input", {
            class: "sinput",
            type: "text",
            placeholder: "Your name",
            "aria-label": "Your name",
            maxlength: "60",
            value: s.name,
            autocomplete: "off",
        }) as HTMLInputElement;
        const mine = toggle(
            "Only my notes",
            "Hide what other people wrote on this page.",
            "mineOnly",
            () =>
                settings.get().name.trim()
                    ? undefined
                    : "Add your name above first, so your notes can be told apart."
        );
        // Saved when it is left or Enter is pressed, so the field is never replaced under the cursor mid-word, and
        // when the panel closes or moves on with the field still in use.
        const saveName = () => {
            if (name.value === settings.get().name) return;
            settings.set({ name: name.value });
            mine.refresh(); // the switch for "only my notes" needs a name to mean anything
        };
        name.addEventListener("change", saveName);
        commitName = saveName;
        name.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") name.blur();
        });

        const levels = h(
            "div",
            { class: "seg", role: "radiogroup", "aria-label": "Copy as Markdown" },
            ...DETAILS.map((d) => {
                const b = h(
                    "button",
                    {
                        type: "button",
                        role: "radio",
                        "aria-checked": String(d === s.copyDetail),
                        title: BLURB[d],
                    },
                    d
                );
                b.addEventListener("click", () => {
                    settings.set({ copyDetail: d });
                    for (const other of levels.querySelectorAll("button"))
                        other.setAttribute("aria-checked", String(other.textContent === d));
                });
                return b;
            })
        );

        const swatches = h(
            "div",
            { class: "swatches", role: "radiogroup", "aria-label": "Pin colour" },
            ...MARKER_COLORS.map((c) => {
                const b = h("button", {
                    type: "button",
                    class: "swatch",
                    role: "radio",
                    "aria-checked": String(c.id === s.markerColor),
                    "aria-label": c.name,
                    title: c.name,
                    style: { background: c.hex },
                });
                b.addEventListener("click", () => {
                    settings.set({ markerColor: c.id });
                    for (const other of swatches.querySelectorAll("button"))
                        other.setAttribute(
                            "aria-checked",
                            String(other.getAttribute("aria-label") === c.name)
                        );
                });
                return b;
            })
        );

        const hide = h(
            "button",
            { class: "slink", type: "button" },
            "Hide Notato until this page is reloaded"
        );
        hide.addEventListener("click", () => {
            close();
            options.onHide();
        });

        const rows: HTMLElement[] = [
            h(
                "div",
                { class: "sfield" },
                h("div", { class: "slabel" }, "Your name"),
                name,
                h(
                    "div",
                    { class: "shelp" },
                    "Written on your notes and replies, so others can tell who wrote what."
                )
            ),
            h(
                "div",
                { class: "sfield" },
                h("div", { class: "slabel" }, "Copy as Markdown"),
                levels
            ),
            h(
                "div",
                { class: "stoggles" },
                toggle(
                    "Component names",
                    "Record the React or Angular components around an element.",
                    "components"
                ).row,
                toggle(
                    "Computed styles",
                    "Record an element's colours, type, size and spacing.",
                    "styles"
                ).row,
                toggle("Screenshots", "Take a screenshot with each note.", "screenshots", () =>
                    options.serverScreenshots()
                        ? undefined
                        : "The server has screenshots turned off."
                ).row,
                mine.row
            ),
            h("div", { class: "sfield" }, h("div", { class: "slabel" }, "Pin colour"), swatches),
        ];
        if (options.server) {
            const go = h(
                "button",
                { class: "snav", type: "button" },
                h("span", {
                    class: "sdot",
                    "data-state": options.server.connection(),
                    "aria-hidden": "true",
                }),
                h("span", {}, "Server and agent"),
                h("span", { class: "chev", "aria-hidden": "true" }, "›")
            );
            go.addEventListener("click", () => {
                view = "server";
                render();
            });
            rows.push(go);
        }
        rows.push(hide);
        return rows;
    }

    function serverView(): HTMLElement[] {
        const server = options.server;
        if (!server) return [];
        const status = h("div", { class: "shelp" }, "Checking…");
        const conn = server.connection();
        const word =
            conn === "connected"
                ? "Connected"
                : conn === "connecting"
                  ? "Connecting…"
                  : "Cannot reach it";

        void server.status().then((info) => {
            if (!el || view !== "server") return;
            status.textContent = info
                ? [
                      info.version ? `Notato ${info.version}` : "",
                      info.mode ? `${info.mode} mode` : "",
                      info.pages !== undefined ? `${plural(info.pages, "page")} connected` : "",
                      info.screenshots ? `screenshots ${info.screenshots}` : "",
                  ]
                      .filter(Boolean)
                      .join(" · ")
                : "The server did not answer.";
            showAgent(info?.agent);
        });

        const agentField = h("div", { class: "sfield" });
        function showAgent(agent: ServerInfo["agent"]) {
            const names = agent?.names ?? [];
            agentField.replaceChildren(
                h("div", { class: "slabel" }, names.length ? names.join(", ") : "Coding agent")
            );
            if (agent?.connected) {
                agentField.append(
                    h(
                        "div",
                        { class: "shelp ok" },
                        agent.watching
                            ? "Connected, and watching for notes."
                            : "Connected, not watching for notes yet."
                    )
                );
                if (!agent.watching)
                    agentField.append(
                        h(
                            "div",
                            { class: "shelp" },
                            "Ask it to watch Notato, or use the notato skill."
                        )
                    );
                agentField.append(
                    h(
                        "div",
                        { class: "shelp" },
                        "Everything you write reaches it. Mark a note People only, or send a reply as an aside, to keep it between people."
                    )
                );
                return;
            }
            agentField.append(
                h(
                    "div",
                    { class: "shelp" },
                    "Notes reach your coding agent (Claude Code, Codex, Cursor, Gemini CLI, Copilot…) through MCP. Set it up once in your project:"
                ),
                h("code", { class: "scode" }, "npx notato init"),
                h("div", { class: "shelp" }, "Then ask your agent to watch Notato.")
            );
        }
        showAgent(undefined);

        return [
            h(
                "div",
                { class: "sfield" },
                h(
                    "div",
                    { class: "slabel" },
                    h("span", { class: "sdot", "data-state": conn }),
                    ` ${word}`
                ),
                h("div", { class: "shelp" }, `${server.url} · project ${server.project}`),
                status
            ),
            agentField,
        ];
    }

    function render() {
        if (!el) return;
        commitName?.();
        commitName = undefined;
        const back = h("button", { class: "sback", type: "button", "aria-label": "Back" }, "‹");
        back.addEventListener("click", () => {
            view = "main";
            render();
        });
        const x = h(
            "button",
            { class: "sback x", type: "button", "aria-label": "Close settings" },
            "×"
        );
        x.addEventListener("click", close);
        el.replaceChildren(
            h(
                "div",
                { class: "shead" },
                view === "server" ? back : null,
                h(
                    "div",
                    { class: "stitle" },
                    view === "server" ? "Server and agent" : "Notato settings"
                ),
                x
            ),
            ...(view === "server" ? serverView() : mainView())
        );
        place();
    }

    function place() {
        if (!el) return;
        const a = options.anchor();
        const w = el.offsetWidth || 300;
        el.style.left = `${Math.max(8, Math.min(a.left + a.width - w, window.innerWidth - w - 8))}px`;
        // The toolbar can be dragged anywhere: open towards the side of the window with more room.
        if (a.top < window.innerHeight / 2) {
            const top = a.top + (a.height ?? 0) + 8;
            el.style.top = `${top}px`;
            el.style.bottom = "";
            el.style.maxHeight = `${Math.max(160, window.innerHeight - top - 12)}px`;
        } else {
            el.style.top = "";
            el.style.bottom = `${Math.max(8, window.innerHeight - a.top + 8)}px`;
            el.style.maxHeight = `${Math.max(160, a.top - 20)}px`;
        }
    }

    return {
        get isOpen() {
            return el !== null;
        },
        open() {
            if (el) return;
            el = h("div", { class: "spanel", role: "dialog", "aria-label": "Notato settings" });
            layer.append(el);
            render();
            options.onToggle?.(true);
            off = dismissOnOutside(el, close, options.owner?.());
        },
        close,
        toggle() {
            if (el) close();
            else this.open();
        },
        destroy: close,
    };
}
