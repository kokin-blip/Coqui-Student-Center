import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { classify, parseDate, parseSessionCalendar, stripTags } from "../calendar/registrar-page.mjs";
import { verifyCalendars } from "../verify-academic-calendar.mjs";

const providers = JSON.parse(readFileSync(
  new URL("../../apps/desktop/src-tauri/resources/institution-setup-providers.json", import.meta.url),
  "utf8",
));
const asu = providers.find((provider) => provider.institutionId === "104151");
const fixture = readFileSync(
  new URL("../../apps/desktop/src-tauri/test-fixtures/calendar/asu-academic-calendar.html", import.meta.url),
  "utf8",
);

/**
 * The cross-language pin for the calendar parsers.
 *
 * `school_calendar.rs` reads this same fixture with this same descriptor in its
 * own suite and asserts the same rows. Neither implementation owns the rule —
 * the patterns and the date format live in the descriptor — so this is what
 * catches one of them drifting from it.
 *
 * The fixture is a saved copy of the live registrar page, not a reconstruction.
 * The previous one was written from a description of the page, and the pattern
 * fitted to it read the real thing as 152 rows that matched nothing at all.
 */
test("the bundled descriptor reads the real registrar page", () => {
  const entries = parseSessionCalendar(fixture, asu.calendarSource);
  assert.ok(entries.length >= 100, `expected a full calendar, read ${entries.length}`);

  const sessionC = (needle, year) =>
    entries.find(
      (entry) =>
        entry.sessionCode === "C" &&
        entry.startsOn.startsWith(year) &&
        entry.label.toLowerCase().includes(needle),
    );
  assert.equal(sessionC("classes begin", "2026").startsOn, "2026-08-20");
  assert.equal(sessionC("classes end", "2026").startsOn, "2026-12-04");
  assert.equal(sessionC("classes begin", "2027").startsOn, "2027-01-11");
});

// A date belongs to the label above it, not to the whole page above it.
test("a label is the text immediately above its date", () => {
  const entries = parseSessionCalendar(fixture, asu.calendarSource);
  for (const entry of entries) {
    assert.ok(entry.label.length <= 140, `runaway label: ${entry.label}`);
  }
  // Two lines are one label when the registrar wraps it.
  assert.ok(entries.some((entry) => entry.label.startsWith("Classes end/")));
});

// The page writes "Final exams / Session A / Last Day of Classes", meaning
// finals happen then. Read as a label, "Last Day of Classes" adopts the next
// session's date and overwrites the real end-of-classes date with the day
// finals start.
test("a value standing in for a date does not become a label", () => {
  const entries = parseSessionCalendar(fixture, asu.calendarSource);
  assert.ok(
    !entries.some((entry) => entry.label.toLowerCase() === "last day of classes"),
    "a session's stand-in value was read as a label",
  );
  const finals = entries.find(
    (entry) =>
      entry.label.toLowerCase().startsWith("final exams") &&
      entry.sessionCode === "C" &&
      entry.startsOn.startsWith("2026"),
  );
  assert.equal(finals.startsOn, "2026-12-07");
});

test("a multi-day break is read as a range that borrows what it does not repeat", () => {
  const entries = parseSessionCalendar(fixture, asu.calendarSource);
  const fallBreak = entries.find((entry) => entry.label.toLowerCase().startsWith("fall break"));
  // "October 10–13, 2026" states the month and year once.
  assert.equal(fallBreak.startsOn, "2026-10-10");
  assert.equal(fallBreak.endsOn, "2026-10-13");
  assert.equal(classify(fallBreak.label), "noClass");
});

// A parser that reads script and style text invents holidays out of the
// date-shaped strings every analytics tag is full of.
test("script and style text never becomes a calendar row", () => {
  const body = `<html><head><style>.a{content:"August 31, 2026"}</style>
    <script>var d = "September 1, 2026";</script></head>
    <body><p>Classes begin</p><p>August 20, 2026</p></body></html>`;
  const entries = parseSessionCalendar(body, asu.calendarSource);
  assert.equal(entries.length, 1, `read more than the one real row: ${JSON.stringify(entries)}`);
  assert.equal(entries[0].startsOn, "2026-08-20");
  assert.equal(entries[0].label, "Classes begin");
});

test("a tag boundary separates words rather than joining them", () => {
  const text = stripTags("<td>Classes begin</td><td>August 20, 2026</td>");
  assert.match(text.split(/\s+/).filter(Boolean).join(" "), /Classes begin August 20, 2026/);
});

