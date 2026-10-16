import type { Annotation } from "@notato/schema";
import { useState } from "react";
import { Icon } from "./ui.tsx";

/**
 * A note's page as a link to open: only an http or https address. Whoever sent the note chose the address and the route
 * beside it, so a link is labelled from the address it goes to, never from the route, and any other scheme (one the
 * browser would hand to another program) is shown as text.
 */
export function pageLink(url: string): URL | null {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
    } catch {
        return null;
    }
}

/** Where a note points: its page, and the component, element and source line it was pinned to, as far as known. */
export function TargetFacts({ annotation: a }: { annotation: Annotation }) {
    const target = a.target.identity[0];
    const page = pageLink(a.url);
    return (
        <dl className="target">
            <dt>Page</dt>
            <dd>
                {page ? (
                    <a href={page.href} target="_blank" rel="noreferrer noopener" title={page.href}>
                        {`${page.host}${page.pathname}${page.hash}`}
                        <Icon name="external" size={11} />
                    </a>
                ) : (
                    a.url
                )}
            </dd>
            {target?.component ? (
                <>
                    <dt>Component</dt>
                    <dd>
                        {target.component.path?.join(" › ") ?? target.component.name}
                        {target.component.source ? (
                            <span className="muted"> · {target.component.source}</span>
                        ) : null}
                    </dd>
                </>
            ) : null}
            {target ? (
                <>
                    <dt>{a.target.kind === "multi" ? "Elements" : "Element"}</dt>
                    <dd>
                        {target.selector}
                        {a.target.identity.length > 1 ? (
                            <span className="muted"> and {a.target.identity.length - 1} more</span>
                        ) : null}
                    </dd>
                </>
            ) : null}
            {target?.source ? (
                <>
                    <dt>{target.source.nearest ? "Inside" : "Source"}</dt>
                    <dd className="source">
                        {target.source.file}:{target.source.line}:{target.source.col}
                    </dd>
                </>
            ) : null}
        </dl>
    );
}

/** Everything else the note recorded (the screen, the browser, the steps that led to it), behind "Show details". */
export function MoreFacts({ annotation: a }: { annotation: Annotation }) {
    const [open, setOpen] = useState(false);
    const target = a.target.identity[0];
    const page = pageLink(a.url);
    return (
        <section className="facts">
            <button
                type="button"
                className="link"
                onClick={() => setOpen(!open)}
                aria-expanded={open}
            >
                {open ? "Hide details" : "Show details"}
            </button>
            {open ? (
                <dl>
                    <dt>Page</dt>
                    <dd>
                        {page ? (
                            <a href={page.href} target="_blank" rel="noreferrer noopener">
                                {page.href}
                            </a>
                        ) : (
                            a.url
                        )}
                    </dd>
                    <dt>Screen</dt>
                    <dd>
                        {a.environment.viewport.w}×{a.environment.viewport.h} @{a.environment.dpr}x
                    </dd>
                    <dt>Browser</dt>
                    <dd>{a.environment.userAgent}</dd>
                    {a.appName ? (
                        <>
                            <dt>App</dt>
                            <dd>
                                {a.appName} {a.appVersion}
                            </dd>
                        </>
                    ) : null}
                    <dt>Mode</dt>
                    <dd>{a.mode}</dd>
                    {a.bundleId ? (
                        <>
                            <dt>Bundle</dt>
                            <dd>
                                <code>{a.bundleId}</code>
                            </dd>
                        </>
                    ) : null}
                    {target?.testId ? (
                        <>
                            <dt>Test id</dt>
                            <dd>
                                <code>{target.testId}</code>
                            </dd>
                        </>
                    ) : null}
                    {target?.role || target?.name ? (
                        <>
                            <dt>Accessible</dt>
                            <dd>
                                {target.role} {target.name ? `“${target.name}”` : ""}
                            </dd>
                        </>
                    ) : null}
                    {target?.ancestors?.length ? (
                        <>
                            <dt>Inside</dt>
                            <dd>
                                <code>{target.ancestors.join(" › ")}</code>
                            </dd>
                        </>
                    ) : null}
                    {target?.styles && Object.keys(target.styles).length ? (
                        <>
                            <dt>Styles</dt>
                            <dd className="styles">
                                {Object.entries(target.styles).map(([k, v]) => (
                                    <code key={k}>
                                        {k}: {v}
                                    </code>
                                ))}
                            </dd>
                        </>
                    ) : null}
                    {a.steps?.length ? (
                        <>
                            <dt>Steps</dt>
                            <dd>
                                <ol>
                                    {a.steps.map((s) => (
                                        <li
                                            key={`${s.at}-${s.action}-${s.target ?? s.value ?? ""}`}
                                        >
                                            {s.action} {s.target ? <code>{s.target}</code> : null}{" "}
                                            {s.value ?? ""}
                                        </li>
                                    ))}
                                </ol>
                            </dd>
                        </>
                    ) : null}
                    <dt>Id</dt>
                    <dd>
                        <code>{a.id}</code>
                    </dd>
                </dl>
            ) : null}
        </section>
    );
}
