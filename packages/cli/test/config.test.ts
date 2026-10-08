import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runConfig } from "../src/commands/config.ts";
import { removeTempDirs, tempDir } from "./helpers.ts";

afterEach(removeTempDirs);
const tmp = () => tempDir("notato-cfg-");
const run = (dir: string, args: string[], env: Record<string, string | undefined> = {}) =>
    runConfig(args, env, dir);
const fileOf = (dir: string) => join(dir, "notato.config.json");

describe("notato config", () => {
    it("shows every setting with its value and where it comes from", () => {
        const dir = tmp();
        const shown = run(dir, []);
        expect(shown.code).toBe(0);
        expect(shown.stdout).toContain("screenshots");
        expect(shown.stdout).toMatch(/screenshots\s+on\s+\(default\)/);
        expect(shown.stdout).toContain("not created yet");
    });

    it("set writes the file, and show and get then read it back", () => {
        const dir = tmp();
        const set = run(dir, ["set", "screenshots", "off"]);
        expect(set.code).toBe(0);
        expect(set.stdout).toContain("screenshots is now off");
        expect(JSON.parse(readFileSync(fileOf(dir), "utf8"))).toEqual({ screenshots: "off" });
        expect(run(dir, ["get", "screenshots"]).stdout).toBe("off");
        expect(run(dir, []).stdout).toMatch(/screenshots\s+off\s+\(file\)/);
        run(dir, ["set", "screenshots", "on"]);
        expect(run(dir, ["get", "screenshots"]).stdout).toBe("on");
    });

    it("unset puts the default back, and says so when there was nothing to remove", () => {
        const dir = tmp();
        run(dir, ["set", "screenshots", "off"]);
        expect(run(dir, ["unset", "screenshots"]).stdout).toContain("removed");
        expect(run(dir, ["get", "screenshots"]).stdout).toBe("on");
        expect(run(dir, ["unset", "screenshots"]).stdout).toContain("was not set");
    });

    it("rejects a setting or value it does not know, as a usage error", () => {
        const dir = tmp();
        const typo = run(dir, ["set", "screenshot", "off"]);
        expect(typo.code).toBe(2);
        expect(typo.stderr).toContain('unknown setting "screenshot"');
        expect(typo.stderr).toContain("screenshots");
        const value = run(dir, ["set", "screenshots", "sometimes"]);
        expect(value.code).toBe(2);
        expect(value.stderr).toContain('must be "on" or "off"');
        expect(run(dir, ["set", "screenshots"]).code).toBe(2);
        expect(run(dir, ["frobnicate"]).code).toBe(2);
        expect(existsSync(fileOf(dir))).toBe(false);
    });

    it("says when the environment overrides the file", () => {
        const dir = tmp();
        const set = run(dir, ["set", "screenshots", "off"], { NOTATO_SCREENSHOTS: "on" });
        expect(set.stdout).toContain("NOTATO_SCREENSHOTS is set to on");
        const shown = run(dir, [], { NOTATO_SCREENSHOTS: "on" });
        expect(shown.stdout).toMatch(/screenshots\s+on\s+\(\$NOTATO_SCREENSHOTS\)/);
    });

    it("reports a broken file and fails, and will not overwrite it", () => {
        const dir = tmp();
        writeFileSync(fileOf(dir), '{ "screenshot": "off" }');
        const shown = run(dir, []);
        expect(shown.code).toBe(1);
        expect(shown.stderr).toContain('unknown setting "screenshot"');
        expect(shown.stderr).toContain("every setting as off");
        const set = run(dir, ["set", "screenshots", "off"]);
        expect(set.code).toBe(1);
        expect(readFileSync(fileOf(dir), "utf8")).toBe('{ "screenshot": "off" }');
    });

    it("--file and $NOTATO_CONFIG choose another file", () => {
        const dir = tmp();
        const other = join(dir, "team.json");
        run(dir, ["set", "screenshots", "off", "--file", other]);
        expect(existsSync(fileOf(dir))).toBe(false);
        expect(JSON.parse(readFileSync(other, "utf8"))).toEqual({ screenshots: "off" });
        expect(run(dir, ["get", "screenshots"], { NOTATO_CONFIG: other }).stdout).toBe("off");
    });

    it("--help describes the settings", () => {
        const help = run(tmp(), ["--help"]);
        expect(help.code).toBe(0);
        expect(help.stdout).toContain("notato config set <name> <on|off>");
        expect(help.stdout).toContain("NOTATO_SCREENSHOTS");
        expect(help.stdout).toContain("screenshots={false}");
    });
});
