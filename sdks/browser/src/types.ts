import type { CapturePlugin, IdentityPlugin, SinkPlugin } from "@notato/core";
import type { AgentStep, Annotation, Intent, Mode, Severity } from "@notato/schema";
import type { Transport } from "./net.ts";
import type { ToolbarPosition } from "./ui/toolbar.ts";
import type { VariantGroupInfo } from "./ui/variants.ts";

/** A plugin may implement more than one role; it is wired into every role it implements. */
export type NotatoPlugin = IdentityPlugin | CapturePlugin | SinkPlugin;

export interface NotatoProps {
    /** `dev` annotates live to a local server, `test` exports bundles, `agent` is driven by an AI agent. */
    mode?: Mode;
    /**
     * Server base URL, e.g. `http://localhost:4747`. Annotations are posted there and its status changes come
     * back live. Omit it in test mode to export zips only.
     */
    server?: string;
    project: string;
    appName?: string;
    appVersion?: string;
    /** Extra plugins. One with the same `id` as a built-in replaces it. Memoise this array. */
    plugins?: NotatoPlugin[];
    /** Defaults to off in production builds. Set it explicitly to run in production. */
    enabled?: boolean;
    /** Include `location.hash` in routes, for hash-routed apps. */
    hashRoutes?: boolean;
    /** Attributes checked, in order, for a test id. Defaults to data-testid, data-qa, data-cy, data-test. */
    testIdAttributes?: string[];
    /**
     * Mask what is typed in screenshots: input, textarea and select values, and regions people type into
     * (`contenteditable`, `role="textbox"`). Defaults to true in test and agent mode.
     */
    maskInputs?: boolean;
    /** Record each element's computed styles (colours, type, spacing, size). Defaults to true. */
    styles?: boolean;
    /**
     * Take a screenshot with each annotation. Defaults to true. Set false to never take one from this page. A server
     * can also turn them off for everyone (`notato config set screenshots off`), and that wins over this.
     */
    screenshots?: boolean;
    /** Toggles annotate mode. Matched on `event.code`. Defaults to `Alt+Shift+KeyA`. */
    shortcut?: string;
    /**
     * The corner the toolbar starts in. Defaults to `bottom-right`. People can drag it anywhere (by any part of it, or
     * with the arrow keys on its grip); that is remembered in this browser, and double-clicking the grip puts it back.
     */
    position?: ToolbarPosition;
    /**
     * Project token for a shared server (`notato serve`). It is visible to anyone who can read the page, so
     * issue one per project and revoke it when the testing ends. Not needed for `notato dev`.
     */
    token?: string;
    /** Name recorded on annotations made by a person. Testers can also enter it when packaging. */
    author?: string;
    /** Keep annotations across reloads in this browser. Defaults to on in test and agent mode. */
    persist?: boolean;
    /**
     * How requests reach the server, for a host that cannot let the page do it (the browser extension). Leave it out
     * and the page's own `fetch` and `EventSource` are used.
     */
    transport?: Partial<Transport>;
    /**
     * For a page whose Content-Security-Policy allows styles only with a nonce. Notato's styles are constructed
     * stylesheets, which such a policy allows anyway; a browser too old for those gets `<style>` elements, which carry
     * this nonce.
     */
    nonce?: string;
}

export interface AnnotateArgs {
    /**
     * An element, or a selector. A selector can reach inside iframes and shadow roots with `>>>`: `iframe#preview >>>
     * button.pay`, or `my-widget >>> .inner`.
     */
    target: string | Element;
    comment: string;
    severity?: Severity;
    /** `fix`, `change`, `question` (an answer is wanted, not an edit) or `approve` (it is right as it is). */
    intent?: Intent;
    /** What the agent did to get here. When omitted in agent mode, the steps seen in the page are used. */
    steps?: AgentStep[];
    /**
     * A real screenshot of the viewport as base64 (or a `data:` URL), PNG, WebP or JPEG, for example from CDP
     * `Page.captureScreenshot` or Playwright's `page.screenshot()`. Used instead of the in-page render; the
     * target is outlined on it and sensitive fields are blocked out. Take it right before calling.
     */
    screenshot?: string;
    /** Name recorded as the agent's. */
    author?: string;
}

/** What `window.__notato.package()` returns: JSON-friendly, so a browser-driving agent can read it. */
export interface PackagedBundle {
    bundleId: string;
    filename: string;
    annotations: number;
    /** The zip, base64-encoded. */
    zipBase64: string;
    /** One entry per sink the bundle was handed to; empty unless `send` was set. */
    delivery: Array<{ sink: string; ok: boolean; error?: string }>;
}

/** The shape of `window.__notato`. */
export interface NotatoApi {
    version: 1;
    annotate(args: AnnotateArgs): Promise<Annotation>;
    list(): Annotation[];
    /**
     * Builds the bundle zip from every annotation on the page. With `send: true` it is also delivered to the
     * configured sinks (download in test mode, upload when a server is set).
     */
    package(options?: { send?: boolean; name?: string }): Promise<PackagedBundle>;
    /**
     * The versions an agent has put in the page for a Variants request: elements marked `data-notato-variant` (the
     * group) and `data-notato-variant-name` (the version). For a driver to look at each one before saying they are ready.
     */
    variants: {
        /** Every group with two or more versions, and which one is showing. */
        list(): VariantGroupInfo[];
        /** Shows a version. False when there is no such group or version. */
        select(group: string, name: string): boolean;
    };
}

declare global {
    interface Window {
        __notato?: NotatoApi;
        /** Lets a remounted controller (HMR, StrictMode) tear down its predecessor. */
        __notatoDestroy?: () => void;
    }
}
