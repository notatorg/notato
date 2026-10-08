import type { ElementIdentity } from "@notato/schema";
import { isLibraryFile, type SourceFrame } from "./stack.ts";

/** Where a view is on screen, in points. */
export interface Frame {
    left: number;
    top: number;
    width: number;
    height: number;
}

/** What React Native's inspector reports for the view under a point (see inspect.ts). */
export interface Inspected {
    /** The components that rendered the view, outermost first, ending with the native view itself (`RCTText`). */
    names: string[];
    /** The native view's props: `testID`, `accessibilityLabel`, `children` (a Text's own text)… */
    props: Record<string, unknown>;
    frame: Frame;
    /** React's component stack for the view, innermost first, with bundle locations. */
    componentStack: string;
}

/** The names native views go by, and what people call them. */
const NATIVE: Record<string, string> = {
    RCTView: "View",
    RCTText: "Text",
    RCTVirtualText: "Text",
    RCTRawText: "Text",
    RCTImageView: "Image",
    RCTScrollView: "ScrollView",
    AndroidHorizontalScrollView: "ScrollView",
    RCTScrollContentView: "View",
    RCTSinglelineTextInputView: "TextInput",
    RCTMultilineTextInputView: "TextInput",
    AndroidTextInput: "TextInput",
    RCTSwitch: "Switch",
    AndroidSwitch: "Switch",
    RCTSafeAreaView: "SafeAreaView",
    RCTModalHostView: "Modal",
    ActivityIndicatorView: "ActivityIndicator",
    AndroidProgressBar: "ActivityIndicator",
};

/**
 * Components React Native, React, Expo and React Navigation put around yours, and wrappers named after what they wrap
 * (`withDevTools(App)`, `ForwardRef(Button)`): real, but never what anyone means by "the component". A component's
 * stack frame cannot tell them apart instead: it names the file that created the element, and a screen of yours is
 * created by the navigation library.
 */
const BUILT_IN =
    /^(?:View|Text|Image|ImageBackground|ScrollView|FlatList|SectionList|VirtualizedList|VirtualizedSectionList|CellRenderer|Pressable|TouchableOpacity|TouchableHighlight|TouchableWithoutFeedback|TouchableNativeFeedback|TextInput|Switch|Button|SafeAreaView|KeyboardAvoidingView|Modal|StatusBar|ActivityIndicator|RefreshControl|AppContainer|RootComponent|LogBoxStateSubscription|LogBox|DebuggingOverlay|ReactDevToolsOverlay|Inspector|Fragment|Suspense|StrictMode|Profiler|ErrorBoundary|ExpoRoot|Unknown|Anonymous|withDevTools|Notato|NotatoRoot|NavigationContainer|BaseNavigationContainer|SceneView|Screen|ScreenContainer|ScreenStack|NativeStackView|NativeStackNavigator|StackView|Header|HeaderContainer|Background|Freeze|DelayedFreeze|Suspender|GestureHandlerRootView|SafeAreaProvider|SafeAreaFrameContext|Slot|Stack|Tabs|Navigator)$|^(?:RCT|Android|Animated|Virtualized|RNS|RNC|RNGestureHandler)|(?:Provider|Consumer|Context|Wrapper|Container|Boundary)$|\(/;

/** What people call a native view: `RCTText` is a `Text`. */
const nativeName = (name: string) => NATIVE[name] ?? name;

/** Whether a native view is a text field. */
export const isTextInput = (native: string) => /TextInput/.test(native);

/** Text the view shows: a Text's own children, as far as they are strings, trimmed to what the schema keeps. */
export function textOf(children: unknown): string | undefined {
    const parts: string[] = [];
    const walk = (value: unknown) => {
        if (typeof value === "string" || typeof value === "number") parts.push(String(value));
        else if (Array.isArray(value)) for (const v of value) walk(v);
    };
    walk(children);
    const text = parts.join("").replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 200) : undefined;
}

const str = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;

/**
 * A test id a selector can name (`#pay`): at most 100 of the characters `#` reads. Anything else (a sentence, a long
 * value) is not taken as one: it would make a selector nothing can read.
 */
const testIdOf = (value: unknown) => {
    const id = str(value);
    return id && id.length <= 100 && /^[\w.@/-]+$/.test(id) ? id : undefined;
};

/** A label inside a selector's quotes: its backslashes and quotes escaped, so it reads back as it was. */
const quoted = (label: string) => `"${label.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Where the view is written (`/…/src/screens/Product.tsx:12:7`): the stack's innermost frame in the app's own code,
 * the line that created the element, when Metro could map the stack.
 */
function sourceOf(sources: SourceFrame[]): { location: string } | undefined {
    const own = sources.find((s) => !isLibraryFile(s.file));
    return own ? { location: `${own.file}:${own.line}:${own.col}` } : undefined;
}

/**
 * The view's identity in the shape every Notato SDK sends: a readable selector, its test id, label and role, its text,
 * and its component, the innermost one you wrote, with the components around it and, when Metro maps the stack,
 * the file and line where the view is written.
 */
export function identityOf(
    inspected: Inspected,
    sources: SourceFrame[] = [],
    privacy: { private?: boolean; maskValue?: boolean } = {}
): ElementIdentity {
    const names = inspected.names.filter(Boolean);
    const native = names[names.length - 1] ?? "View";
    const tag = nativeName(native);
    const props = inspected.props ?? {};
    // Yours: the components that rendered the view, less React Native's, React's and the libraries' own.
    const components = names.slice(0, -1).filter((n) => !BUILT_IN.test(n));
    const path = components.filter((n, i) => components[i - 1] !== n).slice(-8);
    const source = sourceOf(sources);
    const name = path[path.length - 1];

    // Something private says nothing of what it shows: not its text, not its label, not its ids (an app may make them
    // of what it shows: `testID={email}`). A field says its hint either way.
    const testId = privacy.private ? undefined : testIdOf(props.testID);
    const nativeId = privacy.private ? undefined : str(props.nativeID);
    const input = isTextInput(native);
    const label = privacy.private
        ? undefined
        : (str(props.accessibilityLabel) ??
          str(props["aria-label"]) ??
          (input ? str(props.placeholder) : undefined));
    const role = str(props.accessibilityRole) ?? str(props.role) ?? (input ? "textbox" : undefined);
    const text =
        privacy.private || (input && privacy.maskValue)
            ? undefined
            : input
              ? textOf(props.value ?? props.text ?? props.defaultValue)
              : textOf(props.children);
    const selector = [
        ...(name ? [name] : []),
        `${tag}${testId ? `#${testId}` : ""}${label ? `[label=${quoted(label)}]` : ""}`,
    ].join(" > ");

    return {
        selector,
        tag,
        ...(testId ? { testId } : {}),
        ...(role ? { role } : {}),
        ...(label ? { name: label } : {}),
        ...(text ? { text } : {}),
        ...(name
            ? {
                  component: {
                      name,
                      ...(source ? { source: source.location } : {}),
                      ...(path.length >= 2 ? { path } : {}),
                  },
              }
            : {}),
        ...(path.length ? { ancestors: path } : {}),
        ...(nativeId ? { platformId: nativeId } : {}),
    };
}
