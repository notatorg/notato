# @notato/react

Notato for React: render `<Notato />` once and people can pin notes to elements of your running app. The notes, with screenshots, the React component and its source file, reach your coding agent (Claude Code, Codex, Cursor and others) over MCP through a Notato server.

```bash
npm i -D notato @notato/react
npx notato init   # adds <Notato /> behind a dev-only guard and sets up your coding agents
```

Or by hand:

```tsx
import { Notato } from "@notato/react"

{import.meta.env.DEV && <Notato project="checkout-web" server="http://localhost:4747" />}
```

It is [`@notato/browser`](https://www.npmjs.com/package/@notato/browser) as a component, and exports everything that package does. The props, what the agent receives and how the loop works are in the [Notato README](https://github.com/notatorg/notato#readme).

A changed prop restarts the toolbar with it: the token, the author, `persist` and the rest. `plugins` and `transport` are read as it starts; give `<Notato />` a new `key` to change those. If the toolbar cannot load, the console says why.

## Example

[`example/`](https://github.com/notatorg/notato/tree/main/sdks/react/example) is a small Vite app with the toolbar: `bun install` at the repository root, then `bun run dev` in `sdks/react/example`. Its notes go to `http://localhost:4747` unless the page's URL says otherwise (`?server=http://localhost:4799`), and `?mode=test` or `?mode=agent` switch the mode.
