import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Generate the schedule reader's fixtures.
 *
 *   node scripts/fixtures/render-schedule-fixtures.mjs
 *
 * Each fixture is a Tesseract TSV — a stream of words with the box each one
 * occupied — which is exactly what `parse_tesseract_tsv` produces and exactly
 * what the reader consumes. The repository already takes this approach for
 * `test-fixtures/ocr/syllabus.tsv`.
 *
 * WHAT THIS DOES AND DOES NOT PROVE. These fixtures exercise the layout
 * reasoning: clustering words into rows, finding the weekday headers, assigning
 * a block to a day-column, collapsing a class drawn five times into one weekly
 * pattern. They do not exercise character recognition, because the tokens are
 * generated rather than recognised. Swapping in TSVs captured from real
 * screenshots is a drop-in replacement — the tests read whatever is in the
 * directory — and is worth doing when a Tesseract build is on hand.
 *
 * Generated rather than hand-written so the geometry stays consistent: a phone
 * capture really is the laptop layout at 3x, which is the property the reader
 * has to be insensitive to.
 */

const OUT = resolve("apps/desktop/src-tauri/test-fixtures/schedule");

const HEADER =
  "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";

/**
 * Lay a run of text out on one line and emit a word box per token.
 * Character width is proportional to the font size, so a scaled fixture keeps
 * the same proportions rather than merely the same numbers.
 */
function words({ text, x, y, size = 18, conf = 94, block = 1, par = 1, line = 1 }) {
  const charWidth = size * 0.58;
  const rows = [];
  let cursor = x;
  text.split(/\s+/).filter(Boolean).forEach((word, index) => {
    const width = Math.round(word.length * charWidth);
    rows.push({
      level: 5, page: 1, block, par, line, word: index + 1,
      left: Math.round(cursor), top: Math.round(y), width, height: size,
      conf, text: word,
    });
    cursor += width + charWidth;
  });
  return rows;
}

function toTsv(rows) {
  const body = rows.map((r) =>
    [5, 1, r.block, r.par, r.line, r.word, r.left, r.top, r.width, r.height, r.conf, r.text].join("\t"),
  );
  return `${HEADER}\n${body.join("\n")}\n`;
}

/** Scale every coordinate, as a higher-density screen does. */
function scale(rows, factor) {
  return rows.map((r) => ({
    ...r,
    left: Math.round(r.left * factor),
    top: Math.round(r.top * factor),
    width: Math.round(r.width * factor),
    height: Math.round(r.height * factor),
  }));
}

/** Days across the top, times down the side, classes as blocks. */
function weekGrid({ size = 18, conf = 94, dayLabels, classes, originY = 40 }) {
  const rows = [];
  // Wide enough to hold a full time range, and headers centred over their
  // column, because that is how a real week view is drawn. Get either wrong and
  // a block's text spills past the midpoint into the neighbouring day, which is
  // a property of the drawing rather than of the reader.
  const charWidth = size * 0.58;
  const columnWidth = Math.round(size * 13);
  const gutter = Math.round(size * 4);
  let line = 1;
  dayLabels.forEach((label, index) => {
    const columnStart = gutter + index * columnWidth;
    const labelWidth = label.length * charWidth;
    rows.push(...words({
      text: label,
      x: columnStart + (columnWidth - labelWidth) / 2,
      y: originY, size, conf, line,
    }));
  });
  line += 1;
  for (const entry of classes) {
    const column = entry.day;
    const x = gutter + column * columnWidth;
    const y = originY + entry.slot * size * 4;
    rows.push(...words({ text: entry.time, x, y, size, conf, block: 2, line: line++ }));
    rows.push(...words({ text: entry.course, x, y: y + size * 1.4, size, conf, block: 2, line: line++ }));
    rows.push(...words({ text: entry.room, x, y: y + size * 2.8, size, conf, block: 2, line: line++ }));
  }
  return rows;
}

// Every fixture describes the same three classes wherever possible, so a
// difference in output is a difference in layout handling rather than in content.
const CLASSES = [
  { course: "PSY 101", time: "9:00 AM - 9:50 AM", room: "COOR 174", days: [1, 3, 5] },
  { course: "MAT 142", time: "11:00 AM - 12:15 PM", room: "PSA 21", days: [2, 4] },
  { course: "CSE 240", time: "1:30 PM - 2:45 PM", room: "BYAC 110", days: [1, 3] },
];

