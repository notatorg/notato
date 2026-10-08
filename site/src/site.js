// The Notato website: the hero demo, the showcase widgets, and the button that loads the real toolbar.

import { highlight } from "./highlight.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const esc = (text) =>
    String(text).replace(
        /[&<>"]/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]
    );
const restart = (node, cls) => {
    node.classList.remove(cls);
    void node.offsetWidth;
    node.classList.add(cls);
};

/** How the toolbar's cards say a status. */
const statusLabel = (status) =>
    ({
        open: "Open",
        acknowledged: "Acknowledged",
        variant_chosen: "Variant chosen",
        resolved: "Resolved",
        revert_requested: "Revert requested",
        reverted: "Reverted",
        dismissed: "Dismissed",
    })[status] ?? status;

/** Runs `onChange(true/false)` as the element comes into view and leaves it. */
function whenVisible(node, onChange) {
    if (!("IntersectionObserver" in window)) return onChange(true);
    new IntersectionObserver((entries) => {
        for (const entry of entries) onChange(entry.isIntersecting);
    }).observe(node);
}

/**
 * A row of buttons where one is chosen: click, or arrow keys and Home/End move the choice. `attr` is
 * `aria-selected` for tabs and `aria-checked` for radios. Returns `choose(index)` for choosing from code.
 */
function roving(items, attr, onChoose) {
    let current = Math.max(
        0,
        items.findIndex((b) => b.getAttribute(attr) === "true")
    );
    const choose = (index, byUser = false, focus = false) => {
        current = index;
        items.forEach((b, i) => {
            b.setAttribute(attr, String(i === index));
            b.tabIndex = i === index ? 0 : -1;
        });
        if (focus) items[index].focus();
        onChoose(index, items[index], byUser);
    };
    items.forEach((b, i) => {
        b.tabIndex = i === current ? 0 : -1;
        b.addEventListener("click", () => choose(i, true));
        b.addEventListener("keydown", (event) => {
            const last = items.length - 1;
            const next = {
                ArrowRight: i === last ? 0 : i + 1,
                ArrowDown: i === last ? 0 : i + 1,
                ArrowLeft: i === 0 ? last : i - 1,
                ArrowUp: i === 0 ? last : i - 1,
                Home: 0,
                End: last,
            }[event.key];
            if (next === undefined) return;
            event.preventDefault();
            choose(next, true, true);
        });
    });
    return {
        choose,
        get current() {
            return current;
        },
        mark(index) {
            current = index;
            items.forEach((b, i) => {
                b.setAttribute(attr, String(i === index));
                b.tabIndex = i === index ? 0 : -1;
            });
        },
    };
}

/* ------------------------------------------------------------------ copy */

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.cssText = "position:fixed;top:0;left:0;opacity:0";
        document.body.append(area);
        area.select();
        let ok = false;
        try {
            ok = document.execCommand("copy");
        } catch {
            ok = false;
        }
        area.remove();
        return ok;
    }
}

function showCopied(button, ok) {
    const use = $("use", button);
    if (use) {
        use.setAttribute("href", ok ? "#i-check" : "#i-copy");
        button.classList.toggle("copied", ok);
    } else {
        button.dataset.label ??= button.textContent;
        button.textContent = ok ? "Copied" : "Select and copy";
    }
    clearTimeout(button._timer);
    button._timer = setTimeout(() => {
        if (use) use.setAttribute("href", "#i-copy");
        else button.textContent = button.dataset.label;
        button.classList.remove("copied");
    }, 1500);
}

function initCopy() {
    document.addEventListener("click", async (event) => {
        const button = event.target.closest("[data-copy]");
        if (!button) return;
        showCopied(button, await copyText(button.dataset.copy));
    });
}

/* ------------------------------------------------------------- the stage */

class Cancelled extends Error {}

/** The agent each demo story runs in. Any MCP client works the same loop; only its terminal looks different. */
const LOOKS = [
    {
        cmd: "claude",
        author: "Claude",
        banner: "✻ Claude Code",
        accent: "#eba37f",
        tools: { edit: "Update", shell: "Bash", read: "Read" },
    },
    {
        cmd: "codex",
        author: "Codex",
        banner: ">_ Codex",
        accent: "#7fd9bc",
        tools: { edit: "apply_patch", shell: "shell", read: "read" },
    },
    {
        cmd: "gemini",
        author: "Gemini",
        banner: "✦ Gemini CLI",
        accent: "#9dbcff",
        tools: { edit: "Edit", shell: "Shell", read: "ReadFile" },
    },
];

/** Agents, as against people, in the demo's threads. */
const AGENT_NAMES = new Set(["Claude", "Codex", "Cursor", "Gemini", "Copilot"]);

