import type {
    AgentStep,
    Annotation,
    Author,
    ElementIdentity,
    Intent,
    Reply,
    Severity,
} from "@notato/schema";
import type { Shot } from "./capture.ts";
import type { NotatoMode } from "./config.ts";
import { ulid } from "./ids.ts";
import type { LogEntry } from "./logs.ts";
import { SDK } from "./version.ts";

/** An HTTP request the app made, for `context.network` (`notato.recordRequest`). */
export interface NetworkEntry {
    method: string;
    url: string;
    status: number;
    durationMs: number;
    at: string;
}

export interface NoteInput {
    project: string;
    mode?: NotatoMode;
    appName: string;
    appVersion?: string;
    /** The screen, as the app names it: `/` when it does not say. */
    route: string;
    author?: string;
    /** Set when an agent makes the note (`notato_annotate`): it is then the agent's, under this name. */
    agentName?: string;
    identity: ElementIdentity;
    rect: { x: number; y: number; w: number; h: number };
    comment: string;
    intent?: Intent;
    severity?: Severity;
    peopleOnly?: boolean;
    steps?: AgentStep[];
    /** The number on the pin, also drawn on the screenshot. */
    pin: number;
    screenshots?: { full: Shot; crop?: Shot };
    device: {
        os: string;
        osVersion: string;
        reactNative?: string;
        viewport: { w: number; h: number };
        dpr: number;
    };
    console?: LogEntry[];
    network?: NetworkEntry[];
    now?: Date;
    id?: string;
}

/** `react-native://shop/Product`: where a note was made, in the shape of a URL like every SDK's. */
export const appUrl = (appName: string, route: string) =>
    `react-native://${encodeURIComponent(appName.toLowerCase().replace(/\s+/g, "-"))}${route.startsWith("/") ? route : `/${route}`}`;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The words every Notato SDK uses for keeping things from the agent. */
export const PEOPLE_ONLY = {
    title: "People only",
    hint: "Keep this between people: the agent won't see it.",
    aside: "Aside",
    asideHint: "Just for people: the agent won't see this reply.",
    on: "Made this people only: the agent won't see it.",
    off: "Shared this with the agent.",
} as const;

/** The thread's record of People only being turned on or off, as the server writes it. */
export function peopleOnlyChange(on: boolean, author: Author, now = new Date()): Reply {
    return {
        id: ulid(now.getTime()),
        author,
        body: on ? PEOPLE_ONLY.on : PEOPLE_ONLY.off,
        createdAt: now.toISOString(),
        automatic: true,
        peopleOnly: on,
    };
}

/** A note not on the server yet, with People only turned on or off and the change recorded in its thread. */
export function settingPeopleOnly(
    annotation: Annotation,
    on: boolean,
    author: Author,
    now = new Date()
): Annotation {
    if (on === (annotation.peopleOnly === true)) return annotation;
    const next: Annotation = {
        ...annotation,
        thread: [...annotation.thread, peopleOnlyChange(on, author, now)],
    };
    if (on) next.peopleOnly = true;
    else delete next.peopleOnly;
    return next;
}

/** The annotation the server takes (`POST /projects/:id/annotations`), as @notato/schema describes it. */
export function buildAnnotation(input: NoteInput): Annotation {
    const { device } = input;
    const author: Author = input.agentName
        ? { kind: "agent", name: input.agentName }
        : { kind: "human", ...(input.author ? { name: input.author } : {}) };
    return {
        id: input.id ?? ulid(),
        projectId: input.project,
        bundleId: null,
        author,
        mode: input.mode ?? "dev",
        createdAt: (input.now ?? new Date()).toISOString(),
        url: appUrl(input.appName, input.route),
        route: input.route,
        appName: input.appName,
        ...(input.appVersion ? { appVersion: input.appVersion } : {}),
        environment: {
            userAgent: `${input.appName}${input.appVersion ? `/${input.appVersion}` : ""} (${device.os} ${device.osVersion}) React Native${device.reactNative ? `/${device.reactNative}` : ""}`,
            viewport: { w: round2(device.viewport.w), h: round2(device.viewport.h) },
            dpr: device.dpr,
            platform: "react-native",
            sdk: { ...SDK },
        },
        target: {
            kind: "element",
            identity: [input.identity],
            rect: {
                x: round2(input.rect.x),
                y: round2(input.rect.y),
                w: round2(input.rect.w),
                h: round2(input.rect.h),
            },
        },
        comment: input.comment.trim(),
        ...(input.severity ? { severity: input.severity } : {}),
        ...(input.intent ? { intent: input.intent } : {}),
        ...(input.screenshots
            ? {
                  screenshots: {
                      full: input.screenshots.full.ref,
                      ...(input.screenshots.crop ? { crop: input.screenshots.crop.ref } : {}),
                  },
              }
            : {}),
        ...(input.steps?.length ? { steps: input.steps } : {}),
        context: {
            screenshot: { method: "native", pin: input.pin },
            reactNative: {
                os: device.os,
                osVersion: device.osVersion,
                ...(device.reactNative ? { version: device.reactNative } : {}),
            },
            ...(input.console?.length ? { console: input.console } : {}),
            ...(input.network?.length ? { network: input.network } : {}),
        },
        status: "open",
        thread: [],
        // A person's note only: an agent's is never kept from the agent.
        ...(input.peopleOnly && !input.agentName ? { peopleOnly: true } : {}),
    };
}

/** The pin's number a note was made with. */
export const pinOf = (a: Annotation): number | undefined => {
    const pin = (a.context?.screenshot as { pin?: unknown } | undefined)?.pin;
    return typeof pin === "number" ? pin : undefined;
};

/** A route as notes file it: `/` when the app does not say, and always with its leading slash. */
export const routeName = (route: string | undefined) => {
    const r = route?.trim() || "/";
    return r.startsWith("/") ? r : `/${r}`;
};
