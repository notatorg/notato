import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { EXTENSION_ORIGIN, originAllowed, writeOriginRejected } from "@notato/server";

const manifest = JSON.parse(
    readFileSync(new URL("../manifest.json", import.meta.url), "utf8")
) as Record<string, unknown>;

/** The id Chrome gives an unpacked extension with this key: the first half of the key's SHA-256, written a to p. */
const idFromKey = (key: string) =>
    [...createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32)]
        .map((c) => String.fromCharCode(97 + Number.parseInt(c, 16)))
        .join("");

describe("the manifest", () => {
    it("is Manifest V3, with a background worker and a popup", () => {
        expect(manifest.manifest_version).toBe(3);
        expect(manifest.background).toEqual({ service_worker: "background.js", type: "module" });
        expect((manifest.action as { default_popup: string }).default_popup).toBe("popup.html");
    });

    it("asks for as little as it can: scripting and storage, the machine's own servers, and the rest only when a site is turned on", () => {
        expect(manifest.permissions).toEqual(["scripting", "storage"]);
        expect(manifest.host_permissions).toEqual([
            "http://localhost/*",
            "http://127.0.0.1/*",
            "http://[::1]/*",
        ]);
        expect(manifest.optional_host_permissions).toEqual(["http://*/*", "https://*/*"]);
        const text = JSON.stringify(manifest);
        for (const broad of ["<all_urls>", '"tabs"', '"webRequest"', '"cookies"', '"history"'])
            expect(text, broad).not.toContain(broad);
    });

    it("has no content scripts of its own: it loads itself only where a person turned it on", () => {
        expect(manifest.content_scripts).toBeUndefined();
    });

    it("has the public key that gives it the id the server accepts, and a version", () => {
        expect(idFromKey(manifest.key as string)).toBe(
            EXTENSION_ORIGIN.replace("chrome-extension://", "")
        );
        expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    });
});

describe("the server and this extension", () => {
    it("accepts its writes by default, and no other extension's", () => {
        const write = (origin: string) =>
            new Request("http://localhost:4747/projects/p/annotations", {
                method: "POST",
                headers: { origin },
            });
        expect(originAllowed(EXTENSION_ORIGIN, [])).toBe(true);
        expect(writeOriginRejected(write(EXTENSION_ORIGIN), [])).toBe(false);
        expect(
            writeOriginRejected(write("chrome-extension://abcdefghijklmnopabcdefghijklmnop"), [])
        ).toBe(true);
        expect(writeOriginRejected(write("https://evil.example"), [])).toBe(true);
        // A store build has its own id, which is listed like any other origin.
        expect(
            writeOriginRejected(write("chrome-extension://abcdefghijklmnopabcdefghijklmnop"), [
                "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
            ])
        ).toBe(false);
    });
});
