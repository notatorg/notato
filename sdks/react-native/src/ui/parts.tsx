import { forwardRef, type ReactNode, useRef } from "react";
import {
    Animated,
    Image,
    PanResponder,
    Pressable,
    ScrollView,
    StyleSheet,
    Switch,
    Text,
    TextInput,
    type TextInputProps,
    View,
} from "react-native";
import { ICONS, type IconName, POTATO } from "./icons.ts";
import { type Palette, statusColor, usePalette } from "./theme.ts";

/** One of Notato's icons, tinted. */
export function Icon({ name, size = 20, color }: { name: IconName; size?: number; color: string }) {
    return (
        <Image
            source={{ uri: ICONS[name] }}
            style={{ width: size, height: size, tintColor: color }}
            accessibilityElementsHidden
            importantForAccessibility="no"
        />
    );
}

/** The Notato potato, tilted as on the web toolbar. */
export function Potato({ size }: { size: number }) {
    return (
        <Image
            source={{ uri: POTATO }}
            style={{ width: size, height: size, transform: [{ rotate: "-8deg" }] }}
            accessibilityElementsHidden
            importantForAccessibility="no"
        />
    );
}

/**
 * A floating bottom sheet, 8 points off the screen's edges, with a grabber, over a scrim. Pulled down far enough by
 * its grabber, or with the scrim tapped, it closes.
 */
export function BottomSheet({
    close,
    children,
    maxHeight,
    top = 0,
}: {
    close(): void;
    children: ReactNode;
    maxHeight: number;
    /** Room kept clear at the top (the status bar), whatever the keyboard leaves. */
    top?: number;
}) {
    const p = usePalette();
    const pull = useRef(new Animated.Value(0)).current;
    const pan = useRef(
        PanResponder.create({
            onMoveShouldSetPanResponder: (_, g) => g.dy > 8 && Math.abs(g.dy) > Math.abs(g.dx),
            onPanResponderMove: (_, g) => pull.setValue(Math.max(0, g.dy)),
            onPanResponderRelease: (_, g) => {
                if (g.dy > 90 || g.vy > 1.2) close();
                else Animated.spring(pull, { toValue: 0, useNativeDriver: true }).start();
            },
            onPanResponderTerminate: () =>
                Animated.spring(pull, { toValue: 0, useNativeDriver: true }).start(),
        })
    ).current;
    return (
        // In the flow, not absolute, so a KeyboardAvoidingView around it lifts it over the keyboard.
        <View style={styles.sheetRoot} pointerEvents="box-none">
            <Pressable
                style={[StyleSheet.absoluteFill, { backgroundColor: p.scrim }]}
                onPress={close}
                accessibilityLabel="Close"
            />
            <View style={[styles.sheetWrap, { paddingTop: top }]} pointerEvents="box-none">
                <Animated.View
                    style={[
                        styles.sheet,
                        {
                            backgroundColor: p.background,
                            maxHeight,
                            transform: [{ translateY: pull }],
                        },
                    ]}
                >
                    <View {...pan.panHandlers} style={styles.grabberArea}>
                        <View style={[styles.grabber, { backgroundColor: p.line }]} />
                    </View>
                    {children}
                </Animated.View>
            </View>
        </View>
    );
}

/** A sheet's first line: the potato, a back button or the note's pin; the title and a line under it; then a pill or close. */
export function SheetHeader(props: {
    title: string;
    subtitle?: string;
    leading: ReactNode;
    trailing?: ReactNode;
}) {
    const p = usePalette();
    return (
        <View style={styles.header}>
            {props.leading}
            <View style={{ flex: 1, gap: 2 }}>
                <Text
                    style={[styles.title, { color: p.text }]}
                    numberOfLines={1}
                    accessibilityRole="header"
                >
                    {props.title}
                </Text>
                {props.subtitle ? (
                    <Text style={{ fontSize: 12, color: p.muted }} numberOfLines={1}>
                        {props.subtitle}
                    </Text>
                ) : null}
            </View>
            {props.trailing}
        </View>
    );
}

