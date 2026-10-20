import { href, Icon } from "@notato/board";
import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar, type Me } from "./api.ts";

/** Personal controls follow the account across workspaces and deployments. */
export function AccountMenu({ me, onSignOut }: { me: Me; onSignOut?: () => Promise<void> }) {
    const menu = useRef<HTMLDetailsElement>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const name = me.name || me.username || "Your account";
    const close = useCallback(() => menu.current?.removeAttribute("open"), []);
    useEffect(() => {
        const outside = (event: PointerEvent) => {
            if (event.target instanceof Node && !menu.current?.contains(event.target)) close();
        };
        document.addEventListener("pointerdown", outside);
        return () => document.removeEventListener("pointerdown", outside);
    }, [close]);
    return (
        <details
            className="account-menu"
            ref={menu}
            onKeyDown={(event) => {
                if (event.key === "Escape") {
                    close();
                    menu.current?.querySelector("summary")?.focus();
                }
            }}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) close();
            }}
        >
            <summary className="name-card" aria-label={`Account menu for ${name}`}>
                <Avatar author={{ kind: "human", name }} size={30} />
                <span className="name-text">
                    <span className="name-value">{name}</span>
                    <span className="account-menu-caption">Your account</span>
                </span>
                <Icon name="chevrons" size={14} />
            </summary>
            <div className="menu account-menu-items">
                <a href={href({ page: "settings", tab: "account" })} onClick={close}>
                    <Icon name="users" />
                    Account
                </a>
                <a href={href({ page: "settings", tab: "appearance" })} onClick={close}>
                    <Icon name="sun" />
                    Appearance
                </a>
                {me.workspace?.projectOnly && (
                    <a
                        href={href({ page: "ext", name: "workspace", rest: "tokens" })}
                        onClick={close}
                    >
                        <Icon name="key" />
                        Access tokens
                    </a>
                )}
                <hr />
                <a
                    href="https://buymeacoffee.com/notato"
                    className="support-notato"
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={close}
                >
                    <Icon name="coffee" />
                    <span className="support-notato-label">
                        <span>Support Notato</span>
                        <small>Buy Me a Coffee</small>
                    </span>
                </a>
                {onSignOut && (
                    <>
                        <hr />
                        <button
                            type="button"
                            disabled={busy}
                            onClick={async () => {
                                setBusy(true);
                                setError("");
                                try {
                                    await onSignOut();
                                    close();
                                } catch (reason) {
                                    setError(
                                        reason instanceof Error
                                            ? reason.message
                                            : "Could not sign out."
                                    );
                                } finally {
                                    setBusy(false);
                                }
                            }}
                        >
                            <Icon name="back" />
                            {busy ? "Signing out…" : "Sign out"}
                        </button>
                    </>
                )}
                {error && (
                    <p className="error small" role="alert">
                        {error}
                    </p>
                )}
            </div>
        </details>
    );
}
