import { createHash } from "node:crypto";

// The skills are Agent Skills (a folder with a SKILL.md), which Claude Code, Codex, Cursor, Gemini CLI, Copilot and
// others all read; `init` writes them into the skills folder of each agent it sets up (see agents.ts).

/** The skill that teaches the loop: watch, acknowledge, fix, commit, resolve, and undo a change when asked. */
const MAIN = `---
name: notato
description: "Works through UI feedback that people pinned to the running app with Notato, and undoes a change when asked. USE FOR: /notato or $notato, watch notato, fix notato annotations, handle UI feedback from the app, FOLLOW-UP replies, VARIANT CHOSEN, offer variants, REVERT REQUESTED, revert a notato change. DO NOT USE FOR: general bug reports that did not come from Notato, or feedback pasted into the chat (just handle that directly); having the agent review the app itself (that is the notato-critique skill). INVOKES: the notato MCP tools (notato_watch, notato_get, notato_acknowledge, notato_reply, notato_resolve, notato_dismiss, notato_reverted, notato_variants_ready), git."
---

# Notato

People pin notes to elements of the running app (with screenshots, when those are on). Each note is an **annotation**: a comment, the element it points at, and where that element comes from in the code. You read them with the \`notato\` MCP tools, act on them, and report back so the person sees the pin change.

## The loop

1. Call \`notato_watch\`. It blocks until something arrives and returns quietly on a timeout: call it again to keep waiting. Annotations and revert requests both come through it.
2. For each annotation, call \`notato_acknowledge\` so the person sees it is being worked on.
3. Read its **intent** (next section) before touching any code.
4. Find the code. Use what the annotation gives you, best first: the position it was **written at** (an exact file, line and column from the repository root; "inside the element written at" means the nearest tagged element, so start there), then the React component and its **component path** (the chain of components it sits in, innermost first), then the test id, then the selector. In a repo with several apps the path starts with the app's folder. Look at the screenshots if there are any. An element "reached through" an iframe or a shadow root is still in this app's code; the selector's \`>>>\` marks the hop.
5. Make the **smallest change** that does what the comment asks. Do not tidy, refactor or fix other things on the way. If the comment is unclear, ask with \`notato_reply\` and wait for the answer instead of guessing.
6. **Commit that change on its own**, one commit per annotation, so it can be undone later without touching anything else. Stage only the files you changed (\`git add <those files>\`, never \`git add -A\` or \`git commit -a\`): the person may have uncommitted work of their own in the same tree. Use a message like \`notato: <what changed>\`. If the project's rules say not to commit, or this is not a git repository, skip the commit and say so in the summary.
7. Call \`notato_resolve\` with a one-line summary, **the files you changed, and the commit**. That record is how the change gets found if it has to be undone.

If an annotation should not be acted on (a duplicate, working as intended, out of scope), call \`notato_dismiss\` with the reason.

## What the person wants: the intent

Many annotations carry an **intent**. It changes what you do:

- **fix**: something is broken. Fix it. This is the loop above.
- **change**: it works, but should be different. Make the change. If it is a design decision with more than one reasonable answer, pick the most conservative one and say which in the summary.
- **question**: the person wants an **answer, not an edit**. Do not change any code. Look at the code and the screenshots, answer in \`notato_reply\`, then call \`notato_resolve\` with the summary "Answered" and no files and no commit. They can reopen it if the answer is not enough.
- **approve**: the person is saying this is right as it is. Change nothing. Call \`notato_resolve\` with "No change needed" and no files.
- **variants**: the person wants to compare a few versions in the running page and pick one. This has its own section below.
- no intent: treat it as **fix** or **change** by what the comment says, and ask if you cannot tell.

## Variants

The person asked for versions to compare, such as "three layouts for this header". You put them all in the code, they flip between them live in the page, and they pick. You then keep only the pick.

1. \`notato_acknowledge\`. Decide how many new versions: what the comment says, or three. The **original stays** as one of the versions.
2. Write every version into the code at the place the annotation points to, side by side, each in an element with two attributes:
   - \`data-notato-variant="header"\`: the same on all of them. A short name for what is being varied.
   - \`data-notato-variant-name="Original"\`: a different name for each. Use \`Original\` for what is there now, and a short descriptive name for each new one (\`Stacked\`, \`Compact\`).
   Where the extra element must not change the layout, give it \`style={{ display: "contents" }}\`. Elements that share a name are one version, so a version can be several siblings. Put each version in its own component if it uses hooks, so none can break another. Change nothing else, and **do not commit yet**: the scaffolding is temporary.
3. Wait for the page to pick it up (a hot reload, or ask the person to refresh). If you can drive a browser, open the page and run \`window.__notato.variants.list()\`: your group must be listed with every name. \`window.__notato.variants.select("header", "Stacked")\` shows a version, so you can look at each one.
4. Call \`notato_variants_ready\` with the annotation's id, the group, and the names, original first, each with a one-line summary of how it differs. The page now shows a switcher over the group.
5. Go back to \`notato_watch\`. The person switches between the versions and presses "Use this". That arrives as **VARIANT CHOSEN** with the name.
6. Apply it. Keep only the chosen version's content, delete the other versions, and remove every wrapper element and both attributes you added, so no scaffolding, flag or dead code is left. If \`Original\` was chosen, put back exactly what was there. Check the app builds, **commit that on its own** (staging only your files), and call \`notato_resolve\` with the files and the commit.
7. If the person writes back instead (arrives as **FOLLOW-UP**, for example "make Stacked bolder, and add one with the button on the right"), change the versions and call \`notato_variants_ready\` again with the new set; it replaces the old offer.

## When the person writes back

Everything people write reaches you: \`notato_watch\` delivers each reply in an annotation's thread, marked **FOLLOW-UP**, on any annotation, the ones you already resolved and the dismissed ones included. It might be an answer to a question you asked with \`notato_reply\`, a note on one they reopened, a request about versions, more to do on something finished, or people talking among themselves. Read the last message and do what it asks:

- **A plain acknowledgement** ("thanks", "looks good"): nothing to do. Do not reply, and change nothing.
- **A question**: answer it with \`notato_reply\`.
- **More work on an annotation that is still open**: carry on, and finish with \`notato_resolve\` as usual.
- **More work on a finished annotation** (resolved, dismissed, reverted): their reply does not reopen it, you do. Call \`notato_acknowledge\` to reopen it, make the change, commit, and \`notato_resolve\` again. If it only needs an answer, reply and leave it finished.
- **People talking to each other**: take it as context and do not reply.

## What people keep from you

People can keep things between themselves, and you never see them in \`notato_watch\` or \`notato_list_open\`:

- **People only** on a note: the note and its whole thread are between people. If you ask for one by id, \`notato_get\` shows it labelled **PEOPLE ONLY**: leave it alone (no reply, no status change, no code). When someone turns People only off, it reaches you again marked **SHARED WITH YOU**, with what they discussed in the thread; work it as usual.
- **An aside** on a reply: one remark for the people on the thread. It is left out of what you are shown, so the last message you see is the last one for you.

\`@\` in a note or a reply calls one of the server's plugins (\`@jira\`, say), not you: you get what people write without it.

## More detail

\`notato_get\` takes a \`detail\` level when the default is not enough: \`detailed\` adds the element's computed styles (size, spacing, colours, font), the ancestors it sits in and the animations that were running; \`forensic\` adds the full console and network and the identity exactly as captured. Use it for visual feedback ("the spacing is off", "wrong colour") and for anything about an animation.

## When a revert is requested

An annotation marked **REVERT REQUESTED** means the person looked at the change you made and does not want it. Its thread shows what you recorded when you resolved it, and their last message says why.

1. Undo exactly that change and nothing else. With a recorded commit, run \`git revert --no-edit <commit>\`. If you did not commit, restore only the files you listed, and only your own edits in them.
2. If the revert conflicts because the code has moved on, resolve it carefully. If you cannot undo it cleanly, call \`notato_reply\` to say why and leave it for the person. Do not force it.
3. Check that the app still builds and the tests that cover it still pass.
4. Call \`notato_reverted\` with a one-line summary.

Do not call \`notato_acknowledge\`, \`notato_resolve\` or \`notato_dismiss\` on a revert request: they are refused so the request cannot be lost. A revert request that is cancelled goes back to resolved, and nothing is needed from you.
`;

