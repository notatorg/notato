import {
    createCipheriv,
    createDecipheriv,
    createHmac,
    randomBytes,
    timingSafeEqual,
} from "node:crypto";
import { type Annotation, Intent, Severity } from "@notato/schema";
import { z } from "zod";
import {
    conditionsMatch,
    hasWorkflowTag,
    WorkflowConditions,
    WorkflowTag,
    workflowTags,
} from "./conditions.ts";

export { hasWorkflowTag, tagPattern, WorkflowTag } from "./conditions.ts";

export const Provider = z.enum([
    "github",
    "azure",
    "teams",
    "slack",
    "webhook",
    "linear",
    "gitlab",
]);
export type Provider = z.infer<typeof Provider>;
export class PluginError extends Error {
    constructor(
        message: string,
        readonly status = 400
    ) {
        super(message);
    }
}
const name = z.string().trim().min(1).max(120);
const identifier = z.string().trim().min(1).max(200);
export const Destination = z.discriminatedUnion("provider", [
    z
        .object({
            provider: z.literal("github"),
            repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
            labels: z.array(name).max(20).default([]),
            assignee: name.optional(),
        })
        .strict(),
    z
        .object({
            provider: z.literal("azure"),
            organization: z.string().regex(/^[\w-]+$/),
            project: identifier,
            workItemType: name.default("Bug"),
            area: identifier.optional(),
            assignee: identifier.optional(),
        })
        .strict(),
    z.object({ provider: z.literal("teams") }).strict(),
    z
        .object({ provider: z.literal("slack"), channel: z.string().regex(/^[CG][A-Z0-9]{8,}$/) })
        .strict(),
    z.object({ provider: z.literal("webhook") }).strict(),
    z
        .object({
            provider: z.literal("linear"),
            team: z.uuid(),
            labels: z.array(z.uuid()).max(20).default([]),
            assignee: z.uuid().optional(),
        })
        .strict(),
    z
        .object({
            provider: z.literal("gitlab"),
            project: identifier,
            labels: z.array(name).max(20).default([]),
            assignee: z.number().int().positive().optional(),
        })
        .strict(),
]);
export type Destination = z.infer<typeof Destination>;
export const ConnectionInput = z
    .object({
        name,
        provider: Provider,
        credential: z.string().min(1).max(16000),
        installationId: z
            .string()
            .regex(/^\d{1,20}$/)
            .optional(),
        signingSecret: z.string().min(32).max(200).optional(),
        refreshToken: z.string().min(1).max(16000).optional(),
    })
    .strict();
export const ActionInput = z
    .object({ name, connectionId: z.uuid(), projectId: identifier, destination: Destination })
    .strict();
export const ActionEditInput = ActionInput.extend({
    expectedUpdatedAt: z.iso.datetime().optional(),
});
export const WorkflowInput = z
    .object({
        name,
        actionId: z.uuid(),
        enabled: z.boolean().default(true),
        trigger: z.enum(["created", "resolved", "awaiting_response", "unanswered", "daily_digest"]),
        severity: Severity.optional(),
        intent: Intent.optional(),
        tag: WorkflowTag.optional(),
        includePersonal: z.boolean().optional(),
        conditions: WorkflowConditions.optional(),
        hourUtc: z.number().int().min(0).max(23).default(9),
        delayHours: z.number().int().min(1).max(168).default(24),
    })
    .strict();
