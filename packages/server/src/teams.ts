import type { Annotation } from "@notato/schema";
import type { ShotLinks } from "./share.ts";

// The `teams` webhook format: what a Microsoft Teams workflow ("Post to a channel when a webhook request is received",
// and the chat version) expects. That is a message whose attachments are Adaptive Cards; the workflow posts each card.
// Given anything else, the template tries to post the whole body as a card, and Teams answers BadRequest.

const clip = (s: string, n: number) => {
    const t = s.trim();
    return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

const who = (author: { kind: string; name?: string }) =>
    author.name ?? (author.kind === "agent" ? "Agent" : "Someone");

/** What happened, as the card's heading. */
function headline(event: string, a: Annotation): string {
    const last = a.thread[a.thread.length - 1];
    switch (event) {
        case "annotation.created":
            // A note without a name says nothing about who; "from Someone" would only be noise.
            return a.author.name || a.author.kind === "agent"
                ? `New note from ${who(a.author)}`
                : "New note";
        case "annotation.replied":
            return last ? `${who(last.author)} replied` : "New reply";
        case "annotation.variants_ready":
            return "Versions ready to compare";
        case "annotation.variant_chosen":
            return a.variants?.chosen ? `Picked “${a.variants.chosen}”` : "Version picked";
        case "annotation.revert_requested":
            return "Revert requested";
        default: {
            const what = event.replace(/^annotation\./, "").replace(/_/g, " ");
            return what.charAt(0).toUpperCase() + what.slice(1);
        }
    }
}

/** Only a web address can be opened from Teams; an app's own scheme would make the whole card invalid. */
const webUrl = (url: string) => {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "https:" || parsed.protocol === "http:"
            ? parsed.toString()
            : null;
    } catch {
        return null;
    }
};

export function adaptiveCard(
    event: string,
    a: Annotation,
    links?: ShotLinks
): Record<string, unknown> {
    const target = a.target.identity[0];
    const pin = (a.context.screenshot as { pin?: unknown } | undefined)?.pin;
    const last = a.thread[a.thread.length - 1];
    // A status change with a note, or a reply: what was just said is the news, under the note it is about.
    const latest =
        event !== "annotation.created" && event !== "annotation.deleted" ? last : undefined;

    const facts = [
        { title: "Page", value: a.route },
        { title: "Status", value: a.status.replace(/_/g, " ") },
        a.severity ? { title: "Severity", value: a.severity } : null,
        a.intent ? { title: "Intent", value: a.intent } : null,
        a.author.name || a.author.kind === "agent" ? { title: "From", value: who(a.author) } : null,
        target
            ? {
                  title: "Element",
                  value: clip(
                      `${target.role ?? target.tag}${target.name ? ` “${target.name}”` : ""}`,
                      120
                  ),
              }
            : null,
        target?.component ? { title: "Component", value: target.component.name } : null,
    ].filter((f) => f !== null);

    const body: Array<Record<string, unknown>> = [
        {
            type: "TextBlock",
            text: `Notato · ${a.projectId}${typeof pin === "number" ? ` · #${pin}` : ""}`,
            size: "Small",
            isSubtle: true,
            spacing: "None",
        },
        {
            type: "TextBlock",
            text: headline(event, a),
            size: "Medium",
            weight: "Bolder",
            wrap: true,
            spacing: "Small",
        },
        { type: "TextBlock", text: clip(a.comment, 1000), wrap: true },
    ];
    if (links?.full) {
        // Teams fetches it from the link, which works without signing in (see share.ts); a tap opens it full size.
        body.push({
            type: "Image",
            url: links.full,
            altText: "The page, with what the note is about outlined",
            size: "Stretch",
            selectAction: { type: "Action.OpenUrl", url: links.full },
        });
    }
    if (latest) {
        body.push({
            type: "Container",
            style: "emphasis",
            items: [
                {
                    type: "TextBlock",
                    text: who(latest.author),
                    weight: "Bolder",
                    size: "Small",
                    spacing: "None",
                },
                { type: "TextBlock", text: clip(latest.body, 1000), wrap: true, spacing: "Small" },
            ],
        });
    }
    body.push({ type: "FactSet", facts });

    const url = webUrl(a.url);
    return {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.4",
        msteams: { width: "Full" },
        body,
        ...(url ? { actions: [{ type: "Action.OpenUrl", title: "Open the page", url }] } : {}),
    };
}

/** The body a Teams workflow takes: a message carrying one Adaptive Card. */
export function teamsMessage(event: string, a: Annotation, links?: ShotLinks) {
    return {
        type: "message",
        attachments: [
            {
                contentType: "application/vnd.microsoft.card.adaptive",
                contentUrl: null,
                content: adaptiveCard(event, a, links),
            },
        ],
    };
}
