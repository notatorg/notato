import type { CapturePlugin, IdentityPlugin, SinkPlugin } from "@notato/core";
import type { SettingsStore } from "../settings.ts";
import type { NotatoPlugin, NotatoProps } from "../types.ts";
import { animationsPlugin } from "./animations.ts";
import { angularIdentityPlugin } from "./identity-angular.ts";
import { domIdentityPlugin } from "./identity-dom.ts";
import { reactSourceIdentityPlugin } from "./identity-react-source.ts";
import { sourceAttributeIdentityPlugin } from "./identity-source.ts";
import { stylesIdentityPlugin } from "./identity-styles.ts";
import { routePlugin } from "./route.ts";
import { screenshotPlugin } from "./screenshot.ts";
import { stepsPlugin } from "./steps.ts";

// The plugins a toolbar starts with, and how a page's own plugins join them.

const isIdentity = (p: NotatoPlugin): p is IdentityPlugin => "resolve" in p;
const isCapture = (p: NotatoPlugin): p is CapturePlugin => "capture" in p;
const isSink = (p: NotatoPlugin): p is SinkPlugin => "deliver" in p;

/** Built-ins first; a page's plugin with the same id takes the built-in's place. */
function mergePlugins<T extends { id: string }>(defaults: T[], extra: T[]): T[] {
    const out = [...defaults];
    for (const plugin of extra) {
        const at = out.findIndex((p) => p.id === plugin.id);
        if (at >= 0) out[at] = plugin;
        else out.push(plugin);
    }
    return out;
}

/** A plugin that does nothing while its setting is off, so the settings panel can turn it on and off live. */
const whileOn = (plugin: IdentityPlugin, on: () => boolean): IdentityPlugin => ({
    ...plugin,
    resolve: (el) => (on() ? plugin.resolve(el) : {}),
});

/** How an element is identified: its selector and test id, its component and source, and its styles. */
export function identityPlugins(props: NotatoProps, settings: SettingsStore): IdentityPlugin[] {
    const components = () => settings.get().components;
    return mergePlugins<IdentityPlugin>(
        [
            domIdentityPlugin({ testIdAttributes: props.testIdAttributes }),
            whileOn(reactSourceIdentityPlugin(), components),
            whileOn(angularIdentityPlugin(), components),
            sourceAttributeIdentityPlugin(),
            ...(props.styles === false
                ? []
                : [whileOn(stylesIdentityPlugin(), () => settings.get().styles)]),
        ],
        (props.plugins ?? []).filter(isIdentity)
    );
}

/** What is recorded with each note: its route, its screenshots, what was animating and, from an agent, its steps. */
export function capturePlugins(
    props: NotatoProps,
    /** Asked before each screenshot: whether one may be taken now. */
    screenshotsOn: () => Promise<boolean>
): CapturePlugin[] {
    const mode = props.mode ?? "dev";
    return mergePlugins<CapturePlugin>(
        [
            routePlugin({ hash: props.hashRoutes ?? false }),
            screenshotPlugin({ maskInputs: props.maskInputs, enabled: screenshotsOn }),
            animationsPlugin(),
            // An agent's annotation says how it got there; people do not need that recorded.
            ...(mode === "agent"
                ? [stepsPlugin({ testIdAttributes: props.testIdAttributes })]
                : []),
        ],
        (props.plugins ?? []).filter(isCapture)
    );
}

/** Where notes and bundles go: the mode's own sinks, then the page's. */
export function sinkPlugins(props: NotatoProps, modeSinks: SinkPlugin[]): SinkPlugin[] {
    return mergePlugins<SinkPlugin>(modeSinks, (props.plugins ?? []).filter(isSink));
}
