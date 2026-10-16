import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { sampleAnnotation } from "@notato/schema";
import {
    buildDelivery,
    CONFIG_FILE,
    parseWebhooks,
    readWebhooks,
    redactUrl,
    secretEnvName,
    secretOf,
    sendDelivery,
    urlEnvName,
    urlOf,
    WEBHOOK_EVENTS,
    type Webhook,
    type WebhookEvent,
    writeWebhooks,
} from "@notato/server";
import { configFile } from "../options.ts";
import { type CommandOutput, collectOutput, UsageError } from "../output.ts";

const HELP = `notato config webhook

Sends an event to a URL whenever an annotation is created or changes: a Slack or Discord channel, a build hook,
your own service. They are kept in ${CONFIG_FILE} and a running server picks a change up on its own.

Usage:
  notato config webhook                     List them
  notato config webhook add <url|env:NAME> [options]
  notato config webhook remove <url|name>
  notato config webhook test <url|name>     Send a sample event now and say what the other end answered

The file is meant to be committed, and a Slack, Discord or Teams URL lets anyone who has it post to the channel. Write
env:NAME instead of the URL to read it from an environment variable where the server runs. Lists show only the host.

Options for add:
  -e, --event <name>     Only this event; repeat for more. Every event when left out.
                         ${WEBHOOK_EVENTS.map((e) => e.replace("annotation.", "")).join(", ")}
  -F, --format <format>  json (the whole payload), slack or discord (one line of text), or teams (a card, for a
                         Teams workflow's webhook URL). Default json.
  -s, --secret <value>   Sign each body (HMAC-SHA256 in X-Notato-Signature). Write env:NAME to read the secret from
                         an environment variable, so it never goes in a file that is committed.
      --secret-in-file   Save a secret written as it is in the file anyway (refused without this)
  -n, --name <name>      What to call it
  -p, --project <id>     Only this project's annotations

Common options:
  -f, --file <path>      The config file (default $NOTATO_CONFIG, or ./${CONFIG_FILE})
  -C, --cwd <path>       Treat this as the current directory`;

const labelOf = (w: Webhook) => w.name ?? redactUrl(w.url);

/** The host a webhook sends to, with `env:NAME` read from this shell; undefined when it is not set here. */
function hostIn(w: Webhook, env: Record<string, string | undefined>): string | undefined {
    const url = urlOf(w, env);
    return url === null ? undefined : new URL(url).host;
}

/** One line each, for `list` and for `notato config`. */
export function describeWebhook(w: Webhook): string {
    const bits = [
        w.format,
        w.events ? w.events.map((e) => e.replace("annotation.", "")).join("+") : "all events",
        w.project ? `project ${w.project}` : undefined,
        w.secret
            ? `signed${secretEnvName(w.secret) ? ` (${w.secret})` : ", with the secret in the file"}`
            : "unsigned",
    ].filter(Boolean);
    // The path and the query of many webhook URLs are the credential, so a list shows the host only.
    return `${w.name ? `${w.name}  ` : ""}${redactUrl(w.url)}  [${bits.join("; ")}]`;
}

function find(
    list: Webhook[],
    what: string | undefined,
    env: Record<string, string | undefined>
): Webhook {
    if (!what) throw new UsageError("which webhook? Give its URL or its name");
    const hits = list.filter((w) => w.url === what || w.name === what || hostIn(w, env) === what);
    if (hits.length === 0)
        throw new UsageError(
            `no webhook matches "${what}". ${list.length ? "Try `notato config webhook`." : "There are none."}`
        );
    if (hits.length > 1)
        throw new UsageError(`"${what}" matches ${hits.length} webhooks; give the full URL`);
    return hits[0] as Webhook;
}

export interface WebhookDeps {
    fetch?: typeof fetch;
}

