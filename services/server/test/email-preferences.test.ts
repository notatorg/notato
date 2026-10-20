import { expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import {
    addressFingerprint,
    CURRENT_COPY_VERSION,
    type EmailPreferenceOptions,
    emailPreferenceOptions,
    evidenceCutoff,
    marketingMessage,
    readUnsubscribeToken,
    unsubscribeToken,
} from "../src/email-preferences.ts";
import { cleanupAfterEach } from "./helpers.ts";
import { customer, fakeManagedAuth } from "./hosted-helpers.ts";
import { embeddedPostgres } from "./postgres.ts";
import { startServe } from "./serve-helpers.ts";

const defer = cleanupAfterEach();
const emailPreferences: EmailPreferenceOptions = {
    key: "test-key-for-email-preferences-0123456789",
    privacyUrl: "https://example.com/privacy",
    controller: { name: "Example Ltd", address: "1 High Street, London AB1 2CD" },
    providerWebhookSecret: `whsec_${Buffer.from("provider-signing-secret-0123456789").toString("base64")}`,
};

async function setup(enabled = true) {
    const { store } = await embeddedPostgres();
    const s = await startServe(defer, {
        managedAuth: fakeManagedAuth(),
        testPlans: true,
        store,
        emailPreferences: enabled ? emailPreferences : null,
    });
    const headers = (cookie: string) => ({
        origin: s.base,
        "x-notato-board": "1",
        "content-type": "application/json",
        cookie,
    });
    const read = async (cookie: string) =>
        (await s.call("/account/email-preferences", { headers: { cookie } })).json() as Promise<{
            available: boolean;
            marketing: { enabled: boolean; decided: boolean; revision: number; blocked?: string };
            copy: { version: string };
        }>;
    const choose = (
        cookie: string,
        enabled: boolean,
        expectedRevision: number,
        extra: Record<string, unknown> = {}
    ) =>
        s.call("/account/email-preferences", {
            method: "PUT",
            headers: headers(cookie),
            body: JSON.stringify({
                enabled,
                expectedRevision,
                copyVersion: CURRENT_COPY_VERSION,
                source: "settings",
                ...extra,
            }),
        });
    const username = async (cookie: string) =>
        ((await (await s.call("/auth/me", { headers: { cookie } })).json()) as { username: string })
            .username;
    return { s, store, read, choose, username };
}

it("offers nothing until an operator configures it", async () => {
    const { s, read } = await setup(false);
    const alice = await customer(s, "alice");
    expect((await read(alice.cookie)).available).toBe(false);
    expect((await s.call("/email/unsubscribe?t=x")).status).toBe(404);
});

it("starts undecided and off, then records an explicit choice with its evidence", async () => {
    const { s, store, read, choose, username } = await setup();
    const alice = await customer(s, "alice");
    const first = await read(alice.cookie);
    expect(first.marketing).toMatchObject({ enabled: false, decided: false, revision: 0 });
    expect(first.copy.version).toBe(CURRENT_COPY_VERSION);

    const declined = await choose(alice.cookie, false, 0, { source: "onboarding" });
    expect(declined.status).toBe(200);
    expect((await read(alice.cookie)).marketing).toMatchObject({
        enabled: false,
        decided: true,
        revision: 1,
    });

    expect((await choose(alice.cookie, true, 1)).status).toBe(200);
    const now = (await read(alice.cookie)).marketing;
    expect(now).toMatchObject({ enabled: true, decided: true, revision: 2 });

    const fingerprint = addressFingerprint(emailPreferences, "alice@example.com");
    expect(await store.marketingEligible(await username(alice.cookie), fingerprint)).toBe(true);
    // The audit trail names the wording and source, and never the address itself.
    const events = await (
        store as unknown as { db: { query(sql: string): Promise<Array<Record<string, unknown>>> } }
    ).db.query(
        "SELECT source,copy_version,enabled,address_fingerprint FROM notato.communication_preference_events ORDER BY revision"
    );
    expect(events.map((e) => [e.source, e.enabled, e.copy_version])).toEqual([
        ["onboarding", false, CURRENT_COPY_VERSION],
        ["settings", true, CURRENT_COPY_VERSION],
    ]);
    expect(JSON.stringify(events)).not.toContain("alice@example.com");
});

it("retries safely, rejects stale or malformed changes and refuses other sites", async () => {
    const { s, read, choose } = await setup();
    const alice = await customer(s, "alice");
    expect((await choose(alice.cookie, true, 0)).status).toBe(200);
    // The same choice again changes nothing, whatever revision the retry carried.
    expect((await choose(alice.cookie, true, 0)).status).toBe(200);
    expect((await read(alice.cookie)).marketing.revision).toBe(1);
    // A different choice from a stale page does not overwrite a newer one.
    expect((await choose(alice.cookie, false, 0)).status).toBe(409);
    expect((await read(alice.cookie)).marketing.enabled).toBe(true);
    expect((await choose(alice.cookie, false, 1, { copyVersion: "1999-01-01" })).status).toBe(409);
    expect((await choose(alice.cookie, false, 1, { extra: 1 })).status).toBe(400);
    const foreign = await s.call("/account/email-preferences", {
        method: "PUT",
        headers: {
            cookie: alice.cookie,
            origin: "https://attacker.example",
            "content-type": "application/json",
        },
        body: JSON.stringify({
            enabled: false,
            expectedRevision: 1,
            copyVersion: CURRENT_COPY_VERSION,
            source: "settings",
        }),
    });
    expect(foreign.status).toBe(403);
    expect((await read(alice.cookie)).marketing.enabled).toBe(true);
    expect((await s.call("/account/email-preferences")).status).toBe(401);
});

it("keeps each account's choice separate, even in a shared workspace or address", async () => {
    const { s, read, choose } = await setup();
    const alice = await customer(s, "alice");
    const bob = await customer(s, "bob");
    await choose(alice.cookie, true, 0);
    expect((await read(bob.cookie)).marketing).toMatchObject({ enabled: false, decided: false });
});

it("unsubscribes without signing in, only on POST, and cannot be undone by a stale or forged link", async () => {
    const { s, read, choose } = await setup();
    const alice = await customer(s, "alice");
    const bob = await customer(s, "bob");
    await choose(alice.cookie, true, 0);
    await choose(bob.cookie, true, 0);
    const token = unsubscribeToken(emailPreferences, "alice@example.com");
    const link = `/email/unsubscribe?t=${encodeURIComponent(token)}`;

    // Opening the link (a mail scanner may) shows a button and changes nothing.
    const opened = await s.call(link);
    expect(opened.status).toBe(200);
    expect(await opened.text()).toContain("<form");
    expect((await read(alice.cookie)).marketing.enabled).toBe(true);

    const oneClick = await s.call(link, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
    });
    expect(oneClick.status).toBe(200);
    expect((await read(alice.cookie)).marketing).toMatchObject({ enabled: false, revision: 2 });
    expect((await read(bob.cookie)).marketing.enabled).toBe(true);
    // Repeating it is harmless and adds no further change.
    expect((await s.call(link, { method: "POST" })).status).toBe(200);
    expect((await read(alice.cookie)).marketing.revision).toBe(2);

    for (const bad of ["", "v1.x.y", `${token}x`, token.replace("v1.", "v2."), "a.b.c.d"])
        expect(
            (await s.call(`/email/unsubscribe?t=${encodeURIComponent(bad)}`, { method: "POST" }))
                .status
        ).toBe(400);
    expect(
        readUnsubscribeToken(
            { ...emailPreferences, key: "another-key-another-key-another-key" },
            token
        )
    ).toBeNull();
    expect((await read(bob.cookie)).marketing.enabled).toBe(true);

    // A fresh, affirmative request is the only way back after an unsubscribe.
    expect((await choose(alice.cookie, true, 2)).status).toBe(200);
    expect((await read(alice.cookie)).marketing.enabled).toBe(true);
});

