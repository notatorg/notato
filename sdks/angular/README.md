# Notato for Angular

People pin notes to elements of your running Angular app, and the notes reach your coding agent (Claude Code, Codex, Cursor and others) over MCP through a Notato server. Each note says which component the element belongs to and the components around it (`ProductCard` in `App › ProductList › ProductCard`), with a screenshot of what the person saw.

Angular 19 and later.

## Set up

```bash
npm i -D notato @notato/angular
npx notato        # the server, the board and MCP for your agent
```

Add it to the app's providers, in `app.config.ts`:

```ts
import { type ApplicationConfig } from "@angular/core"
import { provideNotato } from "@notato/angular"

export const appConfig: ApplicationConfig = {
    providers: [provideNotato({ project: "shop" })],
}
```

Press **Alt+Shift+A** (or the toolbar's Annotate button), click an element, write what should change, and save. Then ask your agent to watch Notato and fix what comes in.

`provideNotato` takes the same options as the other web SDKs (`server`, `token`, `mode`, `appName`, `plugins` and the rest: see [SDK props](../../README.md#sdk-props)). Plugins come from `@notato/browser`:

```ts
import { consolePlugin, networkPlugin } from "@notato/browser"

provideNotato({ project: "shop", plugins: [consolePlugin(), networkPlugin()] })
```

The toolbar runs outside Angular's zone: following the page as it scrolls, its timers and the server's live updates never set off change detection in an app that uses zone.js. If it cannot load, the console says why.

## In production

It starts only in development builds (`isDevMode()`), unless you pass `enabled: true`, for a staging build say, with a project token. The toolbar is a separate chunk that is only loaded when it starts, so a production build carries a few hundred bytes of it and never loads the rest. During server-side rendering it does nothing, and on the browser it starts once the app does.

## What the agent gets

The element's selector, test id, role and text, its computed styles, and its component: the class whose template the element is in, read from Angular's development-mode debugging API (`ng.getOwningComponent`, the one Angular DevTools uses), and the chain of components around it. Angular records no source file for an element, so the agent is told the component's name rather than a line; it finds the file from there. In a production build without that API, a note has the selector and the rest, without the component.

## Known limits

- Component names need a development build. A component class that two files both name `ProductCard` is reported under that name, without saying which.
- Everything else is the browser SDK's: see [Known limits](../../README.md#known-limits).

## Development

```bash
bun install                                 # at the repository root
bunx vitest run sdks/angular                # the provider
cd sdks/angular/example && npx ng serve     # the example: a shop with a product list (Node 24.15 or later)
```

Open `http://localhost:4200/?server=http://localhost:4799` to send its notes to a scratch server (`npx notato dev --port 4799`) rather than the one on 4747. The example compiles the SDKs from source, which is why its `tsconfig.json` allows `.ts` imports.