export const WorkflowEditInput = WorkflowInput.extend({
    expectedUpdatedAt: z.iso.datetime().optional(),
});
export type Action = z.infer<typeof ActionInput> & {
    archived?: boolean;
    id: string;
    workspaceId: string;
    creator: string;
    updatedAt: string;
};
export type Workflow = z.infer<typeof WorkflowInput> & {
    id: string;
    workspaceId: string;
    creator: string;
    createdAt: string;
    updatedAt?: string;
};
export interface Connection {
    id: string;
    workspaceId: string;
    name: string;
    provider: Provider;
    encrypted: string;
    createdAt: string;
    revoked: boolean;
    revision?: string;
    health?: {
        status: "ready" | "attention" | "unchecked" | "unavailable";
        checkedAt: string;
        message: string;
    };
}
export interface Payload {
    connectionRevision?: string;
    visibility?: boolean;
    personal?: boolean;
    title: string;
    text: string;
    url: string;
    noteIds: string[];
}
export interface Result {
    url?: string;
    reference?: string;
}
export interface Job {
    id: string;
    workspaceId: string;
    actionId: string;
    actor: string;
    noteId: string | null;
    workflowId: string | null;
    status: string;
    attempts: number;
    createdAt: string;
    result?: Result;
    error?: string;
    payload?: Payload;
    /** Stored separately from outbound content; never exposes personal delivery history to teammates. */
    personalActor?: string;
}

export function personalWorkflowMatch(w: Workflow, note: Annotation) {
    return Boolean(
        w.includePersonal &&
            note.visibility === "personal" &&
            note.createdBy === w.creator &&
            workflowTags(w).some((tag) => hasWorkflowTag(note, tag)) &&
            conditionsMatch(w, note)
    );
}
export function workflowMatches(w: Workflow, note: Annotation) {
    return (
        !note.peopleOnly &&
        !note.review?.draft &&
        note.author.kind !== "agent" &&
        (note.visibility !== "personal" || personalWorkflowMatch(w, note)) &&
        conditionsMatch(w, note)
    );
}

export function keyFromEnv(value = process.env.NOTATO_PLUGIN_KEY) {
    if (!value || !/^[0-9a-f]{64}$/i.test(value)) return null;
    return Buffer.from(value, "hex");
}
/** Bind ciphertext to its workspace, provider and record, so a copied row cannot move credentials between tenants. */
export function encrypt(secret: string, key: Buffer, scope: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(scope));
    const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}
export function decrypt(value: string, key: Buffer, scope: string) {
    const data = Buffer.from(value, "base64");
    const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    cipher.setAAD(Buffer.from(scope));
    cipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString("utf8");
}
export function fingerprint(key: Buffer, value: unknown) {
    return createHmac("sha256", key).update(JSON.stringify(value)).digest("hex");
}
export function matches(a: string, b: string) {
    return (
        /^[0-9a-f]{64}$/.test(a) &&
        /^[0-9a-f]{64}$/.test(b) &&
        timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"))
    );
}
export function notePayload(note: Annotation, origin: string): Payload {
    const url = `${origin}/#/p/${encodeURIComponent(note.projectId)}/a/${encodeURIComponent(note.id)}`;
    // Only these explicitly selected fields leave Notato. No replies, screenshots, reference bytes or diagnostics.
    return {
        visibility: Boolean(note.peopleOnly),
        personal: note.visibility === "personal",
        title: (note.comment.trim().split("\n")[0] || "Feedback").slice(0, 180),
        text: `${note.comment.slice(0, 12000)}${note.review?.instruction ? `\n\nReview instruction: ${note.review.instruction.slice(0, 8000)}` : ""}\n\nPage: ${note.route.split(/[?#]/)[0]?.slice(0, 1000) ?? ""}${note.severity ? `\nSeverity: ${note.severity}` : ""}\n\nView feedback: ${url}`,
        url,
        noteIds: [note.id],
    };
}
export const CATALOG = [
    {
        id: "github",
        name: "GitHub Issues",
        description: "Create or link an issue in a repository.",
    },
    {
        id: "azure",
        name: "Azure DevOps Boards",
        description: "Create or link a work item in your project.",
    },
    {
        id: "teams",
        name: "Microsoft Teams",
        description: "Send a feedback card to a Teams Workflow.",
    },
    { id: "slack", name: "Slack", description: "Send feedback to a channel." },
    {
        id: "webhook",
        name: "Signed webhook",
        description: "Send feedback to n8n, Make, Zapier or your own service.",
    },
    { id: "linear", name: "Linear", description: "Create or link an issue in a team." },
    {
        id: "gitlab",
        name: "GitLab Issues",
        description: "Create or link an issue in a GitLab.com project.",
    },
] as const;