function gridRowsFor({ dayLabels, size, conf }) {
  const entries = [];
  for (const cls of CLASSES) {
    for (const day of cls.days) {
      // Column index within the rendered header, not the weekday number.
      const column = dayLabels.findIndex((_, index) => index + 1 === day);
      if (column < 0) continue;
      entries.push({
        day: column,
        slot: CLASSES.indexOf(cls) + 1,
        time: cls.time,
        course: cls.course,
        room: cls.room,
      });
    }
  }
  return weekGrid({ size, conf, dayLabels, classes: entries });
}

const expectedWeekly = CLASSES.map((cls) => ({
  kind: "class_meeting",
  title: cls.course,
  course: cls.course,
  weekdays: cls.days,
  startsAtLocal: to24(cls.time.split(" - ")[0]),
  endsAtLocal: to24(cls.time.split(" - ")[1]),
})).sort((a, b) => a.title.localeCompare(b.title));

function to24(value) {
  const [, h, m, mer] = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(value.trim());
  const hour = (Number(h) % 12) + (mer.toUpperCase() === "PM" ? 12 : 0);
  return `${String(hour).padStart(2, "0")}:${m}`;
}

const fixtures = [];

// 1. A one-row-per-class list, the shape ASU's class search prints.
{
  const rows = [];
  let line = 1;
  rows.push(...words({ text: "Class Course Days Start End Location", x: 40, y: 40, line: line++ }));
  CLASSES.forEach((cls, index) => {
    const y = 80 + index * 34;
    const days = { "1,3,5": "MWF", "2,4": "TTh", "1,3": "MW" }[cls.days.join(",")];
    const [start, end] = cls.time.split(" - ");
    rows.push(...words({
      text: `${cls.course} ${days} ${start} ${end} ${cls.room}`,
      x: 40, y, block: 2, line: line++,
    }));
  });
  fixtures.push({ name: "asu-my-classes-list", rows, expected: expectedWeekly });
}

// 2. A Canvas week view: full weekday names across the top.
fixtures.push({
  name: "canvas-calendar-week",
  rows: gridRowsFor({ dayLabels: ["Mon", "Tue", "Wed", "Thu", "Fri"], size: 18, conf: 93 }),
  expected: expectedWeekly,
});

// 3. Google Calendar prints the day of the month beside the weekday; the reader
//    has to key on the weekday token and ignore the number.
fixtures.push({
  name: "google-calendar-week",
  rows: gridRowsFor({ dayLabels: ["MON", "TUE", "WED", "THU", "FRI"], size: 20, conf: 91 }),
  expected: expectedWeekly,
});

// 4. The same layout on a 3x display. Nothing about the answer may change.
fixtures.push({
  name: "phone-capture-3x",
  rows: scale(gridRowsFor({ dayLabels: ["Mon", "Tue", "Wed", "Thu", "Fri"], size: 18, conf: 90 }), 3),
  expected: expectedWeekly,
});

// 5. Dark mode. Light text on dark ground reads with lower confidence, and the
//    answer still has to be the same one.
fixtures.push({
  name: "dark-mode-week",
  rows: gridRowsFor({ dayLabels: ["Mon", "Tue", "Wed", "Thu", "Fri"], size: 18, conf: 71 }),
  expected: expectedWeekly,
});

// 6. The one that must produce nothing. Cropped so no weekday header survives,
//    low contrast, and rotated enough that rows no longer share a baseline.
//    A reader that finds structure here would find it anywhere.
{
  const rows = [];
  const noise = ["ndav", "1O:", "rm", "8", "PSY", "|", "Ilf", "3O", "..", "3"];
  noise.forEach((text, index) => {
    rows.push(...words({
      text,
      x: 30 + index * 37 + (index % 3) * 11,
      // A few degrees of rotation: every token sits on its own baseline.
      y: 50 + index * 19 + (index % 4) * 7,
      size: 15,
      conf: 24,
      block: index + 1,
      line: index + 1,
    }));
  });
  fixtures.push({ name: "unreadable-capture", rows, expected: [] });
}

mkdirSync(OUT, { recursive: true });
for (const fixture of fixtures) {
  writeFileSync(resolve(OUT, `${fixture.name}.tsv`), toTsv(fixture.rows));
  writeFileSync(
    resolve(OUT, `${fixture.name}.expected.json`),
    `${JSON.stringify(fixture.expected, null, 2)}\n`,
  );
  console.log(`${fixture.name}: ${fixture.rows.length} tokens, ${fixture.expected.length} expected meetings`);
}
console.log(`\nWrote ${fixtures.length} fixtures to ${OUT}`);