function initStage() {
    const stage = $("#stage");
    if (!stage) return;
    const app = $("#app", stage);
    const term = $("#term", stage);
    const termUrl = $(".term-url", stage);
    const el = {
        hover: $(".nt-hover", app),
        hoverLabel: $(".nt-hover-label", app),
        sel: $(".nt-sel", app),
        pins: $(".nt-pins", app),
        card: $(".nt-card", app),
        pop: $(".nt-pop", app),
        popTarget: $(".pop-target", app),
        popSrc: $(".pop-src", app),
        popText: $(".pop-text", app),
        popTyped: $(".pop-typed", app),
        popSend: $(".pop-send", app),
        popSev: $(".pop-sev", app),
        vpill: $(".nt-vpill", app),
        vuse: $(".nt-vpill .vuse", app),
        vstate: $(".nt-vpill .vstate", app),
        annotate: $(".tb-annotate", app),
        count: $(".tb-count", app),
        toast: $(".nt-toast", app),
        cursor: $(".cursor", app),
        pay: $("[data-demo=pay]", app),
        delivery: $("[data-demo=delivery]", app),
        basket: $("[data-demo=basket]", app),
        basketTitle: $("[data-demo=basket-title]", app),
        row: $("[data-demo=row]", app),
    };

    // The clock: every wait checks that this run is still the current one, and stands still while paused.
    let token = 0;
    let paused = false;
    let held = false;
    const newRun = () => {
        const mine = ++token;
        const run = {
            instant: false,
            async wait(ms) {
                if (mine !== token) throw new Cancelled();
                if (run.instant || reduceMotion.matches) return;
                let left = ms;
                while (left > 0) {
                    const step = Math.min(left, 40);
                    await sleep(step);
                    if (mine !== token) throw new Cancelled();
                    if (!paused && !held) left -= step;
                }
            },
            get fast() {
                return run.instant || reduceMotion.matches;
            },
        };
        return run;
    };

    const rel = (node) => {
        const a = app.getBoundingClientRect();
        const b = node.getBoundingClientRect();
        return { x: b.left - a.left, y: b.top - a.top, w: b.width, h: b.height };
    };

    // The cursor.
    let at = { x: 0, y: 0 };
    const place = (x, y, ms) => {
        el.cursor.style.setProperty("--ms", `${ms}ms`);
        el.cursor.style.setProperty("--x", `${x}px`);
        el.cursor.style.setProperty("--y", `${y}px`);
        at = { x, y };
    };
    async function moveTo(run, node, { ax = 0.5, ay = 0.5 } = {}) {
        const b = rel(node);
        await moveToPoint(run, b.x + b.w * ax, b.y + b.h * ay);
    }
    async function moveToPoint(run, x, y) {
        const ms = Math.round(Math.min(950, 300 + Math.hypot(x - at.x, y - at.y) * 1.15));
        place(x, y, run.fast ? 0 : ms);
        await run.wait(ms + 30);
    }
    async function click(run) {
        el.cursor.classList.add("down");
        if (!run.fast) {
            const ring = document.createElement("span");
            ring.className = "ripple";
            ring.style.left = `${at.x}px`;
            ring.style.top = `${at.y}px`;
            app.append(ring);
            setTimeout(() => ring.remove(), 600);
        }
        await run.wait(140);
        el.cursor.classList.remove("down");
        await run.wait(110);
    }

    // Notato's overlay.
    const frame = (box, node, pad = 3) => {
        const b = rel(node);
        const first = !box.classList.contains("on");
        if (first) box.style.transition = "none";
        box.style.translate = `${b.x - pad}px ${b.y - pad}px`;
        box.style.width = `${b.w + pad * 2}px`;
        box.style.height = `${b.h + pad * 2}px`;
        box.classList.add("on");
        if (first) {
            void box.offsetWidth;
            box.style.transition = "";
        }
        return b;
    };
    const hoverOn = (node, label) => {
        const b = frame(el.hover, node);
        el.hoverLabel.textContent = label;
        el.hover.classList.toggle("below", b.y < 34);
    };
    const setCount = (n, bump = true) => {
        el.count.textContent = String(n);
        if (bump) restart(el.count, "bump");
    };
    const addPin = (node, n) => {
        const b = rel(node);
        const pin = document.createElement("span");
        pin.className = "nt-pin";
        pin.dataset.status = "open";
        pin.textContent = String(n);
        // Just outside the element's top-right corner, so it covers nothing it points at.
        pin.style.left = `${b.x + b.w + 3}px`;
        pin.style.top = `${b.y + 3}px`;
        el.pins.append(pin);
        return pin;
    };
    const setPin = (pin, status) => {
        pin.dataset.status = status;
        restart(pin, "bump");
    };
    const burst = (run, pin) => {
        if (run.fast) return;
        const x = Number.parseFloat(pin.style.left);
        const y = Number.parseFloat(pin.style.top);
        const colours = ["#16a34a", "#d8953f", "#2563eb", "#f4c56e", "#1b7f64", "#f2a091"];
        for (let i = 0; i < 18; i++) {
            const spark = document.createElement("span");
            const angle = (i / 18) * Math.PI * 2 + Math.random() * 0.4;
            const distance = 30 + Math.random() * 40;
            spark.className = "spark";
            spark.style.left = `${x}px`;
            spark.style.top = `${y}px`;
            spark.style.setProperty("--dx", `${Math.cos(angle) * distance}px`);
            spark.style.setProperty("--dy", `${Math.sin(angle) * distance}px`);
            spark.style.setProperty("--r", `${Math.round(Math.random() * 540)}deg`);
            spark.style.setProperty("--c", colours[i % colours.length]);
            el.pins.append(spark);
            setTimeout(() => spark.remove(), 900);
        }
    };
    const placeNear = (box, b, below = true) => {
        const a = app.getBoundingClientRect();
        const w = box.offsetWidth;
        const h = box.offsetHeight;
        const x = Math.min(Math.max(10, b.x + b.w / 2 - w / 2), a.width - w - 10);
        let y = below ? b.y + b.h + 10 : b.y - h - 10;
        if (below && y + h > a.height - 56) y = b.y - h - 10;
        if (y < 8) y = Math.min(b.y + b.h + 10, a.height - h - 8);
        box.style.left = `${Math.round(x)}px`;
        box.style.top = `${Math.round(Math.max(8, y))}px`;
    };
    const openPopover = (node, { target, src }) => {
        el.popTarget.textContent = target;
        el.popSrc.textContent = src;
        el.popTyped.textContent = "";
        el.popText.classList.remove("focus");
        for (const chip of $$("[data-intent]", el.pop)) chip.classList.remove("on");
        el.pop.hidden = false;
        placeNear(el.pop, rel(node));
    };
    const openCard = (pin, status, messages) => {
        el.card.innerHTML =
            `<p class="c-meta"><span class="badge" data-v="${status}">${statusLabel(status)}</span>#${esc(pin.textContent)} · /checkout</p>` +
            messages
                .map(
                    (m) =>
                        `<p class="c-msg${m.agent ? " agent" : ""}"><b>${esc(m.who)}</b>${esc(m.text)}</p>`
                )
                .join("");
        el.card.hidden = false;
        const p = rel(pin);
        placeNear(el.card, { x: p.x - 120, y: p.y, w: p.w, h: p.h });
    };
    const hot = (file) => {
        el.toast.hidden = false;
        el.toast.textContent = `[vite] hot updated: /src/checkout/${file}`;
        el.toast.style.animation = "none";
        void el.toast.offsetWidth;
        el.toast.style.animation = "";
    };
    const setVariant = (name) => {
        el.basket.classList.remove("v-cards", "v-compact");
        if (name !== "original") el.basket.classList.add(`v-${name}`);
        for (const tab of $$("[data-v]", el.vpill))
            tab.classList.toggle("on", tab.dataset.v === name);
    };

    // The agent's side: a terminal session, in whichever agent this story runs in.
    let look = LOOKS[0];
    const T = {
        add(cls, html) {
            const line = document.createElement("div");
            line.className = `t-line ${cls}`;
            line.innerHTML = html;
            term.append(line);
            term.scrollTop = term.scrollHeight;
            return line;
        },
        tool: (name, args) => T.add("t-tool", `<b>${esc(name)}</b>${args ? `(${esc(args)})` : ""}`),
        out: (text, cls = "") => T.add(`t-out ${cls}`, esc(text)),
        note: (text, cls = "") => T.add(`t-note ${cls}`, esc(text)),
        mark: (text) => T.add("t-mark", esc(text)),
        diff: (lines) =>
            T.add(
                "t-diff",
                lines
                    .map(
                        ([kind, text]) =>
                            `<span class="${kind}">${kind === "add" ? "+" : "-"} ${esc(text)}</span>`
                    )
                    .join("")
            ),
        waiting: () => T.out("Waiting for notes…", "t-wait"),
        /** A fresh session in another agent: its banner, the request, and a watch waiting for notes. */
        session(next) {
            look = next;
            termUrl.textContent = `${next.cmd} · ~/code/spudshop`;
            term.style.setProperty("--agent-accent", next.accent);
            term.replaceChildren();
            T.add("t-banner", esc(next.banner));
            T.add("t-prompt", "watch Notato and fix what comes in");
            T.tool("notato_watch", 'project: "spudshop"');
            T.waiting();
        },
        settle(text) {
            const line = $$(".t-wait", term).pop();
            if (!line) return T.out(text);
            line.classList.remove("t-wait");
            line.textContent = text;
            return line;
        },
    };

    /** Annotate mode, a walk over the page, then a note on `node`. Returns the new pin. */
    async function annotate(run, { via, node, label, target, src, intent, text, n }) {
        await moveTo(run, el.annotate);
        await click(run);
        el.annotate.classList.add("on");
        for (const [over, overLabel] of via) {
            await moveTo(run, over, { ax: 0.4, ay: 0.55 });
            hoverOn(over, overLabel);
            await run.wait(420);
        }
        await moveTo(run, node, { ax: 0.62, ay: 0.55 });
        hoverOn(node, label);
        await run.wait(500);
        await click(run);
        el.hover.classList.remove("on");
        frame(el.sel, node);
        openPopover(node, { target, src });
        await run.wait(450);
        const chip = $(`[data-intent="${intent}"]`, el.pop);
        await moveTo(run, chip);
        await click(run);
        chip.classList.add("on");
        await moveTo(run, el.popText, { ax: 0.25, ay: 0.45 });
        await click(run);
        el.popText.classList.add("focus");
        el.popTyped.textContent = "";
        if (run.fast) el.popTyped.textContent = text;
        else
            for (const ch of text) {
                el.popTyped.textContent += ch;
                await run.wait(26 + Math.random() * 44);
            }
        await run.wait(380);
        await moveTo(run, el.popSend);
        await click(run);
        el.pop.hidden = true;
        el.sel.classList.remove("on");
        el.annotate.classList.remove("on");
        const pin = addPin(node, n);
        setCount(n, !run.fast);
        const a = app.getBoundingClientRect();
        await moveToPoint(run, a.width * 0.3, a.height * 0.72);
        return pin;
    }

    const stories = [
        async function change(run) {
            T.session(LOOKS[0]);
            await run.wait(700);
            const pin = await annotate(run, {
                via: [
                    [el.row, "listitem “Maris Piper” in <BasketRow>"],
                    [el.delivery, "div “Delivery £4.80” in <SummaryRow>"],
                ],
                node: el.pay,
                label: "button “Pay £12.40” in <PayButton>",
                target: "button “Pay £12.40”",
                src: "<PayButton> · src/checkout/PayButton.tsx:18",
                intent: "change",
                text: "Make it green and say “Place order”",
                n: 1,
            });
            await run.wait(500);
            T.settle("1 note from Dom");
            T.mark("#1 [change, minor] /checkout");
            T.note("Make it green and say “Place order”");
            T.note("button “Pay £12.40” · <PayButton> · src/checkout/PayButton.tsx:18:7", "dim");
            T.note("+ 2 screenshots", "dim");
            await run.wait(1000);
            T.tool("notato_acknowledge", "#1");
            setPin(pin, "acknowledged");
            await run.wait(900);
            T.tool(look.tools.edit, "src/checkout/PayButton.tsx");
            T.diff([
                ["del", '<Button tone="primary">Pay {total}</Button>'],
                ["add", '<Button tone="go">Place order · {total}</Button>'],
            ]);
            await run.wait(1000);
            hot("PayButton.tsx");
            el.pay.classList.add("is-go");
            el.pay.textContent = "Place order · £12.40";
            if (!run.fast) restart(el.pay, "flash");
            await run.wait(1000);
            T.tool(
                look.tools.shell,
                'git commit -m "Checkout: green Place order button (Notato #1)"'
            );
            T.out("[main 3f9c2a1] 1 file changed, 1 insertion(+), 1 deletion(-)");
            await run.wait(900);
            T.tool("notato_resolve", '#1, commit: "3f9c2a1"');
            setPin(pin, "resolved");
            burst(run, pin);
            T.out("Resolved", "t-ok");
            await run.wait(500);
            T.tool("notato_watch");
            T.waiting();
            await run.wait(2400);
        },

        async function question(run) {
            T.session(LOOKS[1]);
            await run.wait(600);
            const pin = await annotate(run, {
                via: [[el.basketTitle, "heading “Your basket” in <Basket>"]],
                node: el.delivery,
                label: "div “Delivery £4.80” in <SummaryRow>",
                target: "div “Delivery £4.80”",
                src: "<SummaryRow> · src/checkout/Summary.tsx:31",
                intent: "question",
                text: "Why is delivery £4.80 on a £7.60 basket?",
                n: 2,
            });
            await run.wait(500);
            T.settle("1 note from Dom");
            T.mark("#2 [question] /checkout");
            T.note("Why is delivery £4.80 on a £7.60 basket?");
            T.note("div “Delivery £4.80” · <SummaryRow> · src/checkout/Summary.tsx:31:9", "dim");
            await run.wait(900);
            T.tool("notato_acknowledge", "#2");
            setPin(pin, "acknowledged");
            await run.wait(700);
            T.tool(look.tools.read, "src/checkout/delivery.ts");
            T.out("Read 24 lines");
            await run.wait(900);
            const answer =
                "Baskets under £10 pay the £4.80 small-order rate (delivery.ts:9). Say if you want that threshold lower and I'll change it.";
            T.tool("notato_reply", "#2");
            T.out(answer);
            openCard(pin, "question", [
                { who: "Dom", text: "Why is delivery £4.80 on a £7.60 basket?" },
                { who: look.author, text: answer, agent: true },
            ]);
            await run.wait(2200);
            T.tool("notato_resolve", '#2, summary: "Answered"');
            setPin(pin, "resolved");
            burst(run, pin);
            $(".badge", el.card).dataset.v = "resolved";
            $(".badge", el.card).textContent = statusLabel("resolved");
            T.out("Answered. No code changed: it was a question.", "t-ok");
            await run.wait(500);
            T.tool("notato_watch");
            T.waiting();
            await run.wait(2400);
            el.card.hidden = true;
        },

        async function variants(run) {
            T.session(LOOKS[2]);
            el.card.hidden = true;
            await run.wait(600);
            const pin = await annotate(run, {
                via: [[el.row, "listitem “Maris Piper” in <BasketRow>"]],
                node: el.basket,
                label: "section “Your basket” in <Basket>",
                target: "section “Your basket”",
                src: "<Basket> · src/checkout/Basket.tsx:12",
                intent: "variants",
                text: "Try a couple of other layouts for this",
                n: 3,
            });
            await run.wait(500);
            T.settle("1 note from Dom");
            T.mark("#3 [variants] /checkout");
            T.note("Try a couple of other layouts for this");
            await run.wait(800);
            T.tool("notato_acknowledge", "#3");
            setPin(pin, "acknowledged");
            await run.wait(700);
            T.tool(look.tools.edit, "src/checkout/Basket.tsx");
            T.diff([
                ["add", '<div data-notato-variant="basket" data-notato-variant-name="Cards">'],
                ["add", '<div data-notato-variant="basket" data-notato-variant-name="Compact">'],
            ]);
            await run.wait(900);
            hot("Basket.tsx");
            T.tool(
                "notato_variants_ready",
                '#3, group: "basket", names: ["Original", "Cards", "Compact"]'
            );
            el.vpill.hidden = false;
            el.vuse.hidden = false;
            el.vstate.hidden = true;
            await run.wait(400);
            T.tool("notato_watch");
            T.waiting();
            await run.wait(600);
            for (const name of ["cards", "compact", "cards"]) {
                await moveTo(run, $(`[data-v="${name}"]`, el.vpill));
                await click(run);
                setVariant(name);
                await run.wait(1300);
            }
            await moveTo(run, el.vuse);
            await click(run);
            el.vuse.hidden = true;
            el.vstate.hidden = false;
            el.vstate.textContent = "✓ Cards chosen";
            setPin(pin, "variant_chosen");
            await run.wait(800);
            T.settle("⇄ VARIANT CHOSEN: “Cards” (Dom)").classList.add("t-mark");
            await run.wait(700);
            T.tool(look.tools.edit, "src/checkout/Basket.tsx");
            T.out("Kept Cards. Removed Original, Compact and the markers.");
            await run.wait(900);
            el.vpill.hidden = true;
            hot("Basket.tsx");
            T.tool(look.tools.shell, 'git commit -m "Basket: card layout (Notato #3)"');
            T.out("[main 8d41e07] 1 file changed, 14 insertions(+), 22 deletions(-)");
            await run.wait(800);
            T.tool("notato_resolve", '#3, commit: "8d41e07"');
            setPin(pin, "resolved");
            burst(run, pin);
            T.out("Resolved. 3 of 3 notes done.", "t-ok");
            await run.wait(3600);
        },
    ];

    const reset = () => {
        el.pins.replaceChildren();
        for (const node of [el.card, el.pop, el.vpill, el.toast]) node.hidden = true;
        for (const node of [el.hover, el.sel, el.annotate]) node.classList.remove("on");
        el.pay.classList.remove("is-go");
        el.pay.textContent = "Pay £12.40";
        setVariant("original");
        setCount(0, false);
        T.session(LOOKS[0]);
        const a = app.getBoundingClientRect();
        place(a.width * 0.55, a.height * 0.62, 0);
    };

    const tabButtons = $$(".stories [data-story]", stage);
    const tabs = roving(tabButtons, "aria-selected", (index, _button, byUser) => {
        if (byUser) play(index);
    });
    const markDone = (upTo) => {
        tabButtons.forEach((b, i) => {
            b.classList.toggle("done", i < upTo);
        });
    };

    let playing = 0;
    async function play(from) {
        const run = newRun();
        playing = from;
        stage.classList.add("instant");
        reset();
        try {
            // Stories build on each other, so the ones before the chosen one are played out at once.
            run.instant = true;
            for (let i = 0; i < from; i++) await stories[i](run);
            run.instant = false;
            term.scrollTop = term.scrollHeight;
            void stage.offsetWidth;
            stage.classList.remove("instant");
            for (let i = from; ; i++) {
                if (i === stories.length) {
                    if (reduceMotion.matches) return;
                    i = 0;
                    reset();
                    await run.wait(400);
                }
                playing = i;
                tabs.mark(i);
                markDone(i);
                await stories[i](run);
                if (reduceMotion.matches) {
                    markDone(i + 1);
                    return;
                }
            }
        } catch (error) {
            if (!(error instanceof Cancelled)) throw error;
        }
    }

    const pauseButton = $(".playpause", stage);
    pauseButton.addEventListener("click", () => {
        paused = !paused;
        pauseButton.setAttribute("aria-pressed", String(paused));
        pauseButton.setAttribute("aria-label", paused ? "Play the demo" : "Pause the demo");
        $("use", pauseButton).setAttribute("href", paused ? "#i-play" : "#i-pause");
        stage.classList.toggle("paused", paused);
    });
    if (reduceMotion.matches) pauseButton.hidden = true;

    let onScreen = true;
    const updateHeld = () => {
        held = !onScreen || document.hidden;
    };
    whenVisible(stage, (visible) => {
        onScreen = visible;
        updateHeld();
    });
    document.addEventListener("visibilitychange", updateHeld);

    // Positions are measured, so a resize replays the current story from its start.
    let width = app.clientWidth;
    let resizeTimer;
    window.addEventListener("resize", () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            if (app.clientWidth === width) return;
            width = app.clientWidth;
            play(playing);
        }, 250);
    });

    const fontsReady = document.fonts?.ready ?? Promise.resolve();
    Promise.race([fontsReady, sleep(1500)]).then(() => play(0));
}

