type Method = "pushState" | "replaceState";
const METHODS: Method[] = ["pushState", "replaceState"];

const listeners = new Set<() => void>();
/** Our wrapper on each history method, and what it wraps. */
const installed = new Map<Method, { original: History[Method]; wrapper: History[Method] }>();

const notify = () => {
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch {
            // one listener failing must not stop the others, or the page's navigation
        }
    }
};

function patch() {
    const history = window.history;
    for (const method of METHODS) {
        if (installed.has(method)) continue;
        const original = history[method];
        const wrapper = function patched(this: History, ...args: Parameters<History[Method]>) {
            const result = original.apply(this, args);
            notify();
            return result;
        };
        history[method] = wrapper;
        installed.set(method, { original, wrapper });
    }
}

function unpatch() {
    const history = window.history;
    for (const [method, { original, wrapper }] of installed) {
        // Something wrapped ours since: taking ours out would take theirs out too. Ours stays, silent, and is reused.
        if (history[method] !== wrapper) continue;
        history[method] = original;
        installed.delete(method);
    }
}

/**
 * Calls `listener` after every `pushState` and `replaceState`, which fire no event of their own (`popstate` and
 * `hashchange` do). History is patched once however many parts of Notato listen, and put back when the last one stops,
 * so the order they are torn down in does not matter.
 */
export function onHistoryChange(listener: () => void): () => void {
    listeners.add(listener);
    patch();
    return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) unpatch();
    };
}
