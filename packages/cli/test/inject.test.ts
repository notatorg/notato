import { describe, expect, it } from "bun:test";
import { runInject } from "../src/commands/inject.ts";

describe("notato inject", () => {
    it("prints the three ways, for the server on this machine", () => {
        const r = runInject([], {});
        expect(r.code).toBe(0);
        expect(r.stdout).toContain("http://127.0.0.1:4747/bookmarklet");
        expect(r.stdout).toContain('<script src="http://127.0.0.1:4747/inject.js"></script>');
        expect(r.stdout).toContain("javascript:(function(){");
        expect(r.stdout).toContain("each page's own host and port as its project");
        expect(r.stdout).toContain("--cors-origin");
    });

    it("follows $NOTATO_PORT, --server, --project and a token, for every way", () => {
        const r = runInject(["--project", "shop", "--token", "pft_abc"], { NOTATO_PORT: "5050" });
        expect(r.stdout).toContain("http://127.0.0.1:5050/bookmarklet?project=shop&token=pft_abc");
        expect(r.stdout).toContain("inject.js?project=shop&token=pft_abc");
        expect(r.stdout).toContain('as project "shop"');
        const other = runInject(["--server", "http://192.168.1.5:4747/"], {});
        expect(other.stdout).toContain("http://192.168.1.5:4747/bookmarklet");
        expect(runInject([], { NOTATO_TOKEN: "pft_env" }).stdout).toContain("token=pft_env");
    });

    it("says what is wrong with a project id or a server address, as a usage error", () => {
        expect(runInject(["--project", "has space"], {})).toMatchObject({ code: 2 });
        expect(runInject(["--project", "has space"], {}).stderr).toContain("is not a project id");
        // The server refuses an id of only dots, so a bookmark with one would do nothing.
        expect(runInject(["--project", ".."], {})).toMatchObject({ code: 2 });
        expect(runInject(["--server", "not a url"], {})).toMatchObject({ code: 2 });
        expect(runInject(["--bogus"], {}).code).toBe(2);
    });

    it("--help describes it", () => {
        const r = runInject(["--help"]);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain("no install in the app");
    });
});
