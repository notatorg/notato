import { type KnownAgent, knownAgent } from "@notato/core";
import type { Status } from "@notato/schema";
import { type ReactNode, useState } from "react";
import { copyText } from "./api.ts";
import { authorName, initial, statusLabel } from "./model.ts";
import logo from "./notato.png";
import { setTheme, useTheme } from "./theme.ts";

// Small shared pieces: icons, avatars, status marks. Icons are inline SVG in `currentColor`.

const paths = {
    search: "M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0Zm3 10-4.35-4.35",
    copy: "M11 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2ZM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
    link: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
    trash: "M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
    more: "M5 12h.01M12 12h.01M19 12h.01",
    back: "M15 18l-6-6 6-6",
    menu: "M4 6h16M4 12h16M4 18h16",
    chat: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z",
    external: "M14 4h6v6m0-6-9 9M19 14v6H4V5h6",
    close: "M6 6l12 12M18 6 6 18",
    inbox: "M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z",
    activity: "M22 12h-4l-3 9L9 3l-3 9H2",
    chart: "M18 20V10M12 20V4M6 20v-6",
    grid: "M4 4h7v7H4zm9 0h7v7h-7zM4 13h7v7H4zm9 0h7v7h-7z",
    key: "M15 7a4 4 0 1 1-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0 1 15 7Zm1 3h.01",
    file: "M14 3H6v18h12V7zm0 0v4h4",
    filter: "M3 5h18l-7 8v6l-4 2v-8z",
    download: "M12 4v12m-5-5 5 5 5-5M4 20h16",
    upload: "M12 20V8m-5 5 5-5 5 5M4 4h16",
    sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
    sliders: "M4 7h9m4 0h3M4 17h3m4 0h9M15 5v4M9 15v4",
    page: "M4 5h16v14H4zM4 9h16",
    gear: "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z",
    sun: "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41",
    moon: "M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z",
    check: "M20 6 9 17l-5-5",
    plus: "M12 5v14M5 12h14",
    send: "M12 19V5m-6 6 6-6 6 6",
    plug: "M9 2v6m6-6v6M6 8h12v3a6 6 0 0 1-12 0zm6 9v5",
    warn: "M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
} as const;

export type IconName = keyof typeof paths;

export function Icon({
    name,
    size = 16,
    className,
}: {
    name: IconName;
    size?: number;
    className?: string;
}) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={name === "more" ? 3 : name === "check" || name === "send" ? 2.6 : 2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
            aria-hidden="true"
        >
            <path d={paths[name]} />
        </svg>
    );
}

/** A status as a small dot in its colour: a ring while it is new, filled once someone has done something. */
export function StatusDot({ status, label = false }: { status: Status; label?: boolean }) {
    return label ? (
        <span className={`status-dot s-${status}`} role="img" aria-label={statusLabel(status)} />
    ) : (
        <span className={`status-dot s-${status}`} aria-hidden="true" />
    );
}

export function StatusPill({ status }: { status: Status }) {
    return (
        <span className={`pill s-${status}`}>
            <span className="pill-dot" aria-hidden="true" />
            {statusLabel(status)}
        </span>
    );
}

/**
 * A round badge with a person's initial; an agent's is in the accent colour, or carries its own logo when it is one
 * Notato knows (Claude, Codex, Cursor…).
 */
export function Avatar({
    author,
    size = 30,
}: {
    author: { kind: string; name?: string };
    size?: number;
}) {
    const name = authorName(author);
    const agent = author.kind === "agent";
    const known = agent ? knownAgent(author.name) : undefined;
    if (known) {
        const ink = known.background === "ink";
        return (
            <span
                className={ink ? "avatar brand ink" : "avatar brand"}
                style={{
                    width: size,
                    height: size,
                    ...(ink ? {} : { background: known.background, color: known.color }),
                }}
                title={name}
            >
                <AgentLogo agent={known} size={Math.round(size * 0.6)} />
            </span>
        );
    }
    return (
        <span
            className={agent ? "avatar agent" : "avatar"}
            style={{ width: size, height: size, fontSize: Math.round(size * 0.43) }}
            title={name}
        >
            {agent || author.name ? initial(name) : "?"}
        </span>
    );
}

/** A known agent's logo, in `currentColor`. */
export function AgentLogo({ agent, size }: { agent: KnownAgent; size: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="currentColor"
            fillRule="evenodd"
            clipRule="evenodd"
            aria-hidden="true"
        >
            {agent.paths.map((d) => (
                <path key={d} d={d} />
            ))}
        </svg>
    );
}

