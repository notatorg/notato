import type { Annotation } from "@notato/schema";
import { useEffect, useMemo, useState } from "react";
import { FlatList, Platform, Pressable, Text, View } from "react-native";
import { PEOPLE_ONLY } from "../annotation.ts";
import type { NotatoController, NotatoState, NoteRecord } from "../controller.ts";
import {
    Badge,
    Field,
    FieldLabel,
    FlagToggle,
    HeaderButton,
    MenuRow,
    PeopleOnlyBadge,
    Potato,
    SheetButton,
    SheetHeader,
    SheetScroll,
    SheetTile,
} from "./parts.tsx";
import { ago, statusColor, usePalette } from "./theme.ts";

/** What the bottom sheet shows: the menu, or what it opens. */
export type Sheet =
    | { kind: "menu" }
    | { kind: "list" }
    | { kind: "settings" }
    | { kind: "clear" }
    | { kind: "pin"; id: string; fromList: boolean };

const device =
    Platform.OS === "ios" ? ((Platform as { isPad?: boolean }).isPad ? "iPad" : "phone") : "device";
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The toolbar's ⋯: who and how, the server's state, and everything else Notato does. */
export function MenuSheet(props: {
    notato: NotatoController;
    state: NotatoState;
    /** The notes on this screen. */
    here: number;
    /** Those of them with a pin here: the notes made in a React Native app. */
    pins: number;
    open(sheet: Sheet | null): void;
    annotate(): void;
    packageAndShare(): void;
}) {
    const { notato, state } = props;
    const p = usePalette();
    const host = notato.serverHost;
    const pending = state.pendingCount;
    const subline = `${capital(state.mode)} mode · ${host ?? `notes stay on this ${device}`}`;
    const pill = !notato.hasServer
        ? undefined
        : state.connection === "connected"
          ? { label: "Connected", color: p.connected }
          : state.connection === "connecting"
            ? { label: "Connecting…", color: statusColor("acknowledged") }
            : state.connection === "offline"
              ? { label: "Offline", color: p.offline }
              : state.connection === "refused"
                ? { label: "Refused", color: p.offline }
                : undefined;
    const problem = !notato.hasServer
        ? undefined
        : state.connection === "offline"
          ? {
                title: "Can't reach the server",
                detail: `${host ?? "The server"} isn't answering. Notes stay on this ${device} and send when it's back.`,
            }
          : state.connection === "refused"
            ? {
                  title: "The server refused this app",
                  detail:
                      state.connectionDetail ??
                      `${host ?? "The server"} did not accept this app's token or project.`,
              }
            : undefined;
    const run = (action: () => void) => {
        props.open(null);
        action();
    };
    return (
        <>
            <SheetHeader
                title="Notato"
                subtitle={subline}
                leading={<Potato size={38} />}
                trailing={
                    pill ? (
                        <View
                            testID="NotatoConnection"
                            accessibilityLabel={pill.label}
                            style={{
                                flexDirection: "row",
                                alignItems: "center",
                                gap: 6,
                                paddingHorizontal: 10,
                                paddingVertical: 4,
                                borderRadius: 999,
                                backgroundColor: `${pill.color}24`,
                            }}
                        >
                            <View
                                style={{
                                    width: 7,
                                    height: 7,
                                    borderRadius: 4,
                                    backgroundColor: pill.color,
                                }}
                            />
                            <Text style={{ fontSize: 12, fontWeight: "700", color: pill.color }}>
                                {pill.label}
                            </Text>
                        </View>
                    ) : undefined
                }
            />
            {problem ? (
                <View
                    style={{
                        flexDirection: "row",
                        alignItems: "flex-start",
                        gap: 10,
                        paddingHorizontal: 12,
                        paddingVertical: 11,
                        borderRadius: 16,
                        backgroundColor: `${p.offline}1f`,
                    }}
                >
                    <View style={{ flex: 1, gap: 2 }}>
                        <Text style={{ fontSize: 13, fontWeight: "700", color: p.text }}>
                            {problem.title}
                        </Text>
                        <Text style={{ fontSize: 13, color: p.muted, lineHeight: 17 }}>
                            {problem.detail}
                        </Text>
                    </View>
                    <Pressable
                        testID="NotatoRetry"
                        accessibilityRole="button"
                        onPress={() => notato.retryConnection()}
                        style={{
                            paddingHorizontal: 12,
                            paddingVertical: 7,
                            borderRadius: 10,
                            backgroundColor: p.text,
                        }}
                    >
                        <Text style={{ fontSize: 13, fontWeight: "700", color: p.background }}>
                            Retry
                        </Text>
                    </Pressable>
                </View>
            ) : null}
            <SheetScroll>
                <MenuRow
                    tile={{ icon: "crosshair" }}
                    title="Annotate"
                    detail="Tap an element, write a note"
                    style="primary"
                    onPress={() => run(props.annotate)}
                />
                <MenuRow
                    tile={{ icon: state.pinsVisible ? "eyeOff" : "eye" }}
                    title={state.pinsVisible ? "Hide pins" : "Show pins"}
                    detail={
                        props.pins === 0
                            ? "No pins on this screen"
                            : props.pins === 1
                              ? "1 pin on this screen"
                              : `${props.pins} pins on this screen`
                    }
                    onPress={() => run(() => notato.togglePins())}
                />
                <MenuRow
                    tile={{ icon: "list" }}
                    title="Notes"
                    detail={`${props.here} on this screen · ${state.notes.length} in all`}
                    opens
                    onPress={() => props.open({ kind: "list" })}
                />
                {state.mode === "test" && pending > 0 ? (
                    <>
                        <MenuRow
                            tile={{ icon: "package" }}
                            title="Package and share"
                            detail="Zip with screenshots, share anywhere"
                            opens
                            separated
                            onPress={() => run(props.packageAndShare)}
                        />
                        <MenuRow
                            tile={{ icon: "trash" }}
                            title="Clear notes"
                            detail={
                                pending === 1
                                    ? "Removes the note on this device"
                                    : `Removes all ${pending} from this device`
                            }
                            style="danger"
                            onPress={() => props.open({ kind: "clear" })}
                        />
                    </>
                ) : null}
                <MenuRow
                    tile={{ icon: "sliders" }}
                    title="Settings"
                    detail="Your name, screenshots, server"
                    opens
                    separated
                    onPress={() => props.open({ kind: "settings" })}
                />
                <MenuRow
                    tile={{ icon: "minimize" }}
                    title="Hide toolbar"
                    detail="The developer menu brings it back"
                    separated
                    onPress={() => run(() => notato.hideToolbar())}
                />
                <MenuRow
                    tile={{ icon: "power" }}
                    title="Turn Notato off"
                    detail="Until the app turns it on again"
                    style="danger"
                    onPress={() => run(() => notato.disable())}
                />
            </SheetScroll>
        </>
    );
}

