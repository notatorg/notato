# Notato website

The source of notato.dev. It lives here, with the code it describes, so the docs it publishes are made from this repository's READMEs at build time and cannot drift from them: fix a docs page by fixing the README.

The promotional site for Notato: one static page with an animated demo of the loop, interactive tiles for each feature, and a button that loads the real toolbar onto the page.

```bash
bun run site           # build into site/dist, serve it on http://localhost:4810, rebuild when site/src or a README changes
bun run build:site     # build once
```

`site/dist` is plain static files (`index.html` and its CSS and scripts, `live.js`, `notato.png` and `docs/`), so any static host serves it, or `npx serve site/dist`.

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

[`.github/workflows/site.yml`](../.github/workflows/site.yml) (Actions > Website > Run workflow) builds the site and, if
*Deploy* is ticked, deploys it to Cloudflare as a Worker with static assets. It is manual on purpose, and it never runs
on a pull request or a fork.

- **preview** uses [`wrangler.preview.json`](wrangler.preview.json): a `workers.dev` address, marked `noindex`
  through `NOTATO_SITE_ENV=preview`.
- **production** uses [`wrangler.production.json`](wrangler.production.json): the `notato.dev` custom domain. Deploying
  it takes the hostname over from wherever it points now, so keep the old host serving until the preview is checked,
  then run it, then retire the old host.
- Put `CLOUDFLARE_API_TOKEN` (Workers edit rights) and `CLOUDFLARE_ACCOUNT_ID` in the `site-preview` and
  `site-production` GitHub environments, and a required reviewer on `site-production`.
- **Analytics.** Create a site under Cloudflare Web Analytics and set its token as the `NOTATO_SITE_ANALYTICS_TOKEN`
  variable of the `site-production` environment. The build then adds Cloudflare's cookieless beacon to every page of that
  deploy, and to nothing else: previews and local builds are never counted. The token is a public identifier.
- Locally: `bun run build:site`, then `bunx wrangler@4.151.1 deploy --config site/wrangler.preview.json` from the
  repository root. Check which Cloudflare account Wrangler is signed in to first (`wrangler whoami`): a `workers.dev`
  address carries that account's subdomain.
- `site/src/_headers` sets the security headers for every page.

## Notes

- Motion respects `prefers-reduced-motion`: the demo jumps to the end of each story instead of playing it, and nothing loops.
- The demo pauses while it is off screen or the tab is hidden, and has its own pause button.
- Light and dark follow the system setting. The demo app, the terminal and the sticky notes keep their own colours in both.
- CI builds the site on every push and pull request, so renaming a README heading that a docs page uses fails the build until `PAGES` in `docs.ts` is updated.
