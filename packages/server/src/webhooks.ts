import { createHmac } from "node:crypto";
import { clip, mentionsIn, renderAnnotation } from "@notato/core";
import type { Annotation } from "@notato/schema";
import { ulid } from "ulid";
import type { ConfigSource, ResolvedConfig } from "./config.ts";
import type { EventBus, NotatoEvent } from "./events.ts";
import type { ShareLinks, ShotLinks } from "./share.ts";
import { teamsMessage } from "./teams.ts";

/** What a webhook can be told about. `annotation.<status>` is sent when the status changes to that. */
export const WEBHOOK_EVENTS = [
    "annotation.created",
    "annotation.acknowledged",
    "annotation.resolved",
    "annotation.variants_ready",
    "annotation.variant_chosen",
    "annotation.revert_requested",
    "annotation.reverted",
    "annotation.dismissed",
    "annotation.reopened",
    "annotation.updated",
    "annotation.replied",
    "annotation.deleted",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_FORMATS = ["json", "slack", "discord", "teams"] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

export interface Webhook {
    /**
     * Where to send. Write `env:NAME` to read it from an environment variable where the server runs: a Slack, Discord or
     * Teams URL lets anyone who has it post to the channel, so it is as much a secret as `secret` is.
     */
    url: string;
    /** Which events to send. Every event when absent. */
    events?: WebhookEvent[];
    /**
     * `json` is the full payload. `slack` and `discord` are a one-line message those services accept as is. `teams` is an
     * Adaptive Card in the message shape a Teams workflow takes (see teams.ts).
     */
    format: WebhookFormat;
    /**
     * Signs each body (HMAC-SHA256, in `X-Notato-Signature`). Write `env:NAME` to read it from an environment variable
     * rather than keep it in a file that is committed.
     */
    secret?: string;
    /** What to call it in logs and in `notato config webhook`. */
    name?: string;
    /** Only this project's annotations. Every project when absent. */
    project?: string;
    /**
     * `false` leaves the screenshot out. Otherwise a `teams` card shows it and a `json` payload links to it, when the
     * server has an address the outside world can reach (its dev tunnel, or NOTATO_PUBLIC_URL).
     */
    screenshots?: boolean;
}

const FIELDS = ["url", "events", "format", "secret", "name", "project", "screenshots"];

/** A value written as `env:NAME` is read from that environment variable where the server runs. */
const ENV = "env:";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const envName = (value: string | undefined) =>
    value?.startsWith(ENV) ? value.slice(ENV.length) : undefined;

/** An http or https URL, written the way `URL` writes it, or what is wrong with it. */
function httpUrl(raw: string): { url: string } | { error: string } {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return { error: "is not a URL" };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
        return { error: "must be http or https" };
    return { url: url.toString() };
}

/** Checks a `webhooks` value from a config file. */
export function parseWebhooks(raw: unknown): { webhooks: Webhook[]; error?: string } {
    if (raw === undefined) return { webhooks: [] };
    if (!Array.isArray(raw)) return { webhooks: [], error: '"webhooks" must be a list' };
    const out: Webhook[] = [];
    for (const [i, entry] of raw.entries()) {
        const at = `webhooks[${i}]`;
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
            return { webhooks: [], error: `${at} must be an object` };
        const e = entry as Record<string, unknown>;
        const unknown = Object.keys(e).find((key) => !FIELDS.includes(key));
        if (unknown !== undefined)
            return {
                webhooks: [],
                error: `${at}: unknown field "${unknown}" (known: ${FIELDS.join(", ")})`,
            };
        if (typeof e.url !== "string") return { webhooks: [], error: `${at}.url is required` };
        // `env:NAME` is kept as it is written, so the URL itself never has to be in the file; it is read when sending.
        const fromEnv = envName(e.url);
        const url = fromEnv === undefined ? httpUrl(e.url) : { url: e.url };
        if ("error" in url) return { webhooks: [], error: `${at}.url ${url.error}` };
        if (fromEnv !== undefined && !ENV_NAME.test(fromEnv))
            return {
                webhooks: [],
                error: `${at}.url: env: must be followed by the name of an environment variable`,
            };
        const format = e.format ?? "json";
        if (!(WEBHOOK_FORMATS as readonly unknown[]).includes(format))
            return {
                webhooks: [],
                error: `${at}.format must be one of ${WEBHOOK_FORMATS.join(", ")}`,
            };
        let events: WebhookEvent[] | undefined;
        if (e.events !== undefined) {
            if (!Array.isArray(e.events) || e.events.length === 0)
                return { webhooks: [], error: `${at}.events must be a non-empty list` };
            const bad = e.events.find((x) => !(WEBHOOK_EVENTS as readonly unknown[]).includes(x));
            if (bad !== undefined)
                return {
                    webhooks: [],
                    error: `${at}.events: unknown event ${JSON.stringify(bad)} (known: ${WEBHOOK_EVENTS.join(", ")})`,
                };
            events = e.events as WebhookEvent[];
        }
        for (const key of ["secret", "name", "project"] as const) {
            if (e[key] !== undefined && typeof e[key] !== "string")
                return { webhooks: [], error: `${at}.${key} must be text` };
        }
        if (e.screenshots !== undefined && typeof e.screenshots !== "boolean")
            return { webhooks: [], error: `${at}.screenshots must be true or false` };
        out.push({
            url: url.url,
            format: format as WebhookFormat,
            ...(events ? { events } : {}),
            ...(typeof e.secret === "string" ? { secret: e.secret } : {}),
            ...(typeof e.name === "string" ? { name: e.name } : {}),
            ...(typeof e.project === "string" ? { project: e.project } : {}),
            ...(e.screenshots === false ? { screenshots: false } : {}),
        });
    }
    return { webhooks: out };
}

/** The environment variable a secret written as `env:NAME` is read from; undefined for one written as it is. */
export function secretEnvName(secret: string | undefined): string | undefined {
    return envName(secret);
}

/** The secret, with `env:NAME` read from the environment. Null when it names a variable that is not set. */
export function secretOf(
    webhook: Webhook,
    env: Record<string, string | undefined> = process.env
): string | null | undefined {
    if (webhook.secret === undefined) return undefined;
    const name = secretEnvName(webhook.secret);
    if (name === undefined) return webhook.secret;
    return env[name] || null;
}

/** The environment variable a URL written as `env:NAME` is read from; undefined for one written as it is. */
export function urlEnvName(webhook: Webhook): string | undefined {
    return envName(webhook.url);
}

/**
 * Where a webhook sends, with `env:NAME` read from the environment. Null when it names a variable that is not set, or
 * that does not hold an http or https URL: then nothing is sent to it.
 */
export function urlOf(
    webhook: Webhook,
    env: Record<string, string | undefined> = process.env
): string | null {
    const name = urlEnvName(webhook);
    if (name === undefined) return webhook.url;
    const checked = httpUrl(env[name] ?? "");
    return "url" in checked ? checked.url : null;
}

/**
 * A webhook URL as a list or a log shows it: `https://hooks.slack.com/••••`. The path and the query are what make a
 * Slack, Discord or Teams URL work, so only the host is left to recognise it by. `env:NAME` is shown as it is.
 */
export function redactUrl(raw: string): string {
    if (envName(raw) !== undefined) return raw;
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return "(not a URL)";
    }
    const hidden = url.pathname.length > 1 || url.search || url.hash;
    return `${url.protocol}//${url.host}/${hidden ? "••••" : ""}`;
}

