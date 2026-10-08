import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DETAILS, type Detail, pinNumber } from "@notato/core";
import { AgentStep, type Author, Intent, Severity, VariantOption } from "@notato/schema";
import { z } from "zod";
import { agentName, waitsLong } from "./agents.ts";
import { type Backend, TEXT_MAX } from "./backend.ts";
import { formatAnnotation, formatList, plural } from "./format.ts";
import { DEFAULT_MAX_BUNDLE } from "./http.ts";
import type { StoredAnnotation } from "./storage.ts";
import { batchHeadline, WatchSession } from "./watch.ts";

export interface McpOptions {
    backend: Backend;
    version: string;
    /** Who replies and status changes are attributed to. By default, the agent the MCP client says it is. */
    agent?: Author;
    /**
     * Whether `notato_import_bundle` may read files from this machine. True for `notato dev`, where the
     * MCP process runs beside the model; a shared server turns it off.
     */
    allowImportPaths?: boolean;
    /** Cap, in seconds, on one `notato_watch` call. Over HTTP this keeps a call inside the connection idle timeout. */
    maxWaitSeconds?: number;
    /** Called once the client has introduced itself, with the name to show for it ("Codex"). */
    onClient?: (name: string | undefined) => void;
    /**
     * Why tools may not be used right now (MCP turned off on the server), or null when they may. Checked before and
     * after every call, so a `notato_watch` that was waiting when MCP went off hands over nothing.
     */
    refuse?: () => string | null;
    /**
     * The projects this agent works on (`notato dev --project`, `/mcp?project=`): what `notato_watch` and
     * `notato_list_open` hand over, and the only notes it may change. Undefined: every project, as for one app.
     */
    projects?: string[];
}

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };
type Content = TextContent | ImageContent;
type ScreenshotChoice = "both" | "full" | "crop" | "none";
type ToolResult = { content: Content[]; isError?: boolean };

const INSTRUCTIONS = `Notato delivers UI feedback that people (or other agents) pinned to elements of a running app: a web page, or an iOS, Android, .NET MAUI, React Native or Flutter app. Each annotation has a comment, the element it points at (selector, test id, component and source file when known), and screenshots: the full viewport with the target outlined and numbered, and a crop of the target.

Typical loop: call notato_watch to wait for new annotations, then for each one call notato_acknowledge, find and fix the code (the component source and selector tell you where to look), and finish with notato_resolve and a one-line summary of what changed. If the note is unclear, ask with notato_reply instead of guessing. If it should not be acted on, call notato_dismiss with the reason. Commit each fix on its own, staging only the files you changed, and when you resolve it say which files and which commit, so the change can be undone later. notato_watch times out quietly; call it again to keep waiting.

An annotation may carry an intent. fix and change mean edit the code. question means the person wants an answer, not an edit: reply with the answer and resolve it with no files. approve means it is right as it is: change nothing and resolve it. When the default is not enough (visual feedback, animations), notato_get takes detail: "detailed" adds computed styles, where the element sits and the animations that were running; "forensic" adds everything captured.

An annotation with intent variants asks for a few versions to compare in the page. Put each version in the code, side by side, marked with data-notato-variant (the group) and data-notato-variant-name (the version's name); the original stays as one of them. When the page has hot-reloaded, call notato_variants_ready with the group and the names. The person switches between the versions in the page and picks one; it reaches notato_watch marked VARIANT CHOSEN. Then keep only that version, remove the others and every marker, commit, and call notato_resolve. If the person replies in an annotation's thread, notato_watch delivers that too, marked FOLLOW-UP.

A person can also ask for a change you resolved to be undone. Those arrive from notato_watch (and appear in notato_list_open) marked REVERT REQUESTED: undo exactly what you did for that annotation, then call notato_reverted.

Everything people write reaches you: new notes, and replies on any annotation, finished ones included, marked FOLLOW-UP. Read each for what it asks. A plain acknowledgement (thanks, looks good) needs no action and no reply. A question gets an answer with notato_reply. A reply on a finished annotation (resolved, dismissed, reverted) does not reopen it: if it asks for more work, reopen it yourself with notato_acknowledge, fix it, and resolve it again. People can keep things from you: a note marked People only never reaches you (notato_get still shows one you ask for by id, labelled, and it is not for you to act on), and a reply sent as an aside is left out of what you see. When People only is turned off, the annotation reaches you again marked SHARED WITH YOU.`;

