# Notato website

The promotional site for Notato: one static page with an animated demo of the loop, interactive tiles for each feature, and a button that loads the real toolbar onto the page.

```bash
bun run site           # build into site/dist, serve it on http://localhost:4810, rebuild when site/src changes
bun run build:site     # build once
```

`site/dist` is plain static files (`index.html`, `site.css`, `site.js`, `live.js`, `notato.png`), so any static host serves it: GitHub Pages, Netlify, an S3 bucket, `npx serve site/dist`.

## What is in it

- `src/index.html`, `src/site.css`, `src/site.js`: the page, written by hand. No framework and no build step for these three; the build copies them. `src/highlight.js` colours code here and in the docs.
- `src/docs.css`, `src/docs.js`: the docs pages' layout, copy buttons and outline.
- `src/live.ts`: the real toolbar, from `sdks/browser` (`createController` in test mode, no server). The build bundles it into `live.js`, and the page loads it only when someone presses **Put Notato on this page**. Notes stay in that browser, and **Download zip** in its Export menu gives the zip a tester would send.
- `build.ts`: also renders the Markdown samples in the "What the agent reads" tile with the real renderer (`renderAnnotation` from `packages/core`), from the same note the hero demo files, and writes them into the page. Change the renderer and the site shows the change on the next build.

`bun site/build.ts --artifact` also writes `dist/artifact.html`, the page without its `<html>`, `<head>` and `<body>` wrapper, for hosts that supply their own.

## The docs

`site/dist/docs/` is a page per setup: React apps, any page and the Chrome extension, SwiftUI, Android, .NET MAUI, real phones, your coding agent, testers and servers, then everything Notato does and its known limits. `docs.ts` makes them from the READMEs at build time, so they say exactly what the READMEs say:

- Each SDK's README (`swift/`, `android/`, `dotnet/`) is a page of its own, without its title and its Development section.
- The main README is cut into pages by heading: `PAGES` in `docs.ts` lists which sections go on which page. The build fails if a listed heading is missing, and warns about any section of the README that is on no page.
- Links are pointed at the page that now has the section; links to other files in the repository go to GitHub.

Rename a README heading and update `PAGES` to match. `bun run site` rebuilds the docs when a README changes.

## Publishing

The release workflow builds the site from each release tag, so the docs describe what that release installs, and deploys it to GitHub Pages once `PUBLISH_SITE` is on (see [RELEASING.md](../RELEASING.md)). Until the packages are on npm, the quick start's `npm i -D notato @notato/react` does not work yet.

## Notes

- Motion respects `prefers-reduced-motion`: the demo jumps to the end of each story instead of playing it, and nothing loops.
- The demo pauses while it is off screen or the tab is hidden, and has its own pause button.
- Light and dark follow the system setting. The demo app, the terminal and the sticky notes keep their own colours in both.
