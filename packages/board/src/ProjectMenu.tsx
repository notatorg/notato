import { DETAILS, type Detail as DetailLevel } from "@notato/core";
import { useRef, useState } from "react";
import { projectHref } from "./route.ts";
import { Icon } from "./ui.tsx";

/**
 * The ⋯ menu in the corner of each of a project's pages: copy what the inbox shows as Markdown (and how much of it),
 * export and import zip bundles, and, for admins, the ways to connect an app and the project's settings.
 */
export function ProjectMenu({
    project,
    admin,
    shown,
    detail,
    onDetail,
    onCopy,
    exportHref,
    onImport,
}: {
    project: string;
    admin: boolean;
    /** How many notes the inbox shows, which is what Copy copies. */
    shown: number;
    detail: DetailLevel;
    onDetail(next: DetailLevel): void;
    onCopy(): void;
    /** Where Export zip downloads from: the inbox's filters, without its search. */
    exportHref: string;
    onImport(file: File): void;
}) {
    const [open, setOpen] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);
    const close = () => setOpen(false);

    return (
        <div className="menu-wrap">
            <button
                type="button"
                className="icon-button"
                aria-label="Project actions"
                title={admin ? "Copy, export, import, settings" : "Copy, export, import"}
                aria-expanded={open}
                onClick={() => setOpen(!open)}
            >
                <Icon name="more" />
            </button>
            {open ? (
                <>
                    <button
                        type="button"
                        className="menu-shade"
                        aria-label="Close menu"
                        onClick={close}
                    />
                    <div className="menu" role="menu">
                        <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                                close();
                                onCopy();
                            }}
                            disabled={shown === 0}
                        >
                            <Icon name="copy" />
                            Copy {shown} shown as Markdown
                        </button>
                        <label className="menu-row">
                            Detail
                            <select
                                value={detail}
                                onChange={(e) => onDetail(e.target.value as DetailLevel)}
                            >
                                {DETAILS.map((d) => (
                                    <option key={d}>{d}</option>
                                ))}
                            </select>
                        </label>
                        <hr />
                        <a
                            role="menuitem"
                            href={exportHref}
                            download
                            onClick={close}
                            title="A bundle of the annotations matching the filters (search is not applied)"
                        >
                            <Icon name="download" />
                            Export zip
                        </a>
                        <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                                close();
                                fileInput.current?.click();
                            }}
                        >
                            <Icon name="upload" />
                            Import zip…
                        </button>
                        {admin ? (
                            <>
                                <hr />
                                <a
                                    role="menuitem"
                                    href={projectHref(project, "connect")}
                                    onClick={close}
                                >
                                    <Icon name="plug" />
                                    Connect an app…
                                </a>
                                <a
                                    role="menuitem"
                                    href={projectHref(project, "settings")}
                                    onClick={close}
                                >
                                    <Icon name="sliders" />
                                    Project settings…
                                </a>
                            </>
                        ) : null}
                    </div>
                </>
            ) : null}
            <input
                ref={fileInput}
                type="file"
                accept=".zip,application/zip"
                hidden
                onChange={(e) => {
                    const file = e.target.files?.[0];
                    // Emptied, so choosing the same file again imports it again.
                    e.target.value = "";
                    if (file) onImport(file);
                }}
            />
        </div>
    );
}
