import { useEffect, useState } from "react";

// Hash routes, so the server needs no fallback page:
//   #/                       every project
//   #/p/<project>            a project's inbox        #/p/<project>/a/<id>   with one annotation open
//   #/p/<project>/activity   what happened, newest first
//   #/p/<project>/overview   the numbers
//   #/p/<project>/connect    how to connect an app to it
//   #/p/<project>/settings   its name, tokens, and deleting it (admin)
//   #/tokens                 tokens (serve mode, admin)
//   #/settings               settings and webhooks (admin)

export type Tab = "inbox" | "activity" | "overview" | "connect" | "settings";
const TABS: readonly string[] = ["activity", "overview", "connect", "settings"];

export type Route =
    | { page: "home" }
    | { page: "tokens" }
    | { page: "settings" }
    | { page: "project"; project: string; tab: Tab; selected?: string };

const decode = (s: string) => {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
};

export function parseRoute(hash: string): Route {
    const path = hash.replace(/^#/, "").replace(/\/+$/, "") || "/";
    if (path === "/tokens") return { page: "tokens" };
    if (path === "/settings") return { page: "settings" };
    const project = /^\/p\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (project?.[1]) {
        const name = decode(project[1]);
        const rest = project[2] ?? "";
        const selected = /^a\/([^/]+)$/.exec(rest)?.[1];
        if (selected)
            return { page: "project", project: name, tab: "inbox", selected: decode(selected) };
        if (TABS.includes(rest)) return { page: "project", project: name, tab: rest as Tab };
        return { page: "project", project: name, tab: "inbox" };
    }
    return { page: "home" };
}

export function href(route: Route): string {
    switch (route.page) {
        case "home":
            return "#/";
        case "tokens":
            return "#/tokens";
        case "settings":
            return "#/settings";
        case "project": {
            const base = `#/p/${encodeURIComponent(route.project)}`;
            if (route.selected) return `${base}/a/${encodeURIComponent(route.selected)}`;
            return route.tab === "inbox" ? base : `${base}/${route.tab}`;
        }
    }
}

export const projectHref = (project: string, tab: Tab = "inbox", selected?: string) =>
    href({ page: "project", project, tab, selected });

/** Moves to a route. `replace` swaps the history entry, so stepping through a list does not fill Back. */
export function go(to: string, replace = false) {
    if (window.location.hash === to) return;
    if (replace) window.location.replace(to);
    else window.location.hash = to;
}

export function useRoute(): Route {
    const [route, setRoute] = useState(() => parseRoute(window.location.hash));
    useEffect(() => {
        const onChange = () => setRoute(parseRoute(window.location.hash));
        window.addEventListener("hashchange", onChange);
        return () => window.removeEventListener("hashchange", onChange);
    }, []);
    return route;
}
