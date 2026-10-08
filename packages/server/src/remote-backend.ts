import { Annotation, type Author, type Status } from "@notato/schema";
import {
    AGENT_HEADER,
    AGENT_NAME_HEADER,
    AGENT_PROJECTS_HEADER,
    encodeAgentProjects,
} from "./agents.ts";
import type { AssetBytes, Backend, ImportResult, VariantOffer } from "./backend.ts";
import { filterToQuery } from "./query.ts";
import type { RelayArgs, RelayResult } from "./relay.ts";
import type { AnnotationFilter, HandedEntry, StoredAnnotation } from "./storage.ts";

/** How long a health check waits: a server on this machine that takes longer is as good as gone. */
const HEALTH_TIMEOUT_MS = 1500;
/** The page size a list is fetched in when the caller wants everything: the most the server gives at once. */
const PAGE_SIZE = 500;
/** How long one long-poll asks the server to wait, inside the server's own cap. */
const WAIT_SLICE_MS = 25_000;

/** The server answered with an error (`status`), or could not be reached at all (no status). */
export class RemoteError extends Error {
    constructor(
        message: string,
        readonly status?: number
    ) {
        super(message);
    }
}

/** True when the request never reached a server, as opposed to the server answering with an error. */
export function isConnectionError(error: unknown): boolean {
    return error instanceof RemoteError && error.status === undefined;
}

/**
 * The same operations as `LocalBackend`, over HTTP. A second `notato dev` uses this to attach to the
 * server another process already started.
 */
export class RemoteBackend implements Backend {
    /** Names this agent to the server on every request, so pages know someone is listening (see agents.ts). */
    private readonly agentId = `pfa_${crypto.randomUUID()}`;
    /** The agent this process serves ("Codex"), once its MCP client has said; sent with the heartbeat. */
    agentName: string | undefined;
    /** The projects that agent is kept to (`notato dev --project`), so only their pages say it is there. */
    agentProjects: string[] | undefined;

    constructor(
        private base: string,
        private token?: string
    ) {}

    /** Who is asking: this agent's heartbeat (see agents.ts), and the token when the server needs one. */
    private headers(extra?: HeadersInit): Headers {
        const headers = new Headers(extra);
        if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
        headers.set(AGENT_HEADER, this.agentId);
        if (this.agentName) headers.set(AGENT_NAME_HEADER, this.agentName);
        if (this.agentProjects?.length)
            headers.set(AGENT_PROJECTS_HEADER, encodeAgentProjects(this.agentProjects));
        return headers;
    }

    private async request(path: string, init: RequestInit = {}): Promise<Response> {
        const headers = this.headers(init.headers);
        try {
            return await fetch(`${this.base}${path}`, { ...init, headers });
        } catch (error) {
            if (init.signal?.aborted) throw error;
            throw new RemoteError(
                `cannot reach notato server at ${this.base}: ${error instanceof Error ? error.message : error}`
            );
        }
    }

    private async json<T>(path: string, init?: RequestInit): Promise<T | null> {
        const res = await this.request(path, init);
        if (res.status === 404) return null;
        if (!res.ok) {
            const body = (await res.json().catch(() => null)) as { error?: string } | null;
            throw new RemoteError(body?.error ?? `server answered ${res.status}`, res.status);
        }
        return (await res.json()) as T;
    }

    private parse(stored: StoredAnnotation): StoredAnnotation {
        return { seq: stored.seq, annotation: Annotation.parse(stored.annotation) };
    }

    /**
     * The server pages its lists, so a filter without a limit (everything that matches, as the local store gives) is
     * fetched page by page until the server says there is no more.
     */
    async list(filter: AnnotationFilter = {}) {
        if (filter.limit !== undefined) {
            const body = await this.json<{ items: StoredAnnotation[] }>(
                `/annotations?${filterToQuery(filter)}`
            );
            return (body?.items ?? []).map((s) => this.parse(s));
        }
        const all: StoredAnnotation[] = [];
        let after = filter.afterSeq;
        for (;;) {
            const body = await this.json<{ items: StoredAnnotation[]; next?: number }>(
                `/annotations?${filterToQuery({ ...filter, afterSeq: after, limit: PAGE_SIZE })}`
            );
            all.push(...(body?.items ?? []).map((s) => this.parse(s)));
            // An older server sends no `next`: the one page is all there is to have.
            if (body?.next === undefined || body.next === after) return all;
            after = body.next;
        }
    }