/** Back to the sheet this one was opened from (38 points), or close (30). Soft circles. */
export function HeaderButton({
    kind,
    onPress,
    label,
}: {
    kind: "back" | "close";
    onPress(): void;
    label?: string;
}) {
    const p = usePalette();
    const size = kind === "back" ? 38 : 30;
    return (
        <Pressable
            onPress={onPress}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={label ?? (kind === "back" ? "Back" : "Close")}
            style={({ pressed }) => [
                styles.round,
                { width: size, height: size, backgroundColor: pressed ? p.line : p.soft },
            ]}
        >
            <Icon
                name={kind === "back" ? "chevronLeft" : "close"}
                size={kind === "back" ? 18 : 14}
                color={kind === "back" ? p.text : p.muted}
            />
        </Pressable>
    );
}

export type ButtonKind = "plain" | "primary" | "danger" | "destructive";

/** A sheet's buttons: as wide as they can be, side by side. */
export function SheetButton(props: {
    title: string;
    kind?: ButtonKind;
    onPress(): void;
    disabled?: boolean;
    testID?: string;
}) {
    const p = usePalette();
    const kind = props.kind ?? "plain";
    return (
        <Pressable
            onPress={props.onPress}
            disabled={props.disabled}
            testID={props.testID}
            accessibilityRole="button"
            accessibilityState={{ disabled: !!props.disabled }}
            style={({ pressed }) => [
                styles.button,
                {
                    backgroundColor:
                        kind === "primary"
                            ? pressed
                                ? p.accentPressed
                                : p.accent
                            : kind === "destructive"
                              ? p.danger
                              : pressed
                                ? p.line
                                : p.soft,
                    opacity: props.disabled ? 0.45 : kind === "destructive" && pressed ? 0.85 : 1,
                },
            ]}
        >
            <Text
                numberOfLines={1}
                style={{
                    fontSize: 15,
                    fontWeight: kind === "plain" || kind === "danger" ? "600" : "700",
                    color: kind === "plain" ? p.text : kind === "danger" ? p.danger : "#fff",
                }}
            >
                {props.title}
            </Text>
        </Pressable>
    );
}

export type TileIcon = { icon: IconName } | { pin: number; status: string; pending: boolean };

/** A sheet's 40-point tile: an icon, or a note's pin as the screen shows it. */
export function SheetTile({
    tile,
    style = "plain",
    size = 40,
}: {
    tile: TileIcon;
    style?: "plain" | "primary" | "danger";
    size?: number;
}) {
    const p = usePalette();
    return (
        <View
            style={[
                styles.tile,
                {
                    width: size,
                    height: size,
                    backgroundColor: style === "primary" ? p.accent : p.soft,
                },
            ]}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
        >
            {"icon" in tile ? (
                <Icon
                    name={tile.icon}
                    size={20}
                    color={style === "primary" ? "#fff" : style === "danger" ? p.danger : p.text}
                />
            ) : (
                <PinDot number={tile.pin} status={tile.status} pending={tile.pending} />
            )}
        </View>
    );
}

/** A note's pin: its number on its status's colour, ringed amber while it is not sent. */
export function PinDot({
    number,
    status,
    pending,
    size = 24,
}: {
    number: number;
    status: string;
    pending: boolean;
    size?: number;
}) {
    return (
        <View
            style={[
                styles.pin,
                {
                    width: size,
                    height: size,
                    borderRadius: size / 2,
                    backgroundColor: statusColor(status),
                    borderColor: pending ? "#e9b44c" : "#fff",
                },
            ]}
        >
            <Text style={styles.pinText}>{number > 0 ? String(number) : ""}</Text>
        </View>
    );
}

