import { createHash } from "node:crypto";
import { type Annotation, sampleAnnotation } from "@notato/schema";
import { z } from "zod";
import { isAdmin, type Principal } from "./auth.ts";
import { RequestError } from "./backend.ts";
import {
    type ConfigSource,
    parseOnOff,
    SETTINGS,
    type SettingName,
    writeSetting,
    writeWebhooks,
} from "./config.ts";
import { sameOrigin } from "./cors.ts";
import type { AppContext } from "./http.ts";
import type { ShareLinks, ShotLinks } from "./share.ts";
import {
    buildDelivery,
    type Delivery,
    parseWebhooks,
    secretOf,
    WEBHOOK_EVENTS,
    WEBHOOK_FORMATS,
    type Webhook,
    type WebhookEvent,
} from "./webhooks.ts";

// The board's settings page: the same `notato.config.json` that `notato config` edits, read and changed over HTTP.
// A webhook's URL is often a secret in itself (a Slack or Discord URL lets anyone post to the channel), and so is a
// signing secret written in the file, so neither ever leaves the server: the board sees a masked URL and whether a
// secret is set, and a change that leaves them out keeps what is there.

/** Identifies one webhook's exact contents, so an edit made against an older copy of the list is refused. */
export const fingerprint = (w: Webhook) =>
    createHash("sha256").update(JSON.stringify(w)).digest("hex").slice(0, 16);

/** `https://hooks.slack.com/services/…/••••`: enough to recognise it, not enough to use it. */
export function maskUrl(raw: string): string {
    const url = new URL(raw);
    const first = url.pathname.split("/").filter(Boolean)[0];
    const rest = url.pathname.length > (first ? first.length + 1 : 1) || url.search;
    return `${url.protocol}//${url.host}${first ? `/${first}` : ""}${rest ? "/••••" : ""}`;
}

export interface WebhookView {
    index: number;
    fingerprint: string;
    name: string | null;
    url: string;
    host: string;
    format: Webhook["format"];
    events: string[] | null;
    project: string | null;
    /** Whether its messages carry the screenshot (where the format can). */
    screenshots: boolean;
    /** A secret named by `env:` is shown by name, with whether it is set where the server runs; one in the file is not shown. */
    secret: { kind: "none" } | { kind: "env"; name: string; set: boolean } | { kind: "file" };
}

export interface SettingsView {
    /** The config file, or null when this server has none to write (it was started without one). */
    file: string | null;
    exists: boolean;
    /** Why the file cannot be used; nothing can be changed here until it is fixed. */
    error: string | null;
    settings: Array<{
        name: SettingName;
        value: "on" | "off";
        source: "default" | "file" | "env" | "flag";
        default: "on" | "off";
        about: string;
        env: string;
    }>;
    webhooks: WebhookView[];
    events: readonly string[];
    formats: readonly string[];
    /** Where screenshot links in messages point, or null when the server cannot be reached from outside. */
    publicUrl: string | null;
}

export function settingsView(
    config: ConfigSource,
    env: Record<string, string | undefined> = process.env,
    share?: ShareLinks
) {
    const now = config();
    const view: SettingsView = {
        file: config.file ?? null,
        exists: now.file !== undefined,
        error: now.error ?? null,
        settings: (Object.keys(SETTINGS) as SettingName[]).map((name) => ({
            name,
            value: now[name] ? "on" : "off",
            source: now.source[name],
            default: SETTINGS[name].default,
            about: SETTINGS[name].about,
            env: SETTINGS[name].env,
        })),
        webhooks: now.webhooks.map((w, index) => ({
            index,
            fingerprint: fingerprint(w),
            name: w.name ?? null,
            url: maskUrl(w.url),
            host: new URL(w.url).host,
            format: w.format,
            events: w.events ?? null,
            project: w.project ?? null,
            screenshots: w.screenshots !== false,
            secret:
                w.secret === undefined
                    ? { kind: "none" }
                    : w.secret.startsWith("env:")
                      ? {
                            kind: "env",
                            name: w.secret.slice(4),
                            set: Boolean(env[w.secret.slice(4)]),
                        }
                      : { kind: "file" },
        })),
        events: WEBHOOK_EVENTS,
        formats: WEBHOOK_FORMATS,
        publicUrl: share?.publicUrl ?? null,
    };
    return view;
}

/**
 * A webhook as the board sends it. Left out, `url` and `secret` keep what the webhook being edited has; `secret: null`
 * removes it. Empty text means none.
 */