test("dates parse against the descriptor's format and reject impossible ones", () => {
  assert.equal(parseDate("August 20, 2026", "%B %-d, %Y"), "2026-08-20");
  // Registrar pages mix padded and unpadded days in the same column.
  assert.equal(parseDate("December 4, 2026", "%B %-d, %Y"), "2026-12-04");
  assert.equal(parseDate("Aug 20, 2026", "%b %-d, %Y"), "2026-08-20");
  assert.equal(parseDate("February 30, 2026", "%B %-d, %Y"), "", "a date that does not exist");
  assert.equal(parseDate("20 August 2026", "%B %-d, %Y"), "", "the wrong shape entirely");
  assert.equal(parseDate("", "%B %-d, %Y"), "");
});

test("boundary vocabulary is registrar phrasing rather than one school's wording", () => {
  assert.equal(classify("Classes begin"), "startsOn");
  assert.equal(classify("First day of classes"), "startsOn");
  assert.equal(classify("Last day of classes"), "classEndsOn");
  assert.equal(classify("Classes end/last day to process transactions"), "classEndsOn");
  assert.equal(classify("Final exams"), undefined, "a bare label needs begin or start");
  assert.equal(classify("Final exams begin"), "examStartsOn");
  assert.equal(classify("Session ends"), "endsOn");
  assert.equal(classify("Labor Day holiday"), "noClass");
  assert.equal(classify("Spring break"), "noClass");
  // A deadline that mentions a class is not the end of instruction.
  assert.equal(classify("Last day to drop a class"), undefined);
  // A row nobody modelled stays unclassified, so it is reported rather than
  // written onto a term boundary it does not describe.
  assert.equal(classify("Tuition and fees 100% refund deadline"), undefined);
});

// The page is one long document with prose in it. A sentence that happens to
// contain the vocabulary is not a row announcing when term starts.
test("prose containing the vocabulary is not a term boundary", () => {
  const prose =
    "As part of a complete session withdrawal a student must withdraw from all " +
    "classes in a session. Beginning the first day of classes, undergraduate students may withdraw";
  assert.equal(classify(prose), undefined);
});

test("the calendar gate accepts the bundled descriptors", () => {
  const result = verifyCalendars({ providers });
  assert.equal(result.ready, true, JSON.stringify(result.problems));
  assert.ok(result.terms > 0);
  assert.ok(result.noClassDates > 0, "the harvest has been run against the live page");
});

test("the calendar gate fails a malformed regeneration", () => {
  const cases = [
    ["a term that ends before it starts", (p) => { p.terms[0].endsOn = "2026-01-01"; }],
    ["finals before classes end", (p) => { p.terms[0].examStartsOn = "2026-11-01"; }],
    ["a holiday outside its term", (p) => { p.terms[0].noClassDates = [{ startsOn: "2027-07-04", endsOn: "", label: "Independence Day" }]; }],
    ["a date pattern that does not compile", (p) => { p.calendarSource.datePattern = "(?P<start>[unclosed"; }],
    // The quiet one: a pattern with no groups parses every page to nothing, and
    // "no changes found" is what a working refresh also reports.
    ["a date pattern with no named groups", (p) => { p.calendarSource.datePattern = "\\d{4}"; }],
    ["HTML with no date format", (p) => { p.calendarSource.dateFormat = ""; }],
    ["an unknown calendar kind", (p) => { p.calendarSource.kind = "html-telepathy"; }],
    ["no catalog and no reason given", (p) => { p.catalogSource.note = ""; }],
    ["a layout that cannot tell Thursday from Tuesday", (p) => {
      const thursday = p.scheduleLayouts[0].weekdayTokens.find((entry) => entry.weekday === 4);
      thursday.tokens = ["thursday"];
    }],
    ["a repeated weekday", (p) => { p.scheduleLayouts[0].weekdayTokens.push({ weekday: 1, tokens: ["m"] }); }],
    ["an uppercase weekday token", (p) => { p.scheduleLayouts[0].weekdayTokens[1].tokens = ["Mon"]; }],
    ["a list layout with no columns", (p) => { p.scheduleLayouts[0].columns = []; }],
    ["a stale schema version", (p) => { p.schemaVersion = 0; }],
  ];
  for (const [name, mutate] of cases) {
    const broken = JSON.parse(JSON.stringify(providers));
    mutate(broken.find((provider) => provider.institutionId === "104151"));
    const result = verifyCalendars({ providers: broken });
    assert.equal(result.ready, false, `the gate accepted ${name}`);
  }
});

test("a descriptor for an institution outside the directory fails the gate", () => {
  const result = verifyCalendars({ providers, institutionIds: new Set(["999999"]) });
  assert.equal(result.ready, false);
});
