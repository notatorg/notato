import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DETAILS, renderAnnotation } from "../packages/core/src/index.ts";
import { Annotation, sampleAnnotation } from "../packages/schema/src/index.ts";
import { buildDocs } from "./docs.ts";

// Builds the website into site/dist: the hand-written page from site/src, the real Notato toolbar bundled as
// live.js (the "Try it here" button loads it), and the Markdown samples rendered by the real renderer.
//
//   bun site/build.ts                    build once
//   bun site/build.ts --serve [--port N] build, serve dist, and rebuild when site/src changes
//   bun site/build.ts --artifact         also write dist/artifact.html, the page without its document wrapper

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, "src");
const dist = join(root, "dist");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
};

/** The note from the hero demo, as the agent would get it. Every level of the Markdown sample is rendered from this. */
function demoAnnotation(): Annotation {
    const { steps: _steps, ...base } = sampleAnnotation;
    return Annotation.parse({
        ...base,
        id: "01K6ZB4Q2W8SPUD0000000001",
        projectId: "spudshop",
        createdAt: "2026-10-06T09:41:07.000Z",
        url: "http://localhost:5173/checkout",
        route: "/checkout",
        appName: "spudshop",
        appVersion: "0.3.0",
        environment: {
            userAgent:
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
            viewport: { w: 1440, h: 900 },
            dpr: 2,
            platform: "web",
        },
        intent: "change",
        severity: "minor",
        comment: "Make it green and say “Place order”",
        target: {
            kind: "element",
            identity: [
                {
                    selector: "#checkout > button.pay",
                    testId: "pay-button",
                    role: "button",
                    name: "Pay £12.40",
                    tag: "button",
                    classes: ["pay"],
                    text: "Pay £12.40",
                    source: { file: "src/checkout/PayButton.tsx", line: 18, col: 7 },
                    component: {
                        name: "PayButton",
                        source: "src/checkout/PayButton.tsx:18:7",
                        path: ["PayButton", "OrderSummary", "CheckoutPage", "App"],
                    },
                    ancestors: ["main", "div#checkout", "aside.summary"],
                    styles: {
                        color: "#ffffff",
                        "background-color": "#2563eb",
                        "font-size": "15px",
                        "font-weight": "600",
                        "border-radius": "10px",
                        padding: "12px 20px",
                        width: "248px",
                        height: "46px",
                    },
                },
            ],
            rect: { x: 1064, y: 512, w: 248, h: 46 },
        },
        screenshots: {
            full: { id: "c".repeat(64), mime: "image/png", w: 2880, h: 1800 },
            crop: { id: "d".repeat(64), mime: "image/png", w: 560, h: 156 },
        },
        context: {
            screenshot: { method: "dom", pin: 1 },
            console: [
                { level: "log", message: "[vite] connected." },
                { level: "warn", message: "Basket: price for sku rooster-2.5 came from cache" },
            ],
            network: [
                { method: "GET", url: "/api/basket", status: 200, ms: 38 },
                { method: "POST", url: "/api/checkout/quote", status: 200, ms: 112 },
            ],
            animations: [
                {
                    kind: "css",
                    name: "pay-pulse",
                    duration: 1600,
                    easing: "ease-in-out",
                    progress: 0.42,
                    state: "running",
                },
            ],
            flags: { newCheckout: true },
        },
        status: "open",
        thread: [],
    });
}

function markdownSamples(): Record<string, string> {
    const note = demoAnnotation();
    return Object.fromEntries(
        DETAILS.map((detail) => [
            detail,
            renderAnnotation(note, { detail, screenshotsAttached: detail !== "compact" }),
        ])
    );
}

async function build() {
    const started = performance.now();
    rmSync(dist, { recursive: true, force: true });
    mkdirSync(dist, { recursive: true });
    cpSync(src, dist, { recursive: true, filter: (path) => !path.endsWith(".ts") });

    // The Markdown samples go into the page itself, so it needs no request to show them. A function replacement, so a
    // `$` in a sample is not read as a pattern.
    const samples = JSON.stringify(markdownSamples()).replaceAll("<", "\\u003c");
    const page = join(dist, "index.html");
    writeFileSync(
        page,
        readFileSync(page, "utf8").replace(
            'id="md-samples">{}<',
            () => `id="md-samples">${samples}<`
        )
    );

    const live = await Bun.build({
        entrypoints: [join(src, "live.ts")],
        outdir: dist,
        naming: "live.js",
        minify: true,
        target: "browser",
        format: "esm",
        define: { "process.env.NODE_ENV": '"production"' },
    });
    if (!live.success) {
        for (const log of live.logs) console.error(log);
        throw new Error("live.js did not build");
    }

    // The docs pages, made from the READMEs.
    const docs = buildDocs(dist);

    if (flag("--artifact")) {
        // A claude.ai artifact supplies its own doctype, html, head and body: keep only what goes inside them.
        const html = readFileSync(page, "utf8");
        const head = html.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? "";
        const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/)?.[1] ?? "";
        writeFileSync(
            join(dist, "artifact.html"),
            `${head.replace(/<meta charset[^>]*>\s*/, "").replace(/<meta name="viewport"[^>]*>\s*/, "")}${body}`
        );
    }
    console.log(
        `built site/dist and ${docs} docs pages in ${Math.round(performance.now() - started)}ms`
    );
}

await build();

if (flag("--serve")) {
    const port = Number(option("--port") ?? 4810);
    const types: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".json": "application/json",
    };
    Bun.serve({
        port,
        hostname: "localhost",
        fetch(request) {
            const path = decodeURIComponent(new URL(request.url).pathname);
            const file = join(dist, path.endsWith("/") ? `${path}index.html` : path);
            if (!file.startsWith(dist) || !existsSync(file))
                return new Response("Not found", { status: 404 });
            return new Response(Bun.file(file), {
                headers: {
                    "content-type": types[extname(file)] ?? "application/octet-stream",
                    "cache-control": "no-store",
                },
            });
        },
    });
    console.log(`serving http://localhost:${port}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const rebuild = () => {
        clearTimeout(timer);
        timer = setTimeout(() => build().catch((error) => console.error(error)), 120);
    };
    watch(src, { recursive: true }, rebuild);
    // The docs are made from these, so a change to one rebuilds them too.
    for (const readme of [
        "README.md",
        "sdks/swift/README.md",
        "sdks/android/README.md",
        "sdks/dotnet/README.md",
    ])
        watch(join(root, "..", readme), rebuild);
}