const Draft = z
    .object({
        name: z.string().max(100).nullish(),
        url: z.string().max(2000).optional(),
        format: z.enum(WEBHOOK_FORMATS),
        events: z.array(z.string()).max(WEBHOOK_EVENTS.length).nullish(),
        project: z.string().max(128).nullish(),
        secret: z.string().max(500).nullish(),
        screenshots: z.boolean().optional(),
    })
    .strict();
type Draft = z.infer<typeof Draft>;

const Which = z.object({ index: z.number().int().min(0), fingerprint: z.string().max(64) });
const AddBody = z.object({ hook: Draft }).strict();
const EditBody = z.object({ fingerprint: z.string().max(64), hook: Draft }).strict();
/** What a test or a preview sends: which event, about which note (a made-up one when none is named). */
const TestBody = z
    .object({
        hook: Draft,
        existing: Which.optional(),
        event: z.enum(WEBHOOK_EVENTS).optional(),
        annotationId: z.string().max(128).optional(),
    })
    .strict();
const SettingBody = z.object({ value: z.enum(["on", "off"]).nullable() }).strict();

const blank = (s: string | null | undefined) => (s?.trim() ? s.trim() : undefined);

/** The webhook a draft describes, on top of the one it edits. Throws a message the person can act on. */
export function fromDraft(draft: Draft, base?: Webhook): Webhook {
    const url = blank(draft.url) ?? base?.url;
    if (!url) throw new RequestError("a URL is required");
    const secret = draft.secret === undefined ? base?.secret : (blank(draft.secret) ?? undefined);
    const candidate: Record<string, unknown> = { url, format: draft.format };
    if (draft.events?.length) candidate.events = draft.events;
    if (blank(draft.name)) candidate.name = blank(draft.name);
    if (blank(draft.project)) candidate.project = blank(draft.project);
    // Chat services ignore a signature, so one is only kept for the JSON format.
    if (secret && draft.format === "json") candidate.secret = secret;
    // On unless turned off, so only `false` is written.
    if ((draft.screenshots ?? base?.screenshots) === false) candidate.screenshots = false;
    const checked = parseWebhooks([candidate]);
    if (checked.error) throw new RequestError(checked.error.replace(/^webhooks\[0\]\.?/, ""));
    return checked.webhooks[0] as Webhook;
}

export interface TestResult {
    ok: boolean;
    /** The HTTP status the other end answered with, when it answered. */
    status?: number;
    ms: number;
    detail: string;
    /** The start of what it answered, which is where Slack and Discord say what is wrong. */
    response?: string;
}

/** A test's subject: the note named, or a made-up one (with no screenshot, since its images do not exist). */
export const SAMPLE_COMMENT = "This is a test event from the Notato board. Nothing is wrong.";
const sampleNote = (): Annotation => ({
    ...sampleAnnotation,
    comment: SAMPLE_COMMENT,
    screenshots: undefined,
});

export interface Prepared {
    delivery: Delivery;
    hook: Webhook;
    annotation: Annotation;
    /** The screenshot links the message carries, mapped to where the board can show them. */
    images: Record<string, string>;
    /** What to know about this message before sending it: why there is no screenshot, say. */
    notes: string[];
}

/** The exact message a test would send, without sending it. */
export function prepareTest(
    hook: Webhook,
    options: {
        event?: WebhookEvent;
        annotation?: Annotation;
        share?: ShareLinks;
        env?: Record<string, string | undefined>;
    } = {}
): Prepared | { error: string } {
    const secret = secretOf(hook, options.env);
    if (secret === null) {
        return {
            error: `${hook.secret?.slice(4)} is not set where the server runs, so a signed test cannot be sent (and no events will be).`,
        };
    }
    const event = options.event ?? "annotation.created";
    const annotation = options.annotation ?? sampleNote();
    const notes: string[] = [];
    const shots = annotation.screenshots;
    const pictured = hook.format === "teams" || hook.format === "json";
    let links: ShotLinks | undefined;
    if (!options.annotation)
        notes.push("A made-up note, so there is no screenshot. Choose a real note to see one.");
    else if (!shots) notes.push("This note has no screenshot.");
    else if (!pictured)
        notes.push("Slack and Discord get one line of text, without the screenshot.");
    else if (hook.screenshots === false) notes.push("Screenshots are turned off for this webhook.");
    else {
        links = options.share?.linksFor(annotation);
        if (!links)
            notes.push(
                "The screenshot is left out: this server has no address the outside world can reach. Start it with --tunnel, or set NOTATO_PUBLIC_URL."
            );
    }
    if (hook.events && !hook.events.includes(event))
        notes.push("This webhook is not sent this event; the test sends it anyway.");
    if (hook.project && options.annotation && annotation.projectId !== hook.project)
        notes.push(
            `This note is from ${annotation.projectId}; the webhook only gets ${hook.project}.`
        );

    const images: Record<string, string> = {};
    if (links?.full && shots) images[links.full] = `/assets/${shots.full.id}`;
    if (links?.crop && shots?.crop) images[links.crop] = `/assets/${shots.crop.id}`;
    return {
        delivery: buildDelivery(hook, event, annotation, secret, undefined, links),
        hook,
        annotation,
        images,
        notes,
    };
}

