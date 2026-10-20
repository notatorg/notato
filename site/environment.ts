/** Cloudflare's branch determines the build, even if an old dashboard variable says otherwise. */
export function siteEnvironment(env: Record<string, string | undefined>) {
    const mode = env.WORKERS_CI_BRANCH
        ? env.WORKERS_CI_BRANCH === "main"
            ? "production"
            : "preview"
        : (env.NOTATO_SITE_ENV ?? "local");
    if (mode !== "production" && mode !== "preview" && mode !== "local")
        throw new Error("NOTATO_SITE_ENV must be production, preview or local");
    return mode;
}
