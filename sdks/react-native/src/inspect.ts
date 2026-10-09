// What React Native's development builds expose for their own Element Inspector, through React's DevTools hook: the
// view under a point, and a view's component stack. With tree.ts, the only place that touches React Native's internals;
// a release build has none of it, and `canInspect()` then says so.
import type { Frame, Inspected } from "./identity.ts";
import {
    elementsUnder,
    elementWhere,
    type Fiber,
    fiberOf,
    instanceOf,
    measure,
    ownerNames,
    sameView,
    type TreeElement,
} from "./tree.ts";

/** What React Native's renderer reports for a view (its development build's inspector functions). */
interface ViewData {
    hierarchy?: Array<{ name?: string | null }>;
    props?: Record<string, unknown>;
    frame?: Frame;
    componentStack?: string;
    closestPublicInstance?: unknown;
    touchedViewTag?: number;
}

interface Renderer {
    rendererConfig?: {
        getInspectorDataForViewAtPoint?(
            inspected: unknown,
            x: number,
            y: number,
            callback: (data: ViewData) => boolean | undefined
        ): void;
        getInspectorDataForInstance?(fiber: Fiber): ViewData;
    };
}

/** A view picked to annotate: what the note says of it, and the view itself. */
export interface Picked extends Inspected {
    element: TreeElement;
    /** The native view, to photograph on its own. */
    view: unknown;
}

/** React's DevTools hook, as much of it as Notato uses. */
interface DevToolsHook {
    renderers?: Map<number, Renderer>;
    onCommitFiberRoot?: (...args: unknown[]) => unknown;
}

const devTools = () =>
    (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevToolsHook })
        .__REACT_DEVTOOLS_GLOBAL_HOOK__;

const renderers = (): Renderer[] => {
    const hook = devTools();
    return hook?.renderers ? [...hook.renderers.values()] : [];
};

let commits = 0;
let counting: DevToolsHook["onCommitFiberRoot"];
/** Who is told of each commit, with the root it was of. */
const listeners = new Set<(root: unknown) => void>();

/**
 * How many times React has committed since Notato began counting: React tells its DevTools hook after every commit,
 * and Notato listens there too, passing each call on. Undefined without the hook (a release build): anything may have
 * changed. Something that takes the hook's place later (React DevTools connecting) is listened through in turn, and
 * that counts as a change.
 */
export function commitCount(): number | undefined {
    const hook = devTools();
    if (!hook) return undefined;
    if (hook.onCommitFiberRoot !== counting) {
        const through = hook.onCommitFiberRoot;
        counting = function (this: unknown, ...args: unknown[]) {
            commits++;
            for (const listener of listeners) {
                try {
                    listener(args[1]);
                } catch {
                    // never React's problem
                }
            }
            return through?.apply(this, args);
        };
        hook.onCommitFiberRoot = counting;
        commits++;
    }
    return commits;
}

/** The fiber at the top of a view's tree: its root, whose `stateNode` is what React commits. */
function topOf(fiber: Fiber): Fiber {
    let top = fiber;
    while (top.return) top = top.return;
    return top;
}

/**
 * Calls `changed` after each of React's commits that rendered something inside `app` (the app's own view), and not
 * after those that only rendered Notato's overlay, or another root. Returns how to stop, or undefined without React's
 * DevTools hook (a release build), when commits cannot be told apart.
 *
 * React keeps two copies of each fiber, and renders into the copy that is not on screen. When only something beside
 * the app's view rendered (or its view was drawn again with the same children), React copies the view and its children
 * and stops there: what each child holds, and the child under it, stay the same objects. When anything under it
 * rendered, they do not. Looked at after every commit, that cannot be missed.
 */