/* -------------------------------------------------------------- showcase */

/** What a note with each intent says, what the agent answers, and which agent answers it in this demo. */
const INTENTS = {
    fix: [
        "The total doesn't change when I remove an item",
        "removeItem never recalculated the total. Fixed in Basket.tsx:44, committed 9e1c0d2 on its own, resolved.",
        "Claude",
    ],
    change: [
        "Make the pay button green",
        "Changed the tone to “go” in PayButton.tsx:18. Committed 3f9c2a1 with only that file, resolved.",
        "Codex",
    ],
    question: [
        "Why is delivery £4.80 here?",
        "Baskets under £10 pay the small-order rate, set in delivery.ts:9. I haven't changed anything.",
        "Cursor",
    ],
    approve: [
        "This empty basket screen is perfect",
        "Noted. I'll leave EmptyBasket.tsx exactly as it is.",
        "Gemini",
    ],
    variants: [
        "Three takes on this header, please",
        "Original, Stacked and Compact are side by side in Header.tsx. Pick one in the page and I'll keep it.",
        "Copilot",
    ],
};

function initIntents() {
    const tile = $(".t-intents");
    if (!tile) return;
    const note = $(".intent-note", tile);
    const reply = $(".intent-reply", tile);
    const who = $(".intent-who", tile);
    let typing = 0;
    let touched = false;
    const show = async (intent) => {
        const [said, answer, agent] = INTENTS[intent];
        note.textContent = said;
        who.textContent = agent;
        const mine = ++typing;
        if (reduceMotion.matches) {
            reply.textContent = answer;
            return;
        }
        reply.textContent = "";
        reply.classList.add("typing");
        await sleep(350);
        for (const word of answer.split(" ")) {
            if (mine !== typing) return;
            reply.textContent += (reply.textContent ? " " : "") + word;
            await sleep(45 + Math.random() * 50);
        }
        if (mine === typing) reply.classList.remove("typing");
    };
    const radios = $$("input[name=intent]", tile);
    for (const radio of radios)
        radio.addEventListener("change", () => {
            touched = true;
            show(radio.value);
        });
    // It cycles by itself while on screen, until someone picks one.
    let visible = false;
    whenVisible(tile, (v) => {
        visible = v;
    });
    if (!reduceMotion.matches)
        setInterval(() => {
            if (touched || !visible || document.hidden) return;
            const next = radios[(radios.findIndex((r) => r.checked) + 1) % radios.length];
            next.checked = true;
            show(next.value);
        }, 5200);
}