/** Sends a prepared message once and reports what came back: for the board's Test button. */
export async function sendTest(
    prepared: Prepared,
    options: { fetch?: typeof fetch; timeoutMs?: number } = {}
): Promise<TestResult> {
    const { delivery, hook } = prepared;
    const started = performance.now();
    const ms = () => Math.round(performance.now() - started);
    try {
        const res = await (options.fetch ?? fetch)(hook.url, {
            method: "POST",
            headers: delivery.headers,
            body: delivery.body,
            signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
            redirect: "manual",
        });
        const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 300);
        const status = res.status;
        if (res.ok)
            return {
                ok: true,
                status,
                ms: ms(),
                detail: `Delivered: answered ${status}.`,
                response: text,
            };
        const why =
            status >= 300 && status < 400
                ? "it redirects, and webhooks do not follow redirects; use the URL it points to"
                : status === 401 || status === 403
                  ? "it refused the request; check the URL (and the secret, if it checks one)"
                  : status === 404 || status === 410
                    ? "nothing there; the webhook may have been deleted on the other side"
                    : status >= 500
                      ? "the other end failed; real events are retried 3 times"
                      : "it did not accept the request";
        return {
            ok: false,
            status,
            ms: ms(),
            detail: `Answered ${status}: ${why}.`,
            response: text,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const timedOut =
            error instanceof Error &&
            (error.name === "TimeoutError" || /timed? ?out/i.test(message));
        return {
            ok: false,
            ms: ms(),
            detail: timedOut ? "No answer within 10 seconds." : `Could not reach it: ${message}`,
        };
    }
}

/** A sample event, prepared and sent: what the CLI-style test does in one step. */
export async function testWebhook(
    hook: Webhook,
    options: Parameters<typeof prepareTest>[1] & { fetch?: typeof fetch; timeoutMs?: number } = {}
): Promise<TestResult> {
    const prepared = prepareTest(hook, options);
    if ("error" in prepared) return { ok: false, ms: 0, detail: prepared.error };
    return sendTest(prepared, options);
}

/**
 * Refuses a request that is not from the board itself (or a tool with no Origin, like curl). An app's page may talk to
 * the server for its annotations, but must never be able to point a webhook somewhere, or create, delete or mint
 * tokens for projects.
 */
export function assertBoard(req: Request, what = "settings") {
    const origin = req.headers.get("origin");
    if (origin !== null && !sameOrigin(req, origin)) {
        throw new RequestError(
            `${what} can only be changed from the Notato board or the notato CLI`,
            403
        );
    }
}

/** The file to write, or why there is none to write. */
function writable(config: ConfigSource): string {
    if (!config.file)
        throw new RequestError("this server was started without a config file to change", 409);
    const now = config();
    if (now.error)
        throw new RequestError(`${config.file}: ${now.error}. Fix or remove the file first.`, 409);
    return config.file;
}

/** The webhook at `index`, as long as it is still the one the board was showing. */
const current = (config: ConfigSource, which: { index: number; fingerprint: string }) =>
    unchanged(config().webhooks, which);

function unchanged(list: Webhook[], which: { index: number; fingerprint: string }): Webhook {
    const hook = list[which.index];
    if (!hook || fingerprint(hook) !== which.fingerprint) {
        throw new RequestError(
            "that webhook was changed or removed since this page loaded (in another tab, or with notato config)",
            409
        );
    }
    return hook;
}

async function body<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
    let raw: unknown;
    try {
        raw = await req.json();
    } catch {
        throw new RequestError("body must be JSON");
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new RequestError(`${issue?.path.join(".") || "body"}: ${issue?.message}`);
    }
    return parsed.data;
}

export interface SettingsRouteOptions {
    env?: Record<string, string | undefined>;
    fetch?: typeof fetch;
}

