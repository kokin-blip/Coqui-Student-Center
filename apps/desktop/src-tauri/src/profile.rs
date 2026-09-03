use chrono::{Datelike, NaiveDate, Utc};
use chrono_tz::Tz;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use uuid::Uuid;

pub const PROFILE_ID: &str = "00000000-0000-4000-8000-000000000010";
pub const ONBOARDING_VERSION: i64 = 2;
const MAX_COMMITMENTS: usize = 50;
const MAX_AVAILABILITY_RULES: usize = 28;

#[derive(thiserror::Error, Debug)]
pub enum ProfileError {
    #[error("profile storage error: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("invalid profile input: {0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, ProfileError>;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingDraft {
    pub name: String,
    pub timezone: String,
    pub term_name: String,
    pub term_starts_on: String,
    pub term_ends_on: String,
    /// Holidays and breaks the school publishes for this term. Carried from the
    /// term preset so the planner stops scheduling study time on Labor Day; the
    /// mechanism that honours them already existed and only lacked any data.
    #[serde(default)]
    pub term_no_class_dates: Vec<NoClassDateInput>,
    pub course_title: String,
    pub course_code: String,
    #[serde(default)]
    pub institution: InstitutionSelection,
    #[serde(default)]
    pub courses: Vec<OnboardingCourseInput>,
    #[serde(default)]
    pub appearance: AppearancePreference,
    pub sleep_start: String,
    pub sleep_end: String,
    pub max_session_minutes: i64,
    pub break_minutes: i64,
    pub transition_minutes: i64,
    pub default_commute_minutes: i64,
    pub availability: Vec<AvailabilityInput>,
    pub commitments: Vec<CommitmentInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstitutionSelection {
    pub id: String,
    pub name: String,
    pub country: String,
    pub source: String,
    pub official_domain: Option<String>,
    pub catalog_provider_status: String,
    pub custom: bool,
    /// Primary campus. Drives the default class-meeting location and the setup
    /// summary, so it stays a single value even when several are attended.
    #[serde(default)]
    pub campus_id: String,
    #[serde(default)]
    pub campus_name: String,
    /// Every campus the student attends, primary first. Empty on profiles saved
    /// before multi-campus support; treat `campus_id` as the sole entry then.
    #[serde(default)]
    pub campus_ids: Vec<String>,
    #[serde(default)]
    pub campus_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NoClassDateInput {
    pub starts_on: String,
    /// Empty for a single day.
    #[serde(default)]
    pub ends_on: String,
    pub label: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingCourseInput {
    pub code: String,
    pub title: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub meetings: Vec<ClassMeetingInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClassMeetingInput {
    pub weekdays: Vec<i64>,
    pub starts_at_local: String,
    pub ends_at_local: String,
    pub component: String,
    pub location: String,
    pub instructor_name: String,
    #[serde(default="default_rotation_interval")]
    pub rotation_interval_weeks:i64,
    #[serde(default)]
    pub rotation_offset_weeks:i64,
}

fn default_rotation_interval()->i64{1}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum AppearancePreference {
    #[default]
    System,
    CoquiDark,
    Midnight,
    Graphite,
    Forest,
    Light,
}

impl AppearancePreference {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::CoquiDark => "coqui-dark",
            Self::Midnight => "midnight",
            Self::Graphite => "graphite",
            Self::Forest => "forest",
            Self::Light => "light",
        }
    }

    /// `dark` is the pre-0.9 name for the only dark theme there was; stored
    /// profiles still carry it.
    pub fn from_setting(value: &str) -> Option<Self> {
        Some(match value {
            "system" => Self::System,
            "coqui-dark" | "dark" => Self::CoquiDark,
            "midnight" => Self::Midnight,
            "graphite" => Self::Graphite,
            "forest" => Self::Forest,
            "light" => Self::Light,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailabilityInput {
    pub weekday: i64,
    pub starts_at_local: String,
    pub ends_at_local: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitmentInput {
    pub title: String,
    pub starts_at: String,
    pub ends_at: String,
    pub kind: String,
    pub location: String,
    pub travel_before_minutes: i64,
    pub travel_after_minutes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyQuarantineItem {
    pub id: String,
    pub entity_type: String,
    pub title: String,
    pub quarantined_at: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LegacyQuarantineStatus {
    pub detected_count: i64,
    pub quarantine_complete: bool,
    pub recovery_available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingState {
    pub required: bool,
    pub onboarding_version: i64,
    pub legacy_quarantine_status: LegacyQuarantineStatus,
    pub draft: OnboardingDraft,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub profile: Option<StudentProfileRecord>,
    pub institution: Option<InstitutionSelection>,
    pub appearance: AppearancePreference,
    pub accent: String,
    pub terms: Vec<AcademicTermRecord>,
    pub courses: Vec<CourseRecord>,
    pub tasks: Vec<TaskRecord>,
    pub commitments: Vec<CommitmentRecord>,
    pub instructors: Vec<InstructorRecord>,
    pub class_meetings: Vec<ClassMeetingSeriesRecord>,
    pub academic_events: Vec<AcademicCalendarEventRecord>,
    pub preferences: Option<PlanningPreferenceRecord>,
    pub availability: Vec<AvailabilityInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudentProfileRecord {
    pub name: String,
    pub timezone: String,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcademicTermRecord {
    pub id: String,
    pub name: String,
    pub starts_on: String,
    pub ends_on: String,
    pub active: bool,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseRecord {
    pub id: String,
    pub title: String,
    pub code: String,
    pub term_id: Option<String>,
    pub version: i64,
    pub record_origin: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    pub id: String,
    pub title: String,
    pub minutes: i64,
    pub due_at: Option<String>,
    pub course_id: Option<String>,
    pub priority: i64,
    pub academic_risk: i64,
    pub earliest_start: Option<String>,
    pub energy_demand: String,
    pub location: String,
    pub splittable: bool,
    pub min_session_minutes: i64,
    pub max_session_minutes: i64,
    pub completed: bool,
    pub version: i64,
    pub dependencies: Vec<String>,
    pub record_origin: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructorRecord {
    pub id: String,
    pub course_id: String,
    pub name: String,
    pub email: String,
    pub office_location: String,
    pub office_hours: String,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassMeetingSeriesRecord {
    pub id: String,
    pub course_id: String,
    pub term_id: String,
    pub timezone: String,
    pub weekdays: Vec<i64>,
    pub starts_at_local: String,
    pub ends_at_local: String,
    pub component: String,
    pub location: String,
    pub modality: String,
    pub instructor_id: Option<String>,
    pub rotation_interval_weeks:i64,
    pub rotation_offset_weeks:i64,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcademicCalendarEventRecord {
    pub id: String,
    pub term_id: Option<String>,
    pub title: String,
    pub starts_on: String,
    pub ends_on: String,
    pub all_day: bool,
    pub no_class: bool,
    pub source: String,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitmentRecord {
    pub id: String,
    pub title: String,
    pub starts_at: String,
    pub ends_at: String,
    pub kind: String,
    pub location: String,
    pub travel_before_minutes: i64,
    pub travel_after_minutes: i64,
    pub protected: bool,
    pub version: i64,
    pub record_origin: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanningPreferenceRecord {
    pub sleep_start: String,
    pub sleep_end: String,
    pub max_session_minutes: i64,
    pub break_minutes: i64,
    pub transition_minutes: i64,
    pub default_commute_minutes: i64,
    pub version: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudentProfileInput {
    pub name: String,
    pub timezone: String,
    pub expected_version: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseInput {
    pub title: String,
    pub code: String,
    pub term_id: Option<String>,
    pub expected_version: Option<i64>,
    #[serde(default)]
    pub color: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInput {
    pub title: String,
    pub minutes: i64,
    pub due_at: Option<String>,
    pub course_id: Option<String>,
    pub priority: i64,
    pub academic_risk: i64,
    pub earliest_start: Option<String>,
    pub energy_demand: String,
    pub location: String,
    pub splittable: bool,
    pub min_session_minutes: i64,
    pub max_session_minutes: i64,
    #[serde(default)]
    pub dependencies: Vec<String>,
    pub expected_version: Option<i64>,
    #[serde(default = "default_task_kind")]
    pub kind: String,
}

fn default_task_kind() -> String {
    "assignment".into()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructorInput {
    pub course_id: String,
    pub name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub office_location: String,
    #[serde(default)]
    pub office_hours: String,
    pub expected_version: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassMeetingSeriesInput {
    pub course_id: String,
    pub term_id: String,
    pub timezone: String,
    pub weekdays: Vec<i64>,
    pub starts_at_local: String,
    pub ends_at_local: String,
    pub component: String,
    pub location: String,
    #[serde(default)]
    pub modality: String,
    pub instructor_id: Option<String>,
    #[serde(default="default_rotation_interval")]
    pub rotation_interval_weeks:i64,
    #[serde(default)]
    pub rotation_offset_weeks:i64,
    pub expected_version: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcademicCalendarEventInput {
    pub term_id: Option<String>,
    pub title: String,
    pub starts_on: String,
    pub ends_on: String,
    pub all_day: bool,
    pub no_class: bool,
    pub source: String,
    pub expected_version: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitmentEditorInput {
    pub title: String,
    pub starts_at: String,
    pub ends_at: String,
    pub kind: String,
    pub location: String,
    pub travel_before_minutes: i64,
    pub travel_after_minutes: i64,
    pub protected: bool,
    pub expected_version: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcademicTermInput {
    pub name: String,
    pub starts_on: String,
    pub ends_on: String,
    pub active: bool,
    pub expected_version: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferenceInput {
    pub sleep_start: String,
    pub sleep_end: String,
    pub max_session_minutes: i64,
    pub break_minutes: i64,
    pub transition_minutes: i64,
    pub default_commute_minutes: i64,
    pub expected_version: i64,
    pub availability: Vec<AvailabilityInput>,
}

pub fn migrate(conn: &Connection, previous_schema_version: i64) -> Result<()> {
    conn.execute_batch("SAVEPOINT profile_migration")?;
    let result = migrate_inner(conn, previous_schema_version);
    match result {
        Ok(()) => {
            conn.execute_batch("RELEASE profile_migration")?;
            Ok(())
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK TO profile_migration; RELEASE profile_migration");
            Err(error)
        }
    }
}

fn migrate_inner(conn: &Connection, previous_schema_version: i64) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS student_profiles(
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           timezone TEXT NOT NULL,
           onboarding_version INTEGER NOT NULL DEFAULT 0,
           version INTEGER NOT NULL DEFAULT 1,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS academic_terms(
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           starts_on TEXT NOT NULL,
           ends_on TEXT NOT NULL,
           active INTEGER NOT NULL DEFAULT 1,
           version INTEGER NOT NULL DEFAULT 1,
           created_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS planning_preferences(
           profile_id TEXT PRIMARY KEY,
           sleep_start TEXT NOT NULL,
           sleep_end TEXT NOT NULL,
           max_session_minutes INTEGER NOT NULL,
           break_minutes INTEGER NOT NULL,
           transition_minutes INTEGER NOT NULL,
           default_commute_minutes INTEGER NOT NULL,
           version INTEGER NOT NULL DEFAULT 1,
           FOREIGN KEY(profile_id) REFERENCES student_profiles(id) ON DELETE CASCADE
         );
         CREATE TABLE IF NOT EXISTS availability_rules(
           id TEXT PRIMARY KEY,
           profile_id TEXT NOT NULL,
           weekday INTEGER NOT NULL,
           starts_at_local TEXT NOT NULL,
           ends_at_local TEXT NOT NULL,
           version INTEGER NOT NULL DEFAULT 1,
           FOREIGN KEY(profile_id) REFERENCES student_profiles(id) ON DELETE CASCADE
         );
         CREATE TABLE IF NOT EXISTS task_dependencies(
           task_id TEXT NOT NULL,
           depends_on_task_id TEXT NOT NULL,
           created_at TEXT NOT NULL,
           PRIMARY KEY(task_id,depends_on_task_id),
           FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
           FOREIGN KEY(depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
           CHECK(task_id<>depends_on_task_id)
         );
         CREATE TABLE IF NOT EXISTS legacy_quarantine(
           id TEXT PRIMARY KEY,
           entity_type TEXT NOT NULL,
           entity_id TEXT NOT NULL,
           title TEXT NOT NULL,
           payload TEXT NOT NULL,
           quarantined_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS instructors(
           id TEXT PRIMARY KEY,
           course_id TEXT NOT NULL,
           name TEXT NOT NULL,
           email TEXT NOT NULL DEFAULT '',
           office_location TEXT NOT NULL DEFAULT '',
           office_hours TEXT NOT NULL DEFAULT '',
           version INTEGER NOT NULL DEFAULT 1,
           FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE
         );
         CREATE TABLE IF NOT EXISTS class_meeting_series(
           id TEXT PRIMARY KEY,
           course_id TEXT NOT NULL,
           term_id TEXT NOT NULL,
           timezone TEXT NOT NULL,
           weekdays TEXT NOT NULL,
           starts_at_local TEXT NOT NULL,
           ends_at_local TEXT NOT NULL,
           component TEXT NOT NULL DEFAULT 'lecture',
           location TEXT NOT NULL DEFAULT '',
           modality TEXT NOT NULL DEFAULT '',
           rotation_interval_weeks INTEGER NOT NULL DEFAULT 1,
           rotation_offset_weeks INTEGER NOT NULL DEFAULT 0,
           instructor_id TEXT,
           version INTEGER NOT NULL DEFAULT 1,
           FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE,
           FOREIGN KEY(term_id) REFERENCES academic_terms(id) ON DELETE CASCADE,
           FOREIGN KEY(instructor_id) REFERENCES instructors(id) ON DELETE SET NULL
         );
         CREATE TABLE IF NOT EXISTS academic_calendar_events(
           id TEXT PRIMARY KEY,
           term_id TEXT,
           title TEXT NOT NULL,
           starts_on TEXT NOT NULL,
           ends_on TEXT NOT NULL,
           all_day INTEGER NOT NULL DEFAULT 1,
           no_class INTEGER NOT NULL DEFAULT 0,
           source TEXT NOT NULL DEFAULT 'user',
           version INTEGER NOT NULL DEFAULT 1,
           FOREIGN KEY(term_id) REFERENCES academic_terms(id) ON DELETE SET NULL
         );",
    )?;
    rebuild_legacy_courses_table(conn)?;
    for (table, column, definition) in [
        ("courses", "term_id", "TEXT"),
        ("courses", "record_origin", "TEXT NOT NULL DEFAULT 'user'"),
        ("courses", "color", "TEXT NOT NULL DEFAULT '#3155B7'"),
        ("tasks", "course_id", "TEXT"),
        ("tasks", "academic_risk", "INTEGER NOT NULL DEFAULT 0"),
        ("tasks", "earliest_start", "TEXT"),
        ("tasks", "energy_demand", "TEXT NOT NULL DEFAULT 'medium'"),
        ("tasks", "location", "TEXT NOT NULL DEFAULT ''"),
        ("tasks", "splittable", "INTEGER NOT NULL DEFAULT 1"),
        (
            "tasks",
            "min_session_minutes",
            "INTEGER NOT NULL DEFAULT 20",
        ),
        (
            "tasks",
            "max_session_minutes",
            "INTEGER NOT NULL DEFAULT 60",
        ),
        ("tasks", "record_origin", "TEXT NOT NULL DEFAULT 'user'"),
        ("tasks", "task_kind", "TEXT NOT NULL DEFAULT 'assignment'"),
        ("commitments", "location", "TEXT NOT NULL DEFAULT ''"),
        (
            "commitments",
            "travel_before_minutes",
            "INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "commitments",
            "travel_after_minutes",
            "INTEGER NOT NULL DEFAULT 0",
        ),
        ("commitments", "protected", "INTEGER NOT NULL DEFAULT 1"),
        (
            "commitments",
            "record_origin",
            "TEXT NOT NULL DEFAULT 'user'",
        ),
        // A class meeting can come from an imported schedule now, so it carries
        // the same provenance columns tasks, commitments and courses already
        // have. Without them an import cannot recognise its own earlier rows and
        // re-importing would duplicate every class.
        (
            "class_meeting_series",
            "source_uid",
            "TEXT NOT NULL DEFAULT ''",
        ),
        ("class_meeting_series", "source_candidate_id", "TEXT"),
    ] {
        ensure_column(conn, table, column, definition)?;
    }
    conn.execute(
        "UPDATE tasks SET record_origin='import' WHERE source_uid<>'' AND record_origin='user'",
        [],
    )?;
    conn.execute(
        "UPDATE commitments SET record_origin='import' WHERE source_uid<>'' AND record_origin='user'",
        [],
    )?;
    conn.execute(
        "UPDATE courses SET record_origin='import' WHERE source_uid<>'' AND record_origin='user'",
        [],
    )?;
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS courses_source_uid_nonempty_idx
         ON courses(source_uid) WHERE source_uid<>''",
    )?;

    if previous_schema_version > 0 {
        let name = setting(conn, "student_name")?.unwrap_or_default();
        let timezone = setting(conn, "timezone")?.unwrap_or_else(detected_timezone);
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT OR IGNORE INTO student_profiles(id,name,timezone,onboarding_version,created_at,updated_at)
             VALUES(?1,?2,?3,0,?4,?4)",
            params![PROFILE_ID, name, timezone, now],
        )?;
    }
    quarantine_untouched_legacy_demo(conn)?;
    set_setting(conn, "demo_review_status", "retired")?;
    set_default(conn, "appearance", if previous_schema_version == 0 { "light" } else { "system" })?;
    Ok(())
}

fn rebuild_legacy_courses_table(conn: &Connection) -> Result<()> {
    let sql = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='courses'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .unwrap_or_default();
    if !sql
        .replace(' ', "")
        .to_ascii_lowercase()
        .contains("unique(source_uid)")
    {
        return Ok(());
    }
    conn.execute_batch(
        "CREATE TABLE courses_v7(
           id TEXT PRIMARY KEY,title TEXT NOT NULL,code TEXT NOT NULL DEFAULT '',
           source_uid TEXT NOT NULL DEFAULT '',source_candidate_id TEXT,
           version INTEGER NOT NULL DEFAULT 1,term_id TEXT,
           record_origin TEXT NOT NULL DEFAULT 'user'
         );
         INSERT INTO courses_v7(id,title,code,source_uid,source_candidate_id,version)
           SELECT id,title,code,source_uid,source_candidate_id,version FROM courses;
         DROP TABLE courses;
         ALTER TABLE courses_v7 RENAME TO courses;",
    )?;
    Ok(())
}

pub fn initialize_defaults(conn: &Connection) -> Result<()> {
    set_default(conn, "timezone", &detected_timezone())?;
    set_default(conn, "student_name", "")?;
    for (key, value) in [
        ("notifications_enabled", "false"),
        ("notification_lead_minutes", "10"),
        ("notification_quiet_start", "22:00"),
        ("notification_quiet_end", "07:00"),
        ("notification_show_titles", "false"),
    ] {
        set_default(conn, key, value)?;
    }
    Ok(())
}

pub fn onboarding_state(conn: &Connection) -> Result<OnboardingState> {
    let profile = conn
        .query_row(
            "SELECT name,timezone,onboarding_version FROM student_profiles WHERE id=?1",
            params![PROFILE_ID],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?;
    let onboarding_version = profile.as_ref().map(|value| value.2).unwrap_or(0);
    let legacy_quarantine_status = quarantine_status(conn)?;
    let draft = setting(conn, "onboarding_draft")?
        .and_then(|value| serde_json::from_str::<OnboardingDraft>(&value).ok())
        .unwrap_or_else(|| default_draft(profile));
    Ok(OnboardingState {
        required: onboarding_version < ONBOARDING_VERSION,
        onboarding_version,
        legacy_quarantine_status,
        draft,
    })
}

pub fn save_draft(conn: &Connection, draft: &OnboardingDraft) -> Result<OnboardingState> {
    validate_draft_limits(draft)?;
    let serialized = serde_json::to_string(draft)
        .map_err(|_| ProfileError::Invalid("onboarding draft could not be encoded".into()))?;
    set_setting(conn, "onboarding_draft", &serialized)?;
    onboarding_state(conn)
}

pub fn complete_onboarding(
    conn: &mut Connection,
    input: &OnboardingDraft,
) -> Result<OnboardingState> {
    validate_complete(input)?;
    let transaction = conn.transaction()?;
    let now = Utc::now().to_rfc3339();
    transaction.execute(
        "INSERT INTO student_profiles(id,name,timezone,onboarding_version,version,created_at,updated_at)
         VALUES(?1,?2,?3,?4,1,?5,?5)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name,timezone=excluded.timezone,
           onboarding_version=excluded.onboarding_version,version=student_profiles.version+1,updated_at=excluded.updated_at",
        params![PROFILE_ID, input.name.trim(), input.timezone, ONBOARDING_VERSION, now],
    )?;
    set_setting_tx(&transaction, "student_name", input.name.trim())?;
    set_setting_tx(&transaction, "timezone", &input.timezone)?;
    set_setting_tx(
        &transaction,
        "institution_selection",
        &serde_json::to_string(&input.institution)
            .map_err(|_| ProfileError::Invalid("institution could not be encoded".into()))?,
    )?;
    set_setting_tx(&transaction, "appearance", input.appearance.as_str())?;
    transaction.execute("UPDATE academic_terms SET active=0 WHERE active=1", [])?;
    let term_id = Uuid::new_v4().to_string();
    transaction.execute(
        "INSERT INTO academic_terms(id,name,starts_on,ends_on,active,created_at) VALUES(?1,?2,?3,?4,1,?5)",
        params![term_id, input.term_name.trim(), input.term_starts_on, input.term_ends_on, now],
    )?;
    // Registrar holidays and breaks. `planner_snapshot` already expands
    // `no_class` events into fixed constraints and the planner already treats
    // those as occupied, so this is the one missing link: without it a student
    // saw "2 no-class dates" on the term preset and still got study blocks on
    // Thanksgiving.
    for date in &input.term_no_class_dates {
        let starts_on = date.starts_on.trim();
        let label = date.label.trim();
        if starts_on.is_empty() || label.is_empty() {
            continue;
        }
        let ends_on = if date.ends_on.trim().is_empty() {
            starts_on
        } else {
            date.ends_on.trim()
        };
        if ends_on < starts_on {
            continue;
        }
        transaction.execute(
            "INSERT INTO academic_calendar_events(id,term_id,title,starts_on,ends_on,all_day,no_class,source)
             VALUES(?1,?2,?3,?4,?5,1,1,'registrar')",
            params![Uuid::new_v4().to_string(), term_id, label, starts_on, ends_on],
        )?;
    }
    // The legacy single-course fields are only a fallback for older drafts. When
    // both they and `courses` are empty the student skipped the step, so no
    // course rows are written at all — inserting one would create an untitled
    // placeholder course.
    let onboarding_courses = if !input.courses.is_empty() {
        input.courses.clone()
    } else if !input.course_title.trim().is_empty() {
        vec![OnboardingCourseInput {
            code: input.course_code.clone(),
            title: input.course_title.clone(),
            color: "#3155B7".into(),
            meetings: Vec::new(),
        }]
    } else {
        Vec::new()
    };
    for (index, course) in onboarding_courses.iter().enumerate() {
        let course_id = Uuid::new_v4().to_string();
        let color = if course.color.trim().is_empty() {
            ["#3155B7", "#0B746B", "#9A5B8E", "#B8653B", "#5E6F2C"][index % 5]
        } else {
            course.color.trim()
        };
        transaction.execute(
            "INSERT INTO courses(id,title,code,term_id,record_origin,color) VALUES(?1,?2,?3,?4,'user',?5)",
            params![course_id, course.title.trim(), course.code.trim(), term_id, color],
        )?;
        for meeting in &course.meetings {
            let instructor_id = if meeting.instructor_name.trim().is_empty() {
                None
            } else {
                let id = Uuid::new_v4().to_string();
                transaction.execute(
                    "INSERT INTO instructors(id,course_id,name) VALUES(?1,?2,?3)",
                    params![id, course_id, meeting.instructor_name.trim()],
                )?;
                Some(id)
            };
            transaction.execute(
                "INSERT INTO class_meeting_series(id,course_id,term_id,timezone,weekdays,starts_at_local,ends_at_local,component,location,instructor_id,rotation_interval_weeks,rotation_offset_weeks)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                params![Uuid::new_v4().to_string(), course_id, term_id, input.timezone, serde_json::to_string(&meeting.weekdays).unwrap_or_else(|_| "[]".into()), meeting.starts_at_local, meeting.ends_at_local, if meeting.component.trim().is_empty() { "lecture" } else { meeting.component.trim() }, meeting.location.trim(), instructor_id,meeting.rotation_interval_weeks,meeting.rotation_offset_weeks],
            )?;
        }
    }
    transaction.execute(
        "INSERT INTO planning_preferences(profile_id,sleep_start,sleep_end,max_session_minutes,break_minutes,transition_minutes,default_commute_minutes)
         VALUES(?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(profile_id) DO UPDATE SET sleep_start=excluded.sleep_start,sleep_end=excluded.sleep_end,
           max_session_minutes=excluded.max_session_minutes,break_minutes=excluded.break_minutes,
           transition_minutes=excluded.transition_minutes,default_commute_minutes=excluded.default_commute_minutes,
           version=planning_preferences.version+1",
        params![PROFILE_ID, input.sleep_start, input.sleep_end, input.max_session_minutes, input.break_minutes, input.transition_minutes, input.default_commute_minutes],
    )?;
    transaction.execute(
        "DELETE FROM availability_rules WHERE profile_id=?1",
        params![PROFILE_ID],
    )?;
    for rule in &input.availability {
        transaction.execute(
            "INSERT INTO availability_rules(id,profile_id,weekday,starts_at_local,ends_at_local) VALUES(?1,?2,?3,?4,?5)",
            params![Uuid::new_v4().to_string(), PROFILE_ID, rule.weekday, rule.starts_at_local, rule.ends_at_local],
        )?;
    }
    for commitment in &input.commitments {
        transaction.execute(
            "INSERT INTO commitments(id,title,starts_at,ends_at,kind,locked,location,travel_before_minutes,travel_after_minutes,protected,record_origin)
             VALUES(?1,?2,?3,?4,?5,1,?6,?7,?8,1,'user')",
            params![Uuid::new_v4().to_string(), commitment.title.trim(), commitment.starts_at, commitment.ends_at, commitment.kind, commitment.location.trim(), commitment.travel_before_minutes, commitment.travel_after_minutes],
        )?;
    }
    transaction.execute("DELETE FROM settings WHERE key='onboarding_draft'", [])?;
    transaction.commit()?;
    onboarding_state(conn)
}

pub fn workspace(conn: &Connection) -> Result<WorkspaceSnapshot> {
    let profile = conn
        .query_row(
            "SELECT name,timezone,version FROM student_profiles WHERE id=?1",
            params![PROFILE_ID],
            |row| {
                Ok(StudentProfileRecord {
                    name: row.get(0)?,
                    timezone: row.get(1)?,
                    version: row.get(2)?,
                })
            },
        )
        .optional()?;
    let institution = setting(conn, "institution_selection")?
        .and_then(|value| serde_json::from_str::<InstitutionSelection>(&value).ok())
        .filter(|value| !value.name.trim().is_empty());
    let appearance = setting(conn, "appearance")?
        .as_deref()
        .and_then(AppearancePreference::from_setting)
        .unwrap_or_default();
    let accent = setting(conn, "accent")?
        .filter(|value| ACCENTS.contains(&value.as_str()))
        .unwrap_or_else(|| "green".to_owned());
    let terms = query_records(conn, "SELECT id,name,starts_on,ends_on,active,version FROM academic_terms ORDER BY active DESC,starts_on DESC,name", |row| Ok(AcademicTermRecord { id: row.get(0)?, name: row.get(1)?, starts_on: row.get(2)?, ends_on: row.get(3)?, active: row.get::<_, i64>(4)? != 0, version: row.get(5)? }))?;
    let courses = query_records(
        conn,
        "SELECT id,title,code,term_id,version,record_origin,color FROM courses ORDER BY code,title,id",
        |row| {
            Ok(CourseRecord {
                id: row.get(0)?,
                title: row.get(1)?,
                code: row.get(2)?,
                term_id: row.get(3)?,
                version: row.get(4)?,
                record_origin: row.get(5)?,
                color: row.get(6)?,
            })
        },
    )?;
    let mut tasks = query_records(conn, "SELECT id,title,minutes,due_at,course_id,priority,academic_risk,earliest_start,energy_demand,location,splittable,min_session_minutes,max_session_minutes,completed,version,record_origin,task_kind FROM tasks ORDER BY completed,due_at IS NULL,due_at,title,id", |row| Ok(TaskRecord { id: row.get(0)?, title: row.get(1)?, minutes: row.get(2)?, due_at: row.get(3)?, course_id: row.get(4)?, priority: row.get(5)?, academic_risk: row.get(6)?, earliest_start: row.get(7)?, energy_demand: row.get(8)?, location: row.get(9)?, splittable: row.get::<_, i64>(10)? != 0, min_session_minutes: row.get(11)?, max_session_minutes: row.get(12)?, completed: row.get::<_, i64>(13)? != 0, version: row.get(14)?, dependencies: Vec::new(), record_origin: row.get(15)?, kind: row.get(16)? }))?;
    let mut dependency_query = conn.prepare("SELECT depends_on_task_id FROM task_dependencies WHERE task_id=?1 ORDER BY depends_on_task_id")?;
    for task in &mut tasks {
        task.dependencies = dependency_query
            .query_map(params![task.id], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
    }
    let commitments = query_records(conn, "SELECT id,title,starts_at,ends_at,kind,location,travel_before_minutes,travel_after_minutes,protected,version,record_origin FROM commitments ORDER BY starts_at,title,id", |row| Ok(CommitmentRecord { id: row.get(0)?, title: row.get(1)?, starts_at: row.get(2)?, ends_at: row.get(3)?, kind: row.get(4)?, location: row.get(5)?, travel_before_minutes: row.get(6)?, travel_after_minutes: row.get(7)?, protected: row.get::<_, i64>(8)? != 0, version: row.get(9)?, record_origin: row.get(10)? }))?;
    let instructors = query_records(conn, "SELECT id,course_id,name,email,office_location,office_hours,version FROM instructors ORDER BY name,id", |row| Ok(InstructorRecord { id: row.get(0)?, course_id: row.get(1)?, name: row.get(2)?, email: row.get(3)?, office_location: row.get(4)?, office_hours: row.get(5)?, version: row.get(6)? }))?;
    let class_meetings = query_records(conn, "SELECT id,course_id,term_id,timezone,weekdays,starts_at_local,ends_at_local,component,location,modality,instructor_id,rotation_interval_weeks,rotation_offset_weeks,version FROM class_meeting_series ORDER BY starts_at_local,id", |row| {
        let weekdays_json: String = row.get(4)?;
        Ok(ClassMeetingSeriesRecord { id: row.get(0)?, course_id: row.get(1)?, term_id: row.get(2)?, timezone: row.get(3)?, weekdays: serde_json::from_str(&weekdays_json).unwrap_or_default(), starts_at_local: row.get(5)?, ends_at_local: row.get(6)?, component: row.get(7)?, location: row.get(8)?, modality:row.get(9)?, instructor_id: row.get(10)?,rotation_interval_weeks:row.get(11)?,rotation_offset_weeks:row.get(12)?, version: row.get(13)? })
    })?;
    let academic_events = query_records(conn, "SELECT id,term_id,title,starts_on,ends_on,all_day,no_class,source,version FROM academic_calendar_events ORDER BY starts_on,title,id", |row| Ok(AcademicCalendarEventRecord { id: row.get(0)?, term_id: row.get(1)?, title: row.get(2)?, starts_on: row.get(3)?, ends_on: row.get(4)?, all_day: row.get::<_, i64>(5)? != 0, no_class: row.get::<_, i64>(6)? != 0, source: row.get(7)?, version: row.get(8)? }))?;
    let preferences = conn.query_row("SELECT sleep_start,sleep_end,max_session_minutes,break_minutes,transition_minutes,default_commute_minutes,version FROM planning_preferences WHERE profile_id=?1", params![PROFILE_ID], |row| Ok(PlanningPreferenceRecord { sleep_start: row.get(0)?, sleep_end: row.get(1)?, max_session_minutes: row.get(2)?, break_minutes: row.get(3)?, transition_minutes: row.get(4)?, default_commute_minutes: row.get(5)?, version: row.get(6)? })).optional()?;
    let availability = query_records(conn, "SELECT weekday,starts_at_local,ends_at_local FROM availability_rules WHERE profile_id='00000000-0000-4000-8000-000000000010' ORDER BY weekday,starts_at_local", |row| Ok(AvailabilityInput { weekday: row.get(0)?, starts_at_local: row.get(1)?, ends_at_local: row.get(2)? }))?;
    Ok(WorkspaceSnapshot {
        profile,
        institution,
        appearance,
        accent,
        terms,
        courses,
        tasks,
        commitments,
        instructors,
        class_meetings,
        academic_events,
        preferences,
        availability,
    })
}

pub fn update_student_profile(conn: &mut Connection, input: &StudentProfileInput) -> Result<()> {
    if input.name.trim().is_empty() || input.name.trim().chars().count() > 100 {
        return Err(ProfileError::Invalid("enter a student name".into()));
    }
    Tz::from_str(&input.timezone)
        .map_err(|_| ProfileError::Invalid("select a valid IANA timezone".into()))?;
    let tx = conn.transaction()?;
    let changed = tx.execute(
        "UPDATE student_profiles SET name=?2,timezone=?3,version=version+1,updated_at=?4
         WHERE id=?1 AND version=?5",
        params![
            PROFILE_ID,
            input.name.trim(),
            input.timezone,
            Utc::now().to_rfc3339(),
            input.expected_version
        ],
    )?;
    if changed == 0 {
        return Err(ProfileError::Invalid(
            "profile changed on another device; reload before saving".into(),
        ));
    }
    set_setting_tx(&tx, "student_name", input.name.trim())?;
    set_setting_tx(&tx, "timezone", &input.timezone)?;
    tx.commit()?;
    Ok(())
}

fn query_records<T, F>(conn: &Connection, sql: &str, map: F) -> Result<Vec<T>>
where
    F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
{
    let mut query = conn.prepare(sql)?;
    let records = query
        .query_map([], map)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(records)
}

pub fn create_term(conn: &mut Connection, input: &AcademicTermInput) -> Result<String> {
    validate_term(input)?;
    let tx = conn.transaction()?;
    if input.active {
        tx.execute(
            "UPDATE academic_terms SET active=0,version=version+1 WHERE active=1",
            [],
        )?;
    }
    let id = Uuid::new_v4().to_string();
    tx.execute("INSERT INTO academic_terms(id,name,starts_on,ends_on,active,created_at) VALUES(?1,?2,?3,?4,?5,?6)", params![id,input.name.trim(),input.starts_on,input.ends_on,input.active,Utc::now().to_rfc3339()])?;
    tx.commit()?;
    Ok(id)
}

pub fn update_term(conn: &mut Connection, id: &str, input: &AcademicTermInput) -> Result<()> {
    validate_term(input)?;
    let version = required_version(input.expected_version)?;
    let tx = conn.transaction()?;
    if input.active {
        tx.execute(
            "UPDATE academic_terms SET active=0,version=version+1 WHERE active=1 AND id<>?1",
            params![id],
        )?;
    }
    require_changed(tx.execute("UPDATE academic_terms SET name=?2,starts_on=?3,ends_on=?4,active=?5,version=version+1 WHERE id=?1 AND version=?6", params![id,input.name.trim(),input.starts_on,input.ends_on,input.active,version])?)?;
    tx.commit()?;
    Ok(())
}

pub fn delete_term(conn: &mut Connection, id: &str, expected_version: i64) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute(
        "UPDATE courses SET term_id=NULL,version=version+1 WHERE term_id=?1",
        params![id],
    )?;
    require_changed(tx.execute(
        "DELETE FROM academic_terms WHERE id=?1 AND version=?2",
        params![id, expected_version],
    )?)?;
    tx.commit()?;
    Ok(())
}

pub fn create_course(conn: &Connection, input: &CourseInput) -> Result<String> {
    validate_course(input)?;
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO courses(id,title,code,term_id,record_origin,color) VALUES(?1,?2,?3,?4,'user',?5)",
        params![id, input.title.trim(), input.code.trim(), input.term_id, normalized_color(&input.color)],
    )?;
    Ok(id)
}

pub fn update_course(conn: &Connection, id: &str, input: &CourseInput) -> Result<()> {
    validate_course(input)?;
    require_changed(conn.execute("UPDATE courses SET title=?2,code=?3,term_id=?4,color=?5,version=version+1 WHERE id=?1 AND version=?6",params![id,input.title.trim(),input.code.trim(),input.term_id,normalized_color(&input.color),required_version(input.expected_version)?])?)
}

pub fn delete_course(conn: &mut Connection, id: &str, expected_version: i64) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute(
        "UPDATE tasks SET course_id=NULL,version=version+1 WHERE course_id=?1",
        params![id],
    )?;
    require_changed(tx.execute(
        "DELETE FROM courses WHERE id=?1 AND version=?2",
        params![id, expected_version],
    )?)?;
    tx.commit()?;
    Ok(())
}

pub fn create_task(conn: &mut Connection, input: &TaskInput) -> Result<String> {
    validate_task(input)?;
    let id = Uuid::new_v4().to_string();
    let tx = conn.transaction()?;
    tx.execute("INSERT INTO tasks(id,title,minutes,due_at,course_id,priority,academic_risk,earliest_start,energy_demand,location,splittable,min_session_minutes,max_session_minutes,created_at,record_origin,task_kind) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'user',?15)",params![id,input.title.trim(),input.minutes,input.due_at,input.course_id,input.priority,input.academic_risk,input.earliest_start,input.energy_demand,input.location.trim(),input.splittable,input.min_session_minutes,input.max_session_minutes,Utc::now().to_rfc3339(),input.kind])?;
    replace_dependencies(&tx, &id, &input.dependencies)?;
    tx.commit()?;
    Ok(id)
}

pub fn update_task(conn: &mut Connection, id: &str, input: &TaskInput) -> Result<()> {
    validate_task(input)?;
    if input.dependencies.iter().any(|dependency| dependency == id) {
        return Err(ProfileError::Invalid(
            "a task cannot depend on itself".into(),
        ));
    }
    let tx = conn.transaction()?;
    require_changed(tx.execute("UPDATE tasks SET title=?2,minutes=?3,due_at=?4,course_id=?5,priority=?6,academic_risk=?7,earliest_start=?8,energy_demand=?9,location=?10,splittable=?11,min_session_minutes=?12,max_session_minutes=?13,task_kind=?14,version=version+1 WHERE id=?1 AND version=?15",params![id,input.title.trim(),input.minutes,input.due_at,input.course_id,input.priority,input.academic_risk,input.earliest_start,input.energy_demand,input.location.trim(),input.splittable,input.min_session_minutes,input.max_session_minutes,input.kind,required_version(input.expected_version)?])?)?;
    replace_dependencies(&tx, id, &input.dependencies)?;
    tx.commit()?;
    Ok(())
}

pub fn delete_task(conn: &mut Connection, id: &str, expected_version: i64) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM plan_blocks WHERE task_id=?1", params![id])?;
    tx.execute(
        "DELETE FROM task_dependencies WHERE task_id=?1 OR depends_on_task_id=?1",
        params![id],
    )?;
    require_changed(tx.execute(
        "DELETE FROM tasks WHERE id=?1 AND version=?2",
        params![id, expected_version],
    )?)?;
    tx.commit()?;
    Ok(())
}

pub fn create_commitment(conn: &Connection, input: &CommitmentEditorInput) -> Result<String> {
    validate_commitment_editor(input)?;
    let id = Uuid::new_v4().to_string();
    conn.execute("INSERT INTO commitments(id,title,starts_at,ends_at,kind,locked,location,travel_before_minutes,travel_after_minutes,protected,record_origin) VALUES(?1,?2,?3,?4,?5,1,?6,?7,?8,?9,'user')",params![id,input.title.trim(),input.starts_at,input.ends_at,input.kind,input.location.trim(),input.travel_before_minutes,input.travel_after_minutes,input.protected])?;
    Ok(id)
}

pub fn update_commitment(conn: &Connection, id: &str, input: &CommitmentEditorInput) -> Result<()> {
    validate_commitment_editor(input)?;
    require_changed(conn.execute("UPDATE commitments SET title=?2,starts_at=?3,ends_at=?4,kind=?5,location=?6,travel_before_minutes=?7,travel_after_minutes=?8,protected=?9,version=version+1 WHERE id=?1 AND version=?10",params![id,input.title.trim(),input.starts_at,input.ends_at,input.kind,input.location.trim(),input.travel_before_minutes,input.travel_after_minutes,input.protected,required_version(input.expected_version)?])?)
}

pub fn delete_commitment(conn: &mut Connection, id: &str, expected_version: i64) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM plan_blocks WHERE id=?1", params![id])?;
    require_changed(tx.execute(
        "DELETE FROM commitments WHERE id=?1 AND version=?2",
        params![id, expected_version],
    )?)?;
    tx.commit()?;
    Ok(())
}

pub fn create_instructor(conn: &Connection, input: &InstructorInput) -> Result<String> {
    validate_instructor(input)?;
    let id = Uuid::new_v4().to_string();
    conn.execute("INSERT INTO instructors(id,course_id,name,email,office_location,office_hours) VALUES(?1,?2,?3,?4,?5,?6)", params![id,input.course_id,input.name.trim(),input.email.trim(),input.office_location.trim(),input.office_hours.trim()])?;
    Ok(id)
}

pub fn update_instructor(conn: &Connection, id: &str, input: &InstructorInput) -> Result<()> {
    validate_instructor(input)?;
    require_changed(conn.execute("UPDATE instructors SET course_id=?2,name=?3,email=?4,office_location=?5,office_hours=?6,version=version+1 WHERE id=?1 AND version=?7", params![id,input.course_id,input.name.trim(),input.email.trim(),input.office_location.trim(),input.office_hours.trim(),required_version(input.expected_version)?])?)
}

pub fn delete_instructor(conn: &Connection, id: &str, expected_version: i64) -> Result<()> {
    require_changed(conn.execute(
        "DELETE FROM instructors WHERE id=?1 AND version=?2",
        params![id, expected_version],
    )?)
}

pub fn create_class_meeting(conn: &Connection, input: &ClassMeetingSeriesInput) -> Result<String> {
    validate_class_meeting(input)?;
    let id = Uuid::new_v4().to_string();
    conn.execute("INSERT INTO class_meeting_series(id,course_id,term_id,timezone,weekdays,starts_at_local,ends_at_local,component,location,modality,instructor_id,rotation_interval_weeks,rotation_offset_weeks) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)", params![id,input.course_id,input.term_id,input.timezone,serde_json::to_string(&input.weekdays).unwrap_or_else(|_| "[]".into()),input.starts_at_local,input.ends_at_local,input.component.trim(),input.location.trim(),input.modality.trim(),input.instructor_id,input.rotation_interval_weeks,input.rotation_offset_weeks])?;
    Ok(id)
}

pub fn update_class_meeting(
    conn: &Connection,
    id: &str,
    input: &ClassMeetingSeriesInput,
) -> Result<()> {
    validate_class_meeting(input)?;
    require_changed(conn.execute("UPDATE class_meeting_series SET course_id=?2,term_id=?3,timezone=?4,weekdays=?5,starts_at_local=?6,ends_at_local=?7,component=?8,location=?9,modality=?10,instructor_id=?11,rotation_interval_weeks=?12,rotation_offset_weeks=?13,version=version+1 WHERE id=?1 AND version=?14", params![id,input.course_id,input.term_id,input.timezone,serde_json::to_string(&input.weekdays).unwrap_or_else(|_| "[]".into()),input.starts_at_local,input.ends_at_local,input.component.trim(),input.location.trim(),input.modality.trim(),input.instructor_id,input.rotation_interval_weeks,input.rotation_offset_weeks,required_version(input.expected_version)?])?)
}

pub fn delete_class_meeting(conn: &Connection, id: &str, expected_version: i64) -> Result<()> {
    require_changed(conn.execute(
        "DELETE FROM class_meeting_series WHERE id=?1 AND version=?2",
        params![id, expected_version],
    )?)
}

pub fn create_academic_event(
    conn: &Connection,
    input: &AcademicCalendarEventInput,
) -> Result<String> {
    validate_academic_event(input)?;
    let id = Uuid::new_v4().to_string();
    conn.execute("INSERT INTO academic_calendar_events(id,term_id,title,starts_on,ends_on,all_day,no_class,source) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)", params![id,input.term_id,input.title.trim(),input.starts_on,input.ends_on,input.all_day,input.no_class,if input.source.trim().is_empty() { "user" } else { input.source.trim() }])?;
    Ok(id)
}

pub fn update_academic_event(
    conn: &Connection,
    id: &str,
    input: &AcademicCalendarEventInput,
) -> Result<()> {
    validate_academic_event(input)?;
    require_changed(conn.execute("UPDATE academic_calendar_events SET term_id=?2,title=?3,starts_on=?4,ends_on=?5,all_day=?6,no_class=?7,source=?8,version=version+1 WHERE id=?1 AND version=?9", params![id,input.term_id,input.title.trim(),input.starts_on,input.ends_on,input.all_day,input.no_class,if input.source.trim().is_empty() { "user" } else { input.source.trim() },required_version(input.expected_version)?])?)
}

pub fn delete_academic_event(conn: &Connection, id: &str, expected_version: i64) -> Result<()> {
    require_changed(conn.execute(
        "DELETE FROM academic_calendar_events WHERE id=?1 AND version=?2",
        params![id, expected_version],
    )?)
}

pub fn update_preferences(conn: &mut Connection, input: &PreferenceInput) -> Result<()> {
    validate_preference_values(input)?;
    let tx = conn.transaction()?;
    require_changed(tx.execute("UPDATE planning_preferences SET sleep_start=?2,sleep_end=?3,max_session_minutes=?4,break_minutes=?5,transition_minutes=?6,default_commute_minutes=?7,version=version+1 WHERE profile_id=?1 AND version=?8",params![PROFILE_ID,input.sleep_start,input.sleep_end,input.max_session_minutes,input.break_minutes,input.transition_minutes,input.default_commute_minutes,input.expected_version])?)?;
    tx.execute(
        "DELETE FROM availability_rules WHERE profile_id=?1",
        params![PROFILE_ID],
    )?;
    for rule in &input.availability {
        tx.execute("INSERT INTO availability_rules(id,profile_id,weekday,starts_at_local,ends_at_local) VALUES(?1,?2,?3,?4,?5)",params![Uuid::new_v4().to_string(),PROFILE_ID,rule.weekday,rule.starts_at_local,rule.ends_at_local])?;
    }
    tx.commit()?;
    Ok(())
}

pub const ACCENTS: [&str; 6] = ["green", "mint", "blue", "purple", "rose", "amber"];

pub fn set_appearance(conn: &Connection, appearance: &str) -> Result<()> {
    let preference = AppearancePreference::from_setting(appearance).ok_or_else(|| {
        ProfileError::Invalid("appearance preference is invalid".into())
    })?;
    // Normalized, so a legacy "dark" is stored under its current name.
    set_setting(conn, "appearance", preference.as_str())
}

pub fn set_accent(conn: &Connection, accent: &str) -> Result<()> {
    if !ACCENTS.contains(&accent) {
        return Err(ProfileError::Invalid("accent preference is invalid".into()));
    }
    set_setting(conn, "accent", accent)
}

fn validate_term(input: &AcademicTermInput) -> Result<()> {
    let starts = NaiveDate::parse_from_str(&input.starts_on, "%Y-%m-%d")
        .map_err(|_| ProfileError::Invalid("term start date is invalid".into()))?;
    let ends = NaiveDate::parse_from_str(&input.ends_on, "%Y-%m-%d")
        .map_err(|_| ProfileError::Invalid("term end date is invalid".into()))?;
    if input.name.trim().is_empty() || input.name.chars().count() > 100 || ends <= starts {
        return Err(ProfileError::Invalid("enter a valid academic term".into()));
    }
    Ok(())
}
fn validate_course(input: &CourseInput) -> Result<()> {
    if input.title.trim().is_empty()
        || input.title.chars().count() > 200
        || input.code.chars().count() > 40
    {
        return Err(ProfileError::Invalid("enter a valid course".into()));
    }
    Ok(())
}
fn normalized_color(value: &str) -> &str {
    if value.len() == 7
        && value.starts_with('#')
        && value[1..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        value
    } else {
        "#3155B7"
    }
}
fn validate_task(input: &TaskInput) -> Result<()> {
    if input.title.trim().is_empty()
        || input.title.chars().count() > 240
        || !(5..=1440).contains(&input.minutes)
        || !(1..=5).contains(&input.priority)
        || !(0..=5).contains(&input.academic_risk)
        || !matches!(input.energy_demand.as_str(), "low" | "medium" | "high")
        || !(5..=240).contains(&input.min_session_minutes)
        || !(5..=480).contains(&input.max_session_minutes)
        || input.min_session_minutes > input.max_session_minutes
        || input.dependencies.len() > 50
        || !matches!(input.kind.as_str(), "task" | "assignment" | "exam")
    {
        return Err(ProfileError::Invalid(
            "task fields are outside supported limits".into(),
        ));
    }
    for value in [&input.due_at, &input.earliest_start].into_iter().flatten() {
        chrono::DateTime::parse_from_rfc3339(value)
            .map_err(|_| ProfileError::Invalid("task date is invalid".into()))?;
    }
    Ok(())
}
fn validate_instructor(input: &InstructorInput) -> Result<()> {
    if input.course_id.trim().is_empty()
        || input.name.trim().is_empty()
        || input.name.chars().count() > 160
        || input.email.chars().count() > 254
        || input.office_location.chars().count() > 200
        || input.office_hours.chars().count() > 500
    {
        return Err(ProfileError::Invalid(
            "instructor fields are invalid".into(),
        ));
    }
    Ok(())
}
fn validate_class_meeting(input: &ClassMeetingSeriesInput) -> Result<()> {
    Tz::from_str(&input.timezone)
        .map_err(|_| ProfileError::Invalid("class timezone is invalid".into()))?;
    let starts = validate_clock(&input.starts_at_local)?;
    let ends = validate_clock(&input.ends_at_local)?;
    if input.course_id.is_empty()
        || input.term_id.is_empty()
        || input.weekdays.is_empty()
        || input.weekdays.len() > 7
        || input.weekdays.iter().any(|day| !(0..=6).contains(day))
        || !(1..=8).contains(&input.rotation_interval_weeks)
        || !(0..input.rotation_interval_weeks).contains(&input.rotation_offset_weeks)
        || ends <= starts
        || input.component.chars().count() > 40
        || input.location.chars().count() > 200
        || input.modality.chars().count() > 80
    {
        return Err(ProfileError::Invalid(
            "class meeting fields are invalid".into(),
        ));
    }
    Ok(())
}
fn validate_academic_event(input: &AcademicCalendarEventInput) -> Result<()> {
    let starts = NaiveDate::parse_from_str(&input.starts_on, "%Y-%m-%d")
        .map_err(|_| ProfileError::Invalid("academic event start date is invalid".into()))?;
    let ends = NaiveDate::parse_from_str(&input.ends_on, "%Y-%m-%d")
        .map_err(|_| ProfileError::Invalid("academic event end date is invalid".into()))?;
    if input.title.trim().is_empty() || input.title.chars().count() > 200 || ends < starts {
        return Err(ProfileError::Invalid(
            "academic event fields are invalid".into(),
        ));
    }
    Ok(())
}
fn validate_commitment_editor(input: &CommitmentEditorInput) -> Result<()> {
    if input.title.trim().is_empty()
        || input.title.chars().count() > 200
        || !matches!(input.kind.as_str(), "class" | "work" | "life" | "protected")
        || !(0..=240).contains(&input.travel_before_minutes)
        || !(0..=240).contains(&input.travel_after_minutes)
    {
        return Err(ProfileError::Invalid(
            "commitment fields are invalid".into(),
        ));
    }
    let starts = chrono::DateTime::parse_from_rfc3339(&input.starts_at)
        .map_err(|_| ProfileError::Invalid("commitment start is invalid".into()))?;
    let ends = chrono::DateTime::parse_from_rfc3339(&input.ends_at)
        .map_err(|_| ProfileError::Invalid("commitment end is invalid".into()))?;
    if ends <= starts {
        return Err(ProfileError::Invalid(
            "commitment must end after it starts".into(),
        ));
    }
    Ok(())
}
fn validate_preference_values(input: &PreferenceInput) -> Result<()> {
    validate_clock(&input.sleep_start)?;
    validate_clock(&input.sleep_end)?;
    if !(15..=240).contains(&input.max_session_minutes)
        || !(0..=60).contains(&input.break_minutes)
        || !(0..=120).contains(&input.transition_minutes)
        || !(0..=240).contains(&input.default_commute_minutes)
        || input.availability.is_empty()
        || input.availability.len() > MAX_AVAILABILITY_RULES
    {
        return Err(ProfileError::Invalid(
            "planning preferences are outside supported limits".into(),
        ));
    }
    for rule in &input.availability {
        let starts = validate_clock(&rule.starts_at_local)?;
        let ends = validate_clock(&rule.ends_at_local)?;
        if !(0..=6).contains(&rule.weekday) || ends <= starts {
            return Err(ProfileError::Invalid("availability rule is invalid".into()));
        }
    }
    Ok(())
}
fn required_version(version: Option<i64>) -> Result<i64> {
    version
        .filter(|value| *value > 0)
        .ok_or_else(|| ProfileError::Invalid("an expected record version is required".into()))
}
fn require_changed(changed: usize) -> Result<()> {
    if changed == 1 {
        Ok(())
    } else {
        Err(ProfileError::Invalid(
            "record changed on another device; refresh and try again".into(),
        ))
    }
}
fn replace_dependencies(
    tx: &Transaction<'_>,
    task_id: &str,
    dependencies: &[String],
) -> Result<()> {
    tx.execute(
        "DELETE FROM task_dependencies WHERE task_id=?1",
        params![task_id],
    )?;
    for dependency in dependencies {
        let exists = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1)",
            params![dependency],
            |row| row.get::<_, i64>(0),
        )? != 0;
        if !exists {
            return Err(ProfileError::Invalid(
                "a selected dependency no longer exists".into(),
            ));
        }
        tx.execute(
            "INSERT INTO task_dependencies(task_id,depends_on_task_id,created_at) VALUES(?1,?2,?3)",
            params![task_id, dependency, Utc::now().to_rfc3339()],
        )?;
    }
    Ok(())
}

fn quarantine_untouched_legacy_demo(conn: &Connection) -> Result<()> {
    if setting(conn, "legacy_quarantine_complete")?.as_deref() == Some("true") {
        return Ok(());
    }
    let now = Utc::now().to_rfc3339();
    let profile = conn
        .query_row(
            "SELECT name,timezone,onboarding_version FROM student_profiles WHERE id=?1",
            params![PROFILE_ID],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?;
    if let Some((name, timezone, onboarding_version)) = profile {
        if onboarding_version == 0
            && name == "Alex Morgan"
            && setting(conn, "student_name")?.as_deref() == Some("Alex Morgan")
        {
            let payload = serde_json::json!({ "name": name, "timezone": timezone }).to_string();
            conn.execute(
                "INSERT OR IGNORE INTO legacy_quarantine(id,entity_type,entity_id,title,payload,quarantined_at)
                 VALUES('legacy-profile-alex','profile',?1,'Alex Morgan',?2,?3)",
                params![PROFILE_ID, payload, now],
            )?;
            conn.execute(
                "UPDATE student_profiles SET name='',version=version+1,updated_at=?2 WHERE id=?1 AND onboarding_version=0 AND name='Alex Morgan'",
                params![PROFILE_ID, now],
            )?;
            conn.execute(
                "UPDATE settings SET value='' WHERE key='student_name' AND value='Alex Morgan'",
                [],
            )?;
        }
    }

    for (id, title, minutes) in [
        ("read-6", "Read Chapter 6: Social Influence", 35_i64),
        ("paper-intro", "Draft research paper introduction", 45_i64),
    ] {
        let task = conn
            .query_row(
                "SELECT id,title,minutes,priority,created_at FROM tasks
                 WHERE id=?1 AND title=?2 AND minutes=?3 AND due_at IS NULL AND completed=0
                   AND source_uid='' AND source_candidate_id IS NULL",
                params![id, title, minutes],
                |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "title": row.get::<_, String>(1)?,
                        "minutes": row.get::<_, i64>(2)?,
                        "priority": row.get::<_, i64>(3)?,
                        "createdAt": row.get::<_, String>(4)?,
                    }))
                },
            )
            .optional()?;
        if let Some(payload) = task {
            conn.execute(
                "INSERT OR IGNORE INTO legacy_quarantine(id,entity_type,entity_id,title,payload,quarantined_at)
                 VALUES(?1,'task',?2,?3,?4,?5)",
                params![format!("legacy-task-{id}"), id, title, payload.to_string(), now],
            )?;
            conn.execute("DELETE FROM plan_blocks WHERE task_id=?1", params![id])?;
            conn.execute(
                "DELETE FROM task_dependencies WHERE task_id=?1 OR depends_on_task_id=?1",
                params![id],
            )?;
            conn.execute("DELETE FROM tasks WHERE id=?1", params![id])?;
        }
    }

    for (id, title, kind) in [
        ("class-stat", "Statistics 201", "class"),
        ("work-library", "Campus library shift", "work"),
        ("work", "Campus library shift", "work"),
    ] {
        let commitment = conn
            .query_row(
                "SELECT id,title,starts_at,ends_at,kind FROM commitments
                 WHERE id=?1 AND title=?2 AND kind=?3 AND source_uid='' AND source_candidate_id IS NULL",
                params![id, title, kind],
                |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "title": row.get::<_, String>(1)?,
                        "startsAt": row.get::<_, String>(2)?,
                        "endsAt": row.get::<_, String>(3)?,
                        "kind": row.get::<_, String>(4)?,
                    }))
                },
            )
            .optional()?;
        if let Some(payload) = commitment {
            conn.execute(
                "INSERT OR IGNORE INTO legacy_quarantine(id,entity_type,entity_id,title,payload,quarantined_at)
                 VALUES(?1,'commitment',?2,?3,?4,?5)",
                params![format!("legacy-commitment-{id}"), id, title, payload.to_string(), now],
            )?;
            conn.execute("DELETE FROM plan_blocks WHERE id=?1", params![id])?;
            conn.execute("DELETE FROM commitments WHERE id=?1", params![id])?;
        }
    }
    set_setting(conn, "legacy_quarantine_complete", "true")?;
    Ok(())
}

pub fn quarantine_status(conn: &Connection) -> Result<LegacyQuarantineStatus> {
    let count = conn.query_row("SELECT COUNT(*) FROM legacy_quarantine", [], |row| {
        row.get(0)
    })?;
    Ok(LegacyQuarantineStatus {
        detected_count: count,
        quarantine_complete: setting(conn, "legacy_quarantine_complete")?.as_deref()
            == Some("true"),
        recovery_available: count > 0,
    })
}

pub fn list_quarantine(conn: &Connection) -> Result<Vec<LegacyQuarantineItem>> {
    query_records(
        conn,
        "SELECT id,entity_type,title,quarantined_at FROM legacy_quarantine ORDER BY quarantined_at,id",
        |row| Ok(LegacyQuarantineItem { id: row.get(0)?, entity_type: row.get(1)?, title: row.get(2)?, quarantined_at: row.get(3)? }),
    )
}

pub fn restore_quarantine(conn: &mut Connection, ids: &[String]) -> Result<()> {
    let tx = conn.transaction()?;
    for id in ids {
        let (entity_type, entity_id, payload): (String, String, String) = tx.query_row(
            "SELECT entity_type,entity_id,payload FROM legacy_quarantine WHERE id=?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let value: serde_json::Value = serde_json::from_str(&payload)
            .map_err(|_| ProfileError::Invalid("legacy recovery snapshot is invalid".into()))?;
        match entity_type.as_str() {
            "profile" => {
                let name = value["name"].as_str().unwrap_or_default();
                tx.execute("UPDATE student_profiles SET name=?2,version=version+1,updated_at=?3 WHERE id=?1 AND name=''", params![PROFILE_ID, name, Utc::now().to_rfc3339()])?;
                set_setting_tx(&tx, "student_name", name)?;
            }
            "task" => {
                tx.execute(
                    "INSERT OR IGNORE INTO tasks(id,title,minutes,priority,completed,created_at,record_origin,task_kind)
                     VALUES(?1,?2,?3,?4,0,?5,'recovered','assignment')",
                    params![entity_id, value["title"].as_str().unwrap_or("Recovered task"), value["minutes"].as_i64().unwrap_or(30), value["priority"].as_i64().unwrap_or(2), value["createdAt"].as_str().unwrap_or(&Utc::now().to_rfc3339())],
                )?;
            }
            "commitment" => {
                tx.execute(
                    "INSERT OR IGNORE INTO commitments(id,title,starts_at,ends_at,kind,locked,record_origin)
                     VALUES(?1,?2,?3,?4,?5,1,'recovered')",
                    params![entity_id, value["title"].as_str().unwrap_or("Recovered commitment"), value["startsAt"].as_str().unwrap_or_default(), value["endsAt"].as_str().unwrap_or_default(), value["kind"].as_str().unwrap_or("life")],
                )?;
            }
            _ => return Err(ProfileError::Invalid("unsupported recovery item".into())),
        }
        tx.execute("DELETE FROM legacy_quarantine WHERE id=?1", params![id])?;
    }
    tx.commit()?;
    Ok(())
}

pub fn purge_quarantine(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM legacy_quarantine", [])?;
    Ok(())
}

fn default_draft(profile: Option<(String, String, i64)>) -> OnboardingDraft {
    let (name, timezone, _) = profile.unwrap_or_else(|| (String::new(), detected_timezone(), 0));
    let year = Utc::now().date_naive().year();
    OnboardingDraft {
        name,
        timezone,
        term_name: "Current term".into(),
        term_starts_on: format!("{year}-08-01"),
        term_ends_on: format!("{}-05-31", year + 1),
        term_no_class_dates: Vec::new(),
        course_title: String::new(),
        course_code: String::new(),
        institution: InstitutionSelection::default(),
        courses: Vec::new(),
        appearance: AppearancePreference::Light,
        sleep_start: "23:00".into(),
        sleep_end: "07:00".into(),
        max_session_minutes: 60,
        break_minutes: 10,
        transition_minutes: 10,
        default_commute_minutes: 0,
        availability: (0..7)
            .map(|weekday| AvailabilityInput {
                weekday,
                starts_at_local: "08:00".into(),
                ends_at_local: "21:00".into(),
            })
            .collect(),
        commitments: Vec::new(),
    }
}

fn validate_draft_limits(input: &OnboardingDraft) -> Result<()> {
    if input.name.len() > 100
        || input.timezone.len() > 100
        || input.term_name.len() > 100
        || input.course_title.len() > 200
        || input.course_code.len() > 40
        || input.institution.name.len() > 200
        || input.courses.len() > 30
        || input.availability.len() > MAX_AVAILABILITY_RULES
        || input.commitments.len() > MAX_COMMITMENTS
    {
        return Err(ProfileError::Invalid(
            "onboarding input is too large".into(),
        ));
    }
    Ok(())
}

fn validate_complete(input: &OnboardingDraft) -> Result<()> {
    validate_draft_limits(input)?;
    if input.name.trim().is_empty() || input.name.trim().chars().count() > 100 {
        return Err(ProfileError::Invalid("enter a student name".into()));
    }
    Tz::from_str(&input.timezone)
        .map_err(|_| ProfileError::Invalid("select a valid IANA timezone".into()))?;
    let starts = NaiveDate::parse_from_str(&input.term_starts_on, "%Y-%m-%d")
        .map_err(|_| ProfileError::Invalid("enter a valid term start date".into()))?;
    let ends = NaiveDate::parse_from_str(&input.term_ends_on, "%Y-%m-%d")
        .map_err(|_| ProfileError::Invalid("enter a valid term end date".into()))?;
    if input.term_name.trim().is_empty() || ends <= starts {
        return Err(ProfileError::Invalid("enter a valid active term".into()));
    }
    // Courses are optional. A student who does not yet know their schedule can
    // finish setup and add courses later from the Courses screen.
    for course in &input.courses {
        if course.title.trim().is_empty()
            || course.title.chars().count() > 200
            || course.code.chars().count() > 40
            || course.meetings.len() > 12
        {
            return Err(ProfileError::Invalid(
                "an onboarding course is invalid".into(),
            ));
        }
        for meeting in &course.meetings {
            if meeting.weekdays.is_empty()
                || meeting.weekdays.len() > 7
                || meeting.weekdays.iter().any(|day| !(0..=6).contains(day))
                || !(1..=8).contains(&meeting.rotation_interval_weeks)
                || !(0..meeting.rotation_interval_weeks).contains(&meeting.rotation_offset_weeks)
            {
                return Err(ProfileError::Invalid(
                    "class meeting days are invalid".into(),
                ));
            }
            let starts = validate_clock(&meeting.starts_at_local)?;
            let ends = validate_clock(&meeting.ends_at_local)?;
            if ends <= starts {
                return Err(ProfileError::Invalid(
                    "class meeting must end after it starts".into(),
                ));
            }
        }
    }
    validate_clock(&input.sleep_start)?;
    validate_clock(&input.sleep_end)?;
    if !(15..=240).contains(&input.max_session_minutes)
        || !(0..=60).contains(&input.break_minutes)
        || !(0..=120).contains(&input.transition_minutes)
        || !(0..=240).contains(&input.default_commute_minutes)
    {
        return Err(ProfileError::Invalid(
            "planning preferences are outside supported limits".into(),
        ));
    }
    if input.availability.is_empty() {
        return Err(ProfileError::Invalid(
            "add at least one availability window".into(),
        ));
    }
    for rule in &input.availability {
        if !(0..=6).contains(&rule.weekday) {
            return Err(ProfileError::Invalid(
                "availability weekday is invalid".into(),
            ));
        }
        let start = validate_clock(&rule.starts_at_local)?;
        let end = validate_clock(&rule.ends_at_local)?;
        if end <= start {
            return Err(ProfileError::Invalid(
                "availability must end after it starts".into(),
            ));
        }
    }
    for commitment in &input.commitments {
        if commitment.title.trim().is_empty()
            || commitment.title.chars().count() > 200
            || !matches!(commitment.kind.as_str(), "class" | "work" | "life")
            || commitment.travel_before_minutes < 0
            || commitment.travel_before_minutes > 240
            || commitment.travel_after_minutes < 0
            || commitment.travel_after_minutes > 240
        {
            return Err(ProfileError::Invalid(
                "a fixed commitment is invalid".into(),
            ));
        }
        let start = chrono::DateTime::parse_from_rfc3339(&commitment.starts_at)
            .map_err(|_| ProfileError::Invalid("commitment start must be RFC 3339".into()))?;
        let end = chrono::DateTime::parse_from_rfc3339(&commitment.ends_at)
            .map_err(|_| ProfileError::Invalid("commitment end must be RFC 3339".into()))?;
        if end <= start {
            return Err(ProfileError::Invalid(
                "commitment must end after it starts".into(),
            ));
        }
    }
    Ok(())
}

fn validate_clock(value: &str) -> Result<i64> {
    let (hour, minute) = value
        .split_once(':')
        .ok_or_else(|| ProfileError::Invalid("time must use HH:MM".into()))?;
    let hour = hour
        .parse::<i64>()
        .map_err(|_| ProfileError::Invalid("time must use HH:MM".into()))?;
    let minute = minute
        .parse::<i64>()
        .map_err(|_| ProfileError::Invalid("time must use HH:MM".into()))?;
    if !(0..=23).contains(&hour) || !(0..=59).contains(&minute) {
        return Err(ProfileError::Invalid("time must use HH:MM".into()));
    }
    Ok(hour * 60 + minute)
}

fn detected_timezone() -> String {
    iana_time_zone::get_timezone().unwrap_or_else(|_| "Etc/UTC".into())
}

fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> Result<()> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let exists = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|item| item.ok())
        .any(|name| name == column);
    if !exists {
        conn.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition}"
        ))?;
    }
    Ok(())
}

fn setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            params![key],
            |row| row.get(0),
        )
        .optional()?)
}

fn set_default(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO settings(key,value) VALUES(?1,?2)",
        params![key, value],
    )?;
    Ok(())
}

fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn set_setting_tx(transaction: &Transaction<'_>, key: &str, value: &str) -> Result<()> {
    transaction.execute(
        "INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_schema(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
             CREATE TABLE courses(id TEXT PRIMARY KEY,title TEXT NOT NULL,code TEXT NOT NULL DEFAULT '',source_uid TEXT NOT NULL DEFAULT '',source_candidate_id TEXT,version INTEGER NOT NULL DEFAULT 1,UNIQUE(source_uid));
             CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,minutes INTEGER NOT NULL,due_at TEXT,priority INTEGER NOT NULL DEFAULT 2,completed INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,source_uid TEXT NOT NULL DEFAULT '',source_candidate_id TEXT);
             CREATE TABLE commitments(id TEXT PRIMARY KEY,title TEXT NOT NULL,starts_at TEXT NOT NULL,ends_at TEXT NOT NULL,kind TEXT NOT NULL,locked INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,source_uid TEXT NOT NULL DEFAULT '',source_candidate_id TEXT);
             CREATE TABLE plan_blocks(id TEXT PRIMARY KEY,task_id TEXT);",
        )
        .unwrap();
    }

    #[test]
    fn fresh_install_has_no_profile_or_demo_data() {
        let conn = Connection::open_in_memory().unwrap();
        base_schema(&conn);
        migrate(&conn, 0).unwrap();
        initialize_defaults(&conn).unwrap();
        let state = onboarding_state(&conn).unwrap();
        assert!(state.required);
        assert!(state.legacy_quarantine_status.quarantine_complete);
        assert_eq!(state.legacy_quarantine_status.detected_count, 0);
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM commitments", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn legacy_demo_cleanup_is_automatic_recoverable_and_preserves_real_records() {
        let mut conn = Connection::open_in_memory().unwrap();
        base_schema(&conn);
        conn.execute(
            "INSERT INTO settings VALUES('student_name','Alex Morgan')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO settings VALUES('timezone','America/Phoenix')",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO commitments(id,title,starts_at,ends_at,kind) VALUES('class-stat','Statistics 201','2026-08-14T09:00:00Z','2026-08-14T10:00:00Z','class')", []).unwrap();
        conn.execute("INSERT INTO commitments(id,title,starts_at,ends_at,kind) VALUES('real','My real job','2026-08-14T12:00:00Z','2026-08-14T13:00:00Z','work')", []).unwrap();
        conn.execute("INSERT INTO tasks(id,title,minutes,created_at) VALUES('read-6','Read Chapter 6: Social Influence',35,'2026-08-01T00:00:00Z')", []).unwrap();
        migrate(&conn, 6).unwrap();
        let before = onboarding_state(&conn).unwrap();
        assert!(before.legacy_quarantine_status.quarantine_complete);
        assert!(before.legacy_quarantine_status.detected_count >= 2);
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM commitments WHERE id='class-stat'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM commitments WHERE id='real'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM tasks WHERE id='read-6'", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            0
        );
        let item = list_quarantine(&conn)
            .unwrap()
            .into_iter()
            .find(|item| item.entity_type == "commitment")
            .unwrap();
        restore_quarantine(&mut conn, &[item.id]).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM commitments WHERE id='class-stat'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }

    #[test]
    fn migration_is_idempotent_and_repairs_manual_course_uniqueness() {
        let conn = Connection::open_in_memory().unwrap();
        base_schema(&conn);
        migrate(&conn, 0).unwrap();
        migrate(&conn, 7).unwrap();
        create_course(
            &conn,
            &CourseInput {
                title: "Biology".into(),
                code: "BIO 101".into(),
                term_id: None,
                expected_version: None,
                color: "#3155B7".into(),
            },
        )
        .unwrap();
        create_course(
            &conn,
            &CourseInput {
                title: "Composition".into(),
                code: "ENG 102".into(),
                term_id: None,
                expected_version: None,
                color: "#0B746B".into(),
            },
        )
        .unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM courses WHERE source_uid=''",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
    }

    #[test]
    fn partially_edited_demo_records_are_not_cleanup_candidates() {
        let conn = Connection::open_in_memory().unwrap();
        base_schema(&conn);
        conn.execute(
            "INSERT INTO settings VALUES('student_name','Alex Morgan')",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO commitments(id,title,starts_at,ends_at,kind) VALUES('class-stat','My statistics seminar','2026-08-14T09:00:00Z','2026-08-14T10:00:00Z','class')",[]).unwrap();
        conn.execute("INSERT INTO tasks(id,title,minutes,created_at) VALUES('edited','Read Chapter 6: Social Influence',40,'2026-08-01T00:00:00Z')",[]).unwrap();
        migrate(&conn, 6).unwrap();
        let items = list_quarantine(&conn).unwrap();
        assert!(items.iter().any(|item| item.entity_type == "profile"));
        assert!(!items.iter().any(|item| item.entity_type == "commitment"));
        assert!(!items.iter().any(|item| item.entity_type == "task"));
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM commitments WHERE id='class-stat'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }

    #[test]
    fn completed_onboarding_and_crud_survive_repeated_startup() {
        let mut conn = Connection::open_in_memory().unwrap();
        base_schema(&conn);
        migrate(&conn, 0).unwrap();
        initialize_defaults(&conn).unwrap();
        let mut draft = onboarding_state(&conn).unwrap().draft;
        draft.name = "Taylor".into();
        draft.timezone = "America/Phoenix".into();
        draft.term_name = "Fall 2026".into();
        draft.term_starts_on = "2026-08-01".into();
        draft.term_ends_on = "2026-12-20".into();
        draft.course_title = "Biology".into();
        draft.course_code = "BIO 101".into();
        complete_onboarding(&mut conn, &draft).unwrap();
        let input = TaskInput {
            title: "Lab report".into(),
            minutes: 90,
            due_at: Some("2026-09-01T23:59:00-07:00".into()),
            course_id: None,
            priority: 4,
            academic_risk: 2,
            earliest_start: None,
            energy_demand: "high".into(),
            location: "library".into(),
            splittable: true,
            min_session_minutes: 30,
            max_session_minutes: 60,
            dependencies: Vec::new(),
            expected_version: None,
            kind: "assignment".into(),
        };
        create_task(&mut conn, &input).unwrap();
        migrate(&conn, 7).unwrap();
        let state = onboarding_state(&conn).unwrap();
        let snapshot = workspace(&conn).unwrap();
        assert!(!state.required);
        assert_eq!(snapshot.profile.unwrap().name, "Taylor");
        assert_eq!(snapshot.tasks.len(), 1);
        assert_eq!(snapshot.courses.len(), 1);
    }

    #[test]
    fn onboarding_completes_without_any_courses() {
        let mut conn = Connection::open_in_memory().unwrap();
        base_schema(&conn);
        migrate(&conn, 0).unwrap();
        initialize_defaults(&conn).unwrap();
        let mut draft = onboarding_state(&conn).unwrap().draft;
        draft.name = "Sam".into();
        draft.timezone = "America/Phoenix".into();
        draft.term_name = "Fall 2026".into();
        draft.term_starts_on = "2026-08-01".into();
        draft.term_ends_on = "2026-12-20".into();
        // The student skipped the schedule step entirely.
        draft.courses = Vec::new();
        draft.course_title = String::new();
        draft.course_code = String::new();

        complete_onboarding(&mut conn, &draft).unwrap();

        let state = onboarding_state(&conn).unwrap();
        let snapshot = workspace(&conn).unwrap();
        assert!(!state.required, "skipping courses must still finish setup");
        assert_eq!(snapshot.profile.unwrap().name, "Sam");
        assert!(
            snapshot.courses.is_empty(),
            "an empty schedule must not create a placeholder course"
        );
        assert_eq!(snapshot.terms.len(), 1, "the term is still recorded");
        assert!(!snapshot.availability.is_empty());
    }

    #[test]
    fn failed_profile_migration_rolls_back_its_schema_changes() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE courses(id TEXT PRIMARY KEY,title TEXT NOT NULL,code TEXT NOT NULL DEFAULT '',source_uid TEXT NOT NULL DEFAULT '',source_candidate_id TEXT,version INTEGER NOT NULL DEFAULT 1,UNIQUE(source_uid));").unwrap();
        assert!(migrate(&conn, 0).is_err());
        let exists=conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='student_profiles')",[],|row|row.get::<_,i64>(0)).unwrap();
        assert_eq!(exists, 0);
    }
}
