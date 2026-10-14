import { type ComponentType, createContext, type ReactNode, useContext } from "react";
import type { Me, ProjectSummary } from "./api.ts";
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
    Frame?: ComponentType<{ me: Me; children: ReactNode }>;
    /** Pages of its own, at `#/x/<key>` (anything after the key is `rest`). */
    pages?: Record<string, ComponentType<ExtensionPageProps>>;
    /** Links the sidebar shows beneath its own: they lead to `#/x/<page>`. */
    nav?: Array<{ label: string; page: string; icon?: IconName }>;
    /** Shown at the top of the sidebar, above the open project: a workspace switcher. */
    SidebarTop?: ComponentType<{ me: Me }>;
    /** Shown at the end of a project's settings. */
    ProjectSettingsExtra?: ComponentType<{ me: Me; projectId: string }>;
    /** Who may create projects, make tokens and change settings. Default: an admin, or anyone in dev mode. */
    canManage?: (me: Me) => boolean;
}

export interface ExtensionPageProps {
    me: Me;
    rest: string;
    projects: ProjectSummary[] | null;
}

const BoardExtensionContext = createContext<BoardExtension | undefined>(undefined);
export const BoardExtensionProvider = BoardExtensionContext.Provider;
export const useBoardExtension = () => useContext(BoardExtensionContext);