it("never lets a settings change override a complaint or bounce", async () => {
    const { s, store, read, choose } = await setup();
    const alice = await customer(s, "alice");
    await choose(alice.cookie, true, 0);
    const fingerprint = addressFingerprint(emailPreferences, "alice@example.com");
    expect(await store.suppressEmail(fingerprint, "complaint", "provider")).toEqual({
        changed: true,
    });
    expect((await read(alice.cookie)).marketing).toMatchObject({
        enabled: false,
        blocked: "complaint",
    });
    expect((await choose(alice.cookie, true, 2)).status).toBe(409);
    // A later plain unsubscribe cannot downgrade it either.
    expect(await store.suppressEmail(fingerprint, "unsubscribe", "unsubscribe")).toEqual({
        changed: false,
    });
    expect((await read(alice.cookie)).marketing.blocked).toBe("complaint");
});

it("needs a fresh choice after the verified address changes", async () => {
    const { s, store, choose, username } = await setup();
    const alice = await customer(s, "alice");
    await choose(alice.cookie, true, 0);
    const name = await username(alice.cookie);
    const next = addressFingerprint(emailPreferences, "alice.new@example.com");
    expect(await store.getMarketingPreference(name, next)).toMatchObject({
        enabled: false,
        decided: false,
        revision: 1,
    });
    expect(await store.marketingEligible(name, next)).toBe(false);
});

