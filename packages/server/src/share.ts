import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Annotation, AssetRef } from "@notato/schema";
import type { LocalBackend } from "./backend.ts";

// Links to one screenshot that work without signing in, for a webhook's message: Teams shows a card's image by
// fetching it, and it can send no token. Each link names one image and carries a signature only this server can make,
// so it opens that image and nothing else. It needs an address the outside world can reach: the dev tunnel's, or
// NOTATO_PUBLIC_URL. Images are named by the hash of their bytes, so a link never shows something else later.

export const SHARE_KEY_FILE = "share.key";

/**
 * The key links are signed with, kept beside the data so links in messages already sent keep working after a restart.
 * It is made the first time a link is, so a server that never shares one never writes it.
 */
export function readShareKey(dir: string, create: boolean): string | undefined {
    const file = join(dir, SHARE_KEY_FILE);
    if (existsSync(file)) {
        const saved = readFileSync(file, "utf8").trim();
        if (saved.length >= 32) return saved;
    }
    if (!create) return undefined;
    mkdirSync(dir, { recursive: true });
    const key = randomBytes(32).toString("base64url");
    writeFileSync(file, `${key}\n`, { mode: 0o600 });
    return key;
}

export interface ShotLinks {
    /** The page, with the target outlined. */
    full?: string;
    /** A close-up of the target. */
    crop?: string;
}

const EXT: Record<AssetRef["mime"], string> = { "image/png": "png", "image/webp": "webp" };

export class ShareLinks {
    private key: string | undefined;

    constructor(
        /** Where the key is kept: the server's data folder. */
        private readonly dir: string,
        /** The address the outside world reaches this server at, if there is one right now. */
        private readonly base: () => string | undefined
    ) {}

    private sign(id: string, key: string) {
        return createHmac("sha256", key).update(`asset:${id}`).digest("base64url").slice(0, 32);
    }

    /** Where links would point, or undefined when the server cannot be reached from outside. */
    get publicUrl(): string | undefined {
        return this.base()?.replace(/\/+$/, "") || undefined;
    }

    urlFor(ref: AssetRef): string | undefined {
        const base = this.publicUrl;
        if (!base) return undefined;
        this.key ??= readShareKey(this.dir, true) as string;
        return `${base}/shared/${ref.id}.${EXT[ref.mime] ?? "png"}?sig=${this.sign(ref.id, this.key)}`;
    }

    /** The annotation's screenshots as links, or nothing when it has none or there is no public address. */
    linksFor(a: Annotation): ShotLinks | undefined {
        const shots = a.screenshots;
        if (!shots || !this.publicUrl) return undefined;
        return {
            full: this.urlFor(shots.full),
            ...(shots.crop ? { crop: this.urlFor(shots.crop) } : {}),
        };
    }

    verify(id: string, sig: string): boolean {
        // No key yet means no link was ever made, so there is nothing a signature could be right for.
        this.key ??= readShareKey(this.dir, false);
        if (!this.key) return false;
        const want = Buffer.from(this.sign(id, this.key));
        const given = Buffer.from(sig);
        return want.length === given.length && timingSafeEqual(want, given);
    }
}

/**
 * `GET /shared/<id>.<ext>?sig=…`: one screenshot, without signing in and through the dev tunnel's gate, when the
 * signature is right. Anything else is a 404, so a guess learns nothing. Null when the path is not this route.
 */
export async function sharedAsset(
    req: Request,
    url: URL,
    backend: Pick<LocalBackend, "asset" | "projectsWithAsset">,
    share: ShareLinks | undefined
): Promise<Response | null> {
    const found = /^\/shared\/([0-9a-f]{64})\.(png|webp)$/.exec(url.pathname);
    if (!found) return null;
    const notFound = () =>
        new Response("not found", { status: 404, headers: { "Content-Type": "text/plain" } });
    if (req.method !== "GET" && req.method !== "HEAD") return notFound();
    const id = found[1] as string;
    if (!share?.verify(id, url.searchParams.get("sig") ?? "")) return notFound();
    // A link lives only as long as a note that shows the screenshot: deleting the note ends it.
    if ((await backend.projectsWithAsset(id)).length === 0) return notFound();
    const asset = await backend.asset(id);
    if (!asset) return notFound();
    return new Response(req.method === "HEAD" ? null : (asset.bytes as BodyInit), {
        headers: {
            "Content-Type": asset.mime,
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'",
        },
    });
}
