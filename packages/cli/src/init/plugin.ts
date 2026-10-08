import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
    type AppInfo,
    dependsOn,
    describeApp,
    discoverApps,
    readJson,
    viteConfigFile,
} from "../discover.ts";
import { resolveStyle } from "../style.ts";
import type { InitReport } from "./report.ts";
import { addToViteConfig } from "./transforms.ts";

// The Vite plugin (@notato/vite), for the exact file and line of an element even in a built app.

/**
 * The apps the plugin goes into: the one named with `--app`, this one, or every Vite app below. In a repo of several
 * apps it goes into each, since each module is built on its own.
 */
export function pluginTargets(app: string | undefined, root: string): AppInfo[] {
    if (app) {
        const named = describeApp(resolve(root, app), root);
        if (!named) throw new Error(`${app} is not a React app`);
        return [named];
    }
    const self = describeApp(root, root);
    if (self) return [self];
    return discoverApps(root).filter((a) => a.framework === "vite");
}

/** Adds `notatoSource()` to each app's Vite config, and says what it could not do. */
export function wirePlugin(apps: AppInfo[], root: string, dryRun: boolean, report: InitReport) {
    if (apps.length === 0) report.warnings.push("no Vite app found to wire the plugin into");
    for (const app of apps) {
        const shown = (file: string) => relative(root, join(app.dir, file)) || file;
        if (app.framework !== "vite") {
            report.notes.push(`${app.rel}: the Vite plugin is for Vite apps, so it was skipped`);
            continue;
        }
        const configName = viteConfigFile(app.dir);
        if (!configName) {
            report.warnings.push(
                `${app.rel}: no vite.config found; add notatoSource() from @notato/vite to its plugins yourself`
            );
            continue;
        }
        const path = join(app.dir, configName);
        const source = readFileSync(path, "utf8");
        const edit = addToViteConfig(source, resolveStyle(source, app.dir));
        if (edit.changed && !dryRun) writeFileSync(path, edit.source);
        report.changes.push({
            file: shown(configName),
            action: edit.changed ? "edited" : "unchanged",
            note: edit.reason ?? edit.note ?? (edit.changed ? "adds notatoSource()" : undefined),
        });
        if (!edit.changed && edit.reason && edit.reason !== "already set up") {
            report.warnings.push(`${shown(configName)}: ${edit.reason}`);
        }
        const pkg = readJson(join(app.dir, "package.json"));
        if (pkg && !dependsOn(pkg, "@notato/vite")) {
            report.warnings.push(
                `@notato/vite is not in ${shown("package.json")}; install it there with: npm i -D @notato/vite`
            );
        }
    }
}
