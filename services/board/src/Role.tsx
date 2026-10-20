import type { ReactNode } from "react";
import type { Me } from "./api.ts";

/** Who is looking: what they may manage here, and whether the workspace is just them. */
export interface Who {
    role: "owner" | "admin" | "member";
    /** Owners and admins: they manage connections, projects and people. */
    manager: boolean;
    owner: boolean;
    /** A guest of one project: no workspace pages. */
    guest: boolean;
    /** The only person in the workspace. */
    solo: boolean;
    /** The server's operator, who is not a workspace member. */
    operator: boolean;
    label: string;
}

export function whoIs(me: Me): Who {
    const w = me.workspace;
    const operator = Boolean(me.isAdmin);
    const role = w?.role ?? "member";
    const guest = Boolean(w?.projectOnly);
    const manager = operator || (!guest && role !== "member");
    return {
        role,
        manager,
        owner: operator || role === "owner",
        guest,
        solo: (w?.memberCount ?? 2) <= 1,
        operator,
        label: operator ? "Operator" : guest ? "Guest" : role[0]?.toUpperCase() + role.slice(1),
    };
}

/**
 * Says why something is not here for this person, and who to ask. A page shows it where controls would be, rather
 * than leaving them wondering whether the page is broken.
 */
export function RoleNote({ me, can, children }: { me: Me; can: string; children?: ReactNode }) {
    const who = whoIs(me);
    if (who.manager) return null;
    return (
        <div className="banner role-note" role="note">
            <span>
                You are {who.guest ? "a guest of one project" : "a member"} of this workspace.{" "}
                {children ?? (
                    <>Owners and admins {can}. Ask one of them if you need something changed.</>
                )}
            </span>
        </div>
    );
}

/** Stands in for a workspace page a guest has no access to. */
export function GuestNotice({ what }: { what: string }) {
    return (
        <div className="sheet">
            <div className="sheet-inner settings">
                <header className="sheet-head">
                    <div>
                        <h1>{what}</h1>
                        <p>
                            You were invited to specific projects, so workspace pages are not part
                            of your access. Ask whoever invited you if you need more.
                        </p>
                    </div>
                </header>
            </div>
        </div>
    );
}
