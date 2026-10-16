# @notato/browser

The Notato toolbar for any web page, with no framework in it: people pin notes to elements of your running app, and the notes reach your coding agent (Claude Code, Codex, Cursor and others) over MCP through a Notato server.

```bash
npm i -D notato @notato/browser
npx notato        # the server, the board and MCP for your agent
```

```ts
import { createController } from "@notato/browser"

if (import.meta.env.DEV) createController({ project: "checkout-web", server: "http://localhost:4747" })
```

## Good to know

- In an app built with Vite, `notatoEnvironment()` from `@notato/browser/env` reads `VITE_NOTATO` (`true` or `false`) and `VITE_NOTATO_SERVER`, as `<Notato />` and `provideNotato` do, without loading the toolbar: `if (notatoEnvironment().enabled ?? import.meta.env.DEV) createController(...)`.

- On a page with many notes, pins are drawn for the newest 150 on that page, as in the native SDKs. The toolbar's count, the copied Markdown and the board have every note.
- With a shared server that takes tokens (`notato serve`, or a server built on it), use version 0.3.0 or later: 0.2.0 predates authenticated event streams and project-scoped capability requests. Give the SDK an **app/tester** token; **agent** tokens are for MCP. Version 0.3 also works with a 0.2 server.
- Status filters are negotiated through `/config`. Older servers are read without a status filter, so a new SDK does not send them unknown states such as `awaiting_response`.
- Notato's styles are constructed stylesheets, which a strict Content-Security-Policy (`style-src` without `'unsafe-inline'`) allows. A browser too old for those (Safari before 16.4) gets `<style>` elements instead: pass the nonce your policy allows as `nonce` and they carry it. The script tag from a Notato server passes its own nonce on.

React apps use [`@notato/react`](https://www.npmjs.com/package/@notato/react), the same toolbar as a component, and Angular apps [`@notato/angular`](https://www.npmjs.com/package/@notato/angular). A page you cannot change takes it from the server instead: a script tag, a bookmark or the browser extension.

The options, what the agent receives and how the loop works are in the [Notato README](https://github.com/notatorg/notato#readme).


### Grouped reviews, references and hiding completed notes

Use **Start a grouped review** in the toolbar to write one shared instruction, then
annotate each related target. Navigate to other pages in the same app as needed.
The targets remain drafts in this browser until **Send review**; the agent receives
linked notes with their own routes and screenshots. Reviews hold at most 50 targets
and survive reloads using IndexedDB. Draft storage is scoped to the server, project,
mode and credential. Changing a token does not carry another credential's drafts over.
Use **Discard review** to remove only its unsent drafts. **Download review** saves a ZIP backup without sending or discarding it, including if browser storage is full. Normal exports exclude drafts.

The annotation composer also accepts up to **three reference images** (PNG, JPEG or
WebP). Each input can be at most 16 MB and 16 megapixels. The browser strips metadata,
resizes to at most 2048 pixels on the longest side and encodes WebP; each resulting
attachment must fit within 5 MB. References use the same private asset access and
storage accounting as screenshots. They are deliberate uploads, independent of the
automatic screenshot switch. New server capabilities enable these controls; older
servers keep ordinary capture working without silently dropping a review or image.

On a resolved or reverted note, **Hide from this app** hides the SDK pin/card in this
browser. It never deletes the note or changes the dashboard. Settings → **Restore
hidden annotations** brings them back. A reopened task or a new agent question is
visible even if it was hidden while completed.

Agents can call **notato_ask_question** to put a task in **Needs your answer**.
Reply in the app or dashboard to resume it; an aside or a People only reply stays
private and does not resume the agent. The waiting task retains any variant pick
or revert request. `notato_get_review` reads every target before a shared fix.
Reference bytes are downloaded only when the dashboard opens them or an agent
calls `notato_get` (use `references: false` when only text is needed).

These capture controls are shared by the browser, React and Angular SDKs. Native
capture controls remain unchanged; the shared question state is readable by them.
