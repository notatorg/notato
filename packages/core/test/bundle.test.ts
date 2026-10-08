import { type Annotation, Bundle, sampleAnnotation } from "@notato/schema";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
    assetsFor,
    BUNDLE_LIMITS,
    BundleError,
    buildBundle,
    readBundle,
    renderFeedbackMarkdown,
    streamBundle,
    writeBundle,
} from "../src/index.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 9]);

function annotation(n: number, over: Partial<Annotation> = {}): Annotation {
    return {
        ...sampleAnnotation,
        id: `01TEST${String(n).padStart(20, "0")}`,
        comment: `comment ${n}\nsecond line`,
        screenshots: {
            full: { id: `full-${n}`, mime: "image/webp", w: 10, h: 10 },
            crop: { id: `crop-${n}`, mime: "image/png", w: 5, h: 5 },
        },
        ...over,
    };
}

/** The screenshots of an annotation that is known to have them, for tests that look inside. */
const shots = (a: Annotation) => a.screenshots as NonNullable<Annotation["screenshots"]>;

const records = (...as: Annotation[]) =>
    as.map((a) => ({
        annotation: a,
        assets: new Map<string, Blob>([
            [shots(a).full.id, new Blob([WEBP as BlobPart], { type: "image/webp" })],
            [a.screenshots?.crop?.id ?? "", new Blob([PNG as BlobPart], { type: "image/png" })],
        ]),
    }));

const bytesFor = (ref: { id: string }) => Promise.resolve(ref.id.startsWith("full") ? WEBP : PNG);

async function roundTrip(...as: Annotation[]) {
    const { bundle } = buildBundle(records(...as), {
        projectId: "checkout-web",
        author: { name: "Tester" },
    });
    const zip = await writeBundle(bundle, bytesFor);
    return { bundle, zip, read: readBundle(zip) };
}

describe("streamBundle", () => {
    it("streams a project of thousands of notes with screenshots, which reads back in whole", async () => {
        const many = Array.from({ length: 3000 }, (_, i) => annotation(i + 1));
        const { bundle } = buildBundle(records(...many), { projectId: "checkout-web" });
        let asked = 0;
        const stream = streamBundle(
            bundle,
            (ref) => {
                asked++;
                return bytesFor(ref);
            },
            { compact: true }
        );
        const zip = new Uint8Array(await new Response(stream).arrayBuffer());
        expect(asked).toBe(6000);
        const read = readBundle(zip);
        expect(read.bundle.annotations).toHaveLength(3000);
        expect(read.files.size).toBe(6000);
        expect(strFromU8(unzipSync(zip)["annotations.json"] as Uint8Array)).not.toContain("\n  ");
    });

    it("ends the stream with an error when a screenshot is missing", async () => {
        const { bundle } = buildBundle(records(annotation(1)), { projectId: "p" });
        const stream = streamBundle(bundle, async () => undefined);
        await expect(new Response(stream).arrayBuffer()).rejects.toThrow(/missing screenshot/);
    });
});

describe("buildBundle", () => {
    it("assigns one bundle id to every annotation and gathers the asset bytes", () => {
        const { bundle, assets } = buildBundle(records(annotation(1), annotation(2)), {
            projectId: "p",
            id: "B1",
        });
        expect(bundle.id).toBe("B1");
        expect(bundle.annotations.every((a) => a.bundleId === "B1")).toBe(true);
        expect(assets.size).toBe(4);
        expect(Bundle.safeParse(bundle).success).toBe(true);
    });
    it("generates a ULID when no id is given", () => {
        expect(buildBundle([], { projectId: "p" }).bundle.id).toMatch(/^[0-9A-Z]{26}$/);
    });
});

describe("write then read", () => {
    it("contains feedback.md, annotations.json and a shots/ entry per screenshot", async () => {
        const { zip } = await roundTrip(annotation(1), annotation(2));
        expect(Object.keys(unzipSync(zip)).sort()).toEqual([
            "annotations.json",
            "feedback.md",
            "shots/01-crop.png",
            "shots/01-full.webp",
            "shots/02-crop.png",
            "shots/02-full.webp",
        ]);
    });

    it("reads back every annotation identically, with paths pointing at the right bytes", async () => {
        const { bundle, read } = await roundTrip(
            annotation(1),
            annotation(2, { severity: "nit", thread: [] })
        );
        expect(read.bundle.annotations).toHaveLength(2);
        read.bundle.annotations.forEach((a, i) => {
            const original = bundle.annotations[i] as Annotation;
            expect({ ...a, screenshots: undefined }).toEqual({
                ...original,
                screenshots: undefined,
            });
            expect(a.screenshots?.full.id).toBe(original.screenshots?.full.id);
            expect(Array.from(read.files.get(a.screenshots?.full.path ?? "") ?? [])).toEqual(
                Array.from(WEBP)
            );
            expect(Array.from(read.files.get(a.screenshots?.crop?.path ?? "") ?? [])).toEqual(
                Array.from(PNG)
            );
        });
        expect(read.bundle).toMatchObject({
            id: bundle.id,
            projectId: "checkout-web",
            author: { name: "Tester" },
            schemaVersion: 1,
        });
    });

    it("assetsFor maps asset ids to their bytes", async () => {
        const { read } = await roundTrip(annotation(1));
        const a = read.bundle.annotations[0] as Annotation;
        const map = assetsFor(a, read.files);
        expect(Array.from(map.get(shots(a).full.id) ?? [])).toEqual(Array.from(WEBP));
        expect(map.size).toBe(2);
    });

    it("supports annotations without a crop", async () => {
        const a = annotation(1);
        const { read } = await roundTrip({ ...a, screenshots: { full: shots(a).full } });
        expect(read.bundle.annotations[0]?.screenshots?.crop).toBeUndefined();
    });

    it("fails loudly when screenshot bytes are missing", async () => {
        const { bundle } = buildBundle(records(annotation(1)), { projectId: "p" });
        await expect(writeBundle(bundle, async () => undefined)).rejects.toThrow(BundleError);
    });
});