/** The skill that has the agent review the running app itself and file what it finds as annotations. */
const CRITIQUE = `---
name: notato-critique
description: "Has the agent review the running app itself, the way a careful designer or tester would, and file what it finds as Notato annotations, then work through them. USE FOR: /notato-critique or $notato-critique, critique the UI, review this page, audit the app for visual and usability problems, self-driving notato. DO NOT USE FOR: handling feedback people already filed (that is the notato skill), or reviewing code that is not running."
---

# Notato critique

You look at the **running** app, as a person would, and file what is wrong as Notato annotations: the same pins, screenshots and element details a person's would have. Then you work through them like any others.

## Before you start

1. You need a browser you can drive and read: a browser built into your agent, a browser extension it controls, or the Playwright or Chrome DevTools MCP server. If you have none, say so and stop: this skill cannot work from the code alone.
2. The app must be running with Notato mounted. Ask the person for the URL if you do not know it. Open it and run \`typeof window.__notato\` in the page: it must be \`"object"\`. If it is not, Notato is not mounted there; say so rather than guessing.
3. Agree the scope: which page or flow, and what to care about (layout, copy, accessibility, states). With no answer, take the page you are on and look at all of those.

## Look properly

- Use the app, do not just glance at it: open the menus, fill the form wrong and right, tab through it with the keyboard, resize to a phone width, open the modal and close it.
- Look at **states**, not only the first paint: empty, loading, error, long text, disabled, focus and hover.
- Check the console and the failed network requests; an error with no visible sign is a finding too.

## File what you find

File **between five and eight** annotations, the ones that matter most. Not twenty; people will not read them. For each, call \`window.__notato.annotate\` in the page through your browser tool, or \`notato_annotate\` if the page is in agent mode:

\`\`\`js
await window.__notato.annotate({
  target: "#pay",            // a selector; \`iframe#x >>> button\` reaches inside an iframe or a shadow root
  comment: "The Pay button has no loading state: after a click nothing changes for two seconds, and a second click charges twice.",
  severity: "major",         // blocker, major, minor or nit
  intent: "fix",             // fix, change, question or approve
})
\`\`\`

Write each comment so a stranger could act on it: what is wrong, where, what you expected, and why it matters. Choose the **severity** honestly: blocker only if the person cannot finish what they came to do. Use **intent** \`question\` when you are not sure it is a defect and want the person to decide, and \`approve\` for the one or two things that are done well and should not be touched.

Do not file what you cannot see: a guess about code you have not run is not a finding. Do not file the same problem on every element it affects; file it once and say where else it appears.

## Then work them

When you have filed them, call \`notato_list_open\`, then work them exactly as the \`notato\` skill says: acknowledge, read the intent, make the smallest change, commit it on its own, resolve with the files and the commit. Leave \`question\` annotations for the person unless you can answer from the code. At the end, tell the person what you filed, what you fixed and what you left for them.
`;

