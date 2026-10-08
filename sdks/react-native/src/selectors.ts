/**
 * Notato's selectors on a native screen, as every mobile SDK reads them: `ProductCard > Text#price`,
 * `button:text("Add to basket")`, `#pay:nth(2)`. Leading names are the components (or the screen) around the element;
 * the last part says the element itself:
 *
 *   `Text`, `button`, `*`     its type, role or component (`*` for any)
 *   `#pay`                    its test id (testID / nativeID)
 *   `[label="Pay now"]`       its accessibility label, exactly
 *   `:text("basket")`         its text or label contains this, ignoring case
 *   `:nth(2)`                 the second match, in drawing order
 */
export interface Selector {
    ancestors: string[];
    type?: string;
    id?: string;
    label?: string;
    text?: string;
    nth?: number;
}

/** What a selector is matched against: one element on the screen. */
export interface Candidate {
    tag: string;
    role?: string;
    testId?: string;
    label?: string;
    /** Absent for a private element: it can never be found by its text. */
    text?: string;
    /** The app's components around it, outermost first. */
    path: string[];
}

export class SelectorError extends Error {}

/** Splits on top-level whitespace and `>`, keeping quoted strings, brackets and parentheses whole. */
function tokens(input: string): string[] {
    const out: string[] = [];
    let current = "";
    let depth = 0;
    let quote: string | null = null;
    for (let i = 0; i < input.length; i++) {
        const c = input[i] as string;
        if (quote) {
            current += c;
            if (c === "\\" && i + 1 < input.length) current += input[++i];
            else if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'") {
            quote = c;
            current += c;
        } else if (c === "[" || c === "(") {
            depth++;
            current += c;
        } else if (c === "]" || c === ")") {
            depth--;
            current += c;
        } else if (depth === 0 && (c === ">" || /\s/.test(c))) {
            if (current) out.push(current);
            current = "";
        } else current += c;
    }
    if (quote || depth !== 0)
        throw new SelectorError(`unbalanced quotes or brackets in ${JSON.stringify(input)}`);
    if (current) out.push(current);
    return out;
}

