import { z } from "zod";

/** Bump on any breaking change to the shapes below. Bundles carry it so importers can reject or migrate. */
export const SCHEMA_VERSION = 1 as const;

export const Mode = z.enum(["dev", "test", "agent"]);
/** Who can read feedback inside a project. Missing visibility on older records means shared. */
export const FeedbackVisibility = z.enum(["personal", "shared"]);
export const Severity = z.enum(["blocker", "major", "minor", "nit"]);
/**
 * What the person wants done. `fix`: something is broken. `change`: it works but should be different. `question`:
 * they want an answer, not an edit. `approve`: this is right as it is. `variants`: show me a few versions to compare
 * in the page, and I will pick one.
 */
export const Intent = z.enum(["fix", "change", "question", "approve", "variants"]);
/**
 * open -> acknowledged -> resolved. A person who does not want a resolved change asks for it to be undone
 * (`revert_requested`), and the agent reports back with `reverted`. For a `variants` request the agent offers the
 * versions (the annotation stays `acknowledged`, with `variants` set), the person picks one (`variant_chosen`), and
 * the agent applies it and resolves. `dismissed` is for feedback not acted on.
 */
export const Status = z.enum([
    "open",
    "acknowledged",
    "awaiting_response",
    "variant_chosen",
    "resolved",
    "revert_requested",
    "reverted",
    "dismissed",
]);

export const Author = z.object({
    kind: z.enum(["human", "agent"]),
    name: z.string().optional(),
});

export const Rect = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

/**
 * An id that is safe to use as a file or folder name on any platform: SDKs keep notes and screenshots on disk under it.
 * ULIDs, UUIDs and sha256 hashes all fit.
 */
export const SafeId = z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/, "ids are 1 to 128 letters, digits, _ or -");

export const AssetRef = z.object({
    id: SafeId,
    mime: z.enum(["image/png", "image/webp"]),
    w: z.number().int().positive(),
    h: z.number().int().positive(),
    path: z.string().optional(),
});

export const ElementIdentity = z.object({
    /** Shortest unique CSS selector. */
    selector: z.string(),
    /** data-testid / data-qa / data-cy / data-test */
    testId: z.string().optional(),
    /** Accessible role + name. */
    role: z.string().optional(),
    name: z.string().optional(),
    tag: z.string(),
    classes: z.array(z.string()).optional(),
    /** Trimmed visible text, max 200 chars. */
    text: z.string().max(200).optional(),
    /**
     * Where this element is written in the source, from the Notato Vite plugin: the file's path from the repository
     * root, and the 1-based line and column of the element's opening `<`. Unlike `component.source` it survives a
     * production build. `nearest` is set when the element itself was not tagged (it comes from a library, say) and
     * this is the closest tagged element around it.
     */
    source: z
        .object({
            file: z.string(),
            line: z.number().int().positive(),
            col: z.number().int().positive(),
            nearest: z.boolean().optional(),
        })
        .optional(),
    /** React component + "path:line:col" when available. `path` is the chain of components around it, outermost first. */
    component: z
        .object({
            name: z.string(),
            source: z.string().optional(),
            path: z.array(z.string()).optional(),
        })
        .optional(),
    /** A curated set of computed styles (colour, type, spacing, size): the values the element actually has. */
    styles: z.record(z.string(), z.string()).optional(),
    /**
     * Where the element lives when it is not simply in the page's document: the iframe or shadow host to go through at
     * each step, outermost first, as a selector in the document or shadow root that contains it. `selector` is then
     * relative to the innermost one.
     */
    within: z
        .array(z.object({ kind: z.enum(["frame", "shadow"]), selector: z.string() }))
        .optional(),
    /** The elements around it, outermost first, as short selectors: where it sits in the page. */
    ancestors: z.array(z.string()).optional(),
    /** The id the native toolkit gives the element, where it has one: MAUI's AutomationId, React Native's nativeID. */
    platformId: z.string().optional(),
});

export const AgentStep = z.object({
    action: z.string(),
    target: z.string().optional(),
    value: z.string().optional(),
    at: z.string(),
});

export const Reply = z.object({
    id: z.string(),
    author: Author,
    body: z.string(),
    createdAt: z.string(),
    /** Written by Notato to record something the person did (picking a version), not something they said. */
    automatic: z.boolean().optional(),
    /**
     * A remark for the people on the thread, not the agent: it is not delivered to the agent, not shown to it, and not
     * the latest word the agent answers. Set by the person who writes it, when they send it.
     */
    aside: z.boolean().optional(),
    /**
     * Only on the automatic entry that records someone turning People only on (`true`) or off (`false`) for the note.
     * Carried here, rather than read from the text, so the server can tell what happened.
     */
    peopleOnly: z.boolean().optional(),
    /** Automatic audit entry for an explicit feedback visibility change. */
    visibility: z.enum(["personal", "shared"]).optional(),
});