export interface SkillFile {
    /** The skill's name, which is also its folder. */
    name: string;
    /** Its file inside any agent's skills folder. */
    file: string;
    body: string;
    /** What the init report says about it when it is created. */
    note: string;
}

/** Every skill `init` writes, in order. */
export const SKILLS: SkillFile[] = [
    {
        name: "notato",
        file: "notato/SKILL.md",
        body: MAIN,
        note: "teaches the agent the loop; ask it to watch Notato",
    },
    {
        name: "notato-critique",
        file: "notato-critique/SKILL.md",
        body: CRITIQUE,
        note: "has the agent review the running app and file what it finds",
    },
];

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const TAG = /\n<!-- notato-skill:([0-9a-f]{16}) -->\n?$/;

/** The skill file as `init` writes it: the body, then a fingerprint of the body so later edits can be told apart. */
export function renderSkill(name = "notato"): string {
    const body = (SKILLS.find((s) => s.name === name) ?? SKILLS[0])?.body ?? "";
    return `${body}\n<!-- notato-skill:${hash(body)} -->\n`;
}

export type SkillState = "current" | "outdated" | "edited";

/**
 * What an existing skill file is: exactly the one this version writes, one an older version wrote and nobody has
 * touched, or something a person has edited or written themselves. Only the first two are ever overwritten or removed.
 */
export function skillState(existing: string, name = "notato"): SkillState {
    // A checkout with core.autocrlf (Windows) has CRLF line endings: the same file, not an edit.
    const text = existing.replace(/\r\n/g, "\n");
    if (text === renderSkill(name)) return "current";
    const tag = TAG.exec(text);
    if (tag && hash(text.slice(0, tag.index)) === tag[1]) return "outdated";
    return "edited";
}
