import type { CapturePlugin } from "@notato/core";
import type { AgentStep } from "@notato/schema";
import { ROOT_ATTR } from "../attributes.ts";
import { onHistoryChange } from "../history.ts";
import { redactUrl } from "../url.ts";
import { DEFAULT_TEST_ID_ATTRIBUTES, uniqueSelector } from "./identity-dom.ts";

export interface StepsOptions {
    /** Steps kept between annotations. */
    limit?: number;
    testIdAttributes?: string[];
}

type Draft = Omit<AgentStep, "at">;

/**
 * Records what happened in the page since the last annotation (clicks, field edits, submits and route
 * changes) so an annotation filed by an agent says how it got there. Input values are never recorded.
 *
 * Steps the agent passes to `annotate` take precedence; this only fills in when it passed none.
 */
export function stepsPlugin(options: StepsOptions = {}): CapturePlugin {
    const limit = options.limit ?? 30;
    const attrs = options.testIdAttributes ?? DEFAULT_TEST_ID_ATTRIBUTES;
    const buffer: AgentStep[] = [];

    const push = (step: Draft) => {
        buffer.push({ ...step, at: new Date().toISOString() });
        if (buffer.length > limit) buffer.shift();
    };
    const fromUi = (ev: Event) =>
        ev.composedPath().some((node) => node instanceof Element && node.hasAttribute(ROOT_ATTR));
    const selectorOf = (ev: Event): string | undefined => {
        const el = ev.composedPath()[0];
        if (!(el instanceof Element)) return undefined;
        try {
            return uniqueSelector(el, attrs);
        } catch {
            return el.tagName.toLowerCase();
        }
    };
    const record = (action: string) => (ev: Event) => {
        if (fromUi(ev)) return;
        push({ action, target: selectorOf(ev) });
    };

    return {
        id: "steps",
        setup() {
            const click = record("click");
            const change = (ev: Event) => {
                if (fromUi(ev)) return;
                const el = ev.target;
                const action =
                    el instanceof HTMLInputElement &&
                    (el.type === "checkbox" || el.type === "radio")
                        ? "toggle"
                        : el instanceof HTMLSelectElement
                          ? "select"
                          : "input";
                push({ action, target: selectorOf(ev) });
            };
            const submit = record("submit");
            // A fragment can carry a token (`#access_token=…`): recorded as a note's URL is.
            const navigated = () =>
                push({
                    action: "navigate",
                    value: redactUrl(`${location.pathname}${location.hash}`),
                });
            window.addEventListener("click", click, true);
            window.addEventListener("change", change, true);
            window.addEventListener("submit", submit, true);
            window.addEventListener("popstate", navigated);
            window.addEventListener("hashchange", navigated);
            const stopHistory = onHistoryChange(navigated);
            return () => {
                window.removeEventListener("click", click, true);
                window.removeEventListener("change", change, true);
                window.removeEventListener("submit", submit, true);
                window.removeEventListener("popstate", navigated);
                window.removeEventListener("hashchange", navigated);
                stopHistory();
            };
        },
        async capture(draft) {
            const mine = buffer.splice(0);
            if (draft.steps?.length || mine.length === 0) return undefined;
            return { steps: mine };
        },
    };
}
