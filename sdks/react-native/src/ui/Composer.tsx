import type { Intent, Severity } from "@notato/schema";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, type TextInput, View } from "react-native";
import { PEOPLE_ONLY } from "../annotation.ts";
import { Chips, Field, FlagToggle, HeaderButton, Icon } from "./parts.tsx";
import { usePalette } from "./theme.ts";

const INTENTS: Array<[Intent, string]> = [
    ["fix", "Fix"],
    ["change", "Change"],
    ["question", "Question"],
    ["approve", "Approve"],
];
const SEVERITIES: Array<[Severity, string]> = [
    ["blocker", "Blocker"],
    ["major", "Major"],
    ["minor", "Minor"],
    ["nit", "Nit"],
];

export interface Draft {
    comment: string;
    intent?: Intent;
    severity?: Severity;
    peopleOnly: boolean;
}

/** The note being written: a floating card, away from what it is about. */
export function Composer(props: {
    title: string;
    subtitle?: string;
    screenshotsOff: boolean;
    sending: boolean;
    error?: string;
    canParent: boolean;
    onParent(): void;
    onCancel(): void;
    onSend(draft: Draft): void;
}) {
    const p = usePalette();
    const [comment, setComment] = useState("");
    const [intent, setIntent] = useState<Intent>();
    const [severity, setSeverity] = useState<Severity>();
    const [peopleOnly, setPeopleOnly] = useState(false);
    const input = useRef<TextInput>(null);
    // autoFocus is unreliable while the card animates in: focus once it is laid out.
    useEffect(() => {
        const t = setTimeout(() => input.current?.focus(), 250);
        return () => clearTimeout(t);
    }, []);
    const ready = comment.trim().length > 0 && !props.sending;
    return (
        <View
            style={{
                width: "100%",
                maxWidth: 480,
                alignSelf: "center",
                borderRadius: 28,
                paddingTop: 16,
                paddingHorizontal: 18,
                paddingBottom: 18,
                gap: 12,
                backgroundColor: p.background,
                shadowColor: "#000",
                shadowOpacity: 0.25,
                shadowRadius: 20,
                shadowOffset: { width: 0, height: 6 },
                elevation: 14,
            }}
        >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View style={{ flex: 1, gap: 1 }}>
                    <Text
                        style={{ fontSize: 17, fontWeight: "600", color: p.text }}
                        numberOfLines={1}
                    >
                        {props.title}
                    </Text>
                    {props.subtitle ? (
                        <Text style={{ fontSize: 12, color: p.muted }} numberOfLines={2}>
                            {props.subtitle}
                        </Text>
                    ) : null}
                </View>
                {props.canParent ? (
                    <Pressable
                        onPress={props.onParent}
                        accessibilityRole="button"
                        accessibilityHint="Select the view around this one"
                        style={({ pressed }) => ({
                            flexDirection: "row",
                            alignItems: "center",
                            gap: 4,
                            height: 30,
                            paddingHorizontal: 11,
                            borderRadius: 999,
                            backgroundColor: pressed ? p.line : p.soft,
                        })}
                    >
                        <Icon name="up" size={13} color={p.text} />
                        <Text style={{ fontSize: 13.5, fontWeight: "600", color: p.text }}>
                            Parent
                        </Text>
                    </Pressable>
                ) : null}
                <HeaderButton kind="close" label="Cancel" onPress={props.onCancel} />
            </View>
            <Field
                ref={input}
                multiline
                value={comment}
                onChangeText={setComment}
                placeholder="What should change?"
                style={{ minHeight: 76, maxHeight: 150, textAlignVertical: "top" }}
                accessibilityLabel="Note"
                testID="NotatoComment"
            />
            <Chips<Intent> options={INTENTS} value={intent} onChange={setIntent} />
            <Chips<Severity> options={SEVERITIES} value={severity} onChange={setSeverity} />
            <FlagToggle
                title={PEOPLE_ONLY.title}
                hint={PEOPLE_ONLY.hint}
                value={peopleOnly}
                onChange={setPeopleOnly}
                testID="NotatoPeopleOnly"
            />
            {props.error ? (
                <Text style={{ fontSize: 12.5, color: p.danger }}>{props.error}</Text>
            ) : null}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <Text style={{ flex: 1, fontSize: 12, color: p.muted }}>
                    {props.screenshotsOff
                        ? "No screenshot: they are turned off."
                        : "Tap another element to change what this note is about."}
                </Text>
                <Pressable
                    testID="NotatoSend"
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !ready }}
                    disabled={!ready}
                    onPress={() =>
                        props.onSend({ comment: comment.trim(), intent, severity, peopleOnly })
                    }
                    style={({ pressed }) => ({
                        paddingHorizontal: 14,
                        paddingVertical: 9,
                        borderRadius: 12,
                        backgroundColor: pressed ? p.accentPressed : p.accent,
                        opacity: ready ? 1 : 0.45,
                    })}
                >
                    <Text style={{ fontSize: 14, fontWeight: "700", color: "#fff" }}>
                        {props.sending ? "Sending…" : "Send"}
                    </Text>
                </Pressable>
            </View>
        </View>
    );
}
