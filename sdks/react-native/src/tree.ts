import { identityOf, isTextInput, nativeName } from "./identity.ts";
import { NotatoMask } from "./mask.tsx";
import type { Candidate } from "./selectors.ts";

/** The slice of a React fiber Notato reads. */
export interface Fiber {
    tag: number;
    type: unknown;
    memoizedProps?: Record<string, unknown> | null;
    return: Fiber | null;
    child: Fiber | null;
    sibling: Fiber | null;
    _debugOwner?: Fiber | null;
    stateNode?: {
        node?: unknown;
        canonical?: { nativeTag?: number; publicInstance?: unknown };
    } | null;
}

/** React's tag for a fiber that is a native view. */
export const HOST_COMPONENT = 5;

/** A native view of the app, with what selectors and masking need to know about it. */
export interface TreeElement extends Candidate {
    fiber: Fiber;
    /** Inside `<NotatoMask>`, or a password field: covered, and none of its text recorded. */
    private: boolean;
    /** A text field: covered and its value left out when `maskInputs` is on, unless `shown`. */
    input: boolean;
    /** A text field inside `<NotatoMask private={false}>`. */
    shown: boolean;
    /** The nearest native view around it, in the app. */
    parent?: TreeElement;
}

export function componentName(type: unknown): string | undefined {
    if (typeof type === "string") return type;
    if (typeof type === "function") {
        const t = type as { displayName?: string; name?: string };
        return t.displayName ?? t.name;
    }
    if (type && typeof type === "object") {
        const t = type as {
            displayName?: string;
            render?: { displayName?: string; name?: string };
            type?: unknown;
        };
        return t.displayName ?? t.render?.displayName ?? t.render?.name ?? componentName(t.type);
    }
    return undefined;
}

/** The fiber of a native view's instance (a `ref` on a View), on the New Architecture. */
export function fiberOf(instance: unknown): Fiber | undefined {
    const handle = (instance as { __internalInstanceHandle?: Fiber } | null)
        ?.__internalInstanceHandle;
    return handle && typeof handle.tag === "number" ? handle : undefined;
}

/**
 * What react-native-view-shot photographs a native view by: its instance when React has made one (it does so lazily,
 * for refs and the inspector), else its native tag, which view-shot takes as well.
 */
export const instanceOf = (fiber: Fiber): unknown =>
    fiber.stateNode?.canonical?.publicInstance ?? fiber.stateNode?.canonical?.nativeTag;

/** Whether two fibers are the same native view: React keeps two copies of each, which share their `canonical`. */
export const sameView = (a: Fiber, b: Fiber) =>
    !!a.stateNode?.canonical && a.stateNode.canonical === b.stateNode?.canonical;

/** The components that rendered a fiber, outermost first, as React's development builds record them. */
export function ownerNames(fiber: Fiber): string[] {
    const names: string[] = [];
    for (let f: Fiber | null | undefined = fiber; f && names.length < 40; f = f._debugOwner) {
        const name = componentName(f.type);
        if (name) names.unshift(name);
    }
    return names;
}

/** Private (inside a private mark), shown (a field inside `private={false}` and nothing private), or neither. */
type Mark = "private" | "shown" | undefined;

function markOf(fiber: Fiber, outer: Mark): Mark {
    if (fiber.type !== NotatoMask || outer === "private") return outer;
    return fiber.memoizedProps?.private === false ? "shown" : "private";
}

/** A native view as selectors see it. `maskInputs` leaves a field's value out unless it is shown. */
export function describe(fiber: Fiber, mark: Mark, maskInputs: boolean): TreeElement {
    const native = fiber.type as string;
    const input = isTextInput(native);
    const secure = input && fiber.memoizedProps?.secureTextEntry === true;
    const isPrivateHere = mark === "private" || secure;
    const identity = identityOf(
        {
            names: [...ownerNames(fiber).slice(0, -1), native],
            props: fiber.memoizedProps ?? {},
            frame: { left: 0, top: 0, width: 0, height: 0 },
            componentStack: "",
        },
        [],
        { private: isPrivateHere, maskValue: maskInputs && mark !== "shown" }
    );
    return {
        fiber,
        tag: identity.tag ?? nativeName(native),
        ...(identity.role ? { role: identity.role } : {}),
        ...(identity.testId ? { testId: identity.testId } : {}),
        ...(identity.name ? { label: identity.name } : {}),
        ...(identity.text ? { text: identity.text } : {}),
        path: identity.ancestors ?? [],
        private: isPrivateHere,
        input,
        shown: mark === "shown",
    };
}

