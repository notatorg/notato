import { describe, expect, it } from "vitest";
import { isMac, shortcutLabel } from "../src/ui/dom.ts";

describe("shortcut labels", () => {
    it("are the Mac's own symbols on a Mac, where Alt is the Option key", () => {
        expect(shortcutLabel("Alt+Shift+KeyA", true)).toBe("⌥⇧A");
        expect(shortcutLabel("Alt+Shift+ArrowRight", true)).toBe("⌥⇧→");
        expect(shortcutLabel("Meta+Digit1", true)).toBe("⌘1");
    });

    it("are spelled out everywhere else", () => {
        expect(shortcutLabel("Alt+Shift+KeyA", false)).toBe("Alt + Shift + A");
        expect(shortcutLabel("Ctrl+KeyK", false)).toBe("Ctrl + K");
    });

    it("know a Mac from its platform, or from its user agent when there is none", () => {
        expect(isMac({ platform: "MacIntel", userAgent: "" })).toBe(true);
        expect(isMac({ platform: "Win32", userAgent: "" })).toBe(false);
        expect(
            isMac({ platform: "", userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)" })
        ).toBe(true);
    });
});
