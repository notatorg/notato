import { type Annotation, type AssetRef, Bundle, SCHEMA_VERSION } from "@notato/schema";
import {
    strFromU8,
    strToU8,
    unzipSync,
    Zip,
    ZipDeflate,
    ZipPassThrough,
    type Zippable,
    zipSync,
} from "fflate";
import { ulid } from "ulid";
import type { AnnotationRecord } from "./types.ts";

export const BUNDLE_JSON = "annotations.json";
export const BUNDLE_MARKDOWN = "feedback.md";

/** Ceilings applied when reading a bundle, so a hostile zip cannot exhaust memory. */
export const BUNDLE_LIMITS = {
    // Two screenshots a note: a project of several thousand notes exports to more than a few thousand files, and must
    // import again. What keeps a zip's memory bounded is the total, and the check that no two entries share data.
    maxFiles: 20_000,
    maxFileBytes: 25 * 1024 * 1024,
    maxTotalBytes: 250 * 1024 * 1024,
} as const;

/** Raised for a bundle that is malformed, unsupported or over the limits. Safe to show to a person. */
export class BundleError extends Error {}

const SHOT_PATH = /^shots\/[A-Za-z0-9._-]{1,120}$/;

export interface BundleMeta {
    projectId: string;
    author?: { name?: string };
    appName?: string;
    appVersion?: string;
    /** Defaults to a new ULID. */
    id?: string;
    createdAt?: string;
}

/** Assigns a bundle id to a set of annotations and returns it with the bytes behind their screenshots. */
export function buildBundle(
    records: AnnotationRecord[],
    meta: BundleMeta
): { bundle: Bundle; assets: Map<string, Blob> } {
    const id = meta.id ?? ulid();
    const assets = new Map<string, Blob>();
    for (const record of records) for (const [key, blob] of record.assets) assets.set(key, blob);
    const bundle: Bundle = {
        id,
        projectId: meta.projectId,
        createdAt: meta.createdAt ?? new Date().toISOString(),
        author: { name: meta.author?.name },
        appName: meta.appName,
        appVersion: meta.appVersion,
        annotations: records.map(({ annotation }) => ({ ...annotation, bundleId: id })),
        schemaVersion: SCHEMA_VERSION,
    };
    return { bundle, assets };
}

const extension = (ref: AssetRef) => (ref.mime === "image/webp" ? "webp" : "png");

/** Gives every screenshot a stable, readable path inside the zip. */
function withPaths(bundle: Bundle): Bundle {
    const pad = (n: number) => String(n).padStart(2, "0");
    return {
        ...bundle,
        annotations: bundle.annotations.map((a, i) => {
            const n = pad(i + 1);
            if (!a.screenshots) return a;
            const full = {
                ...a.screenshots.full,
                path: `shots/${n}-full.${extension(a.screenshots.full)}`,
            };
            const crop = a.screenshots.crop
                ? {
                      ...a.screenshots.crop,
                      path: `shots/${n}-crop.${extension(a.screenshots.crop)}`,
                  }
                : undefined;
            return { ...a, screenshots: { full, ...(crop ? { crop } : {}) } };
        }),
    };
}

/** Writes `feedback.md`, `annotations.json` and `shots/` into a zip. */
export async function writeBundle(
    bundle: Bundle,
    getAsset: (ref: AssetRef) => Promise<Uint8Array | undefined>
): Promise<Uint8Array> {
    const placed = withPaths(bundle);
    const files: Zippable = {
        [BUNDLE_MARKDOWN]: strToU8(renderFeedbackMarkdown(placed)),
        [BUNDLE_JSON]: strToU8(JSON.stringify(placed, null, 2)),
    };
    for (const a of placed.annotations) {
        for (const ref of [a.screenshots?.full, a.screenshots?.crop]) {
            if (!ref?.path) continue;
            const bytes = await getAsset(ref);
            if (!bytes) throw new BundleError(`missing screenshot bytes for ${ref.id}`);
            // Screenshots are already compressed; storing them avoids burning CPU for nothing.
            files[ref.path] = [bytes, { level: 0 }];
        }
    }
    return zipSync(files, { level: 6 });
}

/**
 * The same zip as `writeBundle`, written as it is read: one screenshot in memory at a time, so a project of thousands
 * of notes is never held whole. `compact` writes `annotations.json` on one line, which keeps a large one under the
 * size a single file may have when it is imported again.
 */
