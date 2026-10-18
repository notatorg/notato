# One checkout connection for the app and agent

Choose a Local or remote connection once per checkout. The app and `notato dev` read the same private profile;
changing destination does not move or mirror existing feedback. The account-free local server remains available.
These commands require a build containing the connection-profile feature; installing an older published package
will not add them.

## Connect a shared or Cloud checkout

In the board open **Team and checkouts → Set up app and agent → Download checkout connection**. From your app's
repository, import that download:

```sh
npx notato connection import ~/Downloads/notato-checkout.json --name cloud
npx notato run -- npm run dev
```

Import verifies both credentials against the server: they must be an app key and agent key for the same active
checkout and project. Failed verification leaves the selected profile unchanged. Keep the agent's MCP entry as
`npx notato dev` (existing `init` entries with a local `--project` are supported). The selected profile supplies
the Cloud project instead. An agent started outside this checkout can use `--connection-root /path/to/checkout`.

The toolbar displays the selected destination. Its **Settings → Server and agent** view shows the checkout,
branch label, server and project. This label is descriptive; credentials enforce routing on the server.
`npx notato doctor` follows the selected profile and checks the app loop using its scoped app key.

Use the app command appropriate to the project: `npm run dev`, `bun run dev`, or another command after `--`.
The wrapper preserves the folder you launch from, including a package below the checkout root. Vite and Next
browser SDK builds consume its public connection environment automatically; React, Angular and direct browser
controllers use the same resolution. This does not configure native/mobile SDKs or a separately launched app.
Those can still use the manual server/project/app-key settings.

## Switch destinations

Import creates a saved `local` destination alongside `cloud`. Configure its port/project when they differ from
the original local setup:

```sh
npx notato connection local --project my-local-project --port 4800
npx notato connection use cloud
npx notato connection use local
npx notato connection
```

The final command lists destinations without printing keys. Both destinations can use different project IDs.
For the saved Local profile without an explicit project, the app retains its existing project prop and the agent
retains the project restriction written by `init`. Set `--project` to make the local project explicit for both.

An app started by `notato run` is stopped and restarted when the profile file changes. The wrapper runs or attaches
to the local Notato service for Local, and starts no local Notato service for a remote profile. Stop and reconnect
the agent's Notato MCP session after switching; existing sessions disconnect instead of retaining old credentials.
Stop the previous agent's file edits before continuing: disconnecting a tool cannot stop an agent editing files.
Existing work claims retain their recovery rules. A switch does not automatically release a claim to another agent.

Cloud unavailability never selects Local. Invalid profiles stop capture/startup; an invalid profile change stops
the running wrapped app. Correct/select the profile to restart it. Applications launched separately must be stopped
and relaunched through the wrapper to receive profile changes. Static builds need rebuilding with the selected
connection; changing a local file cannot rewrite a deployed preview.

## Credential storage and precedence

`.notato.connection.json` belongs to this checkout and is added to `.gitignore`, including its temporary write
files. Writes are atomic and owner-only (0600 on POSIX). The CLI refuses tracked files and symlinks. Each Git
worktree has its own connection; profile discovery stops at its Git boundary. Remove the downloaded copy after
importing, and keep the profile out of archives/shared folders. Deleting a local file does not revoke its keys;
use the server's credential controls or archive the checkout.

The app subprocess receives `VITE_NOTATO_CONNECTION` and `NEXT_PUBLIC_NOTATO_CONNECTION` with only the browser
portion: destination, project, checkout label and app key. The agent key stays in the private profile and is removed
from the app subprocess's `NOTATO_AGENT_TOKEN` environment. App keys are visible in browser builds by design;
use separate capture-only credentials for a public/shared PR preview. Do not deploy a personal checkout profile
as a production app configuration.

A profile replaces the server, project and app credential together, overriding older inline SDK props and legacy
server environment settings. Returning locally clears the remote app credential. Existing CLI `--server`/`--token`
setup works when no checkout profile exists. With a profile, select the destination through `connection use` so
manual CLI overrides cannot make the app and agent silently diverge. The existing `notato start` command always
starts a local service; use `notato run` for an app that follows the selected destination.

There is no automatic history transfer or continuous Local/Cloud sync. Existing notes stay in their original
service and data folder.
