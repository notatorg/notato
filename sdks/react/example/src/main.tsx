import { consolePlugin, Notato, type NotatoPlugin, networkPlugin } from "@notato/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

// The demo takes its mode and server from the URL, so each can be tried without editing code:
//   /                         dev mode, annotations go to the local server
//   /?mode=test               testers: annotations stay in the page until packaged into a zip
//   /?mode=test&server=URL    ...and the zip is also uploaded to a shared server
//   /?download=0              replace the zip sink with a no-op (handy in automated runs)
//   /?server=URL&token=notato_…  talk to a shared server (`notato serve`) with a project token
const params = new URLSearchParams(window.location.search);
const mode = (["dev", "test", "agent"] as const).find((m) => m === params.get("mode")) ?? "dev";
const defaultServer = import.meta.env.VITE_NOTATO_SERVER ?? "http://localhost:4747";
const server = params.get("server") ?? (mode === "test" ? undefined : defaultServer);

// Module scope keeps the plugin array stable across renders.
const plugins: NotatoPlugin[] = [consolePlugin(), networkPlugin()];
if (params.get("download") === "0") plugins.push({ id: "zip", deliver: async () => {} });

createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
        <App />
        <Notato
            mode={mode}
            project="checkout-web"
            appName="checkout-web"
            appVersion={import.meta.env.VITE_APP_VERSION ?? "0.0.0-demo"}
            server={server}
            token={params.get("token") ?? undefined}
            plugins={plugins}
        />
    </StrictMode>
);
