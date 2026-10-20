/**
 * What one process lets through at once (the documented hosted deployment is a single instance). A client is an
 * address (an IPv6 one by its /64); a credential is a token or an account, wherever it is used from.
 */
export const INGRESS_LIMITS = {
    /** Clients tracked at once. When full, the idle one seen longest ago is forgotten: newcomers are never refused. */
    clients: 10_000,
    /** Requests per client per minute. */
    rate: 600,
    /** Responses being made or sent at once, per client and in all. */
    clientActive: 24,
    active: 128,
    /** Uploads, downloads, annotation reads and expensive MCP tools, which are active responses too. */
    clientHeavy: 2,
    heavy: 8,
    /**
     * Responses that stay open (event streams, the long poll, MCP), which never take an active one's place: a board
     * tab or a watching agent cannot crowd out sign-in or anyone's ordinary requests.
     */
    clientStreams: 48,
    streams: 2048,
    /** Open streams for one credential, from every address together (a shared app token, one account's tabs). */
    credentialStreams: 128,
};

export type IngressLimits = typeof INGRESS_LIMITS;

const WINDOW_MS = 60_000;

interface Client {
    count: number;
    start: number;
    active: number;
    heavy: number;
    streams: number;
}

export interface Lease {
    release(): void;
}

/** Bounded rate and concurrency limits for the documented single-instance hosted deployment. */
export class HostedGuard {
    private clients = new Map<string, Client>();
    /** Where a newcomer is counted if every tracked client is busy: shared, so still limited, but never refused outright. */
    private overflow: Client = { count: 0, start: 0, active: 0, heavy: 0, streams: 0 };
    private active = 0;
    private heavy = 0;
    private streams = 0;
    constructor(
        private now: () => number = Date.now,
        private limits: IngressLimits = INGRESS_LIMITS
    ) {}

    /** A request whose answer ends: counted against its client's rate, and the active pool until it is sent. */
    acquire(key: string, heavy = false): Lease | Response {
        const { limits } = this;
        const client = this.counted(key);
        if (!client || client.active >= limits.clientActive || this.active >= limits.active)
            return refuse();
        if (heavy && (client.heavy >= limits.clientHeavy || this.heavy >= limits.heavy))
            return refuse();
        client.active++;
        this.active++;
        if (heavy) {
            client.heavy++;
            this.heavy++;
        }
        return once(() => {
            client.active--;
            this.active--;
            if (heavy) {
                client.heavy--;
                this.heavy--;
            }
        });
    }

    /** A request whose answer stays open: counted against its client's rate, and the stream pool, never the active one. */
    acquireStream(key: string): Lease | Response {
        const client = this.counted(key);
        if (
            !client ||
            client.streams >= this.limits.clientStreams ||
            this.streams >= this.limits.streams
        )
            return refuse();
        client.streams++;
        this.streams++;
        return once(() => {
            client.streams--;
            this.streams--;
        });
    }

    /** One more open stream for a credential, once it is known. Its request was counted when it arrived. */
    holdStream(credential: string): Lease | Response {
        const holder = this.client(`credential:${credential}`);
        if (holder.streams >= this.limits.credentialStreams) return refuse();
        holder.streams++;
        return once(() => {
            holder.streams--;
        });
    }

    /** The client, with this request counted; null once it has made its minute's requests. */
    private counted(key: string): Client | null {
        const client = this.client(key);
        const now = this.now();
        if (now - client.start >= WINDOW_MS) {
            client.count = 0;
            client.start = now;
            // Kept in the order their minutes began, so the first idle one is the one to forget.
            if (this.clients.get(key) === client) {
                this.clients.delete(key);
                this.clients.set(key, client);
            }
        }
        return ++client.count > this.limits.rate ? null : client;
    }

    private client(key: string): Client {
        const known = this.clients.get(key);
        if (known) return known;
        if (this.clients.size >= this.limits.clients && !this.forgetOne()) return this.overflow;
        const client = { count: 0, start: this.now(), active: 0, heavy: 0, streams: 0 };
        this.clients.set(key, client);
        return client;
    }

    /** Makes room by forgetting the idle client whose minute began longest ago (its count starts again if it returns). */
    private forgetOne(): boolean {
        for (const [key, client] of this.clients)
            if (!client.active && !client.streams) {
                this.clients.delete(key);
                return true;
            }
        return false;
    }
}

function refuse() {
    return new Response(JSON.stringify({ error: "request limit reached; try again shortly" }), {
        status: 429,
        headers: {
            "Content-Type": "application/json",
            "Retry-After": "60",
            "Cache-Control": "no-store",
        },
    });
}

function once(release: () => void): Lease {
    let released = false;
    return {
        release: () => {
            if (!released) {
                released = true;
                release();
            }
        },
    };
}

/**
 * The part of an address one client controls, as the guard and the sign-in limits count it: an IPv6 address by its
 * /64 (one network hands out a whole /64, so cycling through it is still one client), anything else whole.
 */
export function clientAddress(ip: string): string {
    const address = ip.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
    if (!address.includes(":")) return address;
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1];
    if (mapped) return mapped;
    const halves = address.split("::");
    if (halves.length > 2) return address;
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    // An IPv4 tail (::ffff:… aside) fills the last two groups.
    const width = left.length + right.length + (right.at(-1)?.includes(".") ? 1 : 0);
    const groups =
        halves.length === 2
            ? [...left, ...Array(Math.max(0, 8 - width)).fill("0"), ...right]
            : left;
    const network = groups.slice(0, 4);
    if (network.length < 4 || !network.every((group) => /^[0-9a-f]{1,4}$/i.test(group)))
        return address;
    return `${network.map((group) => Number.parseInt(group, 16).toString(16)).join(":")}::/64`;
}

/** Hold a lease for streamed responses too, releasing it on completion, disconnect or failure. */
export function limitedResponse(response: Response, release: () => void): Response {
    if (!response.body) {
        release();
        return response;
    }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const next = await reader.read();
                if (next.done) {
                    release();
                    controller.close();
                } else controller.enqueue(next.value);
            } catch (reason) {
                release();
                controller.error(reason);
            }
        },
        async cancel(reason) {
            release();
            await reader.cancel(reason);
        },
    });
    return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
}