/** `notato config webhook ...`: the arguments are those after `webhook`. */
export async function runWebhook(
    argv: string[],
    env: Record<string, string | undefined> = process.env,
    defaultCwd: string = process.cwd(),
    deps: WebhookDeps = {}
): Promise<CommandOutput> {
    const { out, err, done } = collectOutput();
    try {
        const { values, positionals } = parseArgs({
            args: argv,
            allowPositionals: true,
            options: {
                event: { type: "string", short: "e", multiple: true },
                format: { type: "string", short: "F" },
                secret: { type: "string", short: "s" },
                "secret-in-file": { type: "boolean" },
                name: { type: "string", short: "n" },
                project: { type: "string", short: "p" },
                file: { type: "string", short: "f" },
                cwd: { type: "string", short: "C" },
                help: { type: "boolean", short: "h" },
            },
        });
        if (values.help) {
            out.push(HELP);
            return done(0);
        }
        const cwd = resolve(values.cwd ?? defaultCwd);
        const file = configFile(values.file, cwd, env);
        const [action = "list", ...rest] = positionals;

        if (action === "list" || action === "show") {
            const hooks = readWebhooks(file);
            if (hooks.length === 0)
                out.push(`No webhooks in ${file}. Add one with: notato config webhook add <url>`);
            else {
                out.push(`Webhooks (${file}):`);
                for (const w of hooks) out.push(`  ${describeWebhook(w)}`);
            }
            return done(0);
        }

        if (action === "add") {
            const url = rest[0];
            if (!url)
                throw new UsageError("add what? Give the URL: notato config webhook add <url>");
            // The file is meant to be committed: a secret written in it is everyone's who can read the repository.
            if (values.secret && !secretEnvName(values.secret) && !values["secret-in-file"])
                throw new UsageError(
                    `a secret written as it is would be saved in ${file}, which is meant to be committed. Write env:NAME to read it from an environment variable where the server runs (--secret env:NOTATO_HOOK_SECRET), or add --secret-in-file to save it in the file anyway`
                );
            const candidate: Record<string, unknown> = { url };
            if (values.event?.length) {
                // `-e resolved` is as good as `-e annotation.resolved`.
                candidate.events = values.event.map((e) =>
                    e.includes(".") ? e : `annotation.${e}`
                );
            }
            if (values.format) candidate.format = values.format;
            if (values.secret) candidate.secret = values.secret;
            if (values.name) candidate.name = values.name;
            if (values.project) candidate.project = values.project;
            const checked = parseWebhooks([candidate]);
            if (checked.error) throw new UsageError(checked.error.replace(/^webhooks\[0\]\.?/, ""));
            const added = checked.webhooks[0] as Webhook;
            let replaced = false;
            const now = writeWebhooks(file, (list) => {
                replaced = list.some((w) => w.url === added.url);
                return [...list.filter((w) => w.url !== added.url), added];
            });
            out.push(`${replaced ? "Updated" : "Added"} ${describeWebhook(added)}`);
            const urlVar = urlEnvName(added);
            const secretVar = secretEnvName(added.secret);
            for (const [name, what] of [
                [urlVar, "the webhook's URL"],
                [secretVar, "the secret"],
            ] as const) {
                if (name !== undefined && !env[name])
                    out.push(
                        `Note: $${name} is not set here. Set it to ${what} where the server runs, or nothing will be sent to this webhook.`
                    );
            }
            if (urlVar === undefined && (added.format !== "json" || new URL(added.url).search))
                out.push(
                    `Note: the URL is saved as it is in ${file}, and anyone who has it can post to it. If the file is committed, keep the URL in an environment variable where the server runs and add env:NAME instead.`
                );
            const target = urlOf(added, env);
            if (
                target !== null &&
                !added.secret &&
                !/^https:/.test(target) &&
                !/^http:\/\/(localhost|127\.|\[::1\])/.test(target)
            )
                out.push(
                    "Note: this URL is plain http and the body is not signed; anyone on the way can read or forge it."
                );
            // Named so the URL is not printed again: by its name, the variable it is read from, or a host only it has.
            const host = hostIn(added, env);
            const ref =
                added.name ??
                (urlVar !== undefined
                    ? added.url
                    : now.filter((w) => hostIn(w, env) === host).length === 1
                      ? host
                      : undefined);
            out.push(
                `A running server starts sending to it with the next event. Try it: notato config webhook test ${ref ?? "<its URL>"}`
            );
            return done(0);
        }

        if (action === "remove" || action === "rm") {
            const hooks = readWebhooks(file);
            const gone = find(hooks, rest[0], env);
            writeWebhooks(file, (list) => list.filter((w) => w.url !== gone.url));
            out.push(`Removed ${labelOf(gone)}.`);
            return done(0);
        }

        if (action === "test") {
            const hook = find(readWebhooks(file), rest[0], env);
            if (urlOf(hook, env) === null)
                throw new Error(
                    `$${urlEnvName(hook)} is not set to an http or https URL in this shell, so there is nowhere to send the test. Set it and run again.`
                );
            const secret = secretOf(hook, env);
            if (secret === null)
                throw new Error(
                    `${hook.secret} is not set in this shell, so the test cannot be signed. Set it and run again.`
                );
            const sample = {
                ...sampleAnnotation,
                comment:
                    "This is a test event from `notato config webhook test`. Nothing is wrong.",
            };
            const event: WebhookEvent = "annotation.created";
            const delivery = buildDelivery(hook, event, sample, secret);
            const log: string[] = [];
            const ok = await sendDelivery(hook, delivery, {
                fetch: deps.fetch,
                retryDelaysMs: [],
                log: (m) => log.push(m),
                env,
            });
            if (ok) {
                out.push(`Sent a sample ${event} to ${labelOf(hook)}; it answered with success.`);
                return done(0);
            }
            err.push(
                `The test to ${labelOf(hook)} did not get through.`,
                ...log.map((l) => `  ${l}`)
            );
            return done(1);
        }

        throw new UsageError(`unknown action "${action}". Use list, add, remove or test`);
    } catch (error) {
        err.push(
            `notato config webhook: ${error instanceof Error ? error.message : String(error)}`
        );
        return done(error instanceof UsageError ? 2 : 1);
    }
}
