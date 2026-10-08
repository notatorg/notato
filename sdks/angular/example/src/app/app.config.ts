import { type ApplicationConfig, provideBrowserGlobalErrorListeners } from "@angular/core";
import { provideNotato } from "@notato/angular";

export const appConfig: ApplicationConfig = {
    providers: [
        provideBrowserGlobalErrorListeners(),
        // Development builds only, unless `enabled` says otherwise. Another server: `?server=` on the page's URL.
        provideNotato({
            project: "angular-example",
            appName: "Notato Angular example",
            server: new URLSearchParams(location.search).get("server") ?? undefined,
        }),
    ],
};
