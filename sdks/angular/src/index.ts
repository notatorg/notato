import {
    DestroyRef,
    type EnvironmentProviders,
    inject,
    isDevMode,
    makeEnvironmentProviders,
    NgZone,
    PLATFORM_ID,
    provideEnvironmentInitializer,
} from "@angular/core";
import type { NotatoController, NotatoProps } from "@notato/browser";

// Only types from the browser SDK: a value exported from here would put the whole toolbar in the app's first chunk
// (Angular's bundler keeps a re-exported module that the app imports nothing from), and it must stay a lazy one.
// Plugins and the rest come from @notato/browser itself.
export type { NotatoPlugin, NotatoProps } from "@notato/browser";

/**
 * Puts the Notato toolbar on the app. Add it to the application's providers (`app.config.ts`):
 *
 *     providers: [provideNotato({ project: "shop", server: "http://localhost:4747" })]
 *
 * It starts once the app does and goes when the app is destroyed. In a production build it does nothing unless
 * `enabled` is set: the toolbar is a separate chunk that is only loaded when it starts. During server-side rendering
 * it does nothing.
 *
 * The toolbar runs outside Angular's zone. Everything it does (following scrolls each frame, its timers, the server's
 * live stream) is its own, and inside the zone each of those would set change detection running over the whole app.
 */
export function provideNotato(options: NotatoProps): EnvironmentProviders {
    return makeEnvironmentProviders([
        provideEnvironmentInitializer(() => {
            if (inject(PLATFORM_ID) !== "browser") return;
            if (!(options.enabled ?? isDevMode())) return;
            let cancelled = false;
            let controller: NotatoController | undefined;
            // A zoneless app's stand-in zone just runs it; an injector with no zone at all starts it as it is.
            const zone = inject(NgZone, { optional: true });
            const start = () =>
                import("@notato/browser")
                    .then(({ createController }) => {
                        if (!cancelled) controller = createController(options);
                    })
                    .catch((error: unknown) =>
                        console.warn("[notato] the toolbar could not start", error)
                    );
            if (zone) zone.runOutsideAngular(start);
            else void start();
            inject(DestroyRef).onDestroy(() => {
                cancelled = true;
                controller?.destroy();
            });
        }),
    ]);
}