it("stops marketing on deletion, keeps only evidence and suppression, and a new account starts undecided", async () => {
    const { s, store, read, choose, username } = await setup();
    const alice = await customer(s, "alice");
    await choose(alice.cookie, true, 0);
    const name = await username(alice.cookie);
    await store.deleteAccount(name, new Date().toISOString(), true);
    const db = (
        store as unknown as { db: { query(sql: string): Promise<Array<Record<string, unknown>>> } }
    ).db;
    expect(await db.query("SELECT 1 FROM notato.communication_preferences")).toHaveLength(0);
    expect(
        (await db.query("SELECT reason FROM notato.email_suppressions")).map((r) => r.reason)
    ).toEqual(["deletion"]);
    const events = await db.query(
        "SELECT username,enabled,source FROM notato.communication_preference_events ORDER BY created_at,id"
    );
    expect(events.map((e) => [e.username, e.enabled, e.source])).toEqual([
        [null, true, "settings"],
        [null, false, "deletion"],
    ]);

    // The deleted identity cannot sign back in, so a new account (here carol) is judged on its own record.
    const carol = await customer(s, "carol");
    expect((await read(carol.cookie)).marketing).toMatchObject({ enabled: false, decided: false });
    // Someone who later asks for this address again affirmatively replaces the deletion suppression.
    const fingerprint = addressFingerprint(emailPreferences, "alice@example.com");
    expect(
        await store.setMarketingPreference({
            username: await username(carol.cookie),
            fingerprint,
            enabled: true,
            expectedRevision: 0,
            source: "settings",
            copyVersion: CURRENT_COPY_VERSION,
        })
    ).toMatchObject({ enabled: true });
    expect(await db.query("SELECT 1 FROM notato.email_suppressions")).toHaveLength(0);
});

const signed = (
    body: string,
    at = Date.now(),
    id = "msg_1",
    secret = emailPreferences.providerWebhookSecret ?? ""
) => {
    const timestamp = String(Math.floor(at / 1000));
    const mac = createHmac("sha256", Buffer.from(secret.replace("whsec_", ""), "base64"))
        .update(`${id}.${timestamp}.${body}`)
        .digest("base64");
    return {
        "svix-id": id,
        "svix-timestamp": timestamp,
        "svix-signature": `v1,invalid v1,${mac}`,
        "content-type": "application/json",
    };
};

