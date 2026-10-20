import type { Annotation, ElementIdentity } from "@notato/schema";
import { memo, useCallback, useMemo, useState } from "react";
import {
    FlatList,
    type ListRenderItem,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    View,
} from "react-native";
import { PEOPLE_ONLY } from "../annotation.ts";
import type { ConnectionState, NotatoController, NotatoState } from "../controller.ts";
import { isCompleted } from "../hidden.ts";
import type { NoteRecord, NumberedNote } from "../notes.ts";
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
import { ago, type Palette, statusColor, statusLabel, usePalette } from "./theme.ts";

/** What the bottom sheet shows: the menu, or what it opens. */
export type Sheet =
    | { kind: "menu" }
    | { kind: "list" }
    | { kind: "settings" }
    | { kind: "clear" }
    | { kind: "pin"; id: string; fromList: boolean };

/** Where Back goes from a sheet: to the sheet it was opened from, or closed. */
export function backFrom(sheet: Sheet): Sheet | null {
    switch (sheet.kind) {
        case "pin":
            return sheet.fromList ? { kind: "list" } : null;
        case "list":
        case "settings":
        case "clear":
            return { kind: "menu" };
        default:
            return null;
    }
}

const device =
    Platform.OS === "ios" ? ((Platform as { isPad?: boolean }).isPad ? "iPad" : "phone") : "device";
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The bottom sheet's content: the sheet it shows, with what each needs. Drawn again only when one of them changes. */
export const SheetView = memo(function SheetView(props: {
    sheet: Sheet;
    notato: NotatoController;
    state: NotatoState;
    /** The notes on this screen, numbered. */
    here: readonly NumberedNote[];
    /** How many of them have a pin here. */
    pins: number;
    open(sheet: Sheet | null): void;
    annotate(): void;
    toast(message: string): void;
}) {
    const { sheet, notato, state, here, open, toast } = props;
    const p = usePalette();
    switch (sheet.kind) {
        case "menu":
            return (
                <MenuSheet
                    notato={notato}
                    state={state}
                    here={here.length}
                    pins={props.pins}
                    open={open}
                    annotate={props.annotate}
                    packageAndShare={() => {
                        notato.packageAndShare().then(toast, (e: unknown) => toast(messageOf(e)));
                    }}
                />
            );
        case "list":
            return (
                <NotesSheet
                    total={notato.visibleCount}
                    list={here}
                    open={open}
                    annotate={props.annotate}
                />
            );
        case "settings":
            return <SettingsSheet notato={notato} state={state} open={open} toast={toast} />;
        case "clear":
            return <ClearSheet notato={notato} state={state} open={open} toast={toast} />;
        case "pin": {
            const record = state.notes.find((r) => r.annotation.id === sheet.id);
            if (!record)
                return <Text style={[styles.gone, { color: p.danger }]}>That note is gone.</Text>;
            const number = here.find((n) => n.record.annotation.id === sheet.id)?.number ?? 0;
            return (
                <NoteCard
                    key={record.annotation.id}
                    notato={notato}
                    record={record}
                    number={number}
                    fromList={sheet.fromList}
                    open={open}
                    toast={toast}
                />
            );
        }
    }
});

/** The pill beside the menu's title: how the connection stands. */
function connectionPill(
    connection: ConnectionState,
    p: Palette
): { label: string; color: string } | undefined {
    switch (connection) {
        case "connected":
            return { label: "Connected", color: p.connected };
        case "connecting":
            return { label: "Connecting…", color: statusColor("acknowledged") };
        case "offline":
            return { label: "Offline", color: p.offline };
        case "refused":
            return { label: "Refused", color: p.offline };
        default:
            return undefined;
    }
}

