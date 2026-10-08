// Validates JSON the Android SDK wrote against the Zod schema the server uses: `bun sdks/android/scripts/validate.ts annotation file.json`.
import { Annotation, Bundle } from "../../../packages/schema/src/index.ts"

const [kind, file] = process.argv.slice(2)
if (!kind || !file) {
  console.error("usage: bun sdks/android/scripts/validate.ts annotation|bundle <file.json>")
  process.exit(2)
}
const data = JSON.parse(await Bun.file(file).text())
const result = (kind === "bundle" ? Bundle : Annotation).safeParse(data)
if (!result.success) {
  console.error(JSON.stringify(result.error.issues, null, 2))
  process.exit(1)
}
console.log("valid")
