import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { runInit } from "../src/init/init.ts";
import { addToViteEntry } from "../src/init/transforms.ts";
import { detectStyle, readPrettierConfig, resolveStyle } from "../src/style.ts";
import { federatedRepo, HOST_MAIN } from "./federated-repo.ts";
import { read, removeTempDirs, tempDir } from "./helpers.ts";

afterEach(removeTempDirs);

describe("matching the project's formatting", () => {
    it("reads semicolons and indentation from the file", () => {
        expect(detectStyle(HOST_MAIN)).toMatchObject({ semi: true, indent: "    ", quote: '"' });
        expect(detectStyle("import a from 'a'\nconst x = () => {\n  return 1\n}\n")).toMatchObject({
            semi: false,
            indent: "  ",
            quote: "'",
        });
        expect(detectStyle("import a from 'a';\nfunction f() {\n\treturn 1\n}\n").indent).toBe(
            "\t"
        );
    });

    it("prefers the prettier config the project enforces, found by walking up", () => {
        const root = federatedRepo();
        expect(readPrettierConfig(join(root, "app-shell/src"))).toEqual({
            semi: true,
            quote: '"',
            indent: "    ",
            printWidth: 100,
        });
        expect(resolveStyle("import a from 'a'\n", join(root, "app-shell"))).toMatchObject({
            semi: true,
            quote: '"',
            printWidth: 100,
        });
    });

    it("reads useTabs, singleQuote and the simple YAML form", () => {
        const root = federatedRepo({
            ".prettierrc.json": "",
            ".prettierrc": "semi: false\nsingleQuote: true\nuseTabs: true\nprintWidth: 120\n",
        });
        rmSync(join(root, ".prettierrc.json"));
        expect(readPrettierConfig(root)).toEqual({
            semi: false,
            quote: "'",
            indent: "\t",
            printWidth: 120,
        });
    });

    it("produces exactly what prettier would for a typical entry file", () => {
        const edit = addToViteEntry(
            HOST_MAIN,
            { project: "acme-storefront", server: "http://localhost:4747" },
            { semi: true, indent: "    ", quote: '"', printWidth: 100 }
        );
        expect(edit.source).toBe(`import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./i18n/config";
import App from "./App.tsx";
import { Notato } from "@notato/react";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <>
            <App />
            {import.meta.env.DEV && (
                <Notato mode="dev" project="acme-storefront" server="http://localhost:4747" />
            )}
        </>
    </StrictMode>
);
`);
    });

    it("keeps the element on one line when it fits, and breaks attributes when even that is too long", () => {
        const short = addToViteEntry(
            "import a from 'a'\nrender(<App />)\n",
            { project: "x", server: "http://h" },
            { semi: false, indent: "  ", quote: "'", printWidth: 200 }
        );
        expect(short.source).toContain(
            '{import.meta.env.DEV && <Notato mode="dev" project="x" server="http://h" />}'
        );
        const narrow = addToViteEntry(
            "render(<App />)\n",
            { project: "x", server: "http://localhost:4747" },
            { semi: false, indent: "  ", quote: '"', printWidth: 40 }
        );
        expect(narrow.source).toContain('<Notato\n      mode="dev"\n      project="x"\n');
    });

    it("uses the .render( one when there are several <App /> tags, and says so", () => {
        const source = `import { App } from "./App"\nconst unused = <App />\n\ncreateRoot(el).render(\n  <App />\n)\n`;
        const edit = addToViteEntry(
            source,
            { project: "p", server: "http://h" },
            detectStyle(source)
        );
        expect(edit.note).toContain("found 2 <App /> tags");
        expect(edit.source).toContain("const unused = <App />\n");
        expect(edit.source.match(/<Notato/g)).toHaveLength(1);
        expect(edit.source.indexOf("<Notato")).toBeGreaterThan(edit.source.indexOf(".render("));
    });
});

describe("init in a Next.js repo with prettier settings", () => {
    it("writes the client component in the project's style", async () => {
        const root = tempDir("notato-next-", {
            ".prettierrc.json": JSON.stringify({ semi: true, tabWidth: 4, printWidth: 100 }),
            "package.json": JSON.stringify({
                name: "storefront",
                dependencies: { react: "^19", next: "^15" },
            }),
            ".git/HEAD": "ref: refs/heads/main\n",
            "app/layout.tsx": `import "./globals.css";\n\nexport default function RootLayout({ children }) {\n    return (\n        <html>\n            <body>{children}</body>\n        </html>\n    );\n}\n`,
        });
        await runInit({ cwd: root, mcp: false });
        expect(read(root, "app/notato-dev.tsx")).toBe(`"use client";

import { Notato } from "@notato/react";

/** Mounts the Notato toolbar in development only; renders nothing in production builds. */
export function NotatoDev() {
    if (process.env.NODE_ENV !== "development") return null;
    return <Notato mode="dev" project="storefront" server="http://localhost:4747" />;
}
`);
        expect(read(root, "app/layout.tsx")).toContain('import { NotatoDev } from "./notato-dev";');
        // `<body>{children}</body>` was on one line; it is opened up so the toolbar gets its own, as prettier writes it.
        expect(read(root, "app/layout.tsx")).toContain(
            "            <body>\n                {children}\n                <NotatoDev />\n            </body>\n"
        );
    });
});
