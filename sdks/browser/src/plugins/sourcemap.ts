/** A decoded mapping segment. All fields are 0-based, as in the source map spec. */
interface Segment {
    col: number;
    source: number;
    line: number;
    scol: number;
}

export interface ParsedMap {
    /** One sorted segment list per generated line. */
    lines: Segment[][];
    sources: string[];
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Map([...BASE64].map((ch, i) => [ch, i]));

/** Decodes the `mappings` field of a source map. */
export function decodeMappings(mappings: string): Segment[][] {
    const lines: Segment[][] = [];
    let source = 0;
    let line = 0;
    let scol = 0;
    for (const rawLine of mappings.split(";")) {
        const segments: Segment[] = [];
        let col = 0;
        for (const raw of rawLine.split(",")) {
            if (!raw) continue;
            const fields = decodeVlq(raw);
            col += fields[0] ?? 0;
            if (fields.length >= 4) {
                source += fields[1] ?? 0;
                line += fields[2] ?? 0;
                scol += fields[3] ?? 0;
                segments.push({ col, source, line, scol });
            }
        }
        lines.push(segments);
    }
    return lines;
}

function decodeVlq(segment: string): number[] {
    const out: number[] = [];
    let value = 0;
    let shift = 0;
    for (const ch of segment) {
        const digit = B64_INDEX.get(ch);
        if (digit === undefined) throw new Error(`bad VLQ digit "${ch}"`);
        value += (digit & 31) << shift;
        if (digit & 32) {
            shift += 5;
        } else {
            out.push(value & 1 ? -(value >> 1) : value >> 1);
            value = 0;
            shift = 0;
        }
    }
    return out;
}

/** Maps a 1-based generated line/column (as in a stack trace) to the original 1-based position. */
export function originalPosition(map: ParsedMap, line: number, col: number) {
    const segments = map.lines[line - 1];
    if (!segments?.length) return null;
    const target = col - 1;
    let best: Segment | undefined;
    let lo = 0;
    let hi = segments.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const seg = segments[mid] as Segment;
        if (seg.col <= target) {
            best = seg;
            lo = mid + 1;
        } else hi = mid - 1;
    }
    if (!best) return null;
    const source = map.sources[best.source];
    return source === undefined ? null : { source, line: best.line + 1, col: best.scol + 1 };
}

export function parseSourceMap(json: string): ParsedMap | null {
    const raw = JSON.parse(json) as { mappings?: string; sources?: string[]; sourceRoot?: string };
    if (typeof raw.mappings !== "string" || !Array.isArray(raw.sources)) return null;
    return { lines: decodeMappings(raw.mappings), sources: raw.sources };
}

type Fetcher = (url: string) => Promise<Response>;

/** Finds the map a module points at: an inline `data:` URL or a sibling file. */
async function fetchMap(moduleUrl: string, fetcher: Fetcher): Promise<ParsedMap | null> {
    const body = await (await fetcher(moduleUrl)).text();
    const refs = [...body.matchAll(/\/\/[#@]\s*sourceMappingURL=(\S+)/g)];
    const ref = refs[refs.length - 1]?.[1];
    if (!ref) return null;
    const inline = /^data:application\/json[^,]*?(;base64)?,(.*)$/s.exec(ref);
    if (inline) {
        const payload = inline[2] ?? "";
        return parseSourceMap(inline[1] ? atob(payload) : decodeURIComponent(payload));
    }
    return parseSourceMap(await (await fetcher(new URL(ref, moduleUrl).href)).text());
}

const cache = new Map<string, Promise<ParsedMap | null>>();

/** Loads and caches the source map for a module URL. Never rejects. */
export function loadSourceMap(moduleUrl: string, fetcher: Fetcher): Promise<ParsedMap | null> {
    let pending = cache.get(moduleUrl);
    if (!pending) {
        pending = fetchMap(moduleUrl, fetcher).catch(() => null);
        cache.set(moduleUrl, pending);
    }
    return pending;
}

/** Synchronous view of what `loadSourceMap` has already finished, for `resolve()`. */
const settled = new Map<string, ParsedMap | null>();

export function warmSourceMap(moduleUrl: string, fetcher: Fetcher): Promise<void> {
    return loadSourceMap(moduleUrl, fetcher).then((map) => {
        settled.set(moduleUrl, map);
    });
}

export function cachedSourceMap(moduleUrl: string): ParsedMap | null | undefined {
    return settled.get(moduleUrl);
}

export function clearSourceMapCache(): void {
    cache.clear();
    settled.clear();
}
