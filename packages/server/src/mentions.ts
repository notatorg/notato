import { mentionsIn } from "@notato/core";
import type { Annotation, Reply } from "@notato/schema";
import type { NotatoEvent } from "./events.ts";

/** A mention plugin as a page sees it: what to offer after `@`. */
export interface MentionInfo {
    name: string;
    description: string;
    /** Whether mentioning it does something now (a plugin that needs a connection it does not have yet, say). */
    available: boolean;
}

/** A note or a reply that mentioned a plugin. */
export interface Mention {
    /** The plugin's name, without the `@`. */
    name: string;
    projectId: string;
    annotation: Annotation;
    /** The reply that mentioned it, or undefined for the note itself. */
    reply?: Reply;
    /** What the person wrote: the note's comment or the reply's body. */
    text: string;
}

/**
 * Something people can call with `@name` in a note or a reply (`@jira`, `@slack`). The basic shape for now: a name and a
 * description for the `@` menu, whether it can be used right now, and a hook for when it is mentioned. None is built in:
 * mentions are for plugins, and the agent gets what people write without one.
 */
export interface MentionPlugin {
    /** A letter, then letters, digits or dashes; matched without case. */
    name: string;
    description: string;
    /** Default: always. */
    available?(): boolean;
    /** Lets pages know when `available` changes; returns how to stop. */
    watch?(changed: () => void): () => void;
    /** Called after a note or a reply that mentions it is stored. Errors are logged, never thrown at the person. */
    onMention?(mention: Mention): void | Promise<void>;
}

const NAME = /^[a-z][\w-]{0,31}$/;

/** The server's mention plugins: what `@` offers, and calling them when a note or a reply mentions them. */
export class MentionRegistry {
    private plugins = new Map<string, MentionPlugin>();
    private listeners = new Set<(mentions: MentionInfo[]) => void>();
    private unwatch = new Map<string, () => void>();

    constructor(
        plugins: MentionPlugin[] = [],
        private log: (message: string) => void = (m) => console.error(`[notato] ${m}`)
    ) {
        for (const plugin of plugins) this.register(plugin);
    }

    register(plugin: MentionPlugin): () => void {
        const name = plugin.name.toLowerCase();
        if (!NAME.test(name))
            throw new Error(
                `a mention plugin's name must be a letter then letters, digits or dashes: "${plugin.name}"`
            );
        this.unwatch.get(name)?.();
        this.plugins.set(name, plugin);
        if (plugin.watch)
            this.unwatch.set(
                name,
                plugin.watch(() => this.changed())
            );
        this.changed();
        return () => {
            if (this.plugins.get(name) !== plugin) return;
            this.unwatch.get(name)?.();
            this.unwatch.delete(name);
            this.plugins.delete(name);
            this.changed();
        };
    }

    /** Everything `@` can offer, available or not, by name. */
    list(): MentionInfo[] {
        return [...this.plugins.entries()]
            .map(([name, p]) => ({
                name,
                description: p.description,
                available: p.available?.() ?? true,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    /** The registered plugins a text mentions. */
    mentioned(text: string | undefined | null): string[] {
        return mentionsIn(text).filter((name) => this.plugins.has(name));
    }

    subscribe(listener: (mentions: MentionInfo[]) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Calls the plugins a note or a reply mentions, once it is stored. */
    handle(event: NotatoEvent) {
        const a = event.annotation;
        const reply = event.type === "replied" ? a.thread[a.thread.length - 1] : undefined;
        const text =
            event.type === "created"
                ? a.comment
                : reply && !reply.automatic
                  ? reply.body
                  : undefined;
        if (!text) return;
        for (const name of this.mentioned(text)) {
            const plugin = this.plugins.get(name);
            if (!plugin?.onMention) continue;
            Promise.resolve()
                .then(() =>
                    plugin.onMention?.({
                        name,
                        projectId: event.projectId,
                        annotation: a,
                        reply,
                        text,
                    })
                )
                .catch((error) =>
                    this.log(
                        `@${name} failed: ${error instanceof Error ? error.message : String(error)}`
                    )
                );
        }
    }

    private last = "";

    private changed() {
        const mentions = this.list();
        // Presence changes often (a watch starting, another session); only a different list is news.
        const key = JSON.stringify(mentions);
        if (key === this.last) return;
        this.last = key;
        for (const listener of [...this.listeners]) {
            try {
                listener(mentions);
            } catch {
                // one broken subscriber must not stop the others
            }
        }
    }
}
