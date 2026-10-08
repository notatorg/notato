import type { WebhookDraft, WebhookView } from "./api.ts";

// What the webhook form shows and sends, kept apart from the component so it can be tested as plain data.

export const FORMATS: Array<{
    id: WebhookView["format"];
    label: string;
    about: string;
    placeholder: string;
    help: string;
}> = [
    {
        id: "slack",
        label: "Slack",
        about: "A one-line message in a channel.",
        placeholder: "https://hooks.slack.com/services/…",
        help: "In Slack: Apps › Incoming Webhooks › Add to Slack, pick the channel, and copy the Webhook URL.",
    },
    {
        id: "discord",
        label: "Discord",
        about: "A one-line message in a channel.",
        placeholder: "https://discord.com/api/webhooks/…",
        help: "In Discord: the channel's Edit Channel › Integrations › Webhooks › New Webhook › Copy Webhook URL.",
    },
    {
        id: "teams",
        label: "Teams",
        about: "A card in a channel or chat, through a Teams workflow.",
        placeholder: "https://….environment.api.powerplatform.com/…",
        help: "In Teams: the channel's ⋯ › Workflows › “Post to a channel when a webhook request is received”, then copy the URL it gives you.",
    },
    {
        id: "json",
        label: "JSON",
        about: "The whole annotation as JSON, for your own service, Power Automate, Zapier or n8n.",
        placeholder: "https://example.com/notato-hook",
        help: "Each event is a POST with the annotation, its Markdown and an X-Notato-Event header.",
    },
];

export const formatLabel = (f: WebhookView["format"]) =>
    FORMATS.find((x) => x.id === f)?.label ?? f;

/** Events in the order a person thinks of them, with the names they would use. */
export const EVENT_LABELS: Record<string, string> = {
    "annotation.created": "New note",
    "annotation.replied": "Reply",
    "annotation.acknowledged": "Acknowledged",
    "annotation.resolved": "Resolved",
    "annotation.dismissed": "Dismissed",
    "annotation.reopened": "Reopened",
    "annotation.variants_ready": "Versions ready",
    "annotation.variant_chosen": "Version picked",
    "annotation.revert_requested": "Revert requested",
    "annotation.reverted": "Reverted",
    "annotation.updated": "Other changes",
    "annotation.deleted": "Deleted",
};

export const eventLabel = (e: string) =>
    EVENT_LABELS[e] ?? e.replace(/^annotation\./, "").replace(/_/g, " ");

/** The server's events, in the order above, with any it knows that this list does not at the end. */
export const orderEvents = (events: string[]) => [
    ...Object.keys(EVENT_LABELS).filter((e) => events.includes(e)),
    ...events.filter((e) => !(e in EVENT_LABELS)),
];

export function eventsSummary(events: string[] | null): string {
    if (!events) return "Every event";
    if (events.length <= 3) return events.map(eventLabel).join(", ");
    return `${events.length} events`;
}

/** What the form holds while it is open. */
export interface WebhookForm {
    format: WebhookView["format"];
    name: string;
    /** What is typed; ignored when editing and the saved URL is kept. */
    url: string;
    /** Editing: a new URL is being typed instead of keeping the saved one. */
    replaceUrl: boolean;
    project: string;
    allEvents: boolean;
    events: string[];
    secret: string;
    /** What to do with the saved secret when editing: keep it, use what is typed, or remove it. */
    secretAction: "keep" | "set" | "remove";
    /** Put the screenshot in the message (Teams and JSON can carry one). */
    screenshots: boolean;
}

/** The formats a message can carry a screenshot in. */
export const PICTURED: ReadonlyArray<WebhookView["format"]> = ["teams", "json"];

export function formFor(existing?: WebhookView): WebhookForm {
    return {
        format: existing?.format ?? "slack",
        name: existing?.name ?? "",
        url: "",
        replaceUrl: !existing,
        project: existing?.project ?? "",
        allEvents: !existing?.events,
        events: existing?.events ?? ["annotation.created"],
        // A secret named by environment variable is not a secret: it is shown so it can be changed.
        secret: existing?.secret.kind === "env" ? `env:${existing.secret.name}` : "",
        secretAction: existing ? "keep" : "set",
        screenshots: existing?.screenshots ?? true,
    };
}

/** What to send for the form. Leaving `url` or `secret` out keeps the saved one. */
export function draftOf(form: WebhookForm, existing?: WebhookView): WebhookDraft {
    const draft: WebhookDraft = {
        format: form.format,
        name: form.name.trim() || null,
        project: form.project.trim() || null,
        events: form.allEvents ? null : form.events,
    };
    if (!existing || form.replaceUrl) draft.url = form.url.trim();
    if (PICTURED.includes(form.format)) draft.screenshots = form.screenshots;
    if (form.format === "json") {
        if (form.secretAction === "remove") draft.secret = null;
        else if (form.secretAction === "set") draft.secret = form.secret.trim() || null;
    }
    return draft;
}

/** Why the form cannot be saved or tested yet, or null when it can. */
export function formProblem(form: WebhookForm, existing?: WebhookView): string | null {
    if (!existing || form.replaceUrl) {
        const url = form.url.trim();
        if (!url) return "Paste the webhook's URL.";
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
                return "The URL must start with https://.";
        } catch {
            return "That is not a URL.";
        }
    }
    if (!form.allEvents && form.events.length === 0)
        return "Choose at least one event, or Every event.";
    return null;
}
