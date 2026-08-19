import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { classify, parseRegistrarPage } from "./calendar/registrar-page.mjs";

/**
 * Regenerate a school's term dates and no-class dates from its published
 * academic calendar, following that school's own descriptor.
 *
 *   npm run calendar:prepare -- --institution=104151
 *   npm run calendar:prepare -- --institution=104151 --input=saved-calendar.html
 *   npm run calendar:verify
 *
 * Run it, review the diff, commit the result. `--input` reads a saved copy
 * instead of fetching, which is how a regeneration stays reproducible and how
 * this runs at all with no network.
 *
 * Nothing here defeats an access control. It reads a page a school publishes to
 * anyone; a calendar behind a login is simply out of reach, and the bundled
 * snapshot plus manual entry is the answer for that school.
 */

function option(name) {
  const found = process.argv.find((value) => value.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1) : undefined;
}

const providersPath = resolve(
  option("--out") ?? "apps/desktop/src-tauri/resources/institution-setup-providers.json",
);
const institutionId = option("--institution");
const inputPath = option("--input");
const apply = process.argv.includes("--apply");
if (!institutionId) {
  throw new Error(
    "Usage: npm run calendar:prepare -- --institution=<id> [--input=<saved.html>] [--apply]",
  );
}

const providers = JSON.parse(readFileSync(providersPath, "utf8"));
const provider = providers.find((entry) => entry.institutionId === institutionId);
if (!provider) throw new Error(`No descriptor for institution ${institutionId}`);
const source = provider.calendarSource;
if (!source) throw new Error(`Institution ${institutionId} publishes no calendar this can read`);
if (source.kind === "ics") {
  throw new Error("ICS calendars are read by the app at runtime; this script harvests HTML pages");
}

const html = inputPath
  ? readFileSync(resolve(inputPath), "utf8")
  : await fetchCalendar(source.url);

async function fetchCalendar(url) {
  if (!/^https:\/\//.test(url)) throw new Error(`Calendar URL must be HTTPS: ${url}`);
  const response = await fetch(url, {
    redirect: "error",
    headers: { "user-agent": "StudentCenter calendar:prepare (read-only)" },
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
}

const entries = parseRegistrarPage(html, source);
console.log(`${inputPath ?? source.url}: ${entries.length} dated rows`);

// Match rows onto the terms already declared, rather than inventing terms. A
// harvest that discovered terms would be guessing at which session a row names,
// and a wrong term boundary is worse than a missing one.
const within = (term, iso) => {
  const day = 24 * 60 * 60 * 1000;
  const start = Date.parse(`${term.startsOn}T00:00:00Z`) - 14 * day;
  const end = Date.parse(`${term.endsOn}T00:00:00Z`) + 14 * day;
  const at = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(start) && Number.isFinite(end) && at >= start && at <= end;
};

const changes = [];
const unmatched = [];
for (const entry of entries) {
  const term = provider.terms.find((candidate) =>
    entry.sessionCode
      ? candidate.sessionCode === entry.sessionCode && within(candidate, entry.startsOn)
      : within(candidate, entry.startsOn),
  );
  const field = classify(entry.label);
  if (!term || !field) {
    unmatched.push(entry);
    continue;
  }
  if (field === "noClass") {
    term.noClassDates ??= [];
    const known = term.noClassDates.some(
      (date) => date.startsOn === entry.startsOn && (date.endsOn ?? "") === entry.endsOn,
    );
    if (!known) {
      term.noClassDates.push({ startsOn: entry.startsOn, endsOn: entry.endsOn, label: entry.label });
      changes.push(`${term.id}: + no-class ${entry.startsOn}${entry.endsOn ? `–${entry.endsOn}` : ""} (${entry.label})`);
    }
    continue;
  }
  if (term[field] !== entry.startsOn) {
    changes.push(`${term.id}: ${field} ${term[field] || "(unset)"} -> ${entry.startsOn} (${entry.label})`);
    if (apply) term[field] = entry.startsOn;
  }
}

for (const term of provider.terms) {
  if (!term.noClassDates?.length) continue;
  term.noClassDates.sort((left, right) => left.startsOn.localeCompare(right.startsOn));
}
provider.generatedAt = new Date().toISOString().slice(0, 10);

console.log(changes.length ? changes.join("\n") : "No differences against the bundled snapshot.");
if (unmatched.length) {
  // Reported rather than dropped: a school whose sessions are worded differently
  // should look unmatched, not look like it has nothing to say.
  console.log(`\n${unmatched.length} row(s) matched no term boundary:`);
  for (const entry of unmatched.slice(0, 20)) console.log(`  ${entry.startsOn}  ${entry.label}`);
}

if (!apply) {
  console.log("\nDry run. Re-run with --apply to write these into the descriptor.");
} else {
  writeFileSync(providersPath, `${JSON.stringify(providers, null, 2)}\n`);
  console.log(`\nWrote ${providersPath}. Review the diff, run calendar:verify, then commit.`);
}
