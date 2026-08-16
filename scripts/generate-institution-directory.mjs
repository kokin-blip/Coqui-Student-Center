import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

const input = process.argv[2];
if (!input) {
  throw new Error("Usage: npm run institutions:generate -- <Most-Recent-Cohorts-Institution.csv> [output.json]");
}

const inputPath = resolve(input);
const outputPath = resolve(process.argv[3] ?? "apps/desktop/src-tauri/resources/institutions-us.json");
const sourceUpdated = process.argv[4] ?? "unknown";

function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      fields.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  fields.push(current);
  return fields;
}

function normalizeDomain(value) {
  const candidate = value.trim();
  if (!candidate || candidate.toLowerCase() === "null") return "";
  try {
    const hostname = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`).hostname;
    return hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

const hash = createHash("sha256");
const inputForHash = createReadStream(inputPath);
inputForHash.on("data", (chunk) => hash.update(chunk));
const hashReady = new Promise((fulfill, reject) => {
  inputForHash.on("end", () => fulfill(hash.digest("hex")));
  inputForHash.on("error", reject);
});

const rows = createInterface({ input: createReadStream(inputPath), crlfDelay: Infinity });
let columns;
const institutions = [];
for await (const line of rows) {
  if (!columns) {
    columns = new Map(parseCsvLine(line.replace(/^\uFEFF/, "")).map((name, index) => [name, index]));
    for (const required of ["UNITID", "INSTNM", "INSTURL"]) {
      if (!columns.has(required)) throw new Error(`Missing required College Scorecard column: ${required}`);
    }
    continue;
  }
  const values = parseCsvLine(line);
  const operatingIndex = columns.get("CURROPER");
  if (operatingIndex !== undefined && values[operatingIndex] !== "1") continue;
  const id = values[columns.get("UNITID")]?.trim();
  const name = values[columns.get("INSTNM")]?.trim();
  if (!/^\d+$/.test(id ?? "") || !name) continue;
  institutions.push({
    id,
    name,
    country: "US",
    domain: normalizeDomain(values[columns.get("INSTURL")] ?? ""),
    catalog: false,
  });
}

institutions.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(institutions)}\n`, "utf8");
await writeFile(
  outputPath.replace(/\.json$/i, ".meta.json"),
  `${JSON.stringify({
    source: "U.S. Department of Education College Scorecard",
    sourceUrl: "https://collegescorecard.ed.gov/data/",
    sourceUpdated,
    generatedAt: new Date().toISOString(),
    inputSha256: await hashReady,
    count: institutions.length,
    catalogCoverage: "none; official catalog adapters are separately allowlisted",
  }, null, 2)}\n`,
  "utf8",
);

process.stdout.write(`Generated ${institutions.length} institutions at ${outputPath}\n`);