/** `/settings` and below, for an admin on the board. Null when the path is not one of them. */
export async function settingsRoute(
    req: Request,
    path: string,
    principal: Principal,
    ctx: Pick<AppContext, "backend" | "json"> & { options?: { share?: ShareLinks } },
    options: SettingsRouteOptions = {}
): Promise<Response | null> {
    if (path !== "/settings" && !path.startsWith("/settings/")) return null;
    if (!isAdmin(principal))
        throw new RequestError("only an admin can see or change the settings", 403);
    assertBoard(req);
    const config = ctx.backend.config;
    const env = options.env ?? process.env;
    const method = req.method;
    const share = ctx.options?.share;
    const view = () => ctx.json(settingsView(config, env, share));
    /** Writes, then reads the file back, so what is answered is what is now in force. */
    const changed = (write: () => void) => {
        try {
            write();
        } catch (error) {
            if (error instanceof RequestError) throw error;
            throw new RequestError(error instanceof Error ? error.message : String(error), 409);
        }
        config.invalidate?.();
        // Turning MCP off drops the agents now: pages stop showing one as connected, and calls in progress are answered.
        ctx.backend.agents.refresh();
        return view();
    };

    if (path === "/settings" && method === "GET") return view();

    const setting = /^\/settings\/(\w+)$/.exec(path)?.[1];
    if (setting && setting in SETTINGS && method === "PUT") {
        const { value } = await body(req, SettingBody);
        const file = writable(config);
        return changed(() =>
            writeSetting(file, setting as SettingName, value === null ? null : parseOnOff(value))
        );
    }

    if (path === "/settings/webhooks" && method === "POST") {
        const { hook } = await body(req, AddBody);
        const file = writable(config);
        const added = fromDraft(hook);
        return changed(() =>
            writeWebhooks(file, (list) => {
                if (list.some((w) => w.url === added.url))
                    throw new RequestError(
                        "a webhook with that URL is already set up; edit that one instead",
                        409
                    );
                return [...list, added];
            })
        );
    }

    // A test sends a message; a preview answers with exactly what the test would send, and sends nothing.
    const testing = path === "/settings/webhooks/test" || path === "/settings/webhooks/preview";
    if (testing && method === "POST") {
        const { hook, existing, event, annotationId } = await body(req, TestBody);
        const target = fromDraft(hook, existing ? current(config, existing) : undefined);
        let annotation: Annotation | undefined;
        if (annotationId) {
            const found = await ctx.backend.get(annotationId);
            if (!found) throw new RequestError("that note no longer exists", 404);
            annotation = found.annotation;
        }
        const prepared = prepareTest(target, { event, annotation, share, env });
        if (path.endsWith("/preview")) {
            if ("error" in prepared) throw new RequestError(prepared.error, 409);
            const { delivery } = prepared;
            return ctx.json({
                format: target.format,
                event: delivery.event,
                url: maskUrl(target.url),
                body: JSON.parse(delivery.body),
                // The signature is made from the secret, which stays here.
                headers: Object.fromEntries(
                    Object.entries(delivery.headers).map(([k, v]) =>
                        k === "X-Notato-Signature"
                            ? [k, "sha256=… (made with the secret when it is sent)"]
                            : [k, v]
                    )
                ),
                images: prepared.images,
                notes: prepared.notes,
            });
        }
        if ("error" in prepared) return ctx.json({ ok: false, ms: 0, detail: prepared.error });
        return ctx.json(await sendTest(prepared, { fetch: options.fetch }));
    }

    const one = /^\/settings\/webhooks\/(\d+)$/.exec(path);
    if (one) {
        const index = Number(one[1]);
        // Checked against the list as it is read for the write, so a change from `notato config` in between is caught.
        if (method === "PUT") {
            const edit = await body(req, EditBody);
            const file = writable(config);
            return changed(() =>
                writeWebhooks(file, (list) => {
                    const next = fromDraft(
                        edit.hook,
                        unchanged(list, { index, fingerprint: edit.fingerprint })
                    );
                    if (list.some((w, i) => i !== index && w.url === next.url))
                        throw new RequestError("another webhook already uses that URL", 409);
                    return list.map((w, i) => (i === index ? next : w));
                })
            );
        }
        if (method === "DELETE") {
            const file = writable(config);
            const which = {
                index,
                fingerprint: new URL(req.url).searchParams.get("fingerprint") ?? "",
            };
            return changed(() =>
                writeWebhooks(file, (list) => {
                    unchanged(list, which);
                    return list.filter((_, i) => i !== index);
                })
            );
        }
    }

    return ctx.json({ error: "not found" }, 404);
}
