/**
 * Reading a registrar calendar page, following the same descriptor the desktop
 * app follows.
 *
 * This is a deliberate second implementation of what `school_calendar.rs` does,
 * for the build-time harvest. The thing that keeps the two honest is that the
 * rule itself — the row pattern, the date format, the section bound — lives in
 * the descriptor rather than in either of them, so both are configured by the
 * same data and a shared fixture proves they agree.
 *
 * Nothing here touches the network; the driver hands it bytes.
 */

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * Tags that end a line rather than merely separating two words. Mirrors
 * `BLOCK_TAGS` in `school_calendar.rs`.
 *
 * Flattened to a single line, a row like "Classes end—last day to process
 * transactions. Session C December 4, 2026" cannot be told from its neighbours:
 * the row pattern latches onto the wrong span, the label is lost, and a real
 * term boundary goes unread. Block structure is the only structure a registrar
 * page reliably has, so it survives de-tagging.
 */
const BLOCK_TAGS = new Set([
  "p", "div", "li", "ul", "ol", "tr", "td", "th", "table", "br", "h1", "h2", "h3", "h4", "h5",
  "h6", "section", "article", "header", "footer", "main", "dt", "dd", "dl", "blockquote",
]);

/**
 * Strip tags to text, one calendar row per line.
 *
 * Script and style bodies are dropped rather than de-tagged: they are full of
 * date-shaped strings, and a parser that reads those invents holidays.
 */
export function stripTags(html) {
  const withoutScripts = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  // Source newlines are formatting, not structure: a single <p> is routinely
  // wrapped across several lines in the file. Flattening them first means the
  // only line breaks left are the ones tags introduce, which are the real ones.
  const flattened = withoutScripts.replace(/\s+/g, " ");
  const text = flattened.replace(/<[^>]*>/g, (tag) => {
    const name = /^<\/?\s*([a-zA-Z0-9]+)/.exec(tag)?.[1]?.toLowerCase() ?? "";
    return BLOCK_TAGS.has(name) ? "\n" : " ";
  });
  return normalizeLines(decodeEntities(text));
}

/** Collapse spaces within each line while keeping the line breaks. */
function normalizeLines(value) {
  return value
    .split("\n")
    .map((line) => line.split(/[^\S\n]+/).filter(Boolean).join(" ").trim())
    .filter(Boolean)
    .join("\n");
}

function decodeEntities(value) {
  return value
    .replaceAll("&nbsp;", " ").replaceAll("&#160;", " ")
    .replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&rsquo;", "'").replaceAll("&lsquo;", "'")
    .replaceAll("&mdash;", "—").replaceAll("&ndash;", "–")
    .replaceAll("&#8212;", "—").replaceAll("&#8211;", "–");
}

const collapse = (value) => value.split(/\s+/).filter(Boolean).join(" ");

/**
 * Translate a descriptor pattern from Rust's regex spelling to JavaScript's.
 *
 * The descriptor stores the Rust spelling because that is what ships in the app;
 * two dialects differ in exactly two places that matter here. Named groups are
 * `(?P<name>)` there and `(?<name>)` here, and multi-line is an inline `(?m)`
 * there and a flag here. Kept in one function so the harvest script and the gate
 * that checks it cannot disagree about what compiles.
 */
export function toJsRegex(pattern, extraFlags = "") {
  const multiline = pattern.startsWith("(?m)");
  const source = pattern.replace(/^\(\?m\)/, "").replaceAll("(?P<", "(?<");
  return new RegExp(source, `${extraFlags}${multiline ? "m" : ""}`);
}

/**
 * Parse the subset of `chrono` format specifiers registrar pages actually use.
 *
 * Supporting a subset and saying so beats pretending to implement `strftime`:
 * an unsupported specifier returns nothing, which surfaces as an unread row
 * rather than as a wrong date.
 */
