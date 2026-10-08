import {
    Annotation,
    type AssetRef,
    type Author,
    type ElementIdentity,
    type Environment,
    type Mode,
} from "@notato/schema";
import { ulid } from "ulid";
import type {
    AnnotationRecord,
    CapturePlugin,
    CreateInput,
    DraftAnnotation,
    IdentityPlugin,
    SinkPlugin,
} from "./types.ts";

export interface PipelineConfig {
    mode: Mode;
    projectId: string;
    appName?: string;
    appVersion?: string;
    /**
     * Default author; a CreateInput may override it (an agent annotating on a human's page). A function is
     * read at each annotation, so a tester's name entered later still applies.
     */
    author: Author | (() => Author);
    identity: IdentityPlugin[];
    capture: CapturePlugin[];
    sinks: SinkPlugin[];
    /** Where the page is right now. Injected so the core stays testable without a DOM. */
    locate(): { url: string; route: string };
    environment(): Environment;
    /** The next pin number. Defaults to a per-pipeline counter; the SDK supplies one that survives reloads. */
    nextNumber?(): number;
    /** Called to report a plugin failure; the pipeline keeps going. */
    onWarn?(message: string, error?: unknown): void;
}

export interface Pipeline {
    create(input: CreateInput): Promise<AnnotationRecord>;
    /** Runs every plugin's `setup` and returns a function that undoes them all. */
    setup(): () => void;
}

/** Capture plugins may only set these top-level fields, plus `context[plugin.id]`. */
const CAPTURE_FIELDS = ["screenshots", "steps", "route"] as const;

export function createPipeline(config: PipelineConfig): Pipeline {
    const warn = config.onWarn ?? (() => {});
    let counter = 0;

    const resolveIdentity = (el: Element): ElementIdentity => {
        const merged: Partial<ElementIdentity> = {};
        for (const plugin of config.identity) {
            try {
                for (const [key, value] of Object.entries(plugin.resolve(el))) {
                    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
                }
            } catch (error) {
                warn(`identity plugin "${plugin.id}" failed`, error);
            }
        }
        return { selector: el.tagName.toLowerCase(), tag: el.tagName.toLowerCase(), ...merged };
    };

    return {
        setup() {
            const teardowns: Array<() => void> = [];
            for (const plugin of [...config.identity, ...config.capture, ...config.sinks]) {
                const teardown = plugin.setup?.();
                if (teardown) teardowns.push(teardown);
            }
            return () => {
                for (const teardown of teardowns.reverse()) teardown();
            };
        },

        async create(input) {
            // Taken now, before anything is awaited: a second create running meanwhile must not change this note's number.
            counter = config.nextNumber ? config.nextNumber() : counter + 1;
            const number = counter;
            const id = ulid();
            const assets = new Map<string, Blob>();
            const mode = input.mode ?? config.mode;
            const where = config.locate();

            const prepared = await Promise.allSettled(
                config.identity.map((p) => p.prepare?.(input.elements))
            );
            prepared.forEach((result, i) => {
                if (result.status === "rejected")
                    warn(
                        `identity plugin "${config.identity[i]?.id}" prepare failed`,
                        result.reason
                    );
            });

            const draft: DraftAnnotation = {
                id,
                number,
                projectId: config.projectId,
                mode,
                author:
                    input.author ??
                    (typeof config.author === "function" ? config.author() : config.author),
                createdAt: new Date().toISOString(),
                url: where.url,
                route: where.route,
                appName: config.appName,
                appVersion: config.appVersion,
                environment: config.environment(),
                kind: input.kind,
                elements: input.elements,
                rect: input.rect,
                selectedText: input.selectedText,
                identity: input.elements.map(resolveIdentity),
                comment: input.comment,
                severity: input.severity,
                intent: input.intent,
                steps: input.steps,
                screenshot: input.screenshot,
                async putAsset(blob, meta): Promise<AssetRef> {
                    const assetId = await contentId(blob);
                    assets.set(assetId, blob);
                    const mime = blob.type === "image/webp" ? "image/webp" : "image/png";
                    return { id: assetId, mime, w: meta.w, h: meta.h };
                },
            };

            let screenshots: Annotation["screenshots"] | undefined;
            let steps = draft.steps;
            let route = draft.route;
            const context: Record<string, unknown> = {};

            for (const plugin of config.capture) {
                try {
                    const result = await plugin.capture(draft);
                    if (!result) continue;
                    for (const key of Object.keys(result)) {
                        if (
                            key !== "context" &&
                            !(CAPTURE_FIELDS as readonly string[]).includes(key)
                        ) {
                            warn(`capture plugin "${plugin.id}" tried to write "${key}"; ignored`);
                        }
                    }
                    if (result.screenshots) screenshots = result.screenshots;
                    if (result.steps) steps = result.steps;
                    if (result.route) route = result.route;
                    if (result.context) {
                        for (const key of Object.keys(result.context)) {
                            if (key === plugin.id) context[key] = result.context[key];
                            else
                                warn(
                                    `capture plugin "${plugin.id}" tried to write context.${key}; ignored`
                                );
                        }
                    }
                } catch (error) {
                    warn(`capture plugin "${plugin.id}" failed`, error);
                }
            }

            // No screenshots is a valid annotation: they can be turned off, and then nothing produces them.

            const annotation = Annotation.parse({
                id,
                projectId: draft.projectId,
                bundleId: null,
                author: draft.author,
                mode,
                createdAt: draft.createdAt,
                url: draft.url,
                route,
                appName: draft.appName,
                appVersion: draft.appVersion,
                environment: draft.environment,
                target: {
                    kind: draft.kind,
                    identity: draft.identity,
                    rect: draft.rect,
                    selectedText: draft.selectedText,
                },
                comment: draft.comment,
                severity: draft.severity,
                intent: draft.intent,
                screenshots,
                steps,
                context,
                status: "open",
                thread: [],
                ...(input.peopleOnly ? { peopleOnly: true } : {}),
            });

            const record = withElements({ annotation, assets }, input.elements);
            const results = await Promise.allSettled(
                config.sinks.map((sink) => sink.deliver(annotation, assets))
            );
            results.forEach((result, i) => {
                if (result.status === "rejected")
                    warn(`sink "${config.sinks[i]?.id}" failed`, result.reason);
            });
            return record;
        },
    };
}

/**
 * A record that holds its elements weakly. A note can outlive the element it was made on by hours (the app moves on,
 * re-renders, navigates), and holding it would keep that element, and everything it points at, alive for as long as
 * the page is open. While the element is around, `elements` gives it; once it is gone, nothing: pins then find the
 * element again through the note's identity, as they do for a note from the server.
 */
function withElements(
    record: Omit<AnnotationRecord, "elements">,
    elements: Element[]
): AnnotationRecord {
    if (typeof WeakRef !== "function") return { ...record, elements };
    const held = elements.map((el) => new WeakRef(el));
    return Object.defineProperty(record as AnnotationRecord, "elements", {
        enumerable: true,
        get: () => held.flatMap((ref) => ref.deref() ?? []),
    });
}

/** sha-256 hex when SubtleCrypto is available (secure contexts), otherwise a random id. */
export async function contentId(blob: Blob): Promise<string> {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
        const digest = await subtle.digest("SHA-256", await blob.arrayBuffer());
        return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    }
    return ulid().toLowerCase().padEnd(64, "0");
}