function initVariants() {
    const tile = $(".t-variants");
    if (!tile) return;
    const promo = $(".promo", tile);
    const result = $(".vresult", tile);
    const use = $(".vuse", tile);
    const tabs = $$(".vtabs [data-layout]", tile);
    roving(tabs, "aria-selected", (_i, button) => {
        promo.dataset.layout = button.dataset.layout;
        result.textContent = "";
        use.disabled = false;
    });
    use.addEventListener("click", () => {
        const chosen =
            tabs.find((t) => t.getAttribute("aria-selected") === "true")?.textContent ?? "Original";
        result.innerHTML = `Picked <b>${esc(chosen)}</b>. The agent keeps it, deletes the other versions and the markers, and commits one change.`;
        use.disabled = true;
    });
}

function highlightMarkdown(text) {
    return text
        .split("\n")
        .map((line) => {
            const safe = esc(line).replace(/`([^`]+)`/g, '<span class="md-c">`$1`</span>');
            if (/^#{1,3} /.test(line)) return `<span class="md-h">${safe}</span>`;
            return safe.replace(
                /^(\s*(?:- )?)([A-Z][\w ()/-]{1,28}:)(?= )/,
                '$1<span class="md-k">$2</span>'
            );
        })
        .join("\n");
}

function initMarkdown() {
    const tile = $(".t-md");
    const source = $("#md-samples");
    if (!tile || !source) return;
    let samples = {};
    try {
        samples = JSON.parse(source.textContent);
    } catch {
        samples = {};
    }
    const out = $(".md-out", tile);
    const code = $("code", out);
    const meta = $(".md-lines", tile);
    let detail = "detailed";
    const show = (name) => {
        detail = name;
        const text = samples[name] ?? "Build the site to see the samples (bun site/build.ts).";
        code.innerHTML = highlightMarkdown(text);
        out.scrollTop = 0;
        restart(out, "swap");
        const lines = text.split("\n").length;
        meta.textContent = `${name}: ${lines} line${lines === 1 ? "" : "s"}, ${text.length.toLocaleString()} characters`;
    };
    roving($$("[data-detail]", tile), "aria-selected", (_i, button) => show(button.dataset.detail));
    show(detail);
    $(".md-copy", tile).addEventListener("click", async (event) => {
        showCopied(event.currentTarget, await copyText(samples[detail] ?? ""));
    });
}

function initPause() {
    const tile = $(".t-pause");
    if (!tile) return;
    const stage = $(".pause-stage", tile);
    const button = $(".pause-btn", tile);
    const log = $(".pause-log code", tile);
    const setTrack = () => stage.style.setProperty("--track", `${stage.clientWidth}px`);
    setTrack();
    window.addEventListener("resize", setTrack);
    let frozen = [];
    const describe = (animation) => {
        const timing = animation.effect.getTiming();
        const duration = Number(timing.duration) || 0;
        const time = Number(animation.currentTime) || 0;
        const round = duration ? Math.floor(time / duration) : 0;
        let progress = duration ? (time % duration) / duration : 0;
        if (timing.direction === "alternate" && round % 2 === 1) progress = 1 - progress;
        const target = animation.effect.target;
        const easing = target
            ? getComputedStyle(target).animationTimingFunction.split(/,(?![^(]*\))/)[0]
            : timing.easing;
        const where = target?.classList[0] ? `.${target.classList[0]}` : "element";
        return `css ${animation.animationName ?? "animation"} ${duration}ms ${easing} (paused at ${Math.round(progress * 100)}%) on ${where}`;
    };
    button.addEventListener("click", () => {
        if (frozen.length) {
            for (const animation of frozen) animation.play();
            frozen = [];
            stage.classList.remove("frozen");
            button.textContent = "Pause animations";
            button.setAttribute("aria-pressed", "false");
            log.textContent = "Animations: running";
            return;
        }
        frozen = stage.getAnimations({ subtree: true }).filter((a) => a.playState === "running");
        for (const animation of frozen) animation.pause();
        stage.classList.add("frozen");
        button.textContent = "Resume";
        button.setAttribute("aria-pressed", "true");
        log.textContent = frozen.length
            ? `Animations:\n${frozen.map(describe).join("\n")}`
            : "No animations are running: your system asks for reduced motion.";
    });
}

function initRevert() {
    const tile = $(".t-revert");
    if (!tile) return;
    const button = $(".rv-btn", tile);
    const pin = $(".rv-pin", tile);
    const badge = $(".badge", tile);
    const body = $(".rv-body", tile);
    const form = $(".rv-form", tile);
    const action = $(".rv-action", tile);
    let state = "resolved";
    let timer;
    const set = (next) => {
        state = next;
        clearTimeout(timer);
        pin.dataset.status = next === "asking" ? "resolved" : next;
        restart(pin, "bump");
        form.hidden = next !== "asking";
        if (next === "resolved") {
            badge.dataset.v = "resolved";
            badge.textContent = statusLabel("resolved");
            body.textContent = "Made the pay button green and renamed it.";
            action.textContent = "Revert this change…";
            button.dataset.state = "go";
            button.textContent = "Place order · £12.40";
        } else if (next === "asking") {
            action.textContent = "Ask Codex to revert";
            $("#rv-reason").focus();
        } else if (next === "revert_requested") {
            badge.dataset.v = "revert_requested";
            badge.textContent = statusLabel("revert_requested");
            body.textContent = `“${$("#rv-reason").value || "Not what I wanted"}”. Waiting for Codex…`;
            action.textContent = "Cancel request";
            timer = setTimeout(() => set("reverted"), reduceMotion.matches ? 600 : 2200);
        } else if (next === "reverted") {
            badge.dataset.v = "reverted";
            badge.textContent = statusLabel("reverted");
            body.textContent = "Codex undid 3f9c2a1 in a71be04. The button is blue again.";
            action.textContent = "Start over";
            button.dataset.state = "blue";
            button.textContent = "Pay £12.40";
        }
    };
    action.addEventListener("click", () => {
        const next = {
            resolved: "asking",
            asking: "revert_requested",
            revert_requested: "resolved",
            reverted: "resolved",
        }[state];
        set(next);
    });
}

function initMention() {
    const tile = $(".t-mention");
    if (!tile) return;
    const thread = $(".m-thread", tile);
    const typed = $(".m-typed", tile);
    const input = $(".m-input", tile);
    const asideChip = $(".m-aside", tile);
    const play = $(".m-play", tile);
    const question = "Is this green from the theme or hard-coded?";
    const answer = "From the theme: tone “go” is --green-600, set in theme.ts:14.";
    const aside = "Sam, can you check it on Android too?";
    const message = (cls, who, html, tag) => {
        const p = document.createElement("p");
        p.className = `m-msg ${cls}`;
        p.innerHTML = `<b>${esc(who)}${tag ? ` <span class="m-tag">${esc(tag)}</span>` : ""}</b>${html}`;
        thread.append(p);
        return p;
    };
    const flag = (text, quiet = false) => {
        const f = document.createElement("span");
        f.className = quiet ? "m-flag quiet" : "m-flag";
        f.textContent = text;
        thread.append(f);
    };
    const base = () => {
        thread.replaceChildren();
        message("you", "Dom", "Make the pay button green");
        message("agent", "Copilot", "Done in 3f9c2a1. Resolved.");
    };
    const finished = () => {
        base();
        message("you", "Dom", esc(question));
        flag("↩ FOLLOW-UP");
        message("agent", "Copilot", esc(answer));
        message("you aside", "Dom", esc(aside), "Aside");
        flag("kept from the agent", true);
    };
    finished();
    let running = false;
    const typeOut = async (text, step) => {
        typed.textContent = "";
        input.classList.add("typing");
        for (const ch of text) {
            typed.append(ch);
            await step(30 + Math.random() * 35);
        }
        await step(500);
        typed.textContent = "";
        input.classList.remove("typing");
    };
    play.addEventListener("click", async () => {
        if (running) return;
        running = true;
        play.disabled = true;
        base();
        const step = (ms) => sleep(reduceMotion.matches ? 0 : ms);
        await step(400);
        await typeOut(question, step);
        message("you", "Dom", esc(question));
        await step(600);
        flag("↩ FOLLOW-UP");
        await step(1200);
        message("agent", "Copilot", esc(answer));
        await step(900);
        asideChip.dataset.on = "true";
        await step(500);
        await typeOut(aside, step);
        asideChip.dataset.on = "false";
        message("you aside", "Dom", esc(aside), "Aside");
        await step(500);
        flag("kept from the agent", true);
        running = false;
        play.disabled = false;
        play.lastChild.textContent = "Replay";
    });
}

function initMask() {
    const tile = $(".t-mask");
    if (!tile) return;
    const stage = $(".mask-stage", tile);
    $(".mask-toggle", tile).addEventListener("change", (event) => {
        stage.dataset.masked = String(event.currentTarget.checked);
    });
}

const FINDINGS = [
    ["Promo banner text is 1.9:1 against its background", "contrast · major"],
    ["The quantity stepper has no focus ring", "keyboard · minor"],
    ["The coupon field has no label", "accessibility · minor"],
    ["“Go” is a 28px tap target at phone width", "touch · minor"],
    ["Footer text is 10px, below the 12px floor", "type · nit"],
];

function initCritique() {
    const tile = $(".t-critique");
    if (!tile) return;
    const page = $(".crit-page", tile);
    const pins = $(".cp-pins", page);
    const list = $(".crit-list", tile);
    const run = $(".crit-run", tile);
    const cursor = $(".cp-cursor", page);
    const tag = $(".cp-tagline", page);
    const spots = FINDINGS.map((_, i) => $(`[data-c="${i}"]`, page));
    const point = (node) => {
        const a = page.getBoundingClientRect();
        const b = node.getBoundingClientRect();
        return { x: b.left - a.left + b.width * 0.7, y: b.top - a.top + b.height * 0.5 };
    };
    const file = (i) => {
        const spot = spots[i];
        const p = point(spot);
        const pin = document.createElement("span");
        pin.className = "cp-pin";
        pin.textContent = String(i + 1);
        pin.style.left = `${p.x + 6}px`;
        pin.style.top = `${p.y - 10}px`;
        pins.append(pin);
        const item = document.createElement("li");
        item.innerHTML = `<span>${esc(FINDINGS[i][0])} <small>${esc(FINDINGS[i][1])}</small></span>`;
        list.append(item);
    };
    const fill = () => {
        pins.replaceChildren();
        list.replaceChildren();
        FINDINGS.forEach((_, i) => {
            file(i);
        });
    };
    // At rest it shows what a run files; Run plays it out.
    requestAnimationFrame(fill);
    window.addEventListener("resize", () => {
        if (!page.classList.contains("running")) fill();
    });
    run.addEventListener("click", async () => {
        if (page.classList.contains("running")) return;
        run.disabled = true;
        pins.replaceChildren();
        list.replaceChildren();
        page.classList.add("running");
        const go = (x, y) => {
            for (const node of [cursor, tag]) {
                node.style.setProperty("--x", `${x}px`);
                node.style.setProperty("--y", `${y}px`);
            }
        };
        const a = page.getBoundingClientRect();
        go(a.width * 0.5, a.height * 0.9);
        const step = (ms) => sleep(reduceMotion.matches ? 0 : ms);
        await step(500);
        for (let i = 0; i < spots.length; i++) {
            const p = point(spots[i]);
            go(p.x, p.y);
            await step(700);
            spots[i].classList.add("found");
            await step(350);
            file(i);
            spots[i].classList.remove("found");
            await step(450);
        }
        page.classList.remove("running");
        run.disabled = false;
    });
}

/* ---------------------------------------------------------------- board */

const BOARD_START = [
    {
        n: 4,
        status: "open",
        text: "Basket total wraps onto two lines at 375px",
        by: "Priya",
        page: "/checkout",
        src: "<OrderSummary> · src/checkout/OrderSummary.tsx:27",
        thread: [["Priya", "Basket total wraps onto two lines at 375px"]],
    },
    {
        n: 3,
        status: "resolved",
        text: "Try a couple of other layouts for the basket",
        by: "Dom",
        page: "/checkout",
        src: "<Basket> · src/checkout/Basket.tsx:12",
        thread: [
            ["Dom", "Try a couple of other layouts for the basket"],
            ["Gemini", "Kept Cards in 8d41e07."],
        ],
    },
    {
        n: 2,
        status: "resolved",
        text: "Why is delivery £4.80 on a £7.60 basket?",
        by: "Dom",
        page: "/checkout",
        src: "<SummaryRow> · src/checkout/Summary.tsx:31",
        thread: [],
    },
    {
        n: 1,
        status: "resolved",
        text: "Make it green and say “Place order”",
        by: "Dom",
        page: "/checkout",
        src: "<PayButton> · src/checkout/PayButton.tsx:18",
        thread: [],
    },
];
const BOARD_INCOMING = [
    {
        n: 5,
        status: "open",
        text: "The coupon field has no label",
        by: "Gemini, via critique",
        page: "/checkout",
        src: "<CouponInput> · src/checkout/Coupon.tsx:8",
        thread: [["Gemini", "The coupon field has no label, so a screen reader says “edit text”."]],
    },
    {
        n: 6,
        status: "open",
        text: "Love the empty basket screen. Keep it",
        by: "Sam",
        page: "/basket",
        src: "<EmptyBasket> · src/basket/EmptyBasket.tsx:5",
        thread: [["Sam", "Love the empty basket screen. Keep it"]],
    },
    {
        n: 7,
        status: "open",
        text: "Delivery date shows in US format",
        by: "Priya",
        page: "/checkout",
        src: "<DeliverySlot> · src/checkout/DeliverySlot.tsx:19",
        thread: [["Priya", "Delivery date shows in US format"]],
    },
];

/** Who picks up the next note on the board: agents, and a developer working from the board. */
const PICKERS = [
    ["Codex", "Looking into it."],
    ["Sam", "I'll take this one."],
    ["Claude", "Looking into it."],
    ["Cursor", "On it."],
];

function initBoard() {
    const board = $(".board");
    if (!board) return;
    const list = $(".b-list", board);
    const title = $(".b-d-title", board);
    const src = $(".b-d-src", board);
    const thread = $(".b-thread", board);
    const counts = $$('[data-count="spudshop"]', board);
    const head = $(".b-d-head .badge", board);
    const num = $(".b-d-num", board);
    let notes = [];
    let selected = null;
    const renderThread = (note) => {
        thread.replaceChildren(
            ...note.thread.map(([who, text]) => {
                const p = document.createElement("p");
                if (AGENT_NAMES.has(who)) p.className = "agent";
                p.innerHTML = `<b>${esc(who)}</b>${esc(text)}`;
                return p;
            })
        );
    };
    const select = (note) => {
        selected = note;
        for (const item of $$(".b-item", list)) item.classList.toggle("on", item._note === note);
        title.textContent = note.text;
        head.dataset.v = note.status;
        head.textContent = statusLabel(note.status);
        num.textContent = `Note #${note.n} · ${note.by}`;
        src.textContent = `${note.page} · ${note.src}`;
        renderThread(note);
    };
    const item = (note, isNew) => {
        const li = document.createElement("li");
        li._note = note;
        li.className = "b-item";
        li.innerHTML = `<span class="b-row-top"><span class="b-dot" data-status="${note.status}"></span><span class="b-st">${statusLabel(note.status)}</span></span><b>${isNew ? '<i class="newdot"></i>' : ""}${esc(note.text)}</b><small>${esc(note.page)} · ${esc(note.by)}</small>`;
        if (!isNew) li.style.animation = "none";
        return li;
    };
    const todo = () =>
        notes.filter((n) => n.status === "open" || n.status === "acknowledged").length;
    const setCountTo = (n, bump) => {
        for (const count of counts) {
            count.textContent = String(n);
            if (bump) restart(count, "bump");
        }
    };
    const start = () => {
        notes = BOARD_START.map((n) => ({ ...n, thread: [...n.thread] }));
        list.replaceChildren(...notes.map((n) => item(n, false)));
        setCountTo(todo(), false);
        select(notes[0]);
    };
    start();
    if (reduceMotion.matches) return;

    let visible = false;
    whenVisible(board, (v) => {
        visible = v;
    });
    let next = 0;
    let picked = 0;
    const tick = async () => {
        if (!visible || document.hidden) return;
        if (next === BOARD_INCOMING.length) {
            next = 0;
            start();
            return;
        }
        // Someone picks up the one in view, an agent or a developer, then a new note arrives.
        if (selected && selected.status === "open") {
            const [who, says] = PICKERS[picked++ % PICKERS.length];
            selected.status = "acknowledged";
            selected.thread.push([who, says]);
            const row = $$(".b-item", list).find((li) => li._note === selected);
            const dot = row && $(".b-dot", row);
            if (dot) {
                dot.dataset.status = "acknowledged";
                $(".b-st", row).textContent = statusLabel("acknowledged");
                restart(dot, "bump");
            }
            head.dataset.v = "acknowledged";
            head.textContent = statusLabel("acknowledged");
            renderThread(selected);
            await sleep(1400);
        }
        const note = { ...BOARD_INCOMING[next++], thread: [...BOARD_INCOMING[next - 1].thread] };
        notes.unshift(note);
        list.prepend(item(note, true));
        setCountTo(todo(), true);
        select(note);
    };
    setInterval(tick, 3800);
}

