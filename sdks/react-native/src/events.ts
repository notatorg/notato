/** One server-sent event: its name and its data, parsed as JSON when it is JSON. */
export interface ServerEvent {
    event: string;
    data: unknown;
}

/**
 * Reads a text/event-stream as it arrives. Feed it the response text so far (React Native's XMLHttpRequest gives the
 * whole text on each progress event); it returns the events completed since the last call.
 */
export function createEventParser(): (textSoFar: string) => ServerEvent[] {
    let consumed = 0;
    return (textSoFar) => {
        const events: ServerEvent[] = [];
        let end = textSoFar.indexOf("\n\n", consumed);
        while (end >= 0) {
            const block = textSoFar.slice(consumed, end);
            consumed = end + 2;
            let event = "message";
            const data: string[] = [];
            for (const line of block.split("\n")) {
                if (line.startsWith(":")) continue;
                if (line.startsWith("event:")) event = line.slice(6).trim();
                else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
            }
            if (data.length) {
                const raw = data.join("\n");
                let parsed: unknown = raw;
                try {
                    parsed = JSON.parse(raw);
                } catch {
                    // plain text
                }
                events.push({ event, data: parsed });
            }
            end = textSoFar.indexOf("\n\n", consumed);
        }
        return events;
    };
}
