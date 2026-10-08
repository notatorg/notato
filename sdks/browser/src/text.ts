/** Text shortened to at most `max` characters, the last of them an ellipsis when anything was cut. */
export const clip = (text: string, max: number): string =>
    text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** `1 note`, `3 notes`. */
export const plural = (count: number, word: string): string =>
    `${count} ${word}${count === 1 ? "" : "s"}`;

/** What went wrong, fit to show: an error's message, or whatever else was thrown, as text. */
export const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

/** `fix` as `Fix`, for a value shown as a label. */
export const capitalize = (text: string): string =>
    `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
