import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toJsRegex } from "./calendar/registrar-page.mjs";

/**
 * The gate on the bundled school descriptors, in the same spirit as
 * `verify-course-catalog.mjs`: a malformed regeneration should fail the build
 * rather than ship.
 *
 * Most of what it checks is unreachable from Rust's type system. A row pattern
 * is a string as far as serde is concerned, so a descriptor can parse cleanly
 * and still be unable to read the page it points at — the two failures that
 * matter are a pattern that does not compile and a pattern with no `label` or
 * `start` group, both of which produce a refresh that silently finds nothing.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CALENDAR_KINDS = new Set(["ics", "html-table", "html-list", "html-sessions"]);
const CATALOG_KINDS = new Set(["none", "ics", "html-table", "student-export"]);
const SHAPES = new Set(["grid", "list"]);
const CURRENT_SCHEMA_VERSION = 1;

export function verifyCalendars({ providers, institutionIds }) {
  const problems = [];
  const seen = new Set();
  let terms = 0;
  let noClassDates = 0;
  let layouts = 0;

  if (!Array.isArray(providers)) {
    return { providers: 0, terms, noClassDates, layouts, ready: false, problems: ["the descriptor file is not an array"] };
  }

  for (const provider of providers) {
    const id = provider?.institutionId;
    const where = id ? `institution ${id}` : "an entry with no institutionId";
    if (!id) {
      problems.push("every descriptor needs an institutionId");
      continue;
    }
    if (seen.has(id)) problems.push(`${where} appears more than once`);
    seen.add(id);
    if (institutionIds && institutionIds.size && !institutionIds.has(id)) {
      problems.push(`${where} is not in the bundled institution directory`);
    }
    if (provider.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      problems.push(`${where} states schemaVersion ${provider.schemaVersion}, expected ${CURRENT_SCHEMA_VERSION}`);
    }

    const campusIds = new Set();
    for (const campus of provider.campuses ?? []) {
      if (!campus.id || !campus.name) problems.push(`${where} has a campus with no id or name`);
      if (campusIds.has(campus.id)) problems.push(`${where} repeats campus ${campus.id}`);
      campusIds.add(campus.id);
    }

    const termIds = new Set();
    for (const term of provider.terms ?? []) {
      terms += 1;
      const at = `${where} term ${term.id ?? "(no id)"}`;
      if (!term.id || !term.name) problems.push(`${at} needs an id and a name`);
      if (termIds.has(term.id)) problems.push(`${at} appears more than once`);
      termIds.add(term.id);
      // A preset with no dates pre-fills nothing, which is the whole point of it.
      if (!ISO_DATE.test(term.startsOn ?? "") || !ISO_DATE.test(term.endsOn ?? "")) {
        problems.push(`${at} needs ISO startsOn and endsOn dates`);
      } else if (term.startsOn > term.endsOn) {
        problems.push(`${at} ends before it starts`);
      }
      for (const [field, value] of [["classEndsOn", term.classEndsOn], ["examStartsOn", term.examStartsOn]]) {
        if (!value) continue;
        if (!ISO_DATE.test(value)) problems.push(`${at} has a malformed ${field}`);
        else if (value < term.startsOn || value > term.endsOn) problems.push(`${at} has ${field} outside the term`);
      }
      // Finals cannot start before instruction has finished.
      if (term.classEndsOn && term.examStartsOn && term.examStartsOn < term.classEndsOn) {
        problems.push(`${at} starts finals before classes end`);
      }
      if (term.sourceLabel && !term.sourceUrl) problems.push(`${at} cites a source with no URL`);
      for (const date of term.noClassDates ?? []) {
        noClassDates += 1;
        if (!ISO_DATE.test(date.startsOn ?? "")) problems.push(`${at} has a no-class date with no startsOn`);
        if (date.endsOn && !ISO_DATE.test(date.endsOn)) problems.push(`${at} has a malformed no-class endsOn`);
        if (date.endsOn && date.endsOn < date.startsOn) problems.push(`${at} has a no-class range that ends before it starts`);
        if (!date.label) problems.push(`${at} has an unlabelled no-class date`);
        // A holiday outside the term it is filed under is filed wrongly.
        if (ISO_DATE.test(term.startsOn ?? "") && ISO_DATE.test(date.startsOn ?? "")) {
          if (date.startsOn < term.startsOn || date.startsOn > term.endsOn) {
            problems.push(`${at} has no-class date ${date.startsOn} outside the term`);
          }
        }
      }
    }

    const calendar = provider.calendarSource;
    if (calendar) {
      if (!/^https:\/\//.test(calendar.url ?? "")) problems.push(`${where} calendar URL must be HTTPS`);
      if (!CALENDAR_KINDS.has(calendar.kind)) problems.push(`${where} has an unknown calendar kind ${calendar.kind}`);
      if (calendar.kind === "html-table" || calendar.kind === "html-list") {
        if (!calendar.rowPattern) problems.push(`${where} reads HTML but declares no rowPattern`);
      }
      if (calendar.kind === "html-sessions") {
        // This shape finds dates first and reaches back for their label, so a
        // date pattern is what it cannot work without.
        if (!calendar.datePattern) problems.push(`${where} reads sessions but declares no datePattern`);
        for (const group of ["start", "year"]) {
          if (calendar.datePattern && !calendar.datePattern.includes(`(?P<${group}>`)) {
            problems.push(`${where} datePattern has no named ${group} group`);
          }
        }
      }
      if (calendar.kind !== "ics" && !calendar.dateFormat) {
        problems.push(`${where} reads HTML but declares no dateFormat`);
      }
      for (const [field, pattern] of [
        ["rowPattern", calendar.rowPattern],
        ["datePattern", calendar.datePattern],
        ["sessionPattern", calendar.sessionPattern],
        ["sectionPattern", calendar.sectionPattern],
      ]) {
        if (!pattern) continue;
        try {
          // Rust's regex crate and JavaScript disagree on spelling, but a
          // pattern neither can compile is wrong on any reading.
          toJsRegex(pattern);
        } catch (error) {
          problems.push(`${where} ${field} does not compile: ${error.message}`);
        }
      }
      // A row pattern with no label or start group parses every page to nothing,
      // and "no changes found" is exactly what a working refresh also reports.
      if (calendar.kind === "html-table" || calendar.kind === "html-list") {
        for (const group of ["label", "start"]) {
          if (!(calendar.rowPattern ?? "").includes(`(?P<${group}>`)) {
            problems.push(`${where} rowPattern has no named ${group} group`);
          }
        }
      }
    }

    const catalog = provider.catalogSource;
    if (catalog) {
      if (!CATALOG_KINDS.has(catalog.kind)) problems.push(`${where} has an unknown catalog kind ${catalog.kind}`);
      // "none" is the common and correct answer, but a bare "none" leaves the UI
      // nothing to say, so the reason has to be written down.
      if (catalog.kind === "none" && !catalog.note) {
        problems.push(`${where} declares no catalog without saying why`);
      }
      if (catalog.kind !== "none" && !/^https:\/\//.test(catalog.url ?? "")) {
        problems.push(`${where} declares a catalog with no HTTPS URL`);
      }
    }

    const layoutIds = new Set();
    for (const layout of provider.scheduleLayouts ?? []) {
      layouts += 1;
      const at = `${where} layout ${layout.id ?? "(no id)"}`;
      if (!layout.id || !layout.name) problems.push(`${at} needs an id and a name`);
      if (layoutIds.has(layout.id)) problems.push(`${at} appears more than once`);
      layoutIds.add(layout.id);
      if (!SHAPES.has(layout.shape)) problems.push(`${at} has an unknown shape ${layout.shape}`);
      if (layout.shape === "list" && !(layout.columns ?? []).length) {
        problems.push(`${at} is a list with no column order, so it can read nothing`);
      }
      const weekdays = new Set();
      for (const entry of layout.weekdayTokens ?? []) {
        if (!Number.isInteger(entry.weekday) || entry.weekday < 0 || entry.weekday > 6) {
          problems.push(`${at} has weekday ${entry.weekday}; the encoding is 0 = Sunday through 6`);
        }
        if (weekdays.has(entry.weekday)) problems.push(`${at} repeats weekday ${entry.weekday}`);
        weekdays.add(entry.weekday);
        if (!(entry.tokens ?? []).length) problems.push(`${at} has weekday ${entry.weekday} with no tokens`);
        for (const token of entry.tokens ?? []) {
          if (token !== token.toLowerCase()) problems.push(`${at} token "${token}" must be lowercase`);
        }
      }
      // Thursday shares its first letter with Tuesday. A layout that cannot say
      // "th" turns every Thursday class into a Tuesday one.
      const thursday = (layout.weekdayTokens ?? []).find((entry) => entry.weekday === 4);
      if (thursday && !thursday.tokens.includes("th")) {
        problems.push(`${at} has no "th" token, so Thursday will parse as Tuesday`);
      }
    }
  }

  return { providers: providers.length, terms, noClassDates, layouts, ready: problems.length === 0, problems };
}

function option(name) {
  const found = process.argv.find((value) => value.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1) : undefined;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const providersPath = resolve(
    option("--providers") ?? "apps/desktop/src-tauri/resources/institution-setup-providers.json",
  );
  const directoryPath = resolve(
    option("--directory") ?? "apps/desktop/src-tauri/resources/institutions-us.json",
  );
  const providers = JSON.parse(readFileSync(providersPath, "utf8"));
  const institutionIds = existsSync(directoryPath)
    ? new Set(JSON.parse(readFileSync(directoryPath, "utf8")).map((entry) => entry.id))
    : undefined;
  const result = verifyCalendars({ providers, institutionIds });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) {
    process.stderr.write(`Academic calendar gate failed: ${result.problems.length} problem(s).\n`);
    process.exitCode = 1;
  }
}
