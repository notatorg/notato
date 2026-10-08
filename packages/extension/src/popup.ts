import { DEFAULT_SERVER, type SiteConfig } from "./protocol.ts";
import {
    annotatable,
    defaultConfig,
    injectNow,
    loadSites,
    registerSite,
    removeNow,
    saveSite,
    unregisterSite,
} from "./sites.ts";

const app = document.getElementById("app") as HTMLElement;
const siteLine = document.getElementById("site") as HTMLElement;

const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Record<string, string> = {},
    ...children: Array<Node | string>
) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) node.setAttribute(key, value);
    node.append(...children);
    return node;
};

const serverOrigin = (server: string): string | null => {
    try {
        return new URL(server).origin;
    } catch {
        return null;
    }
};

async function main() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const origin = annotatable(tab?.url);
    if (!tab?.id || !origin) {
        siteLine.textContent = "Notato works on web pages (http and https), not on this one.";
        return;
    }
    siteLine.textContent = origin;
    const tabId = tab.id;
    const saved = (await loadSites())[origin];
    const config: SiteConfig = { ...defaultConfig(origin), ...saved };

    const message = el("p", { class: "msg", role: "status" });
    const say = (text: string, ok = true) => {
        message.textContent = text;
        message.className = `msg ${ok ? "ok" : "bad"}`;
    };

    const server = el("input", {
        type: "url",
        value: config.server,
        placeholder: DEFAULT_SERVER,
        "aria-label": "Notato server",
    });
    const project = el("input", { type: "text", value: config.project, "aria-label": "Project" });
    const author = el("input", {
        type: "text",
        value: config.author ?? "",
        placeholder: "Your name (optional)",
        "aria-label": "Your name",
    });
    const token = el("input", {
        type: "password",
        value: config.token ?? "",
        placeholder: "Only for a shared server",
        "aria-label": "Project token",
        autocomplete: "off",
    });
    const sw = el("button", {
        class: "sw",
        type: "button",
        role: "switch",
        "aria-checked": String(config.enabled),
        "aria-label": "Notato on this site",
    });

    const current = (): SiteConfig => ({
        enabled: sw.getAttribute("aria-checked") === "true",
        server: server.value.trim().replace(/\/$/, "") || DEFAULT_SERVER,
        project: project.value.trim() || config.project,
        ...(token.value ? { token: token.value } : {}),
        ...(author.value.trim() ? { author: author.value.trim() } : {}),
    });

    /** Applies what is in the form to this site, and to the page if it is open. */
    async function apply(enabled: boolean) {
        const next = { ...current(), enabled };
        const serverBase = serverOrigin(next.server);
        if (!serverBase) return say("That is not a server address.", false);
        if (enabled) {
            // Asked first, while the click that started this still counts: the site, and the server if it is somewhere else.
            const granted = await chrome.permissions.request({
                origins: [`${origin}/*`, `${serverBase}/*`],
            });
            if (!granted)
                return say(
                    "Notato needs permission to run on this site and reach the server.",
                    false
                );
        }
        await saveSite(origin as string, next);
        if (enabled) {
            await registerSite(origin as string);
            await removeNow(tabId).catch(() => {});
            await injectNow(tabId);
            say("Notato is on for this site. Use the toolbar on the page.");
        } else {
            await unregisterSite(origin as string);
            await removeNow(tabId).catch(() => {});
            say("Notato is off for this site.");
        }
        sw.setAttribute("aria-checked", String(enabled));
    }

    sw.addEventListener("click", () => void apply(sw.getAttribute("aria-checked") !== "true"));

    const save = el("button", { class: "b primary", type: "button" }, "Save");
    save.addEventListener("click", () => void apply(sw.getAttribute("aria-checked") === "true"));
    const check = el("button", { class: "b", type: "button" }, "Check server");
    check.addEventListener("click", async () => {
        say("Checking…");
        const target = serverOrigin(server.value.trim() || DEFAULT_SERVER);
        if (!target) return say("That is not a server address.", false);
        const reply = (await chrome.runtime
            .sendMessage({ kind: "ping", server: target })
            .catch(() => undefined)) as { ok: boolean; message?: string } | undefined;
        if (reply?.ok) say("Found a Notato server there.");
        else
            say(
                `Could not reach a Notato server at ${target}. Start one with: npx notato dev`,
                false
            );
    });
    const board = el("button", { class: "b", type: "button" }, "Open board");
    board.addEventListener("click", () => void chrome.tabs.create({ url: current().server }));

    app.replaceChildren(
        el(
            "div",
            { class: "row" },
            el(
                "div",
                {},
                el("strong", {}, "Notato on this site"),
                el("small", {}, "Annotate this page and send the notes to your coding agent")
            ),
            sw
        ),
        el("label", {}, "Notato server", server),
        el("label", {}, "Project (each site is its own by default)", project),
        el("label", {}, "Your name", author),
        el("label", {}, "Project token", token),
        el("div", { class: "buttons" }, save, check, board),
        message
    );
}

void main();