export const signature = (secret: string, body: string) =>
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

/** What a webhook is called in the log: its name, its host, or the variable its URL is read from. */
const label = (w: Webhook) => {
    const name = urlEnvName(w);
    return w.name ?? (name === undefined ? new URL(w.url).host : `$${name}`);
};

/** Why a webhook whose URL is written as `env:NAME` has nowhere to send, for the log. */
const noUrl = (w: Webhook) =>
    `webhook ${w.name ? `${w.name}: ` : ""}$${urlEnvName(w)} is not set to an http or https URL`;

/** Where a webhook sends, host only, for the log line that says where annotation events go. */
function destination(w: Webhook, env: Record<string, string | undefined> | undefined): string {
    const name = urlEnvName(w);
    const url = urlOf(w, env);
    const where =
        name === undefined
            ? new URL(w.url).host
            : url === null
              ? `$${name}, which is not set to a URL here`
              : `${new URL(url).host} from $${name}`;
    return w.name ? `${w.name} (${where})` : where;
}

/** What is said in one line, for chat services: who, what happened, and the comment. */
function summary(event: string, a: Annotation): string {
    const what = event.replace("annotation.", "").replaceAll("_", " ");
    const target = a.target.identity[0];
    const where = target
        ? `${target.role ?? target.tag}${target.name ? ` “${target.name}”` : ""}`
        : a.target.kind;
    const severity = a.severity ? ` (${a.severity})` : "";
    const picked =
        event === "annotation.variant_chosen" && a.variants?.chosen
            ? ` — picked “${a.variants.chosen}”`
            : "";
    return `Notato · ${a.projectId}: annotation ${what}${severity} on ${a.route} — ${where}: ${clip(a.comment, 240)}${picked}`;
}

