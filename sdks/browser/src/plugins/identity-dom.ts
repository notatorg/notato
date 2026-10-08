import type { IdentityPlugin } from "@notato/core";
import { EDITABLE, MASK_ATTR } from "../attributes.ts";
import { isDocument, isShadowRoot } from "../ui/dom.ts";

export const DEFAULT_TEST_ID_ATTRIBUTES = ["data-testid", "data-qa", "data-cy", "data-test"];

export interface DomIdentityOptions {
    /** Checked in order. Defaults to data-testid, data-qa, data-cy, data-test. */
    testIdAttributes?: string[];
}

const TEXT_LIMIT = 200;

/**
 * Resolution order: test id attribute, then accessible role + name, then the shortest unique CSS selector.
 * Every field that can be resolved is filled in; the order says which one an agent should trust first.
 */
export function domIdentityPlugin(options: DomIdentityOptions = {}): IdentityPlugin {
    const testIdAttributes = options.testIdAttributes ?? DEFAULT_TEST_ID_ATTRIBUTES;
    return {
        id: "dom",
        resolve(el) {
            const classes = stableClasses(el, 8);
            return {
                selector: uniqueSelector(el, testIdAttributes),
                testId: testIdOf(el, testIdAttributes),
                role: roleOf(el),
                name: accessibleName(el),
                tag: el.tagName.toLowerCase(),
                classes: classes.length ? classes : undefined,
                text: visibleText(el),
                within: containerPath(el, testIdAttributes),
                ancestors: ancestorsOf(el),
            };
        },
    };
}

export function testIdOf(
    el: Element,
    attributes: string[] = DEFAULT_TEST_ID_ATTRIBUTES
): string | undefined {
    for (const attr of attributes) {
        const value = el.getAttribute(attr);
        if (value) return value;
    }
    return undefined;
}

// ---------------------------------------------------------------- selectors

export function cssEscape(value: string): string {
    const native = globalThis.CSS?.escape;
    if (native) return native(value);
    return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`).replace(/^(\d)/, "\\3$1 ");
}

const GENERATED_PATTERNS: RegExp[] = [
    /^[:«]r?[0-9a-z]+[:»]$/, // React useId in 18 and 19.0/19.1: ":r1:", "«r1»"
    /^_r_[0-9a-z]+_$/, // React 19.2 useId
    /^\d+$/, // purely numeric
    /\d{5,}/, // long digit runs
    /[0-9a-f]{8}-[0-9a-f]{4}-/i, // uuid
    /^(css|sc|jsx|emotion|svelte)-[0-9a-z]+/i, // css-in-js hashes
    /__[A-Za-z0-9_-]{4,}$/, // CSS modules: Button_primary__x7Fq2
    /^_[A-Za-z0-9]{5,}_[A-Za-z0-9]{3,}$/, // hashed module classes
];

/** Generated ids and classes change between renders and builds, so they make poor selectors. */
export function looksGenerated(token: string): boolean {
    return GENERATED_PATTERNS.some((pattern) => pattern.test(token));
}

export function stableClasses(el: Element, limit: number): string[] {
    const out: string[] = [];
    for (const cls of Array.from(el.classList)) {
        if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(cls) || looksGenerated(cls)) continue;
        out.push(cls);
        if (out.length >= limit) break;
    }
    return out;
}

function matchesOnly(root: ParentNode, selector: string, el: Element): boolean {
    try {
        const found = root.querySelectorAll(selector);
        return found.length === 1 && found[0] === el;
    } catch {
        return false;
    }
}

function anchorOf(el: Element, testIdAttributes: string[]): string | undefined {
    const testId = testIdOf(el, testIdAttributes);
    const attr = testId ? testIdAttributes.find((a) => el.getAttribute(a) === testId) : undefined;
    if (attr && testId) return `[${attr}="${cssEscape(testId)}"]`;
    if (el.id && !looksGenerated(el.id)) return `#${cssEscape(el.id)}`;
    return undefined;
}

function segmentOf(el: Element): string {
    const tag = el.tagName.toLowerCase();
    // Not `parentElement`: the top-level children of a shadow root have no parent element, but they do have siblings.
    const parent = el.parentNode;
    const classes = stableClasses(el, 2);
    const own = tag + classes.map((c) => `.${cssEscape(c)}`).join("");
    if (!parent) return own;
    const sameTag = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
    if (sameTag.length === 1) return own;
    const sameShape = Array.from(parent.children).filter(
        (c) => c.tagName === el.tagName && classes.every((cls) => c.classList.contains(cls))
    );
    if (classes.length && sameShape.length === 1) return own;
    return `${tag}:nth-of-type(${sameTag.indexOf(el) + 1})`;
}

