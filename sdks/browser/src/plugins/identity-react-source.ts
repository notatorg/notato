import type { IdentityPlugin } from "@notato/core";
import { cachedSourceMap, originalPosition, warmSourceMap } from "./sourcemap.ts";

/** The slice of a React fiber we read. Only present in development builds; every field is optional. */
interface Fiber {
    type?: unknown;
    return?: Fiber | null;
    _debugOwner?: Fiber | null;
    _debugSource?: { fileName?: string; lineNumber?: number; columnNumber?: number } | null;
    _debugStack?: { stack?: string } | null;
}

/** A stack frame as the browser reported it: positions are 1-based, in the served (transformed) module. */
export interface Frame {
    url: string;
    line: number;
    col: number;
}

/** Frames from these are React's own JSX runtime or dependency pre-bundles, never the app's source. */
const INTERNAL_FRAME =
    /react-jsx|jsx-dev-runtime|jsx-runtime|react\.development|react-dom|\/node_modules\/|\.vite\/deps|chunk-[A-Z0-9]+/;

/** Source maps are fetched with the real `fetch`, captured before any network plugin patches it. */
const nativeFetch = typeof window !== "undefined" ? window.fetch.bind(window) : undefined;
const PREPARE_TIMEOUT_MS = 1500;

/**
 * Reads React dev-build fiber metadata for the component name and source location. Best effort: in a
 * production build, or with a React that exposes neither `_debugSource` nor `_debugStack`, it returns
 * nothing, and it never throws.
 *
 * React 19 only exposes a stack trace, whose positions are in the dev server's transformed module. `prepare`
 * loads that module's source map so `resolve` can report the position in the file you actually edit.
 */
export function reactSourceIdentityPlugin(): IdentityPlugin {
    return {
        id: "react-source",

        async prepare(elements) {
            if (!nativeFetch) return;
            const fetcher = nativeFetch;
            const urls = new Set<string>();
            for (const el of elements) {
                const fiber = fiberOf(el);
                const frame = fiber && frameOf(fiber);
                if (frame) urls.add(frame.url);
            }
            if (urls.size === 0) return;
            const loads = Promise.all([...urls].map((url) => warmSourceMap(url, fetcher)));
            await Promise.race([
                loads,
                new Promise<void>((resolve) => setTimeout(resolve, PREPARE_TIMEOUT_MS)),
            ]);
        },

        resolve(el) {
            try {
                const fiber = fiberOf(el);
                if (!fiber) return {};
                const owner = fiber._debugOwner ?? nearestComponent(fiber);
                const name =
                    componentName(owner?.type) ?? componentName(nearestComponent(fiber)?.type);
                if (!name) return {};
                const source = sourceOf(fiber) ?? (owner ? sourceOf(owner) : undefined);
                const path = componentPathOf(fiber);
                return {
                    component: { name, ...(source ? { source } : {}), ...(path ? { path } : {}) },
                };
            } catch {
                return {};
            }
        },
    };
}

/** Plumbing React and routers add around your components: real, but never what anyone means by "where". */
const PLUMBING =
    /^(?:Fragment|Suspense|StrictMode|Profiler|Anonymous|Unknown|Lazy|ErrorBoundary|Router|BrowserRouter|Routes|Route|RenderedRoute|RenderErrorBoundary|Outlet|Transition|CSSTransition|TransitionGroup)$|(?:Provider|Consumer|Context)$/;

/**
 * The components around an element, outermost first: `["App", "Dashboard", "SubmitButton"]`. It follows the chain
 * of components that rendered it when React recorded one (development builds), and the chain of parents otherwise
 * (so a production build with readable names still gets a path). Only a chain of two or more is worth reporting.
 */
export function componentPathOf(fiber: Fiber, limit = 8): string[] | undefined {
    const start = fiber._debugOwner ?? nearestComponent(fiber);
    if (!start) return undefined;
    const byOwner = Boolean(start._debugOwner);
    const names: string[] = [];
    for (
        let f: Fiber | null | undefined = start;
        f && names.length < limit;
        f = byOwner ? f._debugOwner : f.return
    ) {
        const name = componentName(f.type);
        if (name && !PLUMBING.test(name) && names[names.length - 1] !== name) names.push(name);
    }
    names.reverse();
    return names.length >= 2 ? names : undefined;
}