/** Every note on this screen, newest first, each opening its card: a list that draws only the rows in sight. */
export function NotesSheet(props: {
    state: NotatoState;
    list: ReadonlyArray<{ number: number; record: NoteRecord }>;
    open(sheet: Sheet | null): void;
    annotate(): void;
}) {
    const p = usePalette();
    const { list, state } = props;
    const newest = useMemo(() => [...list].reverse(), [list]);
    const others = state.notes.length - list.length;
    return (
        <>
            <SheetHeader
                title="Notes"
                subtitle={`${list.length} on this screen · ${state.notes.length} in all`}
                leading={<HeaderButton kind="back" onPress={() => props.open({ kind: "menu" })} />}
                trailing={<HeaderButton kind="close" onPress={() => props.open(null)} />}
            />
            <FlatList
                style={{ flexGrow: 0, flexShrink: 1 }}
                keyboardShouldPersistTaps="handled"
                bounces={false}
                data={newest}
                keyExtractor={(item) => item.record.annotation.id}
                initialNumToRender={12}
                windowSize={7}
                ListEmptyComponent={
                    <MenuRow
                        tile={{ icon: "crosshair" }}
                        title="Annotate"
                        detail="No notes on this screen yet"
                        style="primary"
                        onPress={() => {
                            props.open(null);
                            props.annotate();
                        }}
                    />
                }
                renderItem={({ item: { number, record } }) => {
                    const a = record.annotation;
                    return (
                        <MenuRow
                            tile={{ pin: number, status: a.status, pending: record.pending }}
                            title={a.comment}
                            titleLines={2}
                            detail={[
                                a.status.replace(/_/g, " "),
                                a.peopleOnly ? PEOPLE_ONLY.title : undefined,
                                ago(a.createdAt),
                            ]
                                .filter(Boolean)
                                .join(" · ")}
                            opens
                            onPress={() => props.open({ kind: "pin", id: a.id, fromList: true })}
                        />
                    );
                }}
                ListFooterComponent={
                    others > 0 ? (
                        <View style={{ paddingTop: 14, paddingBottom: 2, paddingHorizontal: 4 }}>
                            <View
                                style={{
                                    position: "absolute",
                                    top: 4,
                                    left: 0,
                                    right: 0,
                                    height: 1,
                                    backgroundColor: p.line,
                                }}
                            />
                            <Text style={{ fontSize: 12.5, color: p.muted }}>
                                {others === 1
                                    ? "1 more on another screen."
                                    : `${others} more on other screens.`}
                            </Text>
                        </View>
                    ) : null
                }
            />
        </>
    );
}

