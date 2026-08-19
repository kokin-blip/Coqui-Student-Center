import { readFileSync } from "node:fs";

// Parses an ASU Class Search result page that a student exported to PDF and ran
// through `pdftotext -layout`.
//
// This exists because ASU publishes no usable course data. The class search API
// behind catalog.apps.asu.edu answers 401 to anyone anonymous and authenticates
// through weblogin.asu.edu with an OAuth2 code grant; the legacy public search
// redirects into it; and catalog.asu.edu carries policy pages, not courses.
// Fetching it would mean defeating an access control, so nothing here touches
// the network. A student exports their own search -- data they are entitled to
// -- and this reads the file.
//
// ASU renders one class per row; `pdftotext -layout` keeps the columns but wraps
// long titles and pushes the course code onto a later line, so a record is
// assembled from the row plus the first code that follows it.
const DAY_INDEX = { su: 0, m: 1, t: 2, w: 3, th: 4, f: 5, sa: 6 };

// Exported so the cross-language golden vector in scripts/test/schedule-reader.test.mjs
// can pin this against its Rust port in apps/desktop/src-tauri/src/schedule_reader.rs.
// The two cannot share code, so the table is what keeps them honest.
export function parseDays(value) {
  const days = [];
  let rest = value.replace(/\s+/g, "");
  while (rest.length) {
    const two = rest.slice(0, 2).toLowerCase();
    if (two === "th" || two === "su" || two === "sa") {
      days.push(DAY_INDEX[two]);
      rest = rest.slice(2);
      continue;
    }
    const one = rest[0].toLowerCase();
    if (one in DAY_INDEX) days.push(DAY_INDEX[one]);
    rest = rest.slice(1);
  }
  return days;
}

export function to24Hour(value) {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(value.trim());
  if (!match) return "";
  let hour = Number(match[1]) % 12;
  if (match[3].toUpperCase() === "PM") hour += 12;
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

const CAMPUS_IDS = {
  tempe: "tempe",
  poly: "polytechnic",
  dtphx: "downtown-phoenix",
  west: "west-valley",
  "west valley": "west-valley",
};

function parseLocation(value) {
  const [rawCampus, ...room] = value.split(" - ");
  const campusId = CAMPUS_IDS[rawCampus.trim().toLowerCase()] ?? "";
  return { campusId, location: room.join(" - ").trim() || rawCampus.trim() };
}

export function parseClassSearch(text) {
  const rows = text
    .split("\n")
    // Rows are indented, so the leading run of spaces becomes a delimiter and
    // shifts every column by one unless it is stripped.
    .map((line) => line.replace(/\s{2,}/g, "|").replace(/^\|+|\|+$/g, "").trim())
    .filter(Boolean);

  const records = [];
  for (let index = 0; index < rows.length; index += 1) {
    const cells = rows[index].split("|").map((cell) => cell.trim());
    // A class row always carries a 5-digit class number in the second cell and
    // ends with the Add control.
    const number = cells[1];
    if (!/^\d{5}$/.test(number ?? "")) continue;

    const titleHead = cells[0];
    const instructor = cells[2] ?? "";
    let weekdays = [];
    let startsAtLocal = "";
    let endsAtLocal = "";
    let campusId = "";
    let location = "";
    let modality = "in-person";

    if (/^iCourse|^ASU Sync|^Online/i.test(cells[3] ?? "")) {
      modality = cells[3].toLowerCase().startsWith("icourse") ? "online" : cells[3];
      location = cells[3];
    } else {
      weekdays = parseDays(cells[3] ?? "");
      startsAtLocal = to24Hour(cells[4] ?? "");
      endsAtLocal = to24Hour(cells[5] ?? "");
      ({ campusId, location } = parseLocation(cells[6] ?? ""));
    }

    // A page break can splice the running header into a row, merging it with the
    // start time ("Class Search3:00 PM") or truncating the row after the days.
    // The weekdays survive but the clock does not, and a meeting rendered as
    // "Mon Wed · –" is worse than one the student enters themselves.
    if (weekdays.length && !(startsAtLocal && endsAtLocal)) continue;

    const units = cells.find((cell) => /^\d(\.\d)?$/.test(cell));

    // Title continuation lines sit directly beneath, before the course code.
    let code = "";
    let titleOpen = true;
    const titleParts = [titleHead];
    for (let ahead = index + 1; ahead < Math.min(index + 12, rows.length); ahead += 1) {
      const next = rows[ahead].split("|").map((cell) => cell.trim()).filter(Boolean);
      const found = next.find((cell) => /^[A-Z]{2,4}\s\d{3}$/.test(cell));
      if (found) {
        code = found;
        break;
      }
      const continuation = next[0];
      if (!continuation) continue;
      // The instructor is repeated below the row, followed by the department.
      // Both would otherwise be swallowed into the title, producing entries like
      // "History of Black Women in America Mako Ward".
      // Closing the title must not stop the scan: the course code sits below the
      // instructor, so breaking here dropped the record entirely.
      const firstWord = (value) => value.split(/[\s-]/)[0].toLowerCase();
      if (instructor && firstWord(continuation) === firstWord(instructor)) {
        titleOpen = false;
        continue;
      }
      if (
        titleOpen &&
        titleParts.length < 4 &&
        continuation.length <= 60 &&
        !/\d{1,2}\/\d{1,2}/.test(continuation) &&
        !/^(Syllabus|Rate My Professor|RATING|DIFFICULTY|Maroon|Gold|No Data Found|Search this professor|RateMyProfessor|Class Search|ASU Home|Add|Internet|iCourse|ASU Sync|Hybrid|Online|\d+ reviews|reviews)/i.test(continuation) &&
        /^[A-Za-z]/.test(continuation)
      ) {
        titleParts.push(continuation);
      }
    }
    if (!code) continue;

    records.push({
      code,
      title: titleParts.join(" ").replace(/\s+/g, " ").trim(),
      credits: units ? Number(units) : undefined,
      section: {
        lineNumber: number,
        component: "lecture",
        weekdays,
        startsAtLocal,
        endsAtLocal,
        campusId,
        location,
        instructor,
        modality,
      },
    });
  }
  return records;
}

/// Folds section rows into one entry per course, keeping the longest title seen
/// because a wrapped row can yield a truncated one.
export function foldIntoCourses(records) {
  const byCode = new Map();
  for (const record of records) {
    const existing = byCode.get(record.code) ?? {
      code: record.code,
      title: record.title,
      credits: record.credits,
      sections: [],
    };
    if (record.title.length > existing.title.length) existing.title = record.title;
    if (!existing.sections.some((section) => section.lineNumber === record.section.lineNumber)) {
      existing.sections.push(record.section);
    }
    byCode.set(record.code, existing);
  }
  return [...byCode.values()]
    .filter((course) => course.title.trim())
    .sort((left, right) => left.code.localeCompare(right.code));
}
