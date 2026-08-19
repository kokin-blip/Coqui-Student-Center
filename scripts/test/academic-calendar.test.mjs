import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { classify, parseDate, parseRegistrarPage, stripTags } from "../calendar/registrar-page.mjs";
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
 * the row pattern and date format live in the descriptor — so this is what
 * catches one of them drifting from it.
 */
test("the bundled row pattern reads the bundled fixture", () => {
  const entries = parseRegistrarPage(fixture, asu.calendarSource);
  assert.ok(entries.length >= 6, `expected several rows, read ${entries.length}`);

  const begins = entries.find((entry) => entry.label.toLowerCase().includes("classes begin"));
  assert.ok(begins, "the page states when classes begin");
  assert.equal(begins.startsOn, "2026-08-20");
  assert.equal(begins.sessionCode, "C");

  // Every boundary the bundled Fall 2026 term declares is readable off the page.
  // The page lists two academic years, so "Classes end" appears more than once;
  // scope to the term's own span rather than taking the first match.
  const fall = asu.terms.find((term) => term.id === "asu-fall-2026-c");
  const read = (needle) => entries.find((entry) =>
    entry.label.toLowerCase().includes(needle)
    && entry.startsOn >= fall.startsOn && entry.startsOn <= fall.endsOn);
  assert.equal(read("classes end").startsOn, fall.classEndsOn);
  assert.equal(read("final exams begin").startsOn, fall.examStartsOn);
  assert.equal(read("session ends").startsOn, fall.endsOn);
});

// The row that motivated keeping block structure: a label, a long explanatory
// clause, then the session and the date. Flattened to one line this parsed as
// label "Session C" with no session code, losing a real term boundary.
test("a row with an explanatory clause keeps its label and session", () => {
  const entries = parseRegistrarPage(fixture, asu.calendarSource);
  const classesEnd = entries.find((entry) => entry.startsOn === "2026-12-04");
  assert.equal(classesEnd.label, "Classes end");
  assert.equal(classesEnd.sessionCode, "C");

  const drop = entries.find((entry) => entry.startsOn === "2026-08-26");
  assert.equal(drop.label, "Drop deadline");
  // Read, but not a boundary anything models, so it is reported unmatched
  // rather than written onto a term.
  assert.equal(classify(drop.label), undefined);
});

test("a multi-day break is read as a range", () => {
  const entries = parseRegistrarPage(fixture, asu.calendarSource);
  const fallBreak = entries.find((entry) => entry.label.toLowerCase().includes("fall break"));
  assert.equal(fallBreak.startsOn, "2026-10-10");
  assert.equal(fallBreak.endsOn, "2026-10-13");
  assert.equal(classify(fallBreak.label), "noClass");
});

// A parser that reads script and style text invents holidays. The fixture
// carries three date-shaped strings in those blocks precisely to catch it.
test("script and style text never becomes a calendar row", () => {
  const entries = parseRegistrarPage(fixture, asu.calendarSource);
  for (const decoy of ["2026-08-31", "2026-09-01"]) {
    assert.ok(!entries.some((entry) => entry.startsOn === decoy), `read a decoy date ${decoy}`);
  }
  const text = stripTags(fixture);
  assert.ok(!text.includes("dataLayer"));
  assert.ok(!text.includes("content:"));
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
  // A deadline that mentions a class is not the end of instruction.
  assert.equal(classify("Last day to drop a class"), undefined);
  assert.equal(classify("Classes end/last day to process transactions"), "classEndsOn");
  assert.equal(classify("Final exams begin"), "examStartsOn");
  assert.equal(classify("Session ends"), "endsOn");
  assert.equal(classify("Labor Day holiday"), "noClass");
  assert.equal(classify("Spring break"), "noClass");
  // A row nobody modelled stays unclassified, so it is reported rather than
  // written onto a term boundary it does not describe.
  assert.equal(classify("Tuition and fees 100% refund deadline"), undefined);
});

test("the calendar gate accepts the bundled descriptors", () => {
  const result = verifyCalendars({ providers });
  assert.equal(result.ready, true, JSON.stringify(result.problems));
  assert.ok(result.terms > 0);
});

test("the calendar gate fails a malformed regeneration", () => {
  const cases = [
    ["a term that ends before it starts", (p) => { p.terms[0].endsOn = "2026-01-01"; }],
    ["finals before classes end", (p) => { p.terms[0].examStartsOn = "2026-11-01"; }],
    ["a holiday outside its term", (p) => { p.terms[0].noClassDates = [{ startsOn: "2027-07-04", endsOn: "", label: "Independence Day" }]; }],
    ["a row pattern that does not compile", (p) => { p.calendarSource.rowPattern = "(?P<label>[unclosed"; }],
    // The quiet one: a pattern with no groups parses every page to nothing, and
    // "no changes found" is what a working refresh also reports.
    ["a row pattern with no named groups", (p) => { p.calendarSource.rowPattern = "\\d{4}"; }],
    ["HTML with no date format", (p) => { p.calendarSource.dateFormat = ""; }],
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
  const result = verifyCalendars({
    providers,
    institutionIds: new Set(["999999"]),
  });
  assert.equal(result.ready, false);
});
