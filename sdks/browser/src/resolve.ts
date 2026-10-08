import type { ElementIdentity } from "@notato/schema";

/** The document or shadow root an iframe or shadow host leads into, or null when it cannot be entered. */
function enter(host: Element, kind: "frame" | "shadow"): ParentNode | null {
    try {
        if (kind === "frame") return (host as HTMLIFrameElement).contentDocument ?? null;
        return host.shadowRoot;
    } catch {
        return null; // a cross-origin frame
    }
}

function query(root: ParentNode, selector: string): Element | null {
    try {
        return root.querySelector(selector);
    } catch {
        return null;
    }
}

/**
 * The live element an identity points at: through each iframe and shadow root it records, then by its selector.
 * Null when any step is gone (a frame that navigated, a component that re-rendered without it).
 */
export function resolveIdentity(
    identity: Pick<ElementIdentity, "selector" | "within">,
    doc: Document = document
): Element | null {
    let root: ParentNode = doc;
    for (const hop of identity.within ?? []) {
        const host = query(root, hop.selector);
        const inner = host && enter(host, hop.kind);
        if (!inner) return null;
        root = inner;
    }
    return query(root, identity.selector);
}

/**
 * A selector that may reach inside iframes and shadow roots: `iframe#preview >>> button.pay` or
 * `my-widget >>> .inner`. Each `>>>` goes through whatever the element on its left holds, frame or shadow root.
 */
export function querySelectorDeep(selector: string, doc: Document = document): Element | null {
    const parts = selector.split(">>>").map((p) => p.trim());
    let root: ParentNode = doc;
    for (let i = 0; i < parts.length; i++) {
        const found = query(root, parts[i] as string);
        if (!found) return null;
        if (i === parts.length - 1) return found;
        const inner = enter(found, "frame") ?? enter(found, "shadow");
        if (!inner) return null;
        root = inner;
    }
    return null;
}
