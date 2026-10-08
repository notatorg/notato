import type { Annotation, Bundle } from "@notato/schema";
import { strToU8, type Zippable, zipSync } from "fflate";
import { pinOf } from "./annotation.ts";
import { ulid } from "./ids.ts";

/**
 * A test-mode package: the notes as `annotations.json` (the schema's Bundle) and their screenshots under `shots/`,
 * the zip every SDK writes and `notato_import_bundle` reads.
 */
export function writeBundle(
    notes: Annotation[],
    meta: { project: string; author?: string; appName?: string; appVersion?: string; now?: Date },
    assetOf: (id: string) => Uint8Array | undefined
): { zip: Uint8Array; bundle: Bundle; name: string } {
    const id = ulid(meta.now?.getTime());
    const pad = (n: number) => String(n).padStart(2, "0");
    const files: Zippable = {};
    const annotations = notes.map((a, i) => {
        const n = pad(i + 1);
        const placed: Annotation = { ...a, bundleId: id };
        if (a.screenshots) {
            const full = assetOf(a.screenshots.full.id);
            const crop = a.screenshots.crop ? assetOf(a.screenshots.crop.id) : undefined;
            if (full) {
                const fullRef = { ...a.screenshots.full, path: `shots/${n}-full.png` };
                files[fullRef.path] = [full, { level: 0 }];
                const cropRef =
                    a.screenshots.crop && crop
                        ? { ...a.screenshots.crop, path: `shots/${n}-crop.png` }
                        : undefined;
                if (cropRef && crop) files[cropRef.path] = [crop, { level: 0 }];
                placed.screenshots = { full: fullRef, ...(cropRef ? { crop: cropRef } : {}) };
            } else {
                delete placed.screenshots;
            }
        }
        return placed;
    });
    const bundle: Bundle = {
        id,
        projectId: meta.project,
        createdAt: (meta.now ?? new Date()).toISOString(),
        author: meta.author ? { name: meta.author } : {},
        ...(meta.appName ? { appName: meta.appName } : {}),
        ...(meta.appVersion ? { appVersion: meta.appVersion } : {}),
        annotations,
        schemaVersion: 1,
    };
    files["annotations.json"] = strToU8(JSON.stringify(bundle, null, 2));
    files["feedback.md"] = strToU8(
        [
            `# Feedback on ${meta.appName ?? meta.project}`,
            "",
            ...annotations.map((a) => {
                const target = a.target.identity[0]?.selector ?? "";
                return `- **#${pinOf(a) ?? "?"}** ${a.comment} (\`${target}\` on ${a.route})`;
            }),
            "",
        ].join("\n")
    );
    return { zip: zipSync(files, { level: 6 }), bundle, name: `notato-${meta.project}-${id}.zip` };
}
