// @vitest-environment happy-dom
import type { CapturePlugin, DraftAnnotation } from "@notato/core";
import type { AgentStep } from "@notato/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onHistoryChange } from "../src/history.ts";
import { addServer } from "../src/net.ts";
import { accessibleName, domIdentityPlugin, visibleText } from "../src/plugins/identity-dom.ts";
import { networkPlugin } from "../src/plugins/network.ts";
import { maskClone, maskRects, shouldMask } from "../src/plugins/screenshot.ts";
import { stepsPlugin } from "../src/plugins/steps.ts";
import { redactUrl } from "../src/url.ts";

const teardowns: Array<() => void> = [];
afterEach(() => {
    for (const t of teardowns.splice(0).reverse()) t();
    document.body.innerHTML = "";
});

describe("redactUrl", () => {
    it.each([
        [
            "OAuth's code and state",
            "http://localhost:5173/callback?code=4%2F0AbCdEf&state=xyz123&tab=settings",
            "http://localhost:5173/callback?code=redacted&state=redacted&tab=settings",
        ],
        [
            "an implicit-flow fragment",
            "https://app.example/#access_token=ya29.a0Af&token_type=Bearer&expires_in=3599",
            "https://app.example/#access_token=redacted&token_type=redacted&expires_in=3599",
        ],
        [
            "a reset token in a hash route",
            "https://app.example/#/reset?token=abc&step=2",
            "https://app.example/#/reset?token=redacted&step=2",
        ],
        [
            "names written every way",
            "https://x.test/p?accessToken=1&api_key=2&X-Amz-Signature=3&client_secret=4&sessionId=5&SAMLResponse=6&page=7",
            "https://x.test/p?accessToken=redacted&api_key=redacted&X-Amz-Signature=redacted&client_secret=redacted&sessionId=redacted&SAMLResponse=redacted&page=7",
        ],
        [
            "a token whatever it is called",
            "https://x.test/p?ref=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc&id=42",
            "https://x.test/p?ref=redacted&id=42",
        ],
        [
            "a long opaque value",
            "https://x.test/p?invite=8f14e45fceea167a5a36dedd4bea2543aa&q=red%20shoes",
            "https://x.test/p?invite=redacted&q=red%20shoes",
        ],
        ["a login in the URL", "https://dom:hunter2@x.test/p", "https://x.test/p"],
    ])("blanks %s", (_what, input, output) => expect(redactUrl(input)).toBe(output));

    it.each([
        "http://localhost:5173/settings?tab=profile&sort=desc&page=2",
        "http://localhost:5173/docs#installation",
        "http://localhost:5173/#/orders/42",
        "http://localhost:5173/search?q=author%3Adom&keyword=monkey",
        "http://localhost:5173/",
    ])("leaves %s as it is", (url) => expect(redactUrl(url)).toBe(url));
});

describe("the URL a note records", () => {
    it("has secrets blanked from the steps an agent's note says it took", async () => {
        const plugin = stepsPlugin();
        teardowns.push(plugin.setup?.() as () => void);
        window.history.pushState({}, "", "/callback#access_token=secret-value&state=s1");
        window.history.pushState({}, "", "/orders#summary");
        const steps = ((await plugin.capture({} as DraftAnnotation))?.steps ?? []) as AgentStep[];
        expect(steps.map((s) => s.value)).toEqual([
            "/callback#access_token=redacted&state=redacted",
            "/orders#summary",
        ]);
        expect(JSON.stringify(steps)).not.toContain("secret-value");
    });
});

describe("history, watched by more than one part of Notato", () => {
    it("is patched once, tells each listener, and is put back whichever stops first", () => {
        const { pushState, replaceState } = window.history;
        const a = vi.fn();
        const b = vi.fn();
        const stopA = onHistoryChange(a);
        const stopB = onHistoryChange(b);
        window.history.pushState({}, "", "/one");
        expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 1]);
        stopA(); // the first to start stops first: the other still hears
        window.history.replaceState({}, "", "/two");
        expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 2]);
        stopB();
        expect(window.history.pushState).toBe(pushState);
        expect(window.history.replaceState).toBe(replaceState);
    });

    it("leaves a wrapper the page put on top of it in place", () => {
        const original = window.history.pushState;
        const stop = onHistoryChange(() => {});
        const ours = window.history.pushState;
        const theirs = vi.fn(function (this: History, ...args: Parameters<History["pushState"]>) {
            return ours.apply(this, args);
        });
        window.history.pushState = theirs;
        stop();
        expect(window.history.pushState).toBe(theirs);
        // listening again reuses ours, still in the chain, rather than adding a second
        const heard = vi.fn();
        const again = onHistoryChange(heard);
        window.history.pushState({}, "", "/three");
        expect(heard).toHaveBeenCalledTimes(1);
        again();
        window.history.pushState = original;
    });
});