it("accepts only correctly signed, fresh provider events, and they can only withdraw", async () => {
    const { s, read, choose } = await setup();
    const alice = await customer(s, "alice");
    const bob = await customer(s, "bob");
    await choose(alice.cookie, true, 0);
    await choose(bob.cookie, true, 0);
    const send = (value: unknown, headers?: Record<string, string>) => {
        const body = JSON.stringify(value);
        return s.call("/email/provider-events", {
            method: "POST",
            headers: headers ?? signed(body),
            body,
        });
    };
    const bounce = (type: string, to = "alice@example.com") => ({
        type: "email.bounced",
        data: { to: [to], bounce: { type } },
    });
    const body = JSON.stringify(bounce("Permanent"));
    expect((await s.call("/email/provider-events", { method: "POST", body })).status).toBe(401);
    expect(
        (
            await s.call("/email/provider-events", {
                method: "POST",
                body,
                headers: signed(body, Date.now() - 600_000),
            })
        ).status
    ).toBe(401);
    expect(
        (
            await s.call("/email/provider-events", {
                method: "POST",
                body,
                headers: signed(
                    body,
                    Date.now(),
                    "m",
                    "whsec_b3RoZXItc2VjcmV0LW90aGVyLXNlY3JldA=="
                ),
            })
        ).status
    ).toBe(401);
    // Soft bounces and delivery events do nothing; neither can ever turn marketing on.
    expect((await send(bounce("Transient"))).status).toBe(200);
    expect(
        (await send({ type: "email.delivered", data: { to: ["alice@example.com"] } })).status
    ).toBe(200);
    expect((await send("not an event")).status).toBe(200);
    expect((await read(alice.cookie)).marketing.enabled).toBe(true);

    expect((await send(bounce("Permanent"))).status).toBe(200);
    expect((await read(alice.cookie)).marketing).toMatchObject({
        enabled: false,
        blocked: "hard_bounce",
    });
    expect(
        (await send({ type: "email.complained", data: { to: "alice@example.com" } })).status
    ).toBe(200);
    expect((await read(alice.cookie)).marketing.blocked).toBe("complaint");
    expect((await read(bob.cookie)).marketing.enabled).toBe(true);
    // Replays are harmless.
    expect(
        (await send({ type: "email.complained", data: { to: "alice@example.com" } })).status
    ).toBe(200);
    expect((await read(alice.cookie)).marketing.revision).toBe(2);
});

it("refuses provider events when no signing secret is configured", async () => {
    const { s } = await setup(false);
    expect((await s.call("/email/provider-events", { method: "POST", body: "{}" })).status).toBe(
        404
    );
});

