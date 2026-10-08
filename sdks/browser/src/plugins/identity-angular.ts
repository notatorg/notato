import type { IdentityPlugin } from "@notato/core";

/**
 * What Angular's development builds put on `window.ng` (its debugging API, the one Angular DevTools uses). Production
 * builds leave it out, and so does this plugin: it then returns nothing.
 */
interface AngularDebugApi {
    /** The component whose template the element is in. */
    getOwningComponent?(el: Element): object | null;
    /** The component the element is the host of, when it is one. */
    getComponent?(el: Element): object | null;
    getHostElement?(component: object): Element | null;
}

const ngOf = (el: Element): AngularDebugApi | undefined => {
    const ng = (el.ownerDocument?.defaultView as { ng?: AngularDebugApi } | null)?.ng;
    return typeof ng?.getOwningComponent === "function" ? ng : undefined;
};

/**
 * A component's class name, as written: development builds keep names. A bundler that had to rename a class (two of
 * the same name) adds a `_` in front or a `$1` behind, which are dropped.
 */
export function angularComponentName(component: object | null | undefined): string | undefined {
    const name = (component?.constructor as { name?: string } | undefined)?.name;
    if (!name || name === "Object") return undefined;
    return name.replace(/^_+/, "").replace(/\$\d+$/, "") || undefined;
}

/**
 * The components around an element, outermost first (`["App", "ProductList", "ProductCard"]`): the one whose template
 * the element is in, then the one whose template that one's host element is in, and so on.
 */
export function angularComponentPath(el: Element, ng: AngularDebugApi, limit = 8): string[] {
    const names: string[] = [];
    const seen = new Set<object>();
    let component = ng.getComponent?.(el) ?? ng.getOwningComponent?.(el) ?? null;
    while (component && !seen.has(component) && names.length < limit) {
        seen.add(component);
        const name = angularComponentName(component);
        if (name && names[names.length - 1] !== name) names.push(name);
        const host = ng.getHostElement?.(component);
        component = host ? (ng.getOwningComponent?.(host) ?? null) : null;
    }
    return names.reverse();
}

/**
 * Names the Angular component an element belongs to, and the components around it, from Angular's development-mode
 * debugging API. On a page that is not an Angular app in development, it returns nothing and never throws. Angular
 * records no source file for an element, so there is no `source`: the component's name is where to look.
 */
export function angularIdentityPlugin(): IdentityPlugin {
    return {
        id: "angular",
        resolve(el) {
            try {
                const ng = ngOf(el);
                if (!ng) return {};
                const path = angularComponentPath(el, ng);
                const name = path[path.length - 1];
                if (!name) return {};
                return { component: { name, ...(path.length >= 2 ? { path } : {}) } };
            } catch {
                return {};
            }
        },
    };
}
