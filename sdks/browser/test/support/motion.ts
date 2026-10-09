import { afterEach, beforeEach, vi } from "vitest";

/** A `matchMedia` that answers yes to asking for less motion, and no to anything else. */
export function reducedMotion(): void {
    vi.spyOn(window, "matchMedia").mockImplementation(
        (query: string) =>
            ({
                matches: /prefers-reduced-motion:\s*reduce/.test(query),
                media: query,
                onchange: null,
                addEventListener: () => {},
                removeEventListener: () => {},
                addListener: () => {},
                removeListener: () => {},
                dispatchEvent: () => false,
            }) as MediaQueryList
    );
}

/**
 * For tests about what is shown rather than how it moves: the system asks for less motion, so panels, cards and toasts
 * come and go at once, as they did before they were animated. How they move is tested in motion.test.ts.
 */
export function useReducedMotion(): void {
    beforeEach(reducedMotion);
    afterEach(() => {
        vi.mocked(window.matchMedia).mockRestore?.();
    });
}
