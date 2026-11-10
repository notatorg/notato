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

- `src/games/`: two small canvas games and a toy at `/games` (the home page and docs link to them from the top bar and the footer), with no build step and no dependencies. They share `kit.js` (a sharp canvas, the frame loop, synthesised sounds, a best score in `localStorage`, the start and end cards, and the ink-outline drawing style) and `games.css`.
  - **Spud Cannon** (`spud-cannon.js`): drag back to fire potatoes at the bug on top of a tower of potatoes (each tower a variety: Russ, Ruby, Sunny, Violet, Pip). Bugs come in Notato's severities (nit, minor, major, blocker) worth different points. Each bug moves the tower further away, a new one hops in every four bugs, hitting the tower sends its top potato flipping, and the day turns to night. Wind arrives at bug 3, the web's annoyances at bug 5 (a cookie banner, a support chat, a newsletter pop-up and a loading spinner, a new one every three bugs) and fidgety towers at bug 7. A camera frames the shot, follows the potato and closes in on what it hits. There is an easter egg too: now and then a golden crate floats down by the cannon, and opening it (tap it, shoot it, press Z, type `spudzooka` or the Konami code) gives you the Spudzooka for twelve seconds of rapid-fire rocket spuds. It scores nothing and leaves the bug alone: it is for blowing the potato towers apart (from the bottom, ideally) and bursting the annoyances, the cookie banner into cookies. Everything puts itself back together afterwards.
  - **Mash Pit** (`mash-pit.html`): a toy, not a game. The Spud Cannon scene with `data-mode="party"` on its stage: no score, a Spudzooka that never runs out, a row of towers to blow up (three to start, up to six), and buttons for spud rain (every tower puts up an umbrella), Payback (the tower lobs spuds at the cannon), an annoyance to blow up, and more towers. The extra towers are the same code as the main one: `withTower` lends them the `stack` name while they move, draw and get hit.
  - **Inbox Zero** (`note-toss.js`): swipe resolved notes into a bin across an office drawn in perspective. Every throw has the same arc, so the skill is aiming into the fan's wind. Notes come in Notato's severities and fly differently: a light nit drifts most and scores 3, a heavy blocker barely drifts and scores 2. Three misses end a run. The bin moves back, then slides, and evening comes as you bin more; five in a row sets the note on fire, worth double.
  - Both end with a card that can share the score (the share sheet, or the clipboard), and the hub shows each game's best score from this browser.
  - Add `?debug` to a game's address to put its state on `window` (`spudCannon`, `inboxZero`), with `debug.paused` and `tick(seconds)` to run it without animation frames.

`bun site/build.ts --artifact` also writes `dist/artifact.html`, the page without its `<html>`, `<head>` and `<body>` wrapper, for hosts that supply their own.

## The docs

`site/dist/docs/` is a page per setup: React, Angular, any page and the Chrome extension, SwiftUI, Android, .NET MAUI, React Native, Flutter, real phones, your coding agent, testers and servers, then everything Notato does and its known limits. `docs.ts` makes them from the READMEs at build time, so they say exactly what the READMEs say:

- Each SDK's README under `sdks/` is a page of its own, without its title and its Development section.
- The main README is cut into pages by heading: `PAGES` in `docs.ts` lists which sections go on which page. The build fails if a listed heading is missing, and warns about any section of the README that is on no page. A few sections are only for the repository's front page (`LEFT_OUT`).
- Links are pointed at the page that now has the section; links to other files in the repository go to GitHub.

Rename a README heading and update `PAGES` to match. `bun run site` rebuilds the docs when a README changes.

## Publishing

Cloudflare Workers Builds publishes this site from GitHub using the root [`wrangler.json`](../wrangler.json).
The site is static assets; it needs no Worker script, database or application server. Wrangler is pinned in
the root `package.json` and `bun.lock`. Both addresses are on notato.dev; nothing is published on `workers.dev`.