/** The box under the menu's title when the server cannot be reached or refused the app. */
function connectionProblem(
    state: NotatoState,
    host: string | undefined
): { title: string; detail: string } | undefined {
    switch (state.connection) {
        case "offline":
            return {
                title: "Can't reach the server",
                detail: `${host ?? "The server"} isn't answering. Notes stay on this ${device} and send when it's back.`,
            };
        case "refused":
            return {
                title: "The server refused this app",
                detail:
                    state.connectionDetail ??
                    `${host ?? "The server"} did not accept this app's token or project.`,
            };
        default:
            return undefined;
    }
}

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
    const pill = notato.hasServer ? connectionPill(state.connection, p) : undefined;
    const problem = notato.hasServer ? connectionProblem(state, host) : undefined;
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
                            accessible
                            accessibilityLabel={pill.label}
                            style={[styles.pill, { backgroundColor: `${pill.color}24` }]}
                        >
                            <View style={[styles.pillDot, { backgroundColor: pill.color }]} />
                            <Text style={[styles.pillText, { color: pill.color }]}>
                                {pill.label}
                            </Text>
                        </View>
                    ) : undefined
                }
            />
            {problem ? (
                <View style={[styles.problem, { backgroundColor: `${p.offline}1f` }]}>
                    <View style={styles.grow}>
                        <Text style={[styles.problemTitle, { color: p.text }]}>
                            {problem.title}
                        </Text>
                        <Text style={[styles.problemDetail, { color: p.muted }]}>
                            {problem.detail}
                        </Text>
                    </View>
                    <Pressable
                        testID="NotatoRetry"
                        accessibilityRole="button"
                        onPress={() => notato.retryConnection()}
                        style={[styles.retry, { backgroundColor: p.text }]}
                    >
                        <Text style={[styles.retryText, { color: p.background }]}>Retry</Text>
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
                    detail={`${props.here} on this screen · ${props.notato.visibleCount} in all`}
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
    total: number;
    list: readonly NumberedNote[];
    open(sheet: Sheet | null): void;
    annotate(): void;
}) {
    const p = usePalette();
    const { list, total, open } = props;
    const newest = useMemo(() => [...list].reverse(), [list]);
    const others = total - list.length;
    const renderItem = useCallback<ListRenderItem<NumberedNote>>(
        ({ item: { number, record } }) => {
            const a = record.annotation;
            return (
                <MenuRow
                    tile={{ pin: number, status: a.status, pending: record.pending }}
                    title={a.comment}
                    titleLines={2}
                    detail={[
                        statusLabel(a.status),
                        a.peopleOnly ? "Hidden from agent" : undefined,
                        ago(a.createdAt),
                    ]
                        .filter(Boolean)
                        .join(" · ")}
                    opens
                    onPress={() => open({ kind: "pin", id: a.id, fromList: true })}
                />
            );
        },
        [open]
    );
    return (
        <>
            <SheetHeader
                title="Notes"
                subtitle={`${list.length} on this screen · ${total} in all`}
                leading={<HeaderButton kind="back" onPress={() => open({ kind: "menu" })} />}
                trailing={<HeaderButton kind="close" onPress={() => open(null)} />}
            />
            <FlatList
                style={styles.list}
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
                            open(null);
                            props.annotate();
                        }}
                    />
                }
                renderItem={renderItem}
                ListFooterComponent={
                    others > 0 ? (
                        <View style={styles.footer}>
                            <View style={[styles.footerRule, { backgroundColor: p.line }]} />
                            <Text style={[styles.small, { color: p.muted }]}>
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
    // Only a server typed in here is shown: the app's own is the placeholder.
    const [server, setServer] = useState(() =>
        notato.server !== notato.configuration?.server ? (notato.server ?? "") : ""
    );
    const [screenshots, setScreenshots] = useState(state.screenshots);
    return (
        <>
            <SheetHeader
                title="Settings"
                subtitle={`Project ${state.project ?? ""} · ${capital(state.mode)} mode`}
                leading={<HeaderButton kind="back" onPress={() => props.open({ kind: "menu" })} />}
                trailing={<HeaderButton kind="close" onPress={() => props.open(null)} />}
            />
            <SheetScroll>
                <View style={styles.settings}>
                    <View style={styles.setting}>
                        <FieldLabel text="Your name" />
                        <Field
                            value={name}
                            onChangeText={setName}
                            placeholder="Your name, on your notes"
                            autoCapitalize="words"
                            testID="NotatoName"
                        />
                    </View>
                    <View style={styles.setting}>
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
                        <Text style={[styles.hint, { color: p.muted }]}>
                            {notato.describeConnection()}
                        </Text>
                    </View>
                    <FlagToggle
                        tile={{ icon: "camera" }}
                        title="Screenshots"
                        hint={
                            state.serverScreenshots
                                ? "Each note takes one of the screen"
                                : "Off until the server says it takes them"
                        }
                        value={screenshots}
                        onChange={setScreenshots}
                    />
                    <SheetButton
                        title={`Hide completed annotations (${notato.completedCount})`}
                        disabled={notato.completedCount === 0}
                        testID="NotatoHideCompleted"
                        onPress={() => {
                            props.open(null);
                            notato.hideCompleted();
                        }}
                    />
                    <Text style={[styles.hint, { color: p.muted }]}>
                        Across this app, on this device. Kept in the dashboard.
                    </Text>
                    <SheetButton
                        title={`Restore hidden annotations (${notato.hiddenCount})`}
                        testID="NotatoRestoreHidden"
                        onPress={() => {
                            props.open(null);
                            notato.restoreHidden();
                        }}
                    />
                </View>
            </SheetScroll>
            <View style={styles.buttons}>
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

/** Test mode: asks before the notes on this device are cleared. */
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
            <Text style={[styles.clearText, { color: p.muted }]}>
                A package you already shared keeps them.
            </Text>
            <View style={[styles.buttons, styles.clearButtons]}>
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
            <Text style={[styles.automatic, { color: p.muted }]}>
                <Text style={styles.bold}>{name}</Text> · {reply.body}
            </Text>
        );
    }
    const aside = reply.aside === true;
    return (
        <View
            style={[
                styles.entry,
                aside ? { borderWidth: 1, borderColor: p.line } : { backgroundColor: p.soft },
            ]}
            accessibilityLabel={aside ? `Hidden from agent. ${name}: ${reply.body}` : undefined}
        >
            {aside ? (
                <Text style={[styles.asideLabel, { color: p.muted }]}>{"Hidden from agent"}</Text>
            ) : null}
            <Text style={[styles.entryText, { color: aside ? p.muted : p.text }]}>
                <Text style={styles.bold}>{name}: </Text>
                {reply.body}
            </Text>
        </View>
    );
}