export function parseDate(value, format) {
  const trimmed = (value ?? "").trim();
  if (!trimmed || !format) return "";
  let pattern = "";
  const order = [];
  for (let index = 0; index < format.length; index += 1) {
    if (format[index] !== "%") {
      pattern += format[index].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      continue;
    }
    index += 1;
    if (format[index] === "-") index += 1;
    const specifier = format[index];
    if (specifier === "B") { pattern += "([A-Za-z]+)"; order.push("month-name"); }
    else if (specifier === "b") { pattern += "([A-Za-z]{3,9})"; order.push("month-name"); }
    else if (specifier === "m") { pattern += "(\\d{1,2})"; order.push("month"); }
    else if (specifier === "d" || specifier === "e") { pattern += "\\s*(\\d{1,2})"; order.push("day"); }
    else if (specifier === "Y") { pattern += "(\\d{4})"; order.push("year"); }
    else if (specifier === "%") { pattern += "%"; }
    else return "";
  }
  const match = new RegExp(`^${pattern}$`).exec(trimmed);
  if (!match) return "";
  const parts = {};
  order.forEach((name, index) => { parts[name] = match[index + 1]; });
  const month = parts["month-name"]
    ? MONTHS.findIndex((name) => name.startsWith(parts["month-name"].toLowerCase())) + 1
    : Number(parts.month);
  const day = Number(parts.day);
  const year = Number(parts.year);
  if (!month || !day || !year || month > 12 || day > 31) return "";
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  // Rejects February 30th and friends, which a padStart would happily produce.
  const round = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(round.getTime()) || round.toISOString().slice(0, 10) !== iso ? "" : iso;
}

/**
 * Read a page that lists a label, then a date per session.
 *
 * This is what a registrar calendar actually looks like, and it is not a row of
 * text per event. The label sits on its own line (sometimes two), and each
 * session's date follows on lines of its own:
 *
 *     Classes end/
 *     last day to process transactions
 *     Session A
 *     October 9, 2026
 *     Session C
 *     December 4, 2026
 *
 * Rows with no session put the date straight under the label. The rule covering
 * both is that a date belongs to the nearest label above it, reached through a
 * session marker when one intervenes — so this is a walk with state rather than
 * a pattern matched per line.
 *
 * Anchoring the session and date patterns to whole lines is what keeps prose out:
 * a summary like "Session C: Thursday, August 20–Friday, December 4, 2026" holds
 * both a session and two dates and must not be read as an event.
 */
export function parseSessionCalendar(html, source) {
  if (!source?.datePattern || !source?.dateFormat) {
    throw new Error("this school's descriptor does not say how to read its calendar");
  }
  const datePattern = toJsRegex(source.datePattern);
  const sessionPattern = source.sessionPattern ? toJsRegex(source.sessionPattern) : undefined;
  const region = boundRegion(stripTags(html), source.sectionPattern);
  const lines = region.split("\n");

  const entries = [];
  let labelParts = [];
  let pendingSession = "";
  let labelLine = -Infinity;

  lines.forEach((line, index) => {
    const session = sessionPattern?.exec(line);
    if (session) {
      pendingSession = session.groups?.session ?? "";
      return;
    }
    const date = datePattern.exec(line);
    if (!date) {
      // Directly after a session marker, a line is that session's value even
      // when it is prose. ASU writes "Final exams / Session A / Last Day of
      // Classes", meaning finals happen then; read as a label, "Last Day of
      // Classes" adopts the next session's date and overwrites the real one.
      if (pendingSession) {
        pendingSession = "";
        return;
      }
      // A run of text lines is one label; "Classes end/" and the clause under it
      // are the same event.
      if (index - labelLine > 1) labelParts = [];
      labelParts.push(line);
      labelLine = index;
      return;
    }
    // A label is the text immediately above its date, not everything since the
    // last one. Without a bound, a page's whole navigation column becomes the
    // label of the first date on it.
    const label = labelOf(labelParts);
    // A label too far above is not this date's label. Without this a heading
    // near the top of the page adopts the first date it can reach.
    if (!label || index - labelLine > 8) {
      pendingSession = "";
      return;
    }
    const { startsOn, endsOn } = assembleDates(date.groups ?? {}, source.dateFormat);
    if (startsOn) {
      entries.push({ label, startsOn, endsOn, sessionCode: pendingSession });
    }
    pendingSession = "";
  });
  return entries;
}