const HOOK_EVENTS = [
    { event: "annotation.created", what: "created", status: "open" },
    { event: "annotation.acknowledged", what: "acknowledged", status: "acknowledged" },
    { event: "annotation.resolved", what: "resolved", status: "resolved" },
];

function initHooks() {
    const flow = $(".hooks-flow");
    if (!flow) return;
    const label = $(".h-event", flow);
    const dests = Object.fromEntries($$(".h-dest", flow).map((d) => [d.dataset.d, d]));
    const line = (what) =>
        `Notato · spudshop: annotation ${what} (minor) on /checkout — textbox “Coupon”: The coupon field has no label`;
    const fill = ({ event, what, status }) => {
        label.textContent = event;
        $(".h-msg", dests.slack).textContent = line(what);
        $(".h-msg", dests.discord).textContent = line(what);
        $(".h-msg", dests.teams).innerHTML =
            `<b>Note #5 ${esc(what)}</b><br>The coupon field has no label<small>spudshop · /checkout · ${esc(status)}</small>`;
        $(".h-msg", dests.json).textContent =
            `X-Notato-Event: ${event}\nX-Notato-Signature: sha256=9f2c…\n{ "event": "${event}", "project": "spudshop", … }`;
    };
    let index = 0;
    fill(HOOK_EVENTS[0]);
    if (reduceMotion.matches) return;
    let visible = false;
    whenVisible(flow, (v) => {
        visible = v;
    });
    setInterval(async () => {
        if (!visible || document.hidden) return;
        index = (index + 1) % HOOK_EVENTS.length;
        fill(HOOK_EVENTS[index]);
        restart(label, "bump");
        for (const dest of Object.values(dests)) {
            await sleep(160);
            restart(dest, "ping");
            setTimeout(() => dest.classList.remove("ping"), 900);
        }
    }, 3200);
}

