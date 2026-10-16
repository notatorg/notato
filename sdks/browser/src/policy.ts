import { authHeaders } from "./auth.ts";
import { net } from "./net.ts";

export interface Policy {
    /** Whether a screenshot may be taken right now. Asks the server again when its answer is older than a few seconds. */
    screenshots(): Promise<boolean>;
    /** The last answer, without asking. For labels, where waiting would be wrong. */
    screenshotsNow(): boolean;
    captureOnlyNow(): boolean;
    derivedScreenshotsNow(): boolean;
    referencesNow(): boolean;
    reviewsNow(): boolean;
    /** Asks the server now. Never throws. */
    refresh(): Promise<void>;
}

const FRESH_MS = 5_000;
const WAIT_MS = 1_500;

/**
 * What the Notato server allows (`notato config`). A configured server must explicitly permit screenshots before
 * any pixels are captured. Local-only capture needs no server permission. A failed refresh keeps the last answer.
 */
export function createPolicy(options: {
    baseUrl: string | undefined;
    project?: string;
    token?: string;
    onCapabilities?: () => void;
}): Policy {
    let allowed = !options.baseUrl;
    let captureOnly = false;
    let derived = false;
    let references = !options.baseUrl;
    let reviews = !options.baseUrl;
    let askedAt = 0;
    let pending: Promise<void> | undefined;

    const refresh = (): Promise<void> => {
        if (!options.baseUrl) return Promise.resolve();
        pending ??= (async () => {
            try {
                // Hosted CORS rules belong to the project, including this capability request.
                const project = options.project
                    ? `?project=${encodeURIComponent(options.project)}`
                    : "";
                const res = await net.fetch(`${options.baseUrl}/config${project}`, {
                    headers: authHeaders(options.token),
                });
                if (res.ok) {
                    const body = (await res.json()) as {
                        references?: unknown;
                        reviews?: unknown;
                        screenshots?: unknown;
                        captureOnly?: unknown;
                        derivedScreenshots?: unknown;
                    };
                    references = body.references === true;
                    reviews = body.reviews === true;
                    allowed = body.screenshots === true;
                    captureOnly = body.captureOnly === true;
                    derived = body.derivedScreenshots === true;
                    options.onCapabilities?.();
                }
            } catch {
                // keep the last answer
            } finally {
                askedAt = Date.now();
                pending = undefined;
            }
        })();
        return pending;
    };

    return {
        refresh,
        screenshotsNow: () => allowed,
        captureOnlyNow: () => captureOnly,
        derivedScreenshotsNow: () => derived,
        referencesNow: () => references,
        reviewsNow: () => reviews,
        async screenshots() {
            if (Date.now() - askedAt > FRESH_MS) {
                // A slow server must not hold up the annotation: stop waiting and go with what is known.
                await Promise.race([
                    refresh(),
                    new Promise<void>((resolve) => setTimeout(resolve, WAIT_MS)),
                ]);
            }
            return allowed;
        },
    };
}