/** A project's mark: the first letter of its name on a tile, in the accent colour when it is the one open. */
export function ProjectMark({
    name,
    size = 26,
    active,
}: {
    name: string;
    size?: number;
    active?: boolean;
}) {
    const letters = name.replace(/[^\p{L}\p{N}]/gu, "");
    return (
        <span
            className={active ? "project-mark active" : "project-mark"}
            style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
            aria-hidden="true"
        >
            {letters ? initial(letters) : "#"}
        </span>
    );
}

/** The potato, for empty states and the brand. */
export function Logo({
    size,
    tilt = 0,
    className,
}: {
    size: number;
    tilt?: number;
    className?: string;
}) {
    return (
        <img
            className={className ? `logo ${className}` : "logo"}
            src={logo}
            alt=""
            width={size}
            height={size}
            style={tilt ? { transform: `rotate(${tilt}deg)` } : undefined}
        />
    );
}

export function Empty({
    title,
    children,
    logo = 72,
}: {
    title: string;
    children?: ReactNode;
    logo?: number;
}) {
    return (
        <div className="empty">
            {logo ? <Logo size={logo} tilt={6} /> : null}
            <p className="empty-title">{title}</p>
            {children ? <div className="empty-body">{children}</div> : null}
        </div>
    );
}

/** A two-way switch in a pill, the one used for views, filters and the theme. */
export function Segmented<T extends string>({
    options,
    value,
    onChange,
    label,
    className,
}: {
    options: ReadonlyArray<{ id: T; label: ReactNode; count?: number; icon?: IconName }>;
    value: T | null;
    onChange(next: T): void;
    label: string;
    className?: string;
}) {
    return (
        <div
            className={className ? `segmented ${className}` : "segmented"}
            role="tablist"
            aria-label={label}
        >
            {options.map((o) => (
                <button
                    key={o.id}
                    type="button"
                    role="tab"
                    aria-selected={value === o.id}
                    className={value === o.id ? "on" : undefined}
                    onClick={() => onChange(o.id)}
                >
                    {o.icon ? <Icon name={o.icon} size={13} /> : null}
                    {o.label}
                    {o.count !== undefined ? <span className="n">{o.count}</span> : null}
                </button>
            ))}
        </div>
    );
}

/** Light or dark, for this browser. */
export function ThemeSwitch({ icons }: { icons?: boolean }) {
    const theme = useTheme();
    return (
        <Segmented
            label="Appearance"
            className="theme-switch"
            value={theme}
            onChange={setTheme}
            options={[
                { id: "light", label: "Light", icon: icons ? "sun" : undefined },
                { id: "dark", label: "Dark", icon: icons ? "moon" : undefined },
            ]}
        />
    );
}

/** A time that reads short and shows the full date on hover. */
export function When({ iso, children }: { iso: string; children: ReactNode }) {
    const date = new Date(iso);
    return (
        <time
            dateTime={iso}
            title={date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })}
        >
            {children}
        </time>
    );
}

/** Text with `code` in backticks, as the connect guides write it. */
export function Inline({ text }: { text: string }) {
    return (
        <>
            {text.split("`").map((part, i) =>
                // Every other part was inside backticks. The parts never move, so their place is their key.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above
                i % 2 ? <code key={i}>{part}</code> : part
            )}
        </>
    );
}

/** A block of code to copy: a snippet, a token. */
export function CodeBlock({
    code,
    label = "Copy",
    className,
}: {
    code: string;
    label?: string;
    className?: string;
}) {
    const [copied, setCopied] = useState<"yes" | "no" | null>(null);
    const copy = async () => {
        try {
            await copyText(code);
            setCopied("yes");
        } catch {
            setCopied("no");
        }
        setTimeout(() => setCopied(null), 1600);
    };
    return (
        <div className={className ? `code-block ${className}` : "code-block"}>
            <pre>
                <code>{code}</code>
            </pre>
            <button type="button" className="small copy" onClick={copy} aria-label={label}>
                <Icon name={copied === "yes" ? "check" : "copy"} size={13} />
                {copied === "yes" ? "Copied" : copied === "no" ? "Select and copy" : "Copy"}
            </button>
        </div>
    );
}

/** An on/off switch. */
export function Toggle({
    label,
    on,
    disabled,
    onChange,
}: {
    label: string;
    on: boolean;
    disabled?: boolean;
    onChange(next: boolean): void;
}) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={label}
            className={on ? "switch on" : "switch"}
            disabled={disabled}
            onClick={() => onChange(!on)}
        >
            <span className="knob" />
        </button>
    );
}
