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
  const folded = label.toLowerCase();
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
