import { afterEach, describe, expect, it } from "bun:test";
import { type Annotation, sampleAnnotation } from "@notato/schema";
import { filterQuery } from "../src/api.ts";
import {
    activityOf,
    ago,
    applyChange,
    capitalise,
    countsMayChange,
    dayLabel,
    duration,
    type Filters,
    groupAnnotations,
    initial,
    lastActivity,
    lastSegment,
    later,
    matches,
    matchesSearch,
    mergeSnapshot,
    NO_NAME,
    newestActivity,
    plural,
    projectIdProblem,
    projectStats,
    relativeTime,
    restoreDraft,
    serial,
    sortAnnotations,
    suggestProjectId,
    TODO,
    todoOf,
    viewOf,
    withActivity,
} from "../src/model.ts";
import { href, parseRoute } from "../src/route.ts";

let n = 0;
/** The sample, made plain: no severity, no name, no thread, a page of its own; tests add what they need. */
const annotation = (over: Partial<Annotation> = {}): Annotation => ({
    ...sampleAnnotation,
    id: `01WEB${++n}`,
    bundleId: null,
    status: "open",
    author: { kind: "human" },
    route: "/x",
    severity: undefined,
    thread: [],
    ...over,
});
const reply = (createdAt: string, over: Partial<Annotation["thread"][number]> = {}) => ({
    id: `r${++n}`,
    author: { kind: "agent" as const, name: "Claude" },
    body: "Done.",
    createdAt,
    ...over,
});
const none: Filters = {
    status: [],
    route: "",
    severity: "",
    intent: "",
    by: "",
    author: "",
    bundle: "",
};

describe("board filters", () => {
    it("shows everything when nothing is chosen", () => {
        expect(matches(annotation(), none)).toBe(true);
    });

    it("filters by intent, and an annotation with none does not match one", () => {
        expect(matches(annotation({ intent: "question" }), { ...none, intent: "question" })).toBe(
            true
        );
        expect(matches(annotation({ intent: "fix" }), { ...none, intent: "question" })).toBe(false);
        expect(matches(annotation({ intent: undefined }), { ...none, intent: "fix" })).toBe(false);
    });

    it("combines filters", () => {
        const a = annotation({ intent: "fix", status: "revert_requested", severity: "major" });
        expect(
            matches(a, { ...none, status: ["revert_requested"], intent: "fix", severity: "major" })
        ).toBe(true);
        expect(matches(a, { ...none, status: ["open"], intent: "fix" })).toBe(false);
    });

    it("filters one person's notes by the name on them", () => {
        const dom = annotation({ author: { kind: "human", name: "Dom" } });
        const ana = annotation({ author: { kind: "human", name: "Ana" } });
        expect(matches(dom, { ...none, by: "Dom" })).toBe(true);
        expect(matches(ana, { ...none, by: "Dom" })).toBe(false);
        expect(matches(annotation({ author: { kind: "agent" } }), { ...none, by: "Dom" })).toBe(
            false
        );
    });

    it("names the view a status list is, in any order, and nothing for a mix", () => {
        expect(viewOf(TODO)).toBe("todo");
        expect(viewOf(["reverted", "resolved"])).toBe("done");
        expect(viewOf([])).toBe("all");
        expect(viewOf(["open"])).toBeNull();
    });
});

describe("search", () => {
    const a = annotation({
        comment: "The Save button is cut off",
        route: "/settings/profile",
        thread: [reply("2026-10-01T10:00:00.000Z", { body: "Widened the column in layout.css" })],
    });

    it("needs every word, anywhere in the note, its page or its thread, ignoring case", () => {
        expect(matchesSearch(a, "save PROFILE")).toBe(true);
        expect(matchesSearch(a, "layout.css")).toBe(true);
        expect(matchesSearch(a, "save billing")).toBe(false);
        expect(matchesSearch(a, "   ")).toBe(true);
    });

    it("looks in where the element is written", () => {
        const b = annotation({
            target: {
                ...sampleAnnotation.target,
                identity: [
                    {
                        selector: "button.pill",
                        tag: "button",
                        component: { name: "ProfilePill" },
                        source: { file: "src/Header.tsx", line: 12, col: 4 },
                    },
                ],
            },
        });
        expect(matchesSearch(b, "profilepill")).toBe(true);
        expect(matchesSearch(b, "header.tsx")).toBe(true);
    });
});

