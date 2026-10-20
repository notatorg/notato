// After restoring an older database snapshot, marketing-email withdrawals made since it was taken are missing.
// Hold all marketing sends, replay the withdrawals from the email provider's records, then release the hold.
//
//   bun services/server/scripts/email-restore.ts hold
//   bun services/server/scripts/email-restore.ts replay withdrawn.txt [--reason=unsubscribe|complaint|hard_bounce]
//   bun services/server/scripts/email-restore.ts release
//   bun services/server/scripts/email-restore.ts status
//
// Needs NOTATO_DATABASE_URL and the same marketing settings as the service. `withdrawn.txt` holds one address per
// line, exported from the provider's unsubscribe, complaint and bounce lists for the period since the snapshot.
// Addresses are read once, fingerprinted in memory and never printed or stored.
import { readFileSync } from "node:fs";
import { addressFingerprint, emailPreferenceOptions } from "../src/email-preferences.ts";
import { PostgresStore } from "../src/postgres-store.ts";

const [command, file] = process.argv.slice(2);
const url = process.env.NOTATO_DATABASE_URL;
if (!url) throw new Error("Set NOTATO_DATABASE_URL");
const settings = emailPreferenceOptions(process.env);
if (!settings) throw new Error("Marketing email is not configured (NOTATO_EMAIL_PREFERENCE_KEY)");

const reason = process.argv.find((a) => a.startsWith("--reason="))?.slice(9) ?? "unsubscribe";
if (!["unsubscribe", "complaint", "hard_bounce"].includes(reason))
    throw new Error("--reason must be unsubscribe, complaint or hard_bounce");

const store = await PostgresStore.connect(url);
try {
    if (command === "hold") {
        await store.setMarketingSendHold(true);
        console.log("Marketing sends are held.");
    } else if (command === "release") {
        await store.setMarketingSendHold(false);
        console.log("Marketing sends are released.");
    } else if (command === "status") {
        console.log((await store.marketingSendHeld()) ? "held" : "not held");
    } else if (command === "replay" && file) {
        const emails = new Set(
            readFileSync(file, "utf8")
                .split(/\r?\n/)
                .map((line) => line.trim().toLowerCase())
                .filter((line) => line.includes("@"))
        );
        let changed = 0;
        for (const email of emails)
            if (
                (
                    await store.suppressEmail(
                        addressFingerprint(settings, email),
                        reason as "unsubscribe" | "complaint" | "hard_bounce",
                        "restore"
                    )
                ).changed
            )
                changed++;
        console.log(`Replayed ${emails.size} addresses; ${changed} changed.`);
    } else {
        throw new Error("Usage: email-restore.ts hold | replay <file> | release | status");
    }
} finally {
    await store.close();
}
