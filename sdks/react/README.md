# @notato/react

For hosted Notato, use version **0.2.1 or later**. Published 0.2.0 predates authenticated event streams and project-scoped capability requests. Create an **App/tester** token for the SDK; **Agent** tokens are for MCP.

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

## On or off from where the app is built

In an app built with Vite, two variables in the environment it is built or served from (the shell, a `.env` file, or [.NET Aspire](https://github.com/notatorg/notato/tree/main/sdks/dotnet/src/Notato.Aspire#readme)) win over the props:

- `VITE_NOTATO`: `true` (or `1`, `yes`, `on`) starts the toolbar, in a production build too, such as one made with `vite build --watch` and served with `vite preview`. `false` (or `0`, `no`, `off`) keeps it off, in development too. Anything else, or nothing, leaves it to `enabled` and the kind of build.
- `VITE_NOTATO_SERVER`: the server, over `server`.

`VITE_NOTATO` is also what [`@notato/vite`](https://www.npmjs.com/package/@notato/vite) records source positions under, so one variable turns the lot on. A guard around `<Notato />` decides first: for an app that is built and previewed, write it as `npx notato init` does there, `{(import.meta.env.DEV || import.meta.env.VITE_NOTATO === "true") && <Notato … />}`, and a build without the variable still ships nothing of Notato. Other bundlers do not pass `VITE_` variables to the page; pass `enabled` and `server` from your own there.

## Example

[`example/`](https://github.com/notatorg/notato/tree/main/sdks/react/example) is a small Vite app with the toolbar: `bun install` at the repository root, then `bun run dev` in `sdks/react/example`. Its notes go to `http://localhost:4747` unless the page's URL says otherwise (`?server=http://localhost:4799`), and `?mode=test` or `?mode=agent` switch the mode.