describe("ordering and grouping", () => {
    const old = annotation({ createdAt: "2026-10-01T09:00:00.000Z", severity: "nit", route: "/b" });
    const replied = annotation({
        createdAt: "2026-10-02T09:00:00.000Z",
        route: "/a",
        thread: [reply("2026-10-05T09:00:00.000Z")],
    });
    const fresh = annotation({
        createdAt: "2026-10-04T09:00:00.000Z",
        severity: "blocker",
        route: "/b",
    });

    it("knows when anything last happened, replies included", () => {
        expect(lastActivity(replied)).toBe("2026-10-05T09:00:00.000Z");
        expect(lastActivity(old)).toBe(old.createdAt);
    });

    it("sorts by activity, age and severity", () => {
        const ids = (list: Annotation[]) => list.map((a) => a.id);
        expect(ids(sortAnnotations([old, replied, fresh], "activity"))).toEqual(
            ids([replied, fresh, old])
        );
        expect(ids(sortAnnotations([old, replied, fresh], "newest"))).toEqual(
            ids([fresh, replied, old])
        );
        expect(ids(sortAnnotations([fresh, replied, old], "oldest"))).toEqual(
            ids([old, replied, fresh])
        );
        // Annotations without a severity go last.
        expect(ids(sortAnnotations([old, replied, fresh], "severity"))).toEqual(
            ids([fresh, old, replied])
        );
    });

    it("groups a sorted list without reordering within a group", () => {
        const groups = groupAnnotations(sortAnnotations([old, replied, fresh], "newest"), "route");
        expect(groups.map((g) => g.label)).toEqual(["/a", "/b"]);
        expect(groups[1]?.items.map((a) => a.id)).toEqual([fresh.id, old.id]);
        expect(groupAnnotations([old], "none")).toEqual([{ key: "", label: "", items: [old] }]);
    });

    it("puts statuses in their lifecycle order", () => {
        const groups = groupAnnotations(
            [
                annotation({ status: "dismissed" }),
                annotation({ status: "open" }),
                annotation({ status: "resolved" }),
            ],
            "status"
        );
        expect(groups.map((g) => g.label)).toEqual(["Open", "Resolved", "Dismissed"]);
    });

    it("puts severities from the worst, with the notes that have none last", () => {
        const groups = groupAnnotations(
            [
                annotation({ severity: "nit" }),
                annotation({ severity: undefined }),
                annotation({ severity: "blocker" }),
            ],
            "severity"
        );
        expect(groups.map((g) => g.label)).toEqual(["blocker", "nit", "No severity"]);
    });

    it("groups a long list in one pass, keeping every note in order", () => {
        const many = Array.from({ length: 20_000 }, (_, i) =>
            annotation({ route: i % 2 ? "/odd" : "/even" })
        );
        const groups = groupAnnotations(many, "route");
        expect(groups.map((g) => g.items.length)).toEqual([10_000, 10_000]);
        expect(groups[0]?.items[1]).toBe(many[2] as Annotation);
    });
});

describe("activity", () => {
    it("lists new notes and replies together, newest first, with Notato's own entries marked", () => {
        const a = annotation({
            createdAt: "2026-10-01T09:00:00.000Z",
            thread: [
                reply("2026-10-01T10:00:00.000Z"),
                reply("2026-10-02T10:00:00.000Z", { automatic: true, body: "Picked “Compact”." }),
            ],
        });
        const b = annotation({ createdAt: "2026-10-01T12:00:00.000Z" });
        expect(activityOf([a, b]).map((i) => [i.kind, i.annotation.id])).toEqual([
            ["automatic", a.id],
            ["created", b.id],
            ["reply", a.id],
            ["created", a.id],
        ]);
    });
});

