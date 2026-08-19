//! The bundled school descriptor: what a school publishes, stated as data.
//!
//! The rule this module exists to enforce is "generic mechanisms, school-specific
//! data". No school gets a Rust branch. Everything ASU needs beyond the generic
//! path — where its academic calendar lives, how that page is laid out, what a
//! weekday header looks like in its schedule screenshots — is a field here that
//! any other school could fill in. If a feature cannot be stated in this file, it
//! does not ship.
//!
//! This is the *file* format for `resources/institution-setup-providers.json`.
//! It is deliberately not the wire format the UI receives: `main.rs` projects a
//! `SchoolProvider` down to an `InstitutionSetupOptions`, so the descriptor can
//! carry fields the setup screen does not read yet without changing what
//! `get_institution_setup_options` returns.
//!
//! The TypeScript mirror is `packages/contracts/src/school-provider.ts`. There is
//! no codegen in this repository; both sides are hand-written and pinned by a
//! shared golden vector, the same arrangement `sync_transport.rs` uses for the
//! mutation signing message. Move a field on one side and the other fails.

use serde::{Deserialize, Serialize};

/// Bumped when a change to this file's shape is not readable by the previous
/// parser. Additive fields do not need a bump, because every field below is
/// defaulted.
pub const CURRENT_PROVIDER_SCHEMA_VERSION: u32 = 1;

/// One school. `institution_id` is the IPEDS/Scorecard unit id used everywhere
/// else in the app, so a descriptor joins to `institutions-us.json` and to
/// `institution-catalogs.json` without a second key.
///
/// `deny_unknown_fields` is deliberate. This file ships inside the binary that
/// parses it, so the two can never be out of step, and a mistyped key in a
/// hand-edited descriptor should fail a test rather than be silently ignored.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SchoolProvider {
    pub institution_id: String,
    #[serde(default)]
    pub schema_version: u32,
    /// When the harvest that produced this entry ran. Shown next to pre-filled
    /// dates so a student can see how old the data they are trusting is.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub generated_at: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub source_label: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub source_url: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub campuses: Vec<CampusDescriptor>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub terms: Vec<TermDescriptor>,
    /// Where the registrar publishes term dates, and how to read that page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar_source: Option<CalendarSource>,
    /// Where course sections come from. Most schools answer `None` here: their
    /// class search sits behind a login, and defeating that is out of scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_source: Option<CatalogSource>,
    /// Layout hints for reading a schedule screenshot. Empty is legal and means
    /// the reader falls back to its generic defaults.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub schedule_layouts: Vec<ScheduleLayout>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CampusDescriptor {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub city: String,
    #[serde(default)]
    pub timezone: String,
    #[serde(default)]
    pub source_label: String,
    #[serde(default)]
    pub source_url: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TermDescriptor {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub starts_on: String,
    #[serde(default)]
    pub ends_on: String,
    /// Last day of instruction. Distinct from `ends_on`, which includes finals.
    #[serde(default)]
    pub class_ends_on: String,
    #[serde(default)]
    pub exam_starts_on: String,
    #[serde(default)]
    pub details: String,
    #[serde(default)]
    pub source_label: String,
    #[serde(default)]
    pub source_url: String,
    /// The registrar's own name for the session — ASU's "C" for a full-semester
    /// session, "A"/"B" for the half-semester ones. Two sessions of the same
    /// term have different end dates, so the code is what disambiguates them.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub session_code: String,
    /// Holidays, breaks and reading days. A planner that schedules study time on
    /// Thanksgiving is wrong in a way a student notices immediately.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub no_class_dates: Vec<NoClassDate>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoClassDate {
    /// Inclusive ISO date. Multi-day breaks set `ends_on` as well.
    pub starts_on: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub ends_on: String,
    pub label: String,
}

/// How to read a school's published academic calendar.
///
/// The `kind` picks the parser; the remaining fields configure it. A school that
/// publishes an `.ics` needs nothing but a URL. One that publishes an HTML table
/// needs a row pattern and a date format. Adding a school is a JSON edit.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalendarSource {
    pub url: String,
    pub kind: CalendarSourceKind,
    /// A regex bounding the region of the page worth reading, applied after
    /// tags are stripped. Not a CSS selector: registrar calendars are often not
    /// tables, often not well-formed, and a DOM parser earns less than it costs.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub section_pattern: String,
    /// `chrono` format string, e.g. `%B %-d, %Y` for "August 20, 2026".
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub date_format: String,
    /// Regex splitting one row into label and date(s). Named groups `label`,
    /// `start` and optionally `end` are what the parser reads.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub row_pattern: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CalendarSourceKind {
    #[default]
    Ics,
    HtmlTable,
    HtmlList,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogSource {
    pub kind: CatalogSourceKind,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub url: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub section_pattern: String,
    /// Why this school is `None`, shown to the student instead of a dead end.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CatalogSourceKind {
    /// No readable public catalog. The student imports a screenshot instead.
    /// This is the honest answer for most schools and must never look broken.
    #[default]
    None,
    Ics,
    HtmlTable,
    /// A file the student exports from their own account and hands to the app.
    StudentExport,
}