describe("feedback.md", () => {
    it("lists annotations in order with route, severity, comment, inline screenshots, identity and steps", async () => {
        const a = annotation(1, {
            severity: "major",
            route: "/checkout",
            steps: [{ action: "click", target: "#pay", at: "2026-10-05T10:00:00Z" }],
        });
        const { zip } = await roundTrip(a, annotation(2, { route: "/orders" }));
        const md = strFromU8(unzipSync(zip)["feedback.md"] as Uint8Array);
        const first = md.indexOf("## 1. /checkout — major");
        const second = md.indexOf("## 2. /orders");
        expect(first).toBeGreaterThan(-1);
        expect(second).toBeGreaterThan(first);
        expect(md).toContain("> comment 1\n> second line");
        expect(md).toContain("![Full screenshot, target outlined](shots/01-full.webp)");
        expect(md).toContain("![Crop of the target](shots/01-crop.png)");
        expect(md).toContain("Selector: `#pay > button.primary`");
        expect(md).toContain("Test id: `pay-button`");
        expect(md).toContain("Component: PayButton (`src/PayButton.tsx:12:5`)");
        expect(md).toContain("1. click `#pay`");
        expect(md).toContain("from Tester");
    });

    it("marks a People only note, so an agent handed the file can tell it is not for it", () => {
        const { bundle } = buildBundle(
            records(annotation(1, { route: "/checkout" }), annotation(2, { peopleOnly: true })),
            { projectId: "p" }
        );
        const md = renderFeedbackMarkdown(bundle);
        expect(md).toContain("## 2. ");
        expect(md.match(/People only/g)).toHaveLength(2);
        expect(md.slice(md.indexOf("## 2."))).toContain(
            "_People only: kept between people, not for an agent to act on._"
        );
        expect(md.slice(0, md.indexOf("## 2."))).not.toContain("People only");
    });

    it("renders directly from a bundle too", () => {
        const { bundle } = buildBundle(records(annotation(1)), {
            projectId: "p",
            appName: "shop",
            appVersion: "2.0",
        });
        expect(renderFeedbackMarkdown(bundle)).toContain("# Feedback for shop 2.0");
    });
});

/**
 * A zip written by hand: one stored payload, and `names` entries in the directory that all point at it, each saying
 * the size it likes. What a zip bomb looks like to a reader that checks only each entry's own declared size.
 */
function crafted(names: string[], payload: Uint8Array, said = payload.length): Uint8Array {
    const enc = new TextEncoder();
    const first = enc.encode(names[0] ?? "x");
    const local = new Uint8Array(30 + first.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, said, true);
    lv.setUint16(26, first.length, true);
    local.set(first, 30);
    const central: Uint8Array[] = names.map((name) => {
        const n = enc.encode(name);
        const c = new Uint8Array(46 + n.length);
        const cv = new DataView(c.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint32(20, payload.length, true);
        cv.setUint32(24, said, true);
        cv.setUint16(28, n.length, true);
        cv.setUint32(42, 0, true);
        c.set(n, 46);
        return c;
    });
    const cdSize = central.reduce((t, c) => t + c.length, 0);
    const cdOffset = local.length + payload.length;
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, names.length, true);
    ev.setUint16(10, names.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdOffset, true);
    const out = new Uint8Array(cdOffset + cdSize + 22);
    out.set(local, 0);
    out.set(payload, local.length);
    let at = cdOffset;
    for (const c of central) {
        out.set(c, at);
        at += c.length;
    }
    out.set(end, at);
    return out;
}