/** Every native view under `root`, in drawing order, described for selectors and masking. */
export function elementsUnder(root: Fiber, maskInputs: boolean, limit = 20_000): TreeElement[] {
    const out: TreeElement[] = [];
    // Depth first, carrying the masks down, without recursion: a deep tree cannot overflow the stack.
    type Entry = { fiber: Fiber; mark: Mark; parent?: TreeElement };
    const stack: Entry[] = [];
    if (root.child) stack.push({ fiber: root.child, mark: undefined });
    while (stack.length && out.length < limit) {
        const { fiber, mark: outer, parent } = stack.pop() as Entry;
        if (fiber.sibling) stack.push({ fiber: fiber.sibling, mark: outer, parent });
        const mark = markOf(fiber, outer);
        let host = parent;
        if (fiber.tag === HOST_COMPONENT && typeof fiber.type === "string") {
            host = describe(fiber, mark, maskInputs);
            if (parent) host.parent = parent;
            out.push(host);
        }
        if (fiber.child) stack.push({ fiber: fiber.child, mark, parent: host });
    }
    return out;
}

/** A native view, and the one around it: a walk up from a view to the nearest that has a place of its own. */
export interface HostLink {
    fiber: Fiber;
    parent?: HostLink;
}

/**
 * What screenshots cover: every native view inside a private `<NotatoMask>`, password fields, and (with `maskInputs`)
 * text fields not inside `private={false}`, each with the native views around it. Every view is looked at, however
 * many there are: something private is never left uncovered because the screen is big.
 */
export function maskedUnder(root: Fiber, maskInputs: boolean): HostLink[] {
    const out: HostLink[] = [];
    type Entry = { fiber: Fiber; mark: Mark; parent?: HostLink };
    const stack: Entry[] = [];
    if (root.child) stack.push({ fiber: root.child, mark: undefined });
    while (stack.length) {
        const { fiber, mark: outer, parent } = stack.pop() as Entry;
        if (fiber.sibling) stack.push({ fiber: fiber.sibling, mark: outer, parent });
        const mark = markOf(fiber, outer);
        let host = parent;
        if (fiber.tag === HOST_COMPONENT && typeof fiber.type === "string") {
            host = parent ? { fiber, parent } : { fiber };
            const input = isTextInput(fiber.type);
            const secure = input && fiber.memoizedProps?.secureTextEntry === true;
            if (mark === "private" || secure || (input && maskInputs && mark !== "shown"))
                out.push(host);
        }
        if (fiber.child) stack.push({ fiber: fiber.child, mark, parent: host });
    }
    return out;
}

export interface Frame {
    left: number;
    top: number;
    width: number;
    height: number;
}

type FabricUIManager = { measure(node: unknown, cb: (...n: number[]) => void): void };

/** Where a native view is on the page, from Fabric's own layout. Null when it is not on screen. */
export function measure(fiber: Fiber): Promise<Frame | null> {
    return new Promise((resolve) => {
        const ui = (globalThis as { nativeFabricUIManager?: FabricUIManager })
            .nativeFabricUIManager;
        const node = fiber.stateNode?.node;
        if (!ui || !node) return resolve(null);
        const timer = setTimeout(() => resolve(null), 500);
        try {
            ui.measure(node, (_x, _y, width = 0, height = 0, pageX = 0, pageY = 0) => {
                clearTimeout(timer);
                resolve(
                    width > 0 && height > 0 ? { left: pageX, top: pageY, width, height } : null
                );
            });
        } catch {
            clearTimeout(timer);
            resolve(null);
        }
    });
}