| Git branch | Result | Command after the build |
| --- | --- | --- |
| `develop` | Updates the preview at `preview.notato.dev` (Worker `notato-site-preview`) | `bun run preview:site` |
| `main` | Publishes the production website at `notato.dev` (Worker `notato-site`) | `bun run deploy:site` |
| any other branch | Not built by Cloudflare (CI still builds and tests it) | |

Open feature and fix pull requests against `develop`. After checking the preview, open a release pull request
from `develop` into `main`. Merging into `main` publishes the website. Publishing SDK packages, container images
and GitHub releases still requires the explicit tagged-release process in [RELEASING.md](../RELEASING.md).

### Cloudflare build settings

Two Workers are connected to the `notatorg/notato` repository, each with its own Workers Builds connection.
Workers Builds requires the name in `wrangler.json` to match the Worker it builds, which is why the preview is
a separate Worker and not an environment of the production one.

| Setting | `notato-site` (production) | `notato-site-preview` |
| --- | --- | --- |
| Production branch | `main` | `develop` |
| Root directory | `/` | `/` |
| Build command | `bun run build:site` | `bun run build:site` |
| Deploy command | `bun run deploy:site` (`wrangler deploy`) | `bun run preview:site` (`wrangler deploy --env preview`) |
| Builds for preview branches | Off | Off |
| Build variable | `BUN_VERSION=1.4.3`, matching CI | `BUN_VERSION=1.4.3` |
| Address | `notato.dev` | `preview.notato.dev` |

The preview Worker is the `env.preview` block of `wrangler.json`; its custom domain never touches production, and
it needs `notato.dev` to be a zone in the same Cloudflare account. `site/deploy-preview.ts` publishes only
`develop`, so no other branch can replace the shared preview.

Cloudflare installs dependencies from `bun.lock` before building. `WORKERS_CI_BRANCH`, supplied by Cloudflare,
determines the build mode automatically: `main` is production, and other branches are previews. Remove any old
`NOTATO_SITE_ENV` dashboard override. For local checks, use `NOTATO_SITE_ENV=preview bun run build:site` or
`NOTATO_SITE_ENV=production bun run build:site`.

Preview builds have an `X-Robots-Tag: noindex, nofollow` header. Production builds omit it.

### Analytics

Enable Automatic setup for `notato.dev` in Cloudflare Web Analytics once the custom domain is served through
Cloudflare. No analytics token is needed in GitHub Actions for that setup. If manually installing the beacon
instead, set `NOTATO_SITE_ANALYTICS_TOKEN` as a production build variable in Cloudflare and disable automatic
injection to avoid duplicates. The build only embeds this public identifier in production; previews and local
builds ignore it even if the variable is present.

### Initial migration

Update the Worker's build settings as above, then build `develop` first and check `preview.notato.dev`.
Keep the existing website serving while doing so. `main` must contain the root Wrangler file and
build scripts before its first Cloudflare production build; do not retry a build of an older `main` commit.

The first production deployment attaches `notato.dev` through the custom domain in `wrangler.json`. Replace any
conflicting GitHub Pages CNAME as part of that cutover. After the Cloudflare site is verified, disable the old
GitHub Pages publisher. The separate GitHub Actions Website deploy workflow and the two per-target Wrangler
files are not used. GitHub Actions continues to build and test the website as part of CI on pull requests and
pushes to `develop` and `main`.

`site/src/_headers` sets the security headers for every page.

## Notes

- Motion respects `prefers-reduced-motion`: the demo jumps to the end of each story instead of playing it, and nothing loops.
- The demo pauses while it is off screen or the tab is hidden, and has its own pause button.
- Light and dark follow the system setting. The demo app, the terminal and the sticky notes keep their own colours in both.
- CI builds the site on every push and pull request, so renaming a README heading that a docs page uses fails the build until `PAGES` in `docs.ts` is updated.