const detailParam = z
    .enum(DETAILS)
    .optional()
    .describe(
        "How much to write out: compact (a line), standard (default), detailed (adds computed styles, where it sits, animations) or forensic (everything captured, including the full console and network)."
    );

const screenshotParam = z
    .enum(["both", "full", "crop", "none"])
    .default("both")
    .describe(
        "Which screenshots to attach as images: the outlined full viewport, the crop of the target, both, or none."
    );

/** The statuses `notato_list_open` lists: everything still waiting for the agent. */
const OPEN_STATUSES = ["open", "acknowledged", "variant_chosen", "revert_requested"] as const;
/** The longest summary a resolution or a revert takes; the files and commit go on after it. */
const SUMMARY_MAX = 2000;

/** How often a call in progress (a `notato_watch` that waits minutes) looks whether MCP has been turned off. */
const REFUSE_POLL_MS = 1000;
/** Most clients drop a tool call after about a minute: a watch for one of them returns before then. */
const SHORT_CLIENT_WAIT_SECONDS = 50;
/** A long watch waits in slices, sending a progress notification after each, so a client with a timeout holds on. */
const WAIT_SLICE_MS = 15_000;
/** Once something arrives, a watch keeps collecting what follows it for at most this long. */
const COLLECT_MAX_MS = 10_000;

const text = (t: string): TextContent => ({ type: "text", text: t });
const toolText = (t: string): ToolResult => ({ content: [text(t)] });
const toolError = (t: string): ToolResult => ({ isError: true, content: [text(t)] });
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Puts `refuse` in front of every tool registered on `server` from now on. A call still running when MCP is turned
 * off ends within a second with the reason, rather than handing over what it found.
 */