/** At most the last two lines above the date, and never a runaway. */
function labelOf(parts) {
  const tail = collapse(parts.slice(-2).join(" "));
  return tail.length <= 140 ? tail : collapse(parts.slice(-1).join(" ")).slice(0, 140);
}

/**
 * Build the dates from a matched line.
 *
 * A range shares what it does not repeat: "October 10–13, 2026" states the month
 * and year once, and "August 20–October 4, 2026" states the year once. The end
 * borrows whichever it is missing from the start rather than being parsed alone.
 */
function assembleDates(groups, format) {
  const year = groups.year ?? "";
  const start = groups.start ? `${groups.start}, ${year}`.trim() : "";
  const startsOn = parseDate(start, format);
  if (!startsOn) return { startsOn: "", endsOn: "" };
  let endsOn = "";
  if (groups.end) {
    const month = /^[A-Za-z]/.test(groups.end) ? "" : `${groups.start.split(/\s+/)[0]} `;
    endsOn = parseDate(`${month}${groups.end}, ${year}`.trim(), format);
  }
  return { startsOn, endsOn: endsOn && endsOn > startsOn ? endsOn : "" };
}

/**
 * Apply the descriptor's row pattern to a fetched page.
 *
 * Rust's regex crate spells named groups `(?P<name>)`; JavaScript spells them
 * `(?<name>)`. The descriptor stores the Rust spelling because that is what the
 * shipping app parses with, so it is translated here rather than stored twice.
 */
export function parseRegistrarPage(html, source) {
  if (!source?.rowPattern || !source?.dateFormat) {
    throw new Error("this school's descriptor does not say how to read its calendar");
  }
  const region = boundRegion(stripTags(html), source.sectionPattern);
  const pattern = toJsRegex(source.rowPattern, "g");

  const entries = [];
  for (const match of region.matchAll(pattern)) {
    const groups = match.groups ?? {};
    const label = collapse(groups.label ?? "");
    const startsOn = parseDate(groups.start, source.dateFormat);
    if (!label || !startsOn) continue;
    const endsOn = parseDate(groups.end, source.dateFormat);
    entries.push({
      label,
      startsOn,
      endsOn: endsOn && endsOn > startsOn ? endsOn : "",
      sessionCode: collapse(groups.session ?? ""),
    });
  }
  return entries;
}

function boundRegion(text, sectionPattern) {
  if (!sectionPattern) return text;
  const found = toJsRegex(sectionPattern).exec(text);
  return found ? text.slice(found.index) : text;
}

/**
 * Which term boundary a label describes, mirroring `classify` in
 * `school_calendar.rs`. The vocabulary is English registrar phrasing rather than
 * any one school's; a school that words things differently produces unmatched
 * rows, which a descriptor edit can fix.
 */
export function classify(label) {
  // Only the front of the label. A registrar names the row first and explains it
  // afterwards, so a sentence like "…a student must withdraw from all classes in
  // a session. Beginning the first day of classes…" is prose that happens to
  // contain the vocabulary, not a row announcing when term starts.
  const folded = label.toLowerCase().slice(0, 60);
  const has = (needle) => folded.includes(needle);
  if (has("holiday") || has("no classes") || has("break") || has("recess")) return "noClass";
  if (has("final") && (has("begin") || has("start"))) return "examStartsOn";
  // "first day of classes" and "last day of classes" are as common as "classes
  // begin". The "of" matters: "last day to drop a class" is a deadline, not the
  // end of instruction, and must not be read as one.
  if (has("first day of class")) return "startsOn";
  if (has("last day of class")) return "classEndsOn";
  if (has("class") && (has("begin") || has("start"))) return "startsOn";
  if (has("class") && has("end")) return "classEndsOn";
  if ((has("semester") || has("term") || has("session")) && has("end")) return "endsOn";
  return undefined;
}
