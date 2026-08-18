import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { foldIntoCourses, parseClassSearch } from "./catalog/asu-class-search.mjs";

// Builds the bundled course catalog from class-search exports. Deliberately
// offline: see the note in catalog/asu-class-search.mjs for why nothing here
// fetches. Run it, review the diff, commit the result.
//
//   npm run catalog:prepare -- --institution=104151 --term=asu-fall-2026-c \
//     --source-label="ASU Class Search" \
//     --source-url="https://catalog.apps.asu.edu/catalog/classes" \
//     export1.txt export2.txt
//
// Each input is `pdftotext -layout` output of a saved Class Search page.

function option(name) {
  return process.argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
}

const output = resolve(
  option("--out") ?? "apps/desktop/src-tauri/resources/institution-catalogs.json",
);
const institutionId = option("--institution");
const inputs = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
if (!institutionId || inputs.length === 0) {
  throw new Error("Usage: catalog:prepare -- --institution=<id> [--term=] [--source-label=] [--source-url=] <export.txt>...");
}

const records = inputs.flatMap((file) => {
  const found = parseClassSearch(readFileSync(file, "utf8"));
  console.log(`${file}: ${found.length} sections`);
  return found;
});
const courses = foldIntoCourses(records);

const existing = JSON.parse(readFileSync(output, "utf8"));
const entry = {
  institutionId,
  termId: option("--term") ?? "",
  sourceLabel: option("--source-label") ?? "",
  sourceUrl: option("--source-url") ?? "",
  courses,
};
// Provenance is enforced by a Rust test, but failing here is a better error.
if (courses.length > 0 && (!entry.sourceLabel || !entry.sourceUrl)) {
  throw new Error("--source-label and --source-url are required when courses are written");
}

const merged = existing.some((catalog) => catalog.institutionId === institutionId)
  ? existing.map((catalog) => (catalog.institutionId === institutionId ? entry : catalog))
  : [...existing, entry];

writeFileSync(output, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
console.log(`\n${courses.length} courses, ${records.length} sections -> ${output}`);