/** Slack's own escaping for message text: what is left can be read, but cannot mention or link. */
const escapeSlack = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface Delivery {
    id: string;
    event: string;
    body: string;
    headers: Record<string, string>;
}

/** The request for one event to one webhook. */
export function buildDelivery(
    webhook: Webhook,
    event: string,
    annotation: Annotation,
    secret?: string,
    now = new Date(),
    /** Links to the annotation's screenshots that work from outside, when there are some to give. */
    links?: ShotLinks
): Delivery {
    const id = ulid();
    const payload =
        webhook.format === "slack"
            ? // A note is written by anyone who can reach the app: in Slack's text, <!channel> would ping the whole channel
              // and <https://…|label> would dress up a link, so the characters that make those are escaped.
              { text: escapeSlack(summary(event, annotation)) }
            : webhook.format === "discord"
              ? // Discord pings @everyone, @here and <@id> in content unless told not to.
                {
                    content: summary(event, annotation).slice(0, 1900),
                    allowed_mentions: { parse: [] },
                }
              : webhook.format === "teams"
                ? teamsMessage(event, annotation, links)
                : {
                      id,
                      event,
                      at: now.toISOString(),
                      project: annotation.projectId,
                      annotation,
                      // The @names in what was just written: the note, or the reply. A flow can branch on them.
                      mentions: mentionsIn(
                          event.endsWith("replied")
                              ? annotation.thread[annotation.thread.length - 1]?.body
                              : event.endsWith("created")
                                ? annotation.comment
                                : undefined
                      ),
                      markdown: renderAnnotation(annotation, { detail: "standard" }),
                      ...(links ? { screenshotUrls: links } : {}),
                  };
    const body = JSON.stringify(payload);
    return {
        id,
        event,
        body,
        headers: {
            "Content-Type": "application/json",
            "User-Agent": "notato-webhook",
            "X-Notato-Event": event,
            "X-Notato-Delivery": id,
            ...(secret ? { "X-Notato-Signature": signature(secret, body) } : {}),
        },
    };
}

/** A refusal that may pass if tried again: the other end failed, was busy, or timed out waiting. */
const RETRIABLE = (status: number) => status >= 500 || status === 429 || status === 408;
/** The waits before each retry of a failed delivery. */
const RETRY_DELAYS_MS = [1000, 4000, 15000];
/** How long one delivery waits for the other end to answer. */
const DELIVERY_TIMEOUT_MS = 5000;

export interface SendOptions {
    fetch?: typeof fetch;
    /** Waits before each retry. Default 1s, 4s, 15s. */
    retryDelaysMs?: number[];
    timeoutMs?: number;
    log?: (message: string) => void;
    /** Where a secret or a URL written as `env:NAME` is read from. Default the server's own environment. */
    env?: Record<string, string | undefined>;
}