/**
 * What kind of app made a note, so which code to look in. These are the ones the SDKs in this repository send; the field
 * is open, so an SDK for a new kind of app is never refused by a server that predates it.
 */
export const KNOWN_PLATFORMS = [
    "web",
    "maui",
    "ios",
    "android",
    "react-native",
    "flutter",
] as const;

/** A platform name: lowercase words joined by hyphens (`react-native`). */
export const Platform = z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(40);

export const Environment = z.object({
    userAgent: z.string(),
    viewport: z.object({ w: z.number(), h: z.number() }),
    dpr: z.number(),
    /**
     * `web` (React, Angular or any page), `maui` (.NET MAUI), `ios` (SwiftUI or UIKit), `android` (Views or Jetpack
     * Compose), `react-native`, `flutter`; see {@link KNOWN_PLATFORMS}. Which code to look in.
     */
    platform: Platform,
    /**
     * The package that made the note and its version, as its registry names it: `@notato/browser`, `notato-swift`,
     * `dev.notato:notato-android`, `Notato.Maui`. Absent from SDKs older than 0.2.
     */
    sdk: z
        .object({ name: z.string().min(1).max(100), version: z.string().min(1).max(40) })
        .optional(),
});

export const Target = z.object({
    kind: z.enum(["element", "text", "area", "multi"]),
    /** One per selected element. */
    identity: z.array(ElementIdentity),
    /** Page coordinates, CSS px. */
    rect: Rect,
    selectedText: z.string().optional(),
});

/** What an agent gives a person to choose between, when asked for variants. */
export const VariantOption = z.object({
    /** Written in the code as `data-notato-variant-name`, so it must match there. Unique within the group. */
    name: z.string().min(1).max(40),
    /** One line on how this version differs, for the person choosing. */
    summary: z.string().max(200).optional(),
});
export const Variants = z.object({
    /** The value of `data-notato-variant` on every version's element in the code. */
    group: z.string().regex(/^[A-Za-z0-9][\w.-]{0,63}$/),
    /** The original first, then each new version. */
    options: z.array(VariantOption).min(2).max(12),
    /** When the agent made the offer. */
    offeredAt: z.string(),
    /** The person's pick, once made. */
    chosen: z.string().optional(),
    chosenAt: z.string().optional(),
});

/**
 * Where a note went in another system: an issue in GitHub, a work item in Azure DevOps. Made by an integration (or
 * an agent), never by the app that sent the note.
 */
export const ExternalLink = z.object({
    /** The integration that made it, as a short name: `github`, `azure-devops`. */
    plugin: z.string().regex(/^[a-z][\w-]{0,31}$/),
    /** Where it lives. Always an http or https address. */
    url: z
        .string()
        .max(2000)
        .refine((u) => /^https?:\/\/[^\s]+$/i.test(u), "must be an http or https address"),
    /** What that system calls it, as people say it: `#123`, `ABC-45`. */
    ref: z.string().max(200).optional(),
    title: z.string().max(300).optional(),
    /** ISO 8601 */
    createdAt: z.string(),
});

