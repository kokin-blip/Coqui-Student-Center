import assert from "node:assert/strict";
import test from "node:test";
import { foldIntoCourses, parseClassSearch } from "../catalog/asu-class-search.mjs";
import { verifyCatalogs } from "../verify-course-catalog.mjs";

// Shaped exactly like `pdftotext -layout` output: rows are indented, long titles
// wrap onto the next line, and the course code sits below the instructor.
const EXPORT = `
          Course                    Title                    Number      Instructor(s)   Days      Start        End          Location            Units

                                    Introduction to Programming   66923       Justin Selgrad   MW        1:30 PM      2:45 PM      Tempe - ISTBX101    3
                                    Languages                     Syllabus
                                    Justin Selgrad   3.1
                                    Computer Science
                 CSE 240
                                    Introduction to Programming   77625       Eric Eckert      T Th      10:30 AM     11:45 AM     West Valley - SANDS131   3
                                    Languages
                                    Eric Eckert   4.0
                                    Computer Science
                 CSE 240
                                    African American History      79932       Jessica Vinas-Nelson   iCourse                                        3
                                    Since 1865
                                    Jessica Vinas   ?
                 AFR 364
`;

test("a class row yields the course code that sits below the instructor", () => {
  const records = parseClassSearch(EXPORT);
  const codes = records.map((record) => record.code);
  assert.deepEqual(codes, ["CSE 240", "CSE 240", "AFR 364"]);
});

// Rows are indented, so the leading run of spaces becomes a delimiter and shifts
// every column by one. That bug produced zero matches from a real export.
test("indented rows do not shift the columns", () => {
  const [first] = parseClassSearch(EXPORT);
  assert.equal(first.section.lineNumber, "66923");
  assert.equal(first.section.instructor, "Justin Selgrad");
  assert.deepEqual(first.section.weekdays, [1, 3]);
  assert.equal(first.section.startsAtLocal, "13:30");
  assert.equal(first.section.endsAtLocal, "14:45");
  assert.equal(first.section.campusId, "tempe");
  assert.equal(first.section.location, "ISTBX101");
  assert.equal(first.credits, 3);
});

// Closing the title at the instructor name must not stop the scan for the code,
// which sits below it. That bug silently reduced a 100-class file to one record.
test("titles wrap without swallowing the instructor or department", () => {
  const records = parseClassSearch(EXPORT);
  assert.equal(records[0].title, "Introduction to Programming Languages");
  assert.equal(records[2].title, "African American History Since 1865");
  for (const record of records) {
    assert.doesNotMatch(record.title, /Selgrad|Eckert|Vinas|Computer Science/);
  }
});

test("online sections carry no weekdays and no clock", () => {
  const online = parseClassSearch(EXPORT).at(-1).section;
  assert.deepEqual(online.weekdays, []);
  assert.equal(online.modality, "online");
  assert.equal(online.startsAtLocal, "");
});

// A page break can splice the running header into a row, leaving weekdays with
// no clock. "Mon Wed · –" is worse than no section at all.
test("a row whose clock was lost to a page break is dropped", () => {
  const broken = `
                                    Communication in Business     81373       Dean Batson      MW        Class Search3:00 PM
                 COM 259
`;
  assert.deepEqual(parseClassSearch(broken), []);
});

test("sections fold into one course, keeping the longest title", () => {
  const courses = foldIntoCourses(parseClassSearch(EXPORT));
  const cse = courses.find((course) => course.code === "CSE 240");
  assert.equal(cse.sections.length, 2);
  assert.equal(cse.title, "Introduction to Programming Languages");
  assert.deepEqual(cse.sections.map((section) => section.campusId), ["tempe", "west-valley"]);
});

test("the gate accepts a well-formed catalog", () => {
  const result = verifyCatalogs({
    catalogs: [{
      institutionId: "104151",
      termId: "asu-fall-2026-c",
      sourceLabel: "ASU Class Search",
      sourceUrl: "https://catalog.apps.asu.edu/catalog/classes",
      courses: foldIntoCourses(parseClassSearch(EXPORT)),
    }],
    institutionIds: new Set(["104151"]),
  });
  assert.equal(result.ready, true, JSON.stringify(result.problems));
});

test("the gate rejects the shapes a bad regeneration produces", () => {
  const cases = [
    [{ institutionId: "104151", courses: [{ code: "CSE 240", title: "x" }] }, /sourceLabel/],
    [{ institutionId: "104151", sourceLabel: "s", sourceUrl: "u", courses: [{ code: "CSE 240", title: "" }] }, /no title/],
    [{ institutionId: "999", sourceLabel: "s", sourceUrl: "u", termId: "t", courses: [{ code: "A 1", title: "t" }] }, /no institution/],
    [{ institutionId: "104151", sourceLabel: "s", sourceUrl: "u", termId: "t", courses: [{ code: "A 1", title: "t", sections: [{ lineNumber: "1", weekdays: [1], startsAtLocal: "", endsAtLocal: "" }] }] }, /no start or end/],
    [{ institutionId: "104151", sourceLabel: "s", sourceUrl: "u", termId: "t", courses: [{ code: "A 1", title: "t", sections: [{ lineNumber: "1", weekdays: [9], startsAtLocal: "10:00", endsAtLocal: "11:00" }] }] }, /outside 0-6/],
    [{ institutionId: "104151", sourceLabel: "s", sourceUrl: "u", termId: "t", courses: [{ code: "A 1", title: "t", sections: [{ lineNumber: "1", weekdays: [1], startsAtLocal: "14:00", endsAtLocal: "11:00" }] }] }, /before it starts/],
    [{ institutionId: "104151", sourceLabel: "s", sourceUrl: "u", courses: [{ code: "A 1", title: "t", sections: [{ lineNumber: "1", weekdays: [1], startsAtLocal: "10:00", endsAtLocal: "11:00" }] }] }, /without a termId/],
  ];
  for (const [catalog, expected] of cases) {
    const result = verifyCatalogs({ catalogs: [catalog], institutionIds: new Set(["104151"]) });
    assert.equal(result.ready, false, `expected a failure for ${JSON.stringify(catalog).slice(0, 80)}`);
    assert.match(result.problems.join(" | "), expected);
  }
});
