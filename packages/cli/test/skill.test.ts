import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInit } from "../src/commands/init.ts";
import { runRevert } from "../src/commands/revert.ts";
import { CRITIQUE_SKILL_PATH, renderSkill, SKILL_PATH, SKILLS, skillState } from "../src/skill.ts";

// Init sets up the agents it finds on this machine; these tests are about Claude Code unless they say otherwise.
process.env.NOTATO_AGENTS = "claude";

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function app(extra: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "notato-skill-"));
    dirs.push(dir);
    const files: Record<string, string> = {
        "package.json": JSON.stringify({
            name: "shop",
            dependencies: { react: "^19" },
            devDependencies: { vite: "^8", "@notato/react": "^0.1.0" },
        }),
        "index.html": '<div id="root"></div><script type="module" src="/src/main.tsx"></script>',
        "src/main.tsx": 'import { App } from "./App"\ncreateRoot(el).render(<App />)\n',
        ".gitignore": "node_modules\n",
        ...extra,
    };
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
    }
    return dir;
}
const skillFile = (dir: string) => join(dir, SKILL_PATH);

describe("the skill text", () => {
    const text = renderSkill();
    it("is a Claude Code skill: name and description in frontmatter", () => {
        expect(text.startsWith("---\nname: notato\ndescription: ")).toBe(true);
        expect(text.split("---")[1]).toContain("USE FOR:");
    });
    it("teaches the loop, one commit per annotation with only its own files, and the revert flow", () => {
        for (const phrase of [
            "notato_watch",
            "notato_acknowledge",
            "notato_resolve",
            "the files you changed, and the commit",
            "one commit per annotation",
            "never `git add -A`",
            "REVERT REQUESTED",
            "git revert --no-edit",
            "notato_reverted",
        ])
            expect(text, phrase).toContain(phrase);
    });
    it("teaches what each intent means: a question gets an answer and no edit", () => {
        for (const phrase of [
            "**fix**",
            "**change**",
            "**question**",
            "answer, not an edit",
            "Do not change any code",
            "**approve**",
            "No change needed",
            "component path",
            "`detail` level",
        ])
            expect(text, phrase).toContain(phrase);
    });
    it("only names tools that exist", () => {
        for (const [, tool] of text.matchAll(/`(notato_[a-z_]+)`/g)) {
            expect(
                [
                    "notato_watch",
                    "notato_list_open",
                    "notato_get",
                    "notato_acknowledge",
                    "notato_reply",
                    "notato_resolve",
                    "notato_dismiss",
                    "notato_reverted",
                    "notato_variants_ready",
                ],
                tool
            ).toContain(tool as string);
        }
    });
    it("teaches the variants workflow: markers, scaffolding that is removed, the pick, and a follow-up", () => {
        for (const phrase of [
            "## Variants",
            'data-notato-variant="header"',
            "data-notato-variant-name",
            "do not commit yet",
            "notato_variants_ready",
            "window.__notato.variants.list()",
            "**VARIANT CHOSEN**",
            "remove every wrapper element and both attributes",
            "**FOLLOW-UP**",
            "## When the person writes back",
        ])
            expect(text, phrase).toContain(phrase);
    });
});

describe("the critique skill", () => {
    const text = renderSkill("notato-critique");
    it("is its own skill, with its own name and a way to be asked for", () => {
        expect(text.startsWith("---\nname: notato-critique\ndescription: ")).toBe(true);
        expect(text.split("---")[1]).toContain("/notato-critique");
        expect(text).not.toBe(renderSkill());
    });
    it("tells Claude to check Notato is there, to file a handful, and how", () => {
        for (const phrase of [
            "typeof window.__notato",
            "between five and eight",
            "window.__notato.annotate",
            "notato_annotate",
            'intent: "fix"',
            "`question`",
            "notato_list_open",
            "`notato` skill",
        ])
            expect(text, phrase).toContain(phrase);
    });
    it("only names tools that exist, and only options annotate has", () => {
        const tools = ["notato_annotate", "notato_list_open"];
        for (const [, tool] of text.matchAll(/`(notato_[a-z_]+)`/g))
            expect(tools, tool).toContain(tool as string);
        for (const field of ["target", "comment", "severity", "intent"])
            expect(text).toContain(`${field}:`);
    });
    it("is told apart from the main skill, so the right one is picked", () => {
        expect(renderSkill().split("---")[1]).toContain("DO NOT USE FOR");
        expect(renderSkill().split("---")[1]).toContain("notato-critique skill");
        expect(text.split("---")[1]).toContain("DO NOT USE FOR");
    });
    it("the same fingerprint scheme tells it from an edited one", () => {
        expect(skillState(text, "notato-critique")).toBe("current");
        expect(skillState(`${text}\nours\n`, "notato-critique")).toBe("edited");
    });
    it("every skill has a path under .claude/skills/<name>/SKILL.md", () => {
        for (const s of SKILLS) expect(s.path).toBe(`.claude/skills/${s.name}/SKILL.md`);
        expect(SKILLS.map((s) => s.path)).toEqual([SKILL_PATH, CRITIQUE_SKILL_PATH]);
    });
});