export const Annotation = z.object({
    /** ULID */
    id: SafeId,
    projectId: z.string(),
    /** Server-owned work grouping; capture clients cannot choose it. */
    workId: z.string().max(400).optional(),
    /** Personal feedback belongs to its server-authenticated creator; shared feedback is visible to project members. */
    visibility: FeedbackVisibility.optional(),
    /** A persistent review session; its content has its own access checks. */
    sessionId: SafeId.optional(),
    /** Kept on a loopback development server and never accepted by a shared/cloud server. */
    localOnly: z.literal(true).optional(),
    /** Set by the server from the authenticated principal, never trusted from a capture client. */
    createdBy: z.string().max(200).optional(),
    /** The test-mode bundle this note belongs to, including the tester's session focus. */
    feedbackSession: z
        .object({
            id: SafeId,
            name: z.string().trim().min(1).max(120),
            description: z.string().trim().max(4000).optional(),
        })
        .optional(),
    /** null in dev mode */
    bundleId: z.string().nullable(),
    author: Author,
    mode: Mode,
    /** ISO 8601 */
    createdAt: z.string(),

    // where
    url: z.string(),
    /** pathname (+ hash if enabled) */
    route: z.string(),
    appName: z.string().optional(),
    appVersion: z.string().optional(),
    environment: Environment,

    // what
    target: Target,
    comment: z.string(),
    severity: Severity.optional(),
    intent: Intent.optional(),
    /** Set by the agent when it has put the versions in the code for the person to compare. */
    variants: Variants.optional(),

    /** Related targets in one review. Drafts stay on the client until the person sends the review. */
    review: z
        .object({
            id: SafeId,
            instruction: z.string().trim().min(1).max(8000),
            total: z.number().int().min(1).max(50).optional(),
            draft: z.boolean().optional(),
        })
        .optional(),

    // evidence
    /** Explicitly attached design references; independent of automatic screenshot capture. */
    references: z
        .array(AssetRef.extend({ name: z.string().min(1).max(120) }))
        .max(3)
        .optional(),
    /** `full` has the target outlined. Absent when screenshots are turned off (see `notato config`). */
    screenshots: z
        .object({ full: AssetRef, crop: AssetRef.optional(), thumbnail: AssetRef.optional() })
        .optional(),
    /** Agent mode only. */
    steps: z.array(AgentStep).optional(),
    /** Keyed by plugin id, e.g. { console: [...], network: [...] }. The core never interprets it. */
    context: z.record(z.string(), z.unknown()),

    // lifecycle
    status: Status,
    /** Server-owned: the task resumes here after the person answers the agent's question. */
    awaitingResponse: z
        .object({ resumeStatus: z.enum(["acknowledged", "variant_chosen", "revert_requested"]) })
        .optional(),
    thread: z.array(Reply),
    /**
     * People only: the note and its whole thread are between people, and never reach the agent. Anyone on the thread can
     * turn it on or off; each change is recorded in the thread (a reply with `peopleOnly`).
     */
    peopleOnly: z.boolean().optional(),
    /** Where this note went in other systems. Set by integrations; an SDK never sends it. */
    links: z.array(ExternalLink).max(20).optional(),
});

/** The longest name a bundle carries: who it is from, the app and its version. */
const BUNDLE_NAME_MAX = 200;

export const Bundle = z.object({
    /** ULID. A server keeps one record a bundle, under this id, and serves it at `/bundles/<id>`. */
    id: SafeId,
    projectId: z.string(),
    /** ISO 8601: when the tester packaged it. Any precision, but not a fraction of a second that never ends. */
    createdAt: z.iso.datetime({ offset: true }).max(64),
    author: z.object({ name: z.string().max(BUNDLE_NAME_MAX).optional() }),
    /** Test bundles are review sessions: this is a human-readable title and agent focus, not an auth session. */
    session: z
        .object({
            name: z.string().trim().min(1).max(120),
            description: z.string().trim().max(4000).optional(),
        })
        .optional(),
    appName: z.string().max(BUNDLE_NAME_MAX).optional(),
    appVersion: z.string().max(BUNDLE_NAME_MAX).optional(),
    annotations: z.array(Annotation),
    schemaVersion: z.literal(SCHEMA_VERSION),
});

export type Mode = z.infer<typeof Mode>;
export type FeedbackVisibility = z.infer<typeof FeedbackVisibility>;
export type Severity = z.infer<typeof Severity>;
export type Intent = z.infer<typeof Intent>;
export type VariantOption = z.infer<typeof VariantOption>;
export type Variants = z.infer<typeof Variants>;
export type Status = z.infer<typeof Status>;
export type Author = z.infer<typeof Author>;
export type Rect = z.infer<typeof Rect>;
export type AssetRef = z.infer<typeof AssetRef>;
export type ElementIdentity = z.infer<typeof ElementIdentity>;
export type AgentStep = z.infer<typeof AgentStep>;
export type Reply = z.infer<typeof Reply>;
export type Environment = z.infer<typeof Environment>;
export type Target = z.infer<typeof Target>;
export type Annotation = z.infer<typeof Annotation>;
export type ExternalLink = z.infer<typeof ExternalLink>;
export type Bundle = z.infer<typeof Bundle>;

/** Every image belonging to a note, for transport, authorisation, quotas and garbage collection. */
export function annotationAssets(a: Pick<Annotation, "screenshots" | "references">): AssetRef[] {
    return [
        ...Object.values(a.screenshots ?? {}).filter((r): r is AssetRef => !!r),
        ...(a.references ?? []),
    ];
}

/** Everything exported into schema.json, keyed by definition name. */
export const definitions = {
    Annotation,
    ElementIdentity,
    AssetRef,
    AgentStep,
    Reply,
    Variants,
    Bundle,
} as const;

export { sampleAnnotation, sampleBundle } from "./fixtures.ts";
