# @notato/schema

The wire format of [Notato](https://github.com/notatorg/notato): what an annotation and a bundle of annotations look like, shared by every SDK, the server and the board. It is the one contract between them, so a change here is a change for every platform.

```ts
import { Annotation, Bundle, SCHEMA_VERSION } from "@notato/schema";

const note = Annotation.parse(JSON.parse(body)); // throws on anything malformed
```

- **Zod schemas and their types**: `Annotation`, `Bundle`, `Reply`, `ElementIdentity`, `AssetRef`, `Environment`, `Target`, `Variants`, and the enumerations `Mode`, `Severity`, `Intent` and `Status`. Each is both a schema (`Annotation.parse`) and a type (`Annotation`). The comments in [`src/index.ts`](src/index.ts) say what each field means.
- **`SCHEMA_VERSION`**: bundles carry it, so an importer can refuse one it does not understand.
- **`schema.json`** (`@notato/schema/schema.json`): the same definitions as JSON Schema, for languages without Zod (the .NET SDK's contract test reads it; the other native SDKs run what they write through the Zod schemas, as [sdks/README.md](../../sdks/README.md) describes). It is generated: after changing `src/index.ts`, run `bun run build:schema` from the repository root.
- **`sampleAnnotation` and `sampleBundle`**: fully populated examples, for tests and for the samples Notato sends.

Read leniently: ignore fields you do not know, and keep enumerations as strings, so a newer server never breaks an older app. A change that an older reader would reject needs a new `SCHEMA_VERSION`.
