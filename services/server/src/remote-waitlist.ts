import { z } from "zod";
import type { BetaStore } from "./storage.ts";

const Row = z.object({
    id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
    email: z.email().max(254),
    sdk: z.string().max(80),
    use_case: z.string().max(1200),
    created_at: z.iso.datetime({ offset: true }),
});
/** Reads the independent collection database with a server-only key; never exposes it to the board. */
export class RemoteWaitlist {
    constructor(
        private url: string,
        private key: string,
        private fetcher: (input: string | URL, init?: RequestInit) => Promise<Response> = fetch
    ) {}
    static fromEnv(env: Record<string, string | undefined> = process.env) {
        if (!env.NOTATO_WAITLIST_ENABLED || env.NOTATO_WAITLIST_ENABLED === "0") return undefined;
        if (env.NOTATO_WAITLIST_ENABLED !== "1")
            throw new Error("NOTATO_WAITLIST_ENABLED must be 0 or 1");
        const url = new URL(env.NOTATO_WAITLIST_URL ?? "");
        if (url.protocol !== "https:" || url.username || url.password)
            throw new Error("Remote waitlist requires an HTTPS URL");
        const key = env.NOTATO_WAITLIST_TOKEN ?? "";
        if (key.length < 32) throw new Error("Remote waitlist requires a server-only access token");
        return new RemoteWaitlist(url.toString(), key);
    }
    async import(store: Pick<BetaStore, "listBetaRequests" | "requestBeta">): Promise<number> {
        const existing = new Set<string>();
        let localCursor: string | undefined;
        do {
            const page = await store.listBetaRequests(undefined, localCursor);
            for (const item of page.items) existing.add(item.email);
            localCursor = page.nextCursor;
        } while (localCursor);
        let cursor = "";
        let checked = 0;
        for (let page = 0; page < 26; page++) {
            const url = new URL("/waitlist/export", this.url);
            url.searchParams.set("select", "id,email,sdk,use_case,created_at");
            url.searchParams.set("order", "id.asc");
            url.searchParams.set("limit", "200");
            if (cursor) url.searchParams.set("id", `gt.${cursor}`);
            const response = await this.fetcher(url, {
                headers: { Authorization: `Bearer ${this.key}` },
                signal: AbortSignal.timeout(10_000),
            });
            if (!response.ok)
                throw new Error("Could not read the cloud waitlist. Please try again later.");
            const parsed = z
                .array(Row)
                .max(200)
                .safeParse(await response.json());
            if (!parsed.success)
                throw new Error("The cloud waitlist returned an invalid response.");
            for (const row of parsed.data) {
                if (row.id <= cursor)
                    throw new Error("The cloud waitlist returned an invalid cursor.");
                cursor = row.id;
                if (!existing.has(row.email))
                    await store.requestBeta({
                        id: row.id,
                        email: row.email,
                        sdk: row.sdk,
                        useCase: row.use_case,
                        createdAt: new Date(row.created_at).toISOString(),
                    });
                existing.add(row.email);
                checked++;
            }
            if (parsed.data.length < 200) return checked;
        }
        throw new Error("The cloud waitlist exceeded its configured capacity.");
    }
}