    async get(id: string) {
        const stored = await this.json<StoredAnnotation>(`/annotations/${encodeURIComponent(id)}`);
        return stored ? this.parse(stored) : null;
    }

    async markHanded(entries: HandedEntry[]) {
        if (!entries.length) return;
        const res = await this.request("/annotations/handed", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ items: entries }),
        });
        // An older server has no record of what was handed: the session's own memory still keeps it from repeating.
        if (!res.ok && res.status !== 404 && res.status !== 405)
            throw new RemoteError(`server answered ${res.status}`, res.status);
    }

    async asset(id: string): Promise<AssetBytes | null> {
        const res = await this.request(`/assets/${encodeURIComponent(id)}`);
        if (res.status === 404) return null;
        if (!res.ok) throw new RemoteError(`server answered ${res.status}`, res.status);
        return {
            bytes: new Uint8Array(await res.arrayBuffer()),
            mime: res.headers.get("content-type") ?? "application/octet-stream",
        };
    }

    async setStatus(id: string, status: Status, note?: string, author?: Author) {
        const stored = await this.json<StoredAnnotation>(`/annotations/${encodeURIComponent(id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            // An empty note is no note: the HTTP API refuses an empty one where the local backend just skips it.
            body: JSON.stringify({ status, note: note || undefined, author }),
        });
        return stored ? this.parse(stored) : null;
    }

    async reply(id: string, body: string, author?: Author) {
        const stored = await this.json<StoredAnnotation>(
            `/annotations/${encodeURIComponent(id)}/replies`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ body, author }),
            }
        );
        return stored ? this.parse(stored) : null;
    }

    async offerVariants(id: string, offer: VariantOffer, author?: Author) {
        const stored = await this.json<StoredAnnotation>(
            `/annotations/${encodeURIComponent(id)}/variants`,
            {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...offer, note: offer.note || undefined, author }),
            }
        );
        return stored ? this.parse(stored) : null;
    }

    async chooseVariant(id: string, name: string | null, note?: string, author?: Author) {
        const stored = await this.json<StoredAnnotation>(
            `/annotations/${encodeURIComponent(id)}/variants/choose`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, note: note || undefined, author }),
            }
        );
        return stored ? this.parse(stored) : null;
    }

    async waitForNew(
        filter: AnnotationFilter,
        timeoutMs: number,
        signal?: AbortSignal
    ): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline && !signal?.aborted) {
            const slice = Math.min(WAIT_SLICE_MS, deadline - Date.now());
            const query = filterToQuery({ ...filter, limit: 1 });
            query.set("timeoutMs", String(slice));
            try {
                const res = await this.request(`/annotations/wait?${query}`, { signal });
                if (!res.ok) throw new RemoteError(`server answered ${res.status}`, res.status);
                if (((await res.json()) as { ready: boolean }).ready) return true;
            } catch (error) {
                if (signal?.aborted) return false;
                throw error;
            }
        }
        return false;
    }

    async importBundle(zip: Uint8Array): Promise<ImportResult> {
        const res = await this.request("/bundles", {
            method: "POST",
            headers: { "Content-Type": "application/zip" },
            body: zip as BodyInit,
        });
        const body = (await res.json().catch(() => null)) as
            | (ImportResult & { error?: string })
            | null;
        if (!res.ok || !body)
            throw new RemoteError(body?.error ?? `server answered ${res.status}`, res.status);
        return body;
    }

    async requestAnnotation(
        projectId: string | undefined,
        args: RelayArgs,
        timeoutMs: number
    ): Promise<RelayResult> {
        const res = await this.request("/relay/annotate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...args, projectId, timeoutMs }),
        });
        const body = (await res.json().catch(() => null)) as
            | (RelayResult & { error?: string })
            | null;
        if (!res.ok || !body)
            throw new RemoteError(body?.error ?? `server answered ${res.status}`, res.status);
        return body;
    }

    async health(): Promise<boolean> {
        try {
            // The attach monitor calls this every few seconds: the agent's heartbeat.
            const res = await fetch(`${this.base}/health`, {
                signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
                headers: this.headers(),
            });
            const body = (await res.json()) as { service?: string };
            return res.ok && body.service === "notato";
        } catch {
            return false;
        }
    }
}