/** Your name, screenshots and the server; Reset goes back to the app's configuration. */
export function SettingsSheet(props: {
    notato: NotatoController;
    state: NotatoState;
    open(sheet: Sheet | null): void;
    toast(message: string): void;
}) {
    const { notato, state } = props;
    const p = usePalette();
    const [name, setName] = useState(state.author ?? "");
    const [server, setServer] = useState("");
    const [screenshots, setScreenshots] = useState(state.screenshots);
    useEffect(() => {
        setServer(notato.server !== notato.configuration?.server ? (notato.server ?? "") : "");
    }, [notato]);
    return (
        <>
            <SheetHeader
                title="Settings"
                subtitle={`Project ${state.project ?? ""} · ${capital(state.mode)} mode`}
                leading={<HeaderButton kind="back" onPress={() => props.open({ kind: "menu" })} />}
                trailing={<HeaderButton kind="close" onPress={() => props.open(null)} />}
            />
            <SheetScroll>
                <View style={{ gap: 14 }}>
                    <View style={{ gap: 6 }}>
                        <FieldLabel text="Your name" />
                        <Field
                            value={name}
                            onChangeText={setName}
                            placeholder="Your name, on your notes"
                            autoCapitalize="words"
                            testID="NotatoName"
                        />
                    </View>
                    <View style={{ gap: 6 }}>
                        <FieldLabel text="Server" />
                        <Field
                            value={server}
                            onChangeText={setServer}
                            placeholder={
                                notato.configuration?.server ??
                                "No server: notes stay on this device"
                            }
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="url"
                            testID="NotatoServer"
                        />
                        <Text style={{ fontSize: 12, color: p.muted, paddingHorizontal: 4 }}>
                            {notato.describeConnection()}
                        </Text>
                    </View>
                    <FlagToggle
                        tile={{ icon: "camera" }}
                        title="Screenshots"
                        hint={
                            state.serverScreenshots
                                ? "Each note takes one of the screen"
                                : "The server has them turned off"
                        }
                        value={screenshots}
                        onChange={setScreenshots}
                    />
                </View>
            </SheetScroll>
            <View style={{ flexDirection: "row", gap: 10 }}>
                <SheetButton
                    title="Reset"
                    onPress={() => {
                        notato.resetRuntimeState();
                        props.open(null);
                    }}
                />
                <SheetButton
                    title="Save"
                    kind="primary"
                    testID="NotatoSaveSettings"
                    onPress={() => {
                        const message = notato.saveSettings({ name, screenshots, server });
                        props.open(null);
                        if (message) props.toast(message);
                    }}
                />
            </View>
        </>
    );
}

export function ClearSheet(props: {
    notato: NotatoController;
    state: NotatoState;
    open(sheet: Sheet | null): void;
    toast(message: string): void;
}) {
    const p = usePalette();
    const n = props.state.pendingCount;
    return (
        <>
            <SheetHeader
                title="Clear notes?"
                subtitle={
                    n === 1
                        ? "Removes the note on this device"
                        : `Removes all ${n} from this device`
                }
                leading={<HeaderButton kind="back" onPress={() => props.open({ kind: "menu" })} />}
                trailing={<HeaderButton kind="close" onPress={() => props.open(null)} />}
            />
            <Text style={{ fontSize: 13.5, color: p.muted, paddingHorizontal: 4 }}>
                A package you already shared keeps them.
            </Text>
            <View style={{ flexDirection: "row", gap: 10, paddingTop: 4 }}>
                <SheetButton title="Keep them" onPress={() => props.open(null)} />
                <SheetButton
                    title="Clear"
                    kind="destructive"
                    onPress={() => {
                        props.notato.clearLocal();
                        props.open(null);
                        props.toast("Notes cleared");
                    }}
                />
            </View>
        </>
    );
}

