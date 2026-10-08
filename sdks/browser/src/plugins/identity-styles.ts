import type { IdentityPlugin } from "@notato/core";

/** What the value is when nothing was set, so it is not worth saying. Colours are checked after `toHex`. */
const QUIET: Record<string, string[]> = {
    "background-color": ["rgba(0, 0, 0, 0)", "transparent", "#00000000"],
    "font-weight": [],
    "letter-spacing": ["normal"],
    "text-align": ["start", "left"],
    "text-transform": ["none"],
    "box-shadow": ["none"],
    position: ["static"],
    opacity: ["1"],
    "z-index": ["auto"],
    gap: ["normal"],
    overflow: ["visible"],
    margin: ["0px"],
    padding: ["0px"],
    "border-radius": ["0px"],
};

/** Computed colours come back as `rgb(…)`; hex is what people write and read. */
export function toHex(value: string): string {
    const m = /^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)(?:[ ,/]+([\d.]+))?\s*\)$/.exec(value.trim());
    if (!m) return value;
    const hex = (n: string) => Number(n).toString(16).padStart(2, "0");
    const alpha = m[4] === undefined ? 1 : Number(m[4]);
    return `#${hex(m[1] as string)}${hex(m[2] as string)}${hex(m[3] as string)}${alpha < 1 ? hex(String(Math.round(alpha * 255))) : ""}`;
}

/** Four sides as the shortest CSS shorthand: `8px`, `8px 16px`, or all four. */
function sides(values: [string, string, string, string]): string {
    const [t, r, b, l] = values;
    if (t === r && r === b && b === l) return t;
    if (t === b && r === l) return `${t} ${r}`;
    return values.join(" ");
}

function border(style: CSSStyleDeclaration): string | undefined {
    const side = (name: "top" | "right" | "bottom" | "left") => {
        const s = style.getPropertyValue(`border-${name}-style`);
        if (!s || s === "none" || s === "hidden") return null;
        return `${style.getPropertyValue(`border-${name}-width`)} ${s} ${toHex(style.getPropertyValue(`border-${name}-color`))}`;
    };
    const all = (["top", "right", "bottom", "left"] as const).map((n) => [n, side(n)] as const);
    const present = all.filter(([, v]) => v !== null);
    if (present.length === 0) return undefined;
    if (present.length === 4 && present.every(([, v]) => v === present[0]?.[1]))
        return present[0]?.[1] as string;
    return present.map(([n, v]) => `${n} ${v}`).join(", ");
}

const SINGLE = [
    "color",
    "background-color",
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
    "letter-spacing",
    "text-align",
    "text-transform",
    "width",
    "height",
    "box-shadow",
    "border-radius",
    "display",
    "position",
    "opacity",
    "z-index",
    "gap",
    "overflow",
] as const;

/**
 * A curated set of computed styles for an element: the colours, type, size, spacing and layout it actually has,
 * which is what a comment like "too cramped" or "wrong blue" is about. Defaults are left out, and the set is
 * kept short so it stays worth reading.
 */
export function computedStylesOf(el: Element): Record<string, string> | undefined {
    const view = el.ownerDocument.defaultView;
    if (!view) return undefined;
    const style = view.getComputedStyle(el);
    const out: Record<string, string> = {};
    const put = (key: string, value: string | undefined) => {
        if (value && !(QUIET[key] ?? []).includes(value)) out[key] = value;
    };
    for (const prop of SINGLE) {
        const raw = style.getPropertyValue(prop).trim();
        put(
            prop,
            prop === "color" || prop === "background-color"
                ? toHex(raw)
                : raw.length > 120
                  ? `${raw.slice(0, 119)}…`
                  : raw
        );
    }
    const edge = (prefix: "margin" | "padding") =>
        sides(
            (["top", "right", "bottom", "left"] as const).map((n) =>
                style.getPropertyValue(`${prefix}-${n}`).trim()
            ) as [string, string, string, string]
        );
    put("margin", edge("margin"));
    put("padding", edge("padding"));
    const b = border(style);
    if (b) out.border = b;
    const flex = style.getPropertyValue("display");
    if (flex.includes("flex") || flex.includes("grid")) {
        put(
            "flex-direction",
            style.getPropertyValue("flex-direction").trim() === "row"
                ? ""
                : style.getPropertyValue("flex-direction").trim()
        );
        const j = style.getPropertyValue("justify-content").trim();
        const a = style.getPropertyValue("align-items").trim();
        put("justify-content", j === "normal" ? "" : j);
        put("align-items", a === "normal" ? "" : a);
    }
    return Object.keys(out).length ? out : undefined;
}

/** Adds each element's computed styles to its identity. */
export function stylesIdentityPlugin(): IdentityPlugin {
    return {
        id: "styles",
        resolve(el) {
            try {
                const styles = computedStylesOf(el);
                return styles ? { styles } : {};
            } catch {
                return {};
            }
        },
    };
}
