import { afterEach, describe, expect, it } from "vitest";
import { commitCount } from "../src/inspect.ts";
import { NotatoMask } from "../src/mask.tsx";
import { elementsUnder, type Fiber, HOST_COMPONENT, maskedUnder } from "../src/tree.ts";

/** A fiber tree as React builds one: `[type, props, children]`, functions for components, strings for native views. */
type Spec = [unknown, Record<string, unknown>?, Spec[]?];

function build(spec: Spec, parent: Fiber | null = null, owner: Fiber | null = null): Fiber {
    const [type, props = {}, children = []] = spec;
    const fiber: Fiber = {
        tag: typeof type === "string" ? HOST_COMPONENT : 0,
        type,
        memoizedProps: props,
        return: parent,
        child: null,
        sibling: null,
        _debugOwner: owner,
        stateNode:
            typeof type === "string"
                ? { node: {}, canonical: { publicInstance: { id: props.testID ?? type } } }
                : null,
    };
    const nextOwner = typeof type === "function" && type !== NotatoMask ? fiber : owner;
    let previous: Fiber | null = null;
    for (const child of children) {
        const f = build(child, fiber, nextOwner);
        if (previous) previous.sibling = f;
        else fiber.child = f;
        previous = f;
    }
    return fiber;
}

function App() {}
function Account() {}
function Search() {}

const root = build([
    "RCTView",
    {},
    [
        [
            App,
            {},
            [
                ["RCTText", { children: "Hello Ada" }],
                [
                    Account,
                    {},
                    [
                        [
                            NotatoMask,
                            {},
                            [
                                [
                                    "RCTText",
                                    { children: "ada@example.com", accessibilityLabel: "Email" },
                                ],
                            ],
                        ],
                        ["AndroidTextInput", { placeholder: "Name", value: "Ada Lovelace" }],
                        [
                            "AndroidTextInput",
                            { placeholder: "Password", value: "hunter2", secureTextEntry: true },
                        ],
                        [
                            NotatoMask,
                            { private: false },
                            [
                                [
                                    Search,
                                    {},
                                    [
                                        [
                                            "AndroidTextInput",
                                            { placeholder: "Search", value: "spuds" },
                                        ],
                                    ],
                                ],
                            ],
                        ],
                        [
                            NotatoMask,
                            {},
                            [
                                [
                                    NotatoMask,
                                    { private: false },
                                    [["AndroidTextInput", { value: "inside private" }]],
                                ],
                            ],
                        ],
                    ],
                ],
            ],
        ],
    ],
]);

describe("elementsUnder", () => {
    it("lists native views in drawing order, with the components around them", () => {
        const elements = elementsUnder(root, false);
        expect(elements.map((e) => e.tag)).toEqual([
            "Text",
            "Text",
            "TextInput",
            "TextInput",
            "TextInput",
            "TextInput",
        ]);
        expect(elements[0]).toMatchObject({ text: "Hello Ada", path: ["App"], private: false });
        expect(elements[1]?.path).toEqual(["App", "Account"]);
    });

    it("keeps everything inside <NotatoMask> and password fields private: no text, no label", () => {
        const [, email, name, password] = elementsUnder(root, false);
        expect(email).toMatchObject({ private: true });
        expect(email?.text).toBeUndefined();
        expect(email?.label).toBeUndefined();
        expect(name).toMatchObject({
            private: false,
            input: true,
            text: "Ada Lovelace",
            label: "Name",
        });
        expect(password).toMatchObject({ private: true });
        expect(password?.text).toBeUndefined();
    });

    it("leaves field values out with maskInputs, unless the field is marked private={false}; private wins over it", () => {
        const elements = elementsUnder(root, true);
        const [, , name, , search, inside] = elements;
        expect(name?.text).toBeUndefined();
        expect(name?.label).toBe("Name");
        expect(search).toMatchObject({ shown: true, private: false, text: "spuds" });
        expect(inside).toMatchObject({ private: true, shown: false });
        expect(inside?.text).toBeUndefined();
    });

    it("knows the native view around each one", () => {
        const elements = elementsUnder(root, false);
        expect(elements[0]?.parent).toBeUndefined();
        const wrapped = build([
            "RCTView",
            {},
            [["RCTView", { testID: "card" }, [["RCTText", { children: "x" }]]]],
        ]);
        const [card, text] = elementsUnder(wrapped, false);
        expect(text?.parent).toBe(card);
    });

    it("walks a very deep tree without running out of stack", () => {
        const top = build(["RCTView"]);
        let at = top;
        for (let i = 0; i < 20_000; i++) {
            const next = build(
                [i === 19_999 ? "RCTText" : "RCTView", i === 19_999 ? { children: "deep" } : {}],
                at
            );
            at.child = next;
            at = next;
        }
        const elements = elementsUnder(top, false, 50_000);
        expect(elements).toHaveLength(20_000);
        expect(elements.at(-1)?.text).toBe("deep");
    });
});

describe("maskedUnder", () => {
    const types = (root: Fiber) =>
        maskedUnder(root, true).map((m) => {
            const chain: string[] = [];
            for (let at: typeof m | undefined = m; at; at = at.parent)
                chain.push(String(at.fiber.type));
            return chain.join(" < ");
        });

    it("finds what screenshots cover", () => {
        // The email, the name field (maskInputs), the password, and the field inside a private mark; not the search.
        expect(types(root)).toEqual([
            "RCTText",
            "AndroidTextInput",
            "AndroidTextInput",
            "AndroidTextInput",
        ]);
        expect(maskedUnder(root, false)).toHaveLength(3);
    });

    it("keeps the Text a private Text sits in: the inner one has no place of its own to cover", () => {
        const nested = build([
            "RCTView",
            {},
            [
                [
                    "RCTText",
                    { children: "Signed in as " },
                    [[NotatoMask, {}, [["RCTVirtualText", { children: "ada@example.com" }]]]],
                ],
            ],
        ]);
        expect(types(nested)).toEqual(["RCTVirtualText < RCTText"]);
    });

    it("looks at every view, however many", () => {
        const many = build([
            "RCTView",
            {},
            [
                [
                    NotatoMask,
                    {},
                    Array.from({ length: 25_000 }, (): Spec => ["RCTText", { children: "x" }]),
                ],
            ],
        ]);
        expect(maskedUnder(many, false)).toHaveLength(25_000);
    });
});

describe("commitCount", () => {
    const global = globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown };
    afterEach(() => {
        delete global.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    });

    it("counts React's commits through its DevTools hook, passing each one on", () => {
        expect(commitCount()).toBeUndefined();
        const seen: unknown[] = [];
        const hook: { onCommitFiberRoot?: (...args: unknown[]) => unknown } = {
            onCommitFiberRoot: (...args) => seen.push(args),
        };
        global.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
        const start = commitCount() as number;
        hook.onCommitFiberRoot?.(1, "root");
        expect(commitCount()).toBe(start + 1);
        expect(seen).toEqual([[1, "root"]]);
        expect(commitCount()).toBe(start + 1);
        // Something else taking the hook's place is listened through too, and counts as a change.
        hook.onCommitFiberRoot = () => undefined;
        expect(commitCount()).toBe(start + 2);
    });
});