export function streamBundle(
    bundle: Bundle,
    getAsset: (ref: AssetRef) => Promise<Uint8Array | undefined>,
    options: { compact?: boolean } = {}
): ReadableStream<Uint8Array> {
    const placed = withPaths(bundle);
    const refs = placed.annotations.flatMap((a) =>
        [a.screenshots?.full, a.screenshots?.crop].filter(
            (r): r is AssetRef & { path: string } => !!r?.path
        )
    );
    let zip: Zip;
    let next = 0;
    return new ReadableStream<Uint8Array>({
        start(controller) {
            zip = new Zip((error, chunk, final) => {
                if (error) return controller.error(error);
                controller.enqueue(chunk);
                if (final) controller.close();
            });
            const text = (name: string, value: string) => {
                const file = new ZipDeflate(name, { level: 6 });
                zip.add(file);
                file.push(strToU8(value), true);
            };
            text(BUNDLE_MARKDOWN, renderFeedbackMarkdown(placed));
            text(BUNDLE_JSON, JSON.stringify(placed, null, options.compact ? undefined : 2));
            if (!refs.length) zip.end();
        },
        // One screenshot each time the reader wants more.
        async pull(controller) {
            const ref = refs[next++];
            if (!ref) return;
            try {
                const bytes = await getAsset(ref);
                if (!bytes) throw new BundleError(`missing screenshot bytes for ${ref.id}`);
                // Screenshots are already compressed; storing them avoids burning CPU for nothing.
                const file = new ZipPassThrough(ref.path);
                zip.add(file);
                file.push(bytes, true);
                if (next >= refs.length) zip.end();
            } catch (error) {
                controller.error(error);
            }
        },
    });
}

/**
 * What is wrong with a zip's central directory, before anything in it is inflated, or undefined. Each entry must
 * have its own data: a zip whose entries all point at the same bytes would be inflated once per entry (a zip bomb
 * that a size check on each entry alone does not catch). ZIP64 is refused: no bundle needs it.
 */
function zipShape(zip: Uint8Array): string | undefined {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const min = Math.max(0, zip.byteLength - 22 - 0xffff);
    let end = -1;
    for (let i = zip.byteLength - 22; i >= min; i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
            end = i;
            break;
        }
    }
    // Not a zip at all: the reader says so in its own words.
    if (end < 0) return undefined;
    const entries = view.getUint16(end + 10, true);
    const size = view.getUint32(end + 12, true);
    const offset = view.getUint32(end + 16, true);
    if (entries === 0xffff || size === 0xffffffff || offset === 0xffffffff)
        return "ZIP64 is not supported";
    if (entries > BUNDLE_LIMITS.maxFiles) return `more than ${BUNDLE_LIMITS.maxFiles} files`;
    if (offset + size > zip.byteLength) return "the zip is cut short";
    const starts = new Set<number>();
    let at = offset;
    for (let n = 0; n < entries; n++) {
        if (at + 46 > zip.byteLength || view.getUint32(at, true) !== 0x02014b50)
            return "the zip's directory is damaged";
        const start = view.getUint32(at + 42, true);
        if (starts.has(start)) return "two entries share their data";
        starts.add(start);
        at +=
            46 +
            view.getUint16(at + 28, true) +
            view.getUint16(at + 30, true) +
            view.getUint16(at + 32, true);
    }
    return undefined;
}

export interface ReadBundle {
    bundle: Bundle;
    /** Screenshot bytes by their path in the zip. */
    files: Map<string, Uint8Array>;
}

/**
 * Reads and validates a bundle. Only `annotations.json` and `shots/<name>` are used; `feedback.md` is a
 * human summary and is ignored. Anything unexpected, oversized or unreadable raises a `BundleError`.
 */
export function readBundle(zip: Uint8Array): ReadBundle {
    const shape = zipShape(zip);
    if (shape) throw new BundleError(`bundle rejected: ${shape}`);
    let violation: string | undefined;
    let count = 0;
    let total = 0;
    const declared = new Map<string, number>();
    let entries: Record<string, Uint8Array>;
    try {
        entries = unzipSync(zip, {
            filter(file) {
                count += 1;
                // A stored entry is copied as its compressed size says, whatever its size claims to be: both count.
                const largest = Math.max(file.size, file.originalSize);
                total += largest;
                if (count > BUNDLE_LIMITS.maxFiles)
                    violation ??= `more than ${BUNDLE_LIMITS.maxFiles} files`;
                else if (file.compression !== 0 && file.compression !== 8)
                    violation ??= `"${file.name}" uses a compression this format does not use`;
                else if (file.compression === 0 && file.size !== file.originalSize)
                    violation ??= `"${file.name}" says two different sizes`;
                else if (largest > BUNDLE_LIMITS.maxFileBytes)
                    violation ??= `"${file.name}" is larger than ${BUNDLE_LIMITS.maxFileBytes} bytes`;
                else if (total > BUNDLE_LIMITS.maxTotalBytes)
                    violation ??= `contents exceed ${BUNDLE_LIMITS.maxTotalBytes} bytes`;
                // Never inflate anything over a limit, and skip entries this format does not use.
                const wanted =
                    !violation && (file.name === BUNDLE_JSON || SHOT_PATH.test(file.name));
                if (wanted) declared.set(file.name, file.originalSize);
                return wanted;
            },
        });
    } catch (error) {
        throw new BundleError(
            `not a readable zip file: ${error instanceof Error ? error.message : error}`
        );
    }
    if (violation) throw new BundleError(`bundle rejected: ${violation}`);
    for (const [name, bytes] of Object.entries(entries)) {
        if (bytes.byteLength !== declared.get(name))
            throw new BundleError(`bundle rejected: "${name}" is not the size it says`);
    }

    const json = entries[BUNDLE_JSON];
    if (!json) throw new BundleError(`missing ${BUNDLE_JSON}`);
    let raw: unknown;
    try {
        raw = JSON.parse(strFromU8(json));
    } catch {
        throw new BundleError(`${BUNDLE_JSON} is not valid JSON`);
    }
    const version = (raw as { schemaVersion?: unknown } | null)?.schemaVersion;
    if (version !== SCHEMA_VERSION) {
        throw new BundleError(
            `bundle schemaVersion ${String(version)} is not supported (this build reads ${SCHEMA_VERSION})`
        );
    }
    const parsed = Bundle.safeParse(raw);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new BundleError(
            `invalid ${BUNDLE_JSON}: ${issue?.path.join(".") || "(root)"}: ${issue?.message}`
        );
    }

    const files = new Map<string, Uint8Array>();
    for (const [name, bytes] of Object.entries(entries))
        if (name !== BUNDLE_JSON) files.set(name, bytes);
    for (const a of parsed.data.annotations) {
        for (const ref of [a.screenshots?.full, a.screenshots?.crop]) {
            if (ref && (!ref.path || !files.has(ref.path))) {
                throw new BundleError(
                    `annotation ${a.id} points at a screenshot that is not in the bundle (${ref.path ?? "no path"})`
                );
            }
        }
    }
    return { bundle: parsed.data, files };
}