/** A row of a sheet, as the menu's: a tile, a title with a line under it, and a chevron when it opens another sheet. */
export function MenuRow(props: {
    tile: TileIcon;
    title: string;
    detail: string;
    style?: "plain" | "primary" | "danger";
    titleLines?: number;
    opens?: boolean;
    separated?: boolean;
    onPress(): void;
    testID?: string;
}) {
    const p = usePalette();
    return (
        <View style={props.separated ? { paddingTop: 9 } : undefined}>
            {props.separated ? <View style={[styles.rule, { backgroundColor: p.line }]} /> : null}
            <Pressable
                onPress={props.onPress}
                testID={props.testID}
                accessibilityRole="button"
                accessibilityLabel={`${props.title}. ${props.detail}`}
                style={({ pressed }) => [styles.row, pressed && { backgroundColor: p.soft }]}
            >
                <SheetTile tile={props.tile} style={props.style} />
                <View style={{ flex: 1, gap: 2 }}>
                    <Text
                        numberOfLines={props.titleLines ?? 1}
                        style={{
                            fontSize: 15.5,
                            fontWeight: "600",
                            color: props.style === "danger" ? p.danger : p.text,
                        }}
                    >
                        {props.title}
                    </Text>
                    <Text numberOfLines={1} style={{ fontSize: 12.5, color: p.muted }}>
                        {props.detail}
                    </Text>
                </View>
                {props.opens ? <Text style={{ fontSize: 18, color: p.muted }}>›</Text> : null}
            </Pressable>
        </View>
    );
}

/** A switch with a line under its name saying what it does. */
export function FlagToggle(props: {
    title: string;
    hint: string;
    value: boolean;
    onChange(value: boolean): void;
    disabled?: boolean;
    testID?: string;
    tile?: TileIcon;
}) {
    const p = usePalette();
    return (
        <Pressable
            onPress={() => !props.disabled && props.onChange(!props.value)}
            accessibilityRole="switch"
            accessibilityState={{ checked: props.value, disabled: !!props.disabled }}
            accessibilityLabel={props.title}
            accessibilityHint={props.hint}
            testID={props.testID}
            style={[styles.flag, props.tile ? styles.flagRow : null]}
        >
            {props.tile ? <SheetTile tile={props.tile} /> : null}
            <View style={{ flex: 1, gap: 2 }}>
                <Text
                    style={{ fontSize: props.tile ? 15.5 : 15, fontWeight: "600", color: p.text }}
                >
                    {props.title}
                </Text>
                <Text style={{ fontSize: 12.5, color: p.muted }}>{props.hint}</Text>
            </View>
            {/* The row takes the tap: a switch that took it too would flip it back. */}
            <View pointerEvents="none">
                <Switch
                    value={props.value}
                    disabled={props.disabled}
                    trackColor={{ true: p.accent, false: p.line }}
                    importantForAccessibility="no"
                    accessibilityElementsHidden
                />
            </View>
        </Pressable>
    );
}

/** A label over a text field. */
export function FieldLabel({ text }: { text: string }) {
    const p = usePalette();
    return (
        <Text style={{ fontSize: 12.5, fontWeight: "600", color: p.muted, paddingHorizontal: 4 }}>
            {text}
        </Text>
    );
}

/** A text field's look in a sheet or card. */
export const Field = forwardRef<TextInput, TextInputProps>(function Field(props, ref) {
    const p = usePalette();
    return (
        <TextInput
            ref={ref}
            placeholderTextColor={p.muted}
            {...props}
            style={[styles.field, { backgroundColor: p.soft, color: p.text }, props.style]}
        />
    );
});

/** What does not fit scrolls; what fits is as tall as it is. */
export function SheetScroll({ children }: { children: ReactNode }) {
    return (
        <ScrollView
            style={{ flexGrow: 0, flexShrink: 1 }}
            keyboardShouldPersistTaps="handled"
            bounces={false}
        >
            {children}
        </ScrollView>
    );
}

