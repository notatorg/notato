import { useSyncExternalStore } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { Rect } from "./rect.ts";
import { BRAND } from "./theme.ts";

/** An element outlined and numbered. */
export interface Outline {
    rect: Rect;
    pin: number;
}

/** What is drawn into the screenshot: the selection's outline, and while one is taken, its outline and the covers. */
export interface StageState {
    selected?: Outline;
    capturing?: Outline & { covers: Rect[] };
}

/**
 * What Notato draws over the app inside the view the screenshot is of, and nothing else of Notato's is: the toolbar,
 * the pins and the composer sit beside it, out of the picture, so they never have to be hidden for one. The overlay
 * sets it; the stage draws it.
 */
export class Stage {
    private state: StageState = {};
    private readonly listeners = new Set<() => void>();

    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    get = (): StageState => this.state;

    set(change: Partial<StageState>): void {
        const next = { ...this.state, ...change };
        if (next.selected === this.state.selected && next.capturing === this.state.capturing)
            return;
        this.state = next;
        for (const listener of [...this.listeners]) listener();
    }
}

/** Draws the stage over the app: the outline (the one being photographed first) and the covers over what is private. */
export function StageView({ stage }: { stage: Stage }) {
    const { selected, capturing } = useSyncExternalStore(stage.subscribe, stage.get, stage.get);
    const outline = capturing ?? selected;
    if (!outline) return null;
    return (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
            {capturing?.covers.map((c) => (
                <View
                    key={`${c.x},${c.y},${c.w},${c.h}`}
                    style={[styles.cover, { left: c.x, top: c.y, width: c.w, height: c.h }]}
                />
            ))}
            <View
                style={[
                    styles.outline,
                    {
                        left: outline.rect.x - 2,
                        top: outline.rect.y - 2,
                        width: outline.rect.w + 4,
                        height: outline.rect.h + 4,
                    },
                ]}
            >
                <View style={styles.outlinePin}>
                    <Text style={styles.pinText}>{outline.pin}</Text>
                </View>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    cover: { position: "absolute", backgroundColor: BRAND.cover, borderRadius: 4 },
    outline: {
        position: "absolute",
        borderWidth: 2,
        borderColor: BRAND.selection,
        backgroundColor: "rgba(229,72,77,0.08)",
        borderRadius: 4,
    },
    outlinePin: {
        position: "absolute",
        top: -12,
        right: -12,
        width: 24,
        height: 24,
        borderRadius: 12,
        backgroundColor: BRAND.selection,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 2,
        borderColor: "#fff",
    },
    pinText: { color: "#fff", fontSize: 12, fontWeight: "800" },
});
