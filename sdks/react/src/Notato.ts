import type { NotatoController, NotatoProps } from "@notato/browser";
import { useEffect, useRef } from "react";

/**
 * Bundlers replace `process.env.NODE_ENV` at build time. Without a bundler `process` does not exist in
 * the browser, so the lookup throws and the page counts as development.
 */
function isProduction(): boolean {
    try {
        return process.env.NODE_ENV === "production";
    } catch {
        return false;
    }
}

/**
 * What the toolbar is started with that, changed, starts it again: every prop but `plugins` and `transport`, which are
 * read as it starts (change them by remounting, with a `key`), and `enabled`. Props are compared by value and in any
 * order, so an array written inline does not restart the toolbar on every render.
 */
export function startKey(props: NotatoProps): string {
    const { plugins: _plugins, transport: _transport, enabled: _enabled, ...plain } = props;
    return JSON.stringify(
        Object.entries(plain)
            .filter(([, value]) => value !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : 1))
    );
}

type Load = () => Promise<{ createController(props: NotatoProps): NotatoController }>;

/** Loads the toolbar and starts it, unless stopped before it has loaded. Returns how to stop it. */
export function startToolbar(load: Load, props: () => NotatoProps): () => void {
    let stopped = false;
    let controller: NotatoController | undefined;
    load()
        .then(({ createController }) => {
            if (!stopped) controller = createController(props());
        })
        .catch((error: unknown) => console.warn("[notato] the toolbar could not start", error));
    return () => {
        stopped = true;
        controller?.destroy();
    };
}

/**
 * Renders nothing. In production builds it does nothing at all unless `enabled` is set: the toolbar,
 * plugins and screenshot code live behind a dynamic import that is only requested when enabled.
 */
export function Notato(props: NotatoProps): null {
    const enabled = props.enabled ?? !isProduction();
    const latest = useRef(props);
    // After render, never during it: React may render and throw the result away.
    useEffect(() => {
        latest.current = props;
    });
    const key = startKey(props);

    // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the props that restart the toolbar; the rest are read from `latest` as it starts.
    useEffect(() => {
        if (!enabled) return;
        return startToolbar(
            () => import("@notato/browser"),
            () => latest.current
        );
    }, [enabled, key]);

    return null;
}