describe("project numbers", () => {
    const now = Date.parse("2026-10-06T15:00:00.000Z");
    const list = [
        annotation({
            route: "/a",
            severity: "major",
            author: { kind: "human", name: "Dom" },
            createdAt: "2026-10-06T09:00:00.000Z",
            thread: [reply("2026-10-06T09:10:00.000Z")],
        }),
        annotation({
            route: "/a",
            status: "resolved",
            author: { kind: "human", name: "Dom" },
            createdAt: "2026-10-05T09:00:00.000Z",
            thread: [reply("2026-10-05T09:30:00.000Z")],
        }),
        annotation({ route: "/b", status: "dismissed", createdAt: "2026-08-01T09:00:00.000Z" }),
        annotation({
            route: "/b",
            status: "acknowledged",
            author: { kind: "human" },
            createdAt: "2026-09-01T09:00:00.000Z",
        }),
    ];
    const stats = projectStats(list, now);

    it("counts what is to do, done and dismissed", () => {
        expect([stats.total, stats.todo, stats.done, stats.dismissed]).toEqual([4, 2, 1, 1]);
        expect(stats.severities.major).toBe(1);
        expect(stats.severities.none).toBe(1);
    });

    it("ranks pages and people by what is still to do", () => {
        expect(stats.routes.map((r) => [r.key, r.todo, r.total])).toEqual([
            ["/a", 1, 2],
            ["/b", 1, 2],
        ]);
        expect(stats.people.find((p) => p.name === "Dom")).toMatchObject({ total: 2, todo: 1 });
    });

    it("keeps an agent with no name apart from the named ones, so its row opens only its notes", () => {
        const notes = [
            annotation({ author: { kind: "agent" } }),
            annotation({ author: { kind: "agent", name: "Claude" } }),
            annotation({ author: { kind: "agent", name: "Codex" } }),
            annotation({ author: { kind: "human", name: "Agent" } }),
        ];
        const people = projectStats(notes, now).people;
        expect(people).toHaveLength(4);
        const unnamed = people.find((p) => p.agent && !p.name);
        expect(unnamed?.total).toBe(1);
        // What the Overview row asks the inbox for: agents, and only the ones with no name.
        const row = { ...none, author: "agent" as const, by: NO_NAME };
        expect(notes.filter((a) => matches(a, row))).toEqual([notes[0] as Annotation]);
        const claude = { ...none, author: "agent" as const, by: "Claude" };
        expect(notes.filter((a) => matches(a, claude))).toEqual([notes[1] as Annotation]);
    });

    it("counts new notes per day over the window, leaving older ones out", () => {
        expect(stats.perDay).toHaveLength(30);
        expect(stats.perDay.reduce((n, d) => n + d.count, 0)).toBe(2);
        expect(stats.perDay.at(-1)?.count).toBe(1);
    });

    it("takes the median time to a first reply from someone else", () => {
        // 10 minutes and 30 minutes.
        expect(stats.medianFirstReplyMs).toBe(20 * 60_000);
        expect(projectStats([annotation()], now).medianFirstReplyMs).toBeNull();
    });
});

describe("routes", () => {
    it("round-trips every page through the hash", () => {
        const routes = [
            { page: "home" },
            { page: "tokens" },
            { page: "settings" },
            { page: "project", project: "checkout web", tab: "inbox" },
            { page: "project", project: "a/b", tab: "inbox", selected: "01ABC" },
            { page: "project", project: "x", tab: "activity" },
            { page: "project", project: "x", tab: "overview" },
            { page: "project", project: "x", tab: "connect" },
            { page: "project", project: "x@y.z", tab: "settings" },
        ] as const;
        for (const r of routes) expect(parseRoute(href(r))).toEqual(r);
    });

    it("reads the old board's links, and treats anything unknown as home", () => {
        expect(parseRoute("#/p/checkout-web")).toEqual({
            page: "project",
            project: "checkout-web",
            tab: "inbox",
        });
        expect(parseRoute("")).toEqual({ page: "home" });
        expect(parseRoute("#/nope")).toEqual({ page: "home" });
        expect(parseRoute("#/p/x/bogus")).toEqual({ page: "project", project: "x", tab: "inbox" });
    });
});

describe("the query the board sends", () => {
    it("carries the intent, so Export zip sees what is on screen", () => {
        const q = filterQuery({
            ...none,
            status: ["open", "acknowledged"],
            intent: "question",
            route: "/a",
        });
        expect(q.get("intent")).toBe("question");
        expect(q.get("status")).toBe("open,acknowledged");
        expect(q.get("route")).toBe("/a");
        expect(filterQuery({ ...none, by: "Ada Lovelace" }).get("by")).toBe("Ada Lovelace");
        expect(filterQuery(none).toString()).toBe("");
    });

    it("asks the server for notes with no name as `unnamed`, never by the board's own marker", () => {
        expect(filterQuery({ ...none, author: "agent", by: NO_NAME }).toString()).toBe(
            "author=agent&unnamed=1"
        );
    });

    it("counts a project's to-do the inbox's way, falling back to `open` from an older server", () => {
        expect(
            todoOf({
                id: "x",
                annotations: 5,
                open: 1,
                statuses: { open: 1, acknowledged: 2, resolved: 2 },
            })
        ).toBe(3);
        expect(todoOf({ id: "x", annotations: 5, open: 1 })).toBe(1);
    });
});