const KEPT_HERE = "Kept on this device. Package it from the menu to share it.";

/** What a note is on, in a line: `Text #price “£1.45”`. */
function describeTarget(identity: ElementIdentity | undefined): string | undefined {
    if (!identity) return undefined;
    const text = identity.text;
    const shown = text && text.length > 30 ? `${text.slice(0, 29)}…` : text;
    return [identity.tag, identity.testId && `#${identity.testId}`, shown && `“${shown}”`]
        .filter(Boolean)
        .join(" ");
}

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
    const [optionsOpen, setOptionsOpen] = useState(false);
    const [deleteArmed, setDeleteArmed] = useState(false);
    const [problem, setProblem] = useState<string>();
    const [busy, setBusy] = useState(false);
    /** The People only switch's new value while the change is on its way. */
    const [asked, setAsked] = useState<boolean>();
    /** Sent with a capture-only token: the server took it, and this app can neither read it back nor change it. */
    const sentOnly = notato.captureOnly && !record.pending;
    /** On the server: it has a thread to reply on, and a status to change. */
    const live = notato.hasServer && !record.pending && !sentOnly;

    const run = (action: () => Promise<void>, done: string) => {
        if (busy) return;
        setBusy(true);
        setProblem(undefined);
        action()
            .then(() => {
                props.open(null);
                props.toast(done);
            })
            .catch((e: unknown) => setProblem(messageOf(e)))
            .finally(() => setBusy(false));
    };

    const setPeopleOnly = (on: boolean) => {
        if (asked !== undefined || on === (a.peopleOnly === true)) return;
        setAsked(on);
        setProblem(undefined);
        notato
            .setPeopleOnly(a.id, on)
            .catch((e: unknown) => setProblem(messageOf(e)))
            .finally(() => setAsked(undefined));
    };

    const sendReply = () => {
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
            asAside ? "Reply hidden from agent" : "Reply sent"
        );
    };

    const byline = [
        a.author.name ?? (a.author.kind === "agent" ? "An agent" : undefined),
        ago(a.createdAt),
    ]
        .filter(Boolean)
        .join(" · ");
    const target = describeTarget(a.target.identity[0]);
    const canRevert =
        live && a.status === "resolved" && a.intent !== "question" && a.intent !== "approve";
    const canCancelRevert = live && a.status === "revert_requested";
    // A note on the server is the person's to delete while it is open and theirs; one on the device always is.
    const canDelete = !sentOnly && (!live || (record.mine && a.status === "open"));

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
                <View style={styles.card}>
                    <View style={styles.badges}>
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
                    <Text style={[styles.comment, { color: p.text }]}>{a.comment}</Text>
                    {target ? (
                        <Text style={[styles.small, { color: p.muted }]} numberOfLines={2}>
                            {target}
                        </Text>
                    ) : null}
                    {record.pending && !notato.hasServer ? (
                        <Text style={[styles.small, { color: p.muted }]}>{KEPT_HERE}</Text>
                    ) : record.pending ? (
                        <Text style={[styles.small, { color: statusColor("acknowledged") }]}>
                            {record.failed
                                ? `Not sent: ${record.failed}`
                                : `Not sent yet: ${record.waiting ?? "it goes when the server can be reached."}`}
                        </Text>
                    ) : sentOnly ? (
                        <Text style={[styles.small, { color: p.muted }]}>
                            Sent. Its replies and status are on the Notato board.
                        </Text>
                    ) : null}
                    {a.thread.slice(-4).map((r) => (
                        <ThreadEntry key={r.id} reply={r} />
                    ))}
                    {a.thread.length > 4 ? (
                        <Text style={[styles.earlier, { color: p.muted }]}>
                            {a.thread.length - 4} earlier on the board.
                        </Text>
                    ) : null}
                </View>
            </SheetScroll>
            {/* Outside the scrolling thread, so the keyboard never hides what is being typed. */}
            {live ? (
                <View style={styles.replyBox}>
                    <Field
                        value={reply}
                        onChangeText={setReply}
                        placeholder={
                            a.status === "resolved" ? "Reply, or say what was wrong" : "Reply"
                        }
                        multiline
                        style={styles.replyField}
                        testID="NotatoReply"
                    />
                    {aside ? (
                        <Text
                            style={[styles.small, { color: p.muted }]}
                            accessibilityLiveRegion="polite"
                        >
                            Next reply hidden from agent
                        </Text>
                    ) : null}
                </View>
            ) : null}
            {(!sentOnly || isCompleted(a)) && optionsOpen ? (
                <SheetScroll>
                    <View style={styles.card}>
                        <FlagToggle
                            title={PEOPLE_ONLY.title}
                            hint={PEOPLE_ONLY.hint}
                            value={asked ?? a.peopleOnly === true}
                            disabled={asked !== undefined || sentOnly}
                            onChange={setPeopleOnly}
                            testID="NotatoNotePeopleOnly"
                        />
                        {live ? (
                            <FlagToggle
                                title={PEOPLE_ONLY.aside}
                                hint={PEOPLE_ONLY.asideHint}
                                value={aside}
                                onChange={setAside}
                                testID="NotatoAside"
                            />
                        ) : null}
                        {canRevert ? (
                            <SheetButton
                                title="Revert this change…"
                                onPress={() =>
                                    run(
                                        () => notato.requestRevert(a.id, reply),
                                        "Asked the agent to undo that change"
                                    )
                                }
                            />
                        ) : null}
                        {canCancelRevert ? (
                            <SheetButton
                                title="Cancel revert request"
                                onPress={() =>
                                    run(
                                        () => notato.cancelRevert(a.id),
                                        "Revert request taken back"
                                    )
                                }
                            />
                        ) : null}
                        {isCompleted(a) ? (
                            <SheetButton
                                title="Hide from this app"
                                testID="NotatoHideAnnotation"
                                onPress={() => {
                                    props.open(null);
                                    notato.hideAnnotation(a.id);
                                }}
                            />
                        ) : null}
                        {canDelete ? (
                            <SheetButton
                                title={deleteArmed ? "Confirm delete" : "Delete"}
                                kind="danger"
                                onPress={() => {
                                    if (!deleteArmed) {
                                        setDeleteArmed(true);
                                        return;
                                    }
                                    run(() => notato.delete(a.id), "Note deleted");
                                }}
                            />
                        ) : null}
                    </View>
                </SheetScroll>
            ) : null}
            <View style={styles.buttons}>
                {!sentOnly || isCompleted(a) ? (
                    <SheetButton
                        title={optionsOpen ? "Close options" : "More options"}
                        testID="NotatoMoreOptions"
                        onPress={() => {
                            setOptionsOpen(!optionsOpen);
                            setDeleteArmed(false);
                        }}
                    />
                ) : null}
                {live ? (
                    <SheetButton
                        title="Reply"
                        kind="primary"
                        testID="NotatoSendReply"
                        onPress={sendReply}
                    />
                ) : null}
            </View>
            {problem ? (
                <Text style={[styles.problemLine, { color: p.danger }]}>{problem}</Text>
            ) : null}
        </>
    );
}