describe("reading hostile or broken bundles", () => {
    it("refuses a zip whose entries all point at the same data, before inflating any of it", () => {
        const names = Array.from(
            { length: 100 },
            (_, i) => `shots/${String(i).padStart(3, "0")}.png`
        );
        expect(() => readBundle(crafted(names, new Uint8Array(2 * 1024 * 1024)))).toThrow(
            /two entries share their data/
        );
    });

    it("refuses a stored entry that says a smaller size than it has", () => {
        expect(() => readBundle(crafted(["shots/a.png"], new Uint8Array(4096), 1))).toThrow(
            /says two different sizes/
        );
    });

    const zipOf = (files: Record<string, Uint8Array>) => zipSync(files);
    const validJson = async () =>
        strToU8(JSON.stringify(unzipSyncJson(await roundTrip(annotation(1)))));
    const unzipSyncJson = (r: { zip: Uint8Array }) =>
        JSON.parse(strFromU8(unzipSync(r.zip)["annotations.json"] as Uint8Array));

    it("rejects non-zip input", () => {
        expect(() => readBundle(strToU8("hello"))).toThrow(/not a readable zip/);
    });

    it("rejects a bundle with no annotations.json", () => {
        expect(() => readBundle(zipOf({ "feedback.md": strToU8("x") }))).toThrow(
            /missing annotations.json/
        );
    });

    it("rejects invalid JSON and schema violations with a precise message", async () => {
        expect(() => readBundle(zipOf({ "annotations.json": strToU8("{nope") }))).toThrow(
            /not valid JSON/
        );
        const good = unzipSyncJson(await roundTrip(annotation(1)));
        good.annotations[0].severity = "huge";
        expect(() =>
            readBundle(zipOf({ "annotations.json": strToU8(JSON.stringify(good)) }))
        ).toThrow(/severity/);
    });

    it("rejects an unsupported schemaVersion before looking at anything else", async () => {
        const good = unzipSyncJson(await roundTrip(annotation(1)));
        good.schemaVersion = 2;
        expect(() =>
            readBundle(zipOf({ "annotations.json": strToU8(JSON.stringify(good)) }))
        ).toThrow(/schemaVersion 2 is not supported \(this build reads 1\)/);
    });

    it("rejects an annotation whose screenshot is not in the zip", async () => {
        const { zip } = await roundTrip(annotation(1));
        const files = unzipSync(zip);
        delete files["shots/01-full.webp"];
        expect(() => readBundle(zipOf(files))).toThrow(/not in the bundle/);
    });

    it("ignores entries outside annotations.json and shots/<name>, including path traversal", async () => {
        const { zip } = await roundTrip(annotation(1));
        const files = unzipSync(zip);
        const read = readBundle(
            zipOf({
                ...files,
                "../evil.txt": strToU8("x"),
                "shots/../evil.txt": strToU8("x"),
                "shots/nested/deep.png": PNG,
                "/abs/path.png": PNG,
                "other/thing.bin": PNG,
            })
        );
        expect([...read.files.keys()].sort()).toEqual(["shots/01-crop.png", "shots/01-full.webp"]);
    });

    it("refuses a file that inflates past the per-file limit without inflating it", async () => {
        const bomb = new Uint8Array(BUNDLE_LIMITS.maxFileBytes + 1);
        const files = unzipSync((await roundTrip(annotation(1))).zip);
        expect(() => readBundle(zipOf({ ...files, "shots/bomb.png": bomb }))).toThrow(
            /larger than/
        );
    });

    it("refuses too many files", async () => {
        const files: Record<string, Uint8Array> = { "annotations.json": await validJson() };
        for (let i = 0; i <= BUNDLE_LIMITS.maxFiles; i++)
            files[`shots/f${i}.png`] = new Uint8Array([1]);
        expect(() => readBundle(zipOf(files))).toThrow(/more than/);
    });
});

describe("annotations without screenshots", () => {
    const bare = (n: number) => ({ ...annotation(n), screenshots: undefined }) as Annotation;

    it("round-trips through a zip that has no shots folder and no images in the summary", async () => {
        const { bundle } = buildBundle([{ annotation: bare(1), assets: new Map() }], {
            projectId: "p",
            author: { name: "T" },
        });
        const zip = await writeBundle(bundle, async () => undefined);
        const names = Object.keys(unzipSync(zip));
        expect(names.sort()).toEqual(["annotations.json", "feedback.md"]);
        const markdown = strFromU8(unzipSync(zip)["feedback.md"] as Uint8Array);
        expect(markdown).not.toContain("![");
        expect(markdown).toContain("comment");
        const read = readBundle(zip);
        expect(read.bundle.annotations[0]?.screenshots).toBeUndefined();
        expect(assetsFor(read.bundle.annotations[0] as Annotation, read.files).size).toBe(0);
    });

    it("mixes with annotations that do have them", async () => {
        const a = annotation(1);
        const { bundle, assets } = buildBundle(
            [...records(a), { annotation: bare(2), assets: new Map<string, Blob>() }],
            { projectId: "p", author: { name: "T" } }
        );
        const zip = await writeBundle(bundle, async (ref) => {
            const blob = assets.get(ref.id);
            return blob ? new Uint8Array(await blob.arrayBuffer()) : undefined;
        });
        const read = readBundle(zip);
        expect(read.bundle.annotations.map((x) => Boolean(x.screenshots))).toEqual([true, false]);
    });
});