/** Sends one delivery, retrying a failure that may pass (a network error, a 5xx, a 429). Resolves true if it got through. */
export async function sendDelivery(
    webhook: Webhook,
    delivery: Delivery,
    options: SendOptions = {}
): Promise<boolean> {
    const http = options.fetch ?? fetch;
    const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
    const url = urlOf(webhook, options.env);
    if (url === null) {
        options.log?.(`${noUrl(webhook)}, so ${delivery.event} was not sent`);
        return false;
    }
    for (let attempt = 0; ; attempt++) {
        let failure: string;
        try {
            const res = await http(url, {
                method: "POST",
                headers: delivery.headers,
                body: delivery.body,
                signal: AbortSignal.timeout(options.timeoutMs ?? DELIVERY_TIMEOUT_MS),
                redirect: "manual",
            });
            if (res.ok) return true;
            failure = `status ${res.status}`;
            if (!RETRIABLE(res.status)) {
                options.log?.(
                    `webhook ${label(webhook)}: ${delivery.event} refused with ${failure}; not retried`
                );
                return false;
            }
        } catch (error) {
            failure = error instanceof Error ? error.message : String(error);
        }
        const wait = delays[attempt];
        if (wait === undefined) {
            options.log?.(
                `webhook ${label(webhook)}: ${delivery.event} failed (${failure}); gave up after ${attempt + 1} attempts`
            );
            return false;
        }
        await new Promise((resolve) => setTimeout(resolve, wait));
    }
}

/** Which webhook event an annotation event is, given what its status was last time. */
export function eventFor(
    event: NotatoEvent,
    previous: Annotation["status"] | undefined,
    /** When the variants on it were last offered, as far as this server has seen. */
    previousOffer?: string
): WebhookEvent | null {
    if (event.type === "created") return "annotation.created";
    if (event.type === "replied") return "annotation.replied";
    if (event.type === "deleted") return "annotation.deleted";
    const now = event.annotation.status;
    // A new offer comes with no change of status when it replaces an earlier one, so it is looked for first.
    const offered = event.annotation.variants?.offeredAt;
    if (offered !== undefined && offered !== previousOffer && now === "acknowledged")
        return "annotation.variants_ready";
    if (previous === now) return "annotation.updated";
    if (now === "open") {
        // Back to open from a finished state is worth telling of. From acknowledged, or from a status this server did
        // not see (it restarted), it is just a change.
        return previous && previous !== "acknowledged"
            ? "annotation.reopened"
            : "annotation.updated";
    }
    return `annotation.${now}` as WebhookEvent;
}

/** The most deliveries one webhook may have waiting before newer ones are dropped. */
const MAX_PENDING = 1000;

export interface WebhookDispatcher {
    /** Resolves once everything queued so far has been tried. */
    flush(): Promise<void>;
    stop(): void;
}

export interface DispatcherOptions extends SendOptions {
    bus: EventBus;
    config: ConfigSource;
    /** Makes the screenshot links cards and payloads carry. Without it, none are sent. */
    share?: ShareLinks;
    now?: () => Date;
}

/**
 * Sends each annotation event to the webhooks in the config, off to the side: a slow or dead endpoint never holds up
 * the API. Deliveries to one webhook go in order. The config is read for every event, so adding a webhook applies
 * at once.
 */