describe("regions people type into that are not form fields", () => {
    const mount = (html: string) => {
        document.body.innerHTML = html;
    };
    const $ = (selector: string) => document.querySelector(selector) as HTMLElement;

    it("never have their contents recorded as an element's text or name", () => {
        mount(`
            <section id="chat">
              <h2>Messages</h2>
              <div contenteditable="true" aria-label="Message" id="box">Meet me at <a href="/x">the flat</a> at 9</div>
              <div role="textbox" id="rich">my secret draft</div>
            </section>`);
        const identity = domIdentityPlugin();
        expect(visibleText($("#box"))).toBeUndefined();
        expect(accessibleName($("#box"))).toBe("Message"); // its label is not what was typed
        expect(visibleText($("#rich"))).toBeUndefined();
        expect(accessibleName($("#box a"))).toBeUndefined(); // a link inside is still the person's writing
        expect(visibleText($("#box a"))).toBeUndefined();
        const around = JSON.stringify(identity.resolve($("#chat")));
        expect(around).toContain("Messages");
        expect(around).not.toContain("the flat");
        expect(around).not.toContain("secret draft");
    });

    it("leaves a region switched off with contenteditable=false alone", () => {
        mount(`<div contenteditable="false" id="plain">Shipping address</div>`);
        expect(visibleText($("#plain"))).toBe("Shipping address");
    });

    it("are covered in screenshots wherever fields are", () => {
        const el = (html: string) => {
            const host = document.createElement("div");
            host.innerHTML = html;
            return host.firstElementChild as HTMLElement;
        };
        const editor = el('<div contenteditable="">Dear Sam, <b>private</b></div>');
        expect(shouldMask(editor, true)).toBe(true);
        expect(shouldMask(editor, false)).toBe(false); // dev mode, as for an input
        expect(shouldMask(el('<div role="textbox">x</div>'), true)).toBe(true);
        expect(shouldMask(el('<div contenteditable="false">x</div>'), true)).toBe(false);
        maskClone(editor, true);
        expect(editor.textContent).toBe("");
    });
});

describe("blocking out fields on a screenshot a driver supplied", () => {
    /** A canvas that records the boxes painted on it. */
    const canvas = () => {
        const boxes: number[][] = [];
        const ctx = {
            fillStyle: "",
            fillRect: (...box: number[]) => boxes.push(box),
        };
        return { canvas: { getContext: () => ctx } as unknown as HTMLCanvasElement, boxes };
    };
    const at = (el: Element, left: number, top: number) => {
        el.getBoundingClientRect = () =>
            ({ left, top, width: 50, height: 20, right: left + 50, bottom: top + 20 }) as DOMRect;
    };

    it("finds them inside shadow roots and same-origin frames too", () => {
        const plain = document.createElement("input");
        at(plain, 10, 10);
        const host = document.createElement("div");
        const shadow = host.attachShadow({ mode: "open" });
        const inShadow = document.createElement("input");
        at(inShadow, 100, 10);
        const editor = document.createElement("div");
        editor.setAttribute("contenteditable", "");
        at(editor, 200, 10);
        shadow.append(inShadow, editor);
        const frame = document.createElement("iframe");
        document.body.append(plain, host, frame);
        const inFrame = frame.contentDocument?.createElement("textarea") as HTMLTextAreaElement;
        frame.contentDocument?.body.append(inFrame);
        at(inFrame, 300, 10);

        const { canvas: c, boxes } = canvas();
        maskRects(c, 1, true);
        expect(boxes.map(([x]) => x).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
            10, 100, 200, 300,
        ]);
    });
});

describe("the network plugin and Notato's own server", () => {
    it("leaves out the requests the SDK makes to its server", async () => {
        const realFetch = window.fetch;
        window.fetch = (async () => new Response("ok")) as unknown as typeof fetch;
        teardowns.push(() => {
            window.fetch = realFetch;
        });
        teardowns.push(addServer("http://localhost:4801/"));
        const plugin: CapturePlugin = networkPlugin();
        teardowns.push(plugin.setup?.() as () => void);
        await window.fetch("http://localhost:4801/projects/p/annotations");
        await window.fetch("http://localhost:5173/api/orders");
        const network = (await plugin.capture({} as DraftAnnotation))?.context?.network as Array<{
            url: string;
        }>;
        expect(network.map((e) => e.url)).toEqual(["http://localhost:5173/api/orders"]);
    });

    it("records a request object that is opened and sent again once per send", async () => {
        const proto = XMLHttpRequest.prototype;
        const { open, send } = proto;
        // No real requests: what matters is what the plugin hears when each one ends.
        proto.open = () => {};
        proto.send = () => {};
        teardowns.push(() => {
            proto.open = open;
            proto.send = send;
        });
        const plugin: CapturePlugin = networkPlugin();
        teardowns.push(plugin.setup?.() as () => void);
        const xhr = new XMLHttpRequest();
        for (const path of ["/a", "/b"]) {
            xhr.open("GET", `http://localhost:5173${path}`);
            xhr.send();
            xhr.dispatchEvent(new Event("loadend"));
        }
        const network = (await plugin.capture({} as DraftAnnotation))?.context?.network as Array<{
            url: string;
        }>;
        expect(network.map((e) => e.url)).toEqual([
            "http://localhost:5173/a",
            "http://localhost:5173/b",
        ]);
    });
});
