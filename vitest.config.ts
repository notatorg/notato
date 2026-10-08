import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // server and cli are Bun-only (bun:sqlite) and run under `bun test`.
        // Every SDK written in TypeScript keeps its tests in test/ (the others have their own tools).
        include: ["packages/{schema,core,vite}/test/**/*.test.ts", "sdks/*/test/**/*.test.ts"],
        environment: "node",
    },
});
