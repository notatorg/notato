import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DevSettings, StyleSheet, View } from "react-native";
import type { NotatoConfig } from "./config.ts";
import { NotatoController, type NotatoState } from "./controller.ts";
import { Overlay } from "./ui/Overlay.tsx";

export interface NotatoProps extends NotatoConfig {
    children?: ReactNode;
}

declare const __DEV__: boolean | undefined;

/** Notato at runtime, for the app to switch on and off, show, and annotate from code. */
export const notato = new NotatoController();

/** Notato's state, kept current: on or off, the toolbar, the connection, the notes. */
export function useNotato(): NotatoState {
    return useSyncExternalStore(notato.subscribe, notato.getState, notato.getState);
}

/** React Native's developer menu brings Notato back when its toolbar is hidden (there is no shake to do it). */
let menuAdded = false;
function addDevMenu() {
    if (menuAdded || typeof DevSettings?.addMenuItem !== "function") return;
    menuAdded = true;
    DevSettings.addMenuItem("Notato: annotate", () => {
        notato.enable();
        notato.showToolbar();
        notato.startAnnotating();
    });
    DevSettings.addMenuItem("Notato: show or hide the toolbar", () => {
        const s = notato.getState();
        if (!s.enabled) {
            notato.enable();
            notato.showToolbar();
        } else if (s.toolbarVisible) notato.hideToolbar();
        else notato.showToolbar();
    });
}

/**
 * Notato for React Native: wrap your app in it. People tap Annotate, then any view, and write what should change; the
 * note reaches your coding agent with a screenshot, the component and the file it is in. In a release build it is
 * your app and nothing else, unless `enabled` says otherwise when it mounts.
 */
export function Notato(props: NotatoProps) {
    // Decided once: a release build that changed its mind later would put the app in another place in the tree, and
    // React would mount it again from scratch.
    const [available] = useState(
        () => (typeof __DEV__ !== "undefined" && __DEV__) || props.enabled === true
    );
    if (!available) return <>{props.children}</>;
    return <NotatoHost {...props} />;
}

function NotatoHost(props: NotatoProps) {
    const outer = useRef<View>(null);
    const app = useRef<View>(null);
    const state = useNotato();
    const route = useRef(props.route);
    route.current = props.route;

    // Every option but the screen, which the overlay reads as it goes.
    const { children: _, route: __, ...config } = props;
    const key = JSON.stringify(config);
    const storage = props.storage;
    // This <Notato> owns Notato while it is mounted. One mounted after it (a remount, or React's StrictMode running
    // effects twice) takes over, and this one going then leaves Notato running.
    useEffect(() => {
        const owner = notato.attach();
        return () => notato.detach(owner);
    }, []);
    // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the options
    useEffect(() => {
        notato.configure({ ...config, ...(storage ? { storage } : {}) });
        addDevMenu();
    }, [key, storage]);

    const readRoute = () => {
        const r = route.current;
        try {
            return (typeof r === "function" ? r() : r) ?? "/";
        } catch {
            return "/";
        }
    };

    // The app is always inside the same two views, so switching Notato on or off never remounts it.
    return (
        <View ref={outer} collapsable={false} style={styles.fill}>
            <View ref={app} collapsable={false} style={styles.fill}>
                {props.children}
            </View>
            {state.enabled ? (
                <Overlay notato={notato} state={state} outer={outer} app={app} route={readRoute} />
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
