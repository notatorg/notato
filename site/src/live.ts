import { createController, type NotatoController } from "../../sdks/browser/src/controller.ts";

/**
 * The real Notato toolbar, loaded by the site's "Try it here" button. Test mode with no server: notes stay in this
 * browser, and Package downloads the zip a tester would send.
 */
export function start(): NotatoController {
    return createController({
        mode: "test",
        project: "notato-site",
        appName: "Notato website",
        position: "bottom-right",
    });
}