describe("small things", () => {
    it("puts one letter on an avatar, the same for a name however it is written", () => {
        expect(initial("dom")).toBe("D");
        expect(initial("Ada Lovelace")).toBe("A");
        expect(initial("  émile")).toBe("É");
        expect(initial("  ")).toBe("?");
        expect(initial(undefined)).toBe("?");
    });

    it("counts things in words, and makes labels of the wire format's words", () => {
        expect(plural(1, "note")).toBe("1 note");
        expect(plural(3, "note")).toBe("3 notes");
        expect(plural(0, "reply", "replies")).toBe("0 replies");
        expect(capitalise("fix")).toBe("Fix");
        expect(capitalise("")).toBe("");
    });

    it("tells pages apart by the end of their route", () => {
        expect(lastSegment("/InitPage/HomePage")).toBe("HomePage");
        expect(lastSegment("/settings/")).toBe("settings");
        expect(lastSegment("/")).toBe("/");
    });

    it("says how long something took in the unit a person would use", () => {
        expect(duration(20_000)).toBe("20 s");
        expect(duration(20 * 60_000)).toBe("20 min");
        expect(duration(60 * 60_000)).toBe("1 h");
        expect(duration(30 * 3_600_000)).toBe("30 h");
        expect(duration(24 * 3_600_000 * 3)).toBe("3 days");
    });

    it("says how long ago, briefly", () => {
        const now = new Date(2026, 9, 6, 15, 0).getTime();
        expect(relativeTime(new Date(now - 10_000).toISOString(), now)).toBe("just now");
        expect(relativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5m");
        expect(relativeTime(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe("3h");
        expect(relativeTime(new Date(2026, 9, 5, 9).toISOString(), now)).toBe("Yesterday");
        expect(ago(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5m ago");
        expect(ago(new Date(2026, 9, 5, 9).toISOString(), now)).toBe("yesterday");
    });
});

describe("days, where the clocks change", () => {
    const zone = process.env.TZ;
    afterEach(() => {
        process.env.TZ = zone;
    });

    it("counts yesterday by the calendar when yesterday was 23 hours long", () => {
        process.env.TZ = "Europe/London";
        // The clocks went forward on Sunday 29 March 2026, so Sunday had 23 hours.
        const now = new Date(2026, 2, 30, 12).getTime();
        const saturdayNight = new Date(2026, 2, 28, 23, 30).toISOString();
        expect(relativeTime(saturdayNight, now)).not.toBe("Yesterday");
        expect(dayLabel(saturdayNight, now)).not.toBe("Yesterday");
        expect(dayLabel(new Date(2026, 2, 29, 0, 30).toISOString(), now)).toBe("Yesterday");
    });

    it("counts yesterday by the calendar when yesterday was 25 hours long", () => {
        process.env.TZ = "Europe/London";
        // The clocks went back on Sunday 25 October 2026, so Sunday had 25 hours.
        const now = new Date(2026, 9, 26, 0, 30).getTime();
        const sundayJustAfterMidnight = new Date(2026, 9, 25, 0, 30).toISOString();
        expect(relativeTime(sundayJustAfterMidnight, now)).toBe("Yesterday");
        expect(dayLabel(sundayJustAfterMidnight, now)).toBe("Yesterday");
    });
});

describe("a load and the changes that arrive while it is on its way", () => {
    const a = annotation({ comment: "first" });
    const b = annotation({ comment: "second" });

    it("applies a change, a new note and a delete", () => {
        const resolved = { ...a, status: "resolved" as const };
        expect(applyChange([a, b], { type: "updated", id: a.id, annotation: resolved })).toEqual([
            resolved,
            b,
        ]);
        const c = annotation();
        expect(applyChange([a], { type: "created", id: c.id, annotation: c })).toEqual([a, c]);
        expect(applyChange([a, b], { type: "deleted", id: a.id })).toEqual([b]);
    });

    it("keeps what was heard over an older snapshot, and adds what the snapshot missed", () => {
        const resolved = { ...a, status: "resolved" as const };
        const early = annotation({ comment: "arrived before the load answered" });
        const merged = mergeSnapshot(
            [a, b],
            new Map([
                [a.id, resolved],
                [b.id, null],
                [early.id, early],
            ])
        );
        expect(merged).toEqual([resolved, early]);
    });

    it("leaves a snapshot alone when nothing was heard", () => {
        expect(mergeSnapshot([a, b], new Map())).toEqual([a, b]);
    });
});

describe("keeping the project list up to date", () => {
    const note = annotation({ status: "open" });

    it("asks the server again only when a change can move the counts", () => {
        expect(countsMayChange({ type: "created", id: note.id, annotation: note }, undefined)).toBe(
            true
        );
        expect(countsMayChange({ type: "deleted", id: note.id }, "open")).toBe(true);
        expect(countsMayChange({ type: "replied", id: note.id, annotation: note }, "open")).toBe(
            false
        );
        // A severity or a comment changed: the status is what it was.
        expect(countsMayChange({ type: "updated", id: note.id, annotation: note }, "open")).toBe(
            false
        );
        const resolved = { ...note, status: "resolved" as const };
        expect(
            countsMayChange({ type: "updated", id: note.id, annotation: resolved }, "open")
        ).toBe(true);
        // Nothing known about it before: it may have changed.
        expect(
            countsMayChange({ type: "updated", id: note.id, annotation: resolved }, undefined)
        ).toBe(true);
    });

    it("moves only the activity time otherwise, and only forwards", () => {
        const list = [
            { id: "a", lastActivityAt: "2026-10-06T10:00:00.000Z" },
            { id: "b", lastActivityAt: "2026-10-06T09:00:00.000Z" },
        ];
        expect(withActivity(list, "a", "2026-10-06T11:00:00.000Z")).toEqual([
            { id: "a", lastActivityAt: "2026-10-06T11:00:00.000Z" },
            { id: "b", lastActivityAt: "2026-10-06T09:00:00.000Z" },
        ]);
        expect(withActivity(list, "a", "2026-10-06T08:00:00.000Z")).toBe(list);
        expect(withActivity(list, "nope", "2026-10-06T11:00:00.000Z")).toBeNull();
    });

    it("takes the later of two server times", () => {
        expect(later("2026-10-06T10:00:00.000Z", "2026-10-06T11:00:00.000Z")).toBe(
            "2026-10-06T11:00:00.000Z"
        );
        expect(later(null, "2026-10-06T11:00:00.000Z")).toBe("2026-10-06T11:00:00.000Z");
        expect(later("2026-10-06T10:00:00.000Z", undefined)).toBe("2026-10-06T10:00:00.000Z");
        const replied = annotation({
            createdAt: "2026-10-01T09:00:00.000Z",
            thread: [reply("2026-10-03T09:00:00.000Z")],
        });
        expect(
            newestActivity([annotation({ createdAt: "2026-10-02T09:00:00.000Z" }), replied])
        ).toBe("2026-10-03T09:00:00.000Z");
        expect(newestActivity([])).toBeNull();
    });
});

describe("the reply box", () => {
    it("brings back what failed to send, without losing what was typed since", () => {
        expect(restoreDraft("", "Can you check the footer?")).toBe("Can you check the footer?");
        expect(restoreDraft("And the header", "Can you check the footer?")).toBe(
            "Can you check the footer?\nAnd the header"
        );
    });

    it("sends one request at a time, in order, and carries on after one fails", async () => {
        const queue = serial();
        const done: string[] = [];
        let release = () => {};
        const slow = new Promise<void>((resolve) => {
            release = resolve;
        });
        const first = queue(async () => {
            await slow;
            done.push("reply");
        });
        const second = queue(async () => {
            done.push("resolve");
            throw new Error("refused");
        });
        const third = queue(async () => {
            done.push("reopen");
        });
        await Promise.resolve();
        expect(done).toEqual([]);
        release();
        await first;
        await expect(second).rejects.toThrow("refused");
        await third;
        expect(done).toEqual(["reply", "resolve", "reopen"]);
    });
});

describe("project ids", () => {
    it("suggests an id from a name", () => {
        expect(suggestProjectId("Checkout Web (iOS)")).toBe("checkout-web-ios");
        expect(suggestProjectId("  Café  Crème ")).toBe("cafe-creme");
        expect(suggestProjectId("api_v2.staging")).toBe("api_v2.staging");
        expect(suggestProjectId("...")).toBe("");
        expect(suggestProjectId("!!!")).toBe("");
        expect(suggestProjectId("x".repeat(200))).toHaveLength(128);
    });

    it("says what is wrong with an id, the way the server would refuse it", () => {
        expect(projectIdProblem("checkout-web")).toBeNull();
        expect(projectIdProblem("ada@example.com")).toBeNull();
        expect(projectIdProblem("")).toMatch(/id/);
        expect(projectIdProblem("..")).toMatch(/dots/);
        expect(projectIdProblem("has space")).toMatch(/letters, digits/);
        expect(projectIdProblem("a/b")).toMatch(/letters, digits/);
        expect(projectIdProblem("x".repeat(129))).toMatch(/128/);
    });
});
