import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectDeployment, readDeploymentEnv } from "../src/preflight.ts";
import { removeTempDirs, tempDir } from "./helpers.ts";

afterEach(removeTempDirs);
const config = {
    NOTATO_PUBLIC_URL: "http://localhost:4799",
    NOTATO_DATABASE_URL: "postgres://test:test@postgres/test",
    NOTATO_DATABASE_SSL: "disable",
    NOTATO_AUTH_SECRET: "synthetic-test-secret".repeat(3),
    NOTATO_ADMIN_EMAIL: "admin@example.test",
    NOTATO_ADMIN_PASSWORD: "test account password",
    NOTATO_S3_BUCKET: "screenshots",
    NOTATO_SMTP_HOST: "mailpit",
    NOTATO_EMAIL_FROM: "notato@example.test",
    NOTATO_PLUGIN_KEY: "ab".repeat(32),
};
describe("self-hosted deployment preflight", () => {
    it("accepts local infrastructure without SaaS credentials and never discloses secrets", () => {
        const report = inspectDeployment(config);
        expect(report.configurationValid).toBe(true);
        for (const value of [
            config.NOTATO_AUTH_SECRET,
            config.NOTATO_ADMIN_PASSWORD,
            config.NOTATO_DATABASE_URL,
            config.NOTATO_PLUGIN_KEY,
        ])
            expect(JSON.stringify(report)).not.toContain(value);
    });
    it("rejects missing authentication, incomplete credentials and invalid registration modes", () => {
        for (const change of [
            { NOTATO_AUTH_SECRET: "" },
            { NOTATO_SMTP_HOST: "" },
            { NOTATO_SIGNUP_MODE: "invalid" },
            { NOTATO_S3_ACCESS_KEY_ID: "unpaired" },
            { NOTATO_DATABASE_SSL: "prefer" },
        ])
            expect(inspectDeployment({ ...config, ...change }).configurationValid).toBe(false);
    });
    it("parses a private literal environment file without changing process environment or executing code", () => {
        const root = tempDir("notato-preflight-"),
            path = join(root, "service.env");
        writeFileSync(
            path,
            "# private\nNOTATO_PUBLIC_URL=https://notato.test\nNOTATO_AUTH_SECRET='secret#value' # comment\n",
            { mode: 0o600 }
        );
        const prior = process.env.NOTATO_AUTH_SECRET;
        expect(readDeploymentEnv(path)).toEqual({
            NOTATO_PUBLIC_URL: "https://notato.test",
            NOTATO_AUTH_SECRET: "secret#value",
        });
        expect(process.env.NOTATO_AUTH_SECRET).toBe(prior);
        writeFileSync(path, "NOTATO_SECRET=$(touch marker)\n");
        expect(() => readDeploymentEnv(path)).toThrow("expansion");
        writeFileSync(path, 'NOTATO_SECRET="PRIVATE_SECRET\n');
        try {
            readDeploymentEnv(path);
            throw new Error("expected rejection");
        } catch (e) {
            expect(String(e)).not.toContain("PRIVATE_SECRET");
        }
        chmodSync(path, 0o644);
        expect(() => readDeploymentEnv(path)).toThrow("private file permissions");
        symlinkSync(path, join(root, "link.env"));
        expect(() => readDeploymentEnv(join(root, "link.env"))).toThrow();
    });
});
