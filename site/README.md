# Notato website

The promotional site for Notato: one static page with an animated demo of the loop, interactive tiles for each feature, and a button that loads the real toolbar onto the page.

```bash
bun run site           # build into site/dist, serve it on http://localhost:4810, rebuild when site/src or a README changes
bun run build:site     # build once
```

`site/dist` is plain static files (`index.html` and its CSS and scripts, `live.js`, `notato.png` and `docs/`), so any static host serves it: GitHub Pages, Netlify, an S3 bucket, `npx serve site/dist`.

## What is in it

- `src/index.html`, `src/site.css`, `src/site.js`: the page, written by hand. No framework and no build step for these three; the build copies them, and writes the release's version where the page says `{{version}}`.
- `src/base.css`: what the page and the docs share: the colours (light and dark), type, buttons, the top bar, code blocks and the footer. `src/highlight.js` colours code in both.
- `src/docs.css`, `src/docs.js`: the docs pages' layout, copy buttons and outline.
- `src/live.ts`: the real toolbar, from `sdks/browser` (`createController` in test mode, no server). The build bundles it into `live.js`, and the page loads it only when someone presses **Put Notato on this page**. Notes stay in that browser, and **Download zip** in its Export menu gives the zip a tester would send.
- `build.ts`: also renders the Markdown samples in the "What the agent reads" tile with the real renderer (`renderAnnotation` from `packages/core`), from the same note the hero demo files, and writes them into the page. Change the renderer and the site shows the change on the next build.

`bun site/build.ts --artifact` also writes `dist/artifact.html`, the page without its `<html>`, `<head>` and `<body>` wrapper, for hosts that supply their own.

## The docs

`site/dist/docs/` is a page per setup: React, Angular, any page and the Chrome extension, SwiftUI, Android, .NET MAUI, React Native, Flutter, real phones, your coding agent, testers and servers, then everything Notato does and its known limits. `docs.ts` makes them from the READMEs at build time, so they say exactly what the READMEs say:

- Each SDK's README under `sdks/` is a page of its own, without its title and its Development section.
- The main README is cut into pages by heading: `PAGES` in `docs.ts` lists which sections go on which page. The build fails if a listed heading is missing, and warns about any section of the README that is on no page. A few sections are only for the repository's front page (`LEFT_OUT`).
- Links are pointed at the page that now has the section; links to other files in the repository go to GitHub.

Rename a README heading and update `PAGES` to match. `bun run site` rebuilds the docs when a README changes.

## Publishing

The release workflow builds the site from each release tag, so the docs describe what that release installs, and deploys it to GitHub Pages once `PUBLISH_SITE` is on (see [RELEASING.md](../RELEASING.md)). Until the packages are on npm, the quick start's `npm i -D notato @notato/react` does not work yet.

## Notes

- Motion respects `prefers-reduced-motion`: the demo jumps to the end of each story instead of playing it, and nothing loops.
- The demo pauses while it is off screen or the tab is hidden, and has its own pause button.
- Light and dark follow the system setting. The demo app, the terminal and the sticky notes keep their own colours in both.
- CI builds the site on every pull request, so a README heading the docs need cannot go missing unnoticed.
