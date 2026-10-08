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

- On a page with many notes, pins are drawn for the newest 150 on that page, as in the native SDKs. The toolbar's count, the copied Markdown and the board have every note.
- Notato's styles are constructed stylesheets, which a strict Content-Security-Policy (`style-src` without `'unsafe-inline'`) allows. A browser too old for those (Safari before 16.4) gets `<style>` elements instead: pass the nonce your policy allows as `nonce` and they carry it. The script tag from a Notato server passes its own nonce on.

React apps use [`@notato/react`](https://www.npmjs.com/package/@notato/react), the same toolbar as a component, and Angular apps [`@notato/angular`](https://www.npmjs.com/package/@notato/angular). A page you cannot change takes it from the server instead: a script tag, a bookmark or the browser extension.

The options, what the agent receives and how the loop works are in the [Notato README](https://github.com/notatorg/notato#readme).
