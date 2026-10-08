# @notato/vite

A Vite plugin for [Notato](https://github.com/notatorg/notato). It records where each element is written in your source, so a note pinned to a built app still tells your coding agent the exact file, line and column, not just the component name and a selector.

React only knows which file an element came from in a development build. An app that is built and previewed (`vite build --watch` with `vite preview`, a staging build) loses that. This plugin adds a `data-notato-src="src/Checkout.tsx:42:9"` attribute to every element your JSX writes, and the Notato toolbar reads it.

## Install

```sh
npm i -D @notato/vite
```

Add it to your Vite config, next to the React plugin:

```ts
import react from "@vitejs/plugin-react";
import { notatoSource } from "@notato/vite";
import { defineConfig } from "vite";

export default defineConfig({
    plugins: [notatoSource(), react()],
});
```

Or let `npx notato init --plugin` do it for every Vite app in the repository.

It does nothing unless `VITE_NOTATO=true` is set where the build runs (in the environment or a `.env` file), so any other build, and every test that loads the config, is exactly what it was.

## Options

| Option    | Default                                 | What it does                                                                                                                          |
| --------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled` | `VITE_NOTATO` is `true`                 | Turns tagging on or off, whatever the environment says.                                                                               |
| `root`    | the repository root above the Vite root | The folder recorded paths start from, so in a repository of several apps a path begins with the app's folder. No repository: the Vite root. |

## What it tags

Host elements only: `<div>`, `<button>`, SVG and MathML elements, and custom elements (`<my-widget>`). Components, member tags such as `<motion.div>` and fragments are left alone, and so are React Three Fiber's lowercase tags, which are three.js objects rather than elements of the page. The attribute is inserted and nothing else is rewritten, so the source map stays exact.

Works with Vite 5 and later, for `.jsx` and `.tsx` files outside `node_modules`.