/** One entry in a note's thread. A recorded change is a quiet line; an aside is marked, and drawn outlined. */
function ThreadEntry({ reply }: { reply: Annotation["thread"][number] }) {
    const p = usePalette();
    const name = reply.author.name ?? (reply.author.kind === "agent" ? "Agent" : "You");
    if (reply.automatic) {
        return (
            <Text
                style={{ fontSize: 12, color: p.muted, paddingHorizontal: 10, paddingVertical: 2 }}
            >
                <Text style={{ fontWeight: "700" }}>{name}</Text> · {reply.body}
            </Text>
        );
    }
    const aside = reply.aside === true;
    return (
        <View
            style={{
                paddingHorizontal: 10,
                paddingVertical: 7,
                borderRadius: 12,
                gap: 2,
                backgroundColor: aside ? "transparent" : p.soft,
                borderWidth: aside ? 1 : 0,
                borderStyle: "dashed",
                borderColor: p.line,
            }}
            accessibilityLabel={
                aside ? `Aside, kept from the agent. ${name}: ${reply.body}` : undefined
            }
        >
            {aside ? (
                <Text style={{ fontSize: 11, fontWeight: "700", color: p.muted }}>
                    {PEOPLE_ONLY.aside}
                </Text>
            ) : null}
            <Text style={{ fontSize: 14.5, color: aside ? p.muted : p.text }}>
                <Text style={{ fontWeight: "700" }}>{name}: </Text>
                {reply.body}
            </Text>
        </View>
    );
}

const KEPT_HERE = "Kept on this device. Package it from the menu to share it.";

