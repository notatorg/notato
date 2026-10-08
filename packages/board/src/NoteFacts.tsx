import type { Annotation } from "@notato/schema";
import { useState } from "react";
import { Icon } from "./ui.tsx";

/** Where a note points: its page, and the component, element and source line it was pinned to, as far as known. */
export function TargetFacts({ annotation: a }: { annotation: Annotation }) {
    const target = a.target.identity[0];
    return (
        <dl className="target">
            <dt>Page</dt>
            <dd>
                <a href={a.url} target="_blank" rel="noreferrer noopener" title={a.url}>
                    {a.route}
                    <Icon name="external" size={11} />
                </a>
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
                        <a href={a.url} target="_blank" rel="noreferrer noopener">
                            {a.url}
                        </a>
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
