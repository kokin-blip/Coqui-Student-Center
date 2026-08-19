import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseDays, to24Hour } from "../catalog/asu-class-search.mjs";

/**
 * The cross-language pin for weekday and clock parsing.
 *
 * `parseDays` and `to24Hour` in `scripts/catalog/asu-class-search.mjs` are
 * JavaScript; the schedule reader that has to agree with them is Rust. They
 * cannot be shared, so this table is what stops one being fixed without the
 * other — the same arrangement the mutation signing message uses.
 *
 * Keep in lockstep with GOLDEN_WEEKDAY_VECTOR and GOLDEN_CLOCK_VECTOR in
 * apps/desktop/src-tauri/src/schedule_reader.rs.
 */
const GOLDEN_WEEKDAY_VECTOR = [
  ["M", [1]],
  ["MWF", [1, 3, 5]],
  ["TTh", [2, 4]],
  ["TuTh", [2, 4]],
  ["Th", [4]],
  ["SuSa", [0, 6]],
  ["MTWThF", [1, 2, 3, 4, 5]],
  ["F", [5]],
  ["W", [3]],
];

const GOLDEN_CLOCK_VECTOR = [
  ["9:00 AM", "09:00"],
  ["12:00 PM", "12:00"],
  ["12:30 AM", "00:30"],
  ["1:15 PM", "13:15"],
  ["11:59 PM", "23:59"],
];

test("weekday parsing matches the published golden vector", () => {
  for (const [input, expected] of GOLDEN_WEEKDAY_VECTOR) {
    assert.deepEqual([...parseDays(input)].sort((a, b) => a - b), expected, `parsing ${input}`);
  }
  // The digraph rule: Thursday must not read as Tuesday followed by a stray h.
  assert.deepEqual(parseDays("Th"), [4]);
});

test("clock parsing matches the published golden vector", () => {
  for (const [input, expected] of GOLDEN_CLOCK_VECTOR) {
    assert.equal(to24Hour(input), expected, `parsing ${input}`);
  }
});

/**
 * The fixtures the Rust reader is tested against, checked here for the
 * properties a generated fixture can silently lose.
 */
const FIXTURES = [
  "asu-my-classes-list",
  "canvas-calendar-week",
  "google-calendar-week",
  "phone-capture-3x",
  "dark-mode-week",
  "unreadable-capture",
];

const fixturePath = (name, extension) =>
  new URL(
    `../../apps/desktop/src-tauri/test-fixtures/schedule/${name}.${extension}`,
    import.meta.url,
  );

test("every schedule fixture is a well-formed token stream with expectations beside it", () => {
  for (const name of FIXTURES) {
    const tsv = readFileSync(fixturePath(name, "tsv"), "utf8");
    const lines = tsv.trim().split("\n");
    assert.equal(lines[0].split("\t").length, 12, `${name} header`);
    for (const line of lines.slice(1)) {
      const columns = line.split("\t");
      assert.equal(columns.length, 12, `${name} row width`);
      // Geometry is the entire reason these fixtures exist.
      for (const index of [6, 7, 8, 9]) {
        assert.match(columns[index], /^\d+$/, `${name} column ${index} must be a pixel value`);
      }
      assert.ok(Number(columns[8]) > 0 && Number(columns[9]) > 0, `${name} zero-sized box`);
    }
    JSON.parse(readFileSync(fixturePath(name, "expected.json"), "utf8"));
  }
});

test("the deliberately bad fixture expects nothing", () => {
  const expected = JSON.parse(readFileSync(fixturePath("unreadable-capture", "expected.json"), "utf8"));
  // A parser that hallucinates structure from noise is worse than one that
  // declines, so this expectation is the point of the fixture rather than an
  // omission in it.
  assert.deepEqual(expected, []);
});

test("the phone capture really is the laptop layout at 3x", () => {
  const read = (name) =>
    readFileSync(fixturePath(name, "tsv"), "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.split("\t"));
  const laptop = read("canvas-calendar-week");
  const phone = read("phone-capture-3x");
  assert.equal(laptop.length, phone.length);
  for (const [index, row] of laptop.entries()) {
    assert.equal(phone[index][11], row[11], "same words");
    // Scaled geometry with identical text is exactly the case the reader has to
    // be insensitive to, so a fixture that drifted from it would prove nothing.
    assert.equal(Number(phone[index][7]), Number(row[7]) * 3, "top scales by 3");
  }
});

test("every grid fixture describes the same three classes", () => {
  const expectations = FIXTURES.filter((name) => name !== "unreadable-capture").map((name) =>
    JSON.parse(readFileSync(fixturePath(name, "expected.json"), "utf8")),
  );
  for (const expected of expectations) {
    assert.deepEqual(
      expected.map((meeting) => meeting.title).sort(),
      ["CSE 240", "MAT 142", "PSY 101"],
      "a difference in output should mean a difference in layout handling, not in content",
    );
    for (const meeting of expected) {
      assert.equal(meeting.kind, "class_meeting");
      assert.match(meeting.startsAtLocal, /^([01]\d|2[0-3]):[0-5]\d$/);
      assert.ok(meeting.startsAtLocal < meeting.endsAtLocal);
      assert.ok(meeting.weekdays.length > 0);
      assert.ok(meeting.weekdays.every((day) => day >= 0 && day <= 6));
    }
  }
});
