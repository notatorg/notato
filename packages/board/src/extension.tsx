import { type ComponentType, createContext, type ReactNode, useContext } from "react";
import type { Me, ProjectSummary } from "./api.ts";
import type { Route } from "./route.ts";
import type { IconName } from "./ui.tsx";

/**
 * What a deployment adds to the board, so a hosted product can bring its sign-in, workspaces and billing screens
 * without a copy of the board. `mountBoard({ extension })` takes one; a plain board has none.
 */
export interface BoardExtension {
    name: string;
    /** Replaces the sign-in screen. Call `onDone` once the person is signed in. */
    Login?: ComponentType<{ onDone(): void }>;
    /**
     * Wraps the signed-in board: for providers, or a gate that stands in for the board (a payment wall) by not
     * rendering its children.
     */
    Frame?: ComponentType<{ me: Me; refresh(): void; children: ReactNode }>;
    /** Pages of its own, at `#/x/<key>` (anything after the key is `rest`). */
    pages?: Record<string, ComponentType<ExtensionPageProps>>;
    /** Links the sidebar shows beneath its own: they lead to `#/x/<page>`. */
    nav?: Array<{ label: string; page: string; icon?: IconName }>;
    /**
     * Replaces the sidebar's list of projects, and the open project's pages above it: a deployment with many projects
     * (and workspaces to hold them) may prefer a switcher.
     */
    ProjectNav?: ComponentType<ProjectNavProps>;
    /** Shown at the top of the sidebar, above the open project: a workspace switcher. */
    SidebarTop?: ComponentType<{ me: Me }>;
    /** Shown at the end of a project's settings. */
    ProjectSettingsExtra?: ComponentType<{ me: Me; projectId: string }>;
    /** Signs the person out of whatever the extension signed them in to, before the server forgets the session. */
    signOut?: () => Promise<void>;
    /**
     * Keeps what each signed-in account has read on the server rather than in this browser: the board then shows each
     * project's unread notes for that account, and saves what it has seen through `markRead`.
     */
    readState?: { markRead(project: string, at: string): Promise<ProjectSummary> };
    /** The signed-in person's own name, where the service keeps one: it then replaces the name typed into the board. */
    accountName?: (me: Me) => string | undefined;
    /** Whether the server makes a new project's id itself, so the board does not ask for one. */
    automaticProjectIds?: boolean;
    /** What, besides the username, keeps one account's board memory apart from another's (a workspace). */
    accountScope?: (me: Me) => string | undefined;
    /** Whether every token must expire (a hosted service): the Tokens page then leaves out "No expiry". */
    requireTokenExpiry?: boolean;
    /** Who may see and change the server's own settings. Default: whoever may manage. Others get their browser's. */
    canAdminServer?: (me: Me) => boolean;
    /** Who may create projects, make tokens and change settings. Default: an admin, or anyone in dev mode. */
    canManage?: (me: Me) => boolean;
}

export interface ExtensionPageProps {
    me: Me;
    rest: string;
    projects: ProjectSummary[] | null;
}

export interface ProjectNavProps {
    me: Me;
    route: Route;
    /** The project the sidebar's pages lead to: the open one, or the last one looked at. */
    current: string | null;
    projects: ProjectSummary[] | null;
    /** Opens the new-project dialog; absent for anyone who cannot make one. */
    onNewProject?: () => void;
}

const BoardExtensionContext = createContext<BoardExtension | undefined>(undefined);
export const BoardExtensionProvider = BoardExtensionContext.Provider;
export const useBoardExtension = () => useContext(BoardExtensionContext);
