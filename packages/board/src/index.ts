// What a hosted board imports: `mountBoard` with its extension, and the pieces its own pages are made from.
export * from "./api.ts";
export { type BoardOptions, mountBoard } from "./board.tsx";
export * from "./extension.tsx";
export { go, href, projectHref, type Route, useRoute } from "./route.ts";
export { Icon, type IconName, Logo } from "./ui.tsx";