/**
 * Shortest selector that matches exactly this element in the document, or the shadow root, that contains it. An
 * element inside a shadow root is looked up from that root (see `containerPath` for how to get to it).
 */
export function uniqueSelector(
    el: Element,
    testIdAttributes: string[] = DEFAULT_TEST_ID_ATTRIBUTES
): string {
    const rootNode = el.getRootNode();
    const root: ParentNode =
        isDocument(rootNode) || isShadowRoot(rootNode) ? rootNode : el.ownerDocument;
    const stop = isDocument(root) ? root.documentElement : null;
    const own = anchorOf(el, testIdAttributes);
    if (own && matchesOnly(root, own, el)) return own;

    const tag = el.tagName.toLowerCase();
    if (matchesOnly(root, tag, el)) return tag;

    const path: string[] = [];
    let node: Element | null = el;
    while (node && node !== stop) {
        path.unshift(segmentOf(node));
        const joined = path.join(" > ");
        if (matchesOnly(root, joined, el)) return joined;
        const parent: Element | null = node.parentElement;
        if (parent) {
            const anchor = anchorOf(parent, testIdAttributes);
            if (anchor) {
                const anchored = `${anchor} > ${joined}`;
                if (matchesOnly(root, anchored, el)) return anchored;
                const loose = `${anchor} ${joined}`;
                if (matchesOnly(root, loose, el)) return loose;
            }
        }
        node = parent;
    }
    return stop ? `html > ${path.join(" > ")}` : path.join(" > ");
}

/**
 * The shadow hosts and iframes to go through to reach an element, outermost first, each as a selector in the
 * document or shadow root that holds it. Empty (undefined) for an element in the page's own document.
 */
export function containerPath(
    el: Element,
    testIdAttributes: string[] = DEFAULT_TEST_ID_ATTRIBUTES
): Array<{ kind: "frame" | "shadow"; selector: string }> | undefined {
    const hops: Array<{ kind: "frame" | "shadow"; selector: string }> = [];
    let current: Element = el;
    for (let guard = 0; guard < 12; guard++) {
        const root = current.getRootNode();
        if (isShadowRoot(root)) {
            hops.unshift({ kind: "shadow", selector: uniqueSelector(root.host, testIdAttributes) });
            current = root.host;
            continue;
        }
        const frame = current.ownerDocument.defaultView?.frameElement;
        if (frame) {
            hops.unshift({ kind: "frame", selector: uniqueSelector(frame, testIdAttributes) });
            current = frame;
            continue;
        }
        break;
    }
    return hops.length ? hops : undefined;
}

/** `main#app`, `section.panel`: a short name for an element, for saying where something sits. */
function shortName(el: Element): string {
    const id = el.id && !looksGenerated(el.id) ? `#${cssEscape(el.id)}` : "";
    const cls = id ? [] : stableClasses(el, 1);
    return `${el.tagName.toLowerCase()}${id}${cls.map((c) => `.${cssEscape(c)}`).join("")}`;
}

/** The elements around this one, outermost first, nearest six: where it sits in the page. */
export function ancestorsOf(el: Element, limit = 6): string[] | undefined {
    const names: string[] = [];
    for (let node = el.parentElement; node && names.length < limit; node = node.parentElement) {
        if (node === node.ownerDocument.documentElement) break;
        names.unshift(shortName(node));
    }
    return names.length ? names : undefined;
}

// -------------------------------------------------------------- role & name

const INPUT_ROLES: Record<string, string> = {
    button: "button",
    submit: "button",
    reset: "button",
    image: "button",
    checkbox: "checkbox",
    radio: "radio",
    range: "slider",
    number: "spinbutton",
    search: "searchbox",
    email: "textbox",
    tel: "textbox",
    url: "textbox",
    text: "textbox",
    password: "textbox",
};

const TAG_ROLES: Record<string, string> = {
    button: "button",
    select: "combobox",
    textarea: "textbox",
    nav: "navigation",
    main: "main",
    aside: "complementary",
    ul: "list",
    ol: "list",
    li: "listitem",
    table: "table",
    form: "form",
    dialog: "dialog",
    h1: "heading",
    h2: "heading",
    h3: "heading",
    h4: "heading",
    h5: "heading",
    h6: "heading",
    article: "article",
    summary: "button",
};

