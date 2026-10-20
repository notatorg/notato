import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { PluginError } from "./model.ts";

const blocked = new BlockList();
for (const [ip, bits] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
] as const)
    blocked.addSubnet(ip, bits, "ipv4");
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");
blocked.addSubnet("3fff::", 20, "ipv6");
export function publicAddress(ip: string) {
    if (isIP(ip) === 4) return !blocked.check(ip, "ipv4");
    // Global unicast only. Exclude mapped IPv4, translation/tunnel and documentation ranges.
    return isIP(ip) === 6 && /^[23]/i.test(ip) && !blocked.check(ip, "ipv6");
}
export function outboundUrl(value: string) {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new PluginError("Use a valid HTTPS destination.");
    }
    if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        (url.port && url.port !== "443") ||
        isIP(url.hostname.replace(/^\[|\]$/g, ""))
    )
        throw new PluginError("Use an HTTPS destination on a public hostname.");
    return url;
}
export type Http = (url: string, init?: RequestInit) => Promise<Response>;
/** Resolve once and pin the TLS connection to that public address. Redirects never forward credentials. */
export const publicFetch: Http = async (value, init = {}) => {
    const url = outboundUrl(value);
    const addresses = await lookup(url.hostname, { all: true });
    if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
        throw new Error("The destination is not publicly routable.");
    const address = addresses[0];
    if (!address) throw new Error("The destination could not be resolved.");
    return new Promise<Response>((resolve, reject) => {
        const headers = Object.fromEntries(new Headers(init.headers));
        const req = request(
            url,
            {
                method: init.method ?? "GET",
                headers,
                servername: url.hostname,
                lookup: (_host, options, done) => {
                    if (typeof options === "object" && options.all) {
                        (
                            done as unknown as (
                                error: null,
                                addresses: { address: string; family: number }[]
                            ) => void
                        )(null, [address]);
                    } else done(null, address.address, address.family);
                },
            },
            (res) => {
                const chunks: Buffer[] = [];
                let size = 0;
                res.on("data", (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > 1024 * 1024)
                        req.destroy(new Error("Provider response is too large."));
                    else chunks.push(chunk);
                });
                res.on("error", reject);
                res.on("end", () =>
                    resolve(
                        new Response(
                            [204, 205, 304].includes(res.statusCode ?? 0)
                                ? null
                                : Buffer.concat(chunks),
                            {
                                status: res.statusCode ?? 502,
                                headers: Object.fromEntries(
                                    Object.entries(res.headers).filter(
                                        (entry): entry is [string, string] =>
                                            typeof entry[1] === "string"
                                    )
                                ),
                            }
                        )
                    )
                );
            }
        );
        const timer = setTimeout(
            () => req.destroy(new Error("Provider request timed out.")),
            15_000
        );
        req.on("error", reject);
        req.on("close", () => clearTimeout(timer));
        if (init.body) req.write(String(init.body));
        req.end();
    });
};
