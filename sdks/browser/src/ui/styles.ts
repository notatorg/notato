export const STYLES = /* css */ `
:host {
  all: initial;
  /* the bar and its menus: always dark */
  --b-bg: #17181b; --b-fg: #eceded; --b-mute: #8b8f97; --b-hover: #2a2c31; --b-line: #33353a; --b-field: #111214;
  --b-acc: #45bfa8; --b-accfg: #0b1f1b;
  /* popovers and cards: follow the system */
  --p-bg: #ffffff; --p-text: #1d1f22; --p-mute: #686c72; --p-line: #e4e4df; --p-soft: #f2f2ef; --p-field: #fbfbfa;
  --acc: #1f8a78; --acc-hover: #187465; --sel: #e5484d; --bad: #d6453d;
  --st-open: var(--notato-accent, #1f8a78); --st-ack: #d99a1e; --st-res: #2e9a5b; --st-rev: #8b5cf6; --st-var: #0891b2;
  --st-revd: #64748b; --st-dis: #9a9a9a;
  --f: "Figtree Variable", "Figtree", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --fd: "Bricolage Grotesque Variable", "Bricolage Grotesque", var(--f);
  --fm: "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :host { --p-bg: #1d1e21; --p-text: #e6e7ea; --p-mute: #8f939b; --p-line: #2f3136; --p-soft: #26272b; --p-field: #16171a; }
}
*, *::before, *::after { box-sizing: border-box; font-family: var(--f); }
button, input, textarea { font: inherit; }

.layer { position: fixed; inset: 0; pointer-events: none; overflow: hidden; }

/* ---- what is being pointed at, picked and dragged ------------------------------------------------------- */
.hover, .sel, .drag { position: fixed; display: none; pointer-events: none; }
.hover { border: 2px solid var(--acc); background: rgba(31, 138, 120, 0.08); border-radius: 4px; }
.hover-label {
  position: absolute; left: -2px; bottom: 100%; margin-bottom: 4px; max-width: 380px; padding: 3px 8px;
  background: var(--b-bg); color: var(--b-fg); font: 11px/16px var(--fm); border-radius: 6px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.hover.below .hover-label { bottom: auto; top: 100%; margin: 4px 0 0; }
.sel { border: 2px solid var(--sel); background: rgba(229, 72, 77, 0.06); border-radius: 4px; }
.sel.extra { border-style: dashed; }
.drag { border: 1.5px dashed var(--sel); background: rgba(229, 72, 77, 0.08); }

/* ---- pins -------------------------------------------------------------------------------------------------- */
.pin {
  position: fixed; display: none; width: 24px; height: 24px; margin: -12px 0 0 -12px; padding: 0;
  border: 0; border-radius: 50%; background: var(--st-open); color: #fff;
  font: 800 12px/24px var(--f); text-align: center; cursor: pointer; pointer-events: auto;
  box-shadow: 0 2px 6px rgba(20, 24, 32, 0.3), 0 0 0 2px #fff;
}
/* Literal colours (the same as --st-*), so the settings tests can hold the pin colours apart from them. */
.pin[data-status="acknowledged"] { background: #d99a1e; }
.pin[data-status="resolved"] { background: #2e9a5b; }
.pin[data-status="revert_requested"] { background: #8b5cf6; }
.pin[data-status="variant_chosen"] { background: #0891b2; }
.pin[data-status="reverted"] { background: #64748b; }
.pin[data-status="dismissed"] { background: #9a9a9a; text-decoration: line-through; }
.pin[data-detached="true"] { opacity: 0.55; }
/* The server refused it: it is only in this page. */
.pin[data-refused="true"] { box-shadow: 0 2px 6px rgba(20, 24, 32, 0.3), 0 0 0 2px #fff, 0 0 0 4px var(--bad); }
/* Whose note it is, when more than one person has notes here: their initials in their colour. */
.pin[data-by]::after {
  content: attr(data-by); position: absolute; left: 16px; top: -7px; min-width: 14px; padding: 0 4px;
  border-radius: 999px; background: var(--by, #17181b); color: #fff; font: 700 9px/14px var(--f);
  box-shadow: 0 0 0 1.5px #fff;
}
.pin:focus-visible { outline: 3px solid rgba(69, 191, 168, 0.7); outline-offset: 2px; }

/* ---- a pin's card -------------------------------------------------------------------------------------------- */
.card {
  position: fixed; display: none; width: 320px; padding: 14px; border-radius: 14px;
  background: var(--p-bg); color: var(--p-text); font-size: 13.5px; line-height: 1.4; pointer-events: auto;
  box-shadow: 0 22px 48px -14px rgba(20, 24, 32, 0.45), 0 0 0 1px var(--p-line);
  /* A long thread scrolls inside the card, so its reply line and buttons are always within reach. */
  max-height: calc(100vh - 16px); overflow-y: auto; overscroll-behavior: contain;
}
.card > * + * { margin-top: 10px; }
/* Focus is put on the card itself only to keep it there while the card is redrawn: the card is not a control. */
.card:focus { outline: none; }
.card-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.badge {
  display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px;
  box-shadow: inset 0 0 0 1px var(--p-line); color: var(--p-text); font-size: 11.5px; font-weight: 600; line-height: 1.4;
}
.badge.status { --c: var(--st-open); box-shadow: none; background: color-mix(in oklab, var(--c) 15%, transparent); font-weight: 700; }
.badge.status::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--c); }
.badge[data-v="acknowledged"] { --c: var(--st-ack); }
.badge[data-v="resolved"] { --c: var(--st-res); }
.badge[data-v="revert_requested"] { --c: var(--st-rev); }
.badge[data-v="variant_chosen"] { --c: var(--st-var); }
.badge[data-v="reverted"] { --c: var(--st-revd); }
.badge[data-v="dismissed"] { --c: var(--st-dis); }
.badge.sev { color: var(--p-mute); }
.badge.sev[data-v="blocker"] { box-shadow: none; background: color-mix(in oklab, var(--bad) 14%, transparent); color: var(--bad); }
.card-x {
  margin-left: auto; width: 24px; height: 24px; display: grid; place-items: center; padding: 0; border: 0;
  border-radius: 7px; background: transparent; color: var(--p-mute); cursor: pointer;
}
.card-x:hover { background: var(--p-soft); color: var(--p-text); }
.card .meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; color: var(--p-mute); }
.card .meta b { color: var(--p-text); font-weight: 700; }
.card .who { display: inline-block; flex: none; width: 8px; height: 8px; border-radius: 50%; }
.card .body { font-size: 15px; font-weight: 600; line-height: 1.4; white-space: pre-wrap; word-break: break-word; text-wrap: pretty; }
.reply { display: flex; gap: 8px; align-items: flex-start; }
.av {
  flex: none; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center;
  background: #888; color: #fff; font-size: 10.5px; font-weight: 700;
}
.av.agent { background: var(--acc); }
/* A known agent's logo on its own colour; a black-and-white logo in the text colour, so it turns over in dark mode. */
.av.brand.ink { background: var(--p-text); color: var(--p-bg); }
.bubble {
  min-width: 0; padding: 7px 11px; border-radius: 4px 12px 12px 12px; background: var(--p-soft);
  font-size: 13px; line-height: 1.45; white-space: pre-wrap; word-break: break-word;
}
.bubble b { display: block; font-size: 12px; }
/* An aside is for the people on the thread: drawn apart, so nobody takes it for something the agent was told. */
.bubble.aside { background: transparent; border: 1px dashed var(--p-line); color: var(--p-mute); }
.aside-tag, .badge.people { font-size: 10.5px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
.aside-tag { margin-left: 6px; color: var(--p-mute); }
.badge.people { color: var(--p-mute); box-shadow: inset 0 0 0 1px var(--p-line); }
.say-row { display: flex; gap: 6px; align-items: center; }
.say-row .say { flex: 1; min-width: 0; }
.card .chip { padding: 3px 9px; font-size: 12px; }
.say {
  display: block; width: 100%; padding: 7px 11px; border: 1px solid var(--p-line); border-radius: 9px;
  background: var(--p-field); color: var(--p-text); font-size: 13px; outline: none;
}
.say:focus { border-color: var(--acc); }
.say::placeholder, .card textarea::placeholder, .popover textarea::placeholder { color: var(--p-mute); }
.card .err, .say-err { font-size: 12px; color: var(--bad); }
/* A form or a note inside a card, tinted by what it is about. */
.revert {
  display: grid; gap: 8px; padding: 10px; border-radius: 10px;
  background: color-mix(in oklab, var(--st-rev) 9%, transparent);
}
.revert.versions { background: color-mix(in oklab, var(--st-var) 9%, transparent); }
.revert > .hint { font-size: 12px; font-weight: 700; color: var(--st-rev); }
.revert.versions > .hint { color: var(--st-var); }
.card .revert textarea {
  width: 100%; padding: 7px 10px; border: 1px solid var(--p-line); border-radius: 8px; resize: none;
  background: var(--p-field); color: var(--p-text); font-size: 13px; outline: none;
}
.card .revert textarea:focus { border-color: var(--st-rev); }
.card .revert.versions textarea:focus { border-color: var(--st-var); }
.card .foot { display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.card .revert .foot .btn.primary { background: var(--st-rev); }
.card .revert.versions .foot .btn.primary { background: var(--st-var); }
.card .revert .foot.start { justify-content: flex-start; }
.card .revert .foot.start .link { background: var(--p-bg); box-shadow: inset 0 0 0 1px var(--p-line); color: var(--p-text); }
.card-foot { display: flex; align-items: center; gap: 4px; padding-top: 8px; border-top: 1px solid var(--p-line); }
.card-foot .hint { font-size: 12px; color: var(--p-mute); }
.card .link {
  padding: 6px 8px; border: 0; border-radius: 8px; background: transparent; color: var(--p-mute);
  font-size: 12.5px; font-weight: 600; cursor: pointer; white-space: nowrap;
}
.card .link:hover { background: var(--p-soft); }
.card .link:disabled { opacity: 0.5; cursor: default; }
.card .link.violet { color: var(--st-rev); }
.card .link.delete { margin-left: auto; }
.card .link.delete.armed { background: var(--bad); color: #fff; }

/* ---- the bar --------------------------------------------------------------------------------------------- */
.toolbar {
  position: fixed; display: flex; align-items: center; gap: 2px; padding: 4px; border-radius: 14px;
  background: var(--b-bg); color: var(--b-fg); pointer-events: auto; font-size: 13px; user-select: none; touch-action: none;
  box-shadow: 0 14px 34px -12px rgba(15, 17, 20, 0.55), 0 0 0 1px var(--b-line);
}
.toolbar.dragging { cursor: grabbing; }
.tb-dot { display: grid; place-items: center; width: 22px; height: 32px; margin-left: 2px; }
.tb-dot::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--b-mute); }
.tb-dot[data-state="connected"]::before { background: #55c487; box-shadow: 0 0 0 3px rgba(85, 196, 135, 0.22); }
.tb-dot[data-state="connecting"]::before { background: #e9b44c; box-shadow: 0 0 0 3px rgba(233, 180, 76, 0.22); }
.tb-dot[data-state="offline"]::before { background: #ef6b5e; box-shadow: 0 0 0 3px rgba(239, 107, 94, 0.22); }
.tb-grip {
  display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 32px;
  border-radius: 7px; color: var(--b-mute); cursor: grab;
}
.tb-grip:hover { color: var(--b-fg); }
.tb-grip:focus-visible { outline: 2px solid var(--b-acc); outline-offset: 1px; }
.toolbar.dragging .tb-grip { cursor: grabbing; }
.toolbar.bottom-right { right: 16px; bottom: 16px; }
.toolbar.bottom-left { left: 16px; bottom: 16px; }
.toolbar.top-right { right: 16px; top: 16px; }
.toolbar.top-left { left: 16px; top: 16px; }
.tb-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-width: 32px; height: 32px; padding: 0;
  border: 0; border-radius: 10px; background: transparent; color: inherit; cursor: pointer; white-space: nowrap;
}
.tb-btn:hover { background: var(--b-hover); }
.tb-btn[aria-pressed="true"], .tb-btn[aria-expanded="true"] { background: var(--b-hover); }
.tb-btn.tb-pause[aria-pressed="true"] { color: var(--b-acc); }
.tb-btn:focus-visible { outline: 2px solid var(--b-acc); outline-offset: 1px; }
.tb-btn:disabled { opacity: 0.5; cursor: default; }
.tb-annotate { padding: 0 6px 0 9px; font-weight: 700; }
.tb-annotate[aria-pressed="true"] { background: var(--b-acc); color: var(--b-accfg); }
.tb-annotate[aria-pressed="true"]:hover { background: #5fcfb9; }
.tb-count {
  min-width: 20px; padding: 1px 6px; border-radius: 999px; background: var(--b-hover);
  font-size: 11.5px; line-height: 16px; text-align: center;
}
.tb-annotate[aria-pressed="true"] .tb-count { background: rgba(11, 31, 27, 0.16); }
.tb-sep { flex: none; width: 1px; height: 18px; margin: 0 3px; background: var(--b-line); }
.tb-eye[aria-pressed="true"] { background: transparent; color: var(--b-mute); }
.tb-eye[aria-pressed="true"]:hover { background: var(--b-hover); }
/* On a phone the label goes, so the whole bar (chevron included) fits. */
@media (max-width: 480px) { .tb-label { display: none; } }
.tb-collapse { min-width: 24px; width: 24px; color: var(--b-mute); }
.tb-collapse:hover { color: var(--b-fg); }
.tb-fab {
  display: none; position: relative; flex: none; align-items: center; justify-content: center; width: 32px; height: 32px;
  padding: 0; border: 0; border-radius: 50%; background: transparent; color: inherit; cursor: pointer;
}
.tb-fab img { width: 28px; height: 28px; object-fit: contain; transform: rotate(-8deg); pointer-events: none; }
.tb-fab:focus-visible { outline: 2px solid var(--b-acc); outline-offset: 2px; }
.tb-fab-count {
  position: absolute; top: -9px; right: -10px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px;
  background: var(--b-acc); color: var(--b-accfg); font-size: 11px; font-weight: 800; line-height: 18px; text-align: center;
  box-shadow: 0 0 0 2px var(--b-bg);
}
.tb-fab-dot { position: absolute; left: -4px; bottom: -4px; width: 10px; height: 10px; border-radius: 50%; box-shadow: 0 0 0 2px var(--b-bg); }
.tb-fab-dot[data-state="connecting"] { background: #e9b44c; }
.tb-fab-dot[data-state="offline"] { background: #ef6b5e; }
.tb-fab-count[hidden], .tb-fab-dot[hidden] { display: none; }
/* Folded: the round button alone. Unfolding or folding (.morphing): everything, clipped to the width on its way. */
.toolbar.collapsed:not(.morphing) { padding: 4px; border-radius: 999px; }
.toolbar.collapsed .tb-fab, .toolbar.morphing .tb-fab { display: inline-flex; }
.toolbar.collapsed:not(.morphing) > :not(.tb-fab) { display: none !important; }
.toolbar.morphing { overflow: hidden; }
.toolbar.morphing > * { flex-shrink: 0; }
.toolbar.morphing .tb-fab { position: absolute; top: 4px; left: 4px; }
.toolbar.morphing.held-right { justify-content: flex-end; }
.toolbar.morphing.held-right .tb-fab { left: auto; right: 4px; }
.toolbar.collapsed:not(.morphing) { overflow: visible; }
.icon { display: inline-flex; }

/* ---- menus off the bar: export, settings, server ---------------------------------------------------------- */
.menu, .spanel {
  position: fixed; width: 300px; max-width: calc(100vw - 16px); border-radius: 14px; background: var(--b-bg); color: var(--b-fg);
  pointer-events: auto; font-size: 13px; line-height: 1.35;
  box-shadow: 0 18px 40px -14px rgba(0, 0, 0, 0.6), 0 0 0 1px var(--b-line);
}
.menu { display: flex; flex-direction: column; gap: 2px; padding: 6px; }
.menu-title { display: flex; align-items: baseline; gap: 8px; padding: 8px 10px 4px; }
.menu-title strong { font: 700 15px var(--fd); letter-spacing: -0.01em; }
.menu-title span { font-size: 12px; color: var(--b-mute); }
.menu-empty { margin: 4px 4px 6px; padding: 10px 12px; border-radius: 10px; background: var(--b-hover); font-size: 12.5px; line-height: 1.45; color: var(--b-mute); }
.menu-label { padding: 8px 10px 2px; font-size: 11.5px; font-weight: 600; color: var(--b-mute); }
.menu-item {
  display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: 0 10px; align-items: center; width: 100%;
  padding: 7px 10px 7px 8px; border: 0; border-radius: 9px; background: transparent; color: inherit; text-align: left; cursor: pointer;
}
.menu-item:hover:not(:disabled), .menu-item:focus-visible { background: var(--b-hover); outline: none; }
.menu-item:disabled { opacity: 0.45; cursor: default; }
.menu-item .glyph {
  grid-row: span 2; width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center;
  background: var(--b-hover); color: var(--b-mute); font: 500 11px var(--fm);
}
.menu-item:hover .glyph { background: var(--b-line); }
.menu-item .glyph.acc { background: var(--b-acc); color: var(--b-accfg); }
.menu-item strong { font-size: 13.5px; }
.menu-item em { font-style: normal; font-size: 11px; font-weight: 600; color: var(--b-acc); }
.menu-item .desc { grid-column: 2 / span 2; font-size: 12px; line-height: 1.35; color: var(--b-mute); }
.menu-sep { height: 1px; margin: 4px 6px; background: var(--b-line); }

.spanel { overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 14px; }
.shead { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.stitle { flex: 1; font: 700 15px var(--fd); letter-spacing: -0.01em; }
/* The server's state, at the top of its view. */
.slabel:has(> .sdot) { display: flex; align-items: center; gap: 4px; font: 700 16px var(--fd); color: var(--b-fg); }
.slabel > .sdot { width: 9px; height: 9px; margin: 0 5px 0 1px; }
.sback {
  display: inline-flex; align-items: center; gap: 6px; padding: 2px 4px; border: 0; border-radius: 6px; background: transparent;
  color: var(--b-mute); font-size: 12.5px; font-weight: 600; cursor: pointer;
}
.sback:hover { color: var(--b-fg); }
.sback.x { font-size: 18px; line-height: 1; padding: 0 6px; }
.sfield { display: flex; flex-direction: column; gap: 5px; }
.slabel { font-size: 12px; font-weight: 600; color: var(--b-mute); }
.stoggles { display: flex; flex-direction: column; gap: 2px; }
.srow { display: flex; align-items: center; gap: 10px; padding: 7px 0; }
.stext { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.stext .slabel { font-size: 13px; color: var(--b-fg); }
.shelp { color: var(--b-mute); font-size: 11.5px; line-height: 1.4; }
.shelp.ok { color: #86d9b3; }
.sinput {
  width: 100%; padding: 7px 10px; border-radius: 9px; border: 1px solid var(--b-line); background: var(--b-field);
  color: var(--b-fg); font-size: 13.5px; font-weight: 500; outline: none;
}
.sinput::placeholder { color: var(--b-mute); }
.sinput:focus { border-color: var(--b-acc); }
.seg { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2px; padding: 3px; border-radius: 10px; background: var(--b-field); }
.seg button {
  border: 0; background: transparent; color: var(--b-mute); padding: 5px 2px; border-radius: 7px;
  font-size: 12px; font-weight: 600; text-transform: capitalize; cursor: pointer;
}
.seg button:hover { color: var(--b-fg); }
.seg button[aria-checked="true"] { background: var(--b-hover); color: var(--b-fg); }
.sw {
  position: relative; flex: none; width: 34px; height: 20px; border: 0; border-radius: 999px; background: #3a3c42;
  cursor: pointer; padding: 0; transition: background 0.12s;
}
.sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform 0.12s; }
.sw[aria-checked="true"] { background: var(--b-acc); }
.sw[aria-checked="true"]::after { transform: translateX(14px); }
.sw:disabled { opacity: 0.45; cursor: default; }
.sw:focus-visible, .seg button:focus-visible, .swatch:focus-visible, .snav:focus-visible, .slink:focus-visible, .sback:focus-visible {
  outline: 2px solid var(--b-acc); outline-offset: 2px;
}
.swatches { display: flex; gap: 8px; }
/* A faint ring, so the ink swatch shows on the dark panel. */
.swatch { width: 24px; height: 24px; border-radius: 50%; border: 0; cursor: pointer; padding: 0; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16); }
.swatch[aria-checked="true"] { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16), 0 0 0 2px var(--b-bg), 0 0 0 4px var(--b-fg); }
.snav {
  display: flex; align-items: center; gap: 9px; width: 100%; padding: 9px 10px; border: 0; border-radius: 10px;
  background: var(--b-hover); color: var(--b-fg); font-weight: 600; text-align: left; cursor: pointer;
}
.snav:hover { background: var(--b-line); }
.snav .chev { margin-left: auto; color: var(--b-mute); }
.slink {
  align-self: flex-start; padding: 0; border: 0; background: transparent; color: var(--b-mute); font-size: 12px;
  text-align: left; text-decoration: underline; cursor: pointer;
}
.slink:hover { color: var(--b-fg); }
.scode {
  display: block; padding: 6px 8px; border-radius: 8px; background: var(--b-field); font-family: var(--fm); color: var(--b-acc);
  font-size: 12px; overflow-x: auto; white-space: nowrap;
}
.sdot { flex: none; display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--b-mute); }
.sdot[data-state="connected"] { background: #55c487; box-shadow: 0 0 0 3px rgba(85, 196, 135, 0.22); }
.sdot[data-state="connecting"] { background: #e9b44c; box-shadow: 0 0 0 3px rgba(233, 180, 76, 0.22); }
.sdot[data-state="offline"] { background: #ef6b5e; box-shadow: 0 0 0 3px rgba(239, 107, 94, 0.22); }

.toast {
  position: fixed; left: 50%; bottom: 72px; transform: translateX(-50%); max-width: calc(100vw - 32px); padding: 9px 16px;
  border-radius: 999px; background: var(--b-bg); color: var(--b-fg); font-size: 13.5px; font-weight: 600; pointer-events: none;
  box-shadow: 0 12px 30px -10px rgba(20, 24, 32, 0.45), 0 0 0 1px var(--b-line);
}

/* ---- the versions switcher, above the agent's versions in the page --------------------------------------- */
.vpill {
  position: fixed; display: none; align-items: center; flex-wrap: wrap; gap: 4px; max-width: calc(100vw - 16px);
  padding: 4px; border-radius: 12px; background: var(--b-bg); color: var(--b-fg); pointer-events: auto; font-size: 12.5px;
  box-shadow: 0 10px 24px -10px rgba(0, 0, 0, 0.5), 0 0 0 1px var(--b-line);
}
.vtag { padding: 3px 7px; border-radius: 6px; background: var(--st-var); color: #fff; font-size: 10px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
.vtabs { display: flex; gap: 2px; max-width: 100%; overflow-x: auto; scrollbar-width: none; }
.vopt {
  flex: none; border: 0; background: transparent; color: var(--b-mute); padding: 5px 10px; border-radius: 8px; cursor: pointer;
  font-weight: 600; white-space: nowrap; max-width: 180px; overflow: hidden; text-overflow: ellipsis;
}
.vopt:hover { color: var(--b-fg); }
.vopt[aria-selected="true"] { background: var(--b-hover); color: var(--b-fg); }
.vopt:focus-visible, .vuse:focus-visible, .vundo:focus-visible { outline: 2px solid var(--b-acc); outline-offset: 1px; }
.vmark { color: var(--b-acc); }
.vpill > .vtabs + * { margin-left: 2px; padding-left: 6px; border-left: 1px solid var(--b-line); }
.vuse { border: 0; border-radius: 8px; padding: 5px 10px; background: var(--b-acc); color: var(--b-accfg); font-weight: 700; cursor: pointer; white-space: nowrap; }
.vuse:disabled, .vundo:disabled { opacity: 0.5; cursor: default; }
.vundo { border: 0; border-radius: 8px; padding: 5px 10px; background: transparent; color: var(--b-fg); font-weight: 600; cursor: pointer; white-space: nowrap; }
.vundo:hover { background: var(--b-hover); }
.vstate { color: var(--b-mute); font-size: 12px; padding: 0 4px; }
.verr { color: #fca5a5; font-size: 12px; flex-basis: 100%; padding: 2px 6px; }

/* ---- the new-note popover ------------------------------------------------------------------------------- */
.popover {
  position: fixed; width: 320px; padding: 14px; border-radius: 14px; background: var(--p-bg); color: var(--p-text);
  pointer-events: auto; font-size: 13.5px; display: flex; flex-direction: column; gap: 10px;
  box-shadow: 0 22px 48px -14px rgba(20, 24, 32, 0.45), 0 0 0 1px var(--p-line);
}
.popover h2 { margin: 0; font: 700 16px var(--fd); letter-spacing: -0.02em; }
.popover .targets { margin: -7px 0 0; padding: 0; list-style: none; display: grid; gap: 3px; }
.popover .targets li { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 11px var(--fm); color: var(--p-mute); }
.popover .hint {
  display: flex; gap: 7px; align-items: flex-start; margin: 0; padding: 7px 10px; border-radius: 9px;
  background: var(--p-soft); color: var(--p-mute); font-size: 12px; line-height: 1.4;
}
.popover .hint::before { content: ""; flex: none; width: 6px; height: 6px; margin-top: 5px; border-radius: 50%; background: currentColor; }
.popover .hint.warn { background: color-mix(in oklab, var(--st-ack) 14%, transparent); color: var(--p-text); }
.popover textarea {
  width: 100%; min-height: 76px; resize: vertical; padding: 9px 11px; border: 1.5px solid var(--p-line); border-radius: 11px;
  font-size: 14px; line-height: 1.45; color: var(--p-text); background: var(--p-field); outline: none;
}
.popover textarea:focus { border-color: var(--acc); }
.chips { display: flex; gap: 5px; flex-wrap: wrap; }
.chip {
  display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border: 0; border-radius: 999px;
  background: transparent; color: var(--p-text); box-shadow: inset 0 0 0 1px var(--p-line);
  font-size: 12.5px; font-weight: 600; cursor: pointer;
}
.chip:hover { background: var(--p-soft); }
.chip[aria-pressed="true"] { background: var(--p-text); color: var(--p-bg); box-shadow: inset 0 0 0 1px var(--p-text); }
.chip .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--d); }
.chip[data-severity="blocker"] { --d: var(--bad); }
.chip[data-severity="major"] { --d: var(--st-ack); }
.chip[data-severity="minor"] { --d: #2f6fde; }
.chip[data-severity="nit"] { --d: #9a9a9a; }
.chip:focus-visible, .btn:focus-visible, .card .link:focus-visible, .card-x:focus-visible { outline: 2px solid var(--acc); outline-offset: 1px; }
.actions { display: flex; justify-content: flex-end; align-items: center; gap: 6px; }
.actions .status { margin-right: auto; font-size: 12px; color: var(--p-mute); }
.actions .status.error { color: var(--bad); font-weight: 600; }
.btn {
  padding: 7px 12px; border: 0; border-radius: 9px; background: transparent; color: var(--p-mute); font-weight: 600; cursor: pointer;
}
.btn:hover { background: var(--p-soft); color: var(--p-text); }
.btn.primary { padding: 7px 16px; background: var(--acc); color: #fff; font-weight: 700; }
.btn.primary:hover { background: var(--acc-hover); color: #fff; }
.btn.small { padding: 5px 10px; font-size: 12.5px; }
.btn.primary.small { padding: 5px 12px; }
.btn:disabled { opacity: 0.5; cursor: default; }

/* ---- packaging, in test and agent mode ------------------------------------------------------------------- */
.shade { position: fixed; inset: 0; background: rgba(20, 22, 26, 0.4); pointer-events: auto; }
.dialog {
  position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(400px, calc(100vw - 32px));
  padding: 20px; border-radius: 16px; background: var(--p-bg); color: var(--p-text); pointer-events: auto; font-size: 14px;
  display: flex; flex-direction: column; gap: 14px; box-shadow: 0 30px 60px -20px rgba(0, 0, 0, 0.5);
}
.dialog-head { display: flex; align-items: center; gap: 10px; }
.dialog-head img { width: 34px; height: 34px; object-fit: contain; transform: rotate(-8deg); }
.dialog h2 { margin: 0; font: 700 19px var(--fd); letter-spacing: -0.02em; }
.dialog .hint { margin: 0; color: var(--p-mute); line-height: 1.5; text-wrap: pretty; }
.field { display: flex; flex-direction: column; gap: 5px; font-size: 12.5px; font-weight: 600; color: var(--p-text); }
.field input[type="text"] {
  padding: 8px 11px; border: 1px solid var(--p-line); border-radius: 10px; font-size: 14px; font-weight: 400;
  background: var(--p-field); color: var(--p-text); outline: none;
}
.field input[type="text"]:focus { border-color: var(--acc); }
.check { display: flex; gap: 9px; align-items: center; font-size: 13.5px; color: var(--p-text); cursor: pointer; }
.check input { width: 18px; height: 18px; margin: 0; accent-color: var(--acc); }
.dialog .actions { padding-top: 4px; }
.dialog .btn { padding: 8px 14px; border-radius: 10px; }
.dialog .btn.primary { padding: 8px 16px; }
`;