function gate(server: McpServer, refuse: () => string | null) {
    const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
    (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (
        ...[name, config, handler]: unknown[]
    ) =>
        register(name, config, async (...args: unknown[]) => {
            const before = refuse();
            if (before) return toolError(before);
            let timer: ReturnType<typeof setInterval> | undefined;
            const turnedOff = new Promise<string>((resolve) => {
                timer = setInterval(() => {
                    const why = refuse();
                    if (why) resolve(why);
                }, REFUSE_POLL_MS);
            });
            try {
                const result = await Promise.race([
                    (handler as (...a: unknown[]) => Promise<unknown>)(...args),
                    turnedOff.then(toolError),
                ]);
                const after = refuse();
                return after ? toolError(after) : result;
            } finally {
                clearInterval(timer);
            }
        });
}

/** How a note is named to the agent: its pin number when it has one, and always its id. */
const label = (s: StoredAnnotation) => {
    const pin = pinNumber(s.annotation);
    return pin ? `#${pin} (${s.annotation.id})` : s.annotation.id;
};

const notFound = (id: string) => toolError(`No annotation with id "${id}".`);

/**
 * The MCP server an agent talks to: the tools to wait for notes (`notato_watch`), read them, work through them, offer
 * versions, undo a change, import a bundle and file a note of its own. One per agent session.
 */
export function createMcpServer(options: McpOptions): McpServer {
    const { backend, version } = options;
    /** Several repositories can share one server: an agent kept to its own projects never sees another's notes as work. */
    const scope = options.projects?.length ? [...new Set(options.projects)] : undefined;
    const scopeText = scope
        ? `${scope.length === 1 ? "project" : "projects"} ${scope.join(", ")}`
        : "every project";
    const server = new McpServer(
        { name: "notato", version },
        {
            instructions: scope
                ? `${INSTRUCTIONS}\n\nThis session works on ${scopeText}. notato_watch and notato_list_open hand over only those notes; a note for another project is about other code, and is left to the agent working on it.`
                : INSTRUCTIONS,
        }
    );
    /** What the client called itself in `initialize`: "claude-code", "codex-mcp-client", "cursor-vscode"… */
    const client = () => server.server.getClientVersion()?.name;
    /** Replies and status changes are signed with the agent's own name, so people see who did what. */
    const author = (): Author =>
        options.agent ?? { kind: "agent", name: agentName(client()) ?? "Agent" };
    server.server.oninitialized = () => options.onClient?.(agentName(client()));
    if (options.refuse) gate(server, options.refuse);
    /** What this session has handed its agent, so a backlog is delivered once and then only what is new. */
    const session = new WatchSession(backend);

    /** Refuses changing a People only note: it is between people, and the agent was asked to leave it. */
    const keptFromAgent = (stored: StoredAnnotation | null) =>
        stored?.annotation.peopleOnly
            ? toolError(
                  `${label(stored)} is People only: the people on it are keeping it between themselves, so leave it alone. It reaches notato_watch if someone turns People only off.`
              )
            : null;

    /** Whether a note is for a project this session does not work on: it is about someone else's code. */
    const elsewhere = (stored: StoredAnnotation) =>
        scope !== undefined && !scope.includes(stored.annotation.projectId);

    /** Why this session may not change an annotation, or null when it may. */
    const refusal = (stored: StoredAnnotation | null) =>
        stored && elsewhere(stored)
            ? toolError(
                  `${label(stored)} is for project ${stored.annotation.projectId}, and this session works on ${scopeText}. Leave it to the agent working on that code.`
              )
            : keptFromAgent(stored);

    /** Refuses a call that names a project this session does not work on. */
    const notMine = (projectId: string | undefined) =>
        projectId !== undefined && scope && !scope.includes(projectId)
            ? toolError(
                  `This session works on ${scopeText}, not ${projectId}. Notes for ${projectId} are left to the agent working on that code.`
              )
            : null;

    /** The screenshots asked for, as images the model can see. */
    async function screenshotContent(
        stored: StoredAnnotation,
        which: ScreenshotChoice
    ): Promise<ImageContent[]> {
        const shots = stored.annotation.screenshots;
        const refs = [
            which === "both" || which === "full" ? shots?.full : undefined,
            which === "both" || which === "crop" ? shots?.crop : undefined,
        ].filter((r) => r !== undefined);
        const out: ImageContent[] = [];
        for (const ref of refs) {
            const asset = await backend.asset(ref.id);
            if (asset)
                out.push({
                    type: "image",
                    data: Buffer.from(asset.bytes).toString("base64"),
                    mimeType: ref.mime,
                });
        }
        return out;
    }

    /** A note as the agent reads it: the Markdown, then the screenshots asked for. */
    async function describe(
        stored: StoredAnnotation,
        which: ScreenshotChoice,
        detail?: Detail,
        followUp = false
    ): Promise<Content[]> {
        const images = await screenshotContent(stored, which);
        return [
            text(
                formatAnnotation(stored, {
                    screenshotsAttached: images.length > 0,
                    detail,
                    followUp,
                })
            ),
            ...images,
        ];
    }

    server.registerTool(
        "notato_list_open",
        {
            title: "List open annotations",
            description:
                "List annotations that are open, acknowledged, waiting for you to apply a variant the person picked, or waiting for you to undo a change (not resolved, reverted or dismissed), oldest first, a page at a time (pass `after` for the next page). Text only; use notato_get for screenshots.",
            inputSchema: {
                projectId: z.string().optional().describe("Only this project."),
                route: z
                    .string()
                    .optional()
                    .describe("Only annotations made on this route, e.g. /checkout."),
                severity: Severity.optional(),
                intent: Intent.optional().describe(
                    "Only fixes, changes, questions, approvals or variant requests."
                ),
                bundleId: z
                    .string()
                    .optional()
                    .describe("Only annotations from this imported bundle."),
                limit: z.number().int().min(1).max(200).default(50),
                after: z
                    .number()
                    .int()
                    .min(0)
                    .optional()
                    .describe("The next page: the `after` value the last page ended with."),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ projectId, route, severity, intent, bundleId, limit, after }) => {
            const refused = notMine(projectId);
            if (refused) return refused;
            // One more than asked for, to know whether there is another page.
            const items = await backend.list({
                projectId: projectId ?? scope,
                route,
                severity,
                intent,
                bundleId,
                status: [...OPEN_STATUSES],
                peopleOnly: false,
                ...(after !== undefined ? { afterSeq: after } : {}),
                limit: limit + 1,
            });
            const page = items.slice(0, limit);
            const more = items.length > limit ? page.at(-1)?.seq : undefined;
            return toolText(
                formatList(page) +
                    (more !== undefined
                        ? `\n\nThere are more: call notato_list_open again with after: ${more}.`
                        : "")
            );
        }
    );

    server.registerTool(
        "notato_get",
        {
            title: "Get one annotation",
            description:
                "One annotation in full, with its screenshots returned as images so you can see what the person saw. Asides are left out; a People only note is labelled, and is not for you to act on.",
            inputSchema: { id: z.string(), screenshots: screenshotParam, detail: detailParam },
            annotations: { readOnlyHint: true },
        },
        async ({ id, screenshots, detail }) => {
            const stored = await backend.get(id);
            if (!stored) return notFound(id);
            const content = await describe(stored, screenshots, detail);
            // Readable, as a People only note is, but labelled: it is about code this session does not work on.
            if (elsewhere(stored))
                content.unshift(
                    text(
                        `Not this session's: this note is for project ${stored.annotation.projectId}, and this session works on ${scopeText}. Read it if it helps, but leave it to the agent working on that code.`
                    )
                );
            return { content };
        }
    );

    server.registerTool(
        "notato_watch",
        {
            title: "Wait for new annotations",
            description:
                "Block until new open annotations arrive, the person picks one of the variants you offered (marked VARIANT CHOSEN), asks for a change you resolved to be undone (marked REVERT REQUESTED), replies on any annotation, finished ones included (marked FOLLOW-UP), or hands one back by turning People only off (marked SHARED WITH YOU). People only notes and asides never arrive. Waits a short window so a burst is delivered together, then returns them with screenshots. Anything already waiting when you first call it is delivered too; each annotation is delivered once per session, and each reply once in all (a new session is not handed replies an earlier one was), at most twenty replies a call. Returns quietly on timeout: call it again to keep waiting.",
            inputSchema: {
                projectId: z
                    .string()
                    .optional()
                    .describe("Only this project. Default: every project this session works on."),
                timeoutSeconds: z
                    .number()
                    .int()
                    .min(1)
                    .max(3600)
                    .default(120)
                    .describe("How long to wait for the first annotation."),
                windowMs: z
                    .number()
                    .int()
                    .min(0)
                    .max(10_000)
                    .default(1500)
                    .describe("After the first arrival, keep collecting for this long."),
                screenshots: screenshotParam,
                detail: detailParam,
                maxAnnotations: z
                    .number()
                    .int()
                    .min(1)
                    .max(20)
                    .default(5)
                    .describe("Annotations returned with images; the rest are listed as text."),
            },
            annotations: { readOnlyHint: true },
        },
        async (
            { projectId: asked, timeoutSeconds, windowMs, screenshots, detail, maxAnnotations },
            extra
        ) => {
            const refused = notMine(asked);
            if (refused) return refused;
            const projects = asked ?? scope;
            const clientCap = waitsLong(client())
                ? Number.POSITIVE_INFINITY
                : SHORT_CLIENT_WAIT_SECONDS;
            const waitSeconds = Math.min(
                timeoutSeconds,
                clientCap,
                options.maxWaitSeconds ?? Number.POSITIVE_INFINITY
            );
            const deadline = Date.now() + waitSeconds * 1000;
            const progressToken = extra._meta?.progressToken;

            let ready = false;
            for (let ticks = 1; !ready && Date.now() < deadline && !extra.signal.aborted; ticks++) {
                ready = await session.waitForWork(
                    projects,
                    Math.min(WAIT_SLICE_MS, deadline - Date.now()),
                    extra.signal
                );
                // Progress pings keep a client with a request timeout from giving up on a long wait.
                if (!ready && progressToken !== undefined) {
                    await extra
                        .sendNotification({
                            method: "notifications/progress",
                            params: {
                                progressToken,
                                progress: ticks,
                                message: "waiting for annotations",
                            },
                        })
                        .catch(() => {});
                }
            }
            if (!ready)
                return toolText("No new annotations. Call notato_watch again to keep waiting.");

            // The collection window: keep going while more arrive, for at most COLLECT_MAX_MS in all.
            let seen = await session.waiting(projects);
            const windowEnd = Date.now() + COLLECT_MAX_MS;
            while (windowMs > 0 && Date.now() < windowEnd && !extra.signal.aborted) {
                await new Promise((resolve) => setTimeout(resolve, windowMs));
                const now = await session.waiting(projects);
                if (now === seen) break;
                seen = now;
            }

            const batch = await session.take(projects);
            // What is about work the agent already did (undo requests, picks, replies) comes before new notes.
            const ordered = [...batch.undo, ...batch.picks, ...batch.replies, ...batch.fresh];
            const replyIds = new Set(batch.replies.map((r) => r.annotation.id));
            const content: Content[] = [text(batchHeadline(batch))];
            for (const stored of ordered.slice(0, maxAnnotations))
                content.push(
                    ...(await describe(
                        stored,
                        screenshots,
                        detail,
                        replyIds.has(stored.annotation.id)
                    ))
                );
            const rest = ordered.slice(maxAnnotations);
            if (rest.length)
                content.push(
                    text(
                        `${rest.length} more, text only (use notato_get for screenshots):\n${formatList(rest)}`
                    )
                );
            if (batch.laterReplies)
                content.push(
                    text(
                        `${plural(batch.laterReplies, "more reply", "more replies")} from the person waiting: call notato_watch again for them.`
                    )
                );
            return { content };
        }
    );

    server.registerTool(
        "notato_acknowledge",
        {
            title: "Acknowledge an annotation",
            description:
                "Mark an annotation as acknowledged so the person sees it is being worked on. On a finished one (resolved, dismissed, reverted) this reopens it: do that when a follow-up asks for more work.",
            inputSchema: {
                id: z.string(),
                note: z
                    .string()
                    .max(TEXT_MAX)
                    .optional()
                    .describe("Optional message shown in the thread."),
            },
        },
        async ({ id, note }) => {
            const existing = await backend.get(id);
            const refused = refusal(existing);
            if (refused) return refused;
            // Acknowledging would wipe a revert request or a pick. Keep it, and record the note if there is one.
            const kept =
                existing?.annotation.status === "revert_requested"
                    ? "is a revert request, so it stays marked that way. Undo the change, then call notato_reverted."
                    : existing?.annotation.status === "variant_chosen"
                      ? "has a variant picked, so it stays marked that way. Apply the pick, then call notato_resolve."
                      : undefined;
            if (existing && kept) {
                if (note) await backend.reply(id, note, author());
                return toolText(`${label(existing)} ${kept}`);
            }
            const stored = await backend.setStatus(id, "acknowledged", note, author());
            return stored ? toolText(`Acknowledged ${label(stored)}.`) : notFound(id);
        }
    );

    server.registerTool(
        "notato_reply",
        {
            title: "Reply in an annotation's thread",
            description:
                "Add a message to the thread, for example to ask what was meant. Does not change the status.",
            inputSchema: { id: z.string(), body: z.string().min(1).max(TEXT_MAX) },
        },
        async ({ id, body }) => {
            const refused = refusal(await backend.get(id));
            if (refused) return refused;
            const stored = await backend.reply(id, body, author());
            return stored ? toolText(`Replied on ${label(stored)}.`) : notFound(id);
        }
    );

    server.registerTool(
        "notato_resolve",
        {
            title: "Resolve an annotation",
            description:
                "Mark an annotation resolved once the change is made. The summary appears in the thread and the pin turns green. List the files you changed (and the commit, if you made one): that is what lets the change be undone later if the person asks.",
            inputSchema: {
                id: z.string(),
                summary: z.string().min(1).max(SUMMARY_MAX).describe("One line on what changed."),
                files: z.array(z.string()).optional().describe("Paths of the files you changed."),
                commit: z
                    .string()
                    .optional()
                    .describe("The commit that holds the change, if you made one."),
            },
        },
        async ({ id, summary, files, commit }) => {
            const existing = await backend.get(id);
            const refused = refusal(existing);
            if (refused) return refused;
            if (existing?.annotation.status === "revert_requested")
                return toolError(
                    `${label(existing)} is waiting for you to undo a change, not to make one. Undo it, then call notato_reverted.`
                );
            const where = [
                files?.length ? `Files: ${files.join(", ")}` : "",
                commit ? `Commit: ${commit}` : "",
            ].filter(Boolean);
            // A long list of files must not push the note past what the server keeps (it is refused, not cut, over HTTP).
            const note = [`Resolved: ${summary}`, ...where].join("\n").slice(0, TEXT_MAX);
            const stored = await backend.setStatus(id, "resolved", note, author());
            return stored ? toolText(`Resolved ${label(stored)}.`) : notFound(id);
        }
    );

    server.registerTool(
        "notato_dismiss",
        {
            title: "Dismiss an annotation",
            description:
                "Dismiss an annotation that should not be acted on (duplicate, works as intended, out of scope).",
            inputSchema: { id: z.string(), reason: z.string().min(1).max(TEXT_MAX) },
        },
        async ({ id, reason }) => {
            const existing = await backend.get(id);
            const refused = refusal(existing);
            if (refused) return refused;
            if (existing?.annotation.status === "revert_requested")
                return toolError(
                    `${label(existing)} is a revert request. If you cannot undo the change, say why with notato_reply and leave it for the person.`
                );
            const stored = await backend.setStatus(
                id,
                "dismissed",
                `Dismissed: ${reason}`,
                author()
            );
            return stored ? toolText(`Dismissed ${label(stored)}.`) : notFound(id);
        }
    );

    server.registerTool(
        "notato_variants_ready",
        {
            title: "Offer versions for the person to compare",
            description:
                'Call this for an annotation that asked for variants, once you have put every version in the code and the page has reloaded. Each version is an element with data-notato-variant="<group>" (the same value on all of them) and data-notato-variant-name="<name>" (a different name each; the original is one of them, first). The page then shows a switcher on those elements, and the person picks one with “Use this”. The pick reaches notato_watch marked VARIANT CHOSEN. Calling it again replaces the offer, for when you have changed the versions after a reply.',
            inputSchema: {
                id: z.string(),
                group: z
                    .string()
                    .describe("The data-notato-variant value used in the code, e.g. header."),
                options: z
                    .array(VariantOption)
                    .min(2)
                    .max(12)
                    .describe(
                        "The original first, then each new version: name (must match data-notato-variant-name exactly) and a one-line summary of how it differs."
                    ),
                note: z
                    .string()
                    .max(TEXT_MAX)
                    .optional()
                    .describe("Message for the thread. A listing of the names is used if omitted."),
            },
        },
        async ({ id, group, options: versions, note }) => {
            const existing = await backend.get(id);
            const refused = refusal(existing);
            if (refused) return refused;
            if (!existing) return notFound(id);
            if (existing.annotation.status === "revert_requested")
                return toolError(
                    `${label(existing)} is waiting for you to undo a change, not to offer versions. Undo it, then call notato_reverted.`
                );
            let stored: StoredAnnotation | null;
            try {
                stored = await backend.offerVariants(
                    id,
                    { group, options: versions, note },
                    author()
                );
            } catch (error) {
                return toolError(messageOf(error));
            }
            if (!stored) return notFound(id);
            return toolText(
                `Offered ${versions.length} versions on ${label(stored)}: ${versions.map((v) => v.name).join(", ")}. The page shows a switcher for elements with data-notato-variant="${group}"; each version needs data-notato-variant-name set to exactly one of those names. The pick arrives through notato_watch as VARIANT CHOSEN.`
            );
        }
    );

    server.registerTool(
        "notato_reverted",
        {
            title: "Report that a change was undone",
            description:
                "Call this once you have undone the change for an annotation whose revert was requested (notato_watch and notato_list_open mark those REVERT REQUESTED). The summary appears in the thread and the pin shows as reverted.",
            inputSchema: {
                id: z.string(),
                summary: z.string().min(1).max(SUMMARY_MAX).describe("One line on what you undid."),
            },
        },
        async ({ id, summary }) => {
            const existing = await backend.get(id);
            const refused = refusal(existing);
            if (refused) return refused;
            if (!existing) return notFound(id);
            if (existing.annotation.status !== "revert_requested")
                return toolError(
                    `No revert was requested for ${label(existing)} (it is ${existing.annotation.status}). Nothing was changed.`
                );
            const stored = await backend.setStatus(
                id,
                "reverted",
                `Reverted: ${summary}`,
                author()
            );
            return stored ? toolText(`Marked ${label(stored)} reverted.`) : notFound(id);
        }
    );

    server.registerTool(
        "notato_import_bundle",
        {
            title: "Import a feedback bundle",
            description:
                "Load a bundle zip exported by a tester (Package button) or an agent into the store. Its annotations then show up in notato_list_open and notato_watch. Importing the same bundle twice is safe.",
            inputSchema: { path: z.string().describe("Path to the .zip file on this machine.") },
        },
        async ({ path }) => {
            if (options.allowImportPaths === false)
                return toolError(
                    "This server does not read files from disk. Upload the bundle in the web UI or POST it to /projects/<id>/bundles."
                );
            const file = resolve(path);
            const info = await stat(file).catch(() => null);
            if (!info?.isFile()) return toolError(`No file at ${file}.`);
            if (info.size > DEFAULT_MAX_BUNDLE)
                return toolError(
                    `That file is larger than the ${DEFAULT_MAX_BUNDLE / 1024 / 1024} MB bundle limit.`
                );
            try {
                const result = await backend.importBundle(new Uint8Array(await readFile(file)));
                const counts = `${plural(result.imported, "new annotation")}${result.skipped ? `, ${result.skipped} already present` : ""}`;
                const next =
                    scope && !scope.includes(result.projectId)
                        ? `This session works on ${scopeText}, so notato_watch and notato_list_open will not hand them to you: they are for the agent working on ${result.projectId}.`
                        : `Use notato_list_open with bundleId "${result.bundleId}" or notato_watch to work through them.`;
                return toolText(
                    `Imported bundle ${result.bundleId} for project ${result.projectId}: ${counts}. ${next}`
                );
            } catch (error) {
                return toolError(`Could not import: ${messageOf(error)}`);
            }
        }
    );

    server.registerTool(
        "notato_annotate",
        {
            title: "File an annotation from an agent",
            description:
                'Ask the connected browser tab to annotate an element, as if a person had pinned a note there: same element identity, screenshots and thread. Use it when you are exploring the app and find something wrong but cannot call window.__notato.annotate yourself. Needs the app open with <Notato mode="agent" server="…" />.',
            inputSchema: {
                target: z
                    .string()
                    .describe(
                        "CSS selector of the element to annotate. Reach inside an iframe or a shadow root with >>>, e.g. `iframe#preview >>> button.pay`."
                    ),
                comment: z.string().min(1).max(TEXT_MAX).describe("What is wrong, specifically."),
                severity: Severity.optional(),
                intent: Intent.optional().describe(
                    "fix, change, question (an answer is wanted), or approve."
                ),
                steps: z
                    .array(AgentStep)
                    .max(100)
                    .optional()
                    .describe("The steps you took to get there."),
                projectId: z
                    .string()
                    .optional()
                    .describe(
                        "Needed only when several projects have a page open, or this session works on more than one."
                    ),
                timeoutSeconds: z.number().int().min(1).max(120).default(60),
                screenshots: screenshotParam,
            },
        },
        async ({
            target,
            comment,
            severity,
            intent,
            steps,
            projectId,
            timeoutSeconds,
            screenshots,
        }) => {
            const refused = notMine(projectId);
            if (refused) return refused;
            // Kept to one project: that one's page, even when another project has a page open too.
            const project = projectId ?? (scope?.length === 1 ? scope[0] : undefined);
            if (project === undefined && scope)
                return toolError(`This session works on ${scopeText}: pass projectId.`);
            let result: Awaited<ReturnType<Backend["requestAnnotation"]>>;
            try {
                result = await backend.requestAnnotation(
                    project,
                    { target, comment, severity, intent, steps, author: author().name },
                    timeoutSeconds * 1000
                );
            } catch (error) {
                return toolError(messageOf(error));
            }
            if (!result.ok) return toolError(`The page could not annotate: ${result.error}`);
            const stored = await backend.get(result.annotationId);
            if (!stored)
                return toolText(
                    `Annotation ${result.annotationId} was created in the page but has not reached the server yet; it will be delivered when the connection is back.`
                );
            return { content: [text("Filed."), ...(await describe(stored, screenshots))] };
        }
    );

    return server;
}
