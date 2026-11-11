import { expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const base = join(root, "deploy/self-hosted");
const pages = [
    join(base, "README.md"),
    ...readdirSync(join(base, "docs")).map((f) => join(base, "docs", f)),
];
const slug = (heading: string) =>
    heading
        .toLowerCase()
        .replace(/[`*]/g, "")
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .trim()
        .replace(/\s/g, "-");
const anchors = (file: string) =>
    new Set(
        [...readFileSync(file, "utf8").matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1] ?? ""))
    );

it("every relative link in the self-hosting guides points at a file and heading that exist", () => {
    const broken: string[] = [];
    for (const page of pages)
        for (const [, target] of readFileSync(page, "utf8").matchAll(
            /\]\((?!https?:|mailto:)([^)\s]+)\)/g
        )) {
            const [path = "", hash] = (target ?? "").split("#");
            const file = path ? resolve(dirname(page), path) : page;
            if (!existsSync(file)) broken.push(`${page.replace(root, "")}: ${target}`);
            else if (hash && file.endsWith(".md") && !anchors(file).has(hash))
                broken.push(`${page.replace(root, "")}: ${target} (no such heading)`);
        }
    expect(broken).toEqual([]);
});

it("the Compose file lets each bundled service be switched off by profile, and requires nothing for them", () => {
    const compose = Bun.YAML.parse(readFileSync(join(base, "compose.yml"), "utf8")) as {
        services: Record<string, { profiles?: string[] }>;
    };
    for (const [service, profile] of [
        ["postgres", "db"],
        ["objects", "storage"],
        ["mailpit", "mail"],
    ] as const) {
        const bundled = compose.services[service];
        expect(bundled?.profiles).toEqual([profile]);
        // Required settings on a switched-off service would block users bringing their own.
        expect(JSON.stringify(bundled)).not.toContain(":?");
    }
    expect(readFileSync(join(base, "init.ts"), "utf8")).toContain(
        "COMPOSE_PROFILES=db,storage,mail"
    );
});
