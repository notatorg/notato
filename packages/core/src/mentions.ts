/**
 * `@name` in a note or a reply calls one of the server's mention plugins (`@jira`, `@slack`). Names are a letter then
 * letters, digits or dashes, matched as a word in any case: `@jira`, `@Jira,` and `(@jira)` count; `me@jira.dev` and
 * `@@jira` do not. Mentions are for plugins only: everything people write reaches the agent without one.
 */
export const MENTION = /(^|[^\w@.])@([a-z][\w-]{0,31})\b/gi;

/** The names mentioned in a text, lowercased, each once, in order. */
export function mentionsIn(text: string | undefined | null): string[] {
    if (!text) return [];
    const names: string[] = [];
    for (const match of text.matchAll(MENTION)) {
        const name = (match[2] ?? "").toLowerCase();
        if (name && !names.includes(name)) names.push(name);
    }
    return names;
}
