import { z } from "zod";

/**
 * The bundled school descriptor: what a school publishes, stated as data.
 *
 * This mirrors `apps/desktop/src-tauri/src/school_provider.rs`, which is the
 * parser that actually reads `resources/institution-setup-providers.json` at
 * runtime. There is no codegen in this repository — both sides are hand-written
 * and kept honest by parsing the same bundled bytes in their own test suites, the
 * same arrangement the mutation signing message uses in `sync_transport.rs`.
 * Move or rename a field on one side and the other's round-trip test fails.
 *
 * The rule the descriptor exists to enforce is "generic mechanisms,
 * school-specific data": no school gets a code branch, so anything a particular
 * school needs is a field here that any other school could fill in.
 */

/** Bumped when a shape change is not readable by the previous parser. */
export const CURRENT_PROVIDER_SCHEMA_VERSION = 1;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected an ISO YYYY-MM-DD date");

export const CampusDescriptor = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  city: z.string().trim().max(120).default(""),
  timezone: z.string().trim().max(64).default(""),
  sourceLabel: z.string().trim().max(200).default(""),
  sourceUrl: z.string().trim().max(2048).default(""),
}).strict();
export type CampusDescriptor = z.infer<typeof CampusDescriptor>;

/**
 * Holidays, breaks and reading days. A planner that schedules study time on
 * Thanksgiving is wrong in a way a student notices immediately.
 */
export const NoClassDate = z.object({
  startsOn: isoDate,
  /** Inclusive end for a multi-day break; empty for a single day. */
  endsOn: z.union([isoDate, z.literal("")]).default(""),
  label: z.string().trim().min(1).max(200),
}).strict();
export type NoClassDate = z.infer<typeof NoClassDate>;

export const TermDescriptor = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  startsOn: z.union([isoDate, z.literal("")]).default(""),
  endsOn: z.union([isoDate, z.literal("")]).default(""),
  /** Last day of instruction; `endsOn` includes finals. */
  classEndsOn: z.union([isoDate, z.literal("")]).default(""),
  examStartsOn: z.union([isoDate, z.literal("")]).default(""),
  details: z.string().trim().max(500).default(""),
  sourceLabel: z.string().trim().max(200).default(""),
  sourceUrl: z.string().trim().max(2048).default(""),
  /**
   * The registrar's own session name — ASU's "C" for a full semester, "A"/"B"
   * for the half-semester sessions. Two sessions of one term end on different
   * days, so the code is what tells them apart.
   */
  sessionCode: z.string().trim().max(16).default(""),
  noClassDates: z.array(NoClassDate).max(200).default([]),
}).strict();
export type TermDescriptor = z.infer<typeof TermDescriptor>;

export const CalendarSourceKind = z.enum(["ics", "html-table", "html-list"]);
export type CalendarSourceKind = z.infer<typeof CalendarSourceKind>;

/**
 * How to read a school's published academic calendar. The `kind` picks the
 * parser and the rest configures it, so adding a school is a JSON edit rather
 * than a code change.
 */
export const CalendarSource = z.object({
  url: z.string().trim().min(1).max(2048),
  kind: CalendarSourceKind,
  /**
   * A regex bounding the region of the page worth reading, applied after tags
   * are stripped. Not a CSS selector: registrar calendars are frequently not
   * tables and frequently not well-formed, so a DOM parser earns less than the
   * dependency costs.
   */
  sectionPattern: z.string().trim().max(500).default(""),
  /** A `chrono` format string, e.g. `%B %-d, %Y` for "August 20, 2026". */
  dateFormat: z.string().trim().max(100).default(""),
  /** Regex with named groups `label`, `start` and optionally `end`. */
  rowPattern: z.string().trim().max(500).default(""),
}).strict();
export type CalendarSource = z.infer<typeof CalendarSource>;

/**
 * `none` is the common and correct answer. Most schools put their class search
 * behind a login, and defeating that is out of scope, so the screenshot import
 * is what covers them.
 */
