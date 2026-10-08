import type {
    AgentStep,
    Annotation,
    AssetRef,
    Author,
    Bundle,
    ElementIdentity,
    Environment,
    Intent,
    Mode,
    Rect,
    Severity,
    Target,
} from "@notato/schema";

/** What a capture plugin sees: everything known about the annotation before evidence is attached. */
export interface DraftAnnotation {
    id: string;
    /** 1-based pin number, shown on the outlined screenshot. */
    number: number;
    projectId: string;
    mode: Mode;
    author: Author;
    createdAt: string;
    url: string;
    route: string;
    appName?: string;
    appVersion?: string;
    environment: Environment;
    kind: Target["kind"];
    /** Live DOM nodes. Never serialised. */
    elements: Element[];
    /** Page coordinates, CSS px. */
    rect: Rect;
    selectedText?: string;
    identity: ElementIdentity[];
    comment: string;
    severity?: Severity;
    intent?: Intent;
    steps?: AgentStep[];
    /** Real pixels supplied by a driver (CDP, Playwright). The screenshot plugin uses them instead of rendering the DOM. */
    screenshot?: Blob;
    /** Capture plugins stash image bytes here and get a content reference back. */
    putAsset(blob: Blob, meta: { w: number; h: number }): Promise<AssetRef>;
}

export interface IdentityPlugin {
    id: string;
    /** Runs once per selected element. Later plugins override earlier ones field by field. */
    resolve(el: Element): Partial<ElementIdentity>;
    /**
     * Optional async warm-up, awaited once per annotation before `resolve` runs, so a plugin can fetch
     * what a synchronous `resolve` then reads from cache (e.g. source maps). Failures are ignored.
     */
    prepare?(elements: Element[]): Promise<void>;
    setup?(): undefined | (() => void);
}

/**
 * Capture plugins return a partial annotation. The host keeps only `screenshots`, `steps`, `route`,
 * and `context[plugin.id]`: plugins write under their own id and the core never interprets it.
 */
export interface CapturePlugin {
    id: string;
    capture(draft: DraftAnnotation): Promise<Partial<Annotation> | undefined>;
    setup?(): undefined | (() => void);
}

export type AssetMap = ReadonlyMap<string, Blob>;

export interface SinkPlugin {
    id: string;
    deliver(input: Annotation | Bundle, assets: AssetMap): Promise<void>;
    setup?(): undefined | (() => void);
}

/** An annotation plus the bytes behind its screenshots and the live elements it points at. */
export interface AnnotationRecord {
    annotation: Annotation;
    assets: Map<string, Blob>;
    /** Present only for annotations created in this page; used to keep pins attached. */
    elements?: Element[];
}

export interface CreateInput {
    kind: Target["kind"];
    elements: Element[];
    rect: Rect;
    selectedText?: string;
    comment: string;
    severity?: Severity;
    intent?: Intent;
    /** People only: the note and its thread are between people, and never reach the agent. */
    peopleOnly?: boolean;
    steps?: AgentStep[];
    /** Real pixels of the viewport from a driver; see `DraftAnnotation.screenshot`. */
    screenshot?: Blob;
    author?: Author;
    /** Overrides the mode the pipeline was configured with, e.g. an agent annotating in a test page. */
    mode?: Mode;
}