it("lets a person download their own records, without their address or anyone else's", async () => {
    const { s, choose } = await setup();
    const alice = await customer(s, "alice");
    const bob = await customer(s, "bob");
    await choose(alice.cookie, true, 0, { source: "onboarding" });
    await choose(bob.cookie, true, 0);
    await choose(alice.cookie, false, 1);
    const response = await s.call("/account/email-preferences/export", {
        headers: { cookie: alice.cookie },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    const text = await response.text();
    expect(text).not.toContain("example.com");
    const records = JSON.parse(text) as {
        controller: string;
        events: Array<{ source: string; enabled: boolean }>;
        preference: { enabled: boolean };
    };
    expect(records.controller).toBe("Example Ltd");
    expect(records.preference.enabled).toBe(false);
    expect(records.events.map((e) => [e.source, e.enabled])).toEqual([
        ["onboarding", true],
        ["settings", false],
    ]);
    expect((await s.call("/account/email-preferences/export")).status).toBe(401);
});

it("forgets detached evidence and old suppressions after the retention period, but never a live account's record", async () => {
    const { s, store, choose } = await setup();
    const alice = await customer(s, "alice");
    await choose(alice.cookie, true, 0);
    const db = (
        store as unknown as {
            db: { query(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>> };
        }
    ).db;
    const old = new Date(Date.now() - 4 * 365 * 86_400_000).toISOString();
    await db.query(
        "INSERT INTO notato.communication_preference_events (id,username,address_fingerprint,channel,purpose,enabled,source,created_at) VALUES ('old',NULL,'x','email','marketing',FALSE,'deletion',$1)",
        [old]
    );
    await db.query(
        "INSERT INTO notato.communication_preference_events (id,username,address_fingerprint,channel,purpose,enabled,source,created_at) VALUES ('recent',NULL,'y','email','marketing',FALSE,'deletion',$1)",
        [new Date().toISOString()]
    );
    await db.query(
        "INSERT INTO notato.email_suppressions (address_fingerprint,purpose,reason,recorded_at) VALUES ('x','marketing','unsubscribe',$1)",
        [old]
    );
    const cutoff = evidenceCutoff(emailPreferences);
    expect(await store.purgeEmailRecords(cutoff)).toBe(2);
    expect(
        (await db.query("SELECT id FROM notato.communication_preference_events ORDER BY id")).map(
            (r) => r.id
        ).length
    ).toBe(2);
    expect(await db.query("SELECT 1 FROM notato.email_suppressions")).toHaveLength(0);
    expect(evidenceCutoff({ ...emailPreferences, evidenceRetentionDays: 1 }, 0)).toBe(
        "1969-12-31T00:00:00.000Z"
    );
});

it("holds all marketing sends after a restore until later withdrawals are replayed", async () => {
    const { s, store, read, choose, username } = await setup();
    const alice = await customer(s, "alice");
    const bob = await customer(s, "bob");
    await choose(alice.cookie, true, 0);
    await choose(bob.cookie, true, 0);
    const fp = (email: string) => addressFingerprint(emailPreferences, email);
    await store.setMarketingSendHold(true);
    expect(await store.marketingSendHeld()).toBe(true);
    expect(await store.marketingEligible(await username(bob.cookie), fp("bob@example.com"))).toBe(
        false
    );
    // Alice withdrew after the backup: replaying it suppresses her and records why.
    expect(await store.suppressEmail(fp("alice@example.com"), "unsubscribe", "restore")).toEqual({
        changed: true,
    });
    expect((await read(alice.cookie)).marketing.enabled).toBe(false);
    await store.setMarketingSendHold(false);
    expect(await store.marketingEligible(await username(bob.cookie), fp("bob@example.com"))).toBe(
        true
    );
    expect(
        await store.marketingEligible(await username(alice.cookie), fp("alice@example.com"))
    ).toBe(false);
});

it("builds a one-click unsubscribe header and a footer that names the sender", () => {
    const message = marketingMessage(
        emailPreferences,
        "alice@example.com",
        "https://app.example.com/anything"
    );
    const link = message.headers["List-Unsubscribe"]?.slice(1, -1) ?? "";
    expect(link.startsWith("https://app.example.com/email/unsubscribe?t=")).toBe(true);
    expect(message.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(message.footer).toContain("Example Ltd, 1 High Street, London AB1 2CD");
    expect(message.footer).toContain(link);
    expect(message.footer).toContain("https://example.com/privacy");
    expect(() =>
        marketingMessage(
            { ...emailPreferences, controller: { name: "Example Ltd" } },
            "a@example.com",
            "https://app.example.com"
        )
    ).toThrow("CONTROLLER_ADDRESS");
});

it("refuses to switch marketing email on without a named sender and privacy notice", () => {
    const base = { NOTATO_EMAIL_PREFERENCE_KEY: "k".repeat(32) };
    expect(emailPreferenceOptions({})).toBeUndefined();
    expect(() => emailPreferenceOptions(base)).toThrow("NOTATO_PRIVACY_URL");
    expect(() =>
        emailPreferenceOptions({ ...base, NOTATO_PRIVACY_URL: "http://example.com" })
    ).toThrow("HTTPS");
    expect(() =>
        emailPreferenceOptions({ ...base, NOTATO_PRIVACY_URL: "https://example.com/privacy" })
    ).toThrow("CONTROLLER_NAME");
    expect(
        emailPreferenceOptions({
            ...base,
            NOTATO_PRIVACY_URL: "https://example.com/privacy",
            NOTATO_MARKETING_CONTROLLER_NAME: "Example Ltd",
            NOTATO_EMAIL_EVIDENCE_RETENTION_DAYS: "730",
        })
    ).toMatchObject({ controller: { name: "Example Ltd" }, evidenceRetentionDays: 730 });
    expect(() =>
        emailPreferenceOptions({
            ...base,
            NOTATO_PRIVACY_URL: "https://example.com/p",
            NOTATO_MARKETING_CONTROLLER_NAME: "E",
            NOTATO_EMAIL_WEBHOOK_SECRET: "nope",
        })
    ).toThrow("whsec_");
});