export function fiberOf(el: Element): Fiber | undefined {
    for (const key of Object.keys(el)) {
        if (key.startsWith("__reactFiber$")) return (el as unknown as Record<string, Fiber>)[key];
    }
    return undefined;
}

function nearestComponent(start: Fiber): Fiber | undefined {
    for (let fiber: Fiber | null | undefined = start; fiber; fiber = fiber.return) {
        if (componentName(fiber.type)) return fiber;
    }
    return undefined;
}

/** Function, class, memo and forwardRef components; host elements (string types) have no name here. */
export function componentName(type: unknown): string | undefined {
    if (!type || typeof type === "string") return undefined;
    const t = type as {
        displayName?: string;
        name?: string;
        render?: { displayName?: string; name?: string };
        type?: { displayName?: string; name?: string };
    };
    const name =
        t.displayName ||
        t.name ||
        t.render?.displayName ||
        t.render?.name ||
        t.type?.displayName ||
        t.type?.name;
    return name && name !== "Anonymous" ? name : undefined;
}

/** The raw frame from `_debugStack`, when React 19 recorded one for this fiber or its owner. */
function frameOf(fiber: Fiber): Frame | undefined {
    const own = fiber._debugStack?.stack;
    const fromOwner = fiber._debugOwner?._debugStack?.stack;
    const stack = own ?? fromOwner;
    return stack ? firstAppFrame(stack) : undefined;
}

export function sourceOf(fiber: Fiber): string | undefined {
    const dbg = fiber._debugSource;
    if (dbg?.fileName) return `${dbg.fileName}:${dbg.lineNumber ?? 0}:${dbg.columnNumber ?? 0}`;
    const frame = frameOf(fiber) ?? (fiber._debugOwner ? frameOf(fiber._debugOwner) : undefined);
    return frame ? formatFrame(frame) : undefined;
}

/** Picks the first stack frame outside React. */
export function firstAppFrame(stack: string): Frame | undefined {
    for (const line of stack.split("\n")) {
        const match = /\(?((?:https?:\/\/|file:\/\/|\/)[^\s()]+?):(\d+):(\d+)\)?\s*$/.exec(
            line.trim()
        );
        if (!match || INTERNAL_FRAME.test(match[1] ?? "")) continue;
        return { url: match[1] ?? "", line: Number(match[2]), col: Number(match[3]) };
    }
    return undefined;
}

/**
 * `path:line:col`. Uses the module's source map when it has been loaded, so the position refers to the
 * original file; otherwise the served module's own position, which is still better than nothing.
 */
export function formatFrame(frame: Frame, pageOrigin = currentOrigin()): string {
    const modulePath = normalisePath(frame.url, pageOrigin);
    const map = cachedSourceMap(frame.url);
    const original = map ? originalPosition(map, frame.line, frame.col) : null;
    if (!original) return `${modulePath}:${frame.line}:${frame.col}`;
    const sourcePath = normalisePath(original.source);
    const sameFile = sourcePath.split("/").pop() === modulePath.split("/").pop();
    return `${sameFile ? modulePath : sourcePath}:${original.line}:${original.col}`;
}

const currentOrigin = () => (typeof location === "undefined" ? undefined : location.origin);

/**
 * A root-relative path for a served module. When it comes from a different origin than the page's (a Module
 * Federation remote served by another app), the origin stays: it is what says which app the file belongs to.
 */
export function normalisePath(url: string, pageOrigin?: string): string {
    const origin = /^https?:\/\/[^/]*/.exec(url)?.[0];
    if (pageOrigin && origin && origin !== pageOrigin) return url.replace(/[?#].*$/, "");
    const path = url.replace(/^(?:https?|file):\/\/[^/]*/, "").replace(/[?#].*$/, "");
    return path.replace(/^\/@fs\//, "/").replace(/^\//, "");
}
