import { z } from "zod";
import { definitions } from "../src/index.ts";

// One source of truth: the Zod schemas. This writes them out as JSON Schema (schema.json), so the SDKs in other
// languages (C#, Swift, Kotlin, Dart) can check their models against the same contract.
const defs: Record<string, unknown> = {};
for (const [name, schema] of Object.entries(definitions)) {
    const { $schema: _ignored, ...json } = z.toJSONSchema(schema, {
        target: "draft-7",
        io: "output",
    });
    defs[name] = json;
}

const out = {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "Notato schema",
    description: "Generated from packages/schema/src/index.ts. Do not edit.",
    definitions: defs,
};

const path = new URL("../schema.json", import.meta.url);
await Bun.write(path, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${path.pathname} (${Object.keys(defs).length} definitions)`);