/* ------------------------------------------------------------------ apps */

/** Each native SDK: how its app looks, and how a note about the Add button reaches the agent. */
const APPS = {
    swift: {
        os: "ios",
        title: "Button “Add Sweet potatoes”",
        where: "ProductRow · ProductList.swift:52",
        label: "ProductList.swift:52",
        receive: [
            ["mark", "#1 [change, minor] ProductList"],
            ["", "The Add button is too small to tap"],
            ["dim", 'Button “Add Sweet potatoes” in .notato("ProductRow")'],
            ["dim", "written at ShopSample/ProductList.swift:52"],
            ["dim", "VoiceOver: “Add Sweet potatoes, button”"],
            ["dim", "log: [Basket] price for sweet-1kg came from the cache"],
            ["out", "+ 2 screenshots"],
        ],
        file: "ShopSample/ProductList.swift",
        diff: [".controlSize(.mini)", ".controlSize(.large)"],
    },
    compose: {
        os: "android",
        title: "Button “Add”",
        where: "ProductRow · ShopScreens.kt:95",
        label: "ShopScreens.kt:95",
        receive: [
            ["mark", "#1 [change, minor] ShopScreen"],
            ["", "The Add button is too small to tap"],
            ["dim", "Button “Add” in ShopTheme › ShopScreen › ProductRow"],
            ["dim", "written at app/src/main/java/shop/ShopScreens.kt:95"],
            ["dim", "TalkBack: “Add Sweet potatoes, Button”"],
            ["dim", "logcat W/Basket: price for sweet-1kg came from the cache"],
            ["out", "+ 2 screenshots"],
        ],
        file: "app/src/main/java/shop/ShopScreens.kt",
        diff: ["Modifier.height(28.dp)", "Modifier.heightIn(min = 48.dp)"],
    },
    maui: {
        os: "maui",
        title: "Button “Add”",
        where: "ProductsPage · Views/ProductsPage.xaml:42",
        label: "Views/ProductsPage.xaml:42",
        receive: [
            ["mark", "#1 [change, minor] ProductsPage"],
            ["", "The Add button is too small to tap"],
            ["dim", "Button “Add” on ProductsPage, view model ProductsViewModel"],
            ["dim", "written at Shop/Views/ProductsPage.xaml:42"],
            ["dim", "log: [Basket] price for sweet-1kg came from the cache"],
            ["out", "+ 2 screenshots"],
        ],
        file: "Shop/Views/ProductsPage.xaml",
        diff: ['HeightRequest="28"', 'MinimumHeightRequest="48"'],
    },
};