/// A named schedule layout the screenshot reader can recognise.
///
/// This is what keeps Phase 4 free of school-specific code. The reader knows how
/// to cluster tokens into rows and columns; it learns what a weekday header
/// looks like, and which column holds what, from here.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleLayout {
    pub id: String,
    pub name: String,
    pub shape: ScheduleShape,
    /// Only meaningful for `Grid`.
    #[serde(default)]
    pub orientation: GridOrientation,
    #[serde(default)]
    pub time_format: TimeFormat,
    /// Tokens that identify a weekday column header, lowercased before matching.
    /// An array rather than a map because `serde_json` is built without
    /// `preserve_order`, and a map would not round-trip to the same bytes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub weekday_tokens: Vec<WeekdayTokens>,
    /// For `List`, the meaning of each column left to right.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub columns: Vec<ScheduleColumn>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScheduleShape {
    /// Days across, times down — a week view.
    #[default]
    Grid,
    /// One row per class, days as a single `MWF`-style token.
    List,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GridOrientation {
    #[default]
    DayMajor,
    TimeMajor,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TimeFormat {
    #[default]
    Hour12,
    Hour24,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WeekdayTokens {
    /// 0 = Sunday, matching `DAY_INDEX` in `scripts/catalog/asu-class-search.mjs`,
    /// `weekly_pattern` in `imports.rs`, and the `weekdays` arrays in
    /// `institution-catalogs.json`. One encoding, everywhere.
    pub weekday: u8,
    pub tokens: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScheduleColumn {
    #[default]
    Ignored,
    CourseCode,
    Title,
    SectionNumber,
    Component,
    Days,
    StartTime,
    EndTime,
    /// A single cell holding both times, e.g. "9:00 AM - 9:50 AM".
    TimeRange,
    Location,
    Instructor,
    Modality,
}

impl SchoolProvider {
    /// Whether this descriptor claims a catalog the app can actually read.
    /// `false` is the common case and is not an error state.
    pub fn has_readable_catalog(&self) -> bool {
        !matches!(
            self.catalog_source.as_ref().map(|source| source.kind),
            None | Some(CatalogSourceKind::None)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bundled file must parse, and re-serializing it must produce the same
    /// value. A descriptor that silently loses a field on the way through is
    /// worse than one that fails to parse, because the loss only shows up as a
    /// school whose calendar quietly stops refreshing.
    #[test]
    fn the_bundled_descriptor_round_trips() {
        let raw = include_str!("../resources/institution-setup-providers.json");
        let providers: Vec<SchoolProvider> =
            serde_json::from_str(raw).expect("bundled descriptors must parse");
        assert!(
            !providers.is_empty(),
            "the bundle ships at least one school"
        );

        let reserialized = serde_json::to_string(&providers).unwrap();
        let reparsed: Vec<SchoolProvider> = serde_json::from_str(&reserialized).unwrap();
        assert_eq!(providers, reparsed, "descriptors must survive a round trip");

        for provider in &providers {
            assert_eq!(
                provider.schema_version, CURRENT_PROVIDER_SCHEMA_VERSION,
                "every bundled descriptor states its schema version"
            );
            assert!(!provider.institution_id.is_empty());
            for term in &provider.terms {
                assert!(
                    !term.starts_on.is_empty() && !term.ends_on.is_empty(),
                    "a term preset without dates cannot pre-fill anything"
                );
            }
            for layout in &provider.schedule_layouts {
                for entry in &layout.weekday_tokens {
                    assert!(
                        entry.weekday <= 6,
                        "weekdays are 0=Sunday through 6=Saturday"
                    );
                    assert!(!entry.tokens.is_empty());
                    for token in &entry.tokens {
                        assert_eq!(
                            token.to_lowercase(),
                            *token,
                            "weekday tokens are matched lowercased, so store them that way"
                        );
                    }
                }
            }
        }
    }

    /// A typo in a hand-edited descriptor should fail loudly rather than be
    /// dropped. The file and its parser ship in the same binary, so there is no
    /// forward-compatibility reason to accept unknown keys.
    #[test]
    fn unknown_fields_are_rejected() {
        let raw = r#"[{"institutionId":"1","schemaVersion":1,"campusez":[]}]"#;
        assert!(serde_json::from_str::<Vec<SchoolProvider>>(raw).is_err());
    }

    /// Most schools have no readable catalog. That is a supported state, not a
    /// misconfiguration, and the screenshot path is what covers it.
    #[test]
    fn a_missing_catalog_source_is_a_supported_state() {
        let provider = SchoolProvider::default();
        assert!(!provider.has_readable_catalog());

        let explicit = SchoolProvider {
            catalog_source: Some(CatalogSource {
                kind: CatalogSourceKind::None,
                note: "class search requires a login".into(),
                ..CatalogSource::default()
            }),
            ..SchoolProvider::default()
        };
        assert!(!explicit.has_readable_catalog());
    }

    /// The enum spellings are part of the file format. Renaming a variant
    /// silently invalidates every descriptor already written.
    #[test]
    fn enum_spellings_are_pinned() {
        assert_eq!(
            serde_json::to_string(&CalendarSourceKind::HtmlTable).unwrap(),
            "\"html-table\""
        );
        assert_eq!(
            serde_json::to_string(&CatalogSourceKind::StudentExport).unwrap(),
            "\"student-export\""
        );
        assert_eq!(
            serde_json::to_string(&ScheduleShape::List).unwrap(),
            "\"list\""
        );
        assert_eq!(
            serde_json::to_string(&GridOrientation::TimeMajor).unwrap(),
            "\"time-major\""
        );
        assert_eq!(
            serde_json::to_string(&TimeFormat::Hour12).unwrap(),
            "\"hour12\""
        );
        assert_eq!(
            serde_json::to_string(&ScheduleColumn::CourseCode).unwrap(),
            "\"course-code\""
        );
    }
}
