# @notato/core

What the [Notato](https://github.com/notatorg/notato) SDKs, the server and the board share, beyond the wire format in [`@notato/schema`](../schema). An app does not need it directly: `@notato/react`, `@notato/browser` and the other SDKs are built on it.

- **The annotation pipeline** (`createPipeline`): turns a selection on the page into a valid `Annotation`. Identity plugins say what the element is (selector, role, component, source position), capture plugins add evidence (screenshots, console, network) under their own key of `context`, and sinks deliver the result. A plugin that throws is reported and skipped; the note is still made.
- **The page's store** (`createMemoryStore`): the annotations a page holds, with their screenshot bytes: a mirror of the server's, or the only copy in test mode.
- **Bundles** (`buildBundle`, `writeBundle`, `streamBundle`, `readBundle`): a zip of `annotations.json`, `feedback.md` and the screenshots, for feedback that travels as a file. Reading one is guarded against hostile zips: `readBundle` checks sizes and counts before it inflates anything, and raises `BundleError` with a message safe to show.
- **Markdown** (`renderAnnotation`, `renderAnnotations`): an annotation as text a person or an agent reads, at one of four `DETAILS` levels from `compact` to `forensic`. What people typed can never change the document's structure.
- **What the agent sees** (`agentView`, `lastWord`, `awaitsAgent`): asides and People only notes are kept from the agent.
- **Mentions** (`mentionsIn`) and **known agents** (`knownAgent`, `agentLogoSvg`): the `@name` plugins a note calls, and the logo beside a reply an agent signed.