function initApps() {
    const root = $(".apps");
    if (!root) return;
    const phone = $(".phone", root);
    const screen = $(".ph-screen", root);
    const el = {
        add: $("[data-ph=add]", screen),
        sel: $(".ph-sel", screen),
        src: $(".ph-src", screen),
        pin: $(".ph-pin", screen),
        annotate: $(".pb-annotate", screen),
        count: $(".pb-count", screen),
        sheet: $(".ph-sheet", screen),
        title: $(".ps-title", screen),
        sub: $(".ps-sub", screen),
        field: $(".ps-field", screen),
        typed: $(".ps-typed", screen),
        change: $("[data-chip=change]", screen),
        minor: $("[data-chip=minor]", screen),
        send: $(".ps-send", screen),
        toast: $(".ph-toast", screen),
        finger: $(".ph-finger", screen),
        log: $(".ag-log", root),
    };

    let token = 0;
    let offscreen = false;
    whenVisible(root, (visible) => {
        offscreen = !visible;
    });
    const rel = (node) => {
        const a = screen.getBoundingClientRect();
        const b = node.getBoundingClientRect();
        return { x: b.left - a.left, y: b.top - a.top, w: b.width, h: b.height };
    };
    const line = (cls, html) => {
        const p = document.createElement("p");
        p.className = cls;
        p.innerHTML = html;
        el.log.append(p);
        // Newest at the bottom, like a terminal: the oldest lines scroll away.
        while (el.log.scrollHeight > el.log.clientHeight && el.log.children.length > 1)
            el.log.firstElementChild.remove();
        return p;
    };
    const frameOn = (box, node, pad = 3) => {
        const b = rel(node);
        box.style.left = `${b.x - pad}px`;
        box.style.top = `${b.y - pad}px`;
        box.style.width = `${b.w + pad * 2}px`;
        box.style.height = `${b.h + pad * 2}px`;
        box.classList.add("on");
    };
    const placePin = () => {
        const b = rel(el.add);
        el.pin.style.left = `${b.x + b.w + 2}px`;
        el.pin.style.top = `${b.y + 1}px`;
    };
    const setPin = (status) => {
        el.pin.dataset.status = status;
        restart(el.pin, "bump");
    };

    const reset = (app) => {
        phone.dataset.os = app.os;
        el.add.classList.remove("big");
        for (const node of [el.sel, el.src, el.annotate, el.sheet, el.toast, el.finger, el.field]) {
            node.classList.remove("on", "open", "focus");
        }
        for (const chip of [el.change, el.minor]) chip.classList.remove("on");
        el.pin.hidden = true;
        el.pin.dataset.status = "open";
        el.count.textContent = "0";
        el.typed.textContent = "";
        el.log.replaceChildren();
    };

    async function play(key) {
        const mine = ++token;
        const app = APPS[key];
        const fast = reduceMotion.matches;
        const wait = async (ms) => {
            if (mine !== token) throw new Cancelled();
            if (fast) return;
            let left = ms;
            while (left > 0) {
                const step = Math.min(left, 50);
                await sleep(step);
                if (mine !== token) throw new Cancelled();
                if (!offscreen && !document.hidden) left -= step;
            }
        };
        const moveTo = async (node) => {
            const b = rel(node);
            el.finger.style.setProperty("--ms", fast ? "0ms" : "650ms");
            el.finger.style.setProperty("--x", `${b.x + b.w * 0.55}px`);
            el.finger.style.setProperty("--y", `${b.y + b.h * 0.6}px`);
            await wait(700);
        };
        const tap = async (node) => {
            await moveTo(node);
            el.finger.classList.add("down");
            await wait(160);
            el.finger.classList.remove("down");
            await wait(120);
        };
        phone.classList.toggle("instant", fast);
        try {
            for (;;) {
                reset(app);
                line("tool", "<b>notato_watch</b>()");
                const waiting = line("out", "⎿ Waiting for notes…");
                await wait(900);
                el.finger.style.setProperty("--ms", "0ms");
                el.finger.classList.add("on");
                await tap(el.annotate);
                el.annotate.classList.add("on");
                await tap(el.add);
                frameOn(el.sel, el.add);
                el.src.textContent = app.where;
                const b = rel(el.add);
                el.src.style.left = `${Math.max(8, b.x + b.w - 250)}px`;
                el.src.style.top = `${b.y - 24}px`;
                el.src.classList.add("on");
                await wait(500);
                el.title.textContent = app.title;
                el.sub.textContent = app.where;
                el.sheet.classList.add("open");
                await wait(600);
                await tap(el.field);
                el.field.classList.add("focus");
                if (fast) el.typed.textContent = "The Add button is too small to tap";
                else
                    for (const ch of "The Add button is too small to tap") {
                        el.typed.textContent += ch;
                        await wait(34 + Math.random() * 34);
                    }
                await tap(el.change);
                el.change.classList.add("on");
                el.minor.classList.add("on");
                await tap(el.send);
                el.sheet.classList.remove("open");
                el.field.classList.remove("focus");
                el.sel.classList.remove("on");
                el.src.classList.remove("on");
                el.annotate.classList.remove("on");
                el.finger.classList.remove("on");
                placePin();
                el.pin.hidden = false;
                el.count.textContent = "1";
                restart(el.count, "bump");
                el.toast.classList.add("on");
                await wait(500);
                waiting.textContent = "⎿ 1 note from Dom";
                for (const [cls, text] of app.receive) {
                    line(cls, esc(text));
                    await wait(110);
                }
                await wait(500);
                el.toast.classList.remove("on");
                await wait(500);
                line("tool", "<b>notato_acknowledge</b>(#1)");
                setPin("acknowledged");
                await wait(900);
                line("tool", `<b>edit</b>(${esc(app.file)})`);
                line("del", `- ${esc(app.diff[0])}`);
                line("add", `+ ${esc(app.diff[1])}`);
                await wait(1000);
                el.add.classList.add("big");
                if (!fast) restart(el.add, "flash");
                await wait(550);
                placePin();
                line("tool", '<b>git commit</b> -m "Bigger Add button (Notato #1)"');
                await wait(800);
                line("tool", "<b>notato_resolve</b>(#1)");
                line("ok", "⎿ Resolved");
                setPin("resolved");
                if (fast) return;
                await wait(4200);
            }
        } catch (error) {
            if (!(error instanceof Cancelled)) throw error;
        }
    }

    const tabs = $$(".app-tabs [role=tab]", root);
    roving(tabs, "aria-selected", (_i, tab) => {
        for (const t of tabs) $(`#${t.getAttribute("aria-controls")}`).hidden = t !== tab;
        void play(tab.dataset.app);
    });
    const fontsReady = document.fonts?.ready ?? Promise.resolve();
    Promise.race([fontsReady, sleep(1500)]).then(() => play("swift"));
}