describe("skillState", () => {
    it("tells the file init writes from an older one and from an edited one", () => {
        expect(skillState(renderSkill())).toBe("current");
        expect(skillState(`${renderSkill()}\nmy own note\n`)).toBe("edited");
        expect(skillState(renderSkill().replace("smallest change", "tiniest change"))).toBe(
            "edited"
        );
        expect(skillState("---\nname: notato\n---\nwritten by hand\n")).toBe("edited");
        // What an older version would have written: a different body with its own fingerprint.
        const { createHash } = require("node:crypto") as typeof import("node:crypto");
        const body = "---\nname: notato\n---\nthe old text\n";
        const old = `${body}\n<!-- notato-skill:${createHash("sha256").update(body).digest("hex").slice(0, 16)} -->\n`;
        expect(skillState(old)).toBe("outdated");
    });

    it("reads a CRLF checkout (core.autocrlf) as the same file, not an edited one", () => {
        const crlf = (text: string) => text.replace(/\n/g, "\r\n");
        expect(skillState(crlf(renderSkill()))).toBe("current");
        expect(skillState(crlf(renderSkill("notato-critique")), "notato-critique")).toBe("current");
        const { createHash } = require("node:crypto") as typeof import("node:crypto");
        const body = "---\nname: notato\n---\nthe old text\n";
        const old = `${body}\n<!-- notato-skill:${createHash("sha256").update(body).digest("hex").slice(0, 16)} -->\n`;
        expect(skillState(crlf(old))).toBe("outdated");
        expect(skillState(crlf(`${renderSkill()}\nmy own note\n`))).toBe("edited");
    });
});

describe("init writes the skill", () => {
    it("creates it where the agent starts, and says what it is for", async () => {
        const dir = app();
        const report = await runInit({ cwd: dir, mcp: false });
        expect(readFileSync(skillFile(dir), "utf8")).toBe(renderSkill());
        const row = report.changes.find((c) => c.file === SKILL_PATH);
        expect(row).toMatchObject({ action: "created" });
        expect(row?.note).toContain("watch Notato");
        expect(readFileSync(join(dir, CRITIQUE_SKILL_PATH), "utf8")).toBe(
            renderSkill("notato-critique")
        );
        expect(report.changes.find((c) => c.file === CRITIQUE_SKILL_PATH)?.note).toContain(
            "review the running app"
        );
    });

    it("leaves a critique skill someone edited, and still writes the other", async () => {
        const dir = app({ [CRITIQUE_SKILL_PATH]: "---\nname: notato-critique\n---\nours\n" });
        const report = await runInit({ cwd: dir, mcp: false });
        expect(readFileSync(join(dir, CRITIQUE_SKILL_PATH), "utf8")).toContain("ours");
        expect(report.changes.find((c) => c.file === CRITIQUE_SKILL_PATH)?.note).toContain(
            "edited"
        );
        expect(readFileSync(skillFile(dir), "utf8")).toBe(renderSkill());
    });

    it("is idempotent", async () => {
        const dir = app();
        await runInit({ cwd: dir, mcp: false });
        const again = await runInit({ cwd: dir, mcp: false });
        expect(again.changes.find((c) => c.file === SKILL_PATH)).toMatchObject({
            action: "unchanged",
        });
    });

    it("--no-skill writes nothing, and --dry-run writes nothing either", async () => {
        const off = app();
        const report = await runInit({ cwd: off, mcp: false, skill: false });
        expect(existsSync(skillFile(off))).toBe(false);
        expect(report.changes.some((c) => c.file === SKILL_PATH)).toBe(false);
        const dry = app();
        const planned = await runInit({ cwd: dry, mcp: false, dryRun: true });
        expect(existsSync(skillFile(dry))).toBe(false);
        expect(planned.changes.find((c) => c.file === SKILL_PATH)).toMatchObject({
            action: "created",
        });
    });

    it("updates a file an older version wrote, and leaves one a person edited", async () => {
        const { createHash } = require("node:crypto") as typeof import("node:crypto");
        const body = "---\nname: notato\n---\nthe old text\n";
        const old = `${body}\n<!-- notato-skill:${createHash("sha256").update(body).digest("hex").slice(0, 16)} -->\n`;
        const stale = app({ [SKILL_PATH]: old });
        const updated = await runInit({ cwd: stale, mcp: false });
        expect(readFileSync(skillFile(stale), "utf8")).toBe(renderSkill());
        expect(updated.changes.find((c) => c.file === SKILL_PATH)).toMatchObject({
            action: "edited",
        });

        const mine = app({ [SKILL_PATH]: "---\nname: notato\n---\nour own rules\n" });
        const kept = await runInit({ cwd: mine, mcp: false });
        expect(readFileSync(skillFile(mine), "utf8")).toContain("our own rules");
        const row = kept.changes.find((c) => c.file === SKILL_PATH);
        expect(row).toMatchObject({ action: "unchanged" });
        expect(row?.note).toContain("edited");
    });

    it("leaves the repo's other skills alone", async () => {
        const aspire = "---\nname: aspire\n---\nAspire notes\n";
        const dir = app({ ".claude/skills/aspire/SKILL.md": aspire });
        await runInit({ cwd: dir, mcp: false });
        expect(readFileSync(join(dir, ".claude/skills/aspire/SKILL.md"), "utf8")).toBe(aspire);
    });

    it("goes where Claude Code starts, not into the app, when they differ", async () => {
        const root = mkdtempSync(join(tmpdir(), "notato-skill-root-"));
        dirs.push(root);
        mkdirSync(join(root, ".git"));
        mkdirSync(join(root, "web/src"), { recursive: true });
        writeFileSync(
            join(root, "web/package.json"),
            JSON.stringify({
                name: "web",
                dependencies: { react: "^19" },
                devDependencies: { vite: "^8" },
            })
        );
        writeFileSync(
            join(root, "web/index.html"),
            '<script type="module" src="/src/main.tsx"></script>'
        );
        writeFileSync(join(root, "web/src/main.tsx"), "render(<App />)\n");
        await runInit({ cwd: join(root, "web"), claudeDir: "..", mcp: false });
        expect(existsSync(join(root, SKILL_PATH))).toBe(true);
        expect(existsSync(join(root, "web", SKILL_PATH))).toBe(false);
    });
});

