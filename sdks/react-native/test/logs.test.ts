import { afterEach, describe, expect, it, vi } from "vitest";
import { captureConsole, type LogEntry } from "../src/logs.ts";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("the app's console messages", () => {
    it("are kept without the credentials in them", () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        const into: LogEntry[] = [];
        const release = captureConsole(() => 50, into);
        try {
            console.warn("request failed", {
                url: "/orders",
                headers: {
                    Authorization: "Bearer abc.def",
                    Cookie: "sid=s3cr3t",
                    "X-Api-Key": "k-123",
                },
                data: { password: "hunter2", refresh_token: "r-456" },
            });
            console.error("GET /me: Authorization: Bearer xyz-789 was refused");
            console.error("Set-Cookie: session=0ff1ce; Path=/");
        } finally {
            release();
        }
        const text = into.map((e) => e.message).join("\n");
        for (const secret of [
            "abc.def",
            "s3cr3t",
            "k-123",
            "hunter2",
            "r-456",
            "xyz-789",
            "0ff1ce",
        ])
            expect(text).not.toContain(secret);
        expect(into[0]?.message).toContain('"url":"/orders"');
        expect(into[0]?.message).toContain('"Authorization":"[redacted]"');
        expect(into[1]?.message).toBe("GET /me: Authorization: Bearer [redacted] was refused");
    });
});
