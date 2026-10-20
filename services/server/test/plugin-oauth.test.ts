import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { Providers } from "../src/plugins/providers.ts";
import { pluginsFor } from "../src/routes/plugins.ts";
import { cleanupAfterEach } from "./helpers.ts";
import { customer, fakeManagedAuth } from "./hosted-helpers.ts";
import { startServe } from "./serve-helpers.ts";

const defer = cleanupAfterEach();
for (const provider of ["github", "azure", "slack", "linear", "gitlab"] as const) {
    it(`exercises ${provider} OAuth redirects, scoped callbacks and coordinated refresh without provider traffic`, async () => {
        const names = [
            `NOTATO_${provider.toUpperCase()}_CLIENT_ID`,
            `NOTATO_${provider.toUpperCase()}_CLIENT_SECRET`,
        ];
        const previous = names.map((n) => process.env[n]);
        names.forEach((name, i) => {
            process.env[name] = i === 0 ? "synthetic-app-id" : "synthetic-client-secret";
        });
        defer(() =>
            names.forEach((name, i) => {
                if (previous[i] === undefined) delete process.env[name];
                else process.env[name] = previous[i];
            })
        );
        const exchanges: URLSearchParams[] = [];
        const options = {
            key: Buffer.alloc(32, 9),
            providers: new Providers(async () =>
                Response.json({ id: 1, ok: true, data: { viewer: { id: "synthetic-viewer" } } })
            ),
            oauthHttp: async (_url: string, init?: RequestInit) => {
                const fields = new URLSearchParams(String(init?.body));
                exchanges.push(fields);
                const refresh = fields.get("grant_type") === "refresh_token";
                return Response.json({
                    access_token: `${provider}-${refresh ? "renewed" : "access"}-token`,
                    refresh_token: `${provider}-${refresh ? "next" : "initial"}-refresh`,
                    expires_in: refresh ? 3600 : 1,
                });
            },
        };
        const s = await startServe(defer, {
            managedAuth: fakeManagedAuth(),
            testPlans: true,
            plugins: options,
        });
        const alice = await customer(s, "alice"),
            bob = await customer(s, "bob");
        const board = { cookie: alice.cookie, "x-notato-board": "1" };
        const me = (await (await s.call("/auth/me", { headers: board })).json()) as {
            workspace: { id: string };
        };
        const start = await s.call(`/plugins/oauth/${provider}/start`, {
            headers: board,
            redirect: "manual",
        });
        expect(start.status).toBe(303);
        const authorize = new URL(start.headers.get("location") ?? "");
        expect(authorize.protocol).toBe("https:");
        expect(authorize.searchParams.get("client_id")).toBe("synthetic-app-id");
        expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
        expect(authorize.href).not.toContain("synthetic-client-secret");
        if (provider === "github")
            expect(authorize.searchParams.get("scope")).toBe("offline_access");
        const state = authorize.searchParams.get("state");
        const callback = `/plugins/oauth/callback?state=${state}&code=synthetic-single-use-code`;
        const foreign = await s.call(callback, {
            headers: { cookie: bob.cookie },
            redirect: "manual",
        });
        expect(foreign.status).toBe(400);
        expect(exchanges).toHaveLength(0);
        const success = await s.call(callback, { headers: board, redirect: "manual" });
        expect(success.status).toBe(303);
        expect(success.headers.get("location")).toStartWith(`${s.base}/#/x/plugins/setup/`);
        expect(success.headers.get("cache-control")).toBe("no-store");
        expect(exchanges).toHaveLength(1);
        const verifier = exchanges[0]?.get("code_verifier");
        if (!verifier) throw new Error("missing verifier");
        expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
            authorize.searchParams.get("code_challenge") ?? ""
        );
        expect(exchanges[0]?.get("redirect_uri")).toBe(authorize.searchParams.get("redirect_uri"));
        expect((await s.call(callback, { headers: board, redirect: "manual" })).status).toBe(400);
        expect(exchanges).toHaveLength(1);
        const service = pluginsFor(s.rt.backend, s.base, options);
        const c = (await service.ready().repository.connections(me.workspace.id))[0];
        if (!c) throw new Error("missing connection");
        expect(c.provider).toBe(provider);
        expect(c.encrypted).not.toContain(`${provider}-access-token`);
        const values = await Promise.all([service.secret(c), service.secret(c)]);
        expect(values.map((v) => v.token)).toEqual([
            `${provider}-renewed-token`,
            `${provider}-renewed-token`,
        ]);
        expect(exchanges).toHaveLength(2);
        expect(exchanges[1]?.get("refresh_token")).toBe(`${provider}-initial-refresh`);
        const listing = await (await s.call("/plugins", { headers: board })).text();
        for (const secret of [
            "synthetic-client-secret",
            `${provider}-access-token`,
            `${provider}-renewed-token`,
            `${provider}-initial-refresh`,
            `${provider}-next-refresh`,
        ])
            expect(listing).not.toContain(secret);
        const reconnect = await s.call(`/plugins/oauth/${provider}/start?connection=${c.id}`, {
            headers: board,
            redirect: "manual",
        });
        const reconnectState = new URL(reconnect.headers.get("location") ?? "").searchParams.get(
            "state"
        );
        const restored = await s.call(
            `/plugins/oauth/callback?state=${reconnectState}&code=synthetic-reconnect-code`,
            { headers: board, redirect: "manual" }
        );
        expect(restored.status).toBe(303);
        expect(restored.headers.get("location")).toBe(`${s.base}/#/x/plugins/reconnected/${c.id}`);
        expect(await service.ready().repository.connections(me.workspace.id)).toHaveLength(1);
        expect(
            (await service.ready().repository.connection(me.workspace.id, c.id))?.revision
        ).not.toBe(c.revision);
        const beforeCancel = (await service.ready().repository.connection(me.workspace.id, c.id))
            ?.revision;
        const cancelStart = await s.call(`/plugins/oauth/${provider}/start?connection=${c.id}`, {
            headers: board,
            redirect: "manual",
        });
        const cancelState = new URL(cancelStart.headers.get("location") ?? "").searchParams.get(
            "state"
        );
        const canceled = await s.call(
            `/plugins/oauth/callback?state=${cancelState}&error=access_denied`,
            { headers: board, redirect: "manual" }
        );
        expect(canceled.status).toBe(303);
        expect(canceled.headers.get("location")).toBe(
            `${s.base}/#/x/plugins/authorization-canceled`
        );
        expect((await service.ready().repository.connection(me.workspace.id, c.id))?.revision).toBe(
            beforeCancel
        );
        expect(
            (await s.call(`/plugins/connections/${c.id}`, { method: "DELETE", headers: board }))
                .status
        ).toBe(200);
        expect(
            (await service.ready().repository.connection(me.workspace.id, c.id))?.encrypted
        ).toBe("");
        await expect(service.secret(c)).rejects.toThrow("revoked");
        expect(exchanges).toHaveLength(3);
    });
}