describe("init --revert and the skill", () => {
    it("removes the file init wrote, and the folders that leaves empty", async () => {
        const dir = app();
        await runInit({ cwd: dir, mcp: false });
        const report = await runRevert({ cwd: dir, mcp: false });
        expect(existsSync(skillFile(dir))).toBe(false);
        expect(existsSync(join(dir, CRITIQUE_SKILL_PATH))).toBe(false);
        expect(existsSync(join(dir, ".claude"))).toBe(false);
        expect(report.changes.find((c) => c.file === SKILL_PATH)).toMatchObject({
            action: "deleted",
        });
        expect(report.changes.find((c) => c.file === CRITIQUE_SKILL_PATH)).toMatchObject({
            action: "deleted",
        });
    });

    it("keeps .claude/skills when another skill lives in it", async () => {
        const dir = app({ ".claude/skills/aspire/SKILL.md": "---\nname: aspire\n---\n" });
        await runInit({ cwd: dir, mcp: false });
        await runRevert({ cwd: dir, mcp: false });
        expect(existsSync(join(dir, ".claude/skills/aspire/SKILL.md"))).toBe(true);
        expect(existsSync(join(dir, ".claude/skills/notato"))).toBe(false);
    });

    it("leaves a skill someone edited, and says so", async () => {
        const dir = app();
        await runInit({ cwd: dir, mcp: false });
        writeFileSync(skillFile(dir), `${renderSkill()}\nOur team rule: always squash.\n`);
        const report = await runRevert({ cwd: dir, mcp: false });
        expect(readFileSync(skillFile(dir), "utf8")).toContain("always squash");
        expect(report.notes.join("\n")).toContain("has been edited");
    });

    it("--dry-run removes nothing", async () => {
        const dir = app();
        await runInit({ cwd: dir, mcp: false });
        await runRevert({ cwd: dir, mcp: false, dryRun: true });
        expect(existsSync(skillFile(dir))).toBe(true);
    });

    it("init then revert leaves the project exactly as it started", async () => {
        const before = {
            main: 'import { App } from "./App"\ncreateRoot(el).render(<App />)\n',
            ignore: "node_modules\n",
        };
        const dir = app();
        await runInit({ cwd: dir, mcp: false });
        await runRevert({ cwd: dir, mcp: false });
        expect(readFileSync(join(dir, "src/main.tsx"), "utf8")).toBe(before.main);
        expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(before.ignore);
        expect(existsSync(join(dir, ".claude"))).toBe(false);
    });
});