export function startWebhooks(options: DispatcherOptions): WebhookDispatcher {
    const lastStatus = new Map<string, Annotation["status"]>();
    const lastOffer = new Map<string, string>();
    const queues = new Map<string, Promise<void>>();
    /** Deliveries queued for each webhook and not yet tried, and how many were dropped while it was behind. */
    const pending = new Map<string, number>();
    const droppedFor = new Map<string, number>();
    const warned = new Set<string>();

    // The config file is meant to be committed, so a webhook in it sends every clone's notes on: whoever runs the
    // server is told where they go (the host only) when it starts, and again whenever that changes.
    let told = "";
    const tell = (config: ResolvedConfig) => {
        const where = config.webhooks.map((w) => destination(w, options.env)).join(", ");
        if (where === told) return;
        const count = config.webhooks.length;
        options.log?.(
            where
                ? `annotation events go to ${count === 1 ? "1 webhook" : `${count} webhooks`}: ${where}${config.file ? ` (from ${config.file})` : ""}`
                : "annotation events no longer go to any webhook"
        );
        told = where;
    };
    tell(options.config());

    const unsubscribe = options.bus.subscribe((event) => {
        // The event says what it was just before; what this dispatcher saw last is only a fallback (it forgets on restart).
        const previous = event.previous?.status ?? lastStatus.get(event.id);
        const previousOffer = event.previous ? event.previous.offeredAt : lastOffer.get(event.id);
        if (event.type === "deleted") {
            lastStatus.delete(event.id);
            lastOffer.delete(event.id);
        } else {
            lastStatus.set(event.id, event.annotation.status);
            const offered = event.annotation.variants?.offeredAt;
            if (offered) lastOffer.set(event.id, offered);
        }
        // `notato doctor` files a test annotation and deletes it: a team's channel should not hear about that.
        if (event.annotation.context?.notatoDiagnostic === true) return;
        // A whole project deleted is one act, not thousands of cards in a channel.
        if (event.bulk) return;
        const name = eventFor(event, previous, previousOffer);
        if (!name) return;

        const config = options.config();
        tell(config);
        for (const webhook of config.webhooks) {
            if (webhook.events && !webhook.events.includes(name)) continue;
            if (webhook.project && webhook.project !== event.annotation.projectId) continue;
            if (urlOf(webhook, options.env) === null) {
                // Like a missing secret: said once, and nothing is sent.
                if (!warned.has(`url ${webhook.url}`))
                    options.log?.(`${noUrl(webhook)}, so nothing is sent to it`);
                warned.add(`url ${webhook.url}`);
                continue;
            }
            const secret = secretOf(webhook, options.env);
            if (secret === null) {
                // Sending unsigned when a signature was asked for would be worse than not sending.
                if (!warned.has(webhook.url))
                    options.log?.(
                        `webhook ${label(webhook)}: ${webhook.secret} is not set, so nothing is sent to it`
                    );
                warned.add(webhook.url);
                continue;
            }
            const links =
                webhook.screenshots === false
                    ? undefined
                    : options.share?.linksFor(event.annotation);
            const key = webhook.url;
            // An endpoint that is down holds each delivery for its retries: past a backlog, newer ones are dropped
            // rather than kept in memory without end.
            const waiting = pending.get(key) ?? 0;
            if (waiting >= MAX_PENDING) {
                const dropped = (droppedFor.get(key) ?? 0) + 1;
                droppedFor.set(key, dropped);
                if (dropped === 1 || dropped % 100 === 0)
                    options.log?.(
                        `webhook ${label(webhook)}: ${MAX_PENDING} deliveries are waiting, so ${dropped} newer ones were dropped`
                    );
                continue;
            }
            pending.set(key, waiting + 1);
            const at = options.now?.();
            const annotation = event.annotation;
            const tail = queues.get(key) ?? Promise.resolve();
            queues.set(
                key,
                tail
                    // Written when it is sent, so a backlog holds the events, not every payload made in advance.
                    .then(() =>
                        sendDelivery(
                            webhook,
                            buildDelivery(webhook, name, annotation, secret, at, links),
                            options
                        )
                    )
                    .then(
                        () => undefined,
                        () => undefined
                    )
                    .finally(() => {
                        const left = (pending.get(key) ?? 1) - 1;
                        if (left > 0) pending.set(key, left);
                        else {
                            pending.delete(key);
                            droppedFor.delete(key);
                        }
                    })
            );
        }
    });

    return {
        async flush() {
            await Promise.all([...queues.values()]);
        },
        stop: unsubscribe,
    };
}