/** A note's card: its status, comment and thread; People only, a reply or an aside; revert, cancel or delete. */
export function NoteCard(props: {
    notato: NotatoController;
    record: NoteRecord;
    number: number;
    fromList: boolean;
    open(sheet: Sheet | null): void;
    toast(message: string): void;
}) {
    const { notato, record } = props;
    const a = record.annotation;
    const p = usePalette();
    const [reply, setReply] = useState("");
    const [aside, setAside] = useState(false);
    const [problem, setProblem] = useState<string>();
    const [busy, setBusy] = useState(false);
    const [asked, setAsked] = useState<boolean>();
    const live = notato.hasServer && !record.pending;

    const run = (action: () => Promise<void>, done: string) => {
        if (busy) return;
        setBusy(true);
        setProblem(undefined);
        action()
            .then(() => {
                props.open(null);
                props.toast(done);
            })
            .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false));
    };

    const setPeopleOnly = (on: boolean) => {
        if (asked !== undefined || on === (a.peopleOnly === true)) return;
        setAsked(on);
        setProblem(undefined);
        notato
            .setPeopleOnly(a.id, on)
            .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)))
            .finally(() => setAsked(undefined));
    };

    const byline = [
        a.author.name ?? (a.author.kind === "agent" ? "An agent" : undefined),
        ago(a.createdAt),
    ]
        .filter(Boolean)
        .join(" · ");
    const id = a.target.identity[0];
    const target = id
        ? `${id.tag}${id.testId ? ` #${id.testId}` : ""}${id.text ? ` “${id.text.length > 30 ? `${id.text.slice(0, 29)}…` : id.text}”` : ""}`
        : undefined;

    const actions = live ? (
        <>
            {a.status === "resolved" ? (
                <SheetButton
                    title="Ask the agent to revert"
                    onPress={() =>
                        run(
                            () => notato.requestRevert(a.id, reply),
                            "Asked the agent to undo that change"
                        )
                    }
                />
            ) : null}
            {a.status === "revert_requested" ? (
                <SheetButton
                    title="Cancel request"
                    onPress={() =>
                        run(() => notato.cancelRevert(a.id), "Revert request taken back")
                    }
                />
            ) : null}
            {record.mine && a.status === "open" ? (
                <SheetButton
                    title="Delete"
                    kind="danger"
                    onPress={() => run(() => notato.delete(a.id), "Note deleted")}
                />
            ) : null}
            <SheetButton
                title="Reply"
                kind="primary"
                testID="NotatoSendReply"
                onPress={() => {
                    const text = reply.trim();
                    if (!text) {
                        setProblem("Write a reply first.");
                        return;
                    }
                    const asAside = aside;
                    run(
                        async () => {
                            await notato.reply(a.id, text, asAside);
                            setAside(false);
                        },
                        asAside ? "Aside sent" : "Reply sent"
                    );
                }}
            />
        </>
    ) : (
        <SheetButton
            title="Delete"
            kind="danger"
            onPress={() => run(() => notato.delete(a.id), "Note deleted")}
        />
    );
    const many =
        live &&
        (a.status === "resolved" ||
            a.status === "revert_requested" ||
            (record.mine && a.status === "open"));

    return (
        <>
            <SheetHeader
                title={props.number > 0 ? `Note ${props.number}` : "Note"}
                subtitle={byline || undefined}
                leading={
                    props.fromList ? (
                        <HeaderButton kind="back" onPress={() => props.open({ kind: "list" })} />
                    ) : (
                        <SheetTile
                            tile={{ pin: props.number, status: a.status, pending: record.pending }}
                            size={38}
                        />
                    )
                }
                trailing={<HeaderButton kind="close" onPress={() => props.open(null)} />}
            />
            <SheetScroll>
                <View style={{ gap: 12, paddingHorizontal: 4 }}>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
                        <Badge text={a.status} color={statusColor(a.status)} />
                        {a.intent ? <Badge text={a.intent} color={p.muted} /> : null}
                        {a.severity ? (
                            <Badge
                                text={a.severity}
                                color={a.severity === "blocker" ? p.danger : p.muted}
                            />
                        ) : null}
                        {a.peopleOnly ? <PeopleOnlyBadge palette={p} /> : null}
                    </View>
                    <Text style={{ fontSize: 16, color: p.text }}>{a.comment}</Text>
                    {target ? (
                        <Text style={{ fontSize: 12.5, color: p.muted }} numberOfLines={2}>
                            {target}
                        </Text>
                    ) : null}
                    {record.pending && !notato.hasServer ? (
                        <Text style={{ fontSize: 12.5, color: p.muted }}>{KEPT_HERE}</Text>
                    ) : record.pending ? (
                        <Text style={{ fontSize: 12.5, color: statusColor("acknowledged") }}>
                            {record.failed
                                ? `Not sent: ${record.failed}`
                                : `Not sent yet: ${record.waiting ?? "it goes when the server can be reached."}`}
                        </Text>
                    ) : null}
                    <FlagToggle
                        title={PEOPLE_ONLY.title}
                        hint={PEOPLE_ONLY.hint}
                        value={asked ?? a.peopleOnly === true}
                        disabled={asked !== undefined}
                        onChange={setPeopleOnly}
                        testID="NotatoNotePeopleOnly"
                    />
                    {a.thread.slice(-4).map((r) => (
                        <ThreadEntry key={r.id} reply={r} />
                    ))}
                    {a.thread.length > 4 ? (
                        <Text style={{ fontSize: 12, color: p.muted }}>
                            {a.thread.length - 4} earlier on the board.
                        </Text>
                    ) : null}
                </View>
            </SheetScroll>
            {/* Outside the scrolling thread, so the keyboard never hides what is being typed. */}
            {live ? (
                <View style={{ gap: 10, paddingHorizontal: 4 }}>
                    <Field
                        value={reply}
                        onChangeText={setReply}
                        placeholder={
                            a.status === "resolved" ? "Reply, or say what was wrong" : "Reply"
                        }
                        multiline
                        style={{ maxHeight: 110 }}
                        testID="NotatoReply"
                    />
                    <FlagToggle
                        title={PEOPLE_ONLY.aside}
                        hint={PEOPLE_ONLY.asideHint}
                        value={aside}
                        onChange={setAside}
                        testID="NotatoAside"
                    />
                </View>
            ) : null}
            <View style={{ flexDirection: many ? "column" : "row", gap: many ? 8 : 10 }}>
                {actions}
            </View>
            {problem ? (
                <Text style={{ fontSize: 12.5, color: p.danger, paddingHorizontal: 4 }}>
                    {problem}
                </Text>
            ) : null}
        </>
    );
}
