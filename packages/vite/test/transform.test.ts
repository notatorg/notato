import { describe, expect, it } from "vitest";
import { SOURCE_ATTRIBUTE, tagJsx } from "../src/transform.ts";

const tag = (code: string, label = "app/src/File.tsx", typescript = true) =>
    tagJsx(code, { label, id: "/abs/app/src/File.tsx", typescript });
const attrs = (code: string) => [...code.matchAll(/data-notato-src="([^"]+)"/g)].map((m) => m[1]);
/** Takes the inserted attribute out again: what is left must be the original, byte for byte. */
const strip = (code: string) => code.replace(/ data-notato-src="[^"]*"/g, "");

const SAMPLE = `import { useState } from "react"

export function Panel({ items }: { items: string[] }) {
  const [open, setOpen] = useState<boolean>(false)
  return (
    <section className="panel">
      <h1>Title</h1>
      {open ? <p>open</p> : null}
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <input type="text" disabled />
    </section>
  )
}
`;

describe("tagJsx", () => {
    it("records the file, line and column of each host element's opening <", () => {
        const out = tag(SAMPLE);
        expect(attrs(out?.code ?? "")).toEqual([
            "app/src/File.tsx:6:5", // section
            "app/src/File.tsx:7:7", // h1
            "app/src/File.tsx:8:15", // p, inside the conditional
            "app/src/File.tsx:9:7", // ul
            "app/src/File.tsx:11:11", // li
            "app/src/File.tsx:14:7", // input
        ]);
    });

    it("puts the attribute straight after the tag name, so later props and spreads still win", () => {
        const out = tag(
            'const a = <div {...rest} id="x" />\nconst b = <button onClick={go}>Go</button>\n'
        )?.code;
        expect(out).toContain('<div data-notato-src="app/src/File.tsx:1:11" {...rest} id="x" />');
        expect(out).toContain('<button data-notato-src="app/src/File.tsx:2:11" onClick={go}>');
    });

    it("leaves components, member tags and fragments alone, and tags the host elements inside them", () => {
        const out =
            tag(
                "const v = <><Card title='a'><motion.div><span /></motion.div></Card><Foo.Bar /></>\n"
            )?.code ?? "";
        expect(attrs(out)).toEqual(["app/src/File.tsx:1:41"]);
        expect(out).toContain("<Card title='a'>");
        expect(out).toContain("<motion.div>");
        expect(out).toContain("<Foo.Bar />");
        expect(out).toContain("<>");
    });

    it("leaves React Three Fiber's lowercase tags alone: they are three.js objects, not elements", () => {
        const code = `import { Canvas } from "@react-three/fiber"
import { Html } from "@react-three/drei"
export const Scene = () => (
  <div className="stage">
    <Canvas>
      <ambientLight intensity={0.5} />
      <mesh position={[0, 1, 0]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="hotpink" />
      </mesh>
      <line><bufferGeometry /></line>
      <primitive object={thing} />
      <Html><span>label</span></Html>
    </Canvas>
  </div>
)
`;
        // Only the page's own elements: the stage around the canvas and the label drei renders as HTML.
        expect(attrs(tag(code)?.code ?? "")).toEqual([
            "app/src/File.tsx:4:3",
            "app/src/File.tsx:13:13",
        ]);
    });

    it("tags SVG and custom elements, and an SVG <line> outside a three.js file", () => {
        const code =
            'const a = <svg><line x1="0" /><path d="M0" /><linearGradient /></svg>\nconst b = <my-widget />\nconst c = <group />\n';
        expect(attrs(tag(code)?.code ?? "")).toHaveLength(5);
    });

    it("only inserts: with the attributes taken out, the file is exactly what it was", () => {
        const out = tag(SAMPLE);
        expect(strip(out?.code ?? "")).toBe(SAMPLE);
    });

    it("is idempotent: an element that already has the attribute is not tagged again", () => {
        const once = tag(SAMPLE)?.code ?? "";
        expect(tag(once)).toBeNull();
    });

    it("counts lines and columns from the file's own text, CRLF and non-ASCII included", () => {
        const code = 'const a = "é — ü"\r\nconst b = (\r\n  <div>ok</div>\r\n)\r\n';
        expect(attrs(tag(code)?.code ?? "")).toEqual(["app/src/File.tsx:3:3"]);
    });

    it("copes with the TypeScript people write in a .tsx file", () => {
        const code = `
import type { FC } from "react"
enum Mode { A, B }
const id = <T,>(x: T): T => x
const n = (value as unknown as number) satisfies number
const lt = n < 3 && n > 1
export const View: FC<{ mode: Mode }> = ({ mode }) => <div data-mode={mode}>{lt ? <b>yes</b> : <i>no</i>}</div>
`;
        const out = tag(code);
        expect(attrs(out?.code ?? "")).toHaveLength(3);
        expect(strip(out?.code ?? "")).toBe(code);
    });

    it("reads a .jsx file without the TypeScript plugin", () => {
        const code =
            "export const A = () => <div className='a'>{[1, 2].map((n) => <span key={n}>{n}</span>)}</div>\n";
        const out = tag(code, "app/src/A.jsx", false);
        expect(attrs(out?.code ?? "")).toHaveLength(2);
    });

    it("returns null when there is nothing to tag", () => {
        expect(tag("export const x = 1 < 2\n")).toBeNull();
        expect(tag("export const A = () => <Card />\n")).toBeNull();
        expect(tag("")).toBeNull();
    });

    it("escapes what cannot sit inside an attribute value", () => {
        const out = tag("const a = <div />\n", 'weird "dir"/a&b/File.tsx');
        expect(out?.code).toContain(
            'data-notato-src="weird &quot;dir&quot;/a&amp;b/File.tsx:1:11"'
        );
    });

    it("returns a source map for the file, so what runs still maps to what was written", () => {
        const out = tag(SAMPLE);
        expect(out?.map.version).toBe(3);
        expect(out?.map.sources).toEqual(["/abs/app/src/File.tsx"]);
        expect(out?.map.mappings.length).toBeGreaterThan(0);
    });

    it("throws on a file it cannot parse, for the plugin to report", () => {
        expect(() => tag("const x = <div a=>")).toThrow();
        expect(() => tag("<div>{</div>")).toThrow();
    });

    it("handles a large file quickly", () => {
        const rows = Array.from(
            { length: 3000 },
            (_, i) => `    <li key={${i}}><a href="#${i}">row ${i}</a></li>`
        ).join("\n");
        const code = `export const List = () => (\n  <ul>\n${rows}\n  </ul>\n)\n`;
        const started = performance.now();
        const out = tag(code);
        expect(attrs(out?.code ?? "")).toHaveLength(6001);
        expect(performance.now() - started).toBeLessThan(2000);
    });

    it("names the attribute it writes", () => {
        expect(SOURCE_ATTRIBUTE).toBe("data-notato-src");
    });
});
