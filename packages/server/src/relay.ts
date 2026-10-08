import { AgentStep, Intent, Severity } from "@notato/schema";
import { z } from "zod";

/** What an agent asks a page to annotate. The page runs it through `window.__notato.annotate`. */
export const RelayArgs = z.object({
    /** CSS selector of the element to annotate. */
    target: z.string().min(1).max(2000),
    comment: z.string().min(1).max(10_000),
    severity: Severity.optional(),
    intent: Intent.optional(),
    steps: z.array(AgentStep).max(100).optional(),
    /** Name shown as the annotation's author. */
    author: z.string().max(200).optional(),
});
export type RelayArgs = z.infer<typeof RelayArgs>;

export type RelayResult = { ok: true; annotationId: string } | { ok: false; error: string };

export interface RelayRequest {
    requestId: string;
    args: RelayArgs;
}

interface Registration {
    projectId: string;
    deliver(request: RelayRequest): void;
}

interface Pending {
    projectId: string;
    resolve(result: RelayResult): void;
    timer: ReturnType<typeof setTimeout>;
}

/** Raised when no page can take the request; carries a message an agent can act on. */
export class RelayError extends Error {
    constructor(
        message: string,
        readonly status: 409 | 504 | 400
    ) {
        super(message);
    }
}

/**
 * Routes `notato_annotate` calls to a browser tab. A page registers by opening its event stream in agent
 * mode; the hub hands a request to the most recently connected page of the project and waits for that
 * page to report back.
 */
export class RelayHub {
    private pages: Registration[] = [];
    private pending = new Map<string, Pending>();

    /** Returns a function that unregisters the page. */
    register(projectId: string, deliver: Registration["deliver"]): () => void {
        const registration: Registration = { projectId, deliver };
        this.pages.push(registration);
        return () => {
            this.pages = this.pages.filter((p) => p !== registration);
        };
    }

    /** Projects that currently have a page able to annotate. */
    projects(): string[] {
        return [...new Set(this.pages.map((p) => p.projectId))];
    }

    /** The project a pending request belongs to, so a result can only come from a credential for that project. */
    projectOf(requestId: string): string | undefined {
        return this.pending.get(requestId)?.projectId;
    }

    has(projectId: string): boolean {
        return this.pages.some((p) => p.projectId === projectId);
    }

    request(
        projectId: string | undefined,
        args: RelayArgs,
        timeoutMs: number
    ): Promise<RelayResult> {
        let target = projectId;
        if (target === undefined) {
            const open = this.projects();
            if (open.length === 0) return Promise.reject(this.noPage());
            if (open.length > 1) {
                return Promise.reject(
                    new RelayError(
                        `Several projects have a page open (${open.join(", ")}); pass projectId.`,
                        400
                    )
                );
            }
            target = open[0] as string;
        }
        const page = [...this.pages].reverse().find((p) => p.projectId === target);
        if (!page) return Promise.reject(this.noPage(target));

        const requestId = crypto.randomUUID();
        return new Promise<RelayResult>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(
                    new RelayError(
                        `The page did not respond within ${Math.round(timeoutMs / 1000)}s.`,
                        504
                    )
                );
            }, timeoutMs);
            this.pending.set(requestId, {
                projectId: target as string,
                resolve: (r) => resolve(r),
                timer,
            });
            page.deliver({ requestId, args });
        });
    }

    /** Called when a page reports the outcome. False when the request is unknown or already settled. */
    complete(requestId: string, result: RelayResult): boolean {
        const pending = this.pending.get(requestId);
        if (!pending) return false;
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.resolve(result);
        return true;
    }

    private noPage(projectId?: string) {
        return new RelayError(
            `No page is connected${projectId ? ` for project "${projectId}"` : ""}. Open the app with <Notato mode="agent" server="…" /> and keep the tab open, or call window.__notato.annotate through your browser driver.`,
            409
        );
    }
}