/** Chips that pick one value, or none. */
export function Chips<T extends string>(props: {
    options: Array<[T, string]>;
    value: T | undefined;
    onChange(value: T | undefined): void;
}) {
    const p = usePalette();
    return (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
        >
            <View style={{ flexDirection: "row", gap: 6 }}>
                {props.options.map(([value, label]) => {
                    const on = props.value === value;
                    return (
                        <Pressable
                            key={value}
                            accessibilityRole="button"
                            accessibilityState={{ selected: on }}
                            onPress={() => props.onChange(on ? undefined : value)}
                            style={[
                                styles.chip,
                                {
                                    borderColor: on ? p.accent : p.line,
                                    backgroundColor: on ? p.accent : "transparent",
                                },
                            ]}
                        >
                            <Text
                                style={{
                                    fontSize: 14,
                                    fontWeight: "600",
                                    color: on ? "#fff" : p.text,
                                }}
                            >
                                {label}
                            </Text>
                        </Pressable>
                    );
                })}
            </View>
        </ScrollView>
    );
}

/** A status, intent or severity on a note's card. */
export function Badge({ text, color }: { text: string; color: string }) {
    return (
        <View style={[styles.badge, { backgroundColor: `${color}24` }]}>
            <Text style={{ fontSize: 11, fontWeight: "700", color }}>
                {text.replace(/_/g, " ")}
            </Text>
        </View>
    );
}

/** As the web toolbar draws it: no fill, a hairline, small muted capitals. */
export function PeopleOnlyBadge({ palette }: { palette: Palette }) {
    return (
        <View
            style={[styles.badge, { borderWidth: 1, borderColor: palette.line }]}
            testID="NotatoPeopleOnlyBadge"
        >
            <Text
                style={{
                    fontSize: 10.5,
                    fontWeight: "700",
                    letterSpacing: 0.4,
                    color: palette.muted,
                }}
            >
                PEOPLE ONLY
            </Text>
        </View>
    );
}

export const styles = StyleSheet.create({
    sheetRoot: { flex: 1 },
    sheetWrap: {
        flex: 1,
        justifyContent: "flex-end",
        alignItems: "center",
        paddingHorizontal: 8,
        paddingBottom: 8,
    },
    sheet: {
        flexShrink: 1,
        width: "100%",
        maxWidth: 480,
        borderRadius: 34,
        paddingHorizontal: 18,
        paddingBottom: 24,
        gap: 10,
        shadowColor: "#000",
        shadowOpacity: 0.25,
        shadowRadius: 20,
        shadowOffset: { width: 0, height: -6 },
        elevation: 16,
    },
    grabberArea: { alignItems: "center", paddingTop: 10, paddingBottom: 2 },
    grabber: { width: 36, height: 5, borderRadius: 3 },
    header: {
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingTop: 2,
        paddingLeft: 4,
        paddingRight: 2,
        paddingBottom: 6,
    },
    title: { fontSize: 20, fontWeight: "700", letterSpacing: -0.4 },
    round: { borderRadius: 999, alignItems: "center", justifyContent: "center" },
    button: {
        flex: 1,
        minHeight: 50,
        borderRadius: 14,
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: 14,
    },
    tile: { borderRadius: 12, alignItems: "center", justifyContent: "center" },
    pin: { alignItems: "center", justifyContent: "center", borderWidth: 2 },
    pinText: { color: "#fff", fontSize: 12, fontWeight: "800" },
    row: {
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        minHeight: 58,
        paddingVertical: 7,
        paddingHorizontal: 4,
        borderRadius: 14,
    },
    rule: { position: "absolute", top: 4, left: 0, right: 0, height: StyleSheet.hairlineWidth * 2 },
    flag: { flexDirection: "row", alignItems: "center", gap: 12 },
    flagRow: { gap: 14, minHeight: 58, paddingVertical: 7, paddingHorizontal: 4 },
    field: { fontSize: 15, paddingHorizontal: 12, paddingVertical: 11, borderRadius: 12 },
    chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 6 },
    badge: { borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2 },
});
