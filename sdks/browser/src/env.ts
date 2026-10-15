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
}

/** Each variable written out in full: bundlers replace them one by one, where they are read. */
type Env = { VITE_NOTATO?: unknown; VITE_NOTATO_SERVER?: unknown } | undefined;

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
    return { enabled: parseSwitch(env?.VITE_NOTATO), server: server || undefined };
}

/**
 * The environment's say. Without a bundler that provides `import.meta.env` (webpack, a script tag) nothing is set,
 * and the app's own props decide.
 */
export function notatoEnvironment(): NotatoEnvironment {
    try {
        return readEnvironment({
            // Written exactly as bundlers and Vitest look for them. Only Vite's and Bun's types declare
            // `import.meta.env`, and an app that compiles this source with Angular's has neither, hence the ignores (an
            // expect-error would fail where it is declared). A cast would hide the reads from Vitest.
            // biome-ignore lint/suspicious/noTsIgnore: declared by some compilers' types and not others
            // @ts-ignore
            VITE_NOTATO: import.meta.env?.VITE_NOTATO,
            // biome-ignore lint/suspicious/noTsIgnore: as above
            // @ts-ignore
            VITE_NOTATO_SERVER: import.meta.env?.VITE_NOTATO_SERVER,
        });
    } catch {
        return {};
    }
}