const styles = StyleSheet.create({
    grow: { flex: 1, gap: 2 },
    bold: { fontWeight: "700" },
    small: { fontSize: 12.5 },
    gone: { padding: 20 },
    pill: {
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 999,
    },
    pillDot: { width: 7, height: 7, borderRadius: 4 },
    pillText: { fontSize: 12, fontWeight: "700" },
    problem: {
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 11,
        borderRadius: 16,
    },
    problemTitle: { fontSize: 13, fontWeight: "700" },
    problemDetail: { fontSize: 13, lineHeight: 17 },
    retry: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10 },
    retryText: { fontSize: 13, fontWeight: "700" },
    list: { flexGrow: 0, flexShrink: 1 },
    footer: { paddingTop: 14, paddingBottom: 2, paddingHorizontal: 4 },
    footerRule: { position: "absolute", top: 4, left: 0, right: 0, height: 1 },
    settings: { gap: 14 },
    setting: { gap: 6 },
    hint: { fontSize: 12, paddingHorizontal: 4 },
    buttons: { flexDirection: "row", gap: 10 },
    stackedButtons: { flexDirection: "column", gap: 8 },
    clearText: { fontSize: 13.5, paddingHorizontal: 4 },
    clearButtons: { paddingTop: 4 },
    automatic: { fontSize: 12, paddingHorizontal: 10, paddingVertical: 2 },
    entry: {
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderRadius: 12,
        gap: 2,
        borderStyle: "dashed",
    },
    asideLabel: { fontSize: 11, fontWeight: "700" },
    entryText: { fontSize: 14.5 },
    card: { gap: 12, paddingHorizontal: 4 },
    badges: { flexDirection: "row", flexWrap: "wrap", gap: 5 },
    comment: { fontSize: 16 },
    earlier: { fontSize: 12 },
    replyBox: { gap: 10, paddingHorizontal: 4 },
    replyField: { maxHeight: 110 },
    problemLine: { fontSize: 12.5, paddingHorizontal: 4 },
});