/** The screenshot bytes one annotation needs, keyed by asset id, ready for the server's `ingest`. */
export function assetsFor(
    annotation: Annotation,
    files: Map<string, Uint8Array>
): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>();
    for (const ref of [annotation.screenshots?.full, annotation.screenshots?.crop]) {
        const bytes = ref?.path ? files.get(ref.path) : undefined;
        if (ref && bytes) out.set(ref.id, bytes);
    }
    return out;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const quote = (s: string) =>
    s
        .split(/\r?\n/)
        .map((line) => `> ${line}`)
        .join("\n");

/**
 * `feedback.md`: the bundle as a document a person or a model can read top to bottom. Annotations are
 * numbered in order, each with route, severity, comment, inline screenshots, identity and steps.
 */
export function renderFeedbackMarkdown(bundle: Bundle): string {
    const lines = [
        `# Feedback${bundle.appName ? ` for ${bundle.appName}` : ""}${bundle.appVersion ? ` ${bundle.appVersion}` : ""}`,
        "",
        `Project \`${bundle.projectId}\` · bundle \`${bundle.id}\` · ${bundle.author.name ? `from ${bundle.author.name} · ` : ""}${bundle.createdAt} · ${bundle.annotations.length} annotation${bundle.annotations.length === 1 ? "" : "s"}`,
    ];
    bundle.annotations.forEach((a, i) => {
        lines.push(
            "",
            `## ${i + 1}. ${a.route}${a.severity ? ` — ${a.severity}` : ""}${a.peopleOnly ? " · People only" : ""}`,
            "",
            quote(a.comment),
            ""
        );
        // Someone may hand this file to an agent as it is: say plainly which notes are not for it.
        if (a.peopleOnly)
            lines.push("_People only: kept between people, not for an agent to act on._", "");
        if (a.screenshots?.full.path)
            lines.push(`![Full screenshot, target outlined](${a.screenshots.full.path})`);
        if (a.screenshots?.crop?.path)
            lines.push(`![Crop of the target](${a.screenshots.crop.path})`);
        lines.push("");
        a.target.identity.forEach((id, n) => {
            const label = `${id.role ?? id.tag}${id.name || id.text ? ` “${oneLine(id.name ?? id.text ?? "").slice(0, 80)}”` : ""}`;
            lines.push(
                `- Target${a.target.identity.length > 1 ? ` ${n + 1}` : ""} (${a.target.kind}): ${label}`
            );
            lines.push(`  - Selector: \`${id.selector}\``);
            if (id.testId) lines.push(`  - Test id: \`${id.testId}\``);
            if (id.component)
                lines.push(
                    `  - Component: ${id.component.name}${id.component.source ? ` (\`${id.component.source}\`)` : ""}`
                );
        });
        if (a.target.selectedText)
            lines.push(`- Selected text: “${oneLine(a.target.selectedText)}”`);
        lines.push(
            `- Page: ${a.url}`,
            `- Viewport: ${a.environment.viewport.w}×${a.environment.viewport.h} @${a.environment.dpr}x · ${a.author.name ?? a.author.kind} · ${a.createdAt}`
        );
        if (a.steps?.length) {
            lines.push("", "Steps taken:");
            for (const [n, s] of a.steps.entries()) {
                lines.push(
                    `${n + 1}. ${s.action}${s.target ? ` \`${s.target}\`` : ""}${s.value ? ` = ${oneLine(s.value)}` : ""}`
                );
            }
        }
    });
    return `${lines.join("\n")}\n`;
}
