import { createElement, Fragment, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// There is no React Native renderer under vitest, so the composer is drawn by hand: React Native's views become plain
// named nodes, and the hooks the composer uses keep their state in `hooks.slots`, in call order, between renders.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], next: 0, renders: 0 }));

vi.mock("react", async (importOriginal) => {
    const react = await importOriginal<typeof import("react")>();
    const slot = <T>(init: () => T): [T, number] => {
        const at = hooks.next++;
        if (!(at in hooks.slots)) hooks.slots[at] = init();
        return [hooks.slots[at] as T, at];
    };
    const useState = <T>(init: T | (() => T)) => {
        const [value, at] = slot(() => (typeof init === "function" ? (init as () => T)() : init));
        const set = (next: T | ((old: T) => T)) => {
            hooks.slots[at] =
                typeof next === "function" ? (next as (old: T) => T)(hooks.slots[at] as T) : next;
        };
        return [value, set] as const;
    };
    const fake = {
        useState,
        useRef: <T>(init: T) => slot(() => ({ current: init }))[0],
        useMemo: <T>(make: () => T) => make(),
        useEffect: () => undefined,
        useLayoutEffect: () => undefined,
    };
    return { ...react, ...fake, default: { ...react, ...fake } };
});

vi.mock("react-native", () => ({
    View: "View",
    Text: "Text",
    Pressable: "Pressable",
    Image: "Image",
    Switch: "Switch",
    TextInput: "TextInput",
    ScrollView: "ScrollView",
    StyleSheet: { create: <T>(styles: T) => styles, hairlineWidth: 0.5, absoluteFill: {} },
    useColorScheme: () => "light",
    Animated: { Value: class {}, View: "Animated.View" },
    Easing: { out: (f: unknown) => f, in: (f: unknown) => f, cubic: (t: number) => t },
    AccessibilityInfo: {},
    PanResponder: { create: () => ({ panHandlers: {} }) },
}));

const { Composer, visibilityLabel } = await import("../src/ui/Composer.tsx");
const { ICONS } = await import("../src/ui/icons.ts");

type Props = Record<string, unknown> & { children?: unknown };
/** A React Native view, drawn. */
interface Drawn {
    type: string;
    props: Props;
    children: Array<Drawn | string>;
}

/** Draws an element down to React Native's views, calling every component on the way. */
function draw(node: unknown): Array<Drawn | string> {
    if (node === null || node === undefined || typeof node === "boolean") return [];
    if (typeof node === "string" || typeof node === "number") return [String(node)];
    if (Array.isArray(node)) return node.flatMap(draw);
    const { type, props } = node as ReactElement<Props>;
    if (type === Fragment) return draw(props.children);
    if (typeof type === "function") return draw((type as (p: Props) => ReactNode)(props));
    if (typeof type === "object" && type && "render" in type) {
        return draw((type as { render(p: Props, ref: unknown): ReactNode }).render(props, null));
    }
    const children =
        typeof props.children === "function" ? props.children({ pressed: false }) : props.children;
    return [{ type: String(type), props, children: draw(children) }];
}

function* walk(nodes: Array<Drawn | string>): Generator<Drawn> {
    for (const node of nodes) {
        if (typeof node === "string") continue;
        yield node;
        yield* walk(node.children);
    }
}

const textOf = (node: Drawn): string =>
    node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

/** A composer that keeps its state between draws, as one on screen would. */
function composer(props: { sharedByDefault?: boolean; onSend?: (draft: unknown) => void } = {}) {
    hooks.slots = [];
    const sent: unknown[] = [];
    const render = () => {
        hooks.next = 0;
        const nodes = draw(
            createElement(Composer, {
                title: "Button",
                screenshotsOff: false,
                canParent: false,
                onParent: () => undefined,
                onCancel: () => undefined,
                onSend: (draft) => sent.push(draft),
                ...props,
            })
        );
        const all = [...walk(nodes)];
        const byId = (id: string) => all.find((node) => node.props.testID === id);
        const button = byId("NotatoVisibility");
        if (!button) throw new Error("no visibility button");
        const images = [...walk([button])].filter((node) => node.type === "Image");
        return {
            all,
            byId,
            button,
            label: button.props.accessibilityLabel,
            expanded: (button.props.accessibilityState as { expanded: boolean }).expanded,
            text: textOf(button),
            icons: images.map((image) => (image.props.source as { uri: string }).uri),
            switches: ["NotatoShared", "NotatoPeopleOnly"].filter((id) => byId(id)),
        };
    };
    const press = (id: string) => {
        const node = render().byId(id);
        if (!node) throw new Error(`no ${id}`);
        (node.props.onPress as () => void)();
    };
    return { render, press, sent };
}

describe("the composer's visibility button", () => {
    beforeEach(() => {
        hooks.slots = [];
    });

    it("says who can see the note for each pair of switches", () => {
        expect(visibilityLabel(false, false)).toBe("You and your agent");
        expect(visibilityLabel(true, false)).toBe("Shared with project");
        expect(visibilityLabel(false, true)).toBe("Only you");
        expect(visibilityLabel(true, true)).toBe("Project, not agent");
    });

    it("starts closed, with the switches hidden", () => {
        const shown = composer().render();
        expect(shown.expanded).toBe(false);
        expect(shown.switches).toEqual([]);
        expect(shown.label).toBe("Visibility: You and your agent");
        expect(shown.text).toBe("You and your agent");
        expect(shown.icons).toEqual([ICONS.lock, ICONS.chevronDown]);
    });

    it("starts from the project's default, and says so", () => {
        const shown = composer({ sharedByDefault: true }).render();
        expect(shown.text).toBe("Shared with project");
        expect(shown.icons[0]).toBe(ICONS.people);
        expect(shown.switches).toEqual([]);
    });

    it("shows the two switches under it while open, and hides them again", () => {
        const c = composer();
        c.press("NotatoVisibility");
        const open = c.render();
        expect(open.expanded).toBe(true);
        expect(open.switches).toEqual(["NotatoShared", "NotatoPeopleOnly"]);
        // Directly under the button.
        const at = open.all.indexOf(open.button);
        expect(open.all.indexOf(open.byId("NotatoShared") as Drawn)).toBeGreaterThan(at);
        c.press("NotatoVisibility");
        const closed = c.render();
        expect(closed.expanded).toBe(false);
        expect(closed.switches).toEqual([]);
    });

    it("changes its words and icon as the switches change", () => {
        const c = composer();
        c.press("NotatoVisibility");
        c.press("NotatoShared");
        expect(c.render().text).toBe("Shared with project");
        expect(c.render().icons[0]).toBe(ICONS.people);
        c.press("NotatoPeopleOnly");
        expect(c.render().label).toBe("Visibility: Project, not agent");
        c.press("NotatoShared");
        expect(c.render().text).toBe("Only you");
        expect(c.render().icons[0]).toBe(ICONS.lock);
    });

    it("sends what the switches say", () => {
        const c = composer();
        c.press("NotatoVisibility");
        c.press("NotatoShared");
        c.press("NotatoPeopleOnly");
        c.press("NotatoVisibility");
        const field = c.render().byId("NotatoComment");
        if (!field) throw new Error("no comment field");
        (field.props.onChangeText as (text: string) => void)(" Too small ");
        c.press("NotatoSend");
        expect(c.sent).toEqual([
            {
                comment: "Too small",
                intent: undefined,
                severity: undefined,
                peopleOnly: true,
                visibility: "shared",
            },
        ]);
    });

    it("puts the feedback type above the comment and severity under it, with no headings", () => {
        const shown = composer().render();
        const groups = shown.all.filter(
            (node) => typeof node.props.accessibilityLabel === "string"
        );
        const order = groups.map((node) => node.props.accessibilityLabel);
        expect(order.indexOf("Feedback type")).toBeLessThan(order.indexOf("Note"));
        expect(order.indexOf("Note")).toBeLessThan(order.indexOf("Severity"));
        expect(order.indexOf("Severity")).toBeLessThan(
            order.indexOf("Visibility: You and your agent")
        );
        const words = shown.all.filter((node) => node.type === "Text").map(textOf);
        expect(words).not.toContain("Feedback type");
        expect(words).not.toContain("Severity");
        expect(words).not.toContain("Visibility");
    });
});
