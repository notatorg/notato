import type { Annotation } from "@notato/schema";

export type EventType = "created" | "updated" | "replied" | "deleted";

export interface NotatoEvent {
    type: EventType;
    projectId: string;
    id: string;
    seq: number;
    annotation: Annotation;
    /** For a change: what it was just before, so a listener can tell what changed without remembering. */
    previous?: { status: Annotation["status"]; offeredAt?: string };
    /** One of many notes going at once (a whole project deleted): not something to tell a team about note by note. */
    bulk?: true;
}

export type Listener = (event: NotatoEvent) => void;

/** In-process fan-out behind SSE and `notato_watch`. */
export class EventBus {
    private listeners = new Set<Listener>();

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    publish(event: NotatoEvent) {
        for (const listener of [...this.listeners]) {
            try {
                listener(event);
            } catch {
                // one broken subscriber must not stop the others
            }
        }
    }

    get size() {
        return this.listeners.size;
    }
}