export function roleOf(el: Element): string | undefined {
    const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0];
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : undefined;
    if (tag === "input") return INPUT_ROLES[(el.getAttribute("type") ?? "text").toLowerCase()];
    if (tag === "img") return el.getAttribute("alt") === "" ? "presentation" : "img";
    return TAG_ROLES[tag];
}

const collapse = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const clip = (s: string) => (s.length > TEXT_LIMIT ? `${s.slice(0, TEXT_LIMIT - 1)}…` : s);
const NAME_FROM_CONTENT = new Set([
    "button",
    "link",
    "heading",
    "listitem",
    "tab",
    "menuitem",
    "option",
    "cell",
]);

/** Subtrees whose text is user data (field contents) or explicitly marked private. */
const OMITTED_TAGS = new Set([
    "script",
    "style",
    "noscript",
    "template",
    "textarea",
    "select",
    "input",
    "option",
]);

/** `data-notato-mask` marks private; `data-notato-mask="false"` only opts a field out of screenshot masking. */
const PRIVATE = `[${MASK_ATTR}]:not([${MASK_ATTR}="false"])`;
const isOmitted = (el: Element) =>
    OMITTED_TAGS.has(el.tagName.toLowerCase()) || el.matches(PRIVATE) || el.matches(EDITABLE);

/** Marked private, itself or by an element around it: none of its text is recorded. */
export const isPrivate = (el: Element) => el.closest(PRIVATE) !== null;
/** Typed into, itself or as part of a region around it: its text is the person's writing. */
const inEditable = (el: Element) => el.closest(EDITABLE) !== null;

/**
 * `textContent` without form-field contents or `data-notato-mask` subtrees. A label that wraps a
 * textarea would otherwise leak the textarea's text into the accessible name.
 */
export function safeText(el: Element, limit = TEXT_LIMIT * 2): string {
    if (isOmitted(el) || isPrivate(el) || inEditable(el)) return "";
    const walker = el.ownerDocument.createTreeWalker(
        el,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
        {
            acceptNode: (node) => {
                if (node.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
                return isOmitted(node as Element)
                    ? NodeFilter.FILTER_REJECT
                    : NodeFilter.FILTER_SKIP;
            },
        }
    );
    let out = "";
    for (let node = walker.nextNode(); node && out.length < limit; node = walker.nextNode()) {
        out += node.nodeValue ?? "";
    }
    return out;
}

/** Never reads `.value` of a text input: that is user data, not a name. */
export function accessibleName(el: Element): string | undefined {
    if (isPrivate(el)) return undefined;
    const doc = el.ownerDocument;
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
        const text = collapse(
            labelledBy
                .split(/\s+/)
                .map((id) => {
                    const target = doc.getElementById(id);
                    return target ? safeText(target) : "";
                })
                .join(" ")
        );
        if (text) return clip(text);
    }
    const aria = collapse(el.getAttribute("aria-label"));
    if (aria) return clip(aria);

    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
        const type = (el.getAttribute("type") ?? "").toLowerCase();
        if (tag === "input" && ["button", "submit", "reset"].includes(type)) {
            const label = collapse(el.getAttribute("value"));
            if (label) return clip(label);
        }
        const id = el.getAttribute("id");
        const byFor = id ? doc.querySelector(`label[for="${cssEscape(id)}"]`) : null;
        const wrapping = el.closest("label");
        const labelEl = byFor ?? wrapping;
        const label = collapse(labelEl ? safeText(labelEl) : "");
        if (label) return clip(label);
        const placeholder = collapse(el.getAttribute("placeholder"));
        if (placeholder) return clip(placeholder);
    }
    if (tag === "img") {
        const alt = collapse(el.getAttribute("alt"));
        if (alt) return clip(alt);
    }
    const role = roleOf(el);
    if (role && NAME_FROM_CONTENT.has(role) && !inEditable(el)) {
        const text = collapse(safeText(el));
        if (text) return clip(text);
    }
    const title = collapse(el.getAttribute("title"));
    return title ? clip(title) : undefined;
}

export function visibleText(el: Element): string | undefined {
    if (isOmitted(el) || isPrivate(el) || inEditable(el)) return undefined;
    const holdsPrivateContent =
        el.querySelector(`textarea, select, input, ${PRIVATE}, ${EDITABLE}`) !== null;
    const raw = holdsPrivateContent
        ? safeText(el)
        : ((el as HTMLElement).innerText ?? el.textContent);
    const text = collapse(raw);
    return text ? clip(text) : undefined;
}