export function watchApp(app: () => unknown, changed: () => void): (() => void) | undefined {
    if (commitCount() === undefined) return undefined;
    const now = () => {
        const marks: unknown[] = [];
        for (let c = currentContainer(app())?.child; c; c = c.sibling)
            marks.push(c.memoizedProps, c.memoizedState, c.child);
        return marks;
    };
    let seen = now();
    const listener = (root: unknown) => {
        const own = fiberOf(app());
        if (!own) return;
        if (root !== undefined && root !== topOf(own).stateNode) return;
        const marks = now();
        if (marks.length === seen.length && marks.every((m, i) => m === seen[i])) return;
        seen = marks;
        changed();
    };
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/**
 * Whether views can be picked: React Native's development builds expose what its own Element Inspector uses, through
 * React's DevTools hook, on the New Architecture. A release build does not, and Notato then has nothing to pick with.
 */
export const canInspect = () =>
    renderers().some((r) => typeof r.rendererConfig?.getInspectorDataForViewAtPoint === "function");

/**
 * The native view under a point of `root` (a view of the app): its instance when React has made one, else its native
 * tag (React makes instances lazily). Null when there is none.
 */
export function instanceAt(
    root: unknown,
    x: number,
    y: number,
    timeoutMs = 1000
): Promise<unknown> {
    return new Promise((resolve) => {
        let done = false;
        const finish = (value: unknown) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(value);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        try {
            for (const renderer of renderers()) {
                renderer.rendererConfig?.getInspectorDataForViewAtPoint?.(root, x, y, (data) => {
                    const found = data?.closestPublicInstance ?? data?.touchedViewTag;
                    if (found === undefined || found === null) return false;
                    finish(found);
                    return true;
                });
            }
        } catch {
            finish(null);
        }
    });
}

/**
 * The app's tree as React has it now. A view's own fiber may be an old copy (React keeps two of each), whose children
 * are out of date, so this starts from the root React committed last and finds the app's view in it.
 */
export function currentContainer(app: unknown): Fiber | undefined {
    const own = fiberOf(app);
    if (!own) return undefined;
    const top = topOf(own);
    const current = (top.stateNode as { current?: Fiber } | null | undefined)?.current;
    if (!current) return own;
    const canonical = own.stateNode?.canonical;
    const stack: Fiber[] = [current];
    while (stack.length) {
        const f = stack.pop() as Fiber;
        if (f.stateNode?.canonical && f.stateNode.canonical === canonical) return f;
        if (f.sibling) stack.push(f.sibling);
        if (f.child) stack.push(f.child);
    }
    return own;
}

/** Every native view of the app, as it is now, with the nearest one around each. */
export function appElements(app: unknown, maskInputs: boolean): TreeElement[] {
    const container = currentContainer(app);
    return container ? elementsUnder(container, maskInputs) : [];
}

/** Whether a fiber is a native view: its instance (a ref), or its native tag (what the inspector found under a tap). */
function isView(instance: unknown): ((fiber: Fiber) => boolean) | undefined {
    if (instance === null || instance === undefined) return undefined;
    const fiber = typeof instance === "number" ? undefined : fiberOf(instance);
    const tag =
        typeof instance === "number"
            ? instance
            : (instance as { __nativeTag?: unknown }).__nativeTag;
    return (f) =>
        (!!fiber && sameView(f, fiber)) ||
        (typeof tag === "number" && f.stateNode?.canonical?.nativeTag === tag);
}

/** The element for a native view, among the app's: its instance (a ref), or its native tag. */
export function elementFor(elements: TreeElement[], instance: unknown): TreeElement | undefined {
    const match = isView(instance);
    return match ? elements.find((e) => match(e.fiber)) : undefined;
}

/**
 * The element for a native view of the app, with the views around it, found without describing the rest of the app:
 * what a tap picks.
 */
export function elementAt(
    app: unknown,
    instance: unknown,
    maskInputs: boolean
): TreeElement | undefined {
    const match = isView(instance);
    const container = match ? currentContainer(app) : undefined;
    return match && container ? elementWhere(container, maskInputs, match) : undefined;
}

/** React's component stack for a fiber, innermost first, with bundle locations, which Metro maps to files. */
function stackOf(fiber: Fiber): string {
    for (const renderer of renderers()) {
        try {
            const data = renderer.rendererConfig?.getInspectorDataForInstance?.(fiber);
            if (data?.componentStack) return data.componentStack;
        } catch {
            // another renderer's
        }
    }
    return "";
}

/** What a note says of an element: its components, props, where it is now and its component stack. Null off screen. */
export async function inspect(element: TreeElement): Promise<Picked | null> {
    const frame = await measure(element.fiber);
    if (!frame) return null;
    return {
        names: ownerNames(element.fiber),
        props: element.fiber.memoizedProps ?? {},
        frame,
        componentStack: stackOf(element.fiber),
        element,
        view: instanceOf(element.fiber),
    };
}
