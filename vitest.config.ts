import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // The server, CLI, board and extension are tested with `bun test` instead (the server needs bun:sqlite).
        // Every SDK written in TypeScript keeps its tests in test/; the others have their own tools.
        include: ["packages/{schema,core,vite}/test/**/*.test.ts", "sdks/*/test/**/*.test.ts"],
        environment: "node",
        environmentOptions: {
            happyDOM: {
                // Same-origin iframe fixtures need their own document and window.
                settings: { enableIframePageLoading: true },
            },
        },
    },
});