const unquote = (s: string) =>
    /^(["']).*\1$/.test(s) ? s.slice(1, -1).replace(/\\(.)/g, "$1") : s;

export function parseSelector(input: string): Selector {
    const parts = tokens(input.trim());
    const last = parts.pop();
    if (!last) throw new SelectorError("an empty selector");
    const selector: Selector = { ancestors: parts.map(unquote) };
    let rest = last;
    const head = /^(\*|[A-Za-z_][\w.$-]*)/.exec(rest);
    if (head) {
        if (head[1] !== "*") selector.type = head[1];
        rest = rest.slice(head[0].length);
    }
    const readers: Array<[RegExp, (m: RegExpExecArray) => void]> = [
        [
            /^#([\w.@/-]+)/,
            (m) => {
                selector.id = m[1];
            },
        ],
        [
            /^\[label=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\]/,
            (m) => {
                selector.label = unquote(m[1] as string);
            },
        ],
        [
            /^:text\(("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\)/,
            (m) => {
                selector.text = unquote(m[1] as string);
            },
        ],
        [
            /^:nth\((\d+)\)/,
            (m) => {
                selector.nth = Number(m[1]);
            },
        ],
    ];
    while (rest) {
        const matched = readers.find(([pattern]) => pattern.test(rest));
        if (!matched)
            throw new SelectorError(
                `cannot read ${JSON.stringify(rest)} in ${JSON.stringify(input)}`
            );
        const m = matched[0].exec(rest) as RegExpExecArray;
        matched[1](m);
        rest = rest.slice(m[0].length);
    }
    return selector;
}

/** An element's fields in lower case, worked out once: pins match many selectors against the same elements. */
interface Folded {
    tag: string;
    role?: string;
    component?: string;
    text?: string;
    label?: string;
}
const folded = new WeakMap<Candidate, Folded>();
function fold(c: Candidate): Folded {
    let f = folded.get(c);
    if (!f) {
        f = {
            tag: c.tag.toLowerCase(),
            role: c.role?.toLowerCase(),
            component: c.path[c.path.length - 1]?.toLowerCase(),
            text: c.text?.toLowerCase(),
            label: c.label?.toLowerCase(),
        };
        folded.set(c, f);
    }
    return f;
}

/** A parsed selector, with its own words in lower case. */
interface Prepared {
    s: Selector;
    type?: string;
    text?: string;
}
const prepare = (s: Selector): Prepared => ({
    s,
    type: s.type?.toLowerCase(),
    text: s.text?.toLowerCase(),
});

function matchesSelf(c: Candidate, p: Prepared): boolean {
    const { s } = p;
    if (s.id !== undefined && c.testId !== s.id) return false;
    if (s.label !== undefined && c.label !== s.label) return false;
    if (p.type === undefined && p.text === undefined) return true;
    const f = fold(c);
    if (p.type !== undefined && f.tag !== p.type && f.role !== p.type && f.component !== p.type)
        return false;
    if (p.text !== undefined && !(f.text?.includes(p.text) || f.label?.includes(p.text)))
        return false;
    return true;
}

/** Selectors read before: pins ask for the same ones every time they are placed. */
const parsed = new Map<string, Selector>();
function parseCached(input: string): Selector {
    let s = parsed.get(input);
    if (!s) {
        s = parseSelector(input);
        if (parsed.size > 2000) parsed.clear();
        parsed.set(input, s);
    }
    return s;
}

/** Whether the names appear around the element, outermost first, not necessarily one inside the next. */
function within(c: Candidate, ancestors: string[]): boolean {
    let at = 0;
    for (const name of c.path) if (name === ancestors[at]) at++;
    return at === ancestors.length;
}

/**
 * The elements filed by what selectors most often start from, their test id and their type (tag, role or component,
 * in lower case): built once per look at the screen, so the pins' many selectors each read a few elements, not all.
 */
export interface SelectorIndex<C extends Candidate> {
    byId: Map<string, C[]>;
    byType: Map<string, C[]>;
}

export function indexOf<C extends Candidate>(candidates: C[]): SelectorIndex<C> {
    const byId = new Map<string, C[]>();
    const byType = new Map<string, C[]>();
    const file = (map: Map<string, C[]>, key: string, c: C) => {
        const list = map.get(key);
        if (!list) map.set(key, [c]);
        else if (list[list.length - 1] !== c) list.push(c);
    };
    for (const c of candidates) {
        if (c.testId !== undefined) file(byId, c.testId, c);
        const f = fold(c);
        file(byType, f.tag, c);
        if (f.role !== undefined) file(byType, f.role, c);
        if (f.component !== undefined) file(byType, f.component, c);
    }
    return { byId, byType };
}

/**
 * The elements a selector finds, in drawing order (one, with `:nth`). Leading names narrow the search when the app
 * has those components around the element; a name that is only a screen's (`Checkout button`) is not held against it.
 * With an index of the same elements, only those with the selector's test id or type are looked at.
 */
export function query<C extends Candidate>(
    candidates: C[],
    selector: string | Selector,
    index?: SelectorIndex<C>
): C[] {
    const s = typeof selector === "string" ? parseCached(selector) : selector;
    const p = prepare(s);
    const pool = !index
        ? candidates
        : s.id !== undefined
          ? (index.byId.get(s.id) ?? [])
          : p.type !== undefined
            ? (index.byType.get(p.type) ?? [])
            : candidates;
    const own = pool.filter((c) => matchesSelf(c, p));
    const narrowed = s.ancestors.length ? own.filter((c) => within(c, s.ancestors)) : own;
    const found = narrowed.length ? narrowed : own;
    if (s.nth !== undefined) {
        const one = found[s.nth - 1];
        return one ? [one] : [];
    }
    return found;
}

/** A selector that finds this element again: its own, made sharper with its text when it has no test id. */
export function selectorToFind(identity: {
    selector: string;
    testId?: string;
    text?: string;
}): string {
    if (identity.testId || !identity.text) return identity.selector;
    return `${identity.selector}:text(${JSON.stringify(identity.text.slice(0, 60))})`;
}
