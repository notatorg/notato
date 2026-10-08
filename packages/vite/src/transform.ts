import { parse } from "@babel/parser";
import MagicString from "magic-string";

/** The attribute that carries where an element is written: `path/to/File.tsx:line:column`. */
export const SOURCE_ATTRIBUTE = "data-notato-src";

export interface TagOptions {
    /** What the attribute records for this file, normally its path from the repository root. */
    label: string;
    /** The id the source map is for. */
    id: string;
    /** Parse as TSX rather than JSX. */
    typescript: boolean;
}

export interface Tagged {
    code: string;
    map: ReturnType<MagicString["generateMap"]>;
}

interface AstNode {
    type: string;
    start: number;
    end: number;
    loc: { start: { line: number; column: number } };
    name?: AstNode & { name?: string };
    attributes?: Array<AstNode & { name?: { name?: string } }>;
    [key: string]: unknown;
}

/** Keys that hold positions or comments rather than child nodes. */
const SKIP = new Set([
    "loc",
    "range",
    "extra",
    "leadingComments",
    "trailingComments",
    "innerComments",
    "tokens",
]);

/** Every node, parents before children, without recursion so a deeply nested file cannot overflow the stack. */
function* nodes(root: unknown): Generator<AstNode> {
    const stack: unknown[] = [root];
    while (stack.length > 0) {
        const value = stack.pop();
        if (Array.isArray(value)) {
            for (let i = value.length - 1; i >= 0; i--) stack.push(value[i]);
            continue;
        }
        if (!value || typeof value !== "object") continue;
        const node = value as AstNode;
        if (typeof node.type === "string") yield node;
        for (const key of Object.keys(node)) {
            if (SKIP.has(key)) continue;
            const child = node[key];
            if (child && typeof child === "object") stack.push(child);
        }
    }
}

const escapeAttribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/**
 * The tags react-dom renders as elements of the page: HTML, SVG and MathML. Other renderers have lowercase tags of
 * their own (React Three Fiber's `<mesh>`, `<boxGeometry>`), which are objects, not elements: an attribute on one is
 * set as a property, which R3F reads as a path (`data-notato-src` as `data.notato.src`) and throws on.
 */
const DOM_TAGS = new Set(
    [
        // HTML
        "a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code",
        "col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer",
        "form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map",
        "mark menu meta meter nav noscript object ol optgroup option output p param picture portal pre progress q",
        "rp rt ruby s samp script search section select selectedcontent slot small source span strong style sub",
        "summary sup table tbody td template textarea tfoot th thead time title tr track u ul var video wbr",
        "acronym big center dir font frame frameset marquee nobr noframes strike tt",
        // SVG
        "svg animate animateMotion animateTransform circle clipPath defs desc ellipse feBlend feColorMatrix",
        "feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight",
        "feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMerge feMergeNode",
        "feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence filter",
        "foreignObject g image line linearGradient marker mask metadata mpath path pattern polygon polyline",
        "radialGradient rect set stop switch symbol text textPath tspan use view",
        // MathML
        "math mi mn mo ms mspace mtext mrow mfrac msqrt mroot msub msup msubsup munder mover munderover",
        "mmultiscripts mprescripts mtable mtr mtd mpadded mphantom menclose semantics annotation",
    ].flatMap((names) => names.split(" "))
);

/** DOM tags that three.js has a class of the same name for: in a React Three Fiber file they are probably those. */
const THREE_TOO = new Set(["audio", "line", "path", "source"]);

/** A file that uses React Three Fiber, whose lowercase tags are three.js objects. */
const USES_THREE = /\bfrom\s*["'](?:@react-three\/[\w-]+|three)(?:\/[^"']*)?["']/;

/** Whether `<name>` is an element of the page, which can carry the attribute. */
function isDomTag(name: string, threeFile: boolean): boolean {
    // A custom element (`<my-widget>`) is one too.
    if (name.includes("-")) return true;
    return DOM_TAGS.has(name) && !(threeFile && THREE_TOO.has(name));
}

/**
 * Adds `data-notato-src="file:line:column"` to every host element (`<div>`, `<button>`, …) in a JSX or TSX file,
 * where the position is that of the element's opening `<`. Components (`<Card>`), member tags (`<motion.div>`) and
 * fragments are left alone: a component would pass the attribute on as a prop, and the host elements inside it are
 * tagged where they are written. So are lowercase tags that are not elements of the page, such as React Three
 * Fiber's (see `DOM_TAGS`). The text is inserted, never rewritten, so the rest of the file is byte for byte
 * what it was and the source map stays exact. Returns null when there is nothing to tag.
 */
export function tagJsx(code: string, options: TagOptions): Tagged | null {
    if (!code.includes("<")) return null;
    const ast = parse(code, {
        sourceType: "module",
        plugins: options.typescript ? ["jsx", "typescript"] : ["jsx"],
        errorRecovery: true,
        allowReturnOutsideFunction: true,
    });

    const out = new MagicString(code);
    const threeFile = USES_THREE.test(code);
    let tagged = 0;
    for (const node of nodes(ast.program)) {
        if (node.type !== "JSXOpeningElement") continue;
        const name = node.name;
        if (name?.type !== "JSXIdentifier" || !isDomTag(name.name ?? "", threeFile)) continue;
        if (
            node.attributes?.some(
                (a) => a.type === "JSXAttribute" && a.name?.name === SOURCE_ATTRIBUTE
            )
        )
            continue;
        const { line, column } = node.loc.start;
        out.appendLeft(
            name.end,
            ` ${SOURCE_ATTRIBUTE}="${escapeAttribute(`${options.label}:${line}:${column + 1}`)}"`
        );
        tagged += 1;
    }
    if (tagged === 0) return null;
    return {
        code: out.toString(),
        map: out.generateMap({ hires: true, source: options.id, includeContent: false }),
    };
}