/* ------------------------------------------------------------- platforms */

function initPlatforms() {
    const root = $(".plat");
    if (!root) return;
    const device = $(".device", root);
    const label = $(".dv-src", device);
    const url = $(".dv-url", device);
    const tabs = $$('[role="tab"]', $(".plat-tabs", root));
    const show = (tab) => {
        for (const t of tabs) $(`#${t.getAttribute("aria-controls")}`).hidden = t !== tab;
        const panel = $(`#${tab.getAttribute("aria-controls")}`);
        device.dataset.kind = panel.dataset.device;
        url.textContent =
            panel.dataset.device === "extension" ? "app.example.com" : "localhost:5173";
        label.textContent = panel.dataset.src;
        restart(label, "dv-src");
    };
    roving(tabs, "aria-selected", (_i, tab) => show(tab));
    show(tabs[0]);
}

/* ---------------------------------------------------------------- try it */

function initTry() {
    const button = $(".try-btn");
    if (!button) return;
    const status = $(".try-status");
    let live = null;
    button.addEventListener("click", async () => {
        if (live) {
            live.setAnnotateMode(true);
            status.textContent = "Now click anything on the page";
            return;
        }
        button.disabled = true;
        button.textContent = "Loading…";
        try {
            const mod = await import("./live.js");
            live = mod.start();
            button.textContent = "Start annotating";
            status.textContent = "Notato is on. It's at the bottom right";
        } catch (error) {
            console.error(error);
            button.textContent = "Put Notato on this page";
            status.textContent = "It didn't load. Reload the page and try again";
        } finally {
            button.disabled = false;
        }
    });
}

/* ------------------------------------------------------------------ keys */

/** Key names as this keyboard has them: on a Mac, Alt is the Option key (⌥) and Ctrl is Command (⌘). */
function initKeys() {
    const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
    if (!mac) return;
    const names = { alt: "⌥ Option", shift: "⇧ Shift", mod: "⌘ Cmd" };
    for (const key of $$("kbd[data-key]"))
        key.textContent = names[key.dataset.key] ?? key.textContent;
    for (const text of $$("[data-key-text='mod-click']")) text.textContent = "Cmd-click";
}

/* ------------------------------------------------------------- headline */

/** Who fixes it: the agents Notato works with, and people too. */
const FIXERS = ["Your agent", "Claude", "Codex", "Cursor", "Gemini", "Copilot", "A developer"];

function initFixers() {
    const slot = $(".who-slot");
    const word = $(".who-word", slot ?? document);
    if (!slot || !word || reduceMotion.matches) return;
    const light = (name) => {
        // The agent named in the headline lights up in the list of agents further down.
        for (const card of $$(".agent-card[data-agent]"))
            card.classList.toggle("lit", card.dataset.agent === name);
    };
    // Like someone editing the headline: select the name, type the next one over it, leave it a while.
    const run = async () => {
        for (let index = 0; ; ) {
            await sleep(2600);
            while (document.hidden) await sleep(500);
            index = (index + 1) % FIXERS.length;
            const name = FIXERS[index];
            slot.classList.add("selected");
            await sleep(420);
            slot.classList.remove("selected");
            slot.classList.add("typing");
            word.textContent = "";
            light(name);
            for (const ch of name) {
                word.textContent += ch;
                await sleep(60 + Math.random() * 50);
            }
            await sleep(900);
            slot.classList.remove("typing");
        }
    };
    void run();
}

/* --------------------------------------------------------------- potato */

const PUNS = [
    "Mash it!",
    "Ship it",
    "Looks a-peeling",
    "Spud-tacular",
    "Hash it out",
    "Chip chip hooray",
    "Fry harder",
    "Jacket required",
    "Tater-ly done",
    "Smashing",
];

function initPotato() {
    const potato = $(".potato");
    if (!potato) return;
    let i = 0;
    potato.addEventListener("click", () => {
        restart(potato, "boop");
        const note = document.createElement("span");
        note.className = "pun";
        note.textContent = PUNS[i++ % PUNS.length];
        note.style.setProperty("--drift", `${Math.round(Math.random() * 120 - 60)}px`);
        note.style.setProperty("--spin", `${Math.round(Math.random() * 28 - 14)}deg`);
        potato.append(note);
        setTimeout(() => note.remove(), 1900);
    });
}

/* ------------------------------------------------------------------ boot */

for (const node of $$("code[data-lang]")) highlight(node);
initCopy();
initStage();
initIntents();
initVariants();
initMarkdown();
initPause();
initRevert();
initMention();
initMask();
initCritique();
initBoard();
initHooks();
initPlatforms();
initApps();
initTry();
initPotato();
initFixers();
initKeys();
