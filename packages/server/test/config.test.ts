import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    CONFIG_FILE,
    createConfigSource,
    parseConfig,
    parseOnOff,
    readConfigFile,
    writeSetting,
} from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), "notato-config-"));
    dirs.push(dir);
    return dir;
};

describe("parseOnOff", () => {
    it("takes the spellings people reach for", () => {
        for (const on of ["on", "ON", "true", "yes", "1", true, 1, "enabled"])
            expect(parseOnOff(on), String(on)).toBe(true);
        for (const off of ["off", "Off", "false", "no", "0", false, 0, "disabled"])
            expect(parseOnOff(off), String(off)).toBe(false);
        for (const bad of ["maybe", "", 2, null, undefined, {}])
            expect(parseOnOff(bad), String(bad)).toBeNull();
    });
});

describe("parseConfig", () => {
    it("reads settings", () => {
        expect(parseConfig('{ "screenshots": "off" }')).toEqual({
            values: { screenshots: false },
            webhooks: [],
        });
        expect(parseConfig('{ "screenshots": true }')).toEqual({
            values: { screenshots: true },
            webhooks: [],
        });
        expect(parseConfig("{}")).toEqual({ values: {}, webhooks: [] });
    });
    it("names the problem, so a typo is not silently ignored", () => {
        expect(parseConfig('{ "screenshot": "off" }').error).toContain(
            'unknown setting "screenshot" (known: screenshots, mcp, webhooks)'
        );
        expect(parseConfig('{ "screenshots": "sometimes" }').error).toContain(
            'must be "on" or "off"'
        );
        expect(parseConfig("[]").error).toContain("JSON object");
        expect(parseConfig("{ nope").error).toContain("not valid JSON");
    });
});

describe("createConfigSource", () => {
    it("is all defaults without a file", () => {
        const config = createConfigSource({ file: join(tmp(), CONFIG_FILE), env: {} })();
        expect(config).toMatchObject({ screenshots: true, source: { screenshots: "default" } });
        expect(config.file).toBeUndefined();
    });

    it("reads the file", () => {
        const file = join(tmp(), CONFIG_FILE);
        writeFileSync(file, '{ "screenshots": "off" }');
        expect(createConfigSource({ file, env: {} })()).toMatchObject({
            screenshots: false,
            source: { screenshots: "file" },
            file,
        });
    });

    it("lets the environment win over the file", () => {
        const file = join(tmp(), CONFIG_FILE);
        writeFileSync(file, '{ "screenshots": "off" }');
        expect(createConfigSource({ file, env: { NOTATO_SCREENSHOTS: "on" } })()).toMatchObject({
            screenshots: true,
            source: { screenshots: "env" },
        });
        expect(
            createConfigSource({
                file: join(tmp(), "none.json"),
                env: { NOTATO_SCREENSHOTS: "off" },
            })()
        ).toMatchObject({
            screenshots: false,
            source: { screenshots: "env" },
        });
    });

    it("applies a change to the file without a restart", () => {
        const file = join(tmp(), CONFIG_FILE);
        const config = createConfigSource({ file, env: {} });
        expect(config().screenshots).toBe(true);
        writeFileSync(file, '{ "screenshots": "off" }');
        expect(config().screenshots).toBe(false);
        writeFileSync(file, '{"screenshots":"on", "x": 1}'); // broken now
        expect(config().error).toContain("unknown setting");
        writeFileSync(file, '{ "screenshots": "on" }');
        expect(config()).toMatchObject({ screenshots: true });
        expect(config().error).toBeUndefined();
    });

    it("fails closed: a broken file means no screenshots, never all of them", () => {
        const file = join(tmp(), CONFIG_FILE);
        writeFileSync(file, '{ "screenshots": "off", }'); // trailing comma
        const config = createConfigSource({ file, env: {} })();
        expect(config.screenshots).toBe(false);
        expect(config.error).toContain("not valid JSON");
        expect(config.file).toBe(file);
    });

    it("still lets the environment decide when the file is broken", () => {
        const file = join(tmp(), CONFIG_FILE);
        writeFileSync(file, "{ nope");
        expect(createConfigSource({ file, env: { NOTATO_SCREENSHOTS: "on" } })()).toMatchObject({
            screenshots: true,
        });
    });

    it("notices when the environment changes, not only the file", () => {
        const env: Record<string, string | undefined> = {};
        const config = createConfigSource({ file: join(tmp(), CONFIG_FILE), env });
        expect(config().screenshots).toBe(true);
        env.NOTATO_SCREENSHOTS = "off";
        expect(config().screenshots).toBe(false);
    });
});

describe("writeSetting", () => {
    it("creates the file, and removing the last setting leaves an empty one", () => {
        const file = join(tmp(), CONFIG_FILE);
        writeSetting(file, "screenshots", false);
        expect(readFileSync(file, "utf8")).toBe('{\n  "screenshots": "off"\n}\n');
        expect(readConfigFile(file)).toEqual({ screenshots: false });
        writeSetting(file, "screenshots", true);
        expect(readConfigFile(file)).toEqual({ screenshots: true });
        writeSetting(file, "screenshots", null);
        expect(readConfigFile(file)).toEqual({});
    });

    it("refuses to overwrite a file it cannot read", () => {
        const file = join(tmp(), CONFIG_FILE);
        writeFileSync(file, "{ my notes }");
        expect(() => writeSetting(file, "screenshots", false)).toThrow("not valid JSON");
        expect(readFileSync(file, "utf8")).toBe("{ my notes }");
    });
});
