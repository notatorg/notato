import { expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { cleanupAfterEach } from "../../server/test/helpers.ts";
import { fakeManagedAuth } from "../../server/test/hosted-helpers.ts";
import { startServe } from "../../server/test/serve-helpers.ts";

const defer = cleanupAfterEach();
async function probe(port: number, trustProxy: boolean) {
    const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, "../src/main.ts"), "healthcheck"],
        {
            env: {
                ...process.env,
                NOTATO_PORT: String(port),
                NOTATO_TRUST_PROXY: trustProxy ? "1" : "0",
            },
            stdout: "ignore",
            stderr: "ignore",
        }
    );
    return child.exited;
}

it("probes hosted readiness through loopback without weakening HTTPS enforcement or masking database failures", async () => {
    process.env.NOTATO_PUBLIC_URL = "https://feedback.example.com";
    const s = await startServe(defer, {
        managedAuth: fakeManagedAuth(),
        trustProxy: true,
        allowedHosts: ["127.0.0.1"],
    });
    delete process.env.NOTATO_PUBLIC_URL;
    const port = s.rt.port;
    const url = `http://127.0.0.1:${port}`;
    expect((await fetch(`${url}/ready`)).status).toBe(400);
    expect(await probe(port, false)).toBe(1);
    expect(await probe(port, true)).toBe(0);
    const failing = spyOn(s.rt.store, "getWorkspace").mockImplementation(async () => {
        throw new Error("synthetic database outage");
    });
    try {
        expect(await probe(port, true)).toBe(1);
        expect((await fetch(`${url}/health`)).status).toBe(200);
    } finally {
        failing.mockRestore();
    }
});

it("keeps native local readiness working without proxy trust", async () => {
    const s = await startServe(defer);
    expect(await probe(s.rt.port, false)).toBe(0);
});
