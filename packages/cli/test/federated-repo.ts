import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tempDir, writeFiles } from "./helpers.ts";

// A repository of several React apps that load each other with Module Federation, for the tests of init, revert and
// doctor across apps.

/** A typical Vite + React entry file. */
export const HOST_MAIN = `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./i18n/config";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App />
    </StrictMode>
);
`;

/** A Vite + React app's package.json; `extra` goes into its devDependencies. */
export const reactPkg = (name: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
        name,
        dependencies: { react: "^19" },
        devDependencies: { vite: "^7", ...extra },
    });
/** A Vite app's index.html, pointing at its entry. */
export const INDEX = '<div id="root"></div><script type="module" src="/src/main.tsx"></script>';
export const HOST_CONFIG = `import federation from "@originjs/vite-plugin-federation"
const remotes = Object.fromEntries([])
export default { plugins: [federation({ name: "host", remotes, shared: ["react"] })] }
`;
// Modules reach the shell's shared context through a remote of their own, so they declare `remotes` too.
export const REMOTE_CONFIG = `import federation from "@originjs/vite-plugin-federation"
export default {
  plugins: [
    federation({
      name: "orderHistory",
      remotes: {
        // The shell's permissions context.
        appShell: process.env.VITE_APP_SHELL_URL || "http://localhost:5000/assets/remoteEntry.js",
      },
      exposes: { "./routes": "./src/routes.tsx" },
      shared: ["react"],
    }),
  ],
}
`;

/**
 * A Module Federation monorepo: a federation host (app-shell, with notato installed), a module loaded into it
 * (order-history), a standalone app (developer-portal), a library, and folders that are not apps. `over` adds or
 * replaces files; `hostBin: false` leaves the notato binary out of the host's node_modules.
 */
export function federatedRepo(
    over: Record<string, string> = {},
    options: { hostBin?: boolean } = {}
) {
    const root = tempDir("notato-repo-");
    mkdirSync(join(root, ".git"));
    writeFiles(root, {
        ".gitignore": "node_modules\n",
        ".prettierrc.json": JSON.stringify({
            semi: true,
            singleQuote: false,
            tabWidth: 4,
            printWidth: 100,
        }),
        "app-shell/package.json": reactPkg("app-shell", { "@notato/react": "^0.1.0" }),
        "app-shell/index.html": INDEX,
        "app-shell/vite.config.ts": HOST_CONFIG,
        "app-shell/src/main.tsx": HOST_MAIN,
        "order-history/package.json": reactPkg("order-history"),
        "order-history/index.html": INDEX,
        "order-history/vite.config.ts": REMOTE_CONFIG,
        "order-history/src/main.tsx": HOST_MAIN,
        "developer-portal/package.json": reactPkg("developer-portal"),
        "developer-portal/index.html": INDEX,
        "developer-portal/vite.config.ts": "export default {}\n",
        "developer-portal/src/main.tsx": HOST_MAIN,
        "packages/federation/package.json": JSON.stringify({
            name: "fed",
            dependencies: { react: "^19" },
        }),
        "packages/federation/src/index.ts": "export {}\n",
        "node_modules/some-dep/package.json": reactPkg("some-dep"),
        "node_modules/some-dep/index.html": INDEX,
        "terraform/main.tf": "",
        ...over,
    });
    if (options.hostBin !== false)
        writeFiles(root, { "app-shell/node_modules/.bin/notato": "#!/bin/sh\n" });
    return root;
}
