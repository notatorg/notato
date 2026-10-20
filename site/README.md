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

Cloudflare Workers Builds publishes this site from GitHub using the root [`wrangler.json`](../wrangler.json).
The site is static assets; it needs no Worker script, database or application server. Wrangler is pinned in
the root `package.json` and `bun.lock`. Both addresses are on notato.dev; nothing is published on `workers.dev`.

| Git branch | Result | Command after the build |
| --- | --- | --- |
| `develop` | Updates the preview at `preview.notato.dev` (Worker `notato-site-preview`) | `bun run preview:site` |
| `main` | Publishes the production website at `notato.dev` (Worker `notato-site`) | `bun run deploy:site` |
| any other branch | Built to catch errors, not published | `bun run preview:site` (does nothing) |

Open feature and fix pull requests against `develop`. After checking the preview, open a release pull request
from `develop` into `main`. Merging into `main` publishes the website. Publishing SDK packages, container images
and GitHub releases still requires the explicit tagged-release process in [RELEASING.md](../RELEASING.md).

### Cloudflare build settings

Connect the `notatorg/notato` GitHub repository to the `notato-site` Worker, with these settings:

| Setting | Value |
| --- | --- |
| Root directory | Repository root (`/`) |
| Production branch | `main` |
| Build command | `bun run build:site` |
| Deploy command (production) | `bun run deploy:site` |
| Non-production branch deploy command | `bun run preview:site` |
| Non-production branch builds | Enabled |
| Build variable | `BUN_VERSION=1.4.3`, matching CI |

The preview is a second Worker, `notato-site-preview`, defined by `env.preview` in `wrangler.json`, so the
`preview.notato.dev` custom domain never touches production. The first `develop` build creates it and attaches
the domain, which needs `notato.dev` to be a zone in the same Cloudflare account. `site/deploy-preview.ts`
publishes only `develop`, so other branches cannot replace the shared preview.

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