export const CatalogSourceKind = z.enum(["none", "ics", "html-table", "student-export"]);
export type CatalogSourceKind = z.infer<typeof CatalogSourceKind>;

export const CatalogSource = z.object({
  kind: CatalogSourceKind,
  url: z.string().trim().max(2048).default(""),
  sectionPattern: z.string().trim().max(500).default(""),
  /** Why this school has no catalog, shown instead of a dead end. */
  note: z.string().trim().max(500).default(""),
}).strict();
export type CatalogSource = z.infer<typeof CatalogSource>;

export const ScheduleShape = z.enum(["grid", "list"]);
export type ScheduleShape = z.infer<typeof ScheduleShape>;

export const GridOrientation = z.enum(["day-major", "time-major"]);
export type GridOrientation = z.infer<typeof GridOrientation>;

export const TimeFormat = z.enum(["hour12", "hour24"]);
export type TimeFormat = z.infer<typeof TimeFormat>;

export const ScheduleColumn = z.enum([
  "ignored",
  "course-code",
  "title",
  "section-number",
  "component",
  "days",
  "start-time",
  "end-time",
  "time-range",
  "location",
  "instructor",
  "modality",
]);
export type ScheduleColumn = z.infer<typeof ScheduleColumn>;

export const WeekdayTokens = z.object({
  /**
   * 0 = Sunday, matching `DAY_INDEX` in `scripts/catalog/asu-class-search.mjs`,
   * `weekly_pattern` in `imports.rs` and the `weekdays` arrays in
   * `institution-catalogs.json`. One encoding, everywhere.
   */
  weekday: z.number().int().min(0).max(6),
  /** Lowercase, because the reader lowercases before matching. */
  tokens: z.array(z.string().regex(/^[a-z]+$/).min(1).max(20)).min(1).max(12),
}).strict();
export type WeekdayTokens = z.infer<typeof WeekdayTokens>;

/**
 * A named schedule layout the screenshot reader can recognise. This is what
 * keeps the reader free of school-specific code: it knows how to cluster tokens
 * into rows and columns, and learns what a weekday header looks like from here.
 */
export const ScheduleLayout = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  shape: ScheduleShape,
  orientation: GridOrientation.default("day-major"),
  timeFormat: TimeFormat.default("hour12"),
  weekdayTokens: z.array(WeekdayTokens).max(7).default([]),
  /** For `list`, what each column means, left to right. */
  columns: z.array(ScheduleColumn).max(24).default([]),
}).strict();
export type ScheduleLayout = z.infer<typeof ScheduleLayout>;

export const SchoolProvider = z.object({
  /** The IPEDS/Scorecard unit id, so a descriptor joins to the other bundles. */
  institutionId: z.string().trim().min(1).max(32),
  schemaVersion: z.number().int().min(1).max(1_000).default(0),
  /** When the harvest that produced this entry ran, shown next to its dates. */
  generatedAt: z.string().trim().max(40).default(""),
  sourceLabel: z.string().trim().max(200).default(""),
  sourceUrl: z.string().trim().max(2048).default(""),
  campuses: z.array(CampusDescriptor).max(100).default([]),
  terms: z.array(TermDescriptor).max(200).default([]),
  calendarSource: CalendarSource.optional(),
  catalogSource: CatalogSource.optional(),
  scheduleLayouts: z.array(ScheduleLayout).max(20).default([]),
}).strict();
export type SchoolProvider = z.infer<typeof SchoolProvider>;

export const SchoolProviderBundle = z.array(SchoolProvider);
export type SchoolProviderBundle = z.infer<typeof SchoolProviderBundle>;

/**
 * Whether a descriptor claims a catalog the app can actually read. `false` is
 * the common case and is not an error state.
 *
 * Mirrors `SchoolProvider::has_readable_catalog` in the Rust module.
 */
export function hasReadableCatalog(provider: SchoolProvider): boolean {
  return provider.catalogSource !== undefined && provider.catalogSource.kind !== "none";
}
