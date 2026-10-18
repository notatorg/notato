import { type BrowserConnection, connectionOrigin } from "@notato/core";
import type { NotatoProps } from "./types.ts";

declare const process: {
    env: {
        NEXT_PUBLIC_NOTATO?: string;
        NEXT_PUBLIC_NOTATO_SERVER?: string;
        NEXT_PUBLIC_NOTATO_CONNECTION?: string;
    };
};
/**
 * What the environment the app was built in says about Notato. Vite, and the frameworks built on it, put `VITE_`
 * variables in `import.meta.env` for packages too, so they reach here from wherever the app is built or served: a
 * `.env` file, the shell, or a launcher such as Aspire.
 */
export interface NotatoEnvironment {
    /**
     * `VITE_NOTATO`: `true` turns the toolbar on, in a production build too; `false` keeps it off, in development too.
     * It is the variable `@notato/vite` records source positions under, and what `npx notato init` guards the toolbar
     * with.
     */
    enabled?: boolean;
    /** `VITE_NOTATO_SERVER`: the Notato server, such as `http://localhost:4747`. */
    server?: string;
    connection?: BrowserConnection;
}

/** Each variable written out in full: bundlers replace them one by one, where they are read. */
type Env =
    | { VITE_NOTATO?: unknown; VITE_NOTATO_SERVER?: unknown; VITE_NOTATO_CONNECTION?: unknown }
    | undefined;

/** `true`, `1`, `yes` and `on`, or `false`, `0`, `no` and `off`, in any case. Anything else is as if it were not set. */
export function parseSwitch(value: unknown): boolean | undefined {
    if (typeof value === "boolean") return value;
    if (typeof value !== "string") return undefined;
    const word = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(word)) return true;
    if (["false", "0", "no", "off"].includes(word)) return false;
    return undefined;
}

/** Reads the variables from `env`, which is `import.meta.env` where the app's bundler provides one. */
export function readEnvironment(env: Env): NotatoEnvironment {
    const server = typeof env?.VITE_NOTATO_SERVER === "string" ? env.VITE_NOTATO_SERVER.trim() : "";
    let connection: BrowserConnection | undefined;
    if (env?.VITE_NOTATO_CONNECTION !== undefined) {
        try {
            const c = JSON.parse(String(env.VITE_NOTATO_CONNECTION));
            if (
                !c ||
                typeof c !== "object" ||
                "agentToken" in c ||
                !["local", "remote"].includes(c.mode) ||
                typeof c.name !== "string" ||
                !c.name ||
                c.name.length > 120 ||
                typeof c.server !== "string" ||
                (c.project !== undefined &&
                    (typeof c.project !== "string" ||
                        !/^(?!\.+$)[\w.@-]{1,200}$/.test(c.project))) ||
                (c.mode === "remote" &&
                    (!c.project ||
                        typeof c.token !== "string" ||
                        !c.token ||
                        !c.context ||
                        typeof c.context.id !== "string" ||
                        typeof c.context.name !== "string")) ||
                (c.mode === "local" && (c.token || c.context))
            )
                throw new Error();
            connection = {
                name: c.name,
                mode: c.mode,
                server: connectionOrigin(c.server, c.mode === "local"),
                ...(c.project ? { project: c.project } : {}),
                ...(c.mode === "remote"
                    ? {
                          token: c.token,
                          context: {
                              id: c.context.id,
                              name: c.context.name,
                              branch: c.context.branch,
                          },
                      }
                    : {}),
            };
        } catch {
            throw new Error(
                "Invalid Notato connection profile. Capture stopped; select a valid connection and restart the app."
            );
        }
    }
    return {
        enabled: parseSwitch(env?.VITE_NOTATO),
        server: server || undefined,
        ...(connection ? { connection } : {}),
    };
}

/** A selected profile replaces the entire destination together; old inline credentials cannot leak to another server. */
export function applyEnvironment(props: NotatoProps, env: NotatoEnvironment): NotatoProps {
    if (env.connection) {
        const { token, ...display } = env.connection;
        return {
            ...props,
            server: display.server,
            project: display.project ?? props.project,
            token,
            connection: display,
        };
    }
    return env.server ? { ...props, server: env.server } : props;
}

/**
 * The environment's say. Without a bundler that provides `import.meta.env` (webpack, a script tag) nothing is set,
 * and the app's own props decide.
 */
export function notatoEnvironment(): NotatoEnvironment {
    let env: Env;
    try {
        env = {
            // Written exactly as bundlers and Vitest look for them. Only Vite's and Bun's types declare
            // `import.meta.env`, and an app that compiles this source with Angular's has neither, hence the ignores (an
            // expect-error would fail where it is declared). A cast would hide the reads from Vitest.
            // biome-ignore lint/suspicious/noTsIgnore: declared by some compilers' types and not others
            // @ts-ignore
            VITE_NOTATO: import.meta.env?.VITE_NOTATO,
            // biome-ignore lint/suspicious/noTsIgnore: as above
            // @ts-ignore
            VITE_NOTATO_SERVER: import.meta.env?.VITE_NOTATO_SERVER,
            // biome-ignore lint/suspicious/noTsIgnore: bundler-specific environment
            // @ts-ignore
            VITE_NOTATO_CONNECTION: import.meta.env?.VITE_NOTATO_CONNECTION,
        };
    } catch {
        env = {};
    }
    // Literal reads are required for Next's browser replacement. Never read an agent secret here.
    try {
        env.VITE_NOTATO ??= process.env.NEXT_PUBLIC_NOTATO;
        env.VITE_NOTATO_SERVER ??= process.env.NEXT_PUBLIC_NOTATO_SERVER;
        env.VITE_NOTATO_CONNECTION ??= process.env.NEXT_PUBLIC_NOTATO_CONNECTION;
    } catch {
        /* No process in an ordinary browser. */
    }
    return readEnvironment(env);
}
