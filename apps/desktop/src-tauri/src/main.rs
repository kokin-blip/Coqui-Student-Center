#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth;
mod ai_providers;
mod backup;
mod canvas;
mod canvas_calendar;
mod device_key;
mod imports;
mod managed_ai;
mod pdf_renderer;
mod pin;
mod planner;
mod profile;
mod school_calendar;
mod schedule_reader;
mod scholarships;
mod school_provider;
mod sync_crypto;
mod sync_transport;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use canvas::{CanvasCandidate, CanvasClient, CanvasPull};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, Offset, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use imports::{ExtractedCandidate, OcrRuntime, OcrStatus};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension};
use school_provider::SchoolProvider;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration as StdDuration, Instant},
};
use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_notification::{NotificationExt, PermissionState};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;
use uuid::Uuid;
use zeroize::Zeroizing;

const MAX_IMPORT_BYTES: u64 = 25 * 1024 * 1024;
const CURRENT_SCHEMA_VERSION: i64 = 25;
const TODAY_PLAN_ENTITY_ID: &str = "00000000-0000-4000-8000-000000000001";
const NOTIFICATION_PREFERENCES_ENTITY_ID: &str = "00000000-0000-4000-8000-000000000002";

#[cfg(any(test, feature = "wdio"))]
fn isolated_wdio_data_root(path: PathBuf) -> std::io::Result<PathBuf> {
    if !path.is_absolute() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "the E2E data directory must be absolute",
        ));
    }
    fs::create_dir_all(&path)?;
    let root = path.canonicalize()?;
    let temporary_root = std::env::temp_dir().canonicalize()?;
    if !root.starts_with(&temporary_root) || root == temporary_root {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "the E2E data directory must be a dedicated directory below the operating-system temporary directory",
        ));
    }
    Ok(root)
}

#[derive(thiserror::Error, Debug)]
enum AppError {
    #[error("storage error: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("file error: {0}")]
    Io(#[from] std::io::Error),
    #[error("credential store error: {0}")]
    Keyring(#[from] keyring::Error),
    #[error("device key error: {0}")]
    DeviceKey(#[from] device_key::DeviceKeyError),
    #[error("invalid input: {0}")]
    Invalid(String),
    #[error("encryption operation failed")]
    Crypto,
    #[error("document extraction failed: {0}")]
    Extract(String),
    #[error("Canvas sync failed: {0}")]
    Canvas(#[from] canvas::CanvasError),
    #[error("account operation failed: {0}")]
    Auth(#[from] auth::AuthError),
    #[error("sync protection failed: {0}")]
    SyncCrypto(#[from] sync_crypto::SyncCryptoError),
    #[error("encrypted sync failed: {0}")]
    SyncTransport(#[from] sync_transport::SyncTransportError),
    #[error("profile operation failed: {0}")]
    Profile(#[from] profile::ProfileError),
    #[error("AI provider request failed: {0}")]
    ManagedAi(#[from] managed_ai::ManagedAiError),
    #[error("background operation failed: {0}")]
    Background(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

type Result<T> = std::result::Result<T, AppError>;

#[derive(Clone)]
struct AppState {
    db: Arc<Mutex<Connection>>,
    master_key: [u8; 32],
    root: PathBuf,
    db_path: PathBuf,
    vault: PathBuf,
    ocr: OcrRuntime,
    locked: Arc<AtomicBool>,
    pin_attempts: Arc<Mutex<PinAttempts>>,
    pending_navigation: Arc<Mutex<Option<NavigationTarget>>>,
    account: Arc<Mutex<auth::AccountRuntime>>,
    sync_protection: Arc<Mutex<sync_crypto::SyncProtectionRuntime>>,
}

#[derive(Default)]
struct PinAttempts {
    failures: u32,
    retry_at: Option<Instant>,
}

impl PinAttempts {
    fn retry_after_seconds(&self) -> u64 {
        self.retry_at
            .and_then(|retry_at| retry_at.checked_duration_since(Instant::now()))
            .map(|duration| duration.as_secs().saturating_add(1))
            .unwrap_or(0)
    }

    fn record_failure(&mut self) -> u64 {
        self.failures = self.failures.saturating_add(1);
        let seconds = 1_u64 << self.failures.saturating_sub(1).min(5);
        self.retry_at = Some(Instant::now() + StdDuration::from_secs(seconds));
        seconds
    }

    fn reset(&mut self) {
        self.failures = 0;
        self.retry_at = None;
    }
}

impl AppState {
    fn require_unlocked(&self) -> Result<()> {
        if self.locked.load(Ordering::Acquire) {
            Err(AppError::Invalid("Student Center is locked".into()))
        } else {
            Ok(())
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SecurityStatus {
    pin_enabled: bool,
    locked: bool,
    retry_after_seconds: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppBootstrap {
    security: SecurityStatus,
    schema_version: i64,
    onboarding: Option<profile::OnboardingState>,
    dashboard: Option<Dashboard>,
}

#[derive(Debug, Clone, Deserialize)]
struct InstitutionDirectoryEntry {
    id: String,
    name: String,
    country: String,
    domain: String,
    catalog: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstitutionSearchResult {
    id: String,
    name: String,
    country: String,
    source: String,
    official_domain: String,
    catalog_provider_status: String,
    custom: bool,
    // Set when the query matched a campus rather than the institution name, so
    // searching "Tempe" can select Arizona State with that campus already
    // chosen instead of dropping the student on an unexplained result.
    matched_campus_id: String,
    matched_campus_name: String,
}

/// One scheduled meeting of a course, shaped to drop straight into
/// `profile::ClassMeetingInput` so picking a section fills a class time.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogSection {
    #[serde(default)]
    line_number: String,
    #[serde(default)]
    component: String,
    #[serde(default)]
    weekdays: Vec<i64>,
    #[serde(default)]
    starts_at_local: String,
    #[serde(default)]
    ends_at_local: String,
    #[serde(default)]
    campus_id: String,
    #[serde(default)]
    location: String,
    #[serde(default)]
    instructor: String,
    #[serde(default)]
    modality: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogCourse {
    code: String,
    title: String,
    #[serde(default)]
    credits: Option<f64>,
    #[serde(default)]
    sections: Vec<CatalogSection>,
}

/// A school's course list. Deliberately school-agnostic: a second institution is
/// another entry, not another code path.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstitutionCatalog {
    institution_id: String,
    #[serde(default)]
    term_id: String,
    #[serde(default)]
    source_label: String,
    #[serde(default)]
    source_url: String,
    #[serde(default)]
    courses: Vec<CatalogCourse>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CourseSuggestion {
    code: String,
    title: String,
    source: String,
    source_label: String,
    confidence: f64,
    #[serde(default)]
    credits: Option<f64>,
    /// Empty unless the suggestion came from a catalog that carries meeting
    /// times. The UI offers these so a pick can fill days, times and location.
    #[serde(default)]
    sections: Vec<CatalogSection>,
    /// Which term the sections describe, resolved to the registrar's own wording
    /// where possible. Bundled sections go stale the moment the term turns over,
    /// and a student cannot tell that from the meeting times alone.
    #[serde(default)]
    term_label: String,
    #[serde(default)]
    staleness_warning:String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TimezoneSuggestion {
    timezone: String,
    display_name: String,
    source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct InstitutionCampusOption {
    id: String,
    name: String,
    city: String,
    timezone: String,
    source_label: String,
    source_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AcademicTermPreset {
    id: String,
    name: String,
    starts_on: String,
    ends_on: String,
    class_ends_on: String,
    exam_starts_on: String,
    details: String,
    source_label: String,
    source_url: String,
    /// Two sessions of one term end on different days, so the registrar's own
    /// session letter is what tells them apart on screen.
    #[serde(default)]
    session_code: String,
    /// Holidays and breaks. Empty until a calendar harvest has run against the
    /// school's live page — the app does not invent them.
    #[serde(default)]
    no_class_dates: Vec<school_provider::NoClassDate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct InstitutionSetupOptions {
    institution_id: String,
    campuses: Vec<InstitutionCampusOption>,
    terms: Vec<AcademicTermPreset>,
    /// When the bundled snapshot was produced. Shown beside the dates it filled
    /// in, because "from the registrar" and "from the registrar, in August" are
    /// different claims and only one of them is checkable.
    #[serde(default)]
    generated_at: String,
    #[serde(default)]
    source_label: String,
    #[serde(default)]
    source_url: String,
}

fn current_security_status(state: &AppState) -> SecurityStatus {
    SecurityStatus {
        pin_enabled: pin::is_enabled(&state.root),
        locked: state.locked.load(Ordering::Acquire),
        retry_after_seconds: state.pin_attempts.lock().unwrap().retry_after_seconds(),
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct RestoreJournal {
    id: String,
    stage_id: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PlanBlock {
    id: String,
    task_id: Option<String>,
    starts_at: String,
    ends_at: String,
    title: String,
    kind: String,
    completed: bool,
    locked: bool,
    started_at: Option<String>,
    session_index: i64,
    location: String,
    reason_codes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotificationSettings {
    enabled: bool,
    permission_granted: bool,
    lead_minutes: i64,
    quiet_start: String,
    quiet_end: String,
    show_titles: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "view", rename_all = "kebab-case")]
enum NavigationTarget {
    MyDay,
    PlanBlock {
        #[serde(rename = "blockId")]
        block_id: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateStatus {
    configured: bool,
    current_version: String,
    available: bool,
    latest_version: Option<String>,
    notes: Option<String>,
    checked_at: Option<String>,
    message: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    id: String,
    document_id: String,
    kind: String,
    title: String,
    course: String,
    due_at: Option<String>,
    starts_at: Option<String>,
    ends_at: Option<String>,
    duration_minutes: Option<i64>,
    evidence: String,
    source_locator: String,
    source_type: String,
    source_url: Option<String>,
    confidence: f64,
    warnings: Vec<String>,
    status: String,
    /// Only meaningful for `class_meeting`, which review renders as a weekly
    /// pattern rather than as a single dated occurrence.
    weekdays: Vec<i64>,
    starts_at_local: String,
    ends_at_local: String,
    timezone: String,
    section_number: String,
    location: String,
    modality: String,
    term_id: String,
    suggested_action: String,
    student_edited_fields: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DocumentSummary {
    id: String,
    file_name: String,
    mime: String,
    imported_at: String,
    extraction_status: String,
    extraction_error: Option<String>,
    candidate_count: i64,
    pending_count: i64,
    approved_count: i64,
    /// False once a settled screenshot's image has been shredded. The row and
    /// its evidence survive, but anything that needs the picture itself — the
    /// AI re-read in particular — has nothing left to send.
    original_available: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScheduleSourcePreview {
    file_name: String,
    mime: String,
    data_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CandidateEditInput {
    title: String,
    course: String,
    due_at: Option<String>,
    starts_at: Option<String>,
    ends_at: Option<String>,
    duration_minutes: Option<i64>,
    weekdays: Vec<i64>,
    starts_at_local: String,
    ends_at_local: String,
    timezone: String,
    section_number: String,
    location: String,
    modality: String,
    term_id: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SourceConflictSummary {
    id: String,
    kind: String,
    description: String,
    candidate_id: Option<String>,
    entity_type: Option<String>,
    entity_id: Option<String>,
    current_due_at: Option<String>,
    proposed_due_at: Option<String>,
    current_starts_at: Option<String>,
    proposed_starts_at: Option<String>,
    current_ends_at: Option<String>,
    proposed_ends_at: Option<String>,
    detected_at: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CanvasConnectionSummary {
    id: String,
    provider: String,
    base_url: String,
    account_name: String,
    status: String,
    last_synced_at: Option<String>,
    last_error: Option<String>,
    refresh_on_startup: bool,
    next_eligible_refresh_at: Option<String>,
    pending_candidates: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CanvasSyncRunSummary {
    id: String,
    connection_id: String,
    started_at: String,
    completed_at: Option<String>,
    status: String,
    pulled_count: i64,
    created_count: i64,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NextActionAlternative {
    block_id: String,
    task_id: String,
    title: String,
    duration_minutes: i64,
    reason_codes: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NextAction {
    block_id: String,
    task_id: String,
    title: String,
    duration_minutes: i64,
    explanation: String,
    reason_codes: Vec<String>,
    alternatives: Vec<NextActionAlternative>,
    valid_from: String,
    valid_until: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Dashboard {
    student_name: String,
    timezone: String,
    offline: bool,
    plan_date: String,
    blocks: Vec<PlanBlock>,
    candidates: Vec<Candidate>,
    canvas_connections: Vec<CanvasConnectionSummary>,
    canvas_sync_runs: Vec<CanvasSyncRunSummary>,
    next_action: Option<NextAction>,
    notification_settings: NotificationSettings,
    conflicts: Vec<SourceConflictSummary>,
    ocr: OcrStatus,
    import_notice: Option<String>,
    unsettled_schedule_sources: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CalendarAgenda {
    timezone: String,
    starts_at: String,
    ends_at: String,
    blocks: Vec<PlanBlock>,
    overload_conflicts: Vec<SourceConflictSummary>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedAiInput {
    capability: managed_ai::AiCapability,
    excerpt: String,
    locale: String,
    consent: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedAiResult {
    dashboard: Dashboard,
    explanation: Option<String>,
    candidates_created: usize,
    model: String,
    provider: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AiProviderStatus {
    provider: String,
    connected: bool,
    healthy: bool,
    model: String,
    masked_key: Option<String>,
    capabilities: Vec<String>,
    last_checked_at: Option<String>,
    disclosure_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AiUsageSummary {
    provider: String,
    model: String,
    requests: i64,
    failures: i64,
    input_tokens: i64,
    output_tokens: i64,
    average_latency_ms: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroundedStudyInput {
    capability: managed_ai::AiCapability,
    course_ids: Vec<String>,
    document_ids: Vec<String>,
    prompt: String,
    title: String,
    consent: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GradeBand { label: String, minimum_percent: f64, grade_points: f64 }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StudyMaterialSummary { id:String,file_name:String,mime:String,course_ids:Vec<String>,segment_count:i64 }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StudyArtifactSummary { id:String,course_id:String,kind:String,title:String,content:String,citations:Vec<ai_providers::GroundedCitation>,provider:String,model:String,updated_at:String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StudyReviewSummary { id:String,artifact_id:String,confidence:i64,misses:i64,interval_days:i64,next_review_at:String,last_reviewed_at:Option<String> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GradeCategorySummary { id:String,course_id:String,name:String,weight:f64 }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GradeItemSummary { id:String,course_id:String,category_id:Option<String>,title:String,score:Option<f64>,points_possible:f64,due_at:Option<String>,status:String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CourseGradeSummary { course_id:String,current_percent:Option<f64>,missing_work_impact:f64,projected_letter:Option<String>,credit_hours:f64 }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CourseGradingScaleSummary { course_id:String,bands:Vec<GradeBand>,credit_hours:f64 }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GradeWhatIf { percent:Option<f64>,projected_letter:Option<String> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StudyWorkspace { materials:Vec<StudyMaterialSummary>,artifacts:Vec<StudyArtifactSummary>,reviews:Vec<StudyReviewSummary>,grade_categories:Vec<GradeCategorySummary>,grade_items:Vec<GradeItemSummary>,course_grades:Vec<CourseGradeSummary>,grading_scales:Vec<CourseGradingScaleSummary>,gpa_projection:Option<f64> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GroundedStudyResult { workspace:StudyWorkspace,artifact_id:String,provider:String,model:String }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GradeCategoryInput { id:Option<String>,course_id:String,name:String,weight:f64 }
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GradeItemInput { id:Option<String>,course_id:String,category_id:Option<String>,title:String,score:Option<f64>,points_possible:f64,due_at:Option<String>,status:String }

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncedDocumentMetadata {
    file_name: String,
    mime: String,
    content_nonce: String,
    sha256: String,
    imported_at: String,
    extraction_status: String,
    extraction_error: Option<String>,
}

fn random_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    key
}

fn open_keyed_database(path: &Path, key: &[u8; 32]) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(&format!(
        "PRAGMA key = \"x'{}'\"; PRAGMA cipher_memory_security = ON; PRAGMA foreign_keys = ON;",
        hex::encode(key)
    ))?;
    conn.query_row("SELECT COUNT(*) FROM sqlite_master", [], |row| {
        row.get::<_, i64>(0)
    })?;
    Ok(conn)
}

fn open_database(path: &Path, key: &[u8; 32]) -> Result<Connection> {
    let conn = open_keyed_database(path, key)?;
    let previous_schema_version =
        conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))?;
    conn.execute_batch(
    "BEGIN;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,minutes INTEGER NOT NULL,due_at TEXT,priority INTEGER NOT NULL DEFAULT 2,completed INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,source_uid TEXT NOT NULL DEFAULT '',source_candidate_id TEXT);
      CREATE TABLE IF NOT EXISTS commitments(id TEXT PRIMARY KEY,title TEXT NOT NULL,starts_at TEXT NOT NULL,ends_at TEXT NOT NULL,kind TEXT NOT NULL,locked INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,source_uid TEXT NOT NULL DEFAULT '',source_candidate_id TEXT);
      CREATE TABLE IF NOT EXISTS plan_blocks(id TEXT PRIMARY KEY,task_id TEXT,starts_at TEXT NOT NULL,ends_at TEXT NOT NULL,title TEXT NOT NULL,kind TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 0,locked INTEGER NOT NULL DEFAULT 0,started_at TEXT,reason_codes TEXT NOT NULL,FOREIGN KEY(task_id) REFERENCES tasks(id));
      CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,file_name TEXT NOT NULL,mime TEXT NOT NULL,vault_path TEXT NOT NULL,wrapped_key TEXT NOT NULL,key_nonce TEXT NOT NULL,content_nonce TEXT NOT NULL,sha256 TEXT NOT NULL,imported_at TEXT NOT NULL,extraction_status TEXT NOT NULL DEFAULT 'complete',extraction_error TEXT);
      CREATE TABLE IF NOT EXISTS integration_connections(id TEXT PRIMARY KEY,provider TEXT NOT NULL,base_url TEXT NOT NULL,account_name TEXT NOT NULL DEFAULT '',remote_user_id TEXT NOT NULL DEFAULT '',status TEXT NOT NULL,last_synced_at TEXT,last_error TEXT,sync_cursor TEXT,created_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,UNIQUE(provider,base_url));
      CREATE TABLE IF NOT EXISTS source_objects(id TEXT PRIMARY KEY,connection_id TEXT NOT NULL,source_type TEXT NOT NULL,source_uid TEXT NOT NULL,source_url TEXT NOT NULL,observed_at TEXT NOT NULL,payload_hash TEXT NOT NULL,payload TEXT NOT NULL,FOREIGN KEY(connection_id) REFERENCES integration_connections(id),UNIQUE(connection_id,source_uid,payload_hash));
      CREATE TABLE IF NOT EXISTS integration_sync_runs(id TEXT PRIMARY KEY,connection_id TEXT NOT NULL,started_at TEXT NOT NULL,completed_at TEXT,status TEXT NOT NULL,pulled_count INTEGER NOT NULL DEFAULT 0,created_count INTEGER NOT NULL DEFAULT 0,error TEXT,FOREIGN KEY(connection_id) REFERENCES integration_connections(id));
      CREATE TABLE IF NOT EXISTS courses(id TEXT PRIMARY KEY,title TEXT NOT NULL,code TEXT NOT NULL DEFAULT '',source_uid TEXT NOT NULL DEFAULT '',source_candidate_id TEXT,version INTEGER NOT NULL DEFAULT 1,UNIQUE(source_uid));
      CREATE TABLE IF NOT EXISTS import_candidates(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,source_object_id TEXT,kind TEXT NOT NULL DEFAULT 'task',title TEXT NOT NULL,course TEXT NOT NULL,due_at TEXT,starts_at TEXT,ends_at TEXT,duration_minutes INTEGER,evidence TEXT NOT NULL,source_locator TEXT NOT NULL,source_type TEXT NOT NULL DEFAULT 'document',source_url TEXT,source_uid TEXT NOT NULL DEFAULT '',observed_at TEXT,confidence REAL NOT NULL,warnings TEXT NOT NULL DEFAULT '[]',status TEXT NOT NULL DEFAULT 'pending',canonical_entity_id TEXT,weekdays TEXT NOT NULL DEFAULT '[]',starts_at_local TEXT NOT NULL DEFAULT '',ends_at_local TEXT NOT NULL DEFAULT '',timezone TEXT NOT NULL DEFAULT '',section_number TEXT NOT NULL DEFAULT '',location TEXT NOT NULL DEFAULT '',modality TEXT NOT NULL DEFAULT '',student_edited_fields TEXT NOT NULL DEFAULT '[]',last_observed_payload TEXT NOT NULL DEFAULT '{}',FOREIGN KEY(document_id) REFERENCES documents(id),FOREIGN KEY(source_object_id) REFERENCES source_objects(id));
      CREATE TABLE IF NOT EXISTS provenance_links(id TEXT PRIMARY KEY,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,candidate_id TEXT NOT NULL,source_object_id TEXT,field_name TEXT NOT NULL,source_value TEXT,evidence TEXT NOT NULL,created_at TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,source_kind TEXT NOT NULL DEFAULT '',sanitized_source_identifier TEXT NOT NULL DEFAULT '',external_stable_id TEXT NOT NULL DEFAULT '',confidence REAL NOT NULL DEFAULT 0,import_time TEXT,last_observed_source_value TEXT,student_edited INTEGER NOT NULL DEFAULT 0,FOREIGN KEY(candidate_id) REFERENCES import_candidates(id),FOREIGN KEY(source_object_id) REFERENCES source_objects(id),UNIQUE(entity_type,entity_id,candidate_id,field_name));
      CREATE TABLE IF NOT EXISTS mutations(id TEXT PRIMARY KEY,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,operation TEXT NOT NULL,hlc TEXT NOT NULL,device_id TEXT NOT NULL,tombstone INTEGER NOT NULL DEFAULT 0,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_state(account_id TEXT PRIMARY KEY,device_id TEXT NOT NULL,connected_at TEXT NOT NULL,last_pushed_at TEXT,last_push_cursor TEXT NOT NULL DEFAULT '0',last_pull_cursor TEXT NOT NULL DEFAULT '0');
      CREATE TABLE IF NOT EXISTS sync_outbox(account_id TEXT NOT NULL,mutation_id TEXT NOT NULL,envelope TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(account_id,mutation_id),FOREIGN KEY(mutation_id) REFERENCES mutations(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS sync_uploaded_mutations(account_id TEXT NOT NULL,mutation_id TEXT NOT NULL,uploaded_at TEXT NOT NULL,PRIMARY KEY(account_id,mutation_id),FOREIGN KEY(mutation_id) REFERENCES mutations(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS sync_received_mutations(account_id TEXT NOT NULL,mutation_id TEXT NOT NULL,envelope TEXT NOT NULL,operation TEXT NOT NULL,payload TEXT NOT NULL,received_at TEXT NOT NULL,applied INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(account_id,mutation_id));
      CREATE TABLE IF NOT EXISTS sync_entity_versions(entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,hlc TEXT NOT NULL,device_id TEXT NOT NULL,tombstone INTEGER NOT NULL DEFAULT 0,mutation_id TEXT NOT NULL,PRIMARY KEY(entity_type,entity_id));
      CREATE TABLE IF NOT EXISTS sync_set_elements(entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,field_name TEXT NOT NULL,element_id TEXT NOT NULL,hlc TEXT NOT NULL,device_id TEXT NOT NULL,tombstone INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(entity_type,entity_id,field_name,element_id));
      CREATE TABLE IF NOT EXISTS source_conflicts(id TEXT PRIMARY KEY,description TEXT NOT NULL,resolved INTEGER NOT NULL DEFAULT 0,kind TEXT NOT NULL DEFAULT 'overload',candidate_id TEXT,entity_type TEXT,entity_id TEXT,current_due_at TEXT,proposed_due_at TEXT,current_starts_at TEXT,proposed_starts_at TEXT,current_ends_at TEXT,proposed_ends_at TEXT,detected_at TEXT,resolved_at TEXT,resolution TEXT,FOREIGN KEY(candidate_id) REFERENCES import_candidates(id));
      CREATE TABLE IF NOT EXISTS reminder_deliveries(block_id TEXT PRIMARY KEY,plan_starts_at TEXT NOT NULL,delivered_at TEXT,snoozed_until TEXT,dismissed_at TEXT,FOREIGN KEY(block_id) REFERENCES plan_blocks(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS scholarship_opportunities(id TEXT PRIMARY KEY,payload TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scholarship_applications(id TEXT PRIMARY KEY,opportunity_id TEXT NOT NULL,payload TEXT NOT NULL,updated_at TEXT NOT NULL,FOREIGN KEY(opportunity_id) REFERENCES scholarship_opportunities(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS scholarship_drafts(id TEXT PRIMARY KEY,opportunity_id TEXT NOT NULL,payload TEXT NOT NULL,updated_at TEXT NOT NULL,FOREIGN KEY(opportunity_id) REFERENCES scholarship_opportunities(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS scholarship_draft_versions(id TEXT PRIMARY KEY,draft_id TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(draft_id) REFERENCES scholarship_drafts(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS scholarship_story_examples(id TEXT PRIMARY KEY,payload TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scholarship_crawler_runs(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,payload TEXT NOT NULL,started_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scholarship_sources(id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 1,weekly_refresh INTEGER NOT NULL DEFAULT 0,last_fetched_at TEXT,last_error TEXT,parser_version TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scholarship_opportunity_diffs(id TEXT PRIMARY KEY,opportunity_id TEXT NOT NULL,source_id TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,detected_at TEXT NOT NULL,resolved_at TEXT,FOREIGN KEY(opportunity_id) REFERENCES scholarship_opportunities(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS scholarship_profiles(id TEXT PRIMARY KEY,payload TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scholarship_writing_suggestions(id TEXT PRIMARY KEY,draft_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL,FOREIGN KEY(draft_id) REFERENCES scholarship_drafts(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS scholarship_requirement_documents(id TEXT PRIMARY KEY,opportunity_id TEXT NOT NULL,document_id TEXT NOT NULL,payload TEXT NOT NULL,imported_at TEXT NOT NULL,FOREIGN KEY(opportunity_id) REFERENCES scholarship_opportunities(id) ON DELETE CASCADE,FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE,UNIQUE(opportunity_id,document_id));
    COMMIT;",
  )?;
    ensure_column(
        &conn,
        "documents",
        "extraction_status",
        "TEXT NOT NULL DEFAULT 'complete'",
    )?;
    ensure_column(&conn, "documents", "extraction_error", "TEXT")?;
    ensure_column(&conn, "documents", "source_retention", "TEXT NOT NULL DEFAULT 'ask'")?;
    if previous_schema_version < 15 {
        // Existing vault items predate the per-import decision and must not
        // suddenly interrupt an upgraded student. New imports keep the column
        // default (`ask`) and always enter the explicit retention flow.
        conn.execute("UPDATE documents SET source_retention='keep_encrypted'", [])?;
    }
    ensure_column(&conn, "integration_connections", "refresh_on_startup", "INTEGER NOT NULL DEFAULT 1")?;
    ensure_column(&conn, "integration_connections", "last_attempted_at", "TEXT")?;
    ensure_column(&conn, "integration_connections", "credential_ref", "TEXT NOT NULL DEFAULT ''")?;
    // Set when the encrypted image has been deleted but the row is kept so its
    // evidence still resolves. Distinct from the empty `vault_path` that marks a
    // remote Canvas stub, which never had a blob to begin with.
    ensure_column(
        &conn,
        "documents",
        "content_shredded",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        &conn,
        "import_candidates",
        "kind",
        "TEXT NOT NULL DEFAULT 'task'",
    )?;
    ensure_column(&conn, "import_candidates", "term_id", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "import_candidates", "starts_at", "TEXT")?;
    ensure_column(&conn, "import_candidates", "ends_at", "TEXT")?;
    ensure_column(&conn, "import_candidates", "duration_minutes", "INTEGER")?;
    ensure_column(
        &conn,
        "import_candidates",
        "source_uid",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        &conn,
        "import_candidates",
        "warnings",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    ensure_column(&conn, "import_candidates", "source_object_id", "TEXT")?;
    ensure_column(
        &conn,
        "import_candidates",
        "source_type",
        "TEXT NOT NULL DEFAULT 'document'",
    )?;
    ensure_column(&conn, "import_candidates", "source_url", "TEXT")?;
    ensure_column(&conn, "import_candidates", "observed_at", "TEXT")?;
    // A class_meeting candidate is a weekly pattern rather than a single
    // instant, so it needs weekdays and a local clock that the datetime columns
    // above cannot express. Additive, like every other column here.
    ensure_column(
        &conn,
        "import_candidates",
        "weekdays",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    ensure_column(
        &conn,
        "import_candidates",
        "starts_at_local",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        &conn,
        "import_candidates",
        "ends_at_local",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        &conn,
        "import_candidates",
        "timezone",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(&conn, "import_candidates", "section_number", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "import_candidates", "location", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "import_candidates", "modality", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "import_candidates", "student_edited_fields", "TEXT NOT NULL DEFAULT '[]'")?;
    ensure_column(&conn, "import_candidates", "last_observed_payload", "TEXT NOT NULL DEFAULT '{}'")?;
    ensure_column(&conn, "provenance_links", "source_kind", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "provenance_links", "sanitized_source_identifier", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "provenance_links", "external_stable_id", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "provenance_links", "confidence", "REAL NOT NULL DEFAULT 0")?;
    ensure_column(&conn, "provenance_links", "import_time", "TEXT")?;
    ensure_column(&conn, "provenance_links", "last_observed_source_value", "TEXT")?;
    ensure_column(&conn, "provenance_links", "student_edited", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(&conn, "import_candidates", "canonical_entity_id", "TEXT")?;
    ensure_column(&conn, "tasks", "source_uid", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "tasks", "source_candidate_id", "TEXT")?;
    ensure_column(
        &conn,
        "commitments",
        "version",
        "INTEGER NOT NULL DEFAULT 1",
    )?;
    ensure_column(
        &conn,
        "commitments",
        "source_uid",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(&conn, "commitments", "source_candidate_id", "TEXT")?;
    ensure_column(&conn, "courses", "source_candidate_id", "TEXT")?;
    conn.execute_batch("SAVEPOINT planner_schema_migration")?;
    let planner_schema_result = (|| -> Result<()> {
        ensure_column(&conn, "plan_blocks", "started_at", "TEXT")?;
        ensure_column(
            &conn,
            "plan_blocks",
            "session_index",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(&conn, "plan_blocks", "location", "TEXT NOT NULL DEFAULT ''")?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS plan_blocks_window_idx
             ON plan_blocks(starts_at,ends_at,locked,completed);
             CREATE INDEX IF NOT EXISTS plan_blocks_task_idx
             ON plan_blocks(task_id,session_index);",
        )?;
        Ok(())
    })();
    match planner_schema_result {
        Ok(()) => conn.execute_batch("RELEASE planner_schema_migration")?,
        Err(error) => {
            let _ = conn.execute_batch(
                "ROLLBACK TO planner_schema_migration; RELEASE planner_schema_migration",
            );
            return Err(error);
        }
    }
    conn.execute_batch("SAVEPOINT managed_ai_schema_migration")?;
    let managed_ai_schema_result = (|| -> Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS ai_invocations(
               id TEXT PRIMARY KEY,
               capability TEXT NOT NULL,
               model TEXT,
               latency_ms INTEGER NOT NULL,
               input_tokens INTEGER NOT NULL DEFAULT 0,
               output_tokens INTEGER NOT NULL DEFAULT 0,
               outcome TEXT NOT NULL,
               prompt_version TEXT NOT NULL,
               created_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS ai_invocations_created_idx
             ON ai_invocations(created_at,id);",
        )?;
        ensure_column(&conn, "ai_invocations", "provider", "TEXT NOT NULL DEFAULT 'legacy_managed'")?;
        ensure_column(&conn, "ai_invocations", "error_category", "TEXT")?;
        Ok(())
    })();
    match managed_ai_schema_result {
        Ok(()) => conn.execute_batch("RELEASE managed_ai_schema_migration")?,
        Err(error) => {
            let _ = conn.execute_batch(
                "ROLLBACK TO managed_ai_schema_migration; RELEASE managed_ai_schema_migration",
            );
            return Err(error);
        }
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS document_segments(
           id TEXT PRIMARY KEY,document_id TEXT NOT NULL,locator TEXT NOT NULL,text TEXT NOT NULL,
           confidence REAL NOT NULL,position INTEGER NOT NULL,
           FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE,
           UNIQUE(document_id,position)
         );
         CREATE TABLE IF NOT EXISTS study_materials(
           document_id TEXT NOT NULL,course_id TEXT NOT NULL,added_at TEXT NOT NULL,
           PRIMARY KEY(document_id,course_id),
           FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE,
           FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE
         );
         CREATE TABLE IF NOT EXISTS study_artifacts(
           id TEXT PRIMARY KEY,course_id TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,
           content TEXT NOT NULL,citations TEXT NOT NULL DEFAULT '[]',provider TEXT NOT NULL,
           model TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,
           FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE
         );
         CREATE TABLE IF NOT EXISTS study_reviews(
           id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL,confidence INTEGER NOT NULL DEFAULT 0,
           misses INTEGER NOT NULL DEFAULT 0,interval_days INTEGER NOT NULL DEFAULT 1,
           next_review_at TEXT NOT NULL,last_reviewed_at TEXT,
           FOREIGN KEY(artifact_id) REFERENCES study_artifacts(id) ON DELETE CASCADE
         );
         CREATE TABLE IF NOT EXISTS grade_categories(
           id TEXT PRIMARY KEY,course_id TEXT NOT NULL,name TEXT NOT NULL,weight REAL NOT NULL,
           FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE,
           UNIQUE(course_id,name)
         );
         CREATE TABLE IF NOT EXISTS grade_items(
           id TEXT PRIMARY KEY,course_id TEXT NOT NULL,category_id TEXT,title TEXT NOT NULL,
           score REAL,points_possible REAL NOT NULL,due_at TEXT,status TEXT NOT NULL DEFAULT 'graded',
           FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE,
           FOREIGN KEY(category_id) REFERENCES grade_categories(id) ON DELETE SET NULL
         );
         CREATE TABLE IF NOT EXISTS course_grading_scales(
           course_id TEXT PRIMARY KEY,scale TEXT NOT NULL,credit_hours REAL NOT NULL DEFAULT 3,
           FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS document_segments_document_idx ON document_segments(document_id,position);
         CREATE INDEX IF NOT EXISTS study_artifacts_course_idx ON study_artifacts(course_id,updated_at);
         CREATE INDEX IF NOT EXISTS study_reviews_due_idx ON study_reviews(next_review_at);
         CREATE INDEX IF NOT EXISTS grade_items_course_idx ON grade_items(course_id,status);"
    )?;
    conn.execute_batch("SAVEPOINT canonical_sync_v2_migration")?;
    let canonical_sync_result = (|| -> Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS sync_entity_versions(
               entity_type TEXT NOT NULL,
               entity_id TEXT NOT NULL,
               hlc TEXT NOT NULL,
               device_id TEXT NOT NULL,
               tombstone INTEGER NOT NULL DEFAULT 0,
               mutation_id TEXT NOT NULL,
               PRIMARY KEY(entity_type,entity_id)
             );
             CREATE INDEX IF NOT EXISTS sync_versions_hlc_idx
             ON sync_entity_versions(hlc,device_id);
             CREATE TABLE IF NOT EXISTS sync_set_elements(
               entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,field_name TEXT NOT NULL,
               element_id TEXT NOT NULL,hlc TEXT NOT NULL,device_id TEXT NOT NULL,
               tombstone INTEGER NOT NULL DEFAULT 0,
               PRIMARY KEY(entity_type,entity_id,field_name,element_id)
             );",
        )?;
        Ok(())
    })();
    match canonical_sync_result {
        Ok(()) => conn.execute_batch("RELEASE canonical_sync_v2_migration")?,
        Err(error) => {
            let _ = conn.execute_batch(
                "ROLLBACK TO canonical_sync_v2_migration; RELEASE canonical_sync_v2_migration",
            );
            return Err(error);
        }
    }
    conn.execute_batch("SAVEPOINT signed_sync_v3_migration")?;
    let signed_sync_result = (|| -> Result<()> {
        // Pinned public keys of this account's other computers. Verifying a peer signature against
        // a key the server just handed us would prove nothing, so keys are trusted on first use and
        // never silently replaced -- see upsert_peer_device.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS sync_devices(
               account_id TEXT NOT NULL,
               device_id TEXT NOT NULL,
               public_key TEXT NOT NULL,
               signing_public_key TEXT NOT NULL,
               display_name TEXT NOT NULL DEFAULT '',
               platform TEXT NOT NULL DEFAULT '',
               authorized INTEGER NOT NULL DEFAULT 0,
               revoked INTEGER NOT NULL DEFAULT 0,
               first_seen_at TEXT NOT NULL,
               refreshed_at TEXT NOT NULL,
               PRIMARY KEY(account_id,device_id)
             );",
        )?;
        ensure_column(
            &conn,
            "sync_received_mutations",
            "outcome",
            "TEXT NOT NULL DEFAULT 'applied'",
        )?;
        ensure_column(
            &conn,
            "sync_received_mutations",
            "entity_type",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column(
            &conn,
            "sync_received_mutations",
            "logical_timestamp",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column(
            &conn,
            "sync_received_mutations",
            "device_id",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        conn.execute_batch(
            "UPDATE sync_received_mutations SET outcome='applied' WHERE applied<>0;
             CREATE INDEX IF NOT EXISTS sync_received_outcome_idx
             ON sync_received_mutations(account_id,outcome);",
        )?;
        // Envelopes for local-only types were uploaded by earlier builds and can never be applied
        // anywhere. Drop the queued ones, and clear the register entries they poisoned so a type
        // that later becomes replicated is not permanently stuck behind a phantom high water mark.
        let filter = replicated_entity_type_filter();
        let binds: Vec<&dyn rusqlite::ToSql> = REPLICATED_ENTITY_TYPES
            .iter()
            .map(|value| value as &dyn rusqlite::ToSql)
            .collect();
        conn.execute(
            &format!(
                "DELETE FROM sync_outbox WHERE mutation_id IN
                 (SELECT id FROM mutations WHERE entity_type NOT IN {filter})"
            ),
            binds.as_slice(),
        )?;
        conn.execute(
            &format!("DELETE FROM sync_entity_versions WHERE entity_type NOT IN {filter}"),
            binds.as_slice(),
        )?;
        Ok(())
    })();
    match signed_sync_result {
        Ok(()) => conn.execute_batch("RELEASE signed_sync_v3_migration")?,
        Err(error) => {
            let _ = conn.execute_batch(
                "ROLLBACK TO signed_sync_v3_migration; RELEASE signed_sync_v3_migration",
            );
            return Err(error);
        }
    }
    ensure_column(
        &conn,
        "sync_state",
        "last_pull_cursor",
        "TEXT NOT NULL DEFAULT '0'",
    )?;
    ensure_column(
        &conn,
        "source_conflicts",
        "kind",
        "TEXT NOT NULL DEFAULT 'overload'",
    )?;
    for (column, definition) in [
        ("candidate_id", "TEXT"),
        ("entity_type", "TEXT"),
        ("entity_id", "TEXT"),
        ("current_due_at", "TEXT"),
        ("proposed_due_at", "TEXT"),
        ("current_starts_at", "TEXT"),
        ("proposed_starts_at", "TEXT"),
        ("current_ends_at", "TEXT"),
        ("proposed_ends_at", "TEXT"),
        ("detected_at", "TEXT"),
        ("resolved_at", "TEXT"),
        ("resolution", "TEXT"),
    ] {
        ensure_column(&conn, "source_conflicts", column, definition)?;
    }
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS documents_sha256_idx ON documents(sha256);
     CREATE INDEX IF NOT EXISTS candidates_source_uid_idx ON import_candidates(source_uid);
     CREATE INDEX IF NOT EXISTS source_objects_uid_idx ON source_objects(connection_id,source_uid,observed_at);
     CREATE INDEX IF NOT EXISTS sync_runs_connection_idx ON integration_sync_runs(connection_id,started_at);
     CREATE INDEX IF NOT EXISTS tasks_source_uid_idx ON tasks(source_uid);
     CREATE INDEX IF NOT EXISTS commitments_source_uid_idx ON commitments(source_uid);
     CREATE INDEX IF NOT EXISTS conflicts_candidate_idx ON source_conflicts(candidate_id,resolved);
     CREATE INDEX IF NOT EXISTS provenance_entity_idx ON provenance_links(entity_type,entity_id,active);
     CREATE INDEX IF NOT EXISTS reminder_due_idx ON reminder_deliveries(plan_starts_at,delivered_at,snoozed_until);",
    )?;
    conn.execute(
        "UPDATE mutations SET entity_id=?1 WHERE entity_type='plan' AND entity_id='today'",
        params![TODAY_PLAN_ENTITY_ID],
    )?;
    conn.execute(
        "UPDATE mutations SET entity_id=?1 WHERE entity_type='notification_preferences' AND entity_id='local'",
        params![NOTIFICATION_PREFERENCES_ENTITY_ID],
    )?;
    backfill_legacy_canvas_links(&conn)?;
    profile::migrate(&conn, previous_schema_version)?;
    ensure_column(&conn, "class_meeting_series", "modality", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn,"class_meeting_series","rotation_interval_weeks","INTEGER NOT NULL DEFAULT 1")?;
    ensure_column(&conn,"class_meeting_series","rotation_offset_weeks","INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(&conn,"courses","created_at","TEXT NOT NULL DEFAULT ''")?;
    profile::initialize_defaults(&conn)?;
    conn.execute_batch(&format!("PRAGMA user_version = {CURRENT_SCHEMA_VERSION}"))?;
    Ok(conn)
}

fn scholarship_payloads(conn:&Connection,sql:&str)->Result<Vec<serde_json::Value>>{
    let mut query=conn.prepare(sql)?;
    let values=query.query_map([],|row|row.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
    Ok(values.into_iter().filter_map(|payload|serde_json::from_str(&payload).ok()).collect())
}

fn scholarship_profile_in(conn:&Connection)->Result<serde_json::Value>{
    Ok(conn.query_row("SELECT payload FROM scholarship_profiles WHERE id='local'",[],|row|row.get::<_,String>(0)).optional()?.and_then(|payload|serde_json::from_str(&payload).ok()).unwrap_or_else(||serde_json::json!({"studyLevel":"","fieldsOfStudy":[],"locations":[],"citizenship":[],"residency":[],"gpa":null})))
}

fn json_strings(value:&serde_json::Value,field:&str)->Vec<String>{value.get(field).and_then(|value|value.as_array()).into_iter().flatten().filter_map(|value|value.as_str()).map(|value|value.trim().to_ascii_lowercase()).filter(|value|!value.is_empty()).collect()}

fn scholarship_match(opportunity:&serde_json::Value,profile:&serde_json::Value)->serde_json::Value{
    let mut matched=Vec::new();let mut unknown=Vec::new();let mut ineligible=Vec::new();
    let scalar=profile.get("studyLevel").and_then(|value|value.as_str()).unwrap_or_default().trim().to_ascii_lowercase();let required=json_strings(opportunity,"studyLevels");
    if required.is_empty(){unknown.push("Provider did not publish study-level criteria".to_string());}else if scalar.is_empty(){unknown.push("Your study level is not set".to_string());}else if required.iter().any(|value|value==&scalar){matched.push(serde_json::json!({"attribute":"Study level","profileValue":scalar,"requirement":required.join(", ")}));}else{ineligible.push(format!("Study level requires {}",required.join(", ")));}
    for (field,profile_field,label) in [("fieldsOfStudy","fieldsOfStudy","Field of study"),("locations","locations","Location"),("citizenship","citizenship","Citizenship"),("residency","residency","Residency")]{let required=json_strings(opportunity,field);let supplied=json_strings(profile,profile_field);if required.is_empty(){unknown.push(format!("Provider did not publish {} criteria",label.to_ascii_lowercase()));}else if supplied.is_empty(){unknown.push(format!("Your {} is not set",label.to_ascii_lowercase()));}else if let Some(value)=supplied.iter().find(|value|required.contains(value)){matched.push(serde_json::json!({"attribute":label,"profileValue":value,"requirement":required.join(", ")}));}else{ineligible.push(format!("{label} requires {}",required.join(", ")));}}
    let minimum=opportunity.get("minimumGpa").and_then(|value|value.as_f64());let gpa=profile.get("gpa").and_then(|value|value.as_f64());match(minimum,gpa){(None,_)=>unknown.push("Provider did not publish a GPA criterion".into()),(Some(_),None)=>unknown.push("Your GPA is not set".into()),(Some(required),Some(value))if value>=required=>matched.push(serde_json::json!({"attribute":"GPA","profileValue":format!("{value:.2}"),"requirement":format!("At least {required:.2}")})),(Some(required),Some(_))=>ineligible.push(format!("GPA requires at least {required:.2}")),};
    let total=matched.len()+unknown.len()+ineligible.len();let score=if total==0{0.0}else{matched.len() as f64/total as f64};
    serde_json::json!({"opportunityId":opportunity.get("id").and_then(|value|value.as_str()).unwrap_or_default(),"matched":matched,"unknown":unknown,"ineligible":ineligible,"score":score})
}

fn scholarship_workspace_in(conn:&Connection)->Result<serde_json::Value>{
    let mut sources=Vec::new();
    for source in scholarships::SOURCES{
        conn.execute("INSERT OR IGNORE INTO scholarship_sources(id,parser_version) VALUES(?1,?2)",params![source.id,source.parser_version])?;
        let (enabled,weekly,last_fetched,last_error):(i64,i64,Option<String>,Option<String>)=conn.query_row("SELECT enabled,weekly_refresh,last_fetched_at,last_error FROM scholarship_sources WHERE id=?1",params![source.id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)))?;
        sources.push(serde_json::json!({"id":source.id,"name":source.name,"kind":source.id,"origin":format!("{}{}",source.origin,source.path),"enabled":enabled!=0,"weeklyRefresh":weekly!=0,"requiresCredential":false,"lastFetchedAt":last_fetched,"status":if last_error.is_some(){"error"}else{"ready"},"lastError":last_error,"attribution":source.attribution,"parserVersion":source.parser_version}));
    }
    sources.push(serde_json::json!({"id":"asu-scholarship-universe","name":"ASU Scholarship Universe","kind":"scholarship-universe","origin":"https://asu.scholarshipuniverse.com/","enabled":false,"weeklyRefresh":false,"requiresCredential":true,"status":"disabled","lastError":"Requires an admitted or current student's ASURITE sign-in. Coqui never crawls or reuses that authenticated session.","attribution":"Arizona State University","parserVersion":"manual-launch-1"}));
    sources.push(serde_json::json!({"id":"careeronestop","name":"CareerOneStop Scholarship Finder API","kind":"careeronestop","origin":"https://api.careeronestop.org/api-explorer/","enabled":false,"weeklyRefresh":false,"requiresCredential":true,"status":"disabled","lastError":"Optional adapter is disabled until a CareerOneStop user ID and API bearer token are configured.","attribution":"CareerOneStop, U.S. Department of Labor","parserVersion":"credential-required-1"}));
    sources.push(serde_json::json!({"id":"manual","name":"Manual links and files","kind":"manual","origin":"https://coqui.local/scholarships/manual","enabled":true,"weeklyRefresh":false,"requiresCredential":false,"status":"ready","attribution":"Added by the student","parserVersion":"manual-1"}));
    let opportunities=scholarship_payloads(conn,"SELECT payload FROM scholarship_opportunities ORDER BY updated_at DESC")?;let profile=scholarship_profile_in(conn)?;let matches=opportunities.iter().map(|opportunity|scholarship_match(opportunity,&profile)).collect::<Vec<_>>();
    Ok(serde_json::json!({
        "sources":sources,
        "opportunities":opportunities,
        "documents":scholarship_payloads(conn,"SELECT payload FROM scholarship_requirement_documents ORDER BY imported_at DESC")?,
        "applications":scholarship_payloads(conn,"SELECT payload FROM scholarship_applications ORDER BY updated_at DESC")?,
        "drafts":scholarship_payloads(conn,"SELECT payload FROM scholarship_drafts ORDER BY updated_at DESC")?,
        "stories":scholarship_payloads(conn,"SELECT payload FROM scholarship_story_examples ORDER BY updated_at DESC")?,
        "runs":scholarship_payloads(conn,"SELECT payload FROM scholarship_crawler_runs ORDER BY started_at DESC LIMIT 30")?,
        "diffs":scholarship_payloads(conn,"SELECT payload FROM scholarship_opportunity_diffs WHERE resolved_at IS NULL ORDER BY detected_at DESC")?,
        "profile":profile,
        "matches":matches
        ,"suggestions":scholarship_payloads(conn,"SELECT payload FROM scholarship_writing_suggestions WHERE status='pending' ORDER BY created_at DESC")?
    }))
}

#[tauri::command]
fn get_scholarship_workspace(state:tauri::State<AppState>)->Result<serde_json::Value>{state.require_unlocked()?;scholarship_workspace_in(&state.db.lock().unwrap())}

fn preserve_scholarship_student_fields(next:&mut serde_json::Value,previous:&serde_json::Value){
    for field in ["state","notes","priority","taskIds"]{if let Some(value)=previous.get(field){next[field]=value.clone();}}
}

fn persist_scholarship_refresh(conn:&Connection,refresh:scholarships::SourceRefresh,run_id:&str)->Result<serde_json::Value>{
    let tx=conn.unchecked_transaction()?; let mut discovered=0usize; let mut changed=0usize; let mut seen=std::collections::HashSet::new();
    for opportunity in refresh.opportunities{
        let mut next=serde_json::to_value(&opportunity).map_err(|_|AppError::Invalid("Scholarship result could not be stored".into()))?;
        let id=opportunity.id.clone(); seen.insert(id.clone());
        let previous=tx.query_row("SELECT payload FROM scholarship_opportunities WHERE id=?1",params![id],|row|row.get::<_,String>(0)).optional()?.and_then(|payload|serde_json::from_str::<serde_json::Value>(&payload).ok());
        if let Some(previous)=previous{
            preserve_scholarship_student_fields(&mut next,&previous);
            let critical=["title","awardMinimum","awardMaximum","deadline","deadlineLabel","applicationUrl","summary"];
            if critical.iter().any(|field|previous.get(*field)!=next.get(*field)){
                next["verificationStatus"]=serde_json::Value::String("changed".into()); changed+=1;
                let diff_id=Uuid::new_v4().to_string(); let payload=serde_json::json!({"id":diff_id,"opportunityId":id,"sourceId":refresh.source.id,"kind":"source_changed","detectedAt":refresh.fetched_at,"before":previous,"after":next});
                tx.execute("INSERT INTO scholarship_opportunity_diffs(id,opportunity_id,source_id,kind,payload,detected_at) VALUES(?1,?2,?3,'source_changed',?4,?5)",params![diff_id,id,refresh.source.id,payload.to_string(),refresh.fetched_at])?;
            }
        }else{discovered+=1;}
        tx.execute("INSERT INTO scholarship_opportunities(id,payload,updated_at) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at",params![id,next.to_string(),refresh.fetched_at])?;
    }
    let existing=scholarship_payloads(&tx,&format!("SELECT payload FROM scholarship_opportunities WHERE json_extract(payload,'$.sourceId')='{}'",refresh.source.id.replace('\'',"''")))?;
    for mut previous in existing{
        let Some(id)=previous.get("id").and_then(|value|value.as_str()).map(str::to_owned) else{continue}; if seen.contains(&id){continue;}
        if previous.get("freshness").and_then(|value|value.as_str())==Some("stale"){continue;}
        previous["freshness"]=serde_json::Value::String("stale".into()); previous["verificationStatus"]=serde_json::Value::String("changed".into()); changed+=1;
        let diff_id=Uuid::new_v4().to_string();let payload=serde_json::json!({"id":diff_id,"opportunityId":id,"sourceId":refresh.source.id,"kind":"missing_from_source","detectedAt":refresh.fetched_at});
        tx.execute("UPDATE scholarship_opportunities SET payload=?2,updated_at=?3 WHERE id=?1",params![id,previous.to_string(),refresh.fetched_at])?;
        tx.execute("INSERT INTO scholarship_opportunity_diffs(id,opportunity_id,source_id,kind,payload,detected_at) VALUES(?1,?2,?3,'missing_from_source',?4,?5)",params![diff_id,id,refresh.source.id,payload.to_string(),refresh.fetched_at])?;
    }
    let run=serde_json::json!({"id":run_id,"sourceId":refresh.source.id,"startedAt":refresh.fetched_at,"completedAt":refresh.fetched_at,"status":"complete","discovered":discovered,"changed":changed,"skipped":0,"reasonCategories":[]});
    tx.execute("UPDATE scholarship_crawler_runs SET payload=?2 WHERE id=?1",params![run_id,run.to_string()])?;
    tx.execute("UPDATE scholarship_sources SET last_fetched_at=?2,last_error=NULL,parser_version=?3 WHERE id=?1",params![refresh.source.id,refresh.fetched_at,refresh.source.parser_version])?;
    tx.commit()?; scholarship_workspace_in(conn)
}

fn refresh_scholarship_source_blocking(state:&AppState,source_id:String)->Result<serde_json::Value>{
    state.require_unlocked()?; let source=scholarships::descriptor(&source_id).map_err(|error|AppError::Invalid(error.to_string()))?; let run_id=Uuid::new_v4().to_string(); let started_at=Utc::now();
    {let db=state.db.lock().unwrap();let latest=db.query_row("SELECT started_at FROM scholarship_crawler_runs WHERE source_id=?1 ORDER BY started_at DESC LIMIT 1",params![source_id],|row|row.get::<_,String>(0)).optional()?;if latest.and_then(|value|DateTime::parse_from_rfc3339(&value).ok()).is_some_and(|last|started_at.signed_duration_since(last.with_timezone(&Utc))<Duration::minutes(1)){return Err(AppError::Invalid("Wait one minute before refreshing this source again".into()));}let running=serde_json::json!({"id":run_id,"sourceId":source_id,"startedAt":started_at.to_rfc3339(),"status":"running","discovered":0,"changed":0,"skipped":0,"reasonCategories":[]});db.execute("INSERT INTO scholarship_crawler_runs(id,source_id,payload,started_at) VALUES(?1,?2,?3,?4)",params![run_id,source_id,running.to_string(),started_at.to_rfc3339()])?;}
    match scholarships::refresh(&source_id){Ok(refresh)=>{let db=state.db.lock().unwrap();persist_scholarship_refresh(&db,refresh,&run_id)}Err(error)=>{let safe=error.to_string();let completed=Utc::now().to_rfc3339();let failed=serde_json::json!({"id":run_id,"sourceId":source.id,"startedAt":started_at.to_rfc3339(),"completedAt":completed,"status":"failed","discovered":0,"changed":0,"skipped":0,"reasonCategories":["source_unavailable"]});let db=state.db.lock().unwrap();db.execute("UPDATE scholarship_crawler_runs SET payload=?2 WHERE id=?1",params![run_id,failed.to_string()])?;db.execute("UPDATE scholarship_sources SET last_error=?2 WHERE id=?1",params![source.id,safe])?;Err(AppError::Invalid("Scholarship source refresh failed; saved opportunities were unchanged".into()))}}
}

#[tauri::command]
async fn refresh_scholarship_source(state:tauri::State<'_,AppState>,source_id:String)->Result<serde_json::Value>{state.require_unlocked()?;let state=state.inner().clone();tauri::async_runtime::spawn_blocking(move||refresh_scholarship_source_blocking(&state,source_id)).await.map_err(|error|AppError::Background(error.to_string()))?}

#[tauri::command]
fn set_scholarship_source_refresh(state:tauri::State<AppState>,source_id:String,weekly_refresh:bool)->Result<serde_json::Value>{
    state.require_unlocked()?;scholarships::descriptor(&source_id).map_err(|error|AppError::Invalid(error.to_string()))?;let db=state.db.lock().unwrap();
    db.execute("INSERT INTO scholarship_sources(id,weekly_refresh,parser_version) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET weekly_refresh=excluded.weekly_refresh",params![source_id,i64::from(weekly_refresh),scholarships::descriptor(&source_id).unwrap().parser_version])?;
    scholarship_workspace_in(&db)
}

#[tauri::command]
fn resolve_scholarship_diff(state:tauri::State<AppState>,diff_id:String)->Result<serde_json::Value>{
    state.require_unlocked()?;let db=state.db.lock().unwrap();let changed=db.execute("UPDATE scholarship_opportunity_diffs SET resolved_at=?2 WHERE id=?1 AND resolved_at IS NULL",params![diff_id,Utc::now().to_rfc3339()])?;
    if changed!=1{return Err(AppError::Invalid("Scholarship change was already resolved or not found".into()));}scholarship_workspace_in(&db)
}

#[tauri::command]
fn save_scholarship_profile(state:tauri::State<AppState>,profile:serde_json::Value)->Result<serde_json::Value>{
    state.require_unlocked()?;let study_level=profile.get("studyLevel").and_then(|value|value.as_str()).unwrap_or_default();if study_level.len()>100{return Err(AppError::Invalid("Study level is too long".into()));}
    for field in ["fieldsOfStudy","locations","citizenship","residency"]{let Some(values)=profile.get(field).and_then(|value|value.as_array())else{return Err(AppError::Invalid("Scholarship profile fields must be lists".into()));};if values.len()>25||values.iter().any(|value|value.as_str().is_none_or(|value|value.trim().is_empty()||value.len()>120)){return Err(AppError::Invalid("Scholarship profile contains an invalid value".into()));}}
    if profile.get("gpa").is_some_and(|value|!value.is_null()&&value.as_f64().is_none_or(|value|!(0.0..=5.0).contains(&value))){return Err(AppError::Invalid("GPA must be between 0 and 5".into()));}
    let db=state.db.lock().unwrap();db.execute("INSERT INTO scholarship_profiles(id,payload,updated_at) VALUES('local',?1,?2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at",params![profile.to_string(),Utc::now().to_rfc3339()])?;scholarship_workspace_in(&db)
}

fn scholarship_deadline_rfc3339(conn:&Connection,value:&str)->Result<String>{
    let date=NaiveDate::parse_from_str(value,"%Y-%m-%d").map_err(|_|AppError::Invalid("This scholarship does not have an exact deadline yet".into()))?;
    let timezone=canvas_calendar_timezone(conn);timezone.with_ymd_and_hms(date.year(),date.month(),date.day(),23,59,0).earliest().map(|value|value.to_rfc3339()).ok_or_else(||AppError::Invalid("The scholarship deadline is not valid in your timezone".into()))
}

fn plan_scholarship_deadline_in(conn:&Connection,opportunity_id:&str)->Result<()> {
    let payload=conn.query_row("SELECT payload FROM scholarship_opportunities WHERE id=?1",params![opportunity_id],|row|row.get::<_,String>(0)).optional()?.ok_or_else(||AppError::Invalid("Scholarship opportunity was not found".into()))?;
    let mut opportunity:serde_json::Value=serde_json::from_str(&payload).map_err(|_|AppError::Invalid("Scholarship opportunity could not be read".into()))?;
    if opportunity.get("taskIds").and_then(|value|value.as_array()).is_some_and(|ids|!ids.is_empty()){return Ok(());}
    let deadline=opportunity.get("deadline").and_then(|value|value.as_str()).ok_or_else(||AppError::Invalid("This scholarship does not have an exact deadline yet".into()))?;
    let due=scholarship_deadline_rfc3339(conn,deadline)?;let title=opportunity.get("title").and_then(|value|value.as_str()).unwrap_or("scholarship application");
    let tx=conn.unchecked_transaction()?;let task_id=insert_task(&tx,&format!("Submit {title}"),60,Some(&due),None)?;
    opportunity["taskIds"]=serde_json::json!([task_id]);opportunity["state"]=serde_json::Value::String("preparing".into());
    tx.execute("UPDATE scholarship_opportunities SET payload=?2,updated_at=?3 WHERE id=?1",params![opportunity_id,opportunity.to_string(),Utc::now().to_rfc3339()])?;
    mutation(&tx,"scholarship_opportunity",opportunity_id,"deadline_task_created","{}")?;tx.commit()?;regenerate_plan(conn,None)
}

#[tauri::command]
fn plan_scholarship_deadline(state:tauri::State<AppState>,opportunity_id:String)->Result<serde_json::Value>{state.require_unlocked()?;let db=state.db.lock().unwrap();require_onboarded(&db)?;plan_scholarship_deadline_in(&db,&opportunity_id)?;scholarship_workspace_in(&db)}

fn scholarship_profile_snippets(profile:&serde_json::Value)->Vec<String>{
    let mut snippets=Vec::new();if let Some(value)=profile.get("studyLevel").and_then(|value|value.as_str()).filter(|value|!value.trim().is_empty()){snippets.push(format!("Study level: {}",value.trim()));}
    for (field,label) in [("fieldsOfStudy","Field of study"),("locations","Location"),("citizenship","Citizenship"),("residency","Residency")]{for value in json_strings(profile,field){snippets.push(format!("{label}: {value}"));}}
    if let Some(value)=profile.get("gpa").and_then(|value|value.as_f64()){snippets.push(format!("GPA: {value:.2}"));}snippets
}

fn scholarship_writing_snippets(conn:&Connection)->Result<Vec<String>>{
    let mut snippets=scholarship_profile_snippets(&scholarship_profile_in(conn)?);
    for story in scholarship_payloads(conn,"SELECT payload FROM scholarship_story_examples ORDER BY updated_at DESC LIMIT 30")?{
        let title=story.get("title").and_then(|value|value.as_str()).unwrap_or_default().trim();
        let detail=story.get("detail").and_then(|value|value.as_str()).unwrap_or_default().trim();
        if !title.is_empty()&&!detail.is_empty(){snippets.push(format!("Story — {title}: {detail}"));}
    }
    Ok(snippets)
}

#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
struct ScholarshipWritingRequest{draft_id:String,kinds:Vec<String>,profile_snippets:Vec<String>,provider:String,model:String,policy_acknowledged:bool,consent:bool}

#[tauri::command]
fn preview_scholarship_writing(state:tauri::State<AppState>,draft_id:String)->Result<serde_json::Value>{
    state.require_unlocked()?;let db=state.db.lock().unwrap();let (content,opportunity_id):(String,String)=db.query_row("SELECT json_extract(payload,'$.content'),opportunity_id FROM scholarship_drafts WHERE id=?1",params![draft_id],|row|Ok((row.get(0)?,row.get(1)?))).optional()?.ok_or_else(||AppError::Invalid("Save the draft before requesting feedback".into()))?;
    let policy=db.query_row("SELECT json_extract(payload,'$.aiPolicy') FROM scholarship_opportunities WHERE id=?1",params![opportunity_id],|row|row.get::<_,String>(0)).optional()?.unwrap_or_else(||"unknown".into());if policy=="prohibited"{return Err(AppError::Invalid("This opportunity prohibits AI writing assistance".into()));}
    let (provider,key,model)=resolve_ai_provider(&db,managed_ai::AiCapability::ScholarshipWriting)?;drop(key);let snippets=scholarship_writing_snippets(&db)?;
    Ok(serde_json::json!({"draftId":draft_id,"provider":provider.as_str(),"model":model,"policy":policy,"draftScope":{"characters":content.chars().count(),"words":content.split_whitespace().count()},"profileSnippets":snippets,"disclosureUrl":provider.disclosure_url()}))
}

#[tauri::command]
async fn request_scholarship_writing_feedback(state:tauri::State<'_,AppState>,input:ScholarshipWritingRequest)->Result<serde_json::Value>{
    state.require_unlocked()?;if !input.consent{return Err(AppError::Invalid("Explicit consent is required before draft text leaves this device".into()));}let state=state.inner().clone();tauri::async_runtime::spawn_blocking(move||{
        state.require_unlocked()?;let (draft,policy,provider,key,model)={let db=state.db.lock().unwrap();let (draft,opportunity_id):(String,String)=db.query_row("SELECT json_extract(payload,'$.content'),opportunity_id FROM scholarship_drafts WHERE id=?1",params![input.draft_id],|row|Ok((row.get(0)?,row.get(1)?))).optional()?.ok_or_else(||AppError::Invalid("Draft was not found".into()))?;let policy=db.query_row("SELECT json_extract(payload,'$.aiPolicy') FROM scholarship_opportunities WHERE id=?1",params![opportunity_id],|row|row.get::<_,String>(0)).optional()?.unwrap_or_else(||"unknown".into());if policy=="prohibited"{return Err(AppError::Invalid("This opportunity prohibits AI writing assistance".into()));}if policy!="allowed"&&!input.policy_acknowledged{return Err(AppError::Invalid("Acknowledge the opportunity's unknown or restricted AI policy first".into()));}let provider:ai_providers::ProviderId=input.provider.parse()?;let current_model=ai_model(&db,provider);if current_model!=input.model{return Err(AppError::Invalid("AI provider settings changed; review the disclosure again".into()));}let allowed=scholarship_writing_snippets(&db)?;if input.profile_snippets.iter().any(|snippet|!allowed.contains(snippet)){return Err(AppError::Invalid("A selected profile snippet is no longer available".into()));}let key=ai_providers::load_key(provider)?;(draft,policy,provider,key,current_model)};
        let started=Instant::now();let response=ai_providers::request_writing_feedback(provider,&key,&model,&draft,&input.profile_snippets,&input.kinds)?;let db=state.db.lock().unwrap();let tx=db.unchecked_transaction()?;for suggestion in response.suggestions{let id=Uuid::new_v4().to_string();let payload=serde_json::json!({"id":id,"draftId":input.draft_id,"kind":suggestion.kind,"originalQuote":suggestion.original_quote,"replacement":suggestion.replacement,"rationale":suggestion.rationale,"supportingProfileQuotes":suggestion.supporting_profile_quotes,"provider":provider.as_str(),"model":model,"policy":policy,"status":"pending","createdAt":Utc::now().to_rfc3339()});tx.execute("INSERT INTO scholarship_writing_suggestions(id,draft_id,payload,status,created_at) VALUES(?1,?2,?3,'pending',?4)",params![id,input.draft_id,payload.to_string(),Utc::now().to_rfc3339()])?;}record_ai_invocation(&tx,provider.as_str(),managed_ai::AiCapability::ScholarshipWriting,Some(&model),started.elapsed().as_millis().min(i64::MAX as u128) as i64,response.usage.input_tokens,response.usage.output_tokens,"suggestions_created",None)?;tx.commit()?;scholarship_workspace_in(&db)
    }).await.map_err(|error|AppError::Background(error.to_string()))?
}

#[tauri::command]
fn resolve_scholarship_writing_suggestion(state:tauri::State<AppState>,suggestion_id:String,apply:bool)->Result<serde_json::Value>{
    state.require_unlocked()?;let db=state.db.lock().unwrap();let (draft_id,payload):(String,String)=db.query_row("SELECT draft_id,payload FROM scholarship_writing_suggestions WHERE id=?1 AND status='pending'",params![suggestion_id],|row|Ok((row.get(0)?,row.get(1)?))).optional()?.ok_or_else(||AppError::Invalid("Writing suggestion is no longer pending".into()))?;let suggestion:serde_json::Value=serde_json::from_str(&payload).map_err(|_|AppError::Invalid("Writing suggestion could not be read".into()))?;let tx=db.unchecked_transaction()?;
    if apply{let draft_payload=tx.query_row("SELECT payload FROM scholarship_drafts WHERE id=?1",params![draft_id],|row|row.get::<_,String>(0))?;let mut draft:serde_json::Value=serde_json::from_str(&draft_payload).map_err(|_|AppError::Invalid("Draft could not be read".into()))?;let content=draft.get("content").and_then(|value|value.as_str()).unwrap_or_default();let original=suggestion.get("originalQuote").and_then(|value|value.as_str()).unwrap_or_default();if original.is_empty()||!content.contains(original){return Err(AppError::Invalid("The draft changed; request fresh feedback before applying this suggestion".into()));}let replacement=suggestion.get("replacement").and_then(|value|value.as_str()).unwrap_or_default();let now=Utc::now().to_rfc3339();draft["content"]=serde_json::Value::String(content.replacen(original,replacement,1));draft["updatedAt"]=serde_json::Value::String(now.clone());let version_id=Uuid::new_v4().to_string();let version=serde_json::json!({"id":version_id,"draftId":draft_id,"content":draft["content"],"createdAt":now,"source":"ai_suggestion_applied"});if !draft.get("versions").is_some_and(|value|value.is_array()){draft["versions"]=serde_json::json!([]);}draft["versions"].as_array_mut().unwrap().push(version.clone());tx.execute("UPDATE scholarship_drafts SET payload=?2,updated_at=?3 WHERE id=?1",params![draft_id,draft.to_string(),now])?;tx.execute("INSERT INTO scholarship_draft_versions(id,draft_id,payload,created_at) VALUES(?1,?2,?3,?4)",params![version_id,draft_id,version.to_string(),now])?;mutation(&tx,"scholarship_draft",&draft_id,"suggestion_applied","{}")?;}
    tx.execute("UPDATE scholarship_writing_suggestions SET status=?2 WHERE id=?1",params![suggestion_id,if apply{"applied"}else{"dismissed"}])?;tx.commit()?;scholarship_workspace_in(&db)
}

fn scholarship_requirement_suggestions(segments:&[imports::Segment])->(Vec<String>,Vec<serde_json::Value>){
    let mut requirements=Vec::new();let mut prompts=Vec::new();let word_limit=regex::Regex::new(r"(?i)\b([1-9][0-9]{1,3})\s*words?\b").unwrap();
    for line in segments.iter().flat_map(|segment|segment.text.lines()).map(|line|line.trim().trim_start_matches(['-','•','*',' '])).filter(|line|!line.is_empty()){
        let lower=line.to_lowercase();
        for requirement in [
            lower.contains("transcript").then_some(if lower.contains("official"){"Official transcript"}else{"Transcript"}),
            (lower.contains("resume")||lower.contains("résumé")).then_some("Résumé"),
            lower.contains("recommendation").then_some("Letter of recommendation"),
            lower.contains("fafsa").then_some("FAFSA record"),
            lower.contains("portfolio").then_some("Portfolio"),
            lower.contains("proof of enrollment").then_some("Proof of enrollment"),
            lower.contains("financial aid form").then_some("Financial aid form"),
        ].into_iter().flatten(){if !requirements.iter().any(|value:&String|value.eq_ignore_ascii_case(requirement)){requirements.push(requirement.to_string());}}
        let looks_like_prompt=(lower.contains("essay")||lower.contains("prompt")||line.ends_with('?'))&&line.chars().count()>=20&&line.chars().count()<=800;
        if looks_like_prompt&&!prompts.iter().any(|value:&serde_json::Value|value.get("prompt").and_then(|value|value.as_str()).is_some_and(|value|value.eq_ignore_ascii_case(line))){
            let limit=word_limit.captures(line).and_then(|capture|capture.get(1)).and_then(|value|value.as_str().parse::<u64>().ok());
            prompts.push(serde_json::json!({"id":Uuid::new_v4().to_string(),"prompt":line,"wordLimit":limit}));
        }
        if requirements.len()>=25&&prompts.len()>=12{break;}
    }
    requirements.truncate(25);prompts.truncate(12);(requirements,prompts)
}

#[tauri::command]
fn import_scholarship_requirements(state:tauri::State<AppState>,opportunity_id:String,file_name:String,bytes:Vec<u8>)->Result<serde_json::Value>{
    state.require_unlocked()?;
    if bytes.is_empty()||bytes.len() as u64>MAX_IMPORT_BYTES{return Err(AppError::Invalid("files must be non-empty and 25 MB or smaller".into()));}
    let name=PathBuf::from(&file_name).file_name().and_then(|value|value.to_str()).filter(|value|!value.is_empty()).unwrap_or("requirements-document").to_string();
    let detected=imports::detect_document(&bytes,&name).map_err(|error|AppError::Extract(error.to_string()))?;
    let mut scratch=tempfile::Builder::new().prefix("coqui-scholarship-").suffix(&format!(".{}",Path::new(&name).extension().and_then(|value|value.to_str()).unwrap_or("bin"))).tempfile()?;
    std::io::Write::write_all(&mut scratch,&bytes)?;
    let db=state.db.lock().unwrap();
    if db.query_row("SELECT 1 FROM scholarship_opportunities WHERE id=?1",params![opportunity_id],|row|row.get::<_,i64>(0)).optional()?.is_none(){return Err(AppError::Invalid("Scholarship opportunity was not found".into()));}
    let timezone=db.query_row("SELECT value FROM settings WHERE key='timezone'",[],|row|row.get::<_,String>(0)).unwrap_or_else(|_|"Etc/UTC".into());
    let extraction=imports::extract_document(imports::DocumentSource::File(scratch.path()),&bytes,&name,&timezone,&state.ocr,&[],&[]).map_err(|error|AppError::Extract(error.to_string()))?;
    if extraction.segments.iter().all(|segment|segment.text.trim().is_empty()){return Err(AppError::Invalid("This file contained no locally extractable text. Try a text-based PDF, DOCX, image, or plain-text copy.".into()));}
    let hash=hex::encode(Sha256::digest(&bytes));
    let existing=db.query_row("SELECT id FROM documents WHERE sha256=?1 ORDER BY imported_at LIMIT 1",params![hash],|row|row.get::<_,String>(0)).optional()?;
    let document_id=if let Some(id)=existing{id}else{
        let document_key=random_key();let(encrypted,content_nonce)=encrypt(&document_key,&bytes)?;let(wrapped,key_nonce)=encrypt(&state.master_key,&document_key)?;let id=Uuid::new_v4().to_string();let vault_path=state.vault.join(format!("{id}.vault"));fs::write(&vault_path,encrypted)?;let now=Utc::now().to_rfc3339();
        db.execute("INSERT INTO documents(id,file_name,mime,vault_path,wrapped_key,key_nonce,content_nonce,sha256,imported_at,extraction_status,extraction_error,source_retention) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'complete',NULL,'keep_encrypted')",params![id,name,detected.mime(),vault_path.to_string_lossy(),B64.encode(wrapped),B64.encode(key_nonce),B64.encode(content_nonce),hash,now])?;
        id
    };
    let segment_count:i64=db.query_row("SELECT COUNT(*) FROM document_segments WHERE document_id=?1",params![document_id],|row|row.get(0))?;
    if segment_count==0{for(position,segment)in extraction.segments.iter().take(250).enumerate(){let text=segment.text.chars().take(50_000).collect::<String>();if !text.trim().is_empty(){db.execute("INSERT INTO document_segments(id,document_id,locator,text,confidence,position) VALUES(?1,?2,?3,?4,?5,?6)",params![Uuid::new_v4().to_string(),document_id,segment.locator,text,segment.confidence,position as i64])?;}}}
    let(requirements,prompts)=scholarship_requirement_suggestions(&extraction.segments);let mut warnings=extraction.warnings;if requirements.is_empty()&&prompts.is_empty(){warnings.push("No requirements or essay prompts were recognized. Review the source manually.".into());}
    let imported_at=Utc::now().to_rfc3339();let link_id=db.query_row("SELECT id FROM scholarship_requirement_documents WHERE opportunity_id=?1 AND document_id=?2",params![opportunity_id,document_id],|row|row.get::<_,String>(0)).optional()?.unwrap_or_else(||Uuid::new_v4().to_string());
    let payload=serde_json::json!({"id":link_id,"opportunityId":opportunity_id,"documentId":document_id,"fileName":name,"mime":detected.mime(),"importedAt":imported_at,"status":if requirements.is_empty()&&prompts.is_empty(){"needs_attention"}else{"review_required"},"proposedRequirements":requirements,"proposedPrompts":prompts,"warnings":warnings,"selectedRequirements":[],"selectedPromptIds":[]});
    db.execute("INSERT INTO scholarship_requirement_documents(id,opportunity_id,document_id,payload,imported_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(opportunity_id,document_id) DO UPDATE SET payload=excluded.payload,imported_at=excluded.imported_at",params![link_id,opportunity_id,document_id,payload.to_string(),imported_at])?;
    scholarship_workspace_in(&db)
}

#[tauri::command]
fn apply_scholarship_requirements_review(state:tauri::State<AppState>,document_id:String,requirements:Vec<String>,prompt_ids:Vec<String>)->Result<serde_json::Value>{
    state.require_unlocked()?;if requirements.len()>25||prompt_ids.len()>12{return Err(AppError::Invalid("Too many imported details were selected".into()));}
    let db=state.db.lock().unwrap();let(payload,opportunity_id):(String,String)=db.query_row("SELECT payload,opportunity_id FROM scholarship_requirement_documents WHERE id=?1",params![document_id],|row|Ok((row.get(0)?,row.get(1)?))).optional()?.ok_or_else(||AppError::Invalid("Requirements import was not found".into()))?;let mut review:serde_json::Value=serde_json::from_str(&payload).map_err(|_|AppError::Invalid("Requirements import could not be read".into()))?;
    let proposed_requirements=review.get("proposedRequirements").and_then(|value|value.as_array()).cloned().unwrap_or_default();if requirements.iter().any(|selected|!proposed_requirements.iter().any(|value|value.as_str()==Some(selected))){return Err(AppError::Invalid("A selected requirement is no longer in this import".into()));}
    let proposed_prompts=review.get("proposedPrompts").and_then(|value|value.as_array()).cloned().unwrap_or_default();if prompt_ids.iter().any(|selected|!proposed_prompts.iter().any(|value|value.get("id").and_then(|value|value.as_str())==Some(selected))){return Err(AppError::Invalid("A selected prompt is no longer in this import".into()));}
    let opportunity_payload=db.query_row("SELECT payload FROM scholarship_opportunities WHERE id=?1",params![opportunity_id],|row|row.get::<_,String>(0))?;let mut opportunity:serde_json::Value=serde_json::from_str(&opportunity_payload).map_err(|_|AppError::Invalid("Scholarship opportunity could not be read".into()))?;
    let mut documents=opportunity.get("requiredDocuments").and_then(|value|value.as_array()).cloned().unwrap_or_default();for selected in &requirements{if !documents.iter().any(|value|value.as_str().is_some_and(|value|value.eq_ignore_ascii_case(selected))){documents.push(serde_json::Value::String(selected.clone()));}}
    let mut prompts=opportunity.get("essayPrompts").and_then(|value|value.as_array()).cloned().unwrap_or_default();for selected in proposed_prompts.iter().filter(|value|value.get("id").and_then(|value|value.as_str()).is_some_and(|id|prompt_ids.contains(&id.to_string()))){if !prompts.iter().any(|value|value.get("prompt").and_then(|value|value.as_str())==selected.get("prompt").and_then(|value|value.as_str())){prompts.push(selected.clone());}}
    opportunity["requiredDocuments"]=serde_json::Value::Array(documents);opportunity["essayPrompts"]=serde_json::Value::Array(prompts);opportunity["verificationStatus"]=serde_json::Value::String("verified".into());let now=Utc::now().to_rfc3339();
    review["status"]=serde_json::Value::String("reviewed".into());review["selectedRequirements"]=serde_json::json!(requirements);review["selectedPromptIds"]=serde_json::json!(prompt_ids);
    let tx=db.unchecked_transaction()?;tx.execute("UPDATE scholarship_opportunities SET payload=?2,updated_at=?3 WHERE id=?1",params![opportunity_id,opportunity.to_string(),now])?;tx.execute("UPDATE scholarship_requirement_documents SET payload=?2 WHERE id=?1",params![document_id,review.to_string()])?;tx.commit()?;mutation(&db,"scholarship_opportunity",&opportunity_id,"requirements_reviewed","{}")?;scholarship_workspace_in(&db)
}

#[tauri::command]
fn save_scholarship_opportunity(state: tauri::State<AppState>, opportunity: serde_json::Value) -> Result<serde_json::Value> {
    state.require_unlocked()?;
    let id = opportunity.get("id").and_then(|value| value.as_str()).filter(|value| !value.is_empty()).ok_or_else(|| AppError::Invalid("Scholarship id is required".into()))?;
    let title = opportunity.get("title").and_then(|value| value.as_str()).unwrap_or_default().trim();
    let url = opportunity.get("canonicalUrl").and_then(|value| value.as_str()).unwrap_or_default();
    if title.is_empty() || canvas_calendar::validate_url(url).is_err() { return Err(AppError::Invalid("Scholarship title and a public HTTPS source URL are required".into())); }
    let now = Utc::now().to_rfc3339();
    let db = state.db.lock().unwrap();
    db.execute("INSERT INTO scholarship_opportunities(id,payload,updated_at) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at", params![id, opportunity.to_string(), now])?;
    mutation(&db,"scholarship_opportunity",id,"saved","{}")?;
    drop(db);
    get_scholarship_workspace(state)
}

#[tauri::command]
fn save_scholarship_application(state: tauri::State<AppState>, application: serde_json::Value) -> Result<serde_json::Value> {
    state.require_unlocked()?;
    let id=application.get("id").and_then(|value|value.as_str()).ok_or_else(||AppError::Invalid("Application id is required".into()))?;
    let opportunity_id=application.get("opportunityId").and_then(|value|value.as_str()).ok_or_else(||AppError::Invalid("Opportunity id is required".into()))?;
    let now=Utc::now().to_rfc3339(); let db=state.db.lock().unwrap();
    db.execute("INSERT INTO scholarship_applications(id,opportunity_id,payload,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at",params![id,opportunity_id,application.to_string(),now])?;
    mutation(&db,"scholarship_application",id,"saved","{}")?; drop(db); get_scholarship_workspace(state)
}

#[tauri::command]
fn save_scholarship_draft(state: tauri::State<AppState>, draft: serde_json::Value) -> Result<serde_json::Value> {
    state.require_unlocked()?;let db=state.db.lock().unwrap();persist_scholarship_draft(&db,draft,true)?;scholarship_workspace_in(&db)
}

fn persist_scholarship_draft(conn:&Connection,draft:serde_json::Value,create_version:bool)->Result<()>{
    let id=draft.get("id").and_then(|value|value.as_str()).ok_or_else(||AppError::Invalid("Draft id is required".into()))?.to_string();
    let opportunity_id=draft.get("opportunityId").and_then(|value|value.as_str()).ok_or_else(||AppError::Invalid("Opportunity id is required".into()))?.to_string();
    let content=draft.get("content").and_then(|value|value.as_str()).ok_or_else(||AppError::Invalid("Draft content is required".into()))?.to_string();
    if !create_version&&conn.query_row("SELECT 1 FROM scholarship_drafts WHERE id=?1",params![id],|row|row.get::<_,i64>(0)).optional()?.is_none(){return Err(AppError::Invalid("Save the first draft version before autosave begins".into()));}
    let now=Utc::now().to_rfc3339();let mut draft=draft;
    if !create_version{
        draft["updatedAt"]=serde_json::Value::String(now.clone());
        conn.execute("UPDATE scholarship_drafts SET opportunity_id=?2,payload=?3,updated_at=?4 WHERE id=?1",params![id,opportunity_id,draft.to_string(),now])?;
        return mutation(conn,"scholarship_draft",&id,"autosaved","{}");
    }
    let version_id=Uuid::new_v4().to_string();let tx=conn.unchecked_transaction()?;
    let version=serde_json::json!({"id":version_id,"draftId":id,"content":content,"createdAt":now,"source":"student"});
    if !draft.get("versions").is_some_and(|value|value.is_array()){draft["versions"]=serde_json::json!([]);}
    draft["versions"].as_array_mut().unwrap().push(version.clone());
    draft["updatedAt"]=serde_json::Value::String(now.clone());
    tx.execute("INSERT INTO scholarship_drafts(id,opportunity_id,payload,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at",params![id,opportunity_id,draft.to_string(),now])?;
    tx.execute("INSERT INTO scholarship_draft_versions(id,draft_id,payload,created_at) VALUES(?1,?2,?3,?4)",params![version_id,id,version.to_string(),now])?;
    tx.commit()?;mutation(conn,"scholarship_draft",&id,"version_saved","{}")
}

#[tauri::command]
fn autosave_scholarship_draft(state:tauri::State<AppState>,draft:serde_json::Value)->Result<serde_json::Value>{
    state.require_unlocked()?;let db=state.db.lock().unwrap();persist_scholarship_draft(&db,draft,false)?;scholarship_workspace_in(&db)
}

#[tauri::command]
fn save_scholarship_story(state:tauri::State<AppState>,story:serde_json::Value)->Result<serde_json::Value>{
    state.require_unlocked()?;let id=story.get("id").and_then(|value|value.as_str()).ok_or_else(||AppError::Invalid("Story id is required".into()))?.to_string();let title=story.get("title").and_then(|value|value.as_str()).unwrap_or_default().trim();let detail=story.get("detail").and_then(|value|value.as_str()).unwrap_or_default().trim();let tags=story.get("tags").and_then(|value|value.as_array()).ok_or_else(||AppError::Invalid("Story tags are invalid".into()))?;
    if id.len()>200||title.is_empty()||title.len()>160||detail.is_empty()||detail.len()>6000||tags.len()>20||tags.iter().any(|tag|tag.as_str().is_none_or(|value|value.len()>80)){return Err(AppError::Invalid("Story examples require a title, bounded detail, and up to 20 short tags".into()));}
    let now=Utc::now().to_rfc3339();let mut story=story;story["updatedAt"]=serde_json::Value::String(now.clone());let db=state.db.lock().unwrap();db.execute("INSERT INTO scholarship_story_examples(id,payload,updated_at) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at",params![id,story.to_string(),now])?;mutation(&db,"scholarship_story",&id,"saved","{}")?;scholarship_workspace_in(&db)
}

#[tauri::command]
fn delete_scholarship_story(state:tauri::State<AppState>,story_id:String)->Result<serde_json::Value>{state.require_unlocked()?;let db=state.db.lock().unwrap();if db.execute("DELETE FROM scholarship_story_examples WHERE id=?1",params![story_id])?!=1{return Err(AppError::Invalid("Story example was not found".into()));}mutation(&db,"scholarship_story",&story_id,"deleted","{}")?;scholarship_workspace_in(&db)}

fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> Result<()> {
    let mut query = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let exists = query
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|value| value.ok())
        .any(|name| name == column);
    if !exists {
        conn.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition}"
        ))?;
    }
    Ok(())
}

fn backfill_legacy_canvas_links(conn: &Connection) -> Result<()> {
    let mut query = conn.prepare(
        "SELECT id,kind,title,due_at,starts_at,ends_at,duration_minutes,course,source_uid,status
         FROM import_candidates
         WHERE source_type LIKE 'canvas_%' AND source_uid!='' AND canonical_entity_id IS NULL
         ORDER BY rowid",
    )?;
    let candidates = query
        .query_map([], |row| {
            Ok((
                PendingCandidate {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    title: row.get(2)?,
                    due_at: row.get(3)?,
                    starts_at: row.get(4)?,
                    ends_at: row.get(5)?,
                    duration_minutes: row.get(6)?,
                    course: row.get(7)?,
                    source_uid: row.get(8)?,
                    // Legacy Canvas backfill: these are tasks and commitments,
                    // never weekly patterns.
                    ..Default::default()
                },
                row.get::<_, String>(9)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(query);

    for (candidate, status) in &candidates {
        if status != "approved" {
            continue;
        }
        let matches = match candidate.kind.as_str() {
            "task" => {
                let mut rows = conn.prepare(
                    "SELECT id FROM tasks WHERE title=?1 AND COALESCE(due_at,'')=COALESCE(?2,'')",
                )?;
                let matches = rows
                    .query_map(params![candidate.title, candidate.due_at], |row| {
                        row.get::<_, String>(0)
                    })?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                matches
            }
            "commitment" => {
                let mut rows = conn.prepare(
                    "SELECT id FROM commitments WHERE title=?1 AND starts_at=?2 AND ends_at=?3",
                )?;
                let matches = rows
                    .query_map(
                        params![candidate.title, candidate.starts_at, candidate.ends_at],
                        |row| row.get::<_, String>(0),
                    )?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                matches
            }
            "course" => {
                let mut rows = conn.prepare("SELECT id FROM courses WHERE source_uid=?1")?;
                let matches = rows
                    .query_map(params![candidate.source_uid], |row| row.get::<_, String>(0))?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                matches
            }
            _ => Vec::new(),
        };
        if matches.len() != 1 {
            continue;
        }
        let entity_id = &matches[0];
        let update = match candidate.kind.as_str() {
            "task" => "UPDATE tasks SET source_uid=?2,source_candidate_id=?3 WHERE id=?1",
            "commitment" => {
                "UPDATE commitments SET source_uid=?2,source_candidate_id=?3 WHERE id=?1"
            }
            "course" => "UPDATE courses SET source_candidate_id=?3 WHERE id=?1",
            _ => continue,
        };
        conn.execute(
            update,
            params![entity_id, candidate.source_uid, candidate.id],
        )?;
        conn.execute(
            "UPDATE import_candidates SET canonical_entity_id=?2 WHERE id=?1",
            params![candidate.id, entity_id],
        )?;
        link_candidate_provenance(conn, &candidate.kind, entity_id, &candidate.id)?;
    }

    for (candidate, status) in candidates {
        if status != "pending" {
            continue;
        }
        let legacy_id = format!(
            "source-change-{}",
            hex::encode(Sha256::digest(candidate.source_uid.as_bytes()))
        );
        let extracted = ExtractedCandidate {
            kind: candidate.kind,
            title: candidate.title,
            course: candidate.course,
            due_at: candidate.due_at,
            starts_at: candidate.starts_at,
            ends_at: candidate.ends_at,
            duration_minutes: candidate.duration_minutes,
            evidence: String::new(),
            source_locator: String::new(),
            source_uid: candidate.source_uid,
            confidence: 1.0,
            warnings: Vec::new(),
            ..Default::default()
        };
        candidate_conflict(conn, &candidate.id, &extracted)?;
        let structured_exists = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM source_conflicts
             WHERE candidate_id=?1 AND kind='source_change')",
            params![candidate.id],
            |row| row.get::<_, i64>(0),
        )? != 0;
        if structured_exists {
            conn.execute(
                "UPDATE source_conflicts SET resolved=1,resolved_at=?2,
                 resolution='superseded_by_structured_migration'
                 WHERE id=?1 AND resolved=0 AND candidate_id IS NULL",
                params![legacy_id, Utc::now().to_rfc3339()],
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
fn table_columns(conn: &Connection, table: &str) -> Result<std::collections::HashSet<String>> {
    let mut query = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = query
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|value| value.ok())
        .collect();
    Ok(columns)
}

fn mutation(
    conn: &Connection,
    entity_type: &str,
    entity_id: &str,
    operation: &str,
    _legacy_payload: &str,
) -> Result<()> {
    let device_id = persistent_device_id(conn)?;
    let hlc = next_hybrid_logical_timestamp(conn, &device_id)?;
    let snapshot = canonical_entity_snapshot(conn, entity_type, entity_id)?;
    let tombstone = snapshot.is_none() || operation == "deleted";
    let set_changes =
        local_set_changes(conn, entity_type, entity_id, snapshot.as_ref(), tombstone)?;
    let payload = serde_json::to_string(&serde_json::json!({
        "schemaVersion": 2,
        "entityType": entity_type,
        "entityId": entity_id,
        "operation": operation,
        "snapshot": if tombstone { serde_json::Value::Null } else { snapshot.clone().unwrap() },
        "setChanges": set_changes,
    }))
    .map_err(|_| AppError::Invalid("The canonical mutation could not be encoded".into()))?;
    let mutation_id = Uuid::new_v4().to_string();
    conn.execute(
    "INSERT INTO mutations(id,entity_type,entity_id,operation,hlc,device_id,tombstone,payload) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
    params![mutation_id, entity_type, entity_id, operation, hlc, device_id, i64::from(tombstone), payload],
  )?;
    // A new entity type must be a deliberate choice: either mapped in canonical_table so peers can
    // apply it, or named in LOCAL_ONLY_ENTITY_TYPES. Silently defaulting to local-only is how
    // records end up encrypted, uploaded, and discarded forever.
    debug_assert!(
        is_replicated_entity_type(entity_type) || LOCAL_ONLY_ENTITY_TYPES.contains(&entity_type),
        "{entity_type} is neither replicated nor declared local-only"
    );
    // The version register exists to resolve last-writer-wins against peers. Advancing it for a
    // type that is never replicated would leave a high water mark that silently swallows the first
    // real remote mutation if that type ever does become replicated.
    if is_replicated_entity_type(entity_type) {
        conn.execute(
            "INSERT INTO sync_entity_versions(entity_type,entity_id,hlc,device_id,tombstone,mutation_id)
             VALUES(?1,?2,?3,?4,?5,?6)
             ON CONFLICT(entity_type,entity_id) DO UPDATE SET
               hlc=excluded.hlc,device_id=excluded.device_id,tombstone=excluded.tombstone,mutation_id=excluded.mutation_id",
            params![entity_type, entity_id, hlc, device_id, i64::from(tombstone), mutation_id],
        )?;
    }
    record_local_set_elements(conn, entity_type, entity_id, &set_changes, &hlc, &device_id)?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetElementChange {
    field_name: String,
    element_id: String,
    tombstone: bool,
}

fn local_set_changes(
    conn: &Connection,
    entity_type: &str,
    entity_id: &str,
    snapshot: Option<&serde_json::Value>,
    tombstone: bool,
) -> Result<Vec<SetElementChange>> {
    if entity_type != "task" {
        return Ok(Vec::new());
    }
    let incoming = snapshot
        .and_then(|value| value.get("dependencies"))
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str())
        .map(str::to_owned)
        .collect::<std::collections::BTreeSet<_>>();
    let current = conn
        .prepare(
            "SELECT element_id FROM sync_set_elements
             WHERE entity_type='task' AND entity_id=?1 AND field_name='dependencies' AND tombstone=0
             ORDER BY element_id",
        )?
        .query_map(params![entity_id], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<std::collections::BTreeSet<_>, _>>()?;
    let mut changes = Vec::new();
    if !tombstone {
        changes.extend(
            incoming
                .difference(&current)
                .map(|element_id| SetElementChange {
                    field_name: "dependencies".into(),
                    element_id: element_id.clone(),
                    tombstone: false,
                }),
        );
    }
    changes.extend(
        current
            .difference(&incoming)
            .map(|element_id| SetElementChange {
                field_name: "dependencies".into(),
                element_id: element_id.clone(),
                tombstone: true,
            }),
    );
    Ok(changes)
}

fn record_local_set_elements(
    conn: &Connection,
    entity_type: &str,
    entity_id: &str,
    changes: &[SetElementChange],
    hlc: &str,
    device_id: &str,
) -> Result<()> {
    if entity_type != "task" {
        return Ok(());
    }
    for change in changes {
        conn.execute(
            "INSERT INTO sync_set_elements(entity_type,entity_id,field_name,element_id,hlc,device_id,tombstone)
             VALUES('task',?1,'dependencies',?2,?3,?4,?5)
             ON CONFLICT(entity_type,entity_id,field_name,element_id) DO UPDATE SET
               hlc=excluded.hlc,device_id=excluded.device_id,tombstone=excluded.tombstone
             WHERE sync_set_elements.hlc<excluded.hlc OR (sync_set_elements.hlc=excluded.hlc AND sync_set_elements.device_id<=excluded.device_id)",
            params![entity_id, change.element_id, hlc, device_id, i64::from(change.tombstone)],
        )?;
    }
    Ok(())
}

fn persistent_device_id(conn: &Connection) -> Result<String> {
    if let Some(device_id) = conn
        .query_row(
            "SELECT value FROM settings WHERE key='local_device_id'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    {
        Uuid::parse_str(&device_id)
            .map_err(|_| AppError::Invalid("The persistent device ID is invalid".into()))?;
        return Ok(device_id);
    }
    let device_id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO settings(key,value) VALUES('local_device_id',?1)",
        params![device_id],
    )?;
    Ok(device_id)
}

fn next_hybrid_logical_timestamp(conn: &Connection, device_id: &str) -> Result<String> {
    let physical = Utc::now().timestamp_millis().max(0);
    let previous_physical = db_setting(conn, "hlc_physical_ms", "0")
        .parse::<i64>()
        .unwrap_or(0);
    let previous_counter = db_setting(conn, "hlc_counter", "0")
        .parse::<u32>()
        .unwrap_or(0);
    let (physical, counter) = if physical > previous_physical {
        (physical, 0)
    } else {
        (previous_physical, previous_counter.saturating_add(1))
    };
    conn.execute(
        "INSERT INTO settings(key,value) VALUES('hlc_physical_ms',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![physical.to_string()],
    )?;
    conn.execute(
        "INSERT INTO settings(key,value) VALUES('hlc_counter',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![counter.to_string()],
    )?;
    Ok(format!("{physical:013}-{counter:010}-{device_id}"))
}

fn observe_hybrid_logical_timestamp(conn: &Connection, value: &str) -> Result<()> {
    let mut parts = value.splitn(3, '-');
    let remote_physical = parts
        .next()
        .and_then(|value| value.parse::<i64>().ok())
        .ok_or_else(|| AppError::Invalid("A remote hybrid clock is invalid".into()))?;
    let remote_counter = parts
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or_else(|| AppError::Invalid("A remote hybrid clock is invalid".into()))?;
    let local_physical = db_setting(conn, "hlc_physical_ms", "0")
        .parse::<i64>()
        .unwrap_or(0);
    let local_counter = db_setting(conn, "hlc_counter", "0")
        .parse::<u32>()
        .unwrap_or(0);
    let (physical, counter) = if remote_physical > local_physical {
        (remote_physical, remote_counter)
    } else if remote_physical == local_physical {
        (local_physical, local_counter.max(remote_counter))
    } else {
        return Ok(());
    };
    conn.execute(
        "INSERT INTO settings(key,value) VALUES('hlc_physical_ms',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![physical.to_string()],
    )?;
    conn.execute(
        "INSERT INTO settings(key,value) VALUES('hlc_counter',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![counter.to_string()],
    )?;
    Ok(())
}

fn sqlite_value(value: rusqlite::types::ValueRef<'_>) -> serde_json::Value {
    match value {
        rusqlite::types::ValueRef::Null => serde_json::Value::Null,
        rusqlite::types::ValueRef::Integer(value) => value.into(),
        rusqlite::types::ValueRef::Real(value) => serde_json::Number::from_f64(value)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        rusqlite::types::ValueRef::Text(value) => {
            String::from_utf8_lossy(value).into_owned().into()
        }
        rusqlite::types::ValueRef::Blob(value) => B64.encode(value).into(),
    }
}

fn table_snapshot(
    conn: &Connection,
    table: &str,
    id_column: &str,
    entity_id: &str,
) -> Result<Option<serde_json::Value>> {
    let sql = format!("SELECT * FROM {table} WHERE {id_column}=?1");
    let mut statement = conn.prepare(&sql)?;
    let columns = statement
        .column_names()
        .iter()
        .map(|value| (*value).to_string())
        .collect::<Vec<_>>();
    statement
        .query_row(params![entity_id], |row| {
            let mut object = serde_json::Map::new();
            for (index, column) in columns.iter().enumerate() {
                object.insert(column.clone(), sqlite_value(row.get_ref(index)?));
            }
            Ok(serde_json::Value::Object(object))
        })
        .optional()
        .map_err(Into::into)
}

fn canonical_entity_snapshot(
    conn: &Connection,
    entity_type: &str,
    entity_id: &str,
) -> Result<Option<serde_json::Value>> {
    let table = match entity_type {
        "task" | "assignment" | "exam" => {
            let Some(mut snapshot) = table_snapshot(conn, "tasks", "id", entity_id)? else {
                return Ok(None);
            };
            let dependencies = conn
                .prepare("SELECT depends_on_task_id FROM task_dependencies WHERE task_id=?1 ORDER BY depends_on_task_id")?
                .query_map(params![entity_id], |row| row.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            snapshot
                .as_object_mut()
                .ok_or_else(|| AppError::Invalid("The task snapshot is invalid".into()))?
                .insert("dependencies".into(), serde_json::json!(dependencies));
            return Ok(Some(snapshot));
        }
        "course" => ("courses", "id"),
        "commitment" => ("commitments", "id"),
        "academic_term" => ("academic_terms", "id"),
        "instructor" => ("instructors", "id"),
        "class_meeting_series" => ("class_meeting_series", "id"),
        "academic_calendar_event" => ("academic_calendar_events", "id"),
        "student_profile" => ("student_profiles", "id"),
        "planning_preferences" => ("planning_preferences", "profile_id"),
        "availability_rule" => ("availability_rules", "id"),
        "plan_block" => ("plan_blocks", "id"),
        "document" => ("documents", "id"),
        "import_candidate" => ("import_candidates", "id"),
        "source_conflict" => ("source_conflicts", "id"),
        "integration_connection" => ("integration_connections", "id"),
        "scholarship_opportunity" => ("scholarship_opportunities", "id"),
        "scholarship_application" => ("scholarship_applications", "id"),
        "scholarship_draft" => ("scholarship_drafts", "id"),
        "scholarship_story" => ("scholarship_story_examples", "id"),
        "reminder" => ("reminder_deliveries", "block_id"),
        "plan" => {
            let mut statement = conn.prepare("SELECT * FROM plan_blocks ORDER BY id")?;
            let columns = statement
                .column_names()
                .iter()
                .map(|value| (*value).to_string())
                .collect::<Vec<_>>();
            let rows = statement
                .query_map([], |row| {
                    let mut object = serde_json::Map::new();
                    for (index, column) in columns.iter().enumerate() {
                        object.insert(column.clone(), sqlite_value(row.get_ref(index)?));
                    }
                    Ok(serde_json::Value::Object(object))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            return Ok(Some(serde_json::json!({"blocks": rows})));
        }
        "notification_preferences" => {
            return Ok(Some(serde_json::json!({
                "enabled": db_setting(conn, "notifications_enabled", "false"),
                "leadMinutes": db_setting(conn, "notification_lead_minutes", "10"),
                "quietStart": db_setting(conn, "notification_quiet_start", "22:00"),
                "quietEnd": db_setting(conn, "notification_quiet_end", "07:00"),
                "showTitles": db_setting(conn, "notification_show_titles", "false"),
            })));
        }
        _ => {
            return Err(AppError::Invalid(format!(
                "Unsupported canonical mutation entity type: {entity_type}"
            )))
        }
    };
    table_snapshot(conn, table.0, table.1, entity_id)
}

fn insert_task(
    conn: &Connection,
    title: &str,
    minutes: i64,
    due: Option<&str>,
    course_id: Option<&str>,
) -> Result<String> {
    if title.trim().is_empty() || !(5..=480).contains(&minutes) {
        return Err(AppError::Invalid(
            "task title and a 5–480 minute estimate are required".into(),
        ));
    }
    let id = Uuid::new_v4().to_string();
    // Quick capture could not name a course until now, so everything added from
    // the topbar landed unattached even when the student knew the course.
    let course_id = course_id.map(str::trim).filter(|value| !value.is_empty());
    conn.execute(
        "INSERT INTO tasks(id,title,minutes,due_at,course_id,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
        params![
            id,
            title.trim(),
            minutes,
            due,
            course_id,
            Utc::now().to_rfc3339()
        ],
    )?;
    mutation(conn, "task", &id, "created", "{}")?;
    Ok(id)
}

fn parse_rfc3339(value: &str) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.with_timezone(&Local))
}

fn db_setting(conn: &Connection, key: &str, default: &str) -> String {
    conn.query_row(
        "SELECT value FROM settings WHERE key=?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .unwrap_or_else(|_| default.to_string())
}

fn notification_settings_from_db(
    conn: &Connection,
    permission_granted: bool,
) -> NotificationSettings {
    NotificationSettings {
        enabled: db_setting(conn, "notifications_enabled", "false") == "true",
        permission_granted,
        lead_minutes: db_setting(conn, "notification_lead_minutes", "10")
            .parse()
            .unwrap_or(10),
        quiet_start: db_setting(conn, "notification_quiet_start", "22:00"),
        quiet_end: db_setting(conn, "notification_quiet_end", "07:00"),
        show_titles: db_setting(conn, "notification_show_titles", "false") == "true",
    }
}

fn parse_clock(value: &str) -> Option<u32> {
    let (hours, minutes) = value.split_once(':')?;
    let hours = hours.parse::<u32>().ok()?;
    let minutes = minutes.parse::<u32>().ok()?;
    (hours < 24 && minutes < 60).then_some(hours * 60 + minutes)
}

fn in_quiet_hours(now_minutes: u32, start: u32, end: u32) -> bool {
    if start == end {
        false
    } else if start < end {
        (start..end).contains(&now_minutes)
    } else {
        now_minutes >= start || now_minutes < end
    }
}

fn student_local_minutes(conn: &Connection, now: DateTime<Utc>) -> u32 {
    let timezone = db_setting(conn, "timezone", "Etc/UTC");
    timezone
        .parse::<chrono_tz::Tz>()
        .map(|zone| {
            let local = now.with_timezone(&zone);
            local.hour() * 60 + local.minute()
        })
        .unwrap_or_else(|_| {
            let local = now.with_timezone(&Local);
            local.hour() * 60 + local.minute()
        })
}

#[derive(Debug)]
struct DueReminder {
    block_id: String,
    title: String,
}

fn take_due_reminders(
    conn: &Connection,
    now: DateTime<Utc>,
) -> Result<(NotificationSettings, Vec<DueReminder>)> {
    let settings = notification_settings_from_db(conn, true);
    if !settings.enabled {
        return Ok((settings, Vec::new()));
    }
    let quiet_start = parse_clock(&settings.quiet_start).unwrap_or(22 * 60);
    let quiet_end = parse_clock(&settings.quiet_end).unwrap_or(7 * 60);
    if in_quiet_hours(student_local_minutes(conn, now), quiet_start, quiet_end) {
        return Ok((settings, Vec::new()));
    }
    let earliest = now - Duration::minutes(5);
    let latest = now + Duration::minutes(settings.lead_minutes);
    let mut query = conn.prepare(
        "SELECT p.id,p.title,p.starts_at
         FROM plan_blocks p
         LEFT JOIN reminder_deliveries r
           ON r.block_id=p.id AND r.plan_starts_at=p.starts_at
         WHERE p.task_id IS NOT NULL AND p.completed=0
           AND datetime(p.starts_at)>=datetime(?1) AND datetime(p.starts_at)<=datetime(?2)
           AND r.dismissed_at IS NULL
           AND (r.delivered_at IS NULL OR (r.snoozed_until IS NOT NULL AND datetime(r.snoozed_until)<=datetime(?3)))
         ORDER BY datetime(p.starts_at),p.id",
    )?;
    let due = query
        .query_map(
            params![earliest.to_rfc3339(), latest.to_rfc3339(), now.to_rfc3339()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let delivered_at = now.to_rfc3339();
    let reminders = due
        .into_iter()
        .map(|(block_id, title, starts_at)| {
            conn.execute(
                "INSERT INTO reminder_deliveries(block_id,plan_starts_at,delivered_at,snoozed_until,dismissed_at)
                 VALUES(?1,?2,?3,NULL,NULL)
                 ON CONFLICT(block_id) DO UPDATE SET
                   plan_starts_at=excluded.plan_starts_at,
                   delivered_at=excluded.delivered_at,
                   snoozed_until=NULL,
                   dismissed_at=NULL",
                params![block_id, starts_at, delivered_at],
            )?;
            Ok(DueReminder { block_id, title })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok((settings, reminders))
}

fn run_reminder_tick<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &AppState,
) -> Result<usize> {
    let (settings, reminders) = take_due_reminders(&state.db.lock().unwrap(), Utc::now())?;
    let count = reminders.len();
    for reminder in reminders {
        let body = reminder_body(
            settings.show_titles,
            state.locked.load(Ordering::Acquire),
            &reminder.title,
        );
        app.notification()
            .builder()
            .title("Student Center reminder")
            .body(body)
            .extra("blockId", &reminder.block_id)
            .show()
            .map_err(|error| AppError::Background(error.to_string()))?;
    }
    Ok(count)
}

fn reminder_body(show_titles: bool, locked: bool, title: &str) -> String {
    if show_titles && !locked {
        format!("{title} starts soon. Open Student Center for Start, Complete, or Snooze.")
    } else {
        "A planned focus block starts soon. Open Student Center to review it.".to_string()
    }
}

fn start_reminder_worker<R: tauri::Runtime>(app: tauri::AppHandle<R>, state: AppState) {
    std::thread::spawn(move || loop {
        let _ = run_reminder_tick(&app, &state);
        std::thread::sleep(StdDuration::from_secs(30));
    });
}

fn parse_navigation_target(raw: &str) -> Option<NavigationTarget> {
    let url = url::Url::parse(raw).ok()?;
    if url.scheme() != "studentcenter"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let host = url.host_str()?;
    let segments = if url.path().is_empty() {
        Vec::new()
    } else {
        url.path_segments()?
            .filter(|segment| !segment.is_empty())
            .collect::<Vec<_>>()
    };
    match (host, segments.as_slice()) {
        ("my-day", []) => Some(NavigationTarget::MyDay),
        ("plan", ["block", block_id])
            if (1..=64).contains(&block_id.len())
                && block_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') =>
        {
            Some(NavigationTarget::PlanBlock {
                block_id: (*block_id).to_string(),
            })
        }
        _ => None,
    }
}

fn focus_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn accept_deep_link<R: tauri::Runtime>(app: &tauri::AppHandle<R>, raw: &str) -> bool {
    if auth::is_google_callback_url(raw) {
        focus_main_window(app);
        let Some(state) = app.try_state::<AppState>() else {
            return false;
        };
        if state.locked.load(Ordering::Acquire) {
            state
                .account
                .lock()
                .unwrap()
                .cancel_google_sign_in("Unlock Student Center, then start Google sign-in again.");
            return true;
        }
        let callback = raw.to_string();
        let callback_app = app.clone();
        let callback_state = state.inner().clone();
        std::thread::spawn(move || {
            let _ = callback_state
                .account
                .lock()
                .unwrap()
                .complete_google_sign_in(&callback);
            let _ = callback_app.emit("studentcenter:account-changed", ());
        });
        return true;
    }
    let Some(target) = parse_navigation_target(raw) else {
        return false;
    };
    if let Some(state) = app.try_state::<AppState>() {
        *state.pending_navigation.lock().unwrap() = Some(target.clone());
        if !state.locked.load(Ordering::Acquire) {
            let _ = app.emit("studentcenter:navigate", target);
        }
    }
    focus_main_window(app);
    true
}

fn validate_updater_configuration(endpoint: &str, public_key: &str) -> Option<url::Url> {
    if public_key.trim().len() < 32 {
        return None;
    }
    let endpoint = url::Url::parse(endpoint.trim()).ok()?;
    (endpoint.scheme() == "https"
        && endpoint.host_str().is_some()
        && endpoint.username().is_empty()
        && endpoint.password().is_none()
        && endpoint.fragment().is_none())
    .then_some(endpoint)
}

fn compiled_updater_configuration() -> Option<(url::Url, &'static str)> {
    let endpoint = option_env!("STUDENT_CENTER_UPDATER_ENDPOINT")?;
    let public_key = option_env!("STUDENT_CENTER_UPDATER_PUBLIC_KEY")?;
    validate_updater_configuration(endpoint, public_key).map(|endpoint| (endpoint, public_key))
}

fn updater_status<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> UpdateStatus {
    let configured = compiled_updater_configuration().is_some();
    UpdateStatus {
        configured,
        current_version: app.package_info().version.to_string(),
        available: false,
        latest_version: None,
        notes: None,
        checked_at: None,
        message: if configured {
            "Signed private-beta update checks are ready.".into()
        } else {
            "This development build has no release update channel configured.".into()
        },
    }
}

fn parse_utc(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.with_timezone(&Utc))
}

fn rotation_week_matches(term_start:NaiveDate,date:NaiveDate,interval:i64,offset:i64)->bool{interval>0&&date.signed_duration_since(term_start).num_days().div_euclid(7).rem_euclid(interval)==offset}

fn planner_snapshot(
    conn: &Connection,
    effective: DateTime<Utc>,
    trigger: planner::PlannerTrigger,
) -> Result<planner::PlannerSnapshot> {
    let workspace = profile::workspace(conn)?;
    let profile = workspace
        .profile
        .ok_or_else(|| AppError::Invalid("complete onboarding before creating a plan".into()))?;
    let preferences = workspace
        .preferences
        .ok_or_else(|| AppError::Invalid("planning preferences are missing".into()))?;
    let mut fixed_constraints = workspace
        .commitments
        .iter()
        .map(|commitment| {
            let starts_at = parse_utc(&commitment.starts_at).ok_or_else(|| {
                AppError::Invalid(format!(
                    "commitment '{}' has an invalid start",
                    commitment.title
                ))
            })?;
            let ends_at = parse_utc(&commitment.ends_at).ok_or_else(|| {
                AppError::Invalid(format!(
                    "commitment '{}' has an invalid end",
                    commitment.title
                ))
            })?;
            Ok(planner::FixedConstraint {
                id: commitment.id.clone(),
                title: commitment.title.clone(),
                starts_at,
                ends_at,
                location: commitment.location.clone(),
                travel_before_minutes: commitment.travel_before_minutes,
                travel_after_minutes: commitment.travel_after_minutes,
                transition_before_minutes: preferences.transition_minutes,
                transition_after_minutes: preferences.transition_minutes,
                kind: commitment.kind.clone(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let planner_tz: Tz = profile
        .timezone
        .parse()
        .map_err(|_| AppError::Invalid("profile timezone is invalid".into()))?;
    let horizon_end = effective + Duration::days(14);
    for meeting in &workspace.class_meetings {
        let timezone: Tz = meeting
            .timezone
            .parse()
            .map_err(|_| AppError::Invalid("class meeting timezone is invalid".into()))?;
        let Some(term) = workspace
            .terms
            .iter()
            .find(|term| term.id == meeting.term_id)
        else {
            continue;
        };
        let term_start = NaiveDate::parse_from_str(&term.starts_on, "%Y-%m-%d")
            .map_err(|_| AppError::Invalid("term start date is invalid".into()))?;
        let term_end = NaiveDate::parse_from_str(&term.ends_on, "%Y-%m-%d")
            .map_err(|_| AppError::Invalid("term end date is invalid".into()))?;
        let start_time = chrono::NaiveTime::parse_from_str(&meeting.starts_at_local, "%H:%M")
            .map_err(|_| AppError::Invalid("class start time is invalid".into()))?;
        let end_time = chrono::NaiveTime::parse_from_str(&meeting.ends_at_local, "%H:%M")
            .map_err(|_| AppError::Invalid("class end time is invalid".into()))?;
        let first = effective
            .with_timezone(&timezone)
            .date_naive()
            .max(term_start);
        let last = horizon_end
            .with_timezone(&timezone)
            .date_naive()
            .min(term_end);
        let mut date = first;
        while date <= last {
            let weekday = date.weekday().num_days_from_sunday() as i64;
            if meeting.weekdays.contains(&weekday) && rotation_week_matches(term_start,date,meeting.rotation_interval_weeks,meeting.rotation_offset_weeks) {
                let starts_at = timezone
                    .from_local_datetime(&date.and_time(start_time))
                    .earliest()
                    .ok_or_else(|| {
                        AppError::Invalid("class time falls in a daylight-saving gap".into())
                    })?
                    .with_timezone(&Utc);
                let ends_at = timezone
                    .from_local_datetime(&date.and_time(end_time))
                    .latest()
                    .ok_or_else(|| {
                        AppError::Invalid("class time falls in a daylight-saving gap".into())
                    })?
                    .with_timezone(&Utc);
                if ends_at > effective && starts_at < horizon_end {
                    let course = workspace
                        .courses
                        .iter()
                        .find(|course| course.id == meeting.course_id);
                    fixed_constraints.push(planner::FixedConstraint {
                        id: format!("{}:{}", meeting.id, date),
                        title: course
                            .map(|course| course.code.as_str())
                            .filter(|value| !value.is_empty())
                            .unwrap_or_else(|| {
                                course
                                    .map(|course| course.title.as_str())
                                    .unwrap_or("Class")
                            })
                            .to_string(),
                        starts_at,
                        ends_at,
                        location: meeting.location.clone(),
                        travel_before_minutes: preferences.default_commute_minutes,
                        travel_after_minutes: preferences.default_commute_minutes,
                        transition_before_minutes: preferences.transition_minutes,
                        transition_after_minutes: preferences.transition_minutes,
                        kind: "class".into(),
                    });
                }
            }
            date += Duration::days(1);
        }
    }
    for event in workspace
        .academic_events
        .iter()
        .filter(|event| event.no_class)
    {
        let start = NaiveDate::parse_from_str(&event.starts_on, "%Y-%m-%d")
            .map_err(|_| AppError::Invalid("academic event start is invalid".into()))?;
        let end = NaiveDate::parse_from_str(&event.ends_on, "%Y-%m-%d")
            .map_err(|_| AppError::Invalid("academic event end is invalid".into()))?
            + Duration::days(1);
        let starts_at = planner_tz
            .from_local_datetime(&start.and_hms_opt(0, 0, 0).unwrap())
            .earliest()
            .ok_or_else(|| AppError::Invalid("academic event start is invalid".into()))?
            .with_timezone(&Utc);
        let ends_at = planner_tz
            .from_local_datetime(&end.and_hms_opt(0, 0, 0).unwrap())
            .latest()
            .ok_or_else(|| AppError::Invalid("academic event end is invalid".into()))?
            .with_timezone(&Utc);
        if ends_at > effective && starts_at < horizon_end {
            fixed_constraints.push(planner::FixedConstraint {
                id: event.id.clone(),
                title: event.title.clone(),
                starts_at,
                ends_at,
                location: String::new(),
                travel_before_minutes: 0,
                travel_after_minutes: 0,
                transition_before_minutes: 0,
                transition_after_minutes: 0,
                kind: "protected".into(),
            });
        }
    }
    fixed_constraints.sort_by_key(|item| (item.starts_at, item.ends_at, item.id.clone()));
    let tasks = workspace
        .tasks
        .iter()
        .map(|task| {
            let parse_optional = |value: &Option<String>, field: &str| {
                value
                    .as_deref()
                    .map(|value| {
                        parse_utc(value).ok_or_else(|| {
                            AppError::Invalid(format!(
                                "task '{}' has an invalid {field}",
                                task.title
                            ))
                        })
                    })
                    .transpose()
            };
            Ok(planner::PlannerTask {
                id: task.id.clone(),
                title: task.title.clone(),
                course_id: task.course_id.clone(),
                duration_minutes: task.minutes,
                due_at: parse_optional(&task.due_at, "deadline")?,
                earliest_start: parse_optional(&task.earliest_start, "earliest start")?,
                priority: task.priority,
                academic_risk: task.academic_risk,
                energy_demand: task.energy_demand.clone(),
                location: task.location.clone(),
                splittable: task.splittable,
                min_session_minutes: task.min_session_minutes,
                max_session_minutes: task.max_session_minutes,
                dependencies: task.dependencies.clone(),
                completed: task.completed,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let existing_blocks = {
        let mut query = conn.prepare(
            "SELECT p.id,p.task_id,p.starts_at,p.ends_at,p.completed,p.locked,p.location,t.course_id
             FROM plan_blocks p JOIN tasks t ON t.id=p.task_id
             WHERE p.task_id IS NOT NULL ORDER BY datetime(p.starts_at),p.id",
        )?;
        let rows = query
            .query_map([], |row| {
                let starts_at: String = row.get(2)?;
                let ends_at: String = row.get(3)?;
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    starts_at,
                    ends_at,
                    row.get::<_, i64>(4)? != 0,
                    row.get::<_, i64>(5)? != 0,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(
                |(id, task_id, starts_at, ends_at, completed, locked, location, course_id)| {
                    Ok(planner::ExistingBlock {
                        id,
                        task_id,
                        starts_at: parse_utc(&starts_at).ok_or_else(|| {
                            AppError::Invalid("stored plan start is invalid".into())
                        })?,
                        ends_at: parse_utc(&ends_at).ok_or_else(|| {
                            AppError::Invalid("stored plan end is invalid".into())
                        })?,
                        completed,
                        locked,
                        location,
                        course_id,
                    })
                },
            )
            .collect::<Result<Vec<_>>>()?
    };
    Ok(planner::PlannerSnapshot {
        generated_at: effective,
        effective_time: effective,
        horizon_days: 14,
        timezone: profile.timezone,
        preferences: planner::PlannerPreferences {
            sleep_start: preferences.sleep_start,
            sleep_end: preferences.sleep_end,
            max_session_minutes: preferences.max_session_minutes,
            min_session_minutes: 20,
            break_minutes: preferences.break_minutes,
            transition_minutes: preferences.transition_minutes,
            availability: workspace
                .availability
                .into_iter()
                .map(|rule| planner::AvailabilityRule {
                    weekday: rule.weekday as u32,
                    starts_at_local: rule.starts_at_local,
                    ends_at_local: rule.ends_at_local,
                })
                .collect(),
        },
        fixed_constraints,
        tasks,
        existing_blocks,
        trigger,
    })
}

fn regenerate_plan_for_trigger(
    conn: &Connection,
    effective: Option<DateTime<Local>>,
    trigger: planner::PlannerTrigger,
) -> Result<planner::PlanOutcome> {
    let effective = effective
        .map(|value| value.with_timezone(&Utc))
        .unwrap_or_else(Utc::now);
    let snapshot = planner_snapshot(conn, effective, trigger)?;
    let outcome = planner::generate(&snapshot).map_err(AppError::Invalid)?;
    let tx = conn.unchecked_transaction()?;
    let now = Utc::now().to_rfc3339();
    tx.execute(
        "UPDATE source_conflicts SET resolved=1,resolved_at=?1,resolution='capacity_recomputed'
         WHERE kind='overload' AND resolved=0",
        params![now],
    )?;
    tx.execute(
        "DELETE FROM plan_blocks
         WHERE task_id IS NOT NULL AND locked=0 AND completed=0
           AND datetime(starts_at)>=datetime(?1)",
        params![snapshot.effective_time.to_rfc3339()],
    )?;
    tx.execute(
        "DELETE FROM plan_blocks
         WHERE task_id IS NULL AND id NOT IN (SELECT id FROM commitments)",
        [],
    )?;
    for commitment in &snapshot.fixed_constraints {
        tx.execute(
            "INSERT INTO plan_blocks(
               id,task_id,starts_at,ends_at,title,kind,completed,locked,started_at,
               session_index,location,reason_codes
             ) VALUES(?1,NULL,?2,?3,?4,?5,0,1,NULL,0,?6,'[\"fixed_commitment\"]')
             ON CONFLICT(id) DO UPDATE SET starts_at=excluded.starts_at,ends_at=excluded.ends_at,
               title=excluded.title,kind=excluded.kind,locked=1,location=excluded.location,
               reason_codes=excluded.reason_codes",
            params![
                commitment.id,
                commitment.starts_at.to_rfc3339(),
                commitment.ends_at.to_rfc3339(),
                commitment.title,
                commitment.kind,
                commitment.location,
            ],
        )?;
    }
    for block in &outcome.blocks {
        tx.execute(
            "INSERT INTO plan_blocks(
               id,task_id,starts_at,ends_at,title,kind,completed,locked,started_at,
               session_index,location,reason_codes
             ) VALUES(?1,?2,?3,?4,?5,'study',0,0,NULL,?6,?7,?8)
             ON CONFLICT(id) DO UPDATE SET task_id=excluded.task_id,starts_at=excluded.starts_at,
               ends_at=excluded.ends_at,title=excluded.title,kind='study',session_index=excluded.session_index,
               location=excluded.location,reason_codes=excluded.reason_codes",
            params![
                block.id,
                block.task_id,
                block.starts_at.to_rfc3339(),
                block.ends_at.to_rfc3339(),
                block.title,
                block.session_index,
                block.location,
                serde_json::to_string(&block.reason_codes)
                    .map_err(|error| AppError::Background(error.to_string()))?,
            ],
        )?;
    }
    for conflict in &outcome.overload_conflicts {
        tx.execute(
            "INSERT INTO source_conflicts(
               id,description,resolved,kind,entity_type,entity_id,detected_at
             ) VALUES(?1,?2,0,'overload','task',?3,?4)
             ON CONFLICT(id) DO UPDATE SET description=excluded.description,resolved=0,
               entity_type='task',entity_id=excluded.entity_id,detected_at=excluded.detected_at,
               resolved_at=NULL,resolution=NULL",
            params![
                format!("overload-{}", conflict.task_id),
                format!(
                    "{} has {} unscheduled minute{} ({})",
                    conflict.title,
                    conflict.unscheduled_minutes,
                    if conflict.unscheduled_minutes == 1 {
                        ""
                    } else {
                        "s"
                    },
                    conflict.reason_codes.join(", ")
                ),
                conflict.task_id,
                now,
            ],
        )?;
    }
    tx.execute(
        "INSERT INTO settings(key,value) VALUES('plan_capacity',?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![serde_json::to_string(&outcome.capacity)
            .map_err(|error| AppError::Background(error.to_string()))?],
    )?;
    tx.commit()?;
    Ok(outcome)
}

fn regenerate_plan(conn: &Connection, effective: Option<DateTime<Local>>) -> Result<()> {
    if profile::onboarding_state(conn)?.required {
        return Ok(());
    }
    regenerate_plan_for_trigger(conn, effective, planner::PlannerTrigger::Initial).map(|_| ())
}

fn dashboard(conn: &Connection, ocr: &OcrRuntime) -> Result<Dashboard> {
    dashboard_with_notice(conn, ocr, None)
}

fn dashboard_with_notice(
    conn: &Connection,
    ocr: &OcrRuntime,
    import_notice: Option<String>,
) -> Result<Dashboard> {
    let setting = |key: &str| {
        conn.query_row(
            "SELECT value FROM settings WHERE key=?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_default()
    };
    let timezone: Tz = setting("timezone").parse().unwrap_or(chrono_tz::UTC);
    let today = Utc::now().with_timezone(&timezone).date_naive();
    let day_start = timezone
        .with_ymd_and_hms(today.year(), today.month(), today.day(), 0, 0, 0)
        .earliest()
        .ok_or_else(|| AppError::Invalid("today does not have a valid local midnight".into()))?
        .with_timezone(&Utc);
    let day_end = day_start + Duration::days(1);
    let mut query = conn.prepare(
        "SELECT id,task_id,starts_at,ends_at,title,kind,completed,locked,started_at,
                session_index,location,reason_codes
     FROM plan_blocks
     WHERE datetime(starts_at)>=datetime(?1) AND datetime(starts_at)<datetime(?2)
     ORDER BY datetime(starts_at),id",
    )?;
    let blocks = query
        .query_map(
            params![day_start.to_rfc3339(), day_end.to_rfc3339()],
            |row| {
                let raw: String = row.get(11)?;
                Ok(PlanBlock {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    starts_at: row.get(2)?,
                    ends_at: row.get(3)?,
                    title: row.get(4)?,
                    kind: row.get(5)?,
                    completed: row.get::<_, i64>(6)? != 0,
                    locked: row.get::<_, i64>(7)? != 0,
                    started_at: row.get(8)?,
                    session_index: row.get(9)?,
                    location: row.get(10)?,
                    reason_codes: serde_json::from_str(&raw).unwrap_or_default(),
                })
            },
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut candidate_query = conn.prepare(
    "SELECT id,document_id,kind,title,course,due_at,starts_at,ends_at,duration_minutes,evidence,source_locator,source_type,source_url,confidence,warnings,status,
            weekdays,starts_at_local,ends_at_local,timezone,section_number,location,modality,student_edited_fields,term_id,
            CASE WHEN ic.source_uid!='' AND (
              (ic.kind='task' AND EXISTS(SELECT 1 FROM tasks t WHERE t.source_uid=ic.source_uid)) OR
              (ic.kind='commitment' AND EXISTS(SELECT 1 FROM commitments c WHERE c.source_uid=ic.source_uid)) OR
              (ic.kind='course' AND EXISTS(SELECT 1 FROM courses c WHERE c.source_uid=ic.source_uid)) OR
              (ic.kind='class_meeting' AND EXISTS(SELECT 1 FROM class_meeting_series m WHERE m.source_uid=ic.source_uid))
            ) THEN 'update' ELSE 'add' END
     FROM import_candidates ic ORDER BY status,confidence DESC",
  )?;
    let candidates = candidate_query
        .query_map([], |row| {
            let warnings: String = row.get(14)?;
            Ok(Candidate {
                id: row.get(0)?,
                document_id: row.get(1)?,
                kind: row.get(2)?, title: row.get(3)?, course: row.get(4)?, due_at: row.get(5)?, starts_at: row.get(6)?, ends_at: row.get(7)?, duration_minutes: row.get(8)?, evidence: row.get(9)?, source_locator: row.get(10)?, source_type: row.get(11)?, source_url: row.get(12)?, confidence: row.get(13)?,
                warnings: serde_json::from_str(&warnings).unwrap_or_default(),
                status: row.get(15)?, weekdays: serde_json::from_str(&row.get::<_, String>(16)?).unwrap_or_default(), starts_at_local: row.get(17)?, ends_at_local: row.get(18)?, timezone: row.get(19)?,
                section_number: row.get(20)?, location: row.get(21)?, modality: row.get(22)?, student_edited_fields: serde_json::from_str(&row.get::<_, String>(23)?).unwrap_or_default(), term_id:row.get(24)?, suggested_action:row.get(25)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let conflicts = {
        let mut conflict_query = conn.prepare(
            "SELECT id,kind,description,candidate_id,entity_type,entity_id,
                    current_due_at,proposed_due_at,current_starts_at,proposed_starts_at,
                    current_ends_at,proposed_ends_at,detected_at
             FROM source_conflicts WHERE resolved=0 ORDER BY detected_at,id",
        )?;
        let rows = conflict_query
            .query_map([], |row| {
                Ok(SourceConflictSummary {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    description: row.get(2)?,
                    candidate_id: row.get(3)?,
                    entity_type: row.get(4)?,
                    entity_id: row.get(5)?,
                    current_due_at: row.get(6)?,
                    proposed_due_at: row.get(7)?,
                    current_starts_at: row.get(8)?,
                    proposed_starts_at: row.get(9)?,
                    current_ends_at: row.get(10)?,
                    proposed_ends_at: row.get(11)?,
                    detected_at: row.get(12)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    let canvas_connections = {
        let mut connection_query = conn.prepare(
            "SELECT c.id,c.provider,c.base_url,c.account_name,c.status,c.last_synced_at,c.last_error,
             (SELECT COUNT(*) FROM import_candidates ic JOIN source_objects so ON so.id=ic.source_object_id WHERE so.connection_id=c.id AND ic.status='pending')
             ,c.refresh_on_startup,c.last_attempted_at
             FROM integration_connections c WHERE c.provider IN ('canvas','canvas_calendar') ORDER BY c.created_at,c.id",
        )?;
        let connections = connection_query
            .query_map([], |row| {
                let last_attempted_at: Option<String> = row.get(9)?;
                Ok(CanvasConnectionSummary {
                    id: row.get(0)?,
                    provider: row.get(1)?,
                    base_url: row.get(2)?,
                    account_name: row.get(3)?,
                    status: row.get(4)?,
                    last_synced_at: row.get(5)?,
                    last_error: row.get(6)?,
                    refresh_on_startup: row.get::<_, i64>(8)? != 0,
                    next_eligible_refresh_at: last_attempted_at.as_deref().and_then(parse_utc).map(|value| (value + chrono::Duration::hours(24)).to_rfc3339()),
                    pending_candidates: row.get(7)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        connections
    };
    let canvas_sync_runs = {
        let mut run_query = conn.prepare(
            "SELECT r.id,r.connection_id,r.started_at,r.completed_at,r.status,r.pulled_count,r.created_count,r.error
             FROM integration_sync_runs r JOIN integration_connections c ON c.id=r.connection_id
             WHERE c.provider IN ('canvas','canvas_calendar') ORDER BY r.started_at DESC,r.id DESC LIMIT 20",
        )?;
        let runs = run_query
            .query_map([], |row| {
                Ok(CanvasSyncRunSummary {
                    id: row.get(0)?,
                    connection_id: row.get(1)?,
                    started_at: row.get(2)?,
                    completed_at: row.get(3)?,
                    status: row.get(4)?,
                    pulled_count: row.get(5)?,
                    created_count: row.get(6)?,
                    error: row.get(7)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        runs
    };
    let now = Utc::now();
    let next_action = planner_snapshot(conn, now, planner::PlannerTrigger::Initial)
        .ok()
        .and_then(|snapshot| {
            let planned = blocks
                .iter()
                .filter_map(|block| {
                    Some(planner::PlannedBlock {
                        id: block.id.clone(),
                        task_id: block.task_id.clone()?,
                        session_index: block.session_index,
                        title: block.title.clone(),
                        starts_at: parse_utc(&block.starts_at)?,
                        ends_at: parse_utc(&block.ends_at)?,
                        location: block.location.clone(),
                        reason_codes: block.reason_codes.clone(),
                    })
                })
                .collect();
            let outcome = planner::PlanOutcome {
                blocks: planned,
                overload_conflicts: Vec::new(),
                capacity: planner::CapacitySummary {
                    available_minutes: 0,
                    fixed_minutes: 0,
                    planned_minutes: 0,
                    overload_minutes: 0,
                },
            };
            planner::rank_next_action(&snapshot, &outcome, now, None, 24 * 60, false).map(
                |ranked| NextAction {
                    block_id: ranked.action.block_id,
                    task_id: ranked.action.task_id,
                    title: ranked.action.concrete_action,
                    duration_minutes: ranked.action.duration_minutes,
                    explanation: format!(
                        "Recommended now because {}.",
                        ranked.action.reason_codes.join(", ").replace('_', " ")
                    ),
                    reason_codes: ranked.action.reason_codes,
                    alternatives: ranked
                        .alternatives
                        .into_iter()
                        .map(|alternative| NextActionAlternative {
                            block_id: alternative.block_id,
                            task_id: alternative.task_id,
                            title: alternative.concrete_action,
                            duration_minutes: alternative.duration_minutes,
                            reason_codes: alternative.reason_codes,
                        })
                        .collect(),
                    valid_from: ranked.valid_from.to_rfc3339(),
                    valid_until: ranked.valid_until.to_rfc3339(),
                },
            )
        });
    let unsettled_schedule_sources = {
        let mut query = conn.prepare(
            "SELECT d.id FROM documents d
             WHERE d.source_retention='ask' AND d.vault_path!=''
             ORDER BY d.imported_at,d.id",
        )?;
        let values = query
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        values
    };
    Ok(Dashboard {
        student_name: setting("student_name"),
        timezone: setting("timezone"),
        offline: true,
        plan_date: today.to_string(),
        blocks,
        candidates,
        canvas_connections,
        canvas_sync_runs,
        next_action,
        notification_settings: notification_settings_from_db(conn, true),
        conflicts,
        ocr: ocr.status(),
        import_notice,
        unsettled_schedule_sources,
    })
}

fn bootstrap(state: &AppState) -> Result<AppBootstrap> {
    let security = current_security_status(state);
    if security.locked {
        return Ok(AppBootstrap {
            security,
            schema_version: CURRENT_SCHEMA_VERSION,
            onboarding: None,
            dashboard: None,
        });
    }
    let conn = state.db.lock().unwrap();
    bootstrap_locked(state, &conn, security)
}

/// Builds the bootstrap payload from a connection the caller already holds, so a
/// write followed by a read cannot interleave with the background workers.
fn bootstrap_locked(
    state: &AppState,
    conn: &Connection,
    security: SecurityStatus,
) -> Result<AppBootstrap> {
    let schema_version = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let onboarding = profile::onboarding_state(conn)?;
    let dashboard = if onboarding.required {
        None
    } else {
        Some(dashboard(conn, &state.ocr)?)
    };
    Ok(AppBootstrap {
        security,
        schema_version,
        onboarding: Some(onboarding),
        dashboard,
    })
}

#[tauri::command]
async fn app_initialize(state: tauri::State<'_, AppState>) -> Result<AppBootstrap> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || bootstrap(&state))
        .await
        .map_err(|error| AppError::Invalid(error.to_string()))?
}

#[tauri::command]
async fn unlock_with_pin(
    state: tauri::State<'_, AppState>,
    pin_value: String,
) -> Result<AppBootstrap> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !pin::is_enabled(&state.root) {
            state.locked.store(false, Ordering::Release);
            return bootstrap(&state);
        }
        let pin_value = Zeroizing::new(pin_value);
        let envelope = pin::read(&state.root)?;
        // Keep the attempt lock through Argon2 verification so concurrent webview
        // invocations cannot bypass the backoff by starting in parallel.
        let mut attempts = state.pin_attempts.lock().unwrap();
        let retry_after = attempts.retry_after_seconds();
        if retry_after > 0 {
            return Err(AppError::Invalid(format!(
                "Try again in {retry_after} second{}",
                if retry_after == 1 { "" } else { "s" }
            )));
        }
        if !pin::verify(&envelope, &pin_value, &state.master_key)? {
            let retry_after = attempts.record_failure();
            return Err(AppError::Invalid(format!(
                "Incorrect PIN. Try again in {retry_after} second{}",
                if retry_after == 1 { "" } else { "s" }
            )));
        }
        attempts.reset();
        drop(attempts);
        state.locked.store(false, Ordering::Release);
        bootstrap(&state)
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

#[tauri::command]
async fn enable_pin(state: tauri::State<'_, AppState>, new_pin: String) -> Result<SecurityStatus> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.require_unlocked()?;
        if pin::is_enabled(&state.root) {
            return Err(AppError::Invalid(
                "A Student Center PIN is already enabled".into(),
            ));
        }
        let new_pin = Zeroizing::new(new_pin);
        let envelope = pin::create(&new_pin, &state.master_key)?;
        pin::write_atomic(&state.root, &envelope)?;
        Ok(current_security_status(&state))
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

#[tauri::command]
async fn change_pin(
    state: tauri::State<'_, AppState>,
    current_pin: String,
    new_pin: String,
) -> Result<SecurityStatus> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.require_unlocked()?;
        let current_pin = Zeroizing::new(current_pin);
        let existing = pin::read(&state.root)?;
        if !pin::verify(&existing, &current_pin, &state.master_key)? {
            return Err(AppError::Invalid("Current PIN is incorrect".into()));
        }
        let new_pin = Zeroizing::new(new_pin);
        let replacement = pin::create(&new_pin, &state.master_key)?;
        pin::write_atomic(&state.root, &replacement)?;
        state.pin_attempts.lock().unwrap().reset();
        Ok(current_security_status(&state))
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

#[tauri::command]
async fn disable_pin(
    state: tauri::State<'_, AppState>,
    current_pin: String,
) -> Result<SecurityStatus> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.require_unlocked()?;
        let current_pin = Zeroizing::new(current_pin);
        let existing = pin::read(&state.root)?;
        if !pin::verify(&existing, &current_pin, &state.master_key)? {
            return Err(AppError::Invalid("Current PIN is incorrect".into()));
        }
        pin::remove(&state.root)?;
        state.pin_attempts.lock().unwrap().reset();
        state.locked.store(false, Ordering::Release);
        Ok(current_security_status(&state))
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

#[tauri::command]
fn lock_app(state: tauri::State<AppState>) -> Result<SecurityStatus> {
    state.require_unlocked()?;
    if !pin::is_enabled(&state.root) {
        return Err(AppError::Invalid(
            "Enable a Student Center PIN before locking".into(),
        ));
    }
    state.locked.store(true, Ordering::Release);
    Ok(current_security_status(&state))
}

#[tauri::command]
async fn get_dashboard(state: tauri::State<'_, AppState>) -> Result<Dashboard> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = state.db.lock().unwrap();
        if profile::onboarding_state(&conn)?.required {
            return Err(AppError::Invalid(
                "Complete local onboarding before opening My Day".into(),
            ));
        }
        dashboard(&conn, &state.ocr)
    })
    .await
    .map_err(|error| AppError::Invalid(error.to_string()))?
}

fn calendar_agenda(conn: &Connection, start_date: Option<&str>) -> Result<CalendarAgenda> {
    require_onboarded(conn)?;
    let timezone_name = db_setting(conn, "timezone", "UTC");
    let timezone: Tz = timezone_name
        .parse()
        .map_err(|_| AppError::Invalid("stored profile timezone is invalid".into()))?;
    let date = start_date
        .map(|value| {
            NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .map_err(|_| AppError::Invalid("calendar start date must be YYYY-MM-DD".into()))
        })
        .transpose()?
        .unwrap_or_else(|| Utc::now().with_timezone(&timezone).date_naive());
    let starts_at = timezone
        .with_ymd_and_hms(date.year(), date.month(), date.day(), 0, 0, 0)
        .earliest()
        .ok_or_else(|| AppError::Invalid("calendar start has no valid local midnight".into()))?
        .with_timezone(&Utc);
    let end_date = date + Duration::days(7);
    let ends_at = timezone
        .with_ymd_and_hms(end_date.year(), end_date.month(), end_date.day(), 0, 0, 0)
        .latest()
        .ok_or_else(|| AppError::Invalid("calendar end has no valid local midnight".into()))?
        .with_timezone(&Utc);
    let mut query = conn.prepare(
        "SELECT id,task_id,starts_at,ends_at,title,kind,completed,locked,started_at,
                session_index,location,reason_codes
         FROM plan_blocks
         WHERE datetime(ends_at)>datetime(?1) AND datetime(starts_at)<datetime(?2)
         ORDER BY datetime(starts_at),id",
    )?;
    let blocks = query
        .query_map(
            params![starts_at.to_rfc3339(), ends_at.to_rfc3339()],
            |row| {
                let raw: String = row.get(11)?;
                Ok(PlanBlock {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    starts_at: row.get(2)?,
                    ends_at: row.get(3)?,
                    title: row.get(4)?,
                    kind: row.get(5)?,
                    completed: row.get::<_, i64>(6)? != 0,
                    locked: row.get::<_, i64>(7)? != 0,
                    started_at: row.get(8)?,
                    session_index: row.get(9)?,
                    location: row.get(10)?,
                    reason_codes: serde_json::from_str(&raw).unwrap_or_default(),
                })
            },
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut conflict_query = conn.prepare(
        "SELECT id,kind,description,candidate_id,entity_type,entity_id,
                current_due_at,proposed_due_at,current_starts_at,proposed_starts_at,
                current_ends_at,proposed_ends_at,detected_at
         FROM source_conflicts WHERE resolved=0 AND kind='overload'
         ORDER BY detected_at,id",
    )?;
    let overload_conflicts = conflict_query
        .query_map([], |row| {
            Ok(SourceConflictSummary {
                id: row.get(0)?,
                kind: row.get(1)?,
                description: row.get(2)?,
                candidate_id: row.get(3)?,
                entity_type: row.get(4)?,
                entity_id: row.get(5)?,
                current_due_at: row.get(6)?,
                proposed_due_at: row.get(7)?,
                current_starts_at: row.get(8)?,
                proposed_starts_at: row.get(9)?,
                current_ends_at: row.get(10)?,
                proposed_ends_at: row.get(11)?,
                detected_at: row.get(12)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(CalendarAgenda {
        timezone: timezone_name,
        starts_at: starts_at.to_rfc3339(),
        ends_at: ends_at.to_rfc3339(),
        blocks,
        overload_conflicts,
    })
}

#[tauri::command]
fn get_calendar_agenda(
    state: tauri::State<AppState>,
    start_date: Option<String>,
) -> Result<CalendarAgenda> {
    state.require_unlocked()?;
    calendar_agenda(&state.db.lock().unwrap(), start_date.as_deref())
}

#[tauri::command]
fn set_plan_block_lock(
    state: tauri::State<AppState>,
    block_id: String,
    locked: bool,
) -> Result<Dashboard> {
    state.require_unlocked()?;
    let conn = state.db.lock().unwrap();
    require_onboarded(&conn)?;
    let changed = conn.execute(
        "UPDATE plan_blocks SET locked=?2
         WHERE id=?1 AND task_id IS NOT NULL AND completed=0
           AND datetime(ends_at)>datetime(?3)",
        params![block_id, locked, Utc::now().to_rfc3339()],
    )?;
    if changed == 0 {
        return Err(AppError::Invalid(
            "only an unfinished future study block can be locked".into(),
        ));
    }
    mutation(
        &conn,
        "plan_block",
        &block_id,
        if locked { "locked" } else { "unlocked" },
        "{}",
    )?;
    regenerate_plan_for_trigger(&conn, None, planner::PlannerTrigger::PreferenceChanged)?;
    dashboard(&conn, &state.ocr)
}

#[derive(Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
struct CalendarUndo { block_id:String,starts_at:String,ends_at:String,locked:bool }

#[tauri::command]
fn move_plan_block(state:tauri::State<AppState>,block_id:String,starts_at:String,ends_at:String)->Result<Dashboard>{
    state.require_unlocked()?;let starts=parse_utc(&starts_at).ok_or_else(||AppError::Invalid("calendar start is invalid".into()))?;let ends=parse_utc(&ends_at).ok_or_else(||AppError::Invalid("calendar end is invalid".into()))?;let minutes=(ends-starts).num_minutes();if starts<Utc::now()-chrono::Duration::minutes(1)||!(5..=480).contains(&minutes){return Err(AppError::Invalid("calendar block must be 5–480 minutes in the future".into()));}
    let conn=state.db.lock().unwrap();require_onboarded(&conn)?;let previous=conn.query_row("SELECT starts_at,ends_at,locked FROM plan_blocks WHERE id=?1 AND task_id IS NOT NULL AND completed=0",params![block_id],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,i64>(2)?!=0))).optional()?.ok_or_else(||AppError::Invalid("only unfinished study blocks can be moved".into()))?;
    let overlaps=conn.query_row("SELECT EXISTS(SELECT 1 FROM plan_blocks WHERE id!=?1 AND completed=0 AND datetime(starts_at)<datetime(?3) AND datetime(ends_at)>datetime(?2))",params![block_id,starts_at,ends_at],|row|row.get::<_,i64>(0))?!=0;if overlaps{return Err(AppError::Invalid("that time overlaps another class, commitment, or study block".into()));}
    let undo=CalendarUndo{block_id:block_id.clone(),starts_at:previous.0,ends_at:previous.1,locked:previous.2};conn.execute("INSERT INTO settings(key,value) VALUES('calendar_undo',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![serde_json::to_string(&undo).map_err(|error|AppError::Background(error.to_string()))?])?;conn.execute("UPDATE plan_blocks SET starts_at=?2,ends_at=?3,locked=1,reason_codes='[\"manual_calendar_move\"]' WHERE id=?1",params![block_id,starts.to_rfc3339(),ends.to_rfc3339()])?;mutation(&conn,"plan_block",&block_id,"moved","{}")?;dashboard_with_notice(&conn,&state.ocr,Some("Study block moved and locked. Undo is available from Calendar.".into()))
}

#[tauri::command]
fn undo_calendar_change(state:tauri::State<AppState>)->Result<Dashboard>{state.require_unlocked()?;let conn=state.db.lock().unwrap();let raw=conn.query_row("SELECT value FROM settings WHERE key='calendar_undo'",[],|row|row.get::<_,String>(0)).optional()?.ok_or_else(||AppError::Invalid("there is no calendar change to undo".into()))?;let undo:CalendarUndo=serde_json::from_str(&raw).map_err(|_|AppError::Invalid("saved calendar undo is invalid".into()))?;let changed=conn.execute("UPDATE plan_blocks SET starts_at=?2,ends_at=?3,locked=?4 WHERE id=?1 AND completed=0",params![undo.block_id,undo.starts_at,undo.ends_at,i64::from(undo.locked)])?;if changed!=1{return Err(AppError::Invalid("the moved block is no longer available".into()));}conn.execute("DELETE FROM settings WHERE key='calendar_undo'",[])?;mutation(&conn,"plan_block",&undo.block_id,"move_undone","{}")?;dashboard_with_notice(&conn,&state.ocr,Some("Calendar change undone.".into()))}

#[tauri::command]
fn get_onboarding_state(state: tauri::State<AppState>) -> Result<profile::OnboardingState> {
    state.require_unlocked()?;
    Ok(profile::onboarding_state(&state.db.lock().unwrap())?)
}

#[tauri::command]
fn get_timezone_suggestion(state: tauri::State<AppState>) -> Result<TimezoneSuggestion> {
    state.require_unlocked()?;
    let timezone = iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".into());
    let tz: Tz = timezone.parse().unwrap_or(chrono_tz::UTC);
    let now = Utc::now().with_timezone(&tz);
    Ok(TimezoneSuggestion {
        display_name: format!(
            "{} — {} (UTC{:+})",
            timezone
                .rsplit('/')
                .next()
                .unwrap_or(&timezone)
                .replace('_', " "),
            now.format("%Z"),
            now.offset().fix().local_minus_utc() / 3600
        ),
        timezone,
        source: "operating_system".into(),
    })
}

// The bundled directory is 6,243 entries. Parsing it per keystroke dominated the
// school search, so both bundled resources are deserialized once per process.
static INSTITUTION_DIRECTORY: OnceLock<Option<Vec<InstitutionDirectoryEntry>>> = OnceLock::new();
static INSTITUTION_SETUP_PROVIDERS: OnceLock<Option<Vec<SchoolProvider>>> = OnceLock::new();
static INSTITUTION_CATALOGS: OnceLock<Option<Vec<InstitutionCatalog>>> = OnceLock::new();

/// Course lists for the schools that have one, keyed by institution.
///
/// `include_str!` is deliberate while these are hand-curated and small, matching
/// how the setup providers ship. A full term's class list is a different order of
/// magnitude and must move to `bundle.resources` + the resource directory before
/// it lands, so a student never carries every school's catalog in their binary.
fn institution_catalogs() -> Result<&'static [InstitutionCatalog]> {
    INSTITUTION_CATALOGS
        .get_or_init(|| {
            serde_json::from_str(include_str!("../resources/institution-catalogs.json")).ok()
        })
        .as_deref()
        .ok_or_else(|| AppError::Invalid("bundled course catalog is invalid".into()))
}

fn institution_catalog_for(institution_id: &str) -> Result<Option<&'static InstitutionCatalog>> {
    Ok(institution_catalogs()?
        .iter()
        .find(|catalog| catalog.institution_id == institution_id))
}

fn institution_directory() -> Result<&'static [InstitutionDirectoryEntry]> {
    INSTITUTION_DIRECTORY
        .get_or_init(|| {
            serde_json::from_str(include_str!("../resources/institutions-us.json")).ok()
        })
        .as_deref()
        .ok_or_else(|| AppError::Invalid("bundled institution directory is invalid".into()))
}

fn institution_setup_providers() -> Result<&'static [SchoolProvider]> {
    INSTITUTION_SETUP_PROVIDERS
        .get_or_init(|| {
            serde_json::from_str(include_str!(
                "../resources/institution-setup-providers.json"
            ))
            .ok()
        })
        .as_deref()
        .ok_or_else(|| AppError::Invalid("bundled institution setup providers are invalid".into()))
}

const INSTITUTION_RESULT_LIMIT: usize = 12;

/// True when `needle` appears in `haystack` starting at a word boundary.
///
/// Plain `contains` is why searching "asu" used to return "Beyond Measure
/// Barbering Institute" and "Treasure Coast Technical College" while missing
/// every Arizona State campus: "measure" contains "asu" mid-word. Anchoring to a
/// boundary keeps short acronym-shaped queries useful.
fn matches_at_word_boundary(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    haystack.match_indices(needle).any(|(index, _)| {
        index == 0
            || !haystack.as_bytes()[index - 1].is_ascii_alphanumeric()
    })
}

/// Initials of the significant words, so "asu" reaches "Arizona State
/// University" and "ucla" reaches "University of California-Los Angeles".
fn institution_acronym(name: &str) -> String {
    name.split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|word| {
            !word.is_empty()
                && !matches!(
                    word.to_ascii_lowercase().as_str(),
                    "of" | "the" | "and" | "at" | "in" | "for" | "a"
                )
        })
        .filter_map(|word| word.chars().next())
        .map(|character| character.to_ascii_lowercase())
        .collect()
}

/// Relevance score plus the campus that produced the match, if any.
///
/// Ordering by score rather than by directory order is the fix for the original
/// report: ASU has 17 directory entries, and the twelve that sort first are all
/// small satellite locations, so the main campus entry -- the only one carrying
/// campus and term presets -- was cut off before it could ever be shown.
fn score_institution(
    entry: &InstitutionDirectoryEntry,
    needle: &str,
    campuses: &[school_provider::CampusDescriptor],
) -> Option<(i32, Option<school_provider::CampusDescriptor>)> {
    if needle.is_empty() {
        return Some((0, None));
    }
    let name = entry.name.to_ascii_lowercase();
    let acronym = institution_acronym(&entry.name);

    let name_score = if name == needle {
        Some(1000)
    } else if name.starts_with(needle) {
        Some(850)
    } else if acronym == needle {
        Some(700)
    } else if acronym.starts_with(needle) {
        Some(640)
    } else if matches_at_word_boundary(&name, needle) {
        Some(560)
    } else if matches_at_word_boundary(&entry.domain.to_ascii_lowercase(), needle) {
        Some(300)
    } else {
        None
    };

    // A campus hit is worth more than a loose name hit: a student typing
    // "Tempe" means the ASU campus, not "Brookline College-Tempe".
    let campus_hit = campuses.iter().find_map(|campus| {
        let campus_name = campus.name.to_ascii_lowercase();
        let city = campus.city.to_ascii_lowercase();
        if campus_name == needle {
            Some((620, campus.clone()))
        } else if matches_at_word_boundary(&campus_name, needle) {
            Some((580, campus.clone()))
        } else if city == needle {
            Some((540, campus.clone()))
        } else {
            None
        }
    });

    let (score, campus) = match (name_score, campus_hit) {
        (Some(name), Some((campus_score, campus))) if campus_score > name => {
            (campus_score, Some(campus))
        }
        (Some(name), Some((_, campus))) => (name, Some(campus)),
        (Some(name), None) => (name, None),
        (None, Some((campus_score, campus))) => (campus_score, Some(campus)),
        (None, None) => return None,
    };

    // Entries with campus and term presets are the ones a student can actually
    // finish setup with, so they outrank branch locations that only carry a name.
    let boost = if campuses.is_empty() { 0 } else { 160 };
    Some((score + boost, campus))
}

fn search_institutions_in(query: &str) -> Result<Vec<InstitutionSearchResult>> {
    let entries = institution_directory()?;
    let providers = institution_setup_providers()?;
    let needle = query.trim().to_ascii_lowercase();
    let mut scored = entries
        .iter()
        .filter_map(|entry| {
            let campuses = providers
                .iter()
                .find(|provider| provider.institution_id == entry.id)
                .map(|provider| provider.campuses.as_slice())
                .unwrap_or(&[]);
            score_institution(entry, &needle, campuses)
                .map(|(score, campus)| (score, entry, campus))
        })
        .collect::<Vec<_>>();
    // Shorter names break ties towards the canonical entry rather than a branch
    // that merely repeats it; the name comparison keeps the order stable.
    scored.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| left.1.name.len().cmp(&right.1.name.len()))
            .then_with(|| left.1.name.cmp(&right.1.name))
    });
    let mut matches = scored
        .into_iter()
        .take(INSTITUTION_RESULT_LIMIT)
        .map(|(_, entry, campus)| InstitutionSearchResult {
            id: entry.id.clone(),
            name: entry.name.clone(),
            country: entry.country.clone(),
            source: "college_scorecard".into(),
            official_domain: entry.domain.clone(),
            catalog_provider_status: if entry.catalog {
                "supported".into()
            } else {
                "unavailable".into()
            },
            custom: false,
            matched_campus_id: campus
                .as_ref()
                .map(|campus| campus.id.clone())
                .unwrap_or_default(),
            matched_campus_name: campus
                .map(|campus| campus.name)
                .unwrap_or_default(),
        })
        .collect::<Vec<_>>();
    if !query.trim().is_empty()
        && !matches
            .iter()
            .any(|entry| entry.name.eq_ignore_ascii_case(query.trim()))
    {
        matches.push(InstitutionSearchResult {
            id: format!(
                "custom:{}",
                query.trim().to_ascii_lowercase().replace(' ', "-")
            ),
            name: query.trim().to_string(),
            country: "Other".into(),
            source: "custom".into(),
            official_domain: String::new(),
            catalog_provider_status: "local_fallback".into(),
            custom: true,
            matched_campus_id: String::new(),
            matched_campus_name: String::new(),
        });
    }
    Ok(matches)
}

#[tauri::command]
async fn search_institutions(
    state: tauri::State<'_, AppState>,
    query: String,
) -> Result<Vec<InstitutionSearchResult>> {
    state.require_unlocked()?;
    tauri::async_runtime::spawn_blocking(move || search_institutions_in(&query))
        .await
        .map_err(|error| AppError::Invalid(error.to_string()))?
}

#[tauri::command]
fn search_course_suggestions(
    state: tauri::State<AppState>,
    institution_id: String,
    query: String,
) -> Result<Vec<CourseSuggestion>> {
    state.require_unlocked()?;
    let needle = query.trim().to_ascii_uppercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let conn = state.db.lock().unwrap();
    let workspace = profile::workspace(&conn)?;
    let mut results = workspace
        .courses
        .iter()
        .filter(|course| {
            course.code.to_ascii_uppercase().contains(&needle)
                || course.title.to_ascii_uppercase().contains(&needle)
        })
        .take(5)
        .map(|course| CourseSuggestion {
            code: course.code.clone(),
            title: course.title.clone(),
            source: if course.record_origin == "import" {
                "canvas".into()
            } else {
                "local".into()
            },
            source_label: if course.record_origin == "import" {
                "Canvas".into()
            } else {
                "Previously confirmed".into()
            },
            confidence: if course.record_origin == "import" {
                1.0
            } else {
                0.96
            },
            credits: None,
            term_label: String::new(),
            staleness_warning:String::new(),
            sections: Vec::new(),
        })
        .collect::<Vec<_>>();

    // The student's own school, which this command ignored entirely until now:
    // the parameter was bound to `_institution_id` and nothing read it, so an ASU
    // student searching "CSE 240" could only ever match the generic list below.
    if let Some(catalog) = institution_catalog_for(&institution_id)? {
        let lowered = needle.to_ascii_lowercase();
        // The term presets already carry the registrar's wording for this id, so
        // the catalog does not repeat it and cannot contradict it.
        let catalog_term=institution_setup_providers()?
            .iter()
            .find(|provider| provider.institution_id == catalog.institution_id)
            .and_then(|provider| {
                provider
                    .terms
                    .iter()
                    .find(|term| term.id == catalog.term_id)
                    .cloned()
            });
        let term_label=catalog_term.as_ref().map(|term|term.name.clone()).unwrap_or_else(||catalog.term_id.clone());
        let staleness_warning=catalog_term.as_ref().and_then(|term|NaiveDate::parse_from_str(&term.ends_on,"%Y-%m-%d").ok()).filter(|ends|*ends<Utc::now().date_naive()).map(|_|format!("These sections are from {term_label}, which has ended. Verify against the current registrar listing.")).unwrap_or_default();
        for course in &catalog.courses {
            if results.len() >= 8 {
                break;
            }
            let code = course.code.to_ascii_lowercase();
            let title = course.title.to_ascii_lowercase();
            // Same boundary rule as the school search: a three-letter subject code
            // must not match the middle of an unrelated word.
            if !(matches_at_word_boundary(&code, &lowered)
                || matches_at_word_boundary(&title, &lowered))
            {
                continue;
            }
            if results
                .iter()
                .any(|item| item.code.eq_ignore_ascii_case(&course.code))
            {
                continue;
            }
            results.push(CourseSuggestion {
                code: course.code.clone(),
                title: course.title.clone(),
                source: "catalog".into(),
                source_label: if catalog.source_label.is_empty() {
                    "School catalog".into()
                } else {
                    catalog.source_label.clone()
                },
                confidence: 0.99,
                term_label: term_label.clone(),
                credits: course.credits,
                sections: course.sections.clone(),
                staleness_warning:staleness_warning.clone(),
            });
        }
    }

    let generics = [
        ("MAT 142", "College Mathematics"),
        ("MAT 151", "College Algebra"),
        ("ENG 101", "First-Year Composition"),
        ("ENG 102", "Research and Writing"),
        ("BIO 181", "General Biology I"),
        ("CHM 130", "Fundamental Chemistry"),
        ("PSY 101", "Introduction to Psychology"),
        ("SOC 101", "Introduction to Sociology"),
        ("CIS 105", "Survey of Computer Information Systems"),
        ("CSC 110", "Introduction to Computer Science"),
        ("STA 201", "Introduction to Statistics"),
    ];
    for (code, title) in generics {
        if (code.contains(&needle) || title.to_ascii_uppercase().contains(&needle))
            && !results.iter().any(|item| item.code == code)
        {
            results.push(CourseSuggestion {
                code: code.into(),
                title: title.into(),
                source: "generic".into(),
                source_label: "General course pattern".into(),
                confidence: 0.62,
                credits: None,
                term_label: String::new(),
                sections: Vec::new(),
                staleness_warning:String::new(),
            });
        }
    }
    results.truncate(8);
    Ok(results)
}

/// Project a bundled descriptor down to what the setup screen reads.
///
/// The descriptor is the richer of the two on purpose: it carries the calendar
/// and catalog sources, the schedule layouts, and per-term session codes and
/// no-class dates, none of which the setup screen asks for. Keeping the wire
/// type narrow is what lets the descriptor grow without changing this command's
/// output.
fn setup_options_from(provider: &SchoolProvider) -> InstitutionSetupOptions {
    InstitutionSetupOptions {
        institution_id: provider.institution_id.clone(),
        campuses: provider
            .campuses
            .iter()
            .map(|campus| InstitutionCampusOption {
                id: campus.id.clone(),
                name: campus.name.clone(),
                city: campus.city.clone(),
                timezone: campus.timezone.clone(),
                source_label: campus.source_label.clone(),
                source_url: campus.source_url.clone(),
            })
            .collect(),
        terms: provider
            .terms
            .iter()
            .map(|term| AcademicTermPreset {
                id: term.id.clone(),
                name: term.name.clone(),
                starts_on: term.starts_on.clone(),
                ends_on: term.ends_on.clone(),
                class_ends_on: term.class_ends_on.clone(),
                exam_starts_on: term.exam_starts_on.clone(),
                details: term.details.clone(),
                source_label: term.source_label.clone(),
                source_url: term.source_url.clone(),
                session_code: term.session_code.clone(),
                no_class_dates: term.no_class_dates.clone(),
            })
            .collect(),
        generated_at: provider.generated_at.clone(),
        source_label: provider.source_label.clone(),
        source_url: provider.source_url.clone(),
    }
}

fn institution_setup_options_for(institution_id: String) -> Result<InstitutionSetupOptions> {
    let providers = institution_setup_providers()?;
    Ok(providers
        .iter()
        .find(|provider| provider.institution_id == institution_id)
        .map(setup_options_from)
        .unwrap_or(InstitutionSetupOptions {
            institution_id,
            ..InstitutionSetupOptions::default()
        }))
}

/// The full descriptor for a school, for the paths that need more than the setup
/// screen does.
fn school_provider_for(institution_id: &str) -> Option<&'static SchoolProvider> {
    institution_setup_providers()
        .ok()?
        .iter()
        .find(|provider| provider.institution_id == institution_id)
}

/// Read a school's published academic calendar and report how it differs from
/// the bundled snapshot.
///
/// This never writes. A term date is a critical academic date, and a page that
/// changed under us is not authority to move someone's finals — the student
/// reviews the diff and decides. Failing is also fine: with no network, a
/// blocked host, or a school that publishes nothing, onboarding carries on with
/// the bundled dates exactly as it did before this command existed.
#[tauri::command]
async fn refresh_school_calendar(
    state: tauri::State<'_, AppState>,
    institution_id: String,
) -> Result<school_calendar::CalendarDiff> {
    state.require_unlocked()?;
    tauri::async_runtime::spawn_blocking(move || {
        let provider = school_provider_for(&institution_id)
            .ok_or(school_calendar::CalendarError::NoSource)
            .map_err(|error| AppError::Invalid(error.to_string()))?;
        let source = provider
            .calendar_source
            .as_ref()
            .ok_or(school_calendar::CalendarError::NoSource)
            .map_err(|error| AppError::Invalid(error.to_string()))?;
        let body = school_calendar::fetch_calendar(source)
            .map_err(|error| AppError::Invalid(error.to_string()))?;
        let entries = school_calendar::parse_calendar(&body, source)
            .map_err(|error| AppError::Invalid(error.to_string()))?;
        Ok(school_calendar::diff_calendar(
            provider,
            &entries,
            Utc::now().to_rfc3339(),
        ))
    })
    .await
    .map_err(|error| AppError::Invalid(error.to_string()))?
}

/// What a student approved out of a calendar diff.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalendarDiffApproval {
    #[serde(default)]
    term_changes: Vec<school_calendar::TermChange>,
    #[serde(default)]
    no_class_dates: Vec<school_provider::NoClassDate>,
}

/// Apply the parts of a refresh the student approved, and only those.
///
/// Two rules make this safe to run against records a student may have edited.
/// A change is applied only when the stored value still equals the `current`
/// the diff was computed against — if they moved the date themselves, their
/// edit wins and the row is reported as skipped rather than overwritten. And
/// nothing is matched by position: a term is found by the name it was created
/// with, so a diff for one term can never land on another.
#[tauri::command]
fn apply_calendar_diff(
    state: tauri::State<AppState>,
    approval: CalendarDiffApproval,
) -> Result<Dashboard> {
    state.require_unlocked()?;
    let db = state.db.lock().unwrap();
    let (applied, skipped) = apply_calendar_diff_in(&db, &approval)?;
    regenerate_plan_for_trigger(&db, None, planner::PlannerTrigger::ImportApproved)?;
    let notice = if applied == 0 {
        "Nothing was changed.".to_string()
    } else {
        format!(
            "{applied} calendar change{} applied{}.",
            if applied == 1 { "" } else { "s" },
            if skipped > 0 {
                format!("; {skipped} skipped because your own edits are newer")
            } else {
                String::new()
            }
        )
    };
    dashboard_with_notice(&db, &state.ocr, Some(notice))
}

/// The body of `apply_calendar_diff`, split out so it can be tested without a
/// Tauri `State`. Returns how much was applied and how much was deliberately
/// left alone.
fn apply_calendar_diff_in(
    db: &Connection,
    approval: &CalendarDiffApproval,
) -> Result<(usize, usize)> {
    let tx = db.unchecked_transaction()?;
    let mut applied = 0usize;
    let mut skipped = 0usize;

    for change in &approval.term_changes {
        let existing: Option<(String, String, String)> = tx
            .query_row(
                "SELECT id,starts_on,ends_on FROM academic_terms WHERE name=?1",
                params![change.term_name],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((term_id, starts_on, ends_on)) = existing else {
            skipped += 1;
            continue;
        };
        match change.field.as_str() {
            "startsOn" | "endsOn" => {
                let stored = if change.field == "startsOn" {
                    &starts_on
                } else {
                    &ends_on
                };
                if *stored != change.current {
                    // The student moved this themselves since the snapshot.
                    skipped += 1;
                    continue;
                }
                let column = if change.field == "startsOn" {
                    "starts_on"
                } else {
                    "ends_on"
                };
                tx.execute(
                    &format!(
                        "UPDATE academic_terms SET {column}=?2,version=version+1 WHERE id=?1"
                    ),
                    params![term_id, change.proposed],
                )?;
                mutation(&tx, "academic_term", &term_id, "updated", "{}")?;
                applied += 1;
            }
            // `academic_terms` has nowhere to put the last day of classes or the
            // start of finals, but they are dates a student plans around, so they
            // land on the calendar as ordinary events rather than being dropped.
            "classEndsOn" | "examStartsOn" => {
                let title = if change.field == "classEndsOn" {
                    "Last day of classes"
                } else {
                    "Final exams begin"
                };
                let known: i64 = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM academic_calendar_events
                     WHERE term_id=?1 AND title=?2 AND starts_on=?3)",
                    params![term_id, title, change.proposed],
                    |row| row.get(0),
                )?;
                if known != 0 {
                    skipped += 1;
                    continue;
                }
                let id = Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO academic_calendar_events(id,term_id,title,starts_on,ends_on,all_day,no_class,source)
                     VALUES(?1,?2,?3,?4,?4,1,0,'registrar')",
                    params![id, term_id, title, change.proposed],
                )?;
                mutation(&tx, "academic_calendar_event", &id, "created", "{}")?;
                applied += 1;
            }
            _ => skipped += 1,
        }
    }

    for date in &approval.no_class_dates {
        let starts_on = date.starts_on.trim();
        let label = date.label.trim();
        if starts_on.is_empty() || label.is_empty() {
            skipped += 1;
            continue;
        }
        let ends_on = if date.ends_on.trim().is_empty() {
            starts_on
        } else {
            date.ends_on.trim()
        };
        if ends_on < starts_on {
            skipped += 1;
            continue;
        }
        // Attach to whichever term contains the date; a holiday outside every
        // term is not one this student needs.
        let term_id: Option<String> = tx
            .query_row(
                "SELECT id FROM academic_terms WHERE ?1 BETWEEN starts_on AND ends_on LIMIT 1",
                params![starts_on],
                |row| row.get(0),
            )
            .optional()?;
        let Some(term_id) = term_id else {
            skipped += 1;
            continue;
        };
        let known: i64 = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM academic_calendar_events
             WHERE term_id=?1 AND starts_on=?2 AND ends_on=?3)",
            params![term_id, starts_on, ends_on],
            |row| row.get(0),
        )?;
        if known != 0 {
            skipped += 1;
            continue;
        }
        let id = Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO academic_calendar_events(id,term_id,title,starts_on,ends_on,all_day,no_class,source)
             VALUES(?1,?2,?3,?4,?5,1,1,'registrar')",
            params![id, term_id, label, starts_on, ends_on],
        )?;
        mutation(&tx, "academic_calendar_event", &id, "created", "{}")?;
        applied += 1;
    }

    tx.commit()?;
    Ok((applied, skipped))
}

#[tauri::command]
async fn get_institution_setup_options(
    state: tauri::State<'_, AppState>,
    institution_id: String,
) -> Result<InstitutionSetupOptions> {
    state.require_unlocked()?;
    tauri::async_runtime::spawn_blocking(move || institution_setup_options_for(institution_id))
        .await
        .map_err(|error| AppError::Invalid(error.to_string()))?
}

#[tauri::command]
fn save_onboarding_draft(
    state: tauri::State<AppState>,
    draft: profile::OnboardingDraft,
) -> Result<profile::OnboardingState> {
    state.require_unlocked()?;
    Ok(profile::save_draft(&state.db.lock().unwrap(), &draft)?)
}

#[tauri::command]
async fn complete_onboarding(
    state: tauri::State<'_, AppState>,
    draft: profile::OnboardingDraft,
) -> Result<AppBootstrap> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let security = current_security_status(&state);
        let mut conn = state.db.lock().unwrap();
        profile::complete_onboarding(&mut conn, &draft)?;
        enqueue_initial_workspace_mutations(&conn)?;
        regenerate_plan(&conn, None)?;
        // Read back under the same guard so the payload always reflects the
        // commit that just happened. Returning a bootstrap without a dashboard
        // used to strand the interface on its loading screen.
        bootstrap_locked(&state, &conn, security)
    })
    .await
    .map_err(|error| AppError::Invalid(error.to_string()))?
}

fn table_ids(conn: &Connection, table: &str, id_column: &str) -> Result<Vec<String>> {
    conn.prepare(&format!(
        "SELECT {id_column} FROM {table} ORDER BY {id_column}"
    ))?
    .query_map([], |row| row.get::<_, String>(0))?
    .collect::<std::result::Result<Vec<_>, _>>()
    .map_err(Into::into)
}

fn enqueue_initial_workspace_mutations(conn: &Connection) -> Result<()> {
    mutation(
        conn,
        "student_profile",
        profile::PROFILE_ID,
        "created",
        "{}",
    )?;
    mutation(
        conn,
        "planning_preferences",
        profile::PROFILE_ID,
        "created",
        "{}",
    )?;
    for (entity_type, table) in [
        ("availability_rule", "availability_rules"),
        ("academic_term", "academic_terms"),
        ("course", "courses"),
        ("commitment", "commitments"),
        ("task", "tasks"),
        ("instructor", "instructors"),
        ("class_meeting_series", "class_meeting_series"),
        ("academic_calendar_event", "academic_calendar_events"),
    ] {
        for id in table_ids(conn, table, "id")? {
            mutation(conn, entity_type, &id, "created", "{}")?;
        }
    }
    Ok(())
}

fn require_onboarded(conn: &Connection) -> Result<()> {
    if profile::onboarding_state(conn)?.required {
        Err(AppError::Invalid("Complete local onboarding first".into()))
    } else {
        Ok(())
    }
}

#[tauri::command]
fn get_local_workspace(state: tauri::State<AppState>) -> Result<profile::WorkspaceSnapshot> {
    state.require_unlocked()?;
    let conn = state.db.lock().unwrap();
    require_onboarded(&conn)?;
    Ok(profile::workspace(&conn)?)
}

#[tauri::command]
fn update_student_profile(
    state: tauri::State<AppState>,
    input: profile::StudentProfileInput,
) -> Result<profile::WorkspaceSnapshot> {
    state.require_unlocked()?;
    let mut conn = state.db.lock().unwrap();
    require_onboarded(&conn)?;
    profile::update_student_profile(&mut conn, &input)?;
    mutation(
        &conn,
        "student_profile",
        profile::PROFILE_ID,
        "updated",
        "{}",
    )?;
    regenerate_plan_for_trigger(&conn, None, planner::PlannerTrigger::PreferenceChanged)?;
    Ok(profile::workspace(&conn)?)
}

#[tauri::command]
fn create_academic_term(
    state: tauri::State<AppState>,
    input: profile::AcademicTermInput,
) -> Result<profile::WorkspaceSnapshot> {
    state.require_unlocked()?;
    let mut conn = state.db.lock().unwrap();
    require_onboarded(&conn)?;
    let id = profile::create_term(&mut conn, &input)?;
    mutation(&conn, "academic_term", &id, "created", "{}")?;
    regenerate_plan(&conn, None)?;
    Ok(profile::workspace(&conn)?)
}
#[tauri::command]
fn update_academic_term(
    state: tauri::State<AppState>,
    id: String,
    input: profile::AcademicTermInput,
) -> Result<profile::WorkspaceSnapshot> {
    state.require_unlocked()?;
    let mut conn = state.db.lock().unwrap();
    require_onboarded(&conn)?;
    profile::update_term(&mut conn, &id, &input)?;
    mutation(&conn, "academic_term", &id, "updated", "{}")?;
    regenerate_plan(&conn, None)?;
    Ok(profile::workspace(&conn)?)
}
#[tauri::command]
fn delete_academic_term(
    state: tauri::State<AppState>,
    id: String,
    expected_version: i64,
) -> Result<profile::WorkspaceSnapshot> {
    state.require_unlocked()?;
    let mut conn = state.db.lock().unwrap();
    require_onboarded(&conn)?;
    profile::delete_term(&mut conn, &id, expected_version)?;
    mutation(&conn, "academic_term", &id, "deleted", "{}")?;
    regenerate_plan(&conn, None)?;
    Ok(profile::workspace(&conn)?)
}

#[tauri::command]
fn create_course(
    state: tauri::State<AppState>,
    input: profile::CourseInput,
) -> Result<profile::WorkspaceSnapshot> {
    state.require_unlocked()?;
    let conn = state.db.lock().unwrap();
    require_onboarded(&conn)?;
    let id = profile::create_course(&conn, &input)?;
    mutation(&conn, "course", &id, "created", "{}")?;
    Ok(profile::workspace(&conn)?)
}
#[tauri::command]
fn update_course(
    state: tauri::State<AppState>,
    id: String,
    input: profile::CourseInput,
) -> Result<profile::WorkspaceSnapshot> {
    state.require_unlocked()?;
    let conn = state.db.lock().unwrap();
    require_onboarded(&conn)?;
    profile::update_course(&conn, &id, &input)?;
    mutation(&conn, "course", &id, "updated", "{}")?;
    regenerate_plan(&conn, None)?;
    Ok(profile::workspace(&conn)?)
}
#[tauri::command]
fn delete_course(
    state: tauri::State<AppState>,
    id: String,
    expected_version: i64,
) -> Result<profile::WorkspaceSnapshot> {
    state.require_unlocked()?;
    let mut conn = state.db.lock().unwrap();
    require_onboarded(&conn)?;
    profile::delete_course(&mut conn, &id, expected_version)?;
    mutation(&conn, "course", &id, "deleted", "{}")?;
    regenerate_plan(&conn, None)?;
    Ok(profile::workspace(&conn)?)
}

#[tauri::command]
fn create_local_task(
    state: tauri::State<AppState>,
    input: profile::TaskInput,
) -> Result<profile::WorkspaceSnapshot> {
    state.require_unlocked()?;
    let mut conn = state.db.lock().unwrap();
    require_onboarded(&conn)?;
    let id = profile::create_task(&mut conn, &input)?;
    mutation(&conn, "task", &id, "created", "{}")?;
    regenerate_plan(&conn, None)?;
    Ok(profile::workspace(&conn)?)
}
#[tauri::command]
fn update_local_task(
    state: tauri::State<AppState>,
    id: String,
    input: profile::TaskInput,
) -> Result<profile::WorkspaceSnapshot> {
    state.require_unlocked()?;
    let mut conn = state.db.lock().unwrap();
    require_onboarded(&conn)?;
    profile::update_task(&mut conn, &id, &input)?;
    mutation(&conn, "task", &id, "updated", "{}")?;
    regenerate_plan(&conn, None)?;
    Ok(profile::workspace(&conn)?)
}
#[tauri::command]
fn delete_local_task(
    state: tauri::State<AppState>,
    id: String,
    expected_version: i64,
) -> Result<profile::WorkspaceSnapshot> {
    state.require_unlocked()?;
    let mut conn = state.db.lock().unwrap();
    require_onboarded(&conn)?;
    profile::delete_task(&mut conn, &id, expected_version)?;
    mutation(&conn, "task", &id, "deleted", "{}")?;
    regenerate_plan(&conn, None)?;
    Ok(profile::workspace(&conn)?)
}

#[tauri::command]
fn create_commitment(
    state: tauri::State<AppState>,
    input: profile::CommitmentEditorInput,
) -> Result<profile::WorkspaceSnapshot> {
    state.require_unlocked()?;
    let conn = state.db.lock().unwrap();
    require_onboarded(&conn)?;
    let id = profile::create_commitment(&conn, &input)?;
    mutation(&conn, "commitment", &id, "created", "{}")?;
    regenerate_plan(&conn, None)?;
    Ok(profile::workspace(&conn)?)
}
#[tauri::command]
fn update_commitment(
    state: tauri::State<AppState>,
    id: String,
    input: profile::CommitmentEditorInput,
) -> Result<profile::WorkspaceSnapshot> {
    state.require_unlocked()?;
    let conn = state.db.lock().unwrap();
    require_onboarded(&conn)?;
    profile::update_commitment(&conn, &id, &input)?;
    mutation(&conn, "commitment", &id, "updated", "{}")?;
    regenerate_plan(&conn, None)?;
    Ok(profile::workspace(&conn)?)
}
#[tauri::command]
fn delete_commitment(
    state: tauri::State<AppState>,
    id: String,
    expected_version: i64,
) -> Result<profile::WorkspaceSnapshot> {
    state.require_unlocked()?;
    let mut conn = state.db.lock().unwrap();
    require_onboarded(&conn)?;
    profile::delete_commitment(&mut conn, &id, expected_version)?;
    mutation(&conn, "commitment", &id, "deleted", "{}")?;
    regenerate_plan(&conn, None)?;
    Ok(profile::workspace(&conn)?)
}

#[tauri::command]
fn create_instructor(
    state: tauri::State<AppState>,
    input: profile::InstructorInput,
) -> Result<profile::WorkspaceSnapshot> {
    state.require_unlocked()?;
    let conn = state.db.lock().unwrap();
    require_onboarded(&conn)?;
    let id = profile::create_instructor(&conn, &input)?;
    mutation(&conn, "instructor", &id, "created", "{}")?;
    Ok(profile::workspace(&conn)?)
}

#[tauri::command]
fn update_instructor(
    state: tauri::State<AppState>,
    id: String,
    input: profile::InstructorInput,
) -> Result<profile::WorkspaceSnapshot> {
    state.require_unlocked()?;
    let conn = state.db.lock().unwrap();
    require_onboarded(&conn)?;
    profile::update_instructor(&conn, &id, &input)?;
    mutation(&conn, "instructor", &id, "updated", "{}")?;
    Ok(profile::workspace(&conn)?)
}

#[tauri::command]
fn delete_instructor(
    state: tauri::State<AppState>,
    id: String,
    expected_version: i64,
) -> Result<profile::WorkspaceSnapshot> {
    state.require_unlocked()?;
    let conn = state.db.lock().unwrap();
    require_onboarded(&conn)?;
    profile::delete_instructor(&conn, &id, expected_version)?;
    mutation(&conn, "instructor", &id, "deleted", "{}")?;
    Ok(profile::workspace(&conn)?)
}

#[tauri::command]
fn create_class_meeting(
    state: tauri::State<AppState>,
    input: profile::ClassMeetingSeriesInput,
) -> Result<profile::WorkspaceSnapshot> {
    state.require_unlocked()?;
    let conn = state.db.lock().unwrap();
    require_onboarded(&conn)?;
    let id = profile::create_class_meeting(&conn, &input)?;
    mutation(&conn, "class_meeting_series", &id, "created", "{}")?;
    regenerate_plan(&conn, None)?;
    Ok(profile::workspace(&conn)?)
}

#[tauri::command]
fn update_class_meeting(
    state: tauri::State<AppState>,
    id: String,
    input: profile::ClassMeetingSeriesInput,
) -> Result<profile::WorkspaceSnapshot> {
    state.require_unlocked()?;
    let conn = state.db.lock().unwrap();
    require_onboarded(&conn)?;
    profile::update_class_meeting(&conn, &id, &input)?;
    mutation(&conn, "class_meeting_series", &id, "updated", "{}")?;
    regenerate_plan(&conn, None)?;
    Ok(profile::workspace(&conn)?)
}

#[tauri::command]
fn delete_class_meeting(
    state: tauri::State<AppState>,
    id: String,
    expected_version: i64,
) -> Result<profile::WorkspaceSnapshot> {
    state.require_unlocked()?;
    let conn = state.db.lock().unwrap();
    require_onboarded(&conn)?;
    profile::delete_class_meeting(&conn, &id, expected_version)?;
    mutation(&conn, "class_meeting_series", &id, "deleted", "{}")?;
    regenerate_plan(&conn, None)?;
    Ok(profile::workspace(&conn)?)
}

#[tauri::command]
fn create_academic_event(
    state: tauri::State<AppState>,
    input: profile::AcademicCalendarEventInput,
) -> Result<profile::WorkspaceSnapshot> {
    state.require_unlocked()?;
    let conn = state.db.lock().unwrap();
    require_onboarded(&conn)?;
    let id = profile::create_academic_event(&conn, &input)?;
    mutation(&conn, "academic_calendar_event", &id, "created", "{}")?;
    regenerate_plan(&conn, None)?;
    Ok(profile::workspace(&conn)?)
}

#[tauri::command]
fn update_academic_event(
    state: tauri::State<AppState>,
    id: String,
    input: profile::AcademicCalendarEventInput,
) -> Result<profile::WorkspaceSnapshot> {
    state.require_unlocked()?;
    let conn = state.db.lock().unwrap();
    require_onboarded(&conn)?;
    profile::update_academic_event(&conn, &id, &input)?;
    mutation(&conn, "academic_calendar_event", &id, "updated", "{}")?;
    regenerate_plan(&conn, None)?;
    Ok(profile::workspace(&conn)?)
}

#[tauri::command]
fn delete_academic_event(
    state: tauri::State<AppState>,
    id: String,
    expected_version: i64,
) -> Result<profile::WorkspaceSnapshot> {
    state.require_unlocked()?;
    let conn = state.db.lock().unwrap();
    require_onboarded(&conn)?;
    profile::delete_academic_event(&conn, &id, expected_version)?;
    mutation(&conn, "academic_calendar_event", &id, "deleted", "{}")?;
    regenerate_plan(&conn, None)?;
    Ok(profile::workspace(&conn)?)
}

#[tauri::command]
fn update_appearance(
    state: tauri::State<AppState>,
    appearance: String,
) -> Result<profile::WorkspaceSnapshot> {
    state.require_unlocked()?;
    let conn = state.db.lock().unwrap();
    profile::set_appearance(&conn, &appearance)?;
    Ok(profile::workspace(&conn)?)
}

#[tauri::command]
fn update_accent(
    state: tauri::State<AppState>,
    accent: String,
) -> Result<profile::WorkspaceSnapshot> {
    state.require_unlocked()?;
    let conn = state.db.lock().unwrap();
    profile::set_accent(&conn, &accent)?;
    Ok(profile::workspace(&conn)?)
}

#[derive(Debug,Serialize)]
#[serde(rename_all="camelCase")]
struct AcademicCleanupPreview{duplicate_course_groups:Vec<Vec<String>>,repeated_commitment_series:Vec<RepeatedCommitmentPreview>}
#[derive(Debug,Serialize)]
#[serde(rename_all="camelCase")]
struct RepeatedCommitmentPreview{title:String,count:usize,weekdays:Vec<u32>,starts_at_local:String,ends_at_local:String}

fn normalized_course_key(code:&str,title:&str)->String{let source=if code.trim().is_empty(){title}else{code};source.chars().filter(|value|value.is_ascii_alphanumeric()).flat_map(char::to_lowercase).collect()}

fn academic_cleanup_preview_in(conn:&Connection)->Result<AcademicCleanupPreview>{
    let mut courses=conn.prepare("SELECT id,title,code FROM courses ORDER BY created_at,id")?;let mut grouped=std::collections::BTreeMap::<String,Vec<String>>::new();for row in courses.query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?)))?{let (id,title,code)=row?;let key=normalized_course_key(&code,&title);if !key.is_empty(){grouped.entry(key).or_default().push(id);}}
    let duplicate_course_groups=grouped.into_values().filter(|ids|ids.len()>1).collect();let timezone=canvas_calendar_timezone(conn);let mut commitments=conn.prepare("SELECT id,title,starts_at,ends_at,location FROM commitments WHERE kind='class' ORDER BY datetime(starts_at),id")?;let mut repeated=std::collections::BTreeMap::<String,Vec<(String,NaiveDate,u32,String,String)>>::new();
    for row in commitments.query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?)))?{let (id,title,start,end,location)=row?;let Some(start)=parse_utc(&start)else{continue};let Some(end)=parse_utc(&end)else{continue};let local_start=start.with_timezone(&timezone);let local_end=end.with_timezone(&timezone);let start_clock=format!("{:02}:{:02}",local_start.hour(),local_start.minute());let end_clock=format!("{:02}:{:02}",local_end.hour(),local_end.minute());let key=format!("{}|{}|{}|{}",title.trim().to_ascii_lowercase(),location.trim().to_ascii_lowercase(),start_clock,end_clock);repeated.entry(key).or_default().push((id,local_start.date_naive(),local_start.weekday().num_days_from_sunday(),title,start_clock+"|"+&end_clock));}
    let repeated_commitment_series=repeated.into_values().filter_map(|rows|{if rows.len()<3{return None;}let mut by_day=std::collections::BTreeMap::<u32,Vec<NaiveDate>>::new();for (_,date,weekday,_,_) in &rows{by_day.entry(*weekday).or_default().push(*date);}if by_day.values().any(|dates|dates.len()<2||dates.windows(2).any(|pair|pair[1].signed_duration_since(pair[0]).num_days()!=7)){return None;}let clocks=rows[0].4.split('|').collect::<Vec<_>>();Some(RepeatedCommitmentPreview{title:rows[0].3.clone(),count:rows.len(),weekdays:by_day.into_keys().collect(),starts_at_local:clocks[0].into(),ends_at_local:clocks[1].into()})}).collect();
    Ok(AcademicCleanupPreview{duplicate_course_groups,repeated_commitment_series})
}

#[tauri::command]
fn get_academic_cleanup_preview(state:tauri::State<AppState>)->Result<AcademicCleanupPreview>{state.require_unlocked()?;academic_cleanup_preview_in(&state.db.lock().unwrap())}

fn merge_duplicate_courses_in(conn:&Connection)->Result<usize>{
    let preview=academic_cleanup_preview_in(conn)?;let tx=conn.unchecked_transaction()?;let mut merged=0;
    for ids in preview.duplicate_course_groups{let keep=&ids[0];for duplicate in ids.iter().skip(1){
        for table in ["tasks","instructors","class_meeting_series","study_materials","grade_categories","grade_items"]{tx.execute(&format!("UPDATE {table} SET course_id=?1 WHERE course_id=?2"),params![keep,duplicate])?;}
        tx.execute("DELETE FROM course_grading_scales WHERE course_id=?1 AND EXISTS(SELECT 1 FROM course_grading_scales WHERE course_id=?2)",params![duplicate,keep])?;
        tx.execute("UPDATE course_grading_scales SET course_id=?1 WHERE course_id=?2",params![keep,duplicate])?;
        tx.execute("UPDATE provenance_links SET entity_id=?1 WHERE entity_type='course' AND entity_id=?2",params![keep,duplicate])?;
        tx.execute("UPDATE import_candidates SET canonical_entity_id=?1 WHERE kind='course' AND canonical_entity_id=?2",params![keep,duplicate])?;
        tx.execute("DELETE FROM courses WHERE id=?1",params![duplicate])?;mutation(&tx,"course",duplicate,"deleted","{}")?;merged+=1;
    }mutation(&tx,"course",keep,"duplicates_merged","{}")?;}tx.commit()?;Ok(merged)
}

fn collapse_repeated_commitments_in(conn:&Connection)->Result<usize>{
    let timezone=canvas_calendar_timezone(conn);let mut statement=conn.prepare("SELECT id,title,starts_at,ends_at,location FROM commitments WHERE kind='class' ORDER BY datetime(starts_at),id")?;let rows=statement.query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;drop(statement);let mut groups=std::collections::BTreeMap::<String,Vec<(String,NaiveDate,u32,String,String,String)>>::new();for (id,title,start,end,location) in rows{let Some(start)=parse_utc(&start)else{continue};let Some(end)=parse_utc(&end)else{continue};let local_start=start.with_timezone(&timezone);let local_end=end.with_timezone(&timezone);let start_clock=format!("{:02}:{:02}",local_start.hour(),local_start.minute());let end_clock=format!("{:02}:{:02}",local_end.hour(),local_end.minute());let key=format!("{}|{}|{}|{}",title.trim().to_ascii_lowercase(),location.trim().to_ascii_lowercase(),start_clock,end_clock);groups.entry(key).or_default().push((id,local_start.date_naive(),local_start.weekday().num_days_from_sunday(),title,location,start_clock+"|"+&end_clock));}
    let tx=conn.unchecked_transaction()?;let mut collapsed=0;for rows in groups.into_values(){let mut by_day=std::collections::BTreeMap::<u32,Vec<NaiveDate>>::new();for (_,date,weekday,_,_,_) in &rows{by_day.entry(*weekday).or_default().push(*date);}if rows.len()<3||by_day.values().any(|dates|dates.len()<2||dates.windows(2).any(|pair|pair[1].signed_duration_since(pair[0]).num_days()!=7)){continue;}let first=rows.iter().map(|row|row.1).min().unwrap();let term_id=tx.query_row("SELECT id FROM academic_terms WHERE starts_on<=?1 AND ends_on>=?1 ORDER BY active DESC,starts_on LIMIT 1",params![first.to_string()],|row|row.get::<_,String>(0)).optional()?;let Some(term_id)=term_id else{continue};let title=rows[0].3.trim();let course_id=tx.query_row("SELECT id FROM courses WHERE title=?1 COLLATE NOCASE OR code=?1 COLLATE NOCASE ORDER BY created_at LIMIT 1",params![title],|row|row.get::<_,String>(0)).optional()?.unwrap_or_else(||Uuid::new_v4().to_string());if tx.query_row("SELECT EXISTS(SELECT 1 FROM courses WHERE id=?1)",params![course_id],|row|row.get::<_,i64>(0))?==0{tx.execute("INSERT INTO courses(id,title,code,created_at,record_origin) VALUES(?1,?2,'',?3,'migration')",params![course_id,title,Utc::now().to_rfc3339()])?;mutation(&tx,"course",&course_id,"legacy_series_created","{}")?;}let clocks=rows[0].5.split('|').collect::<Vec<_>>();let meeting_id=Uuid::new_v4().to_string();let source_uid=format!("legacy-collapse:{}",hex::encode(Sha256::digest(format!("{}|{}|{}",title,clocks[0],clocks[1]).as_bytes())));let weekdays=by_day.keys().map(|value|i64::from(*value)).collect::<Vec<_>>();tx.execute("INSERT INTO class_meeting_series(id,course_id,term_id,timezone,weekdays,starts_at_local,ends_at_local,component,location,source_uid) VALUES(?1,?2,?3,?4,?5,?6,?7,'lecture',?8,?9)",params![meeting_id,course_id,term_id,timezone.to_string(),serde_json::to_string(&weekdays).unwrap_or_else(|_|"[]".into()),clocks[0],clocks[1],rows[0].4,source_uid])?;for (id,_,_,_,_,_) in &rows{tx.execute("UPDATE provenance_links SET entity_type='class_meeting_series',entity_id=?1 WHERE entity_type='commitment' AND entity_id=?2",params![meeting_id,id])?;tx.execute("DELETE FROM commitments WHERE id=?1",params![id])?;mutation(&tx,"commitment",id,"collapsed_to_series","{}")?;}mutation(&tx,"class_meeting_series",&meeting_id,"legacy_commitments_collapsed","{}")?;collapsed+=1;}tx.commit()?;Ok(collapsed)
}

#[tauri::command]
fn apply_academic_cleanup(state:tauri::State<AppState>,merge_duplicate_courses:bool,collapse_repeated_commitments:bool)->Result<profile::WorkspaceSnapshot>{state.require_unlocked()?;let db=state.db.lock().unwrap();if merge_duplicate_courses{merge_duplicate_courses_in(&db)?;}if collapse_repeated_commitments{collapse_repeated_commitments_in(&db)?;}regenerate_plan(&db,None)?;Ok(profile::workspace(&db)?)}

#[tauri::command]
fn list_legacy_quarantine(
    state: tauri::State<AppState>,
) -> Result<Vec<profile::LegacyQuarantineItem>> {
    state.require_unlocked()?;
    Ok(profile::list_quarantine(&state.db.lock().unwrap())?)
}

#[tauri::command]
fn restore_legacy_quarantine(
    state: tauri::State<AppState>,
    ids: Vec<String>,
) -> Result<profile::WorkspaceSnapshot> {
    state.require_unlocked()?;
    let mut conn = state.db.lock().unwrap();
    profile::restore_quarantine(&mut conn, &ids)?;
    if !profile::onboarding_state(&conn)?.required {
        regenerate_plan(&conn, None)?;
    }
    Ok(profile::workspace(&conn)?)
}

#[tauri::command]
fn purge_legacy_quarantine(
    state: tauri::State<AppState>,
    confirmation: String,
) -> Result<profile::LegacyQuarantineStatus> {
    state.require_unlocked()?;
    if confirmation != "PURGE LEGACY DATA" {
        return Err(AppError::Invalid(
            "Type PURGE LEGACY DATA to confirm".into(),
        ));
    }
    let conn = state.db.lock().unwrap();
    profile::purge_quarantine(&conn)?;
    Ok(profile::quarantine_status(&conn)?)
}

#[tauri::command]
fn update_planning_preferences(
    state: tauri::State<AppState>,
    input: profile::PreferenceInput,
) -> Result<profile::WorkspaceSnapshot> {
    state.require_unlocked()?;
    let mut conn = state.db.lock().unwrap();
    require_onboarded(&conn)?;
    let previous_availability = table_ids(&conn, "availability_rules", "id")?;
    profile::update_preferences(&mut conn, &input)?;
    mutation(
        &conn,
        "planning_preferences",
        profile::PROFILE_ID,
        "updated",
        "{}",
    )?;
    let current_availability = table_ids(&conn, "availability_rules", "id")?;
    for id in previous_availability {
        if !current_availability.contains(&id) {
            mutation(&conn, "availability_rule", &id, "deleted", "{}")?;
        }
    }
    for id in current_availability {
        mutation(&conn, "availability_rule", &id, "updated", "{}")?;
    }
    regenerate_plan_for_trigger(&conn, None, planner::PlannerTrigger::PreferenceChanged)?;
    Ok(profile::workspace(&conn)?)
}

#[tauri::command]
async fn delete_local_profile(
    state: tauri::State<'_, AppState>,
    confirmation: String,
) -> Result<AppBootstrap> {
    state.require_unlocked()?;
    if confirmation != "DELETE MY PROFILE" {
        return Err(AppError::Invalid(
            "Type DELETE MY PROFILE to confirm permanent local deletion".into(),
        ));
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.require_unlocked()?;
        let archived_vault = state.root.join(format!("profile-reset-{}", Uuid::new_v4()));
        if state.vault.exists() {
            fs::rename(&state.vault, &archived_vault)?;
        }
        fs::create_dir_all(&state.vault)?;
        let reset = reset_local_database(&state);
        if let Err(error) = reset {
            let _ = fs::remove_dir_all(&state.vault);
            if archived_vault.exists() {
                let _ = fs::rename(&archived_vault, &state.vault);
            }
            return Err(error);
        }
        if archived_vault.exists() {
            fs::remove_dir_all(&archived_vault)?;
        }
        bootstrap(&state)
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

fn reset_local_database(state: &AppState) -> Result<()> {
    let mut conn = state.db.lock().unwrap();
    let connections = {
        let mut query = conn.prepare(
            "SELECT id,provider FROM integration_connections WHERE provider IN ('canvas','canvas_calendar')",
        )?;
        let values = query
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        values
    };
    let tx = conn.transaction()?;
    for table in [
        "study_reviews",
        "study_artifacts",
        "study_materials",
        "document_segments",
        "grade_items",
        "grade_categories",
        "course_grading_scales",
        "reminder_deliveries",
        "provenance_links",
        "source_conflicts",
        "import_candidates",
        "source_objects",
        "integration_sync_runs",
        "integration_connections",
        "documents",
        "plan_blocks",
        "task_dependencies",
        "tasks",
        "commitments",
        "courses",
        "availability_rules",
        "planning_preferences",
        "academic_terms",
        "student_profiles",
        "sync_outbox",
        "sync_uploaded_mutations",
        "sync_received_mutations",
        "sync_state",
        "sync_set_elements",
        "sync_entity_versions",
        "mutations",
    ] {
        tx.execute(&format!("DELETE FROM {table}"), [])?;
    }
    tx.execute("DELETE FROM settings", [])?;
    tx.execute(
        "INSERT INTO settings(key,value) VALUES('demo_review_status','not_required')",
        [],
    )?;
    tx.commit()?;
    profile::initialize_defaults(&conn)?;
    for (id, provider) in connections {
        if provider == "canvas" {
            let _ = canvas_token_entry(&id)?.delete_credential();
        } else {
            let _ = canvas_calendar_entry(&id)?.delete_credential();
        }
    }
    for provider in ai_providers::ProviderId::ALL {
        let _ = ai_providers::remove_key(provider);
    }
    Ok(())
}

#[tauri::command]
fn take_pending_navigation(state: tauri::State<AppState>) -> Result<Option<NavigationTarget>> {
    state.require_unlocked()?;
    Ok(state.pending_navigation.lock().unwrap().take())
}

#[tauri::command]
fn get_update_status(app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<UpdateStatus> {
    state.require_unlocked()?;
    Ok(updater_status(&app))
}

#[tauri::command]
fn get_account_status(state: tauri::State<AppState>) -> Result<auth::AccountStatus> {
    state.require_unlocked()?;
    Ok(state.account.lock().unwrap().status())
}

fn signed_in_account_id(state: &AppState) -> Result<String> {
    state
        .account
        .lock()
        .unwrap()
        .account_id()
        .ok_or_else(|| AppError::Invalid("Sign in before configuring encrypted sync".into()))
}

#[tauri::command]
async fn get_sync_protection_status(
    state: tauri::State<'_, AppState>,
) -> Result<sync_crypto::SyncProtectionStatus> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.require_unlocked()?;
        let account_id = signed_in_account_id(&state)?;
        Ok(state.sync_protection.lock().unwrap().status(&account_id)?)
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

#[tauri::command]
async fn begin_sync_protection(
    state: tauri::State<'_, AppState>,
) -> Result<sync_crypto::RecoverySetup> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.require_unlocked()?;
        let account_id = signed_in_account_id(&state)?;
        Ok(state.sync_protection.lock().unwrap().begin(&account_id)?)
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

#[tauri::command]
async fn confirm_sync_protection(
    state: tauri::State<'_, AppState>,
    confirmations: Vec<sync_crypto::RecoveryConfirmation>,
) -> Result<sync_crypto::SyncProtectionStatus> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.require_unlocked()?;
        let account_id = signed_in_account_id(&state)?;
        Ok(state
            .sync_protection
            .lock()
            .unwrap()
            .confirm(&account_id, &confirmations)?)
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

#[tauri::command]
async fn recover_sync_protection(
    state: tauri::State<'_, AppState>,
    recovery_phrase: String,
) -> Result<sync_crypto::SyncProtectionStatus> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.require_unlocked()?;
        let account_id = signed_in_account_id(&state)?;
        Ok(state
            .sync_protection
            .lock()
            .unwrap()
            .recover(&account_id, &recovery_phrase)?)
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

#[tauri::command]
async fn request_existing_device_approval(
    state: tauri::State<'_, AppState>,
) -> Result<sync_crypto::ExistingDeviceSetup> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (account_id, access_token) = signed_in_account_and_token(&state)?;
        let setup = state
            .sync_protection
            .lock()
            .unwrap()
            .begin_existing_device_approval(&account_id)?;
        let registration = sync_transport::DeviceRegistration {
            device_id: setup.device_id,
            public_key: &setup.public_key,
            signing_public_key: &setup.signing_public_key,
            display_name: "This Student Center computer",
            platform: sync_transport::platform()?,
            request_approval: true,
        };
        let response = sync_transport::CloudSyncClient::compiled()?
            .register_device(&access_token, &registration)?;
        if !response.registered
            || response.account_id.to_string() != account_id
            || response.authorized
        {
            return Err(AppError::SyncTransport(
                sync_transport::SyncTransportError::InvalidResponse,
            ));
        }
        Ok(setup)
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

#[tauri::command]
async fn check_existing_device_approval(
    state: tauri::State<'_, AppState>,
) -> Result<sync_crypto::SyncProtectionStatus> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (account_id, access_token) = signed_in_account_and_token(&state)?;
        let setup = state
            .sync_protection
            .lock()
            .unwrap()
            .begin_existing_device_approval(&account_id)?;
        let client = sync_transport::CloudSyncClient::compiled()?;
        let envelopes = client.device_envelopes(&access_token, setup.device_id)?;
        let received = envelopes.first().ok_or_else(|| {
            AppError::Invalid("Approval is still pending on an existing computer".into())
        })?;
        let status = state
            .sync_protection
            .lock()
            .unwrap()
            .accept_existing_device_approval(&account_id, received)?;
        // Retire the envelope now that it has been adopted. A failure here is not worth failing
        // the approval over: the envelope expires on its own within fifteen minutes.
        let _ = client.consume_device_envelope(
            &access_token,
            setup.device_id,
            received.envelope.envelope_id,
        );
        Ok(status)
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

#[tauri::command]
fn cancel_sync_protection(state: tauri::State<AppState>) -> Result<()> {
    state.require_unlocked()?;
    state.sync_protection.lock().unwrap().cancel();
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedSyncStatus {
    configured: bool,
    protected: bool,
    connected: bool,
    account_id: String,
    device_id: Option<String>,
    pending_mutations: usize,
    unsupported_downloaded_mutations: usize,
    last_pushed_at: Option<String>,
    message: String,
}

fn encrypted_sync_status(state: &AppState, account_id: &str) -> Result<EncryptedSyncStatus> {
    let configured = sync_transport::CloudSyncClient::compiled().is_ok();
    let protection = state.sync_protection.lock().unwrap().status(account_id)?;
    let db = state.db.lock().unwrap();
    let binding = db
        .query_row(
            "SELECT value FROM settings WHERE key='sync_account_id'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let state_row = db
        .query_row(
            "SELECT device_id,last_pushed_at FROM sync_state WHERE account_id=?1",
            params![account_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()?;
    let current_device = protection.device_id.clone();
    let connected = configured
        && protection.protected
        && binding.as_deref() == Some(account_id)
        && state_row
            .as_ref()
            .is_some_and(|(device_id, _)| Some(device_id) == current_device.as_ref());
    let pending_mutations = if binding.as_deref().is_none_or(|bound| bound == account_id) {
        pending_mutation_count(&db, account_id)?
    } else {
        0
    };
    let last_pushed_at = state_row.and_then(|(_, pushed)| pushed);
    let unsupported_downloaded_mutations = db
        .query_row(
            "SELECT COUNT(*) FROM sync_received_mutations WHERE account_id=?1 AND outcome='deferred_unknown_type'",
            params![account_id],
            |row| row.get::<_, i64>(0),
        )?
        .max(0) as usize;
    let message = if !configured {
        "This build has no encrypted-sync service configured. Local planning remains available."
            .into()
    } else if !protection.protected {
        "Create or recover the 24-word code before connecting encrypted sync.".into()
    } else if binding.as_deref().is_some_and(|bound| bound != account_id) {
        "This local profile is already bound to a different account.".into()
    } else if connected {
        "This device is registered. Pending changes can be encrypted and synchronized.".into()
    } else {
        "Recovery is protected. Register this device to connect encrypted sync.".into()
    };
    Ok(EncryptedSyncStatus {
        configured,
        protected: protection.protected,
        connected,
        account_id: account_id.into(),
        device_id: current_device,
        pending_mutations,
        unsupported_downloaded_mutations,
        last_pushed_at,
        message,
    })
}

fn signed_in_account_and_token(state: &AppState) -> Result<(String, Zeroizing<String>)> {
    let mut account = state.account.lock().unwrap();
    let account_id = account.account_id().ok_or_else(|| {
        AppError::Invalid("Sign in before using optional account services".into())
    })?;
    let token = account.access_token()?;
    Ok((account_id, token))
}

fn bind_local_mutation_device(
    conn: &Connection,
    account_id: &str,
    target_device_id: Uuid,
) -> Result<()> {
    let current_device_id = persistent_device_id(conn)?;
    let target_device_id = target_device_id.to_string();
    if current_device_id == target_device_id {
        return Ok(());
    }
    let uploaded_with_old_identity = conn.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM mutations m JOIN sync_uploaded_mutations u ON u.mutation_id=m.id
           WHERE u.account_id=?1 AND m.device_id<>?2
         )",
        params![account_id, target_device_id],
        |row| row.get::<_, i64>(0),
    )? != 0;
    if uploaded_with_old_identity {
        return Err(AppError::Invalid(
            "This profile already uploaded mutations under another device identity; recover it on the original authorized device"
                .into(),
        ));
    }
    conn.execute(
        "DELETE FROM sync_outbox WHERE account_id=?1",
        params![account_id],
    )?;
    let local_clocks = conn
        .prepare("SELECT id,hlc FROM mutations WHERE device_id=?1 ORDER BY hlc,id")?
        .query_map(params![current_device_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (mutation_id, old_hlc) in local_clocks {
        let prefix = old_hlc
            .get(..25)
            .ok_or_else(|| AppError::Invalid("A local hybrid clock is invalid".into()))?;
        let new_hlc = format!("{prefix}{target_device_id}");
        conn.execute(
            "UPDATE mutations SET hlc=?2,device_id=?3 WHERE id=?1",
            params![mutation_id, new_hlc, target_device_id],
        )?;
        conn.execute(
            "UPDATE sync_entity_versions SET hlc=?2,device_id=?3 WHERE mutation_id=?1",
            params![mutation_id, new_hlc, target_device_id],
        )?;
    }
    conn.execute(
        "UPDATE sync_set_elements SET hlc=substr(hlc,1,25)||?2,device_id=?2 WHERE device_id=?1",
        params![current_device_id, target_device_id],
    )?;
    conn.execute(
        "INSERT INTO settings(key,value) VALUES('local_device_id',?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![target_device_id],
    )?;
    Ok(())
}

#[tauri::command]
async fn get_encrypted_sync_status(
    state: tauri::State<'_, AppState>,
) -> Result<EncryptedSyncStatus> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.require_unlocked()?;
        let account_id = signed_in_account_id(&state)?;
        encrypted_sync_status(&state, &account_id)
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

#[tauri::command]
async fn connect_encrypted_sync(state: tauri::State<'_, AppState>) -> Result<EncryptedSyncStatus> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.require_unlocked()?;
        let (account_id, access_token) = signed_in_account_and_token(&state)?;
        let account_uuid = Uuid::parse_str(&account_id)
            .map_err(|_| AppError::Invalid("The signed-in account is invalid".into()))?;
        let material = state
            .sync_protection
            .lock()
            .unwrap()
            .key_material(&account_id)?;
        {
            let db = state.db.lock().unwrap();
            let existing = db
                .query_row(
                    "SELECT value FROM settings WHERE key='sync_account_id'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if existing.as_deref().is_some_and(|bound| bound != account_id) {
                return Err(AppError::Invalid(
                    "This local profile is already bound to a different account".into(),
                ));
            }
        }
        let client = sync_transport::CloudSyncClient::compiled()?;
        let registration = sync_transport::DeviceRegistration {
            device_id: material.device_id,
            public_key: &material.public_key,
            signing_public_key: &material.signing_public_key,
            display_name: "This Student Center computer",
            platform: sync_transport::platform()?,
            request_approval: false,
        };
        let registered = client.register_device(&access_token, &registration)?;
        if !registered.registered || registered.account_id != account_uuid {
            return Err(AppError::SyncTransport(
                sync_transport::SyncTransportError::InvalidResponse,
            ));
        }
        if !registered.authorized {
            return Err(AppError::Invalid(
                "This recovered device is pending approval from an authorized computer".into(),
            ));
        }
        let mut db = state.db.lock().unwrap();
        let transaction = db.transaction()?;
        bind_local_mutation_device(&transaction, &account_id, material.device_id)?;
        let existing = transaction
            .query_row(
                "SELECT value FROM settings WHERE key='sync_account_id'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if existing.as_deref().is_some_and(|bound| bound != account_id) {
            return Err(AppError::Invalid(
                "This local profile is already bound to a different account".into(),
            ));
        }
        transaction.execute(
            "INSERT INTO settings(key,value) VALUES('sync_account_id',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![account_id],
        )?;
        transaction.execute(
            "INSERT INTO sync_state(account_id,device_id,connected_at) VALUES(?1,?2,?3) ON CONFLICT(account_id) DO UPDATE SET device_id=excluded.device_id,connected_at=excluded.connected_at",
            params![account_id, material.device_id.to_string(), Utc::now().to_rfc3339()],
        )?;
        transaction.commit()?;
        drop(db);
        encrypted_sync_status(&state, &account_id)
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

#[tauri::command]
async fn list_pending_sync_devices(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<sync_transport::PendingDevice>> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (account_id, access_token) = signed_in_account_and_token(&state)?;
        let material = state
            .sync_protection
            .lock()
            .unwrap()
            .key_material(&account_id)?;
        sync_transport::CloudSyncClient::compiled()?
            .pending_devices(&access_token, material.device_id)
            .map_err(Into::into)
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

#[tauri::command]
async fn list_authorized_sync_devices(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<sync_transport::PendingDevice>> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (account_id, access_token) = signed_in_account_and_token(&state)?;
        let material = state
            .sync_protection
            .lock()
            .unwrap()
            .key_material(&account_id)?;
        sync_transport::CloudSyncClient::compiled()?
            .authorized_devices(&access_token, material.device_id)
            .map_err(Into::into)
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

#[tauri::command]
async fn approve_sync_device(
    state: tauri::State<'_, AppState>,
    target_device_id: String,
) -> Result<Vec<sync_transport::PendingDevice>> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let target_id = Uuid::parse_str(&target_device_id)
            .map_err(|_| AppError::Invalid("The pending device ID is invalid".into()))?;
        let (account_id, access_token) = signed_in_account_and_token(&state)?;
        let material = state
            .sync_protection
            .lock()
            .unwrap()
            .key_material(&account_id)?;
        let client = sync_transport::CloudSyncClient::compiled()?;
        let pending = client.pending_devices(&access_token, material.device_id)?;
        let target = pending
            .iter()
            .find(|device| device.device_id == target_id)
            .ok_or_else(|| AppError::Invalid("The device is no longer pending approval".into()))?;
        let envelope = material.approve_device(target_id, &target.public_key)?;
        client.approve_device(&access_token, &envelope)?;
        client
            .pending_devices(&access_token, material.device_id)
            .map_err(Into::into)
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

#[tauri::command]
async fn revoke_sync_device(
    state: tauri::State<'_, AppState>,
    target_device_id: String,
) -> Result<EncryptedSyncStatus> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let target_id = Uuid::parse_str(&target_device_id)
            .map_err(|_| AppError::Invalid("The device ID is invalid".into()))?;
        let (account_id, access_token) = signed_in_account_and_token(&state)?;
        let material = state
            .sync_protection
            .lock()
            .unwrap()
            .key_material(&account_id)?;
        sync_transport::CloudSyncClient::compiled()?.revoke_device(
            &access_token,
            material.device_id,
            target_id,
        )?;
        if target_id == material.device_id {
            state.db.lock().unwrap().execute(
                "DELETE FROM sync_state WHERE account_id=?1",
                params![account_id],
            )?;
        }
        encrypted_sync_status(&state, &account_id)
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

/// How many local mutations are still waiting to upload.
///
/// Shares the replication filter with `prepare_sync_outbox` so the badge can never count work that
/// will not actually be sent.
fn pending_mutation_count(conn: &Connection, account_id: &str) -> Result<usize> {
    let sql = format!(
        "SELECT COUNT(*) FROM mutations m
         LEFT JOIN sync_uploaded_mutations u ON u.account_id=?1 AND u.mutation_id=m.id
         WHERE u.mutation_id IS NULL AND m.entity_type IN {}",
        replicated_entity_type_filter()
    );
    let mut binds: Vec<&dyn rusqlite::ToSql> = vec![&account_id];
    for entity_type in REPLICATED_ENTITY_TYPES.iter() {
        binds.push(entity_type);
    }
    Ok(conn
        .query_row(&sql, binds.as_slice(), |row| row.get::<_, i64>(0))?
        .max(0) as usize)
}

fn prepare_sync_outbox(
    conn: &mut Connection,
    account_id: Uuid,
    material: &sync_crypto::SyncKeyMaterial,
) -> Result<Vec<sync_transport::EncryptedMutation>> {
    let pending = {
        // The entity-type filter MUST stay in SQL. Filtering in Rust after the LIMIT would let
        // local-only churn (a plan snapshot is rewritten on every replan) fill the page and starve
        // real uploads indefinitely.
        let sql = format!(
            "SELECT m.id,m.entity_type,m.entity_id,m.operation,m.hlc,m.tombstone,m.payload,o.envelope
             FROM mutations m
             LEFT JOIN sync_uploaded_mutations u ON u.account_id=?1 AND u.mutation_id=m.id
             LEFT JOIN sync_outbox o ON o.account_id=?1 AND o.mutation_id=m.id
             WHERE u.mutation_id IS NULL AND m.entity_type IN {}
             ORDER BY m.hlc,m.id LIMIT 100",
            replicated_entity_type_filter()
        );
        let account = account_id.to_string();
        let mut binds: Vec<&dyn rusqlite::ToSql> = vec![&account];
        for entity_type in REPLICATED_ENTITY_TYPES.iter() {
            binds.push(entity_type);
        }
        let mut statement = conn.prepare(&sql)?;
        let rows = statement
            .query_map(binds.as_slice(), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    let transaction = conn.transaction()?;
    let mut envelopes = Vec::with_capacity(pending.len());
    for (mutation_id, entity_type, entity_id, operation, hlc, tombstone, payload, saved) in pending
    {
        let mutation_uuid = Uuid::parse_str(&mutation_id)
            .map_err(|_| AppError::Invalid("A local mutation ID is invalid".into()))?;
        // A saved envelope is reused byte-for-byte so a crash retry cannot re-encrypt the same
        // mutation ID under a fresh nonce. An envelope written by an older protocol version has no
        // usable signature, so it is discarded and re-encrypted rather than uploaded as-is.
        let reusable = match saved {
            Some(saved) => {
                let envelope: sync_transport::EncryptedMutation = serde_json::from_str(&saved)
                    .map_err(|_| AppError::Invalid("The encrypted sync outbox is invalid".into()))?;
                if envelope.mutation_id != mutation_uuid
                    || envelope.account_id != account_id
                    || envelope.entity_id.to_string() != entity_id
                    || envelope.entity_type != entity_type
                    || envelope.logical_timestamp != hlc
                    || envelope.tombstone != (tombstone != 0)
                {
                    return Err(AppError::Invalid(
                        "The encrypted sync outbox does not match this profile".into(),
                    ));
                }
                let signed_by_this_device = sync_transport::verify_mutation_signature(
                    &envelope,
                    &material.signing_public_key,
                )
                .is_ok();
                signed_by_this_device.then_some(envelope)
            }
            None => None,
        };
        let envelope = if let Some(envelope) = reusable {
            envelope
        } else {
            let local = sync_transport::LocalMutation {
                mutation_id: mutation_uuid,
                entity_type,
                entity_id: Uuid::parse_str(&entity_id)
                    .map_err(|_| AppError::Invalid("A local entity ID is invalid".into()))?,
                operation,
                logical_timestamp: hlc,
                tombstone: tombstone != 0,
                payload,
            };
            let envelope = sync_transport::encrypt_mutation(material, account_id, &local)?;
            let serialized = serde_json::to_string(&envelope).map_err(|_| {
                AppError::Invalid("The encrypted outbox could not be encoded".into())
            })?;
            transaction.execute(
                "INSERT INTO sync_outbox(account_id,mutation_id,envelope,created_at)
                 VALUES(?1,?2,?3,?4)
                 ON CONFLICT(account_id,mutation_id) DO UPDATE SET envelope=excluded.envelope,created_at=excluded.created_at",
                params![account_id.to_string(), mutation_id, serialized, Utc::now().to_rfc3339()],
            )?;
            envelope
        };
        envelopes.push(envelope);
    }
    transaction.commit()?;
    Ok(envelopes)
}

#[tauri::command]
async fn push_encrypted_mutations(
    state: tauri::State<'_, AppState>,
) -> Result<EncryptedSyncStatus> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.require_unlocked()?;
        let (account_id, access_token) = signed_in_account_and_token(&state)?;
        let account_uuid = Uuid::parse_str(&account_id)
            .map_err(|_| AppError::Invalid("The signed-in account is invalid".into()))?;
        let material = state
            .sync_protection
            .lock()
            .unwrap()
            .key_material(&account_id)?;
        {
            let db = state.db.lock().unwrap();
            let connected_device = db
                .query_row(
                    "SELECT device_id FROM sync_state WHERE account_id=?1",
                    params![account_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            let material_device_id = material.device_id.to_string();
            if connected_device.as_deref() != Some(material_device_id.as_str()) {
                return Err(AppError::Invalid(
                    "Register this device before synchronizing changes".into(),
                ));
            }
        }
        let envelopes = {
            let mut db = state.db.lock().unwrap();
            prepare_sync_outbox(&mut db, account_uuid, &material)?
        };
        if envelopes.is_empty() {
            return encrypted_sync_status(&state, &account_id);
        }
        let client = sync_transport::CloudSyncClient::compiled()?;
        let response = client.push_mutations(&access_token, material.device_id, &envelopes)?;
        if !response.cursor.chars().all(|value| value.is_ascii_digit())
            || response.cursor.len() > 20
            || response.accepted > envelopes.len()
        {
            return Err(AppError::SyncTransport(
                sync_transport::SyncTransportError::InvalidResponse,
            ));
        }
        let mut db = state.db.lock().unwrap();
        let transaction = db.transaction()?;
        let now = Utc::now().to_rfc3339();
        for envelope in &envelopes {
            transaction.execute(
                "INSERT OR IGNORE INTO sync_uploaded_mutations(account_id,mutation_id,uploaded_at) VALUES(?1,?2,?3)",
                params![account_id, envelope.mutation_id.to_string(), now],
            )?;
            transaction.execute(
                "DELETE FROM sync_outbox WHERE account_id=?1 AND mutation_id=?2",
                params![account_id, envelope.mutation_id.to_string()],
            )?;
        }
        transaction.execute(
            "UPDATE sync_state SET last_pushed_at=?2,last_push_cursor=?3 WHERE account_id=?1",
            params![account_id, now, response.cursor],
        )?;
        transaction.commit()?;
        drop(db);
        encrypted_sync_status(&state, &account_id)
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalMutationV2 {
    schema_version: u16,
    entity_type: String,
    entity_id: String,
    operation: String,
    snapshot: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default)]
    set_changes: Vec<SetElementChange>,
}

/// Entity types that are recorded in the local mutation log but deliberately never leave this
/// computer. They have no `canonical_table` mapping, so a peer could not apply them anyway; listing
/// them here is the explicit statement that the omission is a product decision, not an oversight.
///
/// This governs the OUTBOUND direction only. Nothing inbound consults it -- see the note on
/// `ApplyOutcome::Deferred` for why an unmapped incoming type must be staged rather than dropped.
const LOCAL_ONLY_ENTITY_TYPES: [&str; 10] = [
    "plan",
    "plan_block",
    "document",
    "reminder",
    "notification_preferences",
    "integration_connection",
    "scholarship_opportunity",
    "scholarship_application",
    "scholarship_draft",
    "scholarship_story",
];

/// Every entity type that is replicated to other computers, in the form the outbox SQL needs.
const REPLICATED_ENTITY_TYPES: [&str; 14] = [
    "task",
    "assignment",
    "exam",
    "course",
    "commitment",
    "academic_term",
    "instructor",
    "class_meeting_series",
    "academic_calendar_event",
    "student_profile",
    "planning_preferences",
    "availability_rule",
    "import_candidate",
    "source_conflict",
];

/// The single source of truth for "does this entity type participate in sync", derived from the
/// apply-side mapping so the two can never disagree.
fn is_replicated_entity_type(entity_type: &str) -> bool {
    canonical_table(entity_type).is_some()
}

/// A `WHERE entity_type IN (?,?,...)` fragment plus its bind values.
fn replicated_entity_type_filter() -> String {
    let placeholders = REPLICATED_ENTITY_TYPES
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    format!("({placeholders})")
}

fn canonical_table(entity_type: &str) -> Option<(&'static str, &'static str)> {
    match entity_type {
        "task" | "assignment" | "exam" => Some(("tasks", "id")),
        "course" => Some(("courses", "id")),
        "commitment" => Some(("commitments", "id")),
        "academic_term" => Some(("academic_terms", "id")),
        "instructor" => Some(("instructors", "id")),
        "class_meeting_series" => Some(("class_meeting_series", "id")),
        "academic_calendar_event" => Some(("academic_calendar_events", "id")),
        "student_profile" => Some(("student_profiles", "id")),
        "planning_preferences" => Some(("planning_preferences", "profile_id")),
        "availability_rule" => Some(("availability_rules", "id")),
        "import_candidate" => Some(("import_candidates", "id")),
        "source_conflict" => Some(("source_conflicts", "id")),
        _ => None,
    }
}

fn json_sql_value(value: &serde_json::Value) -> rusqlite::types::Value {
    match value {
        serde_json::Value::Null => rusqlite::types::Value::Null,
        serde_json::Value::Bool(value) => rusqlite::types::Value::Integer(i64::from(*value)),
        serde_json::Value::Number(value) => value
            .as_i64()
            .map(rusqlite::types::Value::Integer)
            .or_else(|| value.as_f64().map(rusqlite::types::Value::Real))
            .unwrap_or(rusqlite::types::Value::Null),
        serde_json::Value::String(value) => rusqlite::types::Value::Text(value.clone()),
        value => rusqlite::types::Value::Text(value.to_string()),
    }
}

fn upsert_canonical_snapshot(
    conn: &Connection,
    table: &str,
    id_column: &str,
    entity_id: &str,
    snapshot: &serde_json::Map<String, serde_json::Value>,
) -> Result<()> {
    let mut schema = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let allowed = schema
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<std::collections::HashSet<_>, _>>()?;
    if snapshot.get(id_column).and_then(|value| value.as_str()) != Some(entity_id) {
        return Err(AppError::Invalid(
            "A synchronized snapshot has a mismatched entity ID".into(),
        ));
    }
    let mut columns = snapshot
        .keys()
        .filter(|column| allowed.contains(*column))
        .cloned()
        .collect::<Vec<_>>();
    columns.sort();
    if columns.is_empty() || !columns.iter().any(|column| column == id_column) {
        return Err(AppError::Invalid(
            "A synchronized snapshot has no canonical columns".into(),
        ));
    }
    let quoted = columns
        .iter()
        .map(|column| format!("\"{column}\""))
        .collect::<Vec<_>>();
    let placeholders = (1..=columns.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>();
    let updates = quoted
        .iter()
        .filter(|column| column.as_str() != format!("\"{id_column}\"").as_str())
        .map(|column| format!("{column}=excluded.{column}"))
        .collect::<Vec<_>>();
    let sql = format!(
        "INSERT INTO {table}({}) VALUES({}) ON CONFLICT(\"{id_column}\") DO UPDATE SET {}",
        quoted.join(","),
        placeholders.join(","),
        updates.join(",")
    );
    let values = columns
        .iter()
        .map(|column| json_sql_value(&snapshot[column]))
        .collect::<Vec<_>>();
    conn.execute(&sql, rusqlite::params_from_iter(values))?;
    Ok(())
}

fn sync_conflict(
    conn: &Connection,
    entity_type: &str,
    entity_id: &str,
    current_due: Option<String>,
    proposed_due: Option<String>,
    current_start: Option<String>,
    proposed_start: Option<String>,
    current_end: Option<String>,
    proposed_end: Option<String>,
) -> Result<()> {
    conn.execute(
        "INSERT INTO source_conflicts(
           id,description,resolved,kind,entity_type,entity_id,current_due_at,proposed_due_at,
           current_starts_at,proposed_starts_at,current_ends_at,proposed_ends_at,detected_at)
         VALUES(?1,'Another device changed a critical academic date',0,'sync_critical_date',?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![Uuid::new_v4().to_string(), entity_type, entity_id, current_due, proposed_due, current_start, proposed_start, current_end, proposed_end, Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

fn detect_stale_critical_conflict(
    conn: &Connection,
    entity_type: &str,
    entity_id: &str,
    snapshot: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Result<()> {
    let Some(snapshot) = snapshot else {
        return Ok(());
    };
    match entity_type {
        "task" | "assignment" | "exam" => {
            let current = conn
                .query_row(
                    "SELECT due_at FROM tasks WHERE id=?1",
                    params![entity_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?;
            let proposed = snapshot
                .get("due_at")
                .and_then(|value| value.as_str())
                .map(str::to_owned);
            if current
                .as_ref()
                .is_some_and(|value| value.as_deref() != proposed.as_deref())
            {
                sync_conflict(
                    conn,
                    entity_type,
                    entity_id,
                    current.flatten(),
                    proposed,
                    None,
                    None,
                    None,
                    None,
                )?;
            }
        }
        "commitment" | "academic_term" => {
            let (table, start_column, end_column) = if entity_type == "commitment" {
                ("commitments", "starts_at", "ends_at")
            } else {
                ("academic_terms", "starts_on", "ends_on")
            };
            let current = conn
                .query_row(
                    &format!("SELECT {start_column},{end_column} FROM {table} WHERE id=?1"),
                    params![entity_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?;
            let proposed_start = snapshot
                .get(start_column)
                .and_then(|value| value.as_str())
                .map(str::to_owned);
            let proposed_end = snapshot
                .get(end_column)
                .and_then(|value| value.as_str())
                .map(str::to_owned);
            if current.as_ref().is_some_and(|(start, end)| {
                Some(start.as_str()) != proposed_start.as_deref()
                    || Some(end.as_str()) != proposed_end.as_deref()
            }) {
                let (start, end) = current.unwrap();
                sync_conflict(
                    conn,
                    entity_type,
                    entity_id,
                    None,
                    None,
                    Some(start),
                    proposed_start,
                    Some(end),
                    proposed_end,
                )?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn apply_task_dependency_changes(
    conn: &Connection,
    entity_id: &str,
    changes: &[SetElementChange],
    hlc: &str,
    device_id: &str,
) -> Result<()> {
    if changes.len() > 2_000 {
        return Err(AppError::Invalid(
            "A synchronized set mutation is too large".into(),
        ));
    }
    for change in changes {
        if change.field_name != "dependencies"
            || Uuid::parse_str(&change.element_id).is_err()
            || change.element_id == entity_id
        {
            return Err(AppError::Invalid(
                "A synchronized dependency change is invalid".into(),
            ));
        }
        conn.execute(
            "INSERT INTO sync_set_elements(entity_type,entity_id,field_name,element_id,hlc,device_id,tombstone)
             VALUES('task',?1,'dependencies',?2,?3,?4,?5)
             ON CONFLICT(entity_type,entity_id,field_name,element_id) DO UPDATE SET
               hlc=excluded.hlc,device_id=excluded.device_id,tombstone=excluded.tombstone
             WHERE sync_set_elements.hlc<excluded.hlc
                OR (sync_set_elements.hlc=excluded.hlc AND sync_set_elements.device_id<excluded.device_id)",
            params![entity_id, change.element_id, hlc, device_id, i64::from(change.tombstone)],
        )?;
    }
    rebuild_task_dependencies_from_set(conn, entity_id)
}

fn rebuild_task_dependencies_from_set(conn: &Connection, entity_id: &str) -> Result<()> {
    if conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1)",
        params![entity_id],
        |row| row.get::<_, i64>(0),
    )? == 0
    {
        return Ok(());
    }
    conn.execute(
        "DELETE FROM task_dependencies WHERE task_id=?1",
        params![entity_id],
    )?;
    conn.execute(
        "INSERT INTO task_dependencies(task_id,depends_on_task_id,created_at)
         SELECT ?1,element_id,?2 FROM sync_set_elements
         WHERE entity_type='task' AND entity_id=?1 AND field_name='dependencies' AND tombstone=0
           AND element_id<>?1 AND EXISTS(SELECT 1 FROM tasks WHERE id=element_id)
         ORDER BY element_id",
        params![entity_id, Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

/// What happened to one downloaded mutation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ApplyOutcome {
    /// Merged into a canonical table; the version register now reflects it.
    Applied,
    /// A newer local write already wins; the register is left alone.
    Superseded,
    /// This build has no mapping for the entity type, so it is stored verbatim and retried after an
    /// upgrade. Crucially this is NOT the same as "declared local-only": inbound classification must
    /// stay two-valued, or a build that predates a type becoming replicated would silently discard
    /// a peer's real records instead of holding them.
    Deferred,
}

impl ApplyOutcome {
    fn as_str(self) -> &'static str {
        match self {
            ApplyOutcome::Applied => "applied",
            ApplyOutcome::Superseded => "superseded",
            ApplyOutcome::Deferred => "deferred_unknown_type",
        }
    }
}

/// Record a peer computer's public keys, pinning them on first use.
///
/// The signing key arrives from the server, so accepting a replacement would let a hostile or
/// compromised server swap in its own key and defeat signature verification entirely. A changed key
/// is therefore an error the student must resolve by re-approving the computer.
fn upsert_peer_device(
    conn: &Connection,
    account_id: &str,
    device: &sync_transport::PendingDevice,
) -> Result<()> {
    let existing = conn
        .query_row(
            "SELECT signing_public_key FROM sync_devices WHERE account_id=?1 AND device_id=?2",
            params![account_id, device.device_id.to_string()],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if existing
        .as_deref()
        .is_some_and(|pinned| pinned != device.signing_public_key)
    {
        return Err(AppError::Invalid(
            "A paired computer's signing key changed. Remove and re-approve that computer before synchronizing.".into(),
        ));
    }
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO sync_devices(account_id,device_id,public_key,signing_public_key,display_name,platform,authorized,revoked,first_seen_at,refreshed_at)
         VALUES(?1,?2,?3,?4,?5,?6,1,0,?7,?7)
         ON CONFLICT(account_id,device_id) DO UPDATE SET
           public_key=excluded.public_key,display_name=excluded.display_name,
           platform=excluded.platform,authorized=1,refreshed_at=excluded.refreshed_at",
        params![
            account_id,
            device.device_id.to_string(),
            device.public_key,
            device.signing_public_key,
            device.display_name,
            device.platform,
            now
        ],
    )?;
    Ok(())
}

fn peer_signing_key(conn: &Connection, account_id: &str, device_id: Uuid) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT signing_public_key FROM sync_devices WHERE account_id=?1 AND device_id=?2",
            params![account_id, device_id.to_string()],
            |row| row.get::<_, String>(0),
        )
        .optional()?)
}

fn apply_canonical_mutation(
    conn: &Connection,
    envelope: &sync_transport::EncryptedMutation,
    plaintext: &sync_transport::DecryptedMutation,
) -> Result<ApplyOutcome> {
    let payload: CanonicalMutationV2 = serde_json::from_str(&plaintext.payload)
        .map_err(|_| AppError::Invalid("A synchronized canonical payload is invalid".into()))?;
    if payload.schema_version != 2
        || payload.entity_type != envelope.entity_type
        || payload.entity_id != envelope.entity_id.to_string()
        || payload.operation != plaintext.operation
        || payload.snapshot.is_none() != envelope.tombstone
    {
        return Err(AppError::Invalid(
            "A synchronized payload does not match its authenticated envelope".into(),
        ));
    }
    observe_hybrid_logical_timestamp(conn, &envelope.logical_timestamp)?;
    if envelope.entity_type == "task" {
        apply_task_dependency_changes(
            conn,
            &envelope.entity_id.to_string(),
            &payload.set_changes,
            &envelope.logical_timestamp,
            &envelope.device_id.to_string(),
        )?;
    } else if !payload.set_changes.is_empty() {
        return Err(AppError::Invalid(
            "A synchronized non-task payload contains set changes".into(),
        ));
    }
    let incoming_key = (&envelope.logical_timestamp, envelope.device_id.to_string());
    let current = conn
        .query_row(
            "SELECT hlc,device_id FROM sync_entity_versions WHERE entity_type=?1 AND entity_id=?2",
            params![envelope.entity_type, envelope.entity_id.to_string()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    if current
        .as_ref()
        .is_some_and(|(hlc, device)| (hlc, device) >= (&incoming_key.0, &incoming_key.1))
    {
        detect_stale_critical_conflict(
            conn,
            &envelope.entity_type,
            &envelope.entity_id.to_string(),
            payload.snapshot.as_ref(),
        )?;
        return Ok(ApplyOutcome::Superseded);
    }

    // No mapping means this build does not understand the type yet. Return before the register is
    // touched, so the mutation can be replayed verbatim once a later build does understand it.
    let Some((table, id_column)) = canonical_table(&envelope.entity_type) else {
        return Ok(ApplyOutcome::Deferred);
    };
    if envelope.tombstone {
        if envelope.entity_type == "task" {
            let completed = conn
                .query_row(
                    "SELECT completed FROM tasks WHERE id=?1",
                    params![envelope.entity_id.to_string()],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .unwrap_or(0);
            if completed == 0 {
                conn.execute(
                    "DELETE FROM tasks WHERE id=?1",
                    params![envelope.entity_id.to_string()],
                )?;
            }
        } else {
            conn.execute(
                &format!("DELETE FROM {table} WHERE {id_column}=?1"),
                params![envelope.entity_id.to_string()],
            )?;
        }
    } else if let Some(mut snapshot) = payload.snapshot {
        if envelope.entity_type == "task" {
            let current = conn
                .query_row(
                    "SELECT due_at,completed FROM tasks WHERE id=?1",
                    params![envelope.entity_id.to_string()],
                    |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()?;
            let proposed_due = snapshot
                .get("due_at")
                .and_then(|value| value.as_str())
                .map(str::to_owned);
            if let Some((current_due, completed)) = current {
                if current_due != proposed_due {
                    sync_conflict(
                        conn,
                        &envelope.entity_type,
                        &envelope.entity_id.to_string(),
                        current_due.clone(),
                        proposed_due.clone(),
                        None,
                        None,
                        None,
                        None,
                    )?;
                    snapshot.insert(
                        "due_at".into(),
                        current_due
                            .map(serde_json::Value::String)
                            .unwrap_or(serde_json::Value::Null),
                    );
                    if completed != 0 {
                        snapshot.insert("completed".into(), 1.into());
                    }
                    upsert_canonical_snapshot(
                        conn,
                        table,
                        id_column,
                        &envelope.entity_id.to_string(),
                        &snapshot,
                    )?;
                } else {
                    if completed != 0 {
                        snapshot.insert("completed".into(), 1.into());
                    }
                    upsert_canonical_snapshot(
                        conn,
                        table,
                        id_column,
                        &envelope.entity_id.to_string(),
                        &snapshot,
                    )?;
                }
            } else {
                upsert_canonical_snapshot(
                    conn,
                    table,
                    id_column,
                    &envelope.entity_id.to_string(),
                    &snapshot,
                )?;
            }
            rebuild_task_dependencies_from_set(conn, &envelope.entity_id.to_string())?;
        } else if envelope.entity_type == "commitment" {
            let current = conn
                .query_row(
                    "SELECT starts_at,ends_at FROM commitments WHERE id=?1",
                    params![envelope.entity_id.to_string()],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?;
            let proposed_start = snapshot
                .get("starts_at")
                .and_then(|value| value.as_str())
                .map(str::to_owned);
            let proposed_end = snapshot
                .get("ends_at")
                .and_then(|value| value.as_str())
                .map(str::to_owned);
            if current.as_ref().is_some_and(|(start, end)| {
                Some(start.as_str()) != proposed_start.as_deref()
                    || Some(end.as_str()) != proposed_end.as_deref()
            }) {
                let (start, end) = current.unwrap();
                sync_conflict(
                    conn,
                    &envelope.entity_type,
                    &envelope.entity_id.to_string(),
                    None,
                    None,
                    Some(start.clone()),
                    proposed_start.clone(),
                    Some(end.clone()),
                    proposed_end.clone(),
                )?;
                snapshot.insert("starts_at".into(), start.into());
                snapshot.insert("ends_at".into(), end.into());
                upsert_canonical_snapshot(
                    conn,
                    table,
                    id_column,
                    &envelope.entity_id.to_string(),
                    &snapshot,
                )?;
            } else {
                upsert_canonical_snapshot(
                    conn,
                    table,
                    id_column,
                    &envelope.entity_id.to_string(),
                    &snapshot,
                )?;
            }
        } else if envelope.entity_type == "academic_term" {
            let current = conn
                .query_row(
                    "SELECT starts_on,ends_on FROM academic_terms WHERE id=?1",
                    params![envelope.entity_id.to_string()],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?;
            let proposed_start = snapshot
                .get("starts_on")
                .and_then(|value| value.as_str())
                .map(str::to_owned);
            let proposed_end = snapshot
                .get("ends_on")
                .and_then(|value| value.as_str())
                .map(str::to_owned);
            if current.as_ref().is_some_and(|(start, end)| {
                Some(start.as_str()) != proposed_start.as_deref()
                    || Some(end.as_str()) != proposed_end.as_deref()
            }) {
                let (start, end) = current.unwrap();
                sync_conflict(
                    conn,
                    &envelope.entity_type,
                    &envelope.entity_id.to_string(),
                    None,
                    None,
                    Some(start.clone()),
                    proposed_start.clone(),
                    Some(end.clone()),
                    proposed_end.clone(),
                )?;
                snapshot.insert("starts_on".into(), start.into());
                snapshot.insert("ends_on".into(), end.into());
            }
            upsert_canonical_snapshot(
                conn,
                table,
                id_column,
                &envelope.entity_id.to_string(),
                &snapshot,
            )?;
        } else {
            upsert_canonical_snapshot(
                conn,
                table,
                id_column,
                &envelope.entity_id.to_string(),
                &snapshot,
            )?;
        }
    }
    conn.execute(
        "INSERT INTO sync_entity_versions(entity_type,entity_id,hlc,device_id,tombstone,mutation_id)
         VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(entity_type,entity_id) DO UPDATE SET
           hlc=excluded.hlc,device_id=excluded.device_id,tombstone=excluded.tombstone,mutation_id=excluded.mutation_id",
        params![envelope.entity_type, envelope.entity_id.to_string(), envelope.logical_timestamp, envelope.device_id.to_string(), i64::from(envelope.tombstone), envelope.mutation_id.to_string()],
    )?;
    Ok(ApplyOutcome::Applied)
}

/// Retry mutations held back by an earlier build that did not recognize their entity type.
///
/// Ordering by (logical_timestamp, device_id) reproduces the live last-writer-wins tie-break
/// exactly, so a drained backlog converges to the same state as if it had been applied on arrival.
fn drain_deferred_mutations(conn: &Connection, account_id: &str) -> Result<usize> {
    let deferred = {
        let mut statement = conn.prepare(
            "SELECT mutation_id,envelope,operation,payload FROM sync_received_mutations
             WHERE account_id=?1 AND outcome='deferred_unknown_type'
             ORDER BY logical_timestamp,device_id,mutation_id",
        )?;
        let rows = statement
            .query_map(params![account_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    let mut drained = 0_usize;
    for (mutation_id, serialized, operation, payload) in deferred {
        let envelope: sync_transport::EncryptedMutation = serde_json::from_str(&serialized)
            .map_err(|_| AppError::Invalid("A staged sync envelope is invalid".into()))?;
        let plaintext = sync_transport::DecryptedMutation { operation, payload };
        let outcome = apply_canonical_mutation(conn, &envelope, &plaintext)?;
        if outcome == ApplyOutcome::Deferred {
            continue;
        }
        conn.execute(
            "UPDATE sync_received_mutations SET outcome=?3,applied=1 WHERE account_id=?1 AND mutation_id=?2",
            params![account_id, mutation_id, outcome.as_str()],
        )?;
        drained += 1;
    }
    Ok(drained)
}

#[tauri::command]
async fn pull_encrypted_mutations(
    state: tauri::State<'_, AppState>,
) -> Result<EncryptedSyncStatus> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.require_unlocked()?;
        let (account_id, access_token) = signed_in_account_and_token(&state)?;
        let account_uuid = Uuid::parse_str(&account_id)
            .map_err(|_| AppError::Invalid("The signed-in account is invalid".into()))?;
        let material = state
            .sync_protection
            .lock()
            .unwrap()
            .key_material(&account_id)?;
        let mut cursor = {
            let db = state.db.lock().unwrap();
            let row = db
                .query_row(
                    "SELECT device_id,last_pull_cursor FROM sync_state WHERE account_id=?1",
                    params![account_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?;
            let Some((connected_device, cursor)) = row else {
                return Err(AppError::Invalid(
                    "Register this device before synchronizing changes".into(),
                ));
            };
            if connected_device != material.device_id.to_string() {
                return Err(AppError::Invalid(
                    "Register this device before synchronizing changes".into(),
                ));
            }
            cursor
        };
        let client = sync_transport::CloudSyncClient::compiled()?;
        // Warm the pinned peer-key cache before pulling, so a newly approved computer's first
        // mutations can be verified without a mid-loop round trip.
        let peers = client.authorized_devices(&access_token, material.device_id)?;
        {
            let db = state.db.lock().unwrap();
            for peer in &peers {
                upsert_peer_device(&db, &account_id, peer)?;
            }
        }
        {
            // Anything an earlier build could not understand may be applicable now.
            let mut db = state.db.lock().unwrap();
            let transaction = db.transaction()?;
            if drain_deferred_mutations(&transaction, &account_id)? > 0 {
                regenerate_plan(&transaction, None)?;
            }
            transaction.commit()?;
        }
        for _ in 0..10 {
            let response =
                client.pull_mutations(&access_token, material.device_id, &cursor, 500)?;
            let previous_cursor = cursor
                .parse::<u64>()
                .map_err(|_| AppError::Invalid("The local sync cursor is invalid".into()))?;
            let next_cursor = response
                .cursor
                .parse::<u64>()
                .map_err(|_| AppError::SyncTransport(sync_transport::SyncTransportError::InvalidResponse))?;
            if next_cursor < previous_cursor || response.mutations.len() > 500 {
                return Err(AppError::SyncTransport(
                    sync_transport::SyncTransportError::InvalidResponse,
                ));
            }
            let mut decoded = Vec::with_capacity(response.mutations.len());
            for envelope in response.mutations {
                let signing_key = {
                    let db = state.db.lock().unwrap();
                    peer_signing_key(&db, &account_id, envelope.device_id)?
                };
                // A mutation from a computer whose key we have never pinned cannot be verified.
                // Stop without advancing the cursor rather than trusting it or dropping it.
                let Some(signing_key) = signing_key else {
                    return Err(AppError::Invalid(
                        "A change arrived from a computer this profile has not paired with. Approve that computer, then synchronize again.".into(),
                    ));
                };
                let plaintext = sync_transport::decrypt_mutation(
                    &material.account_key,
                    account_uuid,
                    &signing_key,
                    &envelope,
                )?;
                let serialized = serde_json::to_string(&envelope).map_err(|_| {
                    AppError::Invalid("A downloaded sync envelope could not be encoded".into())
                })?;
                decoded.push((envelope, plaintext, serialized));
            }
            {
                let mut db = state.db.lock().unwrap();
                let transaction = db.transaction()?;
                let now = Utc::now().to_rfc3339();
                for (envelope, plaintext, serialized) in decoded {
                    let mutation_id = envelope.mutation_id.to_string();
                    let existing = transaction
                        .query_row(
                            "SELECT envelope FROM sync_received_mutations WHERE account_id=?1 AND mutation_id=?2",
                            params![account_id, mutation_id],
                            |row| row.get::<_, String>(0),
                        )
                        .optional()?;
                    if existing.as_deref().is_some_and(|value| value != serialized) {
                        return Err(AppError::Invalid(
                            "A downloaded mutation ID was reused with different ciphertext".into(),
                        ));
                    }
                    let already_local = transaction.query_row(
                        "SELECT EXISTS(SELECT 1 FROM mutations WHERE id=?1)",
                        params![mutation_id],
                        |row| row.get::<_, i64>(0),
                    )? != 0;
                    let outcome = if already_local {
                        ApplyOutcome::Applied
                    } else {
                        apply_canonical_mutation(&transaction, &envelope, &plaintext)?
                    };
                    transaction.execute(
                        "INSERT OR IGNORE INTO sync_received_mutations(account_id,mutation_id,envelope,operation,payload,received_at,applied,outcome,entity_type,logical_timestamp,device_id)
                         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                        params![
                            account_id,
                            mutation_id,
                            serialized,
                            plaintext.operation,
                            plaintext.payload,
                            now,
                            i64::from(outcome != ApplyOutcome::Deferred),
                            outcome.as_str(),
                            envelope.entity_type,
                            envelope.logical_timestamp,
                            envelope.device_id.to_string()
                        ],
                    )?;
                }
                regenerate_plan(&transaction, None)?;
                transaction.execute(
                    "UPDATE sync_state SET last_pull_cursor=?2 WHERE account_id=?1",
                    params![account_id, response.cursor],
                )?;
                transaction.commit()?;
            }
            cursor = response.cursor;
            if !response.has_more {
                break;
            }
        }
        encrypted_sync_status(&state, &account_id)
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

#[tauri::command]
async fn upload_synced_document(
    state: tauri::State<'_, AppState>,
    document_id: String,
) -> Result<bool> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let document_uuid = Uuid::parse_str(&document_id)
            .map_err(|_| AppError::Invalid("The document ID is invalid".into()))?;
        let (account_id, access_token) = signed_in_account_and_token(&state)?;
        let material = state
            .sync_protection
            .lock()
            .unwrap()
            .key_material(&account_id)?;
        let (metadata, wrapped_key, key_nonce, vault_path) = {
            let db = state.db.lock().unwrap();
            db.query_row(
                "SELECT file_name,mime,content_nonce,sha256,imported_at,extraction_status,extraction_error,wrapped_key,key_nonce,vault_path FROM documents WHERE id=?1",
                params![document_id],
                |row| {
                    Ok((
                        SyncedDocumentMetadata { file_name: row.get(0)?, mime: row.get(1)?, content_nonce: row.get(2)?, sha256: row.get(3)?, imported_at: row.get(4)?, extraction_status: row.get(5)?, extraction_error: row.get(6)? },
                        row.get::<_, String>(7)?, row.get::<_, String>(8)?, row.get::<_, String>(9)?,
                    ))
                },
            )?
        };
        let document_key = decrypt(
            &state.master_key,
            &decode_nonce(&key_nonce)?,
            &B64.decode(wrapped_key).map_err(|_| AppError::Crypto)?,
        )?;
        let document_key: [u8; 32] = document_key.try_into().map_err(|_| AppError::Crypto)?;
        let encrypted_file = fs::read(vault_path)?;
        let object = sync_transport::prepare_encrypted_object(
            &material.account_key,
            document_uuid,
            &serde_json::to_vec(&metadata).map_err(|_| AppError::Crypto)?,
            &document_key,
            &encrypted_file,
        )?;
        sync_transport::CloudSyncClient::compiled()?.upload_object(
            &access_token,
            material.device_id,
            &object,
        )?;
        Ok(true)
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

#[tauri::command]
async fn download_synced_document(
    state: tauri::State<'_, AppState>,
    document_id: String,
) -> Result<bool> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let document_uuid = Uuid::parse_str(&document_id)
            .map_err(|_| AppError::Invalid("The document ID is invalid".into()))?;
        let (account_id, access_token) = signed_in_account_and_token(&state)?;
        let material = state
            .sync_protection
            .lock()
            .unwrap()
            .key_material(&account_id)?;
        let download = sync_transport::CloudSyncClient::compiled()?.download_object(
            &access_token,
            material.device_id,
            document_uuid,
        )?;
        let (metadata, document_key, encrypted_file) =
            sync_transport::open_encrypted_object(&material.account_key, &download)?;
        let metadata: SyncedDocumentMetadata = serde_json::from_slice(&metadata)
            .map_err(|_| AppError::Invalid("Encrypted document metadata is invalid".into()))?;
        if metadata.file_name.trim().is_empty()
            || metadata.file_name.len() > 255
            || Path::new(&metadata.file_name).file_name().and_then(|value| value.to_str())
                != Some(metadata.file_name.as_str())
            || metadata.mime.len() > 200
            || !metadata.sha256.chars().all(|value| value.is_ascii_hexdigit())
        {
            return Err(AppError::Invalid(
                "Encrypted document metadata is outside accepted limits".into(),
            ));
        }
        let plain = decrypt(
            &*document_key,
            &decode_nonce(&metadata.content_nonce)?,
            &encrypted_file,
        )?;
        if hex::encode(Sha256::digest(&plain)) != metadata.sha256.to_ascii_lowercase() {
            return Err(AppError::Crypto);
        }
        let existing = state
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT sha256 FROM documents WHERE id=?1",
                params![document_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if existing.as_deref().is_some_and(|sha| sha != metadata.sha256) {
            return Err(AppError::Invalid(
                "A local document already uses this ID with different content".into(),
            ));
        }
        let vault_path = state.vault.join(format!("{document_id}.vault"));
        let temporary = state.vault.join(format!(".{document_id}.syncing"));
        fs::write(&temporary, &encrypted_file)?;
        fs::rename(&temporary, &vault_path)?;
        let (wrapped, nonce) = encrypt(&state.master_key, &*document_key)?;
        let db = state.db.lock().unwrap();
        db.execute(
            "INSERT OR IGNORE INTO documents(id,file_name,mime,vault_path,wrapped_key,key_nonce,content_nonce,sha256,imported_at,extraction_status,extraction_error)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![document_id, metadata.file_name, metadata.mime, vault_path.to_string_lossy(), B64.encode(wrapped), B64.encode(nonce), metadata.content_nonce, metadata.sha256, metadata.imported_at, metadata.extraction_status, metadata.extraction_error],
        )?;
        Ok(true)
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

#[tauri::command]
fn start_google_sign_in(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<auth::AccountStatus> {
    state.require_unlocked()?;
    let start = state.account.lock().unwrap().begin_google_sign_in()?;
    if let Err(error) = app
        .opener()
        .open_url(start.authorize_url.as_str(), None::<&str>)
    {
        state.account.lock().unwrap().cancel_google_sign_in(
            "The system browser could not be opened. Google sign-in was canceled.",
        );
        return Err(AppError::Background(error.to_string()));
    }
    Ok(start.status)
}

#[tauri::command]
fn cancel_google_sign_in(state: tauri::State<AppState>) -> Result<auth::AccountStatus> {
    state.require_unlocked()?;
    Ok(state
        .account
        .lock()
        .unwrap()
        .cancel_google_sign_in("Google sign-in canceled. You can use an email code instead."))
}

#[tauri::command]
async fn request_email_code(
    state: tauri::State<'_, AppState>,
    email: String,
) -> Result<auth::EmailCodeStatus> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.require_unlocked()?;
        Ok(state.account.lock().unwrap().request_email_code(&email)?)
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

#[tauri::command]
async fn verify_email_code(
    state: tauri::State<'_, AppState>,
    email: String,
    code: String,
) -> Result<auth::AccountStatus> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.require_unlocked()?;
        Ok(state
            .account
            .lock()
            .unwrap()
            .verify_email_code(&email, &code)?)
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

#[tauri::command]
async fn refresh_account_session(state: tauri::State<'_, AppState>) -> Result<auth::AccountStatus> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.require_unlocked()?;
        Ok(state.account.lock().unwrap().refresh()?)
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

#[tauri::command]
async fn sign_out_account(state: tauri::State<'_, AppState>) -> Result<auth::AccountStatus> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.require_unlocked()?;
        state.sync_protection.lock().unwrap().cancel();
        Ok(state.account.lock().unwrap().sign_out()?)
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

#[tauri::command]
async fn check_for_updates(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<UpdateStatus> {
    state.require_unlocked()?;
    let Some((endpoint, public_key)) = compiled_updater_configuration() else {
        return Ok(updater_status(&app));
    };
    let updater = app
        .updater_builder()
        .pubkey(public_key)
        .endpoints(vec![endpoint])
        .map_err(|error| AppError::Background(error.to_string()))?
        .build()
        .map_err(|error| AppError::Background(error.to_string()))?;
    let update = updater
        .check()
        .await
        .map_err(|error| AppError::Background(error.to_string()))?;
    let checked_at = Some(Utc::now().to_rfc3339());
    Ok(match update {
        Some(update) => UpdateStatus {
            configured: true,
            current_version: app.package_info().version.to_string(),
            available: true,
            latest_version: Some(update.version),
            notes: update.body,
            checked_at,
            message: "A signed Student Center update is available.".into(),
        },
        None => UpdateStatus {
            configured: true,
            current_version: app.package_info().version.to_string(),
            available: false,
            latest_version: None,
            notes: None,
            checked_at,
            message: "Student Center is up to date.".into(),
        },
    })
}

#[tauri::command]
async fn install_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    expected_version: String,
    confirmed: bool,
) -> Result<()> {
    state.require_unlocked()?;
    if !confirmed {
        return Err(AppError::Invalid(
            "Confirm the signed update and restart before installing.".into(),
        ));
    }
    let expected_version = expected_version.trim();
    if expected_version.is_empty() || expected_version.len() > 64 {
        return Err(AppError::Invalid(
            "Check for updates again before installing.".into(),
        ));
    }
    let Some((endpoint, public_key)) = compiled_updater_configuration() else {
        return Err(AppError::Invalid(
            "This build has no signed update channel configured.".into(),
        ));
    };
    let updater = app
        .updater_builder()
        .pubkey(public_key)
        .endpoints(vec![endpoint])
        .map_err(|_| AppError::Background("Signed update configuration is invalid.".into()))?
        .build()
        .map_err(|_| AppError::Background("Signed update configuration is invalid.".into()))?;
    let update = updater
        .check()
        .await
        .map_err(|_| AppError::Background("The signed update channel could not be checked.".into()))?
        .ok_or_else(|| AppError::Invalid("Student Center is already up to date.".into()))?;
    if update.version != expected_version {
        return Err(AppError::Invalid(
            "The available version changed. Review the new update before installing.".into(),
        ));
    }
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|_| {
            AppError::Background(
                "The signed update could not be downloaded or installed safely.".into(),
            )
        })?;
    app.restart()
}

#[tauri::command]
fn add_task(
    state: tauri::State<AppState>,
    title: String,
    minutes: i64,
    due_at: Option<String>,
    course_id: Option<String>,
) -> Result<Dashboard> {
    state.require_unlocked()?;
    let db = state.db.lock().unwrap();
    insert_task(&db, &title, minutes, due_at.as_deref(), course_id.as_deref())?;
    regenerate_plan(&db, None)?;
    dashboard(&db, &state.ocr)
}

#[tauri::command]
fn toggle_task(state: tauri::State<AppState>, id: String) -> Result<Dashboard> {
    state.require_unlocked()?;
    let db = state.db.lock().unwrap();
    let completed: i64 = db
        .query_row(
            "SELECT completed FROM tasks WHERE id=?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::Invalid("task not found".into()))?;
    db.execute(
        "UPDATE tasks SET completed=?2,version=version+1 WHERE id=?1",
        params![id, 1 - completed],
    )?;
    db.execute(
        "UPDATE plan_blocks SET completed=?2 WHERE task_id=?1",
        params![id, 1 - completed],
    )?;
    mutation(&db, "task", &id, "completion_changed", "{}")?;
    dashboard(&db, &state.ocr)
}

#[tauri::command]
fn replan(
    state: tauri::State<AppState>,
    effective_time: String,
    reason: String,
) -> Result<Dashboard> {
    state.require_unlocked()?;
    let effective = parse_rfc3339(&effective_time)
        .ok_or_else(|| AppError::Invalid("effective time must be RFC 3339".into()))?;
    let normalized_reason = reason.to_ascii_lowercase();
    let trigger = if normalized_reason.contains("woke") || normalized_reason.contains("late") {
        planner::PlannerTrigger::LateWakeUp
    } else if normalized_reason.contains("longer") || normalized_reason.contains("overrun") {
        planner::PlannerTrigger::TaskOverrun
    } else if normalized_reason.contains("energy") {
        planner::PlannerTrigger::LowEnergy
    } else if normalized_reason.contains("cancel") {
        planner::PlannerTrigger::CommitmentCanceled
    } else if normalized_reason.contains("deadline") {
        planner::PlannerTrigger::DeadlineChanged
    } else {
        planner::PlannerTrigger::Initial
    };
    let db = state.db.lock().unwrap();
    regenerate_plan_for_trigger(&db, Some(effective), trigger)?;
    mutation(
        &db,
        "plan",
        TODAY_PLAN_ENTITY_ID,
        "replanned",
        &serde_json::json!({ "reason": reason }).to_string(),
    )?;
    dashboard(&db, &state.ocr)
}

#[tauri::command]
fn update_notification_settings(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    enabled: bool,
    lead_minutes: i64,
    quiet_start: String,
    quiet_end: String,
    show_titles: bool,
) -> Result<Dashboard> {
    state.require_unlocked()?;
    if !(1..=120).contains(&lead_minutes) {
        return Err(AppError::Invalid(
            "reminder lead time must be between 1 and 120 minutes".into(),
        ));
    }
    if parse_clock(&quiet_start).is_none() || parse_clock(&quiet_end).is_none() {
        return Err(AppError::Invalid(
            "quiet hours must use 24-hour HH:MM values".into(),
        ));
    }
    let permission_granted = if enabled {
        matches!(
            app.notification()
                .request_permission()
                .map_err(|error| AppError::Background(error.to_string()))?,
            PermissionState::Granted
        )
    } else {
        matches!(
            app.notification()
                .permission_state()
                .map_err(|error| AppError::Background(error.to_string()))?,
            PermissionState::Granted
        )
    };
    if enabled && !permission_granted {
        return Err(AppError::Invalid(
            "notification permission was not granted by the operating system".into(),
        ));
    }
    let db = state.db.lock().unwrap();
    for (key, value) in [
        ("notifications_enabled", enabled.to_string()),
        ("notification_lead_minutes", lead_minutes.to_string()),
        ("notification_quiet_start", quiet_start),
        ("notification_quiet_end", quiet_end),
        ("notification_show_titles", show_titles.to_string()),
    ] {
        db.execute(
            "INSERT INTO settings(key,value) VALUES(?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )?;
    }
    mutation(
        &db,
        "notification_preferences",
        NOTIFICATION_PREFERENCES_ENTITY_ID,
        "updated",
        &serde_json::json!({
            "enabled": enabled,
            "leadMinutes": lead_minutes,
            "quietStart": db_setting(&db, "notification_quiet_start", "22:00"),
            "quietEnd": db_setting(&db, "notification_quiet_end", "07:00"),
            "showTitles": show_titles
        })
        .to_string(),
    )?;
    dashboard(&db, &state.ocr)
}

#[tauri::command]
fn start_plan_block(state: tauri::State<AppState>, block_id: String) -> Result<Dashboard> {
    state.require_unlocked()?;
    let db = state.db.lock().unwrap();
    let changed = db.execute(
        "UPDATE plan_blocks SET started_at=?2
         WHERE id=?1 AND task_id IS NOT NULL AND completed=0",
        params![block_id, Utc::now().to_rfc3339()],
    )?;
    if changed == 0 {
        return Err(AppError::Invalid(
            "only an unfinished flexible block can be started".into(),
        ));
    }
    mutation(&db, "plan_block", &block_id, "started", "{}")?;
    dashboard(&db, &state.ocr)
}

#[tauri::command]
fn snooze_reminder(
    state: tauri::State<AppState>,
    block_id: String,
    minutes: i64,
) -> Result<Dashboard> {
    state.require_unlocked()?;
    if !(5..=120).contains(&minutes) {
        return Err(AppError::Invalid(
            "a reminder can be snoozed for 5 to 120 minutes".into(),
        ));
    }
    let db = state.db.lock().unwrap();
    let starts_at = db
        .query_row(
            "SELECT starts_at FROM plan_blocks WHERE id=?1 AND task_id IS NOT NULL AND completed=0",
            params![block_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| AppError::Invalid("reminder block not found".into()))?;
    let now = Utc::now();
    db.execute(
        "INSERT INTO reminder_deliveries(block_id,plan_starts_at,delivered_at,snoozed_until,dismissed_at)
         VALUES(?1,?2,?3,?4,NULL)
         ON CONFLICT(block_id) DO UPDATE SET
           plan_starts_at=excluded.plan_starts_at,
           delivered_at=excluded.delivered_at,
           snoozed_until=excluded.snoozed_until,
           dismissed_at=NULL",
        params![
            block_id,
            starts_at,
            now.to_rfc3339(),
            (now + Duration::minutes(minutes)).to_rfc3339()
        ],
    )?;
    mutation(
        &db,
        "reminder",
        &block_id,
        "snoozed",
        &serde_json::json!({ "minutes": minutes }).to_string(),
    )?;
    dashboard(&db, &state.ocr)
}

#[tauri::command]
fn dismiss_reminder(state: tauri::State<AppState>, block_id: String) -> Result<Dashboard> {
    state.require_unlocked()?;
    let db = state.db.lock().unwrap();
    let starts_at = db
        .query_row(
            "SELECT starts_at FROM plan_blocks WHERE id=?1 AND task_id IS NOT NULL",
            params![block_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| AppError::Invalid("reminder block not found".into()))?;
    let now = Utc::now().to_rfc3339();
    db.execute(
        "INSERT INTO reminder_deliveries(block_id,plan_starts_at,delivered_at,dismissed_at)
         VALUES(?1,?2,?3,?3)
         ON CONFLICT(block_id) DO UPDATE SET
           plan_starts_at=excluded.plan_starts_at,
           delivered_at=excluded.delivered_at,
           snoozed_until=NULL,
           dismissed_at=excluded.dismissed_at",
        params![block_id, starts_at, now],
    )?;
    mutation(&db, "reminder", &block_id, "dismissed", "{}")?;
    dashboard(&db, &state.ocr)
}

fn encrypt(key: &[u8; 32], plain: &[u8]) -> Result<(Vec<u8>, [u8; 24])> {
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| AppError::Crypto)?;
    let mut nonce = [0; 24];
    OsRng.fill_bytes(&mut nonce);
    let encrypted = cipher
        .encrypt(XNonce::from_slice(&nonce), plain)
        .map_err(|_| AppError::Crypto)?;
    Ok((encrypted, nonce))
}

fn decrypt(key: &[u8; 32], nonce: &[u8; 24], encrypted: &[u8]) -> Result<Vec<u8>> {
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| AppError::Crypto)?;
    cipher
        .decrypt(XNonce::from_slice(nonce), encrypted)
        .map_err(|_| AppError::Crypto)
}

/// The name of an existing document with these bytes, if one is still stored.
///
/// A shredded screenshot is deliberately not a duplicate. Its row survives so
/// its evidence still reads, but the image is gone, so answering "this already
/// exists in your vault" would strand a student with nothing to look at and no
/// way to import it again. Re-pasting a screenshot after approving its classes
/// is an ordinary thing to do.
fn duplicate_document_name(conn: &Connection, hash: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT file_name FROM documents
             WHERE sha256=?1 AND vault_path!='' AND content_shredded=0
             ORDER BY imported_at LIMIT 1",
            params![hash],
            |row| row.get::<_, String>(0),
        )
        .optional()?)
}

fn canvas_token_entry(connection_id: &str) -> Result<keyring::Entry> {
    Ok(keyring::Entry::new(
        "app.studentcenter.desktop",
        &format!("canvas-token:{connection_id}"),
    )?)
}

fn canvas_calendar_entry(connection_id: &str) -> Result<keyring::Entry> {
    Ok(keyring::Entry::new("app.studentcenter.desktop", &format!("canvas-calendar-feed:{connection_id}"))?)
}

fn delete_credential_if_present(entry: keyring::Entry) -> Result<()> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn integration_credential_targets(conn: &Connection) -> Result<Vec<(String, String)>> {
    let mut query = conn.prepare(
        "SELECT id,provider FROM integration_connections WHERE provider IN ('canvas','canvas_calendar')",
    )?;
    let targets = query
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(targets)
}

fn remove_integration_credentials(targets: &[(String, String)]) -> Result<()> {
    for (id, provider) in targets {
        let entry = if provider == "canvas" {
            canvas_token_entry(id)?
        } else {
            canvas_calendar_entry(id)?
        };
        delete_credential_if_present(entry)?;
    }
    Ok(())
}

fn persist_canvas_calendar_pull(conn: &Connection, connection_id: &str, pull: &canvas_calendar::FeedPull, run_id: &str) -> Result<usize> {
    let observed_at=Utc::now().to_rfc3339();
    let previous_hash=conn.query_row("SELECT sync_cursor FROM integration_connections WHERE id=?1 AND provider='canvas_calendar'",params![connection_id],|row| row.get::<_,Option<String>>(0)).optional()?.flatten();
    if previous_hash.as_deref()==Some(&pull.hash) {
        conn.execute("UPDATE integration_connections SET status='connected',last_synced_at=?2,last_attempted_at=?2,last_error=NULL WHERE id=?1",params![connection_id,observed_at])?;
        conn.execute("UPDATE integration_sync_runs SET completed_at=?2,status='complete',pulled_count=0,created_count=0 WHERE id=?1",params![run_id,observed_at])?;
        return Ok(0);
    }
    let document_id=format!("canvas-calendar-source:{connection_id}");
    conn.execute("INSERT OR IGNORE INTO documents(id,file_name,mime,vault_path,wrapped_key,key_nonce,content_nonce,sha256,imported_at,extraction_status) VALUES(?1,?2,'text/calendar','','','','',?3,?4,'remote')",
        params![document_id,format!("Canvas calendar · {}",pull.origin),hex::encode(Sha256::digest(pull.origin.as_bytes())),observed_at])?;
    let mut created=0usize;
    for candidate in &pull.candidates {
        let payload=serde_json::json!({"kind":candidate.kind,"title":candidate.title,"course":candidate.course,"dueAt":candidate.due_at,"startsAt":candidate.starts_at,"endsAt":candidate.ends_at,"weekdays":candidate.weekdays,"startsAtLocal":candidate.starts_at_local,"endsAtLocal":candidate.ends_at_local,"timezone":candidate.timezone});
        let payload_text=payload.to_string(); let payload_hash=hex::encode(Sha256::digest(payload_text.as_bytes()));
        let exists=conn.query_row("SELECT EXISTS(SELECT 1 FROM source_objects WHERE connection_id=?1 AND source_uid=?2 AND payload_hash=?3)",params![connection_id,candidate.source_uid,payload_hash],|row| row.get::<_,i64>(0))?!=0;
        if exists { continue; }
        let source_object_id=Uuid::new_v4().to_string();
        conn.execute("INSERT INTO source_objects(id,connection_id,source_type,source_uid,source_url,observed_at,payload_hash,payload) VALUES(?1,?2,'canvas_calendar',?3,?4,?5,?6,?7)",
            params![source_object_id,connection_id,candidate.source_uid,pull.origin,observed_at,payload_hash,payload_text])?;
        let candidate_id=Uuid::new_v4().to_string();
        conn.execute("INSERT INTO import_candidates(id,document_id,source_object_id,kind,title,course,due_at,starts_at,ends_at,duration_minutes,evidence,source_locator,source_type,source_url,source_uid,observed_at,confidence,warnings,weekdays,starts_at_local,ends_at_local,timezone) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'canvas_calendar',?13,?14,?15,?16,?17,?18,?19,?20,?21)",
            params![candidate_id,document_id,source_object_id,candidate.kind,candidate.title,candidate.course,candidate.due_at,candidate.starts_at,candidate.ends_at,candidate.duration_minutes,candidate.evidence,candidate.source_locator,pull.origin,candidate.source_uid,observed_at,candidate.confidence,serde_json::to_string(&candidate.warnings).unwrap_or_else(|_|"[]".into()),serde_json::to_string(&candidate.weekdays).unwrap_or_else(|_|"[]".into()),candidate.starts_at_local,candidate.ends_at_local,candidate.timezone])?;
        candidate_conflict(conn,&candidate_id,candidate)?; created+=1;
    }
    conn.execute("UPDATE integration_connections SET status='connected',account_name='Canvas calendar',last_synced_at=?2,last_attempted_at=?2,last_error=NULL,sync_cursor=?3,version=version+1 WHERE id=?1",params![connection_id,observed_at,pull.hash])?;
    conn.execute("UPDATE integration_sync_runs SET completed_at=?2,status='complete',pulled_count=?3,created_count=?4 WHERE id=?1",params![run_id,observed_at,pull.candidates.len() as i64,created as i64])?;
    mutation(conn,"integration_connection",connection_id,"synced","{}")?;
    Ok(created)
}

fn canvas_calendar_timezone(conn: &Connection) -> Tz {
    conn.query_row("SELECT value FROM settings WHERE key='timezone'",[],|row| row.get::<_,String>(0)).ok().and_then(|value| value.parse().ok()).unwrap_or(chrono_tz::UTC)
}

fn canvas_calendar_notice(prefix: &str, created: usize, pull: &canvas_calendar::FeedPull) -> String {
    let mut message = format!(
        "{prefix}; {created} changed item{} await review.",
        if created == 1 { "" } else { "s" }
    );
    if pull.diagnostic.events_needing_correction > 0 {
        message.push_str(&format!(
            " {} source event{} need confirmation.",
            pull.diagnostic.events_needing_correction,
            if pull.diagnostic.events_needing_correction == 1 { "" } else { "s" }
        ));
    }
    if pull.diagnostic.events_skipped > 0 {
        message.push_str(&format!(
            " {} unsupported event{} were skipped safely.",
            pull.diagnostic.events_skipped,
            if pull.diagnostic.events_skipped == 1 { "" } else { "s" }
        ));
    }
    message
}

fn connect_canvas_calendar_blocking(state: &AppState, feed_url: String, label: String, refresh_on_startup: bool) -> Result<Dashboard> {
    state.require_unlocked()?;
    let timezone={let db=state.db.lock().unwrap();canvas_calendar_timezone(&db)};
    let feed=Zeroizing::new(feed_url); let pull=canvas_calendar::fetch(&feed,timezone)?;
    let connection_id=Uuid::new_v4().to_string();
    canvas_calendar_entry(&connection_id)?.set_password(&feed)?;
    let result=(|| {
        let db=state.db.lock().unwrap();
        db.execute("INSERT INTO integration_connections(id,provider,base_url,account_name,status,created_at,refresh_on_startup,last_attempted_at,credential_ref) VALUES(?1,'canvas_calendar',?2,?3,'connecting',?4,?5,?4,?6)",params![connection_id,pull.origin,if label.trim().is_empty(){"Canvas calendar"}else{label.trim()},Utc::now().to_rfc3339(),i64::from(refresh_on_startup),format!("canvas-calendar-feed:{connection_id}")])?;
        let run_id=begin_sync_run(&db,&connection_id)?; let created=persist_canvas_calendar_pull(&db,&connection_id,&pull,&run_id)?;
        dashboard_with_notice(&db,&state.ocr,Some(canvas_calendar_notice("Canvas calendar connected read-only",created,&pull)))
    })();
    if result.is_err(){let _=canvas_calendar_entry(&connection_id)?.delete_credential();}
    result
}

#[tauri::command]
async fn connect_canvas_calendar(state: tauri::State<'_,AppState>, feed_url:String, label:String, refresh_on_startup:bool)->Result<Dashboard>{
    state.require_unlocked()?; let state=state.inner().clone();
    tauri::async_runtime::spawn_blocking(move||connect_canvas_calendar_blocking(&state,feed_url,label,refresh_on_startup)).await.map_err(|error|AppError::Background(error.to_string()))?
}

fn refresh_canvas_calendar_blocking(state:&AppState,connection_id:String)->Result<Dashboard>{
    state.require_unlocked()?;
    let (origin,timezone,run_id)={let db=state.db.lock().unwrap(); let origin=db.query_row("SELECT base_url FROM integration_connections WHERE id=?1 AND provider='canvas_calendar' AND status IN ('connected','error')",params![connection_id],|row|row.get::<_,String>(0)).optional()?.ok_or_else(||AppError::Invalid("Canvas calendar connection not found".into()))?; let run_id=begin_sync_run(&db,&connection_id)?;(origin,canvas_calendar_timezone(&db),run_id)};
    let feed=match canvas_calendar_entry(&connection_id)?.get_password(){Ok(value)=>Zeroizing::new(value),Err(keyring::Error::NoEntry)=>{let db=state.db.lock().unwrap();fail_sync_run(&db,&connection_id,&run_id,"Calendar link must be connected again",true)?;return Err(AppError::Invalid("Canvas calendar link must be connected again".into()));},Err(error)=>return Err(error.into())};
    match canvas_calendar::fetch(&feed,timezone){Ok(pull)=>{let db=state.db.lock().unwrap();let created=persist_canvas_calendar_pull(&db,&connection_id,&pull,&run_id)?;dashboard_with_notice(&db,&state.ocr,Some(canvas_calendar_notice("Canvas calendar refreshed",created,&pull)))} Err(error)=>{let db=state.db.lock().unwrap();fail_sync_run(&db,&connection_id,&run_id,"Canvas calendar refresh failed",false)?;let _=origin;Err(error.into())}}
}

#[tauri::command]
async fn refresh_canvas_calendar(state:tauri::State<'_,AppState>,connection_id:String)->Result<Dashboard>{state.require_unlocked()?;let state=state.inner().clone();tauri::async_runtime::spawn_blocking(move||refresh_canvas_calendar_blocking(&state,connection_id)).await.map_err(|error|AppError::Background(error.to_string()))?}

#[tauri::command]
fn set_canvas_calendar_refresh(state:tauri::State<AppState>,connection_id:String,refresh_on_startup:bool)->Result<Dashboard>{
    state.require_unlocked()?;
    let db=state.db.lock().unwrap();
    let changed=db.execute("UPDATE integration_connections SET refresh_on_startup=?2,version=version+1 WHERE id=?1 AND provider='canvas_calendar' AND status!='disconnected'",params![connection_id,i64::from(refresh_on_startup)])?;
    if changed==0{return Err(AppError::Invalid("Canvas calendar connection not found".into()));}
    mutation(&db,"integration_connection",&connection_id,"refresh_preference_changed",&serde_json::json!({"refreshOnStartup":refresh_on_startup}).to_string())?;
    dashboard_with_notice(&db,&state.ocr,Some(format!("Automatic Canvas refresh {}.",if refresh_on_startup{"enabled"}else{"disabled"})))
}

#[tauri::command]
fn disconnect_canvas_calendar(state:tauri::State<AppState>,connection_id:String)->Result<Dashboard>{state.require_unlocked()?;let db=state.db.lock().unwrap();let changed=db.execute("UPDATE integration_connections SET status='disconnected',version=version+1 WHERE id=?1 AND provider='canvas_calendar'",params![connection_id])?;if changed==0{return Err(AppError::Invalid("Canvas calendar connection not found".into()));}let _=canvas_calendar_entry(&connection_id)?.delete_credential();mutation(&db,"integration_connection",&connection_id,"disconnected","{}")?;dashboard_with_notice(&db,&state.ocr,Some("Canvas calendar disconnected; approved records were preserved.".into()))}

fn ensure_canvas_source_document(
    conn: &Connection,
    connection_id: &str,
    base_url: &str,
) -> Result<String> {
    let id = format!("canvas-source:{connection_id}");
    conn.execute(
        "INSERT OR IGNORE INTO documents(id,file_name,mime,vault_path,wrapped_key,key_nonce,content_nonce,sha256,imported_at,extraction_status)
         VALUES(?1,?2,'application/vnd.instructure.canvas+json','','','','',?3,?4,'remote')",
        params![
            id,
            format!("Canvas connection · {base_url}"),
            hex::encode(Sha256::digest(base_url.as_bytes())),
            Utc::now().to_rfc3339()
        ],
    )?;
    Ok(id)
}

fn extracted_canvas_candidate(
    connection_id: &str,
    candidate: &CanvasCandidate,
) -> ExtractedCandidate {
    ExtractedCandidate {
        kind: candidate.kind.clone(),
        title: candidate.title.clone(),
        course: candidate.course.clone(),
        due_at: candidate.due_at.clone(),
        starts_at: candidate.starts_at.clone(),
        ends_at: candidate.ends_at.clone(),
        duration_minutes: candidate.duration_minutes,
        evidence: candidate.evidence.clone(),
        source_locator: candidate.source_locator.clone(),
        source_uid: format!("canvas:{connection_id}:{}", candidate.source_uid),
        confidence: candidate.confidence,
        warnings: candidate.warnings.clone(),
        // Canvas expands recurrences server-side, so its calendar events arrive
        // as individual dated occurrences with no rule to read. There is no
        // weekly pattern to carry here without inferring one.
        ..Default::default()
    }
}

fn persist_canvas_pull(
    conn: &Connection,
    connection_id: &str,
    pull: &CanvasPull,
    run_id: &str,
) -> Result<usize> {
    let base_url: String = conn.query_row(
        "SELECT base_url FROM integration_connections WHERE id=?1",
        params![connection_id],
        |row| row.get(0),
    )?;
    let document_id = ensure_canvas_source_document(conn, connection_id, &base_url)?;
    let observed_at = Utc::now().to_rfc3339();
    let mut created = 0_usize;
    for candidate in &pull.candidates {
        let normalized = extracted_canvas_candidate(connection_id, candidate);
        let payload = serde_json::to_string(&candidate.snapshot)
            .map_err(|error| AppError::Invalid(error.to_string()))?;
        let payload_hash = hex::encode(Sha256::digest(payload.as_bytes()));
        let already_seen = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM source_objects WHERE connection_id=?1 AND source_uid=?2 AND payload_hash=?3)",
            params![connection_id, normalized.source_uid, payload_hash],
            |row| row.get::<_, i64>(0),
        )? != 0;
        if already_seen {
            continue;
        }
        let source_object_id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO source_objects(id,connection_id,source_type,source_uid,source_url,observed_at,payload_hash,payload)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                source_object_id,
                connection_id,
                candidate.source_type,
                normalized.source_uid,
                candidate.source_url,
                observed_at,
                payload_hash,
                payload
            ],
        )?;
        let candidate_id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO import_candidates(id,document_id,source_object_id,kind,title,course,due_at,starts_at,ends_at,duration_minutes,evidence,source_locator,source_type,source_url,source_uid,observed_at,confidence,warnings)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
            params![
                candidate_id,
                document_id,
                source_object_id,
                normalized.kind,
                normalized.title,
                normalized.course,
                normalized.due_at,
                normalized.starts_at,
                normalized.ends_at,
                normalized.duration_minutes,
                normalized.evidence,
                normalized.source_locator,
                candidate.source_type,
                candidate.source_url,
                normalized.source_uid,
                observed_at,
                normalized.confidence,
                serde_json::to_string(&normalized.warnings).unwrap_or_else(|_| "[]".into())
            ],
        )?;
        candidate_conflict(conn, &candidate_id, &normalized)?;
        created += 1;
    }
    conn.execute(
        "UPDATE integration_connections SET account_name=?2,remote_user_id=?3,status='connected',last_synced_at=?4,last_error=NULL,sync_cursor=?5,version=version+1 WHERE id=?1",
        params![connection_id, pull.profile.name, pull.profile.id, observed_at, pull.next_cursor],
    )?;
    conn.execute(
        "UPDATE integration_sync_runs SET completed_at=?2,status='complete',pulled_count=?3,created_count=?4 WHERE id=?1",
        params![run_id, observed_at, pull.candidates.len() as i64, created as i64],
    )?;
    mutation(
        conn,
        "integration_connection",
        connection_id,
        "synced",
        &serde_json::json!({ "createdCandidates": created }).to_string(),
    )?;
    Ok(created)
}

fn begin_sync_run(conn: &Connection, connection_id: &str) -> Result<String> {
    let run_id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO integration_sync_runs(id,connection_id,started_at,status) VALUES(?1,?2,?3,'running')",
        params![run_id, connection_id, Utc::now().to_rfc3339()],
    )?;
    conn.execute(
        "UPDATE integration_connections SET status='syncing',last_error=NULL WHERE id=?1",
        params![connection_id],
    )?;
    Ok(run_id)
}

fn fail_sync_run(
    conn: &Connection,
    connection_id: &str,
    run_id: &str,
    error: &str,
    needs_reauthentication: bool,
) -> Result<()> {
    let safe_error = error.chars().take(500).collect::<String>();
    conn.execute(
        "UPDATE integration_connections
         SET status=CASE WHEN ?3 THEN 'needs_reauthentication' ELSE 'error' END,
             last_error=?2,version=version+1 WHERE id=?1",
        params![connection_id, safe_error, needs_reauthentication],
    )?;
    conn.execute(
        "UPDATE integration_sync_runs SET completed_at=?2,status='error',error=?3 WHERE id=?1",
        params![run_id, Utc::now().to_rfc3339(), safe_error],
    )?;
    Ok(())
}

fn connect_canvas_blocking(state: &AppState, base_url: String, token: String) -> Result<Dashboard> {
    state.require_unlocked()?;
    let token = Zeroizing::new(token);
    let client = CanvasClient::connect(&base_url, Zeroizing::new(token.to_string()))?;
    let pull = client.pull()?;
    let normalized_base = client.base_url();
    let db = state.db.lock().unwrap();
    let existing = db
        .query_row(
            "SELECT id FROM integration_connections WHERE provider='canvas' AND base_url=?1",
            params![normalized_base],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let connection_id = existing.unwrap_or_else(|| Uuid::new_v4().to_string());
    canvas_token_entry(&connection_id)?.set_password(token.as_str())?;
    db.execute(
        "INSERT INTO integration_connections(id,provider,base_url,status,created_at)
         VALUES(?1,'canvas',?2,'connecting',?3)
         ON CONFLICT(id) DO UPDATE SET base_url=excluded.base_url,status='connecting',last_error=NULL",
        params![connection_id, normalized_base, Utc::now().to_rfc3339()],
    )?;
    let run_id = begin_sync_run(&db, &connection_id)?;
    persist_canvas_pull(&db, &connection_id, &pull, &run_id)?;
    dashboard_with_notice(
        &db,
        &state.ocr,
        Some("Canvas connected read-only. Review every new course, assignment, and calendar event before import.".into()),
    )
}

#[tauri::command]
async fn connect_canvas(
    state: tauri::State<'_, AppState>,
    base_url: String,
    token: String,
) -> Result<Dashboard> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || connect_canvas_blocking(&state, base_url, token))
        .await
        .map_err(|error| AppError::Background(error.to_string()))?
}

fn sync_canvas_blocking(state: &AppState, connection_id: String) -> Result<Dashboard> {
    state.require_unlocked()?;
    let (base_url, run_id) = {
        let db = state.db.lock().unwrap();
        let base_url = db
            .query_row(
                "SELECT base_url FROM integration_connections WHERE id=?1 AND provider='canvas' AND status IN ('connected','error')",
                params![connection_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| AppError::Invalid("Canvas connection not found".into()))?;
        let run_id = begin_sync_run(&db, &connection_id)?;
        (base_url, run_id)
    };
    let token = Zeroizing::new(canvas_token_entry(&connection_id)?.get_password()?);
    let result = CanvasClient::connect(&base_url, token).and_then(|client| client.pull());
    let db = state.db.lock().unwrap();
    match result {
        Ok(pull) => {
            let created = persist_canvas_pull(&db, &connection_id, &pull, &run_id)?;
            dashboard_with_notice(
                &db,
                &state.ocr,
                Some(format!(
                    "Canvas refresh completed; {created} changed item{} require review.",
                    if created == 1 { "" } else { "s" }
                )),
            )
        }
        Err(error) => {
            let needs_reauthentication = matches!(&error, canvas::CanvasError::Unauthorized);
            fail_sync_run(
                &db,
                &connection_id,
                &run_id,
                &error.to_string(),
                needs_reauthentication,
            )?;
            if needs_reauthentication {
                let _ = canvas_token_entry(&connection_id)?.delete_credential();
            }
            Err(error.into())
        }
    }
}

fn due_canvas_reconciliations(conn: &Connection, now: DateTime<Utc>) -> Result<Vec<String>> {
    let cutoff = (now - Duration::hours(24)).to_rfc3339();
    let mut statement = conn.prepare(
        "SELECT id FROM integration_connections
         WHERE provider='canvas' AND status='connected'
           AND (last_synced_at IS NULL OR datetime(last_synced_at)<=datetime(?1))
         ORDER BY COALESCE(datetime(last_synced_at),datetime('1970-01-01')),id
         LIMIT 10",
    )?;
    let rows = statement
        .query_map(params![cutoff], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn due_canvas_calendar_reconciliations(conn:&Connection,now:DateTime<Utc>)->Result<Vec<String>>{
    let cutoff=(now-Duration::hours(24)).to_rfc3339();
    let mut statement=conn.prepare("SELECT id FROM integration_connections WHERE provider='canvas_calendar' AND status='connected' AND refresh_on_startup=1 AND (last_attempted_at IS NULL OR datetime(last_attempted_at)<=datetime(?1)) ORDER BY COALESCE(datetime(last_attempted_at),datetime('1970-01-01')),id LIMIT 10")?;
    let rows=statement.query_map(params![cutoff],|row|row.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
    Ok(rows)
}

fn due_scholarship_refreshes(conn:&Connection,now:DateTime<Utc>)->Result<Vec<String>>{
    let cutoff=(now-Duration::days(7)).to_rfc3339();let mut statement=conn.prepare("SELECT id FROM scholarship_sources WHERE enabled=1 AND weekly_refresh=1 AND (last_fetched_at IS NULL OR datetime(last_fetched_at)<=datetime(?1)) ORDER BY COALESCE(datetime(last_fetched_at),datetime('1970-01-01')),id LIMIT 2")?;
    let rows=statement.query_map(params![cutoff],|row|row.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;Ok(rows)
}

fn start_canvas_reconciliation_worker(state: AppState) {
    std::thread::spawn(move || loop {
        if state.locked.load(Ordering::Acquire) {
            std::thread::sleep(StdDuration::from_secs(30));
            continue;
        }
        let (connection_ids,calendar_ids,scholarship_ids) = {
            let db = state.db.lock().unwrap();
            (due_canvas_reconciliations(&db, Utc::now()).unwrap_or_default(),due_canvas_calendar_reconciliations(&db,Utc::now()).unwrap_or_default(),due_scholarship_refreshes(&db,Utc::now()).unwrap_or_default())
        };
        for connection_id in connection_ids {
            if state.locked.load(Ordering::Acquire) {
                break;
            }
            let _ = sync_canvas_blocking(&state, connection_id);
        }
        for connection_id in calendar_ids { if state.locked.load(Ordering::Acquire){break;} let _=refresh_canvas_calendar_blocking(&state,connection_id); }
        for source_id in scholarship_ids { if state.locked.load(Ordering::Acquire){break;} let _=refresh_scholarship_source_blocking(&state,source_id); }
        std::thread::sleep(StdDuration::from_secs(60 * 60));
    });
}

#[tauri::command]
async fn sync_canvas(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<Dashboard> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sync_canvas_blocking(&state, connection_id))
        .await
        .map_err(|error| AppError::Background(error.to_string()))?
}

#[tauri::command]
fn disconnect_canvas(state: tauri::State<AppState>, connection_id: String) -> Result<Dashboard> {
    state.require_unlocked()?;
    let db = state.db.lock().unwrap();
    let changed = db.execute(
        "UPDATE integration_connections SET status='disconnected',version=version+1 WHERE id=?1 AND provider='canvas'",
        params![connection_id],
    )?;
    if changed == 0 {
        return Err(AppError::Invalid("Canvas connection not found".into()));
    }
    let _ = canvas_token_entry(&connection_id)?.delete_credential();
    mutation(
        &db,
        "integration_connection",
        &connection_id,
        "disconnected",
        "{}",
    )?;
    dashboard_with_notice(
        &db,
        &state.ocr,
        Some("Canvas disconnected and its local credential was removed.".into()),
    )
}

fn candidate_conflict(
    conn: &Connection,
    candidate_id: &str,
    candidate: &ExtractedCandidate,
) -> Result<()> {
    if candidate.source_uid.is_empty() {
        return Ok(());
    }
    let previous = conn
        .query_row(
            "SELECT due_at,starts_at,ends_at,canonical_entity_id,kind FROM import_candidates
       WHERE source_uid=?1 AND status='approved' AND canonical_entity_id IS NOT NULL
       ORDER BY rowid DESC LIMIT 1",
            params![candidate.source_uid],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?;
    if let Some((mut due_at, mut starts_at, mut ends_at, entity_id, entity_type)) = previous {
        match entity_type.as_str() {
            "task" => {
                due_at = conn
                    .query_row(
                        "SELECT due_at FROM tasks WHERE id=?1",
                        params![entity_id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .flatten();
            }
            "commitment" => {
                if let Some((canonical_start, canonical_end)) = conn
                    .query_row(
                        "SELECT starts_at,ends_at FROM commitments WHERE id=?1",
                        params![entity_id],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                    )
                    .optional()?
                {
                    starts_at = Some(canonical_start);
                    ends_at = Some(canonical_end);
                }
            }
            _ => {}
        }
        if due_at != candidate.due_at
            || starts_at != candidate.starts_at
            || ends_at != candidate.ends_at
        {
            let id = format!("source-change-{candidate_id}");
            conn.execute(
                "INSERT OR IGNORE INTO source_conflicts(
           id,description,resolved,kind,candidate_id,entity_type,entity_id,
           current_due_at,proposed_due_at,current_starts_at,proposed_starts_at,
           current_ends_at,proposed_ends_at,detected_at
         ) VALUES(?1,?2,0,'source_change',?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                params![
                    id,
                    format!(
            "{} changed a critical date or time; choose which value Student Center should use",
            candidate.title
          ),
                    candidate_id,
                    entity_type,
                    entity_id,
                    due_at,
                    candidate.due_at,
                    starts_at,
                    candidate.starts_at,
                    ends_at,
                    candidate.ends_at,
                    Utc::now().to_rfc3339(),
                ],
            )?;
        }
    }
    Ok(())
}

fn ai_capability_name(capability: managed_ai::AiCapability) -> &'static str {
    capability.as_str()
}

fn ai_provider_order(conn: &Connection) -> Vec<ai_providers::ProviderId> {
    let saved = conn.query_row("SELECT value FROM settings WHERE key='ai_provider_order'", [], |row| row.get::<_, String>(0)).ok();
    let parsed = saved.and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok()).unwrap_or_default();
    let mut order = parsed.into_iter().filter_map(|value| value.parse().ok()).collect::<Vec<_>>();
    for provider in ai_providers::ProviderId::ALL { if !order.contains(&provider) { order.push(provider); } }
    order
}

fn ai_model(conn: &Connection, provider: ai_providers::ProviderId) -> String {
    conn.query_row("SELECT value FROM settings WHERE key=?1", params![format!("ai_model_{}", provider.as_str())], |row| row.get::<_, String>(0))
        .ok().filter(|value| !value.trim().is_empty()).unwrap_or_else(|| provider.default_model().into())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct AiCapabilityRequirements {
    text: bool,
    images: bool,
    structured_output: bool,
    streaming: bool,
    minimum_context_tokens: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct AiProviderFeatures {
    text: bool,
    images: bool,
    structured_output: bool,
    streaming: bool,
    context_tokens: usize,
}

fn ai_capability_requirements(capability: managed_ai::AiCapability) -> AiCapabilityRequirements {
    AiCapabilityRequirements {
        text: true,
        images: matches!(capability, managed_ai::AiCapability::ScheduleVision),
        structured_output: true,
        streaming: false,
        minimum_context_tokens: if matches!(capability, managed_ai::AiCapability::SourceQa | managed_ai::AiCapability::StudyGuide | managed_ai::AiCapability::Flashcards | managed_ai::AiCapability::PracticeQuestions | managed_ai::AiCapability::PracticeTest) { 64_000 } else { 16_000 },
    }
}

fn ai_provider_features(provider: ai_providers::ProviderId) -> AiProviderFeatures {
    match provider {
        ai_providers::ProviderId::Openai => AiProviderFeatures { text:true, images:true, structured_output:true, streaming:true, context_tokens:128_000 },
        ai_providers::ProviderId::Anthropic | ai_providers::ProviderId::Gemini => AiProviderFeatures { text:true, images:true, structured_output:true, streaming:true, context_tokens:1_000_000 },
    }
}

fn provider_meets_requirements(features: AiProviderFeatures, requirements: AiCapabilityRequirements) -> bool {
    (!requirements.text || features.text)
        && (!requirements.images || features.images)
        && (!requirements.structured_output || features.structured_output)
        && (!requirements.streaming || features.streaming)
        && features.context_tokens >= requirements.minimum_context_tokens
}

fn provider_supports(provider: ai_providers::ProviderId, capability: managed_ai::AiCapability) -> bool {
    provider_meets_requirements(ai_provider_features(provider), ai_capability_requirements(capability))
}

fn resolve_ai_provider(conn: &Connection, capability: managed_ai::AiCapability) -> Result<(ai_providers::ProviderId, Zeroizing<String>, String)> {
    for provider in ai_provider_order(conn) {
        if !provider_supports(provider, capability) { continue; }
        let healthy = conn.query_row(
            "SELECT value FROM settings WHERE key=?1",
            params![format!("ai_healthy_{}", provider.as_str())],
            |row| row.get::<_, String>(0),
        ).ok().as_deref() == Some("true");
        if !healthy { continue; }
        match ai_providers::load_key(provider) {
            Ok(key) => return Ok((provider, key, ai_model(conn, provider))),
            Err(managed_ai::ManagedAiError::NotConfigured) => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err(AppError::Invalid("Connect OpenAI, Anthropic, or Gemini in Settings before using AI".into()))
}

fn all_ai_capabilities() -> Vec<String> {
    ["brain_dump","document_extraction","schedule_vision","task_decomposition","planner_explanation","source_qa","study_guide","flashcards","practice_questions","practice_test","scholarship_writing"]
        .into_iter().map(str::to_owned).collect()
}

#[tauri::command]
fn list_ai_providers(state: tauri::State<AppState>) -> Result<Vec<AiProviderStatus>> {
    state.require_unlocked()?;
    let db = state.db.lock().unwrap();
    Ok(ai_provider_order(&db).into_iter().map(|provider| {
        let key = ai_providers::load_key(provider).ok();
        let suffix = key.as_ref().map(|value| value.chars().rev().take(4).collect::<String>().chars().rev().collect::<String>());
        let healthy = db.query_row("SELECT value FROM settings WHERE key=?1", params![format!("ai_healthy_{}", provider.as_str())], |row| row.get::<_, String>(0)).ok().as_deref() == Some("true");
        let last_checked_at = db.query_row("SELECT value FROM settings WHERE key=?1", params![format!("ai_checked_{}", provider.as_str())], |row| row.get::<_, String>(0)).ok();
        AiProviderStatus { provider:provider.as_str().into(), connected:key.is_some(), healthy:key.is_some() && healthy,
            model:ai_model(&db, provider), masked_key:suffix.map(|value| format!("••••{value}")), capabilities:all_ai_capabilities(),
            last_checked_at, disclosure_url:provider.disclosure_url().into() }
    }).collect())
}

fn persist_ai_health(conn: &Connection, provider: ai_providers::ProviderId, healthy: bool) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    for (key, value) in [(format!("ai_healthy_{}", provider.as_str()), healthy.to_string()), (format!("ai_checked_{}", provider.as_str()), now)] {
        conn.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key,value])?;
    }
    Ok(())
}

#[tauri::command]
async fn save_ai_provider_key(state: tauri::State<'_, AppState>, provider: String, key: String, model: Option<String>, age_confirmed: bool) -> Result<Vec<AiProviderStatus>> {
    state.require_unlocked()?;
    if !age_confirmed { return Err(AppError::Invalid("Confirm that you are 18 or older before connecting an AI provider".into())); }
    let provider: ai_providers::ProviderId = provider.parse()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let key = Zeroizing::new(key);
        ai_providers::test_connection(provider, &key)?;
        ai_providers::save_key(provider, key)?;
        let db = state.db.lock().unwrap();
        if let Some(model) = model.filter(|value| !value.trim().is_empty()) {
            if model.len() > 200 { return Err(AppError::Invalid("model is too long".into())); }
            db.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![format!("ai_model_{}", provider.as_str()), model.trim()])?;
        }
        persist_ai_health(&db, provider, true)?;
        drop(db);
        list_ai_provider_statuses(&state)
    }).await.map_err(|error| AppError::Background(error.to_string()))?
}

fn list_ai_provider_statuses(state: &AppState) -> Result<Vec<AiProviderStatus>> {
    let db = state.db.lock().unwrap();
    Ok(ai_provider_order(&db).into_iter().map(|provider| {
        let key = ai_providers::load_key(provider).ok();
        let suffix = key.as_ref().map(|value| value.chars().rev().take(4).collect::<String>().chars().rev().collect::<String>());
        let healthy = db.query_row("SELECT value FROM settings WHERE key=?1", params![format!("ai_healthy_{}", provider.as_str())], |row| row.get::<_, String>(0)).ok().as_deref() == Some("true");
        AiProviderStatus { provider:provider.as_str().into(), connected:key.is_some(), healthy:key.is_some() && healthy, model:ai_model(&db,provider),
            masked_key:suffix.map(|value| format!("••••{value}")), capabilities:all_ai_capabilities(),
            last_checked_at:db.query_row("SELECT value FROM settings WHERE key=?1", params![format!("ai_checked_{}",provider.as_str())], |row| row.get(0)).ok(), disclosure_url:provider.disclosure_url().into() }
    }).collect())
}

#[tauri::command]
async fn test_ai_provider(state: tauri::State<'_, AppState>, provider: String) -> Result<Vec<AiProviderStatus>> {
    state.require_unlocked()?;
    let provider: ai_providers::ProviderId = provider.parse()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let key = ai_providers::load_key(provider)?;
        let result = ai_providers::test_connection(provider, &key);
        let db = state.db.lock().unwrap(); persist_ai_health(&db, provider, result.is_ok())?; drop(db);
        result?; list_ai_provider_statuses(&state)
    }).await.map_err(|error| AppError::Background(error.to_string()))?
}

#[tauri::command]
fn remove_ai_provider(state: tauri::State<AppState>, provider: String) -> Result<Vec<AiProviderStatus>> {
    state.require_unlocked()?;
    let provider: ai_providers::ProviderId = provider.parse()?;
    ai_providers::remove_key(provider)?;
    let db = state.db.lock().unwrap(); persist_ai_health(&db, provider, false)?; drop(db);
    list_ai_provider_statuses(&state)
}

#[tauri::command]
fn set_ai_provider_order(state: tauri::State<AppState>, order: Vec<String>) -> Result<Vec<AiProviderStatus>> {
    state.require_unlocked()?;
    let parsed = order.iter().map(|value| value.parse::<ai_providers::ProviderId>()).collect::<std::result::Result<Vec<_>,_>>()?;
    if parsed.len()!=3 || parsed.iter().collect::<std::collections::HashSet<_>>().len()!=3 { return Err(AppError::Invalid("provider order must contain each provider exactly once".into())); }
    let db=state.db.lock().unwrap();
    db.execute("INSERT INTO settings(key,value) VALUES('ai_provider_order',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![serde_json::to_string(&order).unwrap_or_default()])?;
    drop(db); list_ai_provider_statuses(&state)
}

#[tauri::command]
fn get_ai_usage(state: tauri::State<AppState>) -> Result<Vec<AiUsageSummary>> {
    state.require_unlocked()?;
    let db=state.db.lock().unwrap();
    ai_usage_summaries(&db)
}

fn ai_usage_summaries(db: &Connection) -> Result<Vec<AiUsageSummary>> {
    let mut query=db.prepare("SELECT provider,COALESCE(model,''),COUNT(*),SUM(CASE WHEN outcome='failed' THEN 1 ELSE 0 END),SUM(input_tokens),SUM(output_tokens),AVG(latency_ms) FROM ai_invocations GROUP BY provider,model ORDER BY provider,model")?;
    let rows=query.query_map([],|row| Ok(AiUsageSummary{provider:row.get(0)?,model:row.get(1)?,requests:row.get(2)?,failures:row.get(3)?,input_tokens:row.get(4)?,output_tokens:row.get(5)?,average_latency_ms:row.get(6)?}))?.collect::<std::result::Result<Vec<_>,_>>()?;
    Ok(rows)
}

fn study_workspace_in(conn: &Connection) -> Result<StudyWorkspace> {
    let materials = {
        let mut query = conn.prepare("SELECT d.id,d.file_name,d.mime,(SELECT COUNT(*) FROM document_segments s WHERE s.document_id=d.id) FROM documents d WHERE d.vault_path!='' OR d.content_shredded=1 ORDER BY datetime(d.imported_at) DESC,d.id")?;
        let values = query.query_map([], |row| {
            let id: String = row.get(0)?;
            let mut courses = conn.prepare("SELECT course_id FROM study_materials WHERE document_id=?1 ORDER BY course_id")?;
            let course_ids = courses.query_map(params![id], |course| course.get::<_, String>(0))?.collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(StudyMaterialSummary { id, file_name: row.get(1)?, mime: row.get(2)?, course_ids, segment_count: row.get(3)? })
        })?.collect::<std::result::Result<Vec<_>, _>>()?;
        values
    };
    let artifacts = {
        let mut query = conn.prepare("SELECT id,course_id,kind,title,content,citations,provider,model,updated_at FROM study_artifacts ORDER BY datetime(updated_at) DESC,id")?;
        let values = query.query_map([], |row| {
            let citations: String = row.get(5)?;
            Ok(StudyArtifactSummary { id: row.get(0)?, course_id: row.get(1)?, kind: row.get(2)?, title: row.get(3)?, content: row.get(4)?, citations: serde_json::from_str(&citations).unwrap_or_default(), provider: row.get(6)?, model: row.get(7)?, updated_at: row.get(8)? })
        })?.collect::<std::result::Result<Vec<_>, _>>()?;
        values
    };
    let reviews = {
        let mut query = conn.prepare("SELECT id,artifact_id,confidence,misses,interval_days,next_review_at,last_reviewed_at FROM study_reviews ORDER BY datetime(next_review_at),id")?;
        let values = query.query_map([], |row| Ok(StudyReviewSummary { id: row.get(0)?, artifact_id: row.get(1)?, confidence: row.get(2)?, misses: row.get(3)?, interval_days: row.get(4)?, next_review_at: row.get(5)?, last_reviewed_at: row.get(6)? }))?.collect::<std::result::Result<Vec<_>, _>>()?;
        values
    };
    let grade_categories = {
        let mut query = conn.prepare("SELECT id,course_id,name,weight FROM grade_categories ORDER BY course_id,name,id")?;
        let values = query.query_map([], |row| Ok(GradeCategorySummary { id: row.get(0)?, course_id: row.get(1)?, name: row.get(2)?, weight: row.get(3)? }))?.collect::<std::result::Result<Vec<_>, _>>()?;
        values
    };
    let grade_items = {
        let mut query = conn.prepare("SELECT id,course_id,category_id,title,score,points_possible,due_at,status FROM grade_items ORDER BY course_id,COALESCE(datetime(due_at),datetime('9999-12-31')),title,id")?;
        let values = query.query_map([], |row| Ok(GradeItemSummary { id: row.get(0)?, course_id: row.get(1)?, category_id: row.get(2)?, title: row.get(3)?, score: row.get(4)?, points_possible: row.get(5)?, due_at: row.get(6)?, status: row.get(7)? }))?.collect::<std::result::Result<Vec<_>, _>>()?;
        values
    };
    let course_ids = {
        let mut query = conn.prepare("SELECT id FROM courses ORDER BY id")?;
        let values = query.query_map([], |row| row.get::<_, String>(0))?.collect::<std::result::Result<Vec<_>, _>>()?;
        values
    };
    let mut course_grades=Vec::new();let mut grading_scales=Vec::new();let mut gpa_points=0.0;let mut gpa_credits=0.0;
    for course_id in course_ids {
        let categories=grade_categories.iter().filter(|value|value.course_id==course_id).collect::<Vec<_>>();
        let items=grade_items.iter().filter(|value|value.course_id==course_id).collect::<Vec<_>>();
        let current=grade_percent(&categories,&items,true);let without_missing=grade_percent(&categories,&items,false);
        let scale=conn.query_row("SELECT scale,credit_hours FROM course_grading_scales WHERE course_id=?1",params![course_id],|row|Ok((row.get::<_,String>(0)?,row.get::<_,f64>(1)?))).optional()?;
        let (bands,credits)=scale.as_ref().map(|(raw,credits)|(serde_json::from_str::<Vec<GradeBand>>(raw).unwrap_or_default(),*credits)).unwrap_or_default();
        if scale.is_some(){grading_scales.push(CourseGradingScaleSummary{course_id:course_id.clone(),bands:bands.clone(),credit_hours:credits});}
        let band=current.and_then(|value|bands.iter().filter(|band|value>=band.minimum_percent).max_by(|a,b|a.minimum_percent.total_cmp(&b.minimum_percent)));
        if let Some(band)=band {gpa_points+=band.grade_points*credits;gpa_credits+=credits;}
        course_grades.push(CourseGradeSummary{course_id,current_percent:current,missing_work_impact:without_missing.unwrap_or(0.0)-current.unwrap_or(0.0),projected_letter:band.map(|value|value.label.clone()),credit_hours:credits});
    }
    Ok(StudyWorkspace{materials,artifacts,reviews,grade_categories,grade_items,course_grades,grading_scales,gpa_projection:(gpa_credits>0.0).then_some(gpa_points/gpa_credits)})
}

fn grade_percent(categories:&[&GradeCategorySummary],items:&[&GradeItemSummary],include_missing:bool)->Option<f64>{
    let included=items.iter().copied().filter(|item|item.status=="graded"||(include_missing&&item.status=="missing")).collect::<Vec<_>>();
    if included.is_empty(){return None;}
    if categories.is_empty(){let possible=included.iter().map(|item|item.points_possible).sum::<f64>();return (possible>0.0).then(||included.iter().map(|item|item.score.unwrap_or(0.0)).sum::<f64>()/possible*100.0);}
    let mut weighted=0.0;let mut used_weight=0.0;
    for category in categories {let category_items=included.iter().filter(|item|item.category_id.as_deref()==Some(category.id.as_str())).collect::<Vec<_>>();let possible=category_items.iter().map(|item|item.points_possible).sum::<f64>();if possible>0.0{weighted+=category_items.iter().map(|item|item.score.unwrap_or(0.0)).sum::<f64>()/possible*category.weight;used_weight+=category.weight;}}
    (used_weight>0.0).then(||weighted/used_weight*100.0)
}

#[tauri::command]
fn get_study_workspace(state:tauri::State<AppState>)->Result<StudyWorkspace>{state.require_unlocked()?;study_workspace_in(&state.db.lock().unwrap())}

#[tauri::command]
fn set_study_material_courses(state:tauri::State<AppState>,document_id:String,course_ids:Vec<String>)->Result<StudyWorkspace>{
    state.require_unlocked()?;Uuid::parse_str(&document_id).map_err(|_|AppError::Invalid("document identifier is invalid".into()))?;
    if course_ids.len()>20{return Err(AppError::Invalid("too many courses were selected".into()));}
    let mut unique=course_ids;unique.sort();unique.dedup();let mut db=state.db.lock().unwrap();let tx=db.transaction()?;
    if tx.query_row("SELECT COUNT(*) FROM documents WHERE id=?1",params![document_id],|row|row.get::<_,i64>(0))?!=1{return Err(AppError::Invalid("document not found".into()));}
    tx.execute("DELETE FROM study_materials WHERE document_id=?1",params![document_id])?;
    for course_id in unique {if tx.query_row("SELECT COUNT(*) FROM courses WHERE id=?1",params![course_id],|row|row.get::<_,i64>(0))?!=1{return Err(AppError::Invalid("selected course was not found".into()));}tx.execute("INSERT INTO study_materials(document_id,course_id,added_at) VALUES(?1,?2,?3)",params![document_id,course_id,Utc::now().to_rfc3339()])?;}
    tx.commit()?;study_workspace_in(&db)
}

#[tauri::command]
fn save_grade_category(state:tauri::State<AppState>,input:GradeCategoryInput)->Result<StudyWorkspace>{state.require_unlocked()?;if input.name.trim().is_empty()||input.name.len()>120||!(0.0..=100.0).contains(&input.weight){return Err(AppError::Invalid("grade category is invalid".into()));}let id=input.id.unwrap_or_else(||Uuid::new_v4().to_string());let db=state.db.lock().unwrap();db.execute("INSERT INTO grade_categories(id,course_id,name,weight) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET name=excluded.name,weight=excluded.weight",params![id,input.course_id,input.name.trim(),input.weight])?;study_workspace_in(&db)}

#[tauri::command]
fn save_grade_item(state:tauri::State<AppState>,input:GradeItemInput)->Result<StudyWorkspace>{state.require_unlocked()?;if input.title.trim().is_empty()||input.title.len()>200||!input.points_possible.is_finite()||input.points_possible<=0.0||input.score.is_some_and(|score|!score.is_finite()||score<0.0)||!matches!(input.status.as_str(),"graded"|"missing"|"planned"){return Err(AppError::Invalid("grade item is invalid".into()));}if let Some(due)=&input.due_at{parse_utc(due).ok_or_else(||AppError::Invalid("grade item due date is invalid".into()))?;}let id=input.id.unwrap_or_else(||Uuid::new_v4().to_string());let db=state.db.lock().unwrap();db.execute("INSERT INTO grade_items(id,course_id,category_id,title,score,points_possible,due_at,status) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET category_id=excluded.category_id,title=excluded.title,score=excluded.score,points_possible=excluded.points_possible,due_at=excluded.due_at,status=excluded.status",params![id,input.course_id,input.category_id,input.title.trim(),input.score,input.points_possible,input.due_at,input.status])?;study_workspace_in(&db)}

#[tauri::command]
fn calculate_grade_what_if(state:tauri::State<AppState>,input:GradeItemInput)->Result<GradeWhatIf>{state.require_unlocked()?;if input.course_id.is_empty()||!input.points_possible.is_finite()||input.points_possible<=0.0||input.score.is_some_and(|score|!score.is_finite()||score<0.0){return Err(AppError::Invalid("what-if score is invalid".into()));}let db=state.db.lock().unwrap();let workspace=study_workspace_in(&db)?;let mut items=workspace.grade_items.into_iter().filter(|item|item.course_id==input.course_id).collect::<Vec<_>>();items.push(GradeItemSummary{id:"what-if".into(),course_id:input.course_id.clone(),category_id:input.category_id,title:input.title,score:input.score,points_possible:input.points_possible,due_at:input.due_at,status:"graded".into()});let categories=workspace.grade_categories.iter().filter(|category|category.course_id==input.course_id).collect::<Vec<_>>();let item_refs=items.iter().collect::<Vec<_>>();let percent=grade_percent(&categories,&item_refs,true);let bands=db.query_row("SELECT scale FROM course_grading_scales WHERE course_id=?1",params![input.course_id],|row|row.get::<_,String>(0)).optional()?.and_then(|raw|serde_json::from_str::<Vec<GradeBand>>(&raw).ok()).unwrap_or_default();let projected_letter=percent.and_then(|value|bands.iter().filter(|band|value>=band.minimum_percent).max_by(|a,b|a.minimum_percent.total_cmp(&b.minimum_percent))).map(|band|band.label.clone());Ok(GradeWhatIf{percent,projected_letter})}

#[tauri::command]
fn save_grading_scale(state:tauri::State<AppState>,course_id:String,bands:Vec<GradeBand>,credit_hours:f64)->Result<StudyWorkspace>{state.require_unlocked()?;if bands.is_empty()||bands.len()>20||!credit_hours.is_finite()||!(0.0..=30.0).contains(&credit_hours)||bands.iter().any(|band|band.label.trim().is_empty()||band.label.len()>20||!band.minimum_percent.is_finite()||!(0.0..=100.0).contains(&band.minimum_percent)||!band.grade_points.is_finite()||!(0.0..=5.0).contains(&band.grade_points)){return Err(AppError::Invalid("grading scale is invalid".into()));}let db=state.db.lock().unwrap();db.execute("INSERT INTO course_grading_scales(course_id,scale,credit_hours) VALUES(?1,?2,?3) ON CONFLICT(course_id) DO UPDATE SET scale=excluded.scale,credit_hours=excluded.credit_hours",params![course_id,serde_json::to_string(&bands).map_err(|error|AppError::Background(error.to_string()))?,credit_hours])?;study_workspace_in(&db)}

#[tauri::command]
fn update_study_artifact(state:tauri::State<AppState>,artifact_id:String,title:String,content:String)->Result<StudyWorkspace>{state.require_unlocked()?;if title.trim().is_empty()||title.len()>200||content.trim().is_empty()||content.chars().count()>40_000{return Err(AppError::Invalid("study artifact is invalid".into()));}let db=state.db.lock().unwrap();let changed=db.execute("UPDATE study_artifacts SET title=?2,content=?3,updated_at=?4,version=version+1 WHERE id=?1",params![artifact_id,title.trim(),content,Utc::now().to_rfc3339()])?;if changed!=1{return Err(AppError::Invalid("study artifact not found".into()));}study_workspace_in(&db)}

fn record_ai_invocation(
    conn: &Connection,
    provider: &str,
    capability: managed_ai::AiCapability,
    model: Option<&str>,
    latency_ms: i64,
    input_tokens: u64,
    output_tokens: u64,
    outcome: &str,
    error_category: Option<&str>,
) -> Result<()> {
    conn.execute(
        "INSERT INTO ai_invocations(
           id,provider,capability,model,latency_ms,input_tokens,output_tokens,outcome,error_category,prompt_version,created_at
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'byok-v1',?10)",
        params![
            Uuid::new_v4().to_string(),
            provider,
            ai_capability_name(capability),
            model,
            latency_ms.max(0),
            input_tokens.min(i64::MAX as u64) as i64,
            output_tokens.min(i64::MAX as u64) as i64,
            outcome,
            error_category,
            Utc::now().to_rfc3339(),
        ],
    )?;
    Ok(())
}

fn ai_error_category(error: &managed_ai::ManagedAiError) -> &'static str {
    match error {
        managed_ai::ManagedAiError::NotConfigured => "not_configured",
        managed_ai::ManagedAiError::Credential => "credential",
        managed_ai::ManagedAiError::Unauthorized => "unauthorized",
        managed_ai::ManagedAiError::InvalidInput(_) => "invalid_input",
        managed_ai::ManagedAiError::Network => "network",
        managed_ai::ManagedAiError::Quota => "quota",
        managed_ai::ManagedAiError::Timeout => "timeout",
        managed_ai::ManagedAiError::Rejected(_) => "rejected",
        managed_ai::ManagedAiError::InvalidResponse => "invalid_response",
    }
}

#[tauri::command]
async fn request_managed_ai(
    state: tauri::State<'_, AppState>,
    input: ManagedAiInput,
) -> Result<ManagedAiResult> {
    state.require_unlocked()?;
    if !input.consent {
        return Err(AppError::Invalid(
            "explicit consent is required before sending an excerpt".into(),
        ));
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.require_unlocked()?;
        {
            let db = state.db.lock().unwrap();
            if profile::onboarding_state(&db)?.required {
                return Err(AppError::Invalid(
                    "finish local onboarding before using an AI provider".into(),
                ));
            }
        }
        let (provider, api_key, model) = {
            let db = state.db.lock().unwrap();
            resolve_ai_provider(&db, input.capability)?
        };
        let started = Instant::now();
        let response = match ai_providers::request(
            provider,
            &api_key,
            &model,
            input.capability,
            &input.excerpt,
            &input.locale,
            None,
        ) {
            Ok(response) => response,
            Err(error) => {
                let db = state.db.lock().unwrap();
                record_ai_invocation(
                    &db,
                    provider.as_str(),
                    input.capability,
                    Some(&model),
                    started.elapsed().as_millis().min(i64::MAX as u128) as i64,
                    0,
                    0,
                    "failed",
                    Some(ai_error_category(&error)),
                )?;
                persist_ai_health(&db, provider, false)?;
                return Err(AppError::ManagedAi(error));
            }
        };
        let latency_ms = started.elapsed().as_millis().min(i64::MAX as u128) as i64;
        let mut db = state.db.lock().unwrap();
        let tx = db.transaction()?;
        let invocation_id = Uuid::new_v4().to_string();
        let document_id = Uuid::new_v4().to_string();
        if !response.candidates.is_empty() {
            tx.execute(
                "INSERT INTO documents(
                   id,file_name,mime,vault_path,wrapped_key,key_nonce,content_nonce,sha256,
                   imported_at,extraction_status,extraction_error
                 ) VALUES(?1,?2,'application/x-student-center-ai','','','','',?3,?4,'complete',NULL)",
                params![
                    document_id,
                    format!("AI provider · {}", ai_capability_name(input.capability)),
                    hex::encode(Sha256::digest(invocation_id.as_bytes())),
                    Utc::now().to_rfc3339(),
                ],
            )?;
            // A class recurs, so it carries a local clock rather than an instant,
            // and the clock is meaningless without the zone it is read in.
            let timezone = tx
                .query_row(
                    "SELECT value FROM settings WHERE key='timezone'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap_or_else(|_| "Etc/UTC".into());
            for (index, candidate) in response.candidates.iter().enumerate() {
                let kind = local_candidate_kind(&candidate.kind);
                let mut warnings = candidate.warnings.clone();
                if candidate.kind != kind {
                    warnings.push(format!(
                        "An AI provider proposed this as an {}; Student Center will import it as a {kind}",
                        candidate.kind
                    ));
                }
                let is_class = kind == "class_meeting";
                tx.execute(
                    "INSERT INTO import_candidates(
                       id,document_id,kind,title,course,due_at,starts_at,ends_at,duration_minutes,
                       evidence,source_locator,source_type,source_uid,observed_at,confidence,warnings,status,
                       weekdays,starts_at_local,ends_at_local,timezone,section_number,location,modality
                     ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'managed_ai',?12,?13,?14,?15,'pending',
                              ?16,?17,?18,?19,?20,?21,?22)",
                    params![
                        Uuid::new_v4().to_string(),
                        document_id,
                        kind,
                        candidate.title,
                        candidate.course.clone().unwrap_or_default(),
                        candidate.due_at,
                        candidate.starts_at,
                        candidate.ends_at,
                        candidate.duration_minutes,
                        candidate.evidence,
                        format!("AI provider · {} · evidence", ai_capability_name(input.capability)),
                        format!("ai:{invocation_id}:{index}"),
                        Utc::now().to_rfc3339(),
                        candidate.confidence,
                        serde_json::to_string(&warnings).unwrap_or_else(|_| "[]".into()),
                        serde_json::to_string(&candidate.weekdays).unwrap_or_else(|_| "[]".into()),
                        candidate.starts_at_local.clone().unwrap_or_default(),
                        candidate.ends_at_local.clone().unwrap_or_default(),
                        if is_class { timezone.as_str() } else { "" },
                        candidate.section_number.clone().unwrap_or_default(),
                        candidate.location.clone().unwrap_or_default(),
                        candidate.modality.clone().unwrap_or_default(),
                    ],
                )?;
            }
        }
        tx.execute(
            "INSERT INTO ai_invocations(
               id,provider,capability,model,latency_ms,input_tokens,output_tokens,outcome,prompt_version,created_at
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,'review_created','byok-v1',?8)",
            params![
                invocation_id,
                provider.as_str(),
                ai_capability_name(input.capability),
                response.model,
                latency_ms,
                response.usage.input_tokens.min(i64::MAX as u64) as i64,
                response.usage.output_tokens.min(i64::MAX as u64) as i64,
                Utc::now().to_rfc3339(),
            ],
        )?;
        tx.commit()?;
        let candidates_created = response.candidates.len();
        let model = response.model;
        let explanation = response.explanation;
        let dashboard = dashboard_with_notice(
            &db,
            &state.ocr,
            Some(if candidates_created > 0 {
                format!(
                    "{} proposed {candidates_created} reviewable item{}; nothing was added to your plan.",
                    provider.as_str(),
                    if candidates_created == 1 { "" } else { "s" }
                )
            } else {
                format!("{} returned an explanation without changing local data.", provider.as_str())
            }),
        )?;
        Ok(ManagedAiResult {
            dashboard,
            explanation,
            candidates_created,
            model,
            provider: provider.as_str().into(),
        })
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

#[tauri::command]
async fn request_ai_capability(
    state: tauri::State<'_, AppState>,
    input: ManagedAiInput,
) -> Result<ManagedAiResult> {
    state.require_unlocked()?;
    request_managed_ai(state, input).await
}

#[tauri::command]
async fn generate_grounded_study_artifact(
    state: tauri::State<'_, AppState>,
    input: GroundedStudyInput,
) -> Result<GroundedStudyResult> {
    state.require_unlocked()?;
    if !input.consent { return Err(AppError::Invalid("explicit consent is required before selected materials leave this device".into())); }
    if !matches!(input.capability,managed_ai::AiCapability::SourceQa|managed_ai::AiCapability::StudyGuide|managed_ai::AiCapability::Flashcards|managed_ai::AiCapability::PracticeQuestions|managed_ai::AiCapability::PracticeTest)
        || input.course_ids.is_empty() || input.document_ids.is_empty() || input.course_ids.len()>20 || input.document_ids.len()>100 {
        return Err(AppError::Invalid("select at least one course and material for this study request".into()));
    }
    let state=state.inner().clone();
    tauri::async_runtime::spawn_blocking(move||{
        state.require_unlocked()?;
        let (provider,api_key,model,sources,course_id)={
            let db=state.db.lock().unwrap();let mut course_ids=input.course_ids.clone();course_ids.sort();course_ids.dedup();let mut document_ids=input.document_ids.clone();document_ids.sort();document_ids.dedup();
            for id in course_ids.iter().chain(document_ids.iter()){Uuid::parse_str(id).map_err(|_|AppError::Invalid("selected study identifier is invalid".into()))?;}
            let mut sources=Vec::new();
            for document_id in &document_ids {
                let linked=course_ids.iter().any(|course_id|db.query_row("SELECT EXISTS(SELECT 1 FROM study_materials WHERE document_id=?1 AND course_id=?2)",params![document_id,course_id],|row|row.get::<_,i64>(0)).unwrap_or(0)!=0);
                if !linked{return Err(AppError::Invalid("every selected material must be assigned to a selected course".into()));}
                let mut query=db.prepare("SELECT id,locator,text FROM document_segments WHERE document_id=?1 ORDER BY position LIMIT 100")?;
                let mut segments=query.query_map(params![document_id],|row|Ok(ai_providers::GroundedSource{id:row.get(0)?,locator:row.get(1)?,text:row.get(2)?}))?.collect::<std::result::Result<Vec<_>,_>>()?;
                if segments.is_empty(){let mut evidence=db.prepare("SELECT id,source_locator,evidence FROM import_candidates WHERE document_id=?1 AND evidence!='' ORDER BY id LIMIT 100")?;segments=evidence.query_map(params![document_id],|row|Ok(ai_providers::GroundedSource{id:row.get(0)?,locator:row.get(1)?,text:row.get(2)?}))?.collect::<std::result::Result<Vec<_>,_>>()?;}
                sources.extend(segments);
            }
            if sources.is_empty(){return Err(AppError::Invalid("the selected materials contain no locally extracted text to ground an answer".into()));}
            let (provider,key,model)=resolve_ai_provider(&db,input.capability)?;(provider,key,model,sources,course_ids[0].clone())
        };
        let started=Instant::now();
        let response=match ai_providers::request_grounded(provider,&api_key,&model,input.capability,input.prompt.trim(),&sources){Ok(value)=>value,Err(error)=>{let db=state.db.lock().unwrap();record_ai_invocation(&db,provider.as_str(),input.capability,Some(&model),started.elapsed().as_millis().min(i64::MAX as u128) as i64,0,0,"failed",Some(ai_error_category(&error)))?;persist_ai_health(&db,provider,false)?;return Err(AppError::ManagedAi(error));}};
        let artifact_id=Uuid::new_v4().to_string();let now=Utc::now();let title=if input.title.trim().is_empty(){match input.capability{managed_ai::AiCapability::SourceQa=>"Grounded answer",managed_ai::AiCapability::StudyGuide=>"Study guide",managed_ai::AiCapability::Flashcards=>"Flashcards",managed_ai::AiCapability::PracticeQuestions=>"Practice questions",managed_ai::AiCapability::PracticeTest=>"Practice test",_=>"Study artifact"}}else{input.title.trim()};
        let mut db=state.db.lock().unwrap();let tx=db.transaction()?;
        tx.execute("INSERT INTO study_artifacts(id,course_id,kind,title,content,citations,provider,model,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)",params![artifact_id,course_id,input.capability.as_str(),title,response.content,serde_json::to_string(&response.citations).map_err(|error|AppError::Background(error.to_string()))?,provider.as_str(),response.model,now.to_rfc3339()])?;
        tx.execute("INSERT INTO study_reviews(id,artifact_id,next_review_at) VALUES(?1,?2,?3)",params![Uuid::new_v4().to_string(),artifact_id,(now+chrono::Duration::days(1)).to_rfc3339()])?;
        record_ai_invocation(&tx,provider.as_str(),input.capability,Some(&model),started.elapsed().as_millis().min(i64::MAX as u128) as i64,response.usage.input_tokens,response.usage.output_tokens,"artifact_created",None)?;
        tx.commit()?;let workspace=study_workspace_in(&db)?;Ok(GroundedStudyResult{workspace,artifact_id,provider:provider.as_str().into(),model})
    }).await.map_err(|error|AppError::Background(error.to_string()))?
}

#[tauri::command]
fn review_study_artifact(state:tauri::State<AppState>,artifact_id:String,confidence:i64)->Result<StudyWorkspace>{
    state.require_unlocked()?;if !(1..=5).contains(&confidence){return Err(AppError::Invalid("confidence must be from 1 to 5".into()));}let mut db=state.db.lock().unwrap();let tx=db.transaction()?;
    let (review_id,previous_interval,misses,title,course_id)=tx.query_row("SELECT r.id,r.interval_days,r.misses,a.title,a.course_id FROM study_reviews r JOIN study_artifacts a ON a.id=r.artifact_id WHERE a.id=?1",params![artifact_id],|row|Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?,row.get::<_,i64>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?))).optional()?.ok_or_else(||AppError::Invalid("study artifact not found".into()))?;
    let interval=match confidence{1=>1,2=>previous_interval.max(1),3=>(previous_interval*2).max(3),4=>(previous_interval*3).max(7),_=>(previous_interval*4).max(14)}.min(90);let next=Utc::now()+chrono::Duration::days(interval);let misses=misses+i64::from(confidence<=2);
    tx.execute("UPDATE study_reviews SET confidence=?2,misses=?3,interval_days=?4,next_review_at=?5,last_reviewed_at=?6 WHERE id=?1",params![review_id,confidence,misses,interval,next.to_rfc3339(),Utc::now().to_rfc3339()])?;
    let task_id=format!("study-review-{review_id}");tx.execute("INSERT INTO tasks(id,title,minutes,due_at,course_id,priority,created_at,source_uid) VALUES(?1,?2,25,?3,?4,2,?5,?6) ON CONFLICT(id) DO UPDATE SET title=excluded.title,due_at=excluded.due_at,completed=0,version=version+1",params![task_id,format!("Review · {title}"),next.to_rfc3339(),course_id,Utc::now().to_rfc3339(),format!("study-review:{review_id}")])?;
    tx.commit()?;regenerate_plan_for_trigger(&db,None,planner::PlannerTrigger::DeadlineChanged)?;study_workspace_in(&db)
}

#[tauri::command]
fn import_document(state: tauri::State<AppState>, path: String) -> Result<Dashboard> {
    state.require_unlocked()?;
    let source = PathBuf::from(path);
    if !source.is_file() {
        return Err(AppError::Invalid("selected path is not a file".into()));
    }
    let size = source.metadata()?.len();
    if size == 0 || size > MAX_IMPORT_BYTES {
        return Err(AppError::Invalid(
            "files must be non-empty and 25 MB or smaller".into(),
        ));
    }
    let bytes = fs::read(&source)?;
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("document")
        .to_string();
    ingest_document(&state, imports::DocumentSource::File(&source), bytes, name)
}

/// Import bytes the app was handed directly rather than read off disk.
///
/// This is the clipboard path. A pasted screenshot has no file to point at, so
/// the webview reads the image off the `paste` event and sends the bytes here.
/// Everything after the read is the same as `import_document` — the same size
/// cap, the same content sniff, the same duplicate check, the same envelope
/// encryption — because a screenshot is a document like any other and a second
/// copy of that path would be a second place for it to be wrong.
#[tauri::command]
fn import_document_bytes(
    state: tauri::State<AppState>,
    file_name: String,
    bytes: Vec<u8>,
) -> Result<Dashboard> {
    state.require_unlocked()?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_IMPORT_BYTES {
        return Err(AppError::Invalid(
            "files must be non-empty and 25 MB or smaller".into(),
        ));
    }
    // Only the basename is kept. A pasted name is attacker-influenced text that
    // ends up in the vault listing, and nothing downstream wants a path.
    let name = PathBuf::from(&file_name)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("pasted-image.png")
        .to_string();
    // Explicitly "there is no file behind this". Passing a bare basename and
    // letting the reader call `is_file()` on it resolved against the process
    // working directory, so an unrelated file with the same name could be read
    // while different bytes were encrypted and hashed.
    ingest_document(&state, imports::DocumentSource::Bytes, bytes, name)
}

/// Encrypt a document into the vault, extract from it, and file every candidate
/// for review. Shared by every import path so they cannot diverge.
fn ingest_document(
    state: &AppState,
    source: imports::DocumentSource<'_>,
    bytes: Vec<u8>,
    name: String,
) -> Result<Dashboard> {
    let hash = hex::encode(Sha256::digest(&bytes));
    let detected = imports::detect_document(&bytes, &name)
        .map_err(|error| AppError::Extract(error.to_string()))?;

    let db = state.db.lock().unwrap();
    if let Some(existing_name) = duplicate_document_name(&db, &hash)? {
        return dashboard_with_notice(
            &db,
            &state.ocr,
            Some(format!("This file already exists in your encrypted vault as {existing_name}; no duplicate was created.")),
        );
    }

    let document_key = random_key();
    let (encrypted, content_nonce) = encrypt(&document_key, &bytes)?;
    let (wrapped, key_nonce) = encrypt(&state.master_key, &document_key)?;
    let id = Uuid::new_v4().to_string();
    let vault_path = state.vault.join(format!("{id}.vault"));
    fs::write(&vault_path, encrypted)?;

    let timezone = db
        .query_row(
            "SELECT value FROM settings WHERE key='timezone'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_else(|_| "Etc/UTC".into());
    // The layouts of the school the student actually attends, so a screenshot is
    // read with that registrar's weekday spellings. A student at a school nobody
    // has described gets an empty list and the reader's English defaults.
    let layouts = student_schedule_layouts(&db);
    // Codes the student already has. A screenshot whose courses match none of
    // them is a hint the read went wrong, so the reader offers a second opinion
    // rather than presenting a confident answer.
    let known_courses = enrolled_course_codes(&db);
    let extraction = imports::extract_document(
        source,
        &bytes,
        &name,
        &timezone,
        &state.ocr,
        &layouts,
        &known_courses,
    );
    let (status, extraction_error) = match &extraction {
        Ok(result) if result.candidates.is_empty() => (
            "needs_attention",
            Some(if result.warnings.is_empty() {
                "No academic dates or calendar events were found".into()
            } else {
                result.warnings.join(" · ")
            }),
        ),
        Ok(result) if result.warnings.is_empty() => ("complete", None),
        Ok(result) => ("complete_with_warnings", Some(result.warnings.join(" · "))),
        Err(error) => ("needs_attention", Some(error.to_string())),
    };
    db.execute(
    "INSERT INTO documents(id,file_name,mime,vault_path,wrapped_key,key_nonce,content_nonce,sha256,imported_at,extraction_status,extraction_error)
     VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
    params![
      id,
      name,
      detected.mime(),
      vault_path.to_string_lossy(),
      B64.encode(wrapped),
      B64.encode(key_nonce),
      B64.encode(content_nonce),
      hash,
      Utc::now().to_rfc3339(),
      status,
      extraction_error
    ],
    )?;
    if let Ok(extraction) = extraction {
        for (position, segment) in extraction.segments.iter().take(250).enumerate() {
            let text = segment.text.chars().take(50_000).collect::<String>();
            if text.trim().is_empty() { continue; }
            db.execute(
                "INSERT INTO document_segments(id,document_id,locator,text,confidence,position) VALUES(?1,?2,?3,?4,?5,?6)",
                params![Uuid::new_v4().to_string(),id,segment.locator,text,segment.confidence,position as i64],
            )?;
        }
        for candidate in extraction.candidates {
            let candidate_id = Uuid::new_v4().to_string();
            db.execute(
        "INSERT INTO import_candidates(id,document_id,kind,title,course,due_at,starts_at,ends_at,duration_minutes,evidence,source_locator,source_uid,confidence,warnings,weekdays,starts_at_local,ends_at_local,timezone,section_number,location,modality)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)",
        params![
          candidate_id,
          id,
          candidate.kind,
          candidate.title,
          candidate.course,
          candidate.due_at,
          candidate.starts_at,
          candidate.ends_at,
          candidate.duration_minutes,
          candidate.evidence,
          candidate.source_locator,
          candidate.source_uid,
          candidate.confidence,
          serde_json::to_string(&candidate.warnings).unwrap_or_else(|_| "[]".into()),
          serde_json::to_string(&candidate.weekdays).unwrap_or_else(|_| "[]".into()),
          candidate.starts_at_local,
          candidate.ends_at_local,
          candidate.timezone
          ,candidate.section_number
          ,candidate.location
          ,candidate.modality
        ],
      )?;
            candidate_conflict(&db, &candidate_id, &candidate)?;
        }
    }
    mutation(&db, "document", &id, "imported", "{}")?;
    let notice = match extraction_error {
        Some(error) => format!(
            "The original is encrypted in your vault, but extraction needs attention: {error}"
        ),
        None => {
            "File encrypted and local extraction completed. Review every candidate before import."
                .into()
        }
    };
    dashboard_with_notice(&db, &state.ocr, Some(notice))
}

#[tauri::command]
fn list_documents(
    state: tauri::State<AppState>,
    query: Option<String>,
) -> Result<Vec<DocumentSummary>> {
    state.require_unlocked()?;
    let query = query.unwrap_or_default().trim().to_lowercase();
    if query.chars().count() > 120 {
        return Err(AppError::Invalid(
            "document search must be 120 characters or fewer".into(),
        ));
    }
    let pattern = format!("%{}%", query.replace('%', "\\%").replace('_', "\\_"));
    let db = state.db.lock().unwrap();
    let mut statement = db.prepare(
        "SELECT d.id,d.file_name,d.mime,d.imported_at,d.extraction_status,d.extraction_error,
                COUNT(c.id),
                COALESCE(SUM(CASE WHEN c.status='pending' THEN 1 ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN c.status='approved' THEN 1 ELSE 0 END),0),
                d.vault_path!='' AND d.content_shredded=0
         FROM documents d
         LEFT JOIN import_candidates c ON c.document_id=d.id
         WHERE (d.vault_path!='' OR d.content_shredded=1)
           AND (?1='' OR lower(d.file_name) LIKE ?2 ESCAPE '\\')
         GROUP BY d.id,d.file_name,d.mime,d.imported_at,d.extraction_status,d.extraction_error,
                  d.vault_path,d.content_shredded
         ORDER BY datetime(d.imported_at) DESC,d.id DESC
         LIMIT 250",
    )?;
    let documents = statement
        .query_map(params![query, pattern], |row| {
            Ok(DocumentSummary {
                id: row.get(0)?,
                file_name: row.get(1)?,
                mime: row.get(2)?,
                imported_at: row.get(3)?,
                extraction_status: row.get(4)?,
                extraction_error: row.get(5)?,
                candidate_count: row.get(6)?,
                pending_count: row.get(7)?,
                approved_count: row.get(8)?,
                original_available: row.get::<_, i64>(9)? != 0,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(documents)
}

/// Apply the student's explicit per-source retention decision. Nothing calls
/// this as an automatic cleanup sweep: old global screenshot preferences must
/// never bypass the choice shown after each completed import.
fn settle_schedule_source_in(db:&Connection,vault:&Path,root:&Path,document_id:&str,decision:&str)->Result<()> {
    if !matches!(decision,"keep_encrypted"|"delete_now"){return Err(AppError::Invalid("source retention decision is invalid".into()));}
    let (path,pending)=db.query_row("SELECT vault_path,(SELECT COUNT(*) FROM import_candidates WHERE document_id=d.id AND status='pending') FROM documents d WHERE id=?1",params![document_id],|row|Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?))).optional()?.ok_or_else(||AppError::Invalid("document not found".into()))?;
    if decision=="delete_now" {
        if pending>0{return Err(AppError::Invalid("finish reviewing this schedule before deleting its source".into()));}
        if !path.is_empty(){let source=PathBuf::from(&path);if !source.starts_with(vault)&&!source.starts_with(root){return Err(AppError::Invalid("stored source path is invalid".into()));}match fs::remove_file(&source){Ok(())=>{},Err(error) if error.kind()==std::io::ErrorKind::NotFound=>{},Err(error)=>return Err(error.into())}}
        db.execute("UPDATE documents SET vault_path='',wrapped_key='',key_nonce='',content_nonce='',content_shredded=1,source_retention='delete_now' WHERE id=?1",params![document_id])?;
    } else {db.execute("UPDATE documents SET source_retention='keep_encrypted' WHERE id=?1",params![document_id])?;}
    Ok(())
}

#[tauri::command]
fn settle_schedule_source(state:tauri::State<AppState>,document_id:String,decision:String)->Result<Dashboard>{
    state.require_unlocked()?;Uuid::parse_str(&document_id).map_err(|_|AppError::Invalid("document identifier is invalid".into()))?;
    let db=state.db.lock().unwrap();
    settle_schedule_source_in(&db,&state.vault,&state.root,&document_id,&decision)?;
    dashboard_with_notice(&db,&state.ocr,Some(if decision=="delete_now"{"Schedule source deleted; approved records and evidence were kept."}else{"Schedule source will remain encrypted in your vault."}.into()))
}

#[tauri::command]
async fn launch_schedule_capture(state:tauri::State<'_,AppState>)->Result<String>{
    state.require_unlocked()?;
    tauri::async_runtime::spawn_blocking(move||{
        #[cfg(target_os="macos")]
        {let status=std::process::Command::new("/usr/sbin/screencapture").args(["-i","-c"]).status()?;if !status.success(){return Err(AppError::Invalid("Screen capture was cancelled or unavailable. Use Shift-Command-4, then paste here.".into()));}return Ok("Capture copied. Press Command-V in Coqui to import it.".into());}
        #[cfg(target_os="windows")]
        {let status=std::process::Command::new("explorer.exe").arg("ms-screenclip:").status()?;if !status.success(){return Err(AppError::Invalid("Snipping Tool could not open. Press Windows-Shift-S, then paste here.".into()));}return Ok("Choose an area, then press Ctrl-V in Coqui to import it.".into());}
        #[cfg(not(any(target_os="macos",target_os="windows")))]
        {Err(AppError::Invalid("Use your system screenshot shortcut, then paste the image into Coqui.".into()))}
    }).await.map_err(|error|AppError::Background(error.to_string()))?
}

/// Read a stored image back out of the vault.
fn decrypt_original_document(
    state: &AppState,
    db: &Connection,
    document_id: &str,
) -> Result<(Vec<u8>, String, String)> {
    let (vault_path, wrapped_key, key_nonce, content_nonce, mime, file_name): (
        String,
        String,
        String,
        String,
        String,
        String,
    ) = db
        .query_row(
            "SELECT vault_path,wrapped_key,key_nonce,content_nonce,mime,file_name FROM documents WHERE id=?1",
            params![document_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| AppError::Invalid("document not found".into()))?;
    if vault_path.is_empty() {
        return Err(AppError::Invalid(
            "the original image is no longer stored; nothing was sent".into(),
        ));
    }
    let document_key = decrypt(
        &state.master_key,
        &decode_nonce(&key_nonce)?,
        &B64.decode(wrapped_key).map_err(|_| AppError::Crypto)?,
    )?;
    let document_key: [u8; 32] = document_key.try_into().map_err(|_| AppError::Crypto)?;
    let encrypted = fs::read(&vault_path)?;
    let bytes = decrypt(&document_key, &decode_nonce(&content_nonce)?, &encrypted)?;
    Ok((bytes, mime, file_name))
}

fn decrypt_document_bytes(state: &AppState, db: &Connection, document_id: &str) -> Result<Vec<u8>> {
    let (bytes, mime, _) = decrypt_original_document(state, db, document_id)?;
    if !mime.starts_with("image/") {
        return Err(AppError::Invalid(
            "only an image can be read as a schedule".into(),
        ));
    }
    Ok(bytes)
}

/// Ask the managed model to structure a schedule the local reader could not.
///
/// Opt-in per import and never invoked on the app's own initiative. This is the
/// first flow that sends a picture of the student's own screen anywhere, so it
/// takes the same explicit consent every other managed-AI call takes and states
/// plainly what leaves the machine.
///
/// The image never travels alone: the excerpt is the OCR text this machine
/// produced from that same image, and every candidate's evidence is checked to
/// be a literal span of it. The model's job is to group text we already hold,
/// not to read pixels unsupervised.
#[tauri::command]
async fn read_schedule_with_ai(
    state: tauri::State<'_, AppState>,
    document_id: String,
    consent: bool,
) -> Result<ManagedAiResult> {
    if !consent {
        return Err(AppError::Invalid(
            "explicit consent is required before sending an image".into(),
        ));
    }
    Uuid::parse_str(&document_id)
        .map_err(|_| AppError::Invalid("document identifier is invalid".into()))?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.require_unlocked()?;
        {
            let db = state.db.lock().unwrap();
            // The same gate request_managed_ai applies. Sending anything before
            // there is a profile to review it against makes no sense.
            if profile::onboarding_state(&db)?.required {
                return Err(AppError::Invalid(
                    "finish local onboarding before using an AI provider".into(),
                ));
            }
        }
        let started = Instant::now();
        let (bytes, excerpt) = {
            let db = state.db.lock().unwrap();
            let bytes = decrypt_document_bytes(&state, &db, &document_id)?;
            // The excerpt is rebuilt from the same evidence the review queue
            // already quotes, so what grounds the response is text the student
            // can see rather than anything invented for the request.
            let mut statement = db.prepare(
                "SELECT evidence FROM import_candidates WHERE document_id=?1 ORDER BY id",
            )?;
            let excerpt = statement
                .query_map(params![document_id], |row| row.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?
                .join("\n");
            (bytes, excerpt)
        };
        let excerpt = excerpt.trim().to_string();
        if excerpt.is_empty() {
            return Err(AppError::Invalid(
                "this image had no readable text to check the result against".into(),
            ));
        }
        let image = managed_ai::AiImage::encode(&bytes)?;
        let (provider, api_key, model) = {
            let db = state.db.lock().unwrap();
            resolve_ai_provider(&db, managed_ai::AiCapability::ScheduleVision)?
        };
        let response = match ai_providers::request(
            provider,
            &api_key,
            &model,
            managed_ai::AiCapability::ScheduleVision,
            &excerpt,
            "en-US",
            Some(&image),
        ) {
            Ok(response) => response,
            Err(error) => {
                // A picture of the student's screen left this machine and
                // failed. That belongs in the record as much as a success does.
                let db = state.db.lock().unwrap();
                record_ai_invocation(
                    &db,
                    provider.as_str(),
                    managed_ai::AiCapability::ScheduleVision,
                    Some(&model),
                    started.elapsed().as_millis().min(i64::MAX as u128) as i64,
                    0,
                    0,
                    "failed",
                    Some(ai_error_category(&error)),
                )?;
                persist_ai_health(&db, provider, false)?;
                return Err(AppError::ManagedAi(error));
            }
        };
        let latency_ms = started.elapsed().as_millis().min(i64::MAX as u128) as i64;
        let mut db = state.db.lock().unwrap();
        let tx = db.transaction()?;
        let timezone = tx
            .query_row("SELECT value FROM settings WHERE key='timezone'", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap_or_else(|_| "Etc/UTC".into());
        let candidates_created = response.candidates.len();
        // Asking twice is a re-read, not a second schedule. Without this the
        // same classes pile up: source_uid is stable across invocations and
        // nothing in the schema forbids the duplicate.
        tx.execute(
            "DELETE FROM import_candidates
             WHERE document_id=?1 AND source_type='managed_ai' AND status='pending'",
            params![document_id],
        )?;
        for (index, candidate) in response.candidates.iter().enumerate() {
            let kind = local_candidate_kind(&candidate.kind);
            tx.execute(
                "INSERT INTO import_candidates(
                   id,document_id,kind,title,course,due_at,starts_at,ends_at,duration_minutes,evidence,source_locator,source_type,source_uid,
                   observed_at,confidence,warnings,status,weekdays,starts_at_local,ends_at_local,timezone,section_number,location,modality
                 ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'managed_ai',?12,?13,?14,?15,'pending',?16,?17,?18,?19,?20,?21,?22)",
                params![
                    Uuid::new_v4().to_string(),
                    document_id,
                    kind,
                    candidate.title,
                    candidate.course.clone().unwrap_or_default(),
                    candidate.due_at,
                    candidate.starts_at,
                    candidate.ends_at,
                    candidate.duration_minutes,
                    candidate.evidence,
                    "AI provider · schedule",
                    format!("ai-schedule:{document_id}:{index}"),
                    Utc::now().to_rfc3339(),
                    candidate.confidence,
                    serde_json::to_string(&candidate.warnings).unwrap_or_else(|_| "[]".into()),
                    serde_json::to_string(&candidate.weekdays).unwrap_or_else(|_| "[]".into()),
                    candidate.starts_at_local.clone().unwrap_or_default(),
                    candidate.ends_at_local.clone().unwrap_or_default(),
                    if kind == "class_meeting" { timezone.as_str() } else { "" },
                    candidate.section_number.clone().unwrap_or_default(),
                    candidate.location.clone().unwrap_or_default(),
                    candidate.modality.clone().unwrap_or_default(),
                ],
            )?;
        }
        record_ai_invocation(
            &tx,
            provider.as_str(),
            managed_ai::AiCapability::ScheduleVision,
            Some(&response.model),
            latency_ms,
            response.usage.input_tokens,
            response.usage.output_tokens,
            "review_created",
            None,
        )?;
        tx.commit()?;
        let dashboard = dashboard_with_notice(
            &db,
            &state.ocr,
            Some(format!(
                "{} proposed {candidates_created} class{} for review; nothing was added to your plan.",
                provider.as_str(),
                if candidates_created == 1 { "" } else { "es" }
            )),
        )?;
        Ok(ManagedAiResult {
            dashboard,
            explanation: response.explanation,
            candidates_created,
            model: response.model,
            provider: provider.as_str().into(),
        })
    })
    .await
    .map_err(|error| AppError::Invalid(error.to_string()))?
}

#[tauri::command]
async fn analyze_schedule_source(
    state: tauri::State<'_, AppState>,
    document_id: String,
    consent: bool,
) -> Result<ManagedAiResult> {
    state.require_unlocked()?;
    read_schedule_with_ai(state, document_id, consent).await
}

/// Course codes already on this profile.
fn enrolled_course_codes(db: &Connection) -> Vec<String> {
    db.prepare("SELECT code FROM courses WHERE code != ''")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()
        })
        .unwrap_or_default()
}

/// Schedule layouts for the school on this profile, if it has a descriptor.
fn student_schedule_layouts(db: &Connection) -> Vec<school_provider::ScheduleLayout> {
    let Ok(raw) = db.query_row(
        "SELECT value FROM settings WHERE key='institution_selection'",
        [],
        |row| row.get::<_, String>(0),
    ) else {
        return Vec::new();
    };
    let Ok(selection) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    selection
        .get("id")
        .and_then(|id| id.as_str())
        .and_then(school_provider_for)
        .map(|provider| provider.schedule_layouts.clone())
        .unwrap_or_default()
}

/// Map a managed-AI candidate kind onto a kind this app can actually apply.
///
/// `apply_candidate` knows three: task, commitment and class_meeting. The rest
/// are shades of task that the planner treats identically, so they collapse and
/// the reviewer is told they did.
///
/// `academic_event` is the deliberate exception worth naming: a holiday or a
/// reading day is a real thing with nowhere to go yet, because the academic
/// calendar arrives through its own reviewed diff rather than through document
/// extraction. It collapses to a task, with the warning, until that path exists.
/// Filing it as a task the student can see beats dropping it silently.
fn local_candidate_kind(kind: &str) -> &'static str {
    match kind {
        "commitment" => "commitment",
        "class_meeting" => "class_meeting",
        _ => "task",
    }
}

#[tauri::command]
fn get_document_evidence(
    state: tauri::State<AppState>,
    document_id: String,
) -> Result<Vec<Candidate>> {
    state.require_unlocked()?;
    Uuid::parse_str(&document_id)
        .map_err(|_| AppError::Invalid("document identifier is invalid".into()))?;
    let db = state.db.lock().unwrap();
    document_evidence_in(&db, &document_id)
}

#[tauri::command]
fn get_schedule_source_preview(
    state: tauri::State<AppState>,
    document_id: String,
) -> Result<ScheduleSourcePreview> {
    state.require_unlocked()?;
    Uuid::parse_str(&document_id)
        .map_err(|_| AppError::Invalid("document identifier is invalid".into()))?;
    let db = state.db.lock().unwrap();
    let (bytes, mime, file_name) = decrypt_original_document(&state, &db, &document_id)?;
    if !mime.starts_with("image/") && mime != "application/pdf" {
        return Err(AppError::Invalid("this schedule source has no visual preview".into()));
    }
    if bytes.len() > 12 * 1024 * 1024 {
        return Err(AppError::Invalid(
            "this source is too large for the review preview; its extracted evidence remains available".into(),
        ));
    }
    Ok(ScheduleSourcePreview {
        file_name,
        data_url: format!("data:{mime};base64,{}", B64.encode(bytes)),
        mime,
    })
}

#[tauri::command]
fn update_import_candidate(
    state: tauri::State<AppState>,
    candidate_id: String,
    mut input: CandidateEditInput,
) -> Result<Dashboard> {
    state.require_unlocked()?;
    Uuid::parse_str(&candidate_id)
        .map_err(|_| AppError::Invalid("candidate identifier is invalid".into()))?;
    input.title = input.title.trim().to_string();
    input.course = input.course.trim().to_string();
    input.starts_at_local = input.starts_at_local.trim().to_string();
    input.ends_at_local = input.ends_at_local.trim().to_string();
    input.timezone = input.timezone.trim().to_string();
    input.section_number = input.section_number.trim().to_string();
    input.location = input.location.trim().to_string();
    input.modality = input.modality.trim().to_string();
    input.term_id = input.term_id.trim().to_string();
    input.due_at = input.due_at.filter(|value| !value.trim().is_empty());
    input.starts_at = input.starts_at.filter(|value| !value.trim().is_empty());
    input.ends_at = input.ends_at.filter(|value| !value.trim().is_empty());
    input.weekdays.sort_unstable();
    input.weekdays.dedup();
    if input.title.is_empty()
        || input.title.len() > 200
        || input.course.len() > 200
        || input.section_number.len() > 80
        || input.location.len() > 200
        || input.modality.len() > 80
        || (!input.term_id.is_empty() && Uuid::parse_str(&input.term_id).is_err())
        || input.duration_minutes.is_some_and(|value| !(5..=480).contains(&value))
        || input.due_at.as_deref().is_some_and(|value| parse_rfc3339(value).is_none())
        || input.starts_at.as_deref().is_some_and(|value| parse_rfc3339(value).is_none())
        || input.ends_at.as_deref().is_some_and(|value| parse_rfc3339(value).is_none())
    {
        return Err(AppError::Invalid("candidate edits are invalid".into()));
    }
    let db = state.db.lock().unwrap();
    let (kind, current, edited_json, last_json): (String, CandidateEditInput, String, String) = db
        .query_row(
            "SELECT kind,title,course,due_at,starts_at,ends_at,duration_minutes,weekdays,
                    starts_at_local,ends_at_local,timezone,section_number,location,modality,term_id,
                    student_edited_fields,last_observed_payload
             FROM import_candidates WHERE id=?1 AND status='pending'",
            params![candidate_id],
            |row| {
                Ok((
                    row.get(0)?,
                    CandidateEditInput {
                        title: row.get(1)?,
                        course: row.get(2)?,
                        due_at: row.get(3)?,
                        starts_at: row.get(4)?,
                        ends_at: row.get(5)?,
                        duration_minutes: row.get(6)?,
                        weekdays: serde_json::from_str(&row.get::<_, String>(7)?).unwrap_or_default(),
                        starts_at_local: row.get(8)?,
                        ends_at_local: row.get(9)?,
                        timezone: row.get(10)?,
                        section_number: row.get(11)?,
                        location: row.get(12)?,
                        modality: row.get(13)?,
                        term_id: row.get(14)?,
                    },
                    row.get(15)?,
                    row.get(16)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| AppError::Invalid("pending candidate not found".into()))?;
    if kind == "class_meeting" {
        let starts = parse_clock(&input.starts_at_local);
        let ends = parse_clock(&input.ends_at_local);
        if input.course.is_empty()
            || input.weekdays.is_empty()
            || input.weekdays.len() > 7
            || input.weekdays.iter().any(|day| !(0..=6).contains(day))
            || starts.is_none()
            || ends.is_none()
            || starts >= ends
            || input.timezone.parse::<Tz>().is_err()
            || (!input.term_id.is_empty() && db.query_row("SELECT COUNT(*) FROM academic_terms WHERE id=?1",params![input.term_id],|row|row.get::<_,i64>(0))? != 1)
        {
            return Err(AppError::Invalid("weekly class edits are incomplete or invalid".into()));
        }
    } else if kind == "commitment" {
        if input.starts_at.is_none()
            || input.ends_at.is_none()
            || input.starts_at.as_deref().and_then(parse_rfc3339)
                >= input.ends_at.as_deref().and_then(parse_rfc3339)
        {
            return Err(AppError::Invalid("commitment edits require a valid time range".into()));
        }
    }
    let field_values = |value: &CandidateEditInput| {
        serde_json::to_value(value).unwrap_or_else(|_| serde_json::json!({}))
    };
    let current_value = field_values(&current);
    let next_value = field_values(&input);
    let mut edited = serde_json::from_str::<Vec<String>>(&edited_json).unwrap_or_default();
    for field in [
        "title", "course", "dueAt", "startsAt", "endsAt", "durationMinutes",
        "weekdays", "startsAtLocal", "endsAtLocal", "timezone", "sectionNumber",
        "location", "modality", "termId",
    ] {
        if current_value.get(field) != next_value.get(field) && !edited.iter().any(|item| item == field) {
            edited.push(field.to_string());
        }
    }
    edited.sort();
    let original = if last_json == "{}" {
        current_value
    } else {
        serde_json::from_str(&last_json).unwrap_or(current_value)
    };
    db.execute(
        "UPDATE import_candidates SET title=?2,course=?3,due_at=?4,starts_at=?5,ends_at=?6,
                duration_minutes=?7,weekdays=?8,starts_at_local=?9,ends_at_local=?10,
                timezone=?11,section_number=?12,location=?13,modality=?14,term_id=?15,
                student_edited_fields=?16,last_observed_payload=?17 WHERE id=?1 AND status='pending'",
        params![
            candidate_id,input.title,input.course,input.due_at,input.starts_at,input.ends_at,
            input.duration_minutes,serde_json::to_string(&input.weekdays).unwrap_or_else(|_|"[]".into()),
            input.starts_at_local,input.ends_at_local,input.timezone,input.section_number,input.location,
            input.modality,input.term_id,serde_json::to_string(&edited).unwrap_or_else(|_|"[]".into()),
            serde_json::to_string(&original).unwrap_or_else(|_|"{}".into()),
        ],
    )?;
    dashboard_with_notice(&db, &state.ocr, Some("Candidate edits saved for review; your plan has not changed.".into()))
}

/// The query behind `get_document_evidence`, split out so it can be tested
/// without a Tauri `State`. The column list and the row indices below must stay
/// in step: reading past the end of the `SELECT` is a runtime error that only
/// fires once a document actually has candidates, which is how the four weekly
/// pattern columns went missing here while the `dashboard` query had them.
fn document_evidence_in(db: &Connection, document_id: &str) -> Result<Vec<Candidate>> {
    let exists = db.query_row(
        // A shredded screenshot still has evidence worth reading, even though
        // the image behind it is gone. A Canvas stub, which never had a blob,
        // still does not.
        "SELECT EXISTS(SELECT 1 FROM documents WHERE id=?1 AND (vault_path!='' OR content_shredded=1))",
        params![document_id],
        |row| row.get::<_, i64>(0),
    )? != 0;
    if !exists {
        return Err(AppError::Invalid("document not found".into()));
    }
    let mut statement = db.prepare(
        "SELECT id,document_id,kind,title,course,due_at,starts_at,ends_at,duration_minutes,evidence,
                source_locator,source_type,source_url,confidence,warnings,status,
                weekdays,starts_at_local,ends_at_local,timezone,section_number,location,modality,student_edited_fields,term_id,
                CASE WHEN ic.source_uid!='' AND (
                  (ic.kind='task' AND EXISTS(SELECT 1 FROM tasks t WHERE t.source_uid=ic.source_uid)) OR
                  (ic.kind='commitment' AND EXISTS(SELECT 1 FROM commitments c WHERE c.source_uid=ic.source_uid)) OR
                  (ic.kind='course' AND EXISTS(SELECT 1 FROM courses c WHERE c.source_uid=ic.source_uid)) OR
                  (ic.kind='class_meeting' AND EXISTS(SELECT 1 FROM class_meeting_series m WHERE m.source_uid=ic.source_uid))
                ) THEN 'update' ELSE 'add' END
         FROM import_candidates ic WHERE document_id=?1
         ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
                  confidence DESC,id",
    )?;
    let candidates = statement
        .query_map(params![document_id], |row| {
            let warnings: String = row.get(14)?;
            Ok(Candidate {
                id: row.get(0)?,
                document_id: row.get(1)?, kind: row.get(2)?, title: row.get(3)?, course: row.get(4)?, due_at: row.get(5)?, starts_at: row.get(6)?, ends_at: row.get(7)?, duration_minutes: row.get(8)?, evidence: row.get(9)?, source_locator: row.get(10)?, source_type: row.get(11)?, source_url: row.get(12)?, confidence: row.get(13)?,
                warnings: serde_json::from_str(&warnings).unwrap_or_default(),
                status: row.get(15)?, weekdays: serde_json::from_str(&row.get::<_, String>(16)?).unwrap_or_default(), starts_at_local: row.get(17)?, ends_at_local: row.get(18)?, timezone: row.get(19)?,
                section_number: row.get(20)?, location: row.get(21)?, modality: row.get(22)?, student_edited_fields: serde_json::from_str(&row.get::<_, String>(23)?).unwrap_or_default(), term_id:row.get(24)?, suggested_action:row.get(25)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(candidates)
}

#[derive(Debug, Default)]
struct PendingCandidate {
    id: String,
    kind: String,
    title: String,
    due_at: Option<String>,
    starts_at: Option<String>,
    ends_at: Option<String>,
    duration_minutes: Option<i64>,
    course: String,
    source_uid: String,
    /// Only populated for `class_meeting`, which is a weekly pattern rather than
    /// the single instant the datetime fields above describe.
    weekdays: Vec<i64>,
    starts_at_local: String,
    ends_at_local: String,
    timezone: String,
    section_number: String,
    location: String,
    modality: String,
    term_id: String,
}

fn pending_candidate(conn: &Connection, id: &str) -> Result<Option<PendingCandidate>> {
    Ok(conn
        .query_row(
            "SELECT id,kind,title,due_at,starts_at,ends_at,duration_minutes,course,source_uid,
                    weekdays,starts_at_local,ends_at_local,timezone,section_number,location,modality,term_id
             FROM import_candidates WHERE id=?1 AND status='pending'",
            params![id],
            |row| {
                let weekdays: String = row.get(9)?;
                Ok(PendingCandidate {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    title: row.get(2)?,
                    due_at: row.get(3)?,
                    starts_at: row.get(4)?,
                    ends_at: row.get(5)?,
                    duration_minutes: row.get(6)?,
                    course: row.get(7)?,
                    source_uid: row.get(8)?,
                    weekdays: serde_json::from_str(&weekdays).unwrap_or_default(),
                    starts_at_local: row.get(10)?,
                    ends_at_local: row.get(11)?,
                    timezone: row.get(12)?,
                    section_number: row.get(13)?,
                    location: row.get(14)?,
                    modality: row.get(15)?,
                    term_id: row.get(16)?,
                })
            },
        )
        .optional()?)
}

fn has_unresolved_candidate_conflict(conn: &Connection, candidate_id: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM source_conflicts WHERE candidate_id=?1 AND resolved=0)",
        params![candidate_id],
        |row| row.get::<_, i64>(0),
    )? != 0)
}

fn existing_entity_for_source(
    conn: &Connection,
    table: &str,
    source_uid: &str,
) -> Result<Option<String>> {
    if source_uid.is_empty() {
        return Ok(None);
    }
    let sql = match table {
        "tasks" => "SELECT id FROM tasks WHERE source_uid=?1 ORDER BY rowid LIMIT 1",
        "commitments" => "SELECT id FROM commitments WHERE source_uid=?1 ORDER BY rowid LIMIT 1",
        "courses" => "SELECT id FROM courses WHERE source_uid=?1 ORDER BY rowid LIMIT 1",
        "class_meeting_series" => {
            "SELECT id FROM class_meeting_series WHERE source_uid=?1 ORDER BY rowid LIMIT 1"
        }
        _ => return Err(AppError::Invalid("unsupported canonical entity".into())),
    };
    Ok(conn
        .query_row(sql, params![source_uid], |row| row.get::<_, String>(0))
        .optional()?)
}

fn link_candidate_provenance(
    conn: &Connection,
    entity_type: &str,
    entity_id: &str,
    candidate_id: &str,
) -> Result<()> {
    let (
        source_object_id,
        document_id,
        source_kind,
        external_stable_id,
        evidence,
        confidence,
        import_time,
        edited_json,
        last_json,
        title,
        course,
        due_at,
        starts_at,
        ends_at,
        duration_minutes,
        weekdays,
        starts_at_local,
        ends_at_local,
        timezone,
        section_number,
        location,
        modality,
        term_id,
    ) = conn.query_row(
        "SELECT source_object_id,document_id,source_type,source_uid,evidence,confidence,
                COALESCE(observed_at,''),student_edited_fields,last_observed_payload,
                title,course,due_at,starts_at,ends_at,duration_minutes,weekdays,
                starts_at_local,ends_at_local,timezone,section_number,location,modality,term_id
         FROM import_candidates WHERE id=?1",
        params![candidate_id],
        |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, f64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, Option<String>>(11)?,
                row.get::<_, Option<String>>(12)?,
                row.get::<_, Option<String>>(13)?,
                row.get::<_, Option<i64>>(14)?,
                row.get::<_, String>(15)?,
                row.get::<_, String>(16)?,
                row.get::<_, String>(17)?,
                row.get::<_, String>(18)?,
                row.get::<_, String>(19)?,
                row.get::<_, String>(20)?,
                row.get::<_, String>(21)?,
                row.get::<_, String>(22)?,
            ))
        },
    )?;
    let edited_fields = serde_json::from_str::<Vec<String>>(&edited_json).unwrap_or_default();
    let last_observed = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&last_json).unwrap_or_default();
    let fields = [
        ("title", Some(title)),
        ("course", (!course.is_empty()).then_some(course)),
        ("due_at", due_at),
        ("starts_at", starts_at),
        ("ends_at", ends_at),
        ("duration_minutes", duration_minutes.map(|value| value.to_string())),
        ("weekdays", (weekdays != "[]").then_some(weekdays)),
        ("starts_at_local", (!starts_at_local.is_empty()).then_some(starts_at_local)),
        ("ends_at_local", (!ends_at_local.is_empty()).then_some(ends_at_local)),
        ("timezone", (!timezone.is_empty()).then_some(timezone)),
        ("section_number", (!section_number.is_empty()).then_some(section_number)),
        ("location", (!location.is_empty()).then_some(location)),
        ("modality", (!modality.is_empty()).then_some(modality)),
        ("term_id", (!term_id.is_empty()).then_some(term_id)),
    ];
    for (field_name, source_value) in fields {
        let Some(source_value) = source_value else {
            continue;
        };
        let edit_key = match field_name {
            "due_at" => "dueAt",
            "starts_at" => "startsAt",
            "ends_at" => "endsAt",
            "duration_minutes" => "durationMinutes",
            "starts_at_local" => "startsAtLocal",
            "ends_at_local" => "endsAtLocal",
            "section_number" => "sectionNumber",
            "term_id" => "termId",
            value => value,
        };
        let last_observed_value = last_observed
            .get(edit_key)
            .map(|value| match value {
                serde_json::Value::String(text) => text.clone(),
                serde_json::Value::Null => String::new(),
                value => value.to_string(),
            })
            .unwrap_or_else(|| source_value.clone());
        conn.execute(
            "UPDATE provenance_links SET active=0
             WHERE entity_type=?1 AND entity_id=?2 AND field_name=?3 AND active=1",
            params![entity_type, entity_id, field_name],
        )?;
        conn.execute(
            "INSERT INTO provenance_links(
               id,entity_type,entity_id,candidate_id,source_object_id,field_name,
               source_value,evidence,created_at,active,source_kind,sanitized_source_identifier,
               external_stable_id,confidence,import_time,last_observed_source_value,student_edited
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,1,?10,?11,?12,?13,?14,?15,?16)",
            params![
                Uuid::new_v4().to_string(),
                entity_type,
                entity_id,
                candidate_id,
                source_object_id,
                field_name,
                source_value,
                evidence,
                Utc::now().to_rfc3339(),
                source_kind,
                document_id,
                external_stable_id,
                confidence,
                if import_time.is_empty() { None } else { Some(import_time.as_str()) },
                last_observed_value,
                i64::from(edited_fields.iter().any(|field| field == edit_key)),
            ],
        )?;
    }
    Ok(())
}

fn apply_candidate(
    conn: &Connection,
    candidate: &PendingCandidate,
    required_entity_id: Option<&str>,
) -> Result<String> {
    let source_uid = if candidate.source_uid.is_empty() {
        format!("candidate:{}", candidate.id)
    } else {
        candidate.source_uid.clone()
    };
    let (entity_id, operation) = match candidate.kind.as_str() {
        "task" => {
            let minutes = candidate.duration_minutes.unwrap_or(45);
            if candidate.title.trim().is_empty() || !(5..=480).contains(&minutes) {
                return Err(AppError::Invalid(
                    "candidate contains an invalid task".into(),
                ));
            }
            let existing = match required_entity_id {
                Some(id) => Some(id.to_string()),
                None => existing_entity_for_source(conn, "tasks", &source_uid)?,
            };
            if let Some(id) = existing {
                let changed = conn.execute(
                    "UPDATE tasks SET title=?2,minutes=?3,due_at=?4,source_uid=?5,
                     source_candidate_id=?6,version=version+1 WHERE id=?1",
                    params![
                        id,
                        candidate.title.trim(),
                        minutes,
                        candidate.due_at,
                        source_uid,
                        candidate.id
                    ],
                )?;
                if changed == 0 {
                    return Err(AppError::Invalid("conflicted task no longer exists".into()));
                }
                (id, "source_updated")
            } else {
                let id = Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO tasks(id,title,minutes,due_at,created_at,source_uid,source_candidate_id)
                     VALUES(?1,?2,?3,?4,?5,?6,?7)",
                    params![id, candidate.title.trim(), minutes, candidate.due_at, Utc::now().to_rfc3339(), source_uid, candidate.id],
                )?;
                (id, "source_created")
            }
        }
        "commitment" => {
            let starts_at = candidate
                .starts_at
                .as_deref()
                .ok_or_else(|| AppError::Invalid("commitment candidate has no start".into()))?;
            let ends_at = candidate
                .ends_at
                .as_deref()
                .ok_or_else(|| AppError::Invalid("commitment candidate has no end".into()))?;
            let parsed_start = parse_rfc3339(starts_at);
            let parsed_end = parse_rfc3339(ends_at);
            if parsed_start.is_none() || parsed_end.is_none() || parsed_start >= parsed_end {
                return Err(AppError::Invalid(
                    "commitment candidate has an invalid time range".into(),
                ));
            }
            let existing = match required_entity_id {
                Some(id) => Some(id.to_string()),
                None => existing_entity_for_source(conn, "commitments", &source_uid)?,
            };
            if let Some(id) = existing {
                let changed = conn.execute(
                    "UPDATE commitments SET title=?2,starts_at=?3,ends_at=?4,source_uid=?5,
                     source_candidate_id=?6,version=version+1 WHERE id=?1",
                    params![
                        id,
                        candidate.title,
                        starts_at,
                        ends_at,
                        source_uid,
                        candidate.id
                    ],
                )?;
                if changed == 0 {
                    return Err(AppError::Invalid(
                        "conflicted commitment no longer exists".into(),
                    ));
                }
                (id, "source_updated")
            } else {
                let id = Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO commitments(
                       id,title,starts_at,ends_at,kind,locked,source_uid,source_candidate_id
                     ) VALUES(?1,?2,?3,?4,'class',1,?5,?6)",
                    params![
                        id,
                        candidate.title,
                        starts_at,
                        ends_at,
                        source_uid,
                        candidate.id
                    ],
                )?;
                (id, "source_created")
            }
        }
        "course" => {
            let existing = match required_entity_id {
                Some(id) => Some(id.to_string()),
                None => existing_entity_for_source(conn, "courses", &source_uid)?,
            };
            if let Some(id) = existing {
                let changed = conn.execute(
                    "UPDATE courses SET title=?2,code=?3,source_uid=?4,source_candidate_id=?5,
                     version=version+1 WHERE id=?1",
                    params![
                        id,
                        candidate.title,
                        candidate.course,
                        source_uid,
                        candidate.id
                    ],
                )?;
                if changed == 0 {
                    return Err(AppError::Invalid(
                        "conflicted course no longer exists".into(),
                    ));
                }
                (id, "source_updated")
            } else {
                let id = Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO courses(id,title,code,source_uid,source_candidate_id)
                     VALUES(?1,?2,?3,?4,?5)",
                    params![
                        id,
                        candidate.title,
                        candidate.course,
                        source_uid,
                        candidate.id
                    ],
                )?;
                (id, "source_created")
            }
        }
        "class_meeting" => {
            if candidate.weekdays.is_empty()
                || candidate.starts_at_local.is_empty()
                || candidate.ends_at_local.is_empty()
            {
                return Err(AppError::Invalid(
                    "class meeting candidate has no weekly pattern".into(),
                ));
            }
            // A meeting belongs to a course, so the course has to exist first.
            // Matched on title or code rather than created blindly, so importing
            // a schedule twice does not leave two of every class.
            let course_id = match conn
                .query_row(
                    "SELECT id FROM courses WHERE title=?1 COLLATE NOCASE OR (code!='' AND code=?1 COLLATE NOCASE) LIMIT 1",
                    params![candidate.course.trim()],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
            {
                Some(id) => id,
                None => {
                    let id = Uuid::new_v4().to_string();
                    conn.execute(
                        "INSERT INTO courses(id,title,code,source_uid,source_candidate_id)
                         VALUES(?1,?2,'',?3,?4)",
                        params![
                            id,
                            candidate.course.trim(),
                            format!("{source_uid}:course"),
                            candidate.id
                        ],
                    )?;
                    mutation(conn, "course", &id, "source_created", "{}")?;
                    id
                }
            };
            // The term that actually contains the first meeting, falling back to
            // the active one. A calendar file has no notion of terms, and the
            // recurrence count says nothing about which term it sits in.
            let first_day = candidate
                .starts_at
                .as_deref()
                .and_then(parse_rfc3339)
                .map(|value| value.date_naive().to_string())
                .unwrap_or_default();
            let term_id = if candidate.term_id.is_empty() {
                conn.query_row(
                    "SELECT id FROM academic_terms
                     WHERE ?1!='' AND starts_on<=?1 AND ends_on>=?1
                     ORDER BY starts_on LIMIT 1",
                    params![first_day],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .or(conn
                    .query_row(
                        "SELECT id FROM academic_terms WHERE active=1 ORDER BY starts_on LIMIT 1",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?)
            } else {
                conn.query_row(
                    "SELECT id FROM academic_terms WHERE id=?1",
                    params![candidate.term_id],
                    |row| row.get::<_, String>(0),
                ).optional()?
            }.ok_or_else(|| AppError::Invalid("select a valid academic term before importing a class schedule".into()))?;

            let existing = match required_entity_id {
                Some(id) => Some(id.to_string()),
                None => existing_entity_for_source(conn, "class_meeting_series", &source_uid)?,
            };
            let weekdays = serde_json::to_string(&candidate.weekdays)
                .unwrap_or_else(|_| "[]".into());
            let timezone = if candidate.timezone.trim().is_empty() {
                "UTC"
            } else {
                candidate.timezone.trim()
            };
            if let Some(id) = existing {
                let changed = conn.execute(
                    "UPDATE class_meeting_series SET course_id=?2,term_id=?3,timezone=?4,weekdays=?5,
                     starts_at_local=?6,ends_at_local=?7,component=?8,location=?9,modality=?10,source_uid=?11,source_candidate_id=?12,
                     version=version+1 WHERE id=?1",
                    params![
                        id,
                        course_id,
                        term_id,
                        timezone,
                        weekdays,
                        candidate.starts_at_local,
                        candidate.ends_at_local,
                        if candidate.section_number.trim().is_empty() { "lecture" } else { candidate.section_number.trim() },
                        candidate.location.trim(),
                        candidate.modality.trim(),
                        source_uid,
                        candidate.id
                    ],
                )?;
                if changed == 0 {
                    return Err(AppError::Invalid(
                        "conflicted class meeting no longer exists".into(),
                    ));
                }
                (id, "source_updated")
            } else {
                let id = Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO class_meeting_series(id,course_id,term_id,timezone,weekdays,
                     starts_at_local,ends_at_local,component,location,modality,source_uid,source_candidate_id)
                     VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                    params![
                        id,
                        course_id,
                        term_id,
                        timezone,
                        weekdays,
                        candidate.starts_at_local,
                        candidate.ends_at_local,
                        if candidate.section_number.trim().is_empty() { "lecture" } else { candidate.section_number.trim() },
                        candidate.location.trim(),
                        candidate.modality.trim(),
                        source_uid,
                        candidate.id
                    ],
                )?;
                (id, "source_created")
            }
        }
        kind => {
            return Err(AppError::Invalid(format!(
                "unsupported candidate kind {kind}"
            )))
        }
    };
    conn.execute(
        "UPDATE import_candidates SET status='approved',canonical_entity_id=?2 WHERE id=?1",
        params![candidate.id, entity_id],
    )?;
    // Every other kind names its own entity type. A class_meeting candidate
    // becomes a class_meeting_series, which is the name the replication set and
    // the mutation log know it by.
    let entity_type = candidate_entity_type(&candidate.kind);
    link_candidate_provenance(conn, entity_type, &entity_id, &candidate.id)?;
    mutation(conn, entity_type, &entity_id, operation, "{}")?;
    mutation(conn, "import_candidate", &candidate.id, "approved", "{}")?;
    Ok(entity_id)
}

/// The replicated entity a candidate of this kind becomes.
fn candidate_entity_type(kind: &str) -> &str {
    match kind {
        "class_meeting" => "class_meeting_series",
        other => other,
    }
}

#[tauri::command]
fn approve_candidates(state: tauri::State<AppState>, ids: Vec<String>) -> Result<Dashboard> {
    state.require_unlocked()?;
    let mut db = state.db.lock().unwrap();
    require_onboarded(&db)?;
    let transaction = db.transaction()?;
    for id in ids {
        if has_unresolved_candidate_conflict(&transaction, &id)? {
            return Err(AppError::Invalid(
                "A critical source change must be resolved explicitly before import".into(),
            ));
        }
        if let Some(candidate) = pending_candidate(&transaction, &id)? {
            apply_candidate(&transaction, &candidate, None)?;
        }
    }
    transaction.commit()?;
    regenerate_plan_for_trigger(&db, None, planner::PlannerTrigger::ImportApproved)?;
    dashboard(&db, &state.ocr)
}

#[tauri::command]
fn apply_schedule_import(state: tauri::State<AppState>, ids: Vec<String>) -> Result<Dashboard> {
    state.require_unlocked()?;
    approve_candidates(state, ids)
}

#[tauri::command]
fn reject_candidates(state: tauri::State<AppState>, ids: Vec<String>) -> Result<Dashboard> {
    state.require_unlocked()?;
    let mut db = state.db.lock().unwrap();
    let transaction = db.transaction()?;
    for id in ids {
        if has_unresolved_candidate_conflict(&transaction, &id)? {
            return Err(AppError::Invalid(
                "A critical source change must be resolved explicitly".into(),
            ));
        }
        let changed = transaction.execute(
            "UPDATE import_candidates SET status='rejected' WHERE id=?1 AND status='pending'",
            params![id],
        )?;
        if changed > 0 {
            mutation(&transaction, "import_candidate", &id, "rejected", "{}")?;
        }
    }
    transaction.commit()?;
    dashboard(&db, &state.ocr)
}

fn resolve_source_conflict_in_db(
    db: &mut Connection,
    conflict_id: &str,
    resolution: &str,
) -> Result<()> {
    if resolution != "keep_existing" && resolution != "use_source" {
        return Err(AppError::Invalid("unsupported conflict resolution".into()));
    }
    let transaction = db.transaction()?;
    let conflict = transaction
        .query_row(
            "SELECT kind,candidate_id,entity_type,entity_id,proposed_due_at,proposed_starts_at,proposed_ends_at
             FROM source_conflicts WHERE id=?1 AND kind IN ('source_change','sync_critical_date') AND resolved=0",
            params![conflict_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| AppError::Invalid("source conflict not found or already resolved".into()))?;
    let (kind, candidate_id, entity_type, entity_id, proposed_due, proposed_start, proposed_end) =
        conflict;
    if kind == "sync_critical_date" {
        if resolution == "use_source" {
            match entity_type.as_str() {
                "task" | "assignment" | "exam" => {
                    transaction.execute(
                        "UPDATE tasks SET due_at=?2,version=version+1 WHERE id=?1",
                        params![entity_id, proposed_due],
                    )?;
                }
                "commitment" => {
                    let start = proposed_start.ok_or_else(|| {
                        AppError::Invalid("the synchronized commitment start is missing".into())
                    })?;
                    let end = proposed_end.ok_or_else(|| {
                        AppError::Invalid("the synchronized commitment end is missing".into())
                    })?;
                    transaction.execute(
                        "UPDATE commitments SET starts_at=?2,ends_at=?3,version=version+1 WHERE id=?1",
                        params![entity_id, start, end],
                    )?;
                }
                "academic_term" => {
                    let start = proposed_start.ok_or_else(|| {
                        AppError::Invalid("the synchronized term start is missing".into())
                    })?;
                    let end = proposed_end.ok_or_else(|| {
                        AppError::Invalid("the synchronized term end is missing".into())
                    })?;
                    transaction.execute(
                        "UPDATE academic_terms SET starts_on=?2,ends_on=?3,version=version+1 WHERE id=?1",
                        params![entity_id, start, end],
                    )?;
                }
                _ => {
                    return Err(AppError::Invalid(
                        "unsupported synchronized conflict entity".into(),
                    ))
                }
            }
            mutation(
                &transaction,
                &entity_type,
                &entity_id,
                "sync_conflict_resolved",
                "{}",
            )?;
        }
    } else if resolution == "use_source" {
        let candidate_id = candidate_id
            .as_deref()
            .ok_or_else(|| AppError::Invalid("source conflict candidate is missing".into()))?;
        let candidate = pending_candidate(&transaction, &candidate_id)?
            .ok_or_else(|| AppError::Invalid("conflict candidate is no longer pending".into()))?;
        if candidate.kind != entity_type {
            return Err(AppError::Invalid("conflict entity type mismatch".into()));
        }
        apply_candidate(&transaction, &candidate, Some(&entity_id))?;
    } else {
        let candidate_id = candidate_id
            .as_deref()
            .ok_or_else(|| AppError::Invalid("source conflict candidate is missing".into()))?;
        let changed = transaction.execute(
            "UPDATE import_candidates SET status='rejected' WHERE id=?1 AND status='pending'",
            params![candidate_id],
        )?;
        if changed == 0 {
            return Err(AppError::Invalid(
                "conflict candidate is no longer pending".into(),
            ));
        }
        mutation(
            &transaction,
            "import_candidate",
            candidate_id,
            "rejected_source_change",
            "{}",
        )?;
    }
    transaction.execute(
        "UPDATE source_conflicts SET resolved=1,resolved_at=?2,resolution=?3 WHERE id=?1",
        params![conflict_id, Utc::now().to_rfc3339(), resolution],
    )?;
    mutation(
        &transaction,
        "source_conflict",
        &conflict_id,
        "resolved",
        &serde_json::json!({ "resolution": resolution }).to_string(),
    )?;
    transaction.commit()?;
    regenerate_plan(&db, None)?;
    Ok(())
}

#[tauri::command]
fn resolve_source_conflict(
    state: tauri::State<AppState>,
    conflict_id: String,
    resolution: String,
) -> Result<Dashboard> {
    state.require_unlocked()?;
    let mut db = state.db.lock().unwrap();
    resolve_source_conflict_in_db(&mut db, &conflict_id, &resolution)?;
    dashboard_with_notice(
        &db,
        &state.ocr,
        Some(if resolution == "use_source" {
            "The proposed critical value was accepted and the flexible plan rebuilt.".into()
        } else {
            "Your existing critical value was preserved and the proposed change was dismissed."
                .into()
        }),
    )
}

fn decode_nonce(value: &str) -> Result<[u8; 24]> {
    let bytes = B64
        .decode(value)
        .map_err(|_| AppError::Invalid("backup contains invalid encrypted-key metadata".into()))?;
    bytes
        .try_into()
        .map_err(|_| AppError::Invalid("backup contains an invalid encryption nonce".into()))
}

fn prepare_staged_profile(state: &AppState, staged: &backup::StagedArchive) -> Result<()> {
    let mut conn = open_keyed_database(&staged.database_path, &staged.archived_key)?;
    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(AppError::Invalid(format!(
            "backup database failed integrity validation: {integrity}"
        )));
    }
    let actual_counts = (
        conn.query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get::<_, i64>(0))?,
        conn.query_row("SELECT COUNT(*) FROM commitments", [], |row| {
            row.get::<_, i64>(0)
        })?,
        conn.query_row("SELECT COUNT(*) FROM courses", [], |row| {
            row.get::<_, i64>(0)
        })?,
        conn.query_row("SELECT COUNT(*) FROM documents", [], |row| {
            row.get::<_, i64>(0)
        })?,
        conn.query_row(
            "SELECT COUNT(*) FROM import_candidates WHERE status='pending'",
            [],
            |row| row.get::<_, i64>(0),
        )?,
    );
    let counts = &staged.manifest.counts;
    if actual_counts
        != (
            counts.tasks,
            counts.commitments,
            counts.courses,
            counts.documents,
            counts.pending_candidates,
        )
    {
        return Err(AppError::Invalid(
            "backup contents do not match the encrypted manifest".into(),
        ));
    }

    struct DocumentKey {
        id: String,
        wrapped_key: String,
        key_nonce: String,
        content_nonce: String,
        plain_sha256: String,
    }
    let documents = {
        let mut statement = conn.prepare(
            "SELECT id,wrapped_key,key_nonce,content_nonce,sha256
             FROM documents WHERE vault_path!='' ORDER BY id",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok(DocumentKey {
                    id: row.get(0)?,
                    wrapped_key: row.get(1)?,
                    key_nonce: row.get(2)?,
                    content_nonce: row.get(3)?,
                    plain_sha256: row.get(4)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    if documents.len() != staged.manifest.vault_objects.len() {
        return Err(AppError::Invalid(
            "backup database and document vault do not contain the same objects".into(),
        ));
    }
    let manifest_objects = staged
        .manifest
        .vault_objects
        .iter()
        .map(|object| (object.document_id.as_str(), object))
        .collect::<std::collections::HashMap<_, _>>();

    let transaction = conn.transaction()?;
    for document in documents {
        Uuid::parse_str(&document.id).map_err(|_| {
            AppError::Invalid("backup contains an invalid local document identifier".into())
        })?;
        let object = manifest_objects
            .get(document.id.as_str())
            .ok_or_else(|| AppError::Invalid("backup document metadata is incomplete".into()))?;
        let archived_name = Path::new(&object.entry)
            .file_name()
            .ok_or_else(|| AppError::Invalid("backup vault entry is invalid".into()))?;
        let archived_path = staged.vault_path.join(archived_name);
        let installed_path = staged.vault_path.join(format!("{}.vault", document.id));

        let wrapped = B64.decode(&document.wrapped_key).map_err(|_| {
            AppError::Invalid("backup contains an invalid wrapped document key".into())
        })?;
        let document_key = Zeroizing::new(decrypt(
            &staged.archived_key,
            &decode_nonce(&document.key_nonce)?,
            &wrapped,
        )?);
        let document_key_array =
            Zeroizing::new(document_key.as_slice().try_into().map_err(|_| {
                AppError::Invalid("backup document key has an invalid length".into())
            })?);
        let ciphertext = fs::read(&archived_path)?;
        let plaintext = Zeroizing::new(decrypt(
            &document_key_array,
            &decode_nonce(&document.content_nonce)?,
            &ciphertext,
        )?);
        if hex::encode(Sha256::digest(&plaintext)) != document.plain_sha256 {
            return Err(AppError::Invalid(format!(
                "encrypted document {} failed content verification",
                document.id
            )));
        }
        let (rewrapped, nonce) = encrypt(&state.master_key, &document_key_array[..])?;
        fs::rename(&archived_path, &installed_path)?;
        let final_path = state.vault.join(format!("{}.vault", document.id));
        transaction.execute(
            "UPDATE documents SET vault_path=?2,wrapped_key=?3,key_nonce=?4 WHERE id=?1",
            params![
                document.id,
                final_path.to_string_lossy(),
                B64.encode(rewrapped),
                B64.encode(nonce)
            ],
        )?;
    }
    transaction.execute(
        "UPDATE integration_connections
         SET status='needs_reauthentication',last_error='Credentials are not included in encrypted backups',version=version+1
         WHERE status!='disconnected'",
        [],
    )?;
    transaction.commit()?;

    let mut foreign_keys = conn.prepare("PRAGMA foreign_key_check")?;
    if foreign_keys.exists([])? {
        return Err(AppError::Invalid(
            "backup database contains broken relationships".into(),
        ));
    }
    drop(foreign_keys);
    conn.execute_batch(&format!(
        "PRAGMA rekey = \"x'{}'\";",
        hex::encode(state.master_key)
    ))?;
    drop(conn);
    let verified = open_keyed_database(&staged.database_path, &state.master_key)?;
    let integrity: String = verified.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(AppError::Invalid(
            "restored database failed verification after device rekey".into(),
        ));
    }
    drop(verified);
    Ok(())
}

fn restore_paths(root: &Path, journal: &RestoreJournal) -> Result<(PathBuf, PathBuf, PathBuf)> {
    Uuid::parse_str(&journal.id)
        .map_err(|_| AppError::Invalid("restore journal identifier is invalid".into()))?;
    Uuid::parse_str(&journal.stage_id)
        .map_err(|_| AppError::Invalid("restore stage identifier is invalid".into()))?;
    Ok((
        root.join(format!("restore-rollback-{}.db", journal.id)),
        root.join(format!("restore-rollback-vault-{}", journal.id)),
        root.join(format!("restore-stage-{}", journal.stage_id)),
    ))
}

fn recover_interrupted_restore(root: &Path) -> Result<()> {
    let journal_path = root.join("restore-journal.json");
    if !journal_path.is_file() {
        return Ok(());
    }
    let journal: RestoreJournal = serde_json::from_slice(&fs::read(&journal_path)?)
        .map_err(|_| AppError::Invalid("restore journal is damaged".into()))?;
    let (rollback_db, rollback_vault, stage) = restore_paths(root, &journal)?;
    let current_db = root.join("student-center.db");
    let current_vault = root.join("vault");
    if rollback_db.is_file() {
        if current_db.is_file() {
            fs::remove_file(&current_db)?;
        }
        fs::rename(&rollback_db, &current_db)?;
    }
    if rollback_vault.is_dir() {
        if current_vault.is_dir() {
            fs::remove_dir_all(&current_vault)?;
        }
        fs::rename(&rollback_vault, &current_vault)?;
    }
    if stage.is_dir() {
        fs::remove_dir_all(stage)?;
    }
    fs::remove_file(journal_path)?;
    Ok(())
}

fn install_staged_profile(state: &AppState, staged: backup::StagedArchive) -> Result<Dashboard> {
    let stage_name = staged
        .directory
        .file_name()
        .and_then(|value| value.to_str())
        .and_then(|value| value.strip_prefix("restore-stage-"))
        .ok_or_else(|| AppError::Invalid("restore stage path is invalid".into()))?;
    Uuid::parse_str(stage_name)
        .map_err(|_| AppError::Invalid("restore stage identifier is invalid".into()))?;
    if staged.directory.parent() != Some(state.root.as_path()) {
        return Err(AppError::Invalid(
            "restore stage is outside app data".into(),
        ));
    }
    let journal = RestoreJournal {
        id: Uuid::new_v4().to_string(),
        stage_id: stage_name.into(),
    };
    let (rollback_db, rollback_vault, _) = restore_paths(&state.root, &journal)?;
    let journal_path = state.root.join("restore-journal.json");
    if journal_path.exists() || rollback_db.exists() || rollback_vault.exists() {
        return Err(AppError::Invalid(
            "another profile restore requires recovery before continuing".into(),
        ));
    }
    let mut journal_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&journal_path)?;
    serde_json::to_writer(&mut journal_file, &journal)
        .map_err(|error| AppError::Invalid(format!("could not write restore journal: {error}")))?;
    use std::io::Write;
    journal_file.flush()?;
    journal_file.sync_all()?;
    drop(journal_file);

    // A restored database may reuse connection identifiers from this profile.
    // Remember both sides of the swap so an old keychain item can never make a
    // restored secret connection silently usable.
    let previous_credentials = {
        let current = state.db.lock().unwrap();
        integration_credential_targets(&current)?
    };
    let placeholder = Connection::open_in_memory()?;
    let mut guard = state.db.lock().unwrap();
    let previous = std::mem::replace(&mut *guard, placeholder);
    if let Err((previous, error)) = previous.close() {
        *guard = previous;
        let _ = fs::remove_file(&journal_path);
        return Err(error.into());
    }

    let swap = (|| -> Result<Connection> {
        fs::rename(&state.db_path, &rollback_db)?;
        fs::rename(&state.vault, &rollback_vault)?;
        fs::rename(&staged.database_path, &state.db_path)?;
        fs::rename(&staged.vault_path, &state.vault)?;
        let replacement = open_database(&state.db_path, &state.master_key)?;
        let integrity: String =
            replacement.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        if integrity != "ok" {
            return Err(AppError::Invalid(
                "installed profile failed its final database check".into(),
            ));
        }
        let mut credential_targets = integration_credential_targets(&replacement)?;
        credential_targets.extend(previous_credentials.iter().cloned());
        credential_targets.sort();
        credential_targets.dedup();
        remove_integration_credentials(&credential_targets)?;
        for provider in ai_providers::ProviderId::ALL {
            ai_providers::remove_key(provider)?;
        }
        fs::remove_file(&journal_path)?;
        Ok(replacement)
    })();

    match swap {
        Ok(replacement) => {
            *guard = replacement;
            let _ = fs::remove_file(&rollback_db);
            let _ = fs::remove_dir_all(&rollback_vault);
            let _ = fs::remove_dir(&staged.directory);
            dashboard_with_notice(
                &guard,
                &state.ocr,
                Some(format!(
                    "Encrypted backup restored for {}. Integration and AI credentials must be entered again.",
                    staged.manifest.student_name
                )),
            )
        }
        Err(error) => {
            recover_interrupted_restore(&state.root)?;
            *guard = open_database(&state.db_path, &state.master_key)?;
            Err(error)
        }
    }
}

#[tauri::command]
async fn export_backup(
    state: tauri::State<'_, AppState>,
    destination: String,
    passphrase: String,
) -> Result<backup::BackupPreview> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.require_unlocked()?;
        let passphrase = Zeroizing::new(passphrase);
        let db = state.db.lock().unwrap();
        backup::export_archive(
            &db,
            &state.root,
            &state.vault,
            &state.master_key,
            Path::new(&destination),
            &passphrase,
        )
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

#[tauri::command]
async fn preview_backup(
    state: tauri::State<'_, AppState>,
    path: String,
    passphrase: String,
) -> Result<backup::BackupPreview> {
    state.require_unlocked()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.require_unlocked()?;
        let passphrase = Zeroizing::new(passphrase);
        let source = PathBuf::from(path);
        if source
            .parent()
            .and_then(|parent| parent.canonicalize().ok())
            .is_some_and(|parent| parent.starts_with(&state.root))
        {
            return Err(AppError::Invalid(
                "restore from a backup stored outside Student Center's private data directory"
                    .into(),
            ));
        }
        backup::preview_archive(&source, &passphrase)
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

#[tauri::command]
async fn restore_backup(
    state: tauri::State<'_, AppState>,
    path: String,
    passphrase: String,
    expected_fingerprint: String,
    confirmed: bool,
) -> Result<Dashboard> {
    state.require_unlocked()?;
    require_restore_confirmation(confirmed)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.require_unlocked()?;
        let passphrase = Zeroizing::new(passphrase);
        let staged = backup::stage_archive(
            &state.root,
            Path::new(&path),
            &passphrase,
            &expected_fingerprint,
        )?;
        if let Err(error) = prepare_staged_profile(&state, &staged) {
            let _ = fs::remove_dir_all(&staged.directory);
            return Err(error);
        }
        install_staged_profile(&state, staged)
    })
    .await
    .map_err(|error| AppError::Background(error.to_string()))?
}

fn require_restore_confirmation(confirmed: bool) -> Result<()> {
    if confirmed {
        Ok(())
    } else {
        Err(AppError::Invalid(
            "restoring requires explicit profile-replacement confirmation".into(),
        ))
    }
}

fn main() {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if let Some(result) = pdf_renderer::run_cli(&arguments) {
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(2);
        }
        return;
    }
    let builder = tauri::Builder::default()
        // This must remain the first plugin so Windows/Linux deep links raised
        // through a second process are forwarded to the existing app instance.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main_window(app);
        }));
    #[cfg(feature = "wdio")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());
    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            #[cfg(feature = "wdio")]
            let root = match std::env::var_os("STUDENT_CENTER_E2E_DATA_DIR") {
                Some(path) => isolated_wdio_data_root(PathBuf::from(path))?,
                None => app.path().app_data_dir()?,
            };
            #[cfg(not(feature = "wdio"))]
            let root = app.path().app_data_dir()?;
            fs::create_dir_all(&root)?;
            recover_interrupted_restore(&root)?;
            pin::recover_interrupted_update(&root)?;
            let vault = root.join("vault");
            fs::create_dir_all(&vault)?;
            let db_path = root.join("student-center.db");
            let key = device_key::load_or_create(&root, db_path.exists())?;
            let db = open_database(&db_path, &key)?;
            let resource_root = app.path().resource_dir().ok();
            let ocr = OcrRuntime::discover(resource_root.as_deref());
            let pin_enabled = pin::is_enabled(&root);
            let state = AppState {
                db: Arc::new(Mutex::new(db)),
                master_key: key,
                root,
                db_path,
                vault,
                ocr,
                locked: Arc::new(AtomicBool::new(pin_enabled)),
                pin_attempts: Arc::new(Mutex::new(PinAttempts::default())),
                pending_navigation: Arc::new(Mutex::new(None)),
                account: Arc::new(Mutex::new(auth::AccountRuntime::load())),
                sync_protection: Arc::new(
                    Mutex::new(sync_crypto::SyncProtectionRuntime::default()),
                ),
            };
            app.manage(state.clone());
            let deep_link_app = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    accept_deep_link(&deep_link_app, url.as_str());
                }
            });
            if let Some(urls) = app.deep_link().get_current()? {
                for url in urls {
                    accept_deep_link(app.handle(), url.as_str());
                }
            }
            let probe_state = state.clone();
            let probe_app = app.handle().clone();
            start_reminder_worker(app.handle().clone(), state.clone());
            start_canvas_reconciliation_worker(state);
            // The main window starts hidden so encrypted storage and security state
            // are initialized before the webview is exposed. Reveal it only after
            // setup succeeds; otherwise a normal packaged launch appears to do
            // nothing even though the process is running.
            focus_main_window(app.handle());
            // The OCR readiness probes launch two subprocesses and can take ten
            // seconds. Running them here rather than during setup keeps that cost
            // off the path between clicking the icon and seeing a usable window.
            std::thread::spawn(move || {
                let status = probe_state.ocr.probe_now();
                let _ = probe_app.emit("studentcenter:ocr-status", status);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_initialize,
            unlock_with_pin,
            enable_pin,
            change_pin,
            disable_pin,
            lock_app,
            get_dashboard,
            get_calendar_agenda,
            set_plan_block_lock,
            move_plan_block,
            undo_calendar_change,
            get_onboarding_state,
            get_timezone_suggestion,
            search_institutions,
            search_course_suggestions,
            get_institution_setup_options,
            refresh_school_calendar,
            apply_calendar_diff,
            save_onboarding_draft,
            complete_onboarding,
            get_local_workspace,
            update_student_profile,
            create_academic_term,
            update_academic_term,
            delete_academic_term,
            create_course,
            update_course,
            delete_course,
            create_local_task,
            update_local_task,
            delete_local_task,
            create_commitment,
            update_commitment,
            delete_commitment,
            create_instructor,
            update_instructor,
            delete_instructor,
            create_class_meeting,
            update_class_meeting,
            delete_class_meeting,
            create_academic_event,
            update_academic_event,
            delete_academic_event,
            update_appearance,
            update_accent,
            get_academic_cleanup_preview,
            apply_academic_cleanup,
            list_legacy_quarantine,
            restore_legacy_quarantine,
            purge_legacy_quarantine,
            update_planning_preferences,
            delete_local_profile,
            take_pending_navigation,
            get_update_status,
            check_for_updates,
            install_update,
            get_account_status,
            get_sync_protection_status,
            begin_sync_protection,
            confirm_sync_protection,
            recover_sync_protection,
            request_existing_device_approval,
            check_existing_device_approval,
            cancel_sync_protection,
            get_encrypted_sync_status,
            connect_encrypted_sync,
            list_authorized_sync_devices,
            list_pending_sync_devices,
            approve_sync_device,
            revoke_sync_device,
            push_encrypted_mutations,
            pull_encrypted_mutations,
            upload_synced_document,
            download_synced_document,
            start_google_sign_in,
            cancel_google_sign_in,
            request_email_code,
            verify_email_code,
            refresh_account_session,
            sign_out_account,
            add_task,
            toggle_task,
            replan,
            update_notification_settings,
            start_plan_block,
            snooze_reminder,
            dismiss_reminder,
            list_ai_providers,
            save_ai_provider_key,
            test_ai_provider,
            remove_ai_provider,
            set_ai_provider_order,
            get_ai_usage,
            request_managed_ai,
            request_ai_capability,
            get_study_workspace,
            set_study_material_courses,
            generate_grounded_study_artifact,
            update_study_artifact,
            review_study_artifact,
            save_grade_category,
            save_grade_item,
            calculate_grade_what_if,
            save_grading_scale,
            get_scholarship_workspace,
            refresh_scholarship_source,
            set_scholarship_source_refresh,
            resolve_scholarship_diff,
            save_scholarship_profile,
            plan_scholarship_deadline,
            preview_scholarship_writing,
            request_scholarship_writing_feedback,
            resolve_scholarship_writing_suggestion,
            import_scholarship_requirements,
            apply_scholarship_requirements_review,
            save_scholarship_opportunity,
            save_scholarship_application,
            save_scholarship_draft,
            autosave_scholarship_draft,
            save_scholarship_story,
            delete_scholarship_story,
            import_document,
            import_document_bytes,
            launch_schedule_capture,
            settle_schedule_source,
            read_schedule_with_ai,
            analyze_schedule_source,
            list_documents,
            get_document_evidence,
            get_schedule_source_preview,
            update_import_candidate,
            approve_candidates,
            apply_schedule_import,
            reject_candidates,
            resolve_source_conflict,
            connect_canvas,
            sync_canvas,
            disconnect_canvas,
            connect_canvas_calendar,
            refresh_canvas_calendar,
            set_canvas_calendar_refresh,
            disconnect_canvas_calendar,
            export_backup,
            preview_backup,
            restore_backup
        ])
        .run(tauri::generate_context!())
        .expect("error while running Student Center");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// A syntactically valid signature for tests that exercise merge behaviour directly. Signature
    /// verification happens at the transport boundary, before apply_canonical_mutation is reached,
    /// and is covered by the sync_transport tests.
    const TEST_SIGNATURE: &str = "G0000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

    #[test]
    fn scholarship_matching_is_explicit_explainable_and_does_not_infer_traits() {
        let opportunity=serde_json::json!({"id":"s1","studyLevels":["undergraduate"],"fieldsOfStudy":["computer science"],"locations":[],"citizenship":["united states"],"residency":["arizona"],"minimumGpa":3.5});
        let partial=serde_json::json!({"studyLevel":"Undergraduate","fieldsOfStudy":["Computer Science"],"locations":[],"citizenship":[],"residency":["Arizona"],"gpa":3.7});
        let result=scholarship_match(&opportunity,&partial);
        assert_eq!(result["matched"].as_array().unwrap().len(),4);
        assert!(result["unknown"].as_array().unwrap().iter().any(|value|value.as_str()==Some("Your citizenship is not set")));
        assert!(result["unknown"].as_array().unwrap().iter().any(|value|value.as_str()==Some("Provider did not publish location criteria")));
        assert!(result["ineligible"].as_array().unwrap().is_empty());

        let mismatch=serde_json::json!({"studyLevel":"graduate","fieldsOfStudy":["history"],"locations":[],"citizenship":["canada"],"residency":["california"],"gpa":3.0});
        let result=scholarship_match(&opportunity,&mismatch);
        assert_eq!(result["ineligible"].as_array().unwrap().len(),5);
    }

    #[test]
    fn scholarship_deadline_planning_is_persisted_and_idempotent() {
        let directory=tempfile::tempdir().unwrap();let conn=open_database(&directory.path().join("scholarship-plan.db"),&random_key()).unwrap();
        let opportunity=serde_json::json!({"id":"s1","title":"Future Builders","deadline":"2026-10-15","taskIds":[],"state":"saved"});
        conn.execute("INSERT INTO scholarship_opportunities(id,payload,updated_at) VALUES('s1',?1,'2026-08-31T00:00:00Z')",params![opportunity.to_string()]).unwrap();
        plan_scholarship_deadline_in(&conn,"s1").unwrap();plan_scholarship_deadline_in(&conn,"s1").unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM tasks WHERE title='Submit Future Builders'",[],|row|row.get::<_,i64>(0)).unwrap(),1);
        let payload=conn.query_row("SELECT payload FROM scholarship_opportunities WHERE id='s1'",[],|row|row.get::<_,String>(0)).unwrap();let saved:serde_json::Value=serde_json::from_str(&payload).unwrap();
        assert_eq!(saved["state"],"preparing");assert_eq!(saved["taskIds"].as_array().unwrap().len(),1);
    }

    #[test]
    fn scholarship_autosave_preserves_explicit_version_history() {
        let directory=tempfile::tempdir().unwrap();let conn=open_database(&directory.path().join("scholarship-drafts.db"),&random_key()).unwrap();
        conn.execute("INSERT INTO scholarship_opportunities(id,payload,updated_at) VALUES('s1','{}','2026-08-31T00:00:00Z')",[]).unwrap();
        let draft=serde_json::json!({"id":"draft-1","opportunityId":"s1","promptId":"general","title":"Essay","outline":"","content":"First text","updatedAt":"2026-08-31T00:00:00Z","versions":[]});
        assert!(persist_scholarship_draft(&conn,draft.clone(),false).is_err());
        persist_scholarship_draft(&conn,draft,true).unwrap();
        let mut autosave:serde_json::Value=serde_json::from_str(&conn.query_row("SELECT payload FROM scholarship_drafts WHERE id='draft-1'",[],|row|row.get::<_,String>(0)).unwrap()).unwrap();
        autosave["content"]=serde_json::Value::String("Autosaved text".into());persist_scholarship_draft(&conn,autosave,false).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM scholarship_draft_versions WHERE draft_id='draft-1'",[],|row|row.get::<_,i64>(0)).unwrap(),1);
        let saved:serde_json::Value=serde_json::from_str(&conn.query_row("SELECT payload FROM scholarship_drafts WHERE id='draft-1'",[],|row|row.get::<_,String>(0)).unwrap()).unwrap();
        assert_eq!(saved["content"],"Autosaved text");assert_eq!(saved["versions"].as_array().unwrap().len(),1);
        persist_scholarship_draft(&conn,saved,true).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM scholarship_draft_versions WHERE draft_id='draft-1'",[],|row|row.get::<_,i64>(0)).unwrap(),2);
    }

    #[test]
    fn scholarship_requirement_extraction_is_bounded_and_reviewable() {
        let segments=vec![imports::Segment{text:"Official transcript\nTwo letters of recommendation\nEssay prompt: Describe how service shaped your goals. 500 words".into(),locator:"page 1".into(),confidence:1.0,tokens:vec![]}];
        let(requirements,prompts)=scholarship_requirement_suggestions(&segments);
        assert_eq!(requirements,vec!["Official transcript","Letter of recommendation"]);
        assert_eq!(prompts.len(),1);
        assert_eq!(prompts[0]["wordLimit"],500);
        assert!(prompts[0]["prompt"].as_str().unwrap().contains("service shaped"));
    }

    #[test]
    fn rotating_class_weeks_follow_the_term_anchor(){let start=NaiveDate::from_ymd_opt(2026,8,24).unwrap();assert!(rotation_week_matches(start,start,2,0));assert!(!rotation_week_matches(start,start+Duration::weeks(1),2,0));assert!(rotation_week_matches(start,start+Duration::weeks(1),2,1));assert!(rotation_week_matches(start,start+Duration::weeks(4),4,0));}

    #[test]
    fn academic_cleanup_preserves_links_and_only_collapses_proven_weekly_series(){
        let directory=tempfile::tempdir().unwrap();let conn=open_database(&directory.path().join("cleanup.db"),&random_key()).unwrap();
        conn.execute("INSERT INTO academic_terms(id,name,starts_on,ends_on,active,created_at) VALUES('fall','Fall','2026-08-01','2026-12-20',1,'2026-08-01T00:00:00Z')",[]).unwrap();
        conn.execute("INSERT INTO courses(id,title,code,created_at) VALUES('keep','Calculus I','MAT 265','2026-08-01T00:00:00Z'),('duplicate','calculus i','MAT-265','2026-08-02T00:00:00Z')",[]).unwrap();
        conn.execute("INSERT INTO tasks(id,title,minutes,course_id,created_at) VALUES('task','Homework',30,'duplicate','2026-08-02T00:00:00Z')",[]).unwrap();assert_eq!(merge_duplicate_courses_in(&conn).unwrap(),1);assert_eq!(conn.query_row("SELECT course_id FROM tasks WHERE id='task'",[],|row|row.get::<_,String>(0)).unwrap(),"keep");
        for (index,date) in ["2026-08-24","2026-08-26","2026-08-28","2026-08-31","2026-09-02","2026-09-04"].iter().enumerate(){conn.execute("INSERT INTO commitments(id,title,starts_at,ends_at,kind,location) VALUES(?1,'BIO 181',?2,?3,'class','LSA 101')",params![format!("c{index}"),format!("{date}T16:00:00Z"),format!("{date}T16:50:00Z")]).unwrap();}
        let preview=academic_cleanup_preview_in(&conn).unwrap();assert_eq!(preview.repeated_commitment_series.len(),1);assert_eq!(collapse_repeated_commitments_in(&conn).unwrap(),1);assert_eq!(conn.query_row("SELECT COUNT(*) FROM commitments",[],|row|row.get::<_,i64>(0)).unwrap(),0);assert_eq!(conn.query_row("SELECT COUNT(*) FROM class_meeting_series",[],|row|row.get::<_,i64>(0)).unwrap(),1);
    }

    #[test]
    fn webdriver_profile_root_is_confined_to_a_dedicated_temporary_directory() {
        let temporary = tempfile::tempdir().unwrap();
        let profile = temporary.path().join("isolated-profile");
        assert_eq!(
            isolated_wdio_data_root(profile.clone()).unwrap(),
            profile.canonicalize().unwrap(),
        );
        assert!(isolated_wdio_data_root(std::env::temp_dir()).is_err());
        assert!(isolated_wdio_data_root(std::env::current_dir().unwrap()).is_err());
    }

    #[test]
    fn ai_capability_routing_declares_sensitive_feature_requirements() {
        let vision = ai_capability_requirements(managed_ai::AiCapability::ScheduleVision);
        assert!(vision.text && vision.images && vision.structured_output);
        assert!(!vision.streaming);
        let grounded = ai_capability_requirements(managed_ai::AiCapability::SourceQa);
        assert!(!grounded.images);
        assert!(grounded.minimum_context_tokens >= 64_000);
        for provider in ai_providers::ProviderId::ALL {
            assert!(provider_supports(provider, managed_ai::AiCapability::ScheduleVision));
            assert!(provider_supports(provider, managed_ai::AiCapability::PracticeQuestions));
        }
        let text_only = AiProviderFeatures {
            text: true,
            images: false,
            structured_output: true,
            streaming: true,
            context_tokens: 128_000,
        };
        assert!(!provider_meets_requirements(text_only, vision));
        assert!(provider_meets_requirements(
            text_only,
            ai_capability_requirements(managed_ai::AiCapability::BrainDump),
        ));
    }

    #[test]
    fn ai_provider_order_models_and_usage_are_local_and_deterministic() {
        let directory = tempfile::tempdir().unwrap();
        let conn = open_database(&directory.path().join("ai-routing.db"), &random_key()).unwrap();
        assert_eq!(ai_provider_order(&conn), ai_providers::ProviderId::ALL);

        conn.execute(
            "INSERT INTO settings(key,value) VALUES('ai_provider_order',?1)",
            params![r#"["gemini","anthropic","openai"]"#],
        ).unwrap();
        assert_eq!(
            ai_provider_order(&conn),
            vec![
                ai_providers::ProviderId::Gemini,
                ai_providers::ProviderId::Anthropic,
                ai_providers::ProviderId::Openai,
            ],
        );
        assert_eq!(
            ai_model(&conn, ai_providers::ProviderId::Openai),
            ai_providers::ProviderId::Openai.default_model(),
        );
        conn.execute(
            "INSERT INTO settings(key,value) VALUES('ai_model_openai','student-selected-model')",
            [],
        ).unwrap();
        assert_eq!(ai_model(&conn, ai_providers::ProviderId::Openai), "student-selected-model");

        record_ai_invocation(
            &conn,
            "openai",
            managed_ai::AiCapability::BrainDump,
            Some("student-selected-model"),
            10,
            100,
            40,
            "review_created",
            None,
        ).unwrap();
        record_ai_invocation(
            &conn,
            "openai",
            managed_ai::AiCapability::BrainDump,
            Some("student-selected-model"),
            30,
            0,
            0,
            "failed",
            Some("quota"),
        ).unwrap();
        let usage = ai_usage_summaries(&conn).unwrap();
        assert_eq!(usage.len(), 1);
        assert_eq!(usage[0].provider, "openai");
        assert_eq!(usage[0].model, "student-selected-model");
        assert_eq!(usage[0].requests, 2);
        assert_eq!(usage[0].failures, 1);
        assert_eq!(usage[0].input_tokens, 100);
        assert_eq!(usage[0].output_tokens, 40);
        assert_eq!(usage[0].average_latency_ms, 20.0);
    }

    #[test]
    fn canvas_calendar_startup_refresh_honors_toggle_and_twenty_four_hour_interval() {
        let directory = tempfile::tempdir().unwrap();
        let key = random_key();
        let conn = open_database(&directory.path().join("canvas-refresh.db"), &key).unwrap();
        let now = Utc::now();
        for (id, enabled, attempted) in [
            ("due", 1, now - Duration::hours(25)),
            ("too-recent", 1, now - Duration::hours(23)),
            ("disabled", 0, now - Duration::hours(48)),
        ] {
            conn.execute(
                "INSERT INTO integration_connections(id,provider,base_url,account_name,status,created_at,refresh_on_startup,last_attempted_at) VALUES(?1,'canvas_calendar',?2,'Canvas calendar','connected',?3,?4,?5)",
                params![id, format!("https://{id}.canvas.example.edu"), now.to_rfc3339(), enabled, attempted.to_rfc3339()],
            ).unwrap();
        }
        assert_eq!(due_canvas_calendar_reconciliations(&conn, now).unwrap(), vec!["due"]);
    }

    #[test]
    fn vault_ciphertext_never_contains_plaintext() {
        let key = random_key();
        let plain = b"private syllabus deadline";
        let (cipher, _) = encrypt(&key, plain).unwrap();
        assert!(!String::from_utf8_lossy(&cipher).contains("syllabus"));
    }

    #[test]
    fn locked_state_denies_domain_access_and_failures_are_throttled() {
        let root = tempfile::tempdir().unwrap();
        let key = random_key();
        let db_path = root.path().join("student-center.db");
        let state = AppState {
            db: Arc::new(Mutex::new(open_database(&db_path, &key).unwrap())),
            master_key: key,
            root: root.path().to_path_buf(),
            db_path,
            vault: root.path().join("vault"),
            ocr: OcrRuntime::discover(None),
            locked: Arc::new(AtomicBool::new(true)),
            pin_attempts: Arc::new(Mutex::new(PinAttempts::default())),
            pending_navigation: Arc::new(Mutex::new(None)),
            account: Arc::new(Mutex::new(auth::AccountRuntime::test_unconfigured())),
            sync_protection: Arc::new(Mutex::new(sync_crypto::SyncProtectionRuntime::default())),
        };
        assert!(state.require_unlocked().is_err());
        state.locked.store(false, Ordering::Release);
        assert!(state.require_unlocked().is_ok());

        let mut attempts = PinAttempts::default();
        assert_eq!(attempts.record_failure(), 1);
        assert!(attempts.retry_after_seconds() >= 1);
        attempts.reset();
        assert_eq!(attempts.retry_after_seconds(), 0);
    }

    #[test]
    fn every_data_bearing_command_has_a_locked_state_guard() {
        let source = include_str!("main.rs");
        for command in [
            "get_dashboard",
            "get_calendar_agenda",
            "set_plan_block_lock",
            "move_plan_block",
            "undo_calendar_change",
            "get_onboarding_state",
            "save_onboarding_draft",
            "complete_onboarding",
            "update_appearance",
            "update_accent",
            "get_local_workspace",
            "update_student_profile",
            "create_academic_term",
            "update_academic_term",
            "delete_academic_term",
            "create_course",
            "update_course",
            "delete_course",
            "create_local_task",
            "update_local_task",
            "delete_local_task",
            "create_commitment",
            "update_commitment",
            "delete_commitment",
            "update_planning_preferences",
            "delete_local_profile",
            "take_pending_navigation",
            "get_update_status",
            "check_for_updates",
            "install_update",
            "get_account_status",
            "get_sync_protection_status",
            "begin_sync_protection",
            "confirm_sync_protection",
            "recover_sync_protection",
            "request_existing_device_approval",
            "check_existing_device_approval",
            "cancel_sync_protection",
            "get_encrypted_sync_status",
            "connect_encrypted_sync",
            "list_authorized_sync_devices",
            "list_pending_sync_devices",
            "approve_sync_device",
            "revoke_sync_device",
            "push_encrypted_mutations",
            "pull_encrypted_mutations",
            "upload_synced_document",
            "download_synced_document",
            "start_google_sign_in",
            "cancel_google_sign_in",
            "request_email_code",
            "verify_email_code",
            "refresh_account_session",
            "sign_out_account",
            "add_task",
            "toggle_task",
            "replan",
            "update_notification_settings",
            "start_plan_block",
            "snooze_reminder",
            "dismiss_reminder",
            "list_ai_providers",
            "save_ai_provider_key",
            "test_ai_provider",
            "remove_ai_provider",
            "set_ai_provider_order",
            "get_ai_usage",
            "request_managed_ai",
            "request_ai_capability",
            "get_study_workspace",
            "set_study_material_courses",
            "generate_grounded_study_artifact",
            "update_study_artifact",
            "review_study_artifact",
            "save_grade_category",
            "save_grade_item",
            "calculate_grade_what_if",
            "save_grading_scale",
            "get_scholarship_workspace",
            "refresh_scholarship_source",
            "set_scholarship_source_refresh",
            "resolve_scholarship_diff",
            "save_scholarship_profile",
            "plan_scholarship_deadline",
            "preview_scholarship_writing",
            "request_scholarship_writing_feedback",
            "resolve_scholarship_writing_suggestion",
            "import_scholarship_requirements",
            "apply_scholarship_requirements_review",
            "save_scholarship_opportunity",
            "save_scholarship_application",
            "save_scholarship_draft",
            "autosave_scholarship_draft",
            "save_scholarship_story",
            "delete_scholarship_story",
            "launch_schedule_capture",
            "settle_schedule_source",
            "connect_canvas",
            "sync_canvas",
            "disconnect_canvas",
            "connect_canvas_calendar",
            "refresh_canvas_calendar",
            "set_canvas_calendar_refresh",
            "disconnect_canvas_calendar",
            "import_document",
            "list_documents",
            "get_document_evidence",
            "get_schedule_source_preview",
            "update_import_candidate",
            "approve_candidates",
            "reject_candidates",
            "resolve_source_conflict",
            "export_backup",
            "preview_backup",
            "restore_backup",
        ] {
            let marker = format!("fn {command}(");
            let start = source
                .find(&marker)
                .unwrap_or_else(|| panic!("missing {command}"));
            let tail = &source[start..];
            let end = tail[marker.len()..]
                .find("#[tauri::command]")
                .map(|offset| marker.len() + offset)
                .unwrap_or(tail.len());
            assert!(
                tail[..end].contains("require_unlocked()?"),
                "{command} must reject invocations while locked"
            );
        }
    }

    #[test]
    fn quiet_hours_support_daytime_and_overnight_ranges() {
        assert!(in_quiet_hours(13 * 60, 12 * 60, 14 * 60));
        assert!(!in_quiet_hours(15 * 60, 12 * 60, 14 * 60));
        assert!(in_quiet_hours(23 * 60, 22 * 60, 7 * 60));
        assert!(in_quiet_hours(6 * 60, 22 * 60, 7 * 60));
        assert!(!in_quiet_hours(12 * 60, 22 * 60, 7 * 60));
        assert!(!in_quiet_hours(12 * 60, 12 * 60, 12 * 60));
    }

    #[test]
    fn deep_links_are_strictly_allowlisted_and_safely_parsed() {
        assert_eq!(
            parse_navigation_target("studentcenter://my-day"),
            Some(NavigationTarget::MyDay)
        );
        assert_eq!(
            parse_navigation_target("studentcenter://plan/block/read-6"),
            Some(NavigationTarget::PlanBlock {
                block_id: "read-6".into()
            })
        );
        for rejected in [
            "https://studentcenter.app/plan/block/read-6",
            "studentcenter://plan/block/read-6?redirect=https://example.com",
            "studentcenter://plan/block/../../settings",
            "studentcenter://plan/block/read%2F6",
            "studentcenter://plan/other/read-6",
            "studentcenter://auth/callback?code=secret",
        ] {
            assert_eq!(parse_navigation_target(rejected), None, "{rejected}");
        }
    }

    #[test]
    fn updater_configuration_requires_https_and_an_embedded_trust_anchor() {
        let public_key = "RWQabcdefghijklmnopqrstuvwxyz1234567890ABCDEFG";
        assert!(validate_updater_configuration(
            "https://updates.studentcenter.app/{{target}}/{{arch}}/{{current_version}}",
            public_key
        )
        .is_some());
        for (endpoint, key) in [
            ("http://updates.studentcenter.app/latest", public_key),
            ("https://user@updates.studentcenter.app/latest", public_key),
            (
                "https://updates.studentcenter.app/latest#unsigned",
                public_key,
            ),
            ("https://updates.studentcenter.app/latest", "short-key"),
        ] {
            assert!(validate_updater_configuration(endpoint, key).is_none());
        }
    }

    #[test]
    fn desktop_lifecycle_starts_hidden_then_shows_after_secure_initialization() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let config: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(manifest.join("tauri.conf.json")).unwrap())
                .unwrap();
        assert_eq!(config["app"]["windows"][0]["visible"], false);
        let updater = &config["plugins"]["updater"];
        assert_eq!(updater["endpoints"], serde_json::json!([]));
        assert_eq!(updater["pubkey"], "");
        assert_eq!(
            config["plugins"]["deep-link"]["desktop"]["schemes"][0],
            "studentcenter"
        );
        let release: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(manifest.join("tauri.release.conf.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(release["bundle"]["createUpdaterArtifacts"], true);
        let capabilities = fs::read_to_string(manifest.join("capabilities/default.json")).unwrap();
        assert!(
            !capabilities.contains("updater:"),
            "the webview must not receive updater download or install permissions"
        );
        let source = include_str!("main.rs");
        let single = source
            .find(".plugin(tauri_plugin_single_instance::init")
            .unwrap();
        let deep_link = source.find(".plugin(tauri_plugin_deep_link::init").unwrap();
        let opener = source.find(".plugin(tauri_plugin_opener::init").unwrap();
        assert!(single < deep_link && deep_link < opener);
        let setup = source.find(".setup(|app|").unwrap();
        let startup_show = source[setup..]
            .find("focus_main_window(app.handle());")
            .map(|offset| setup + offset)
            .unwrap();
        let invoke_handler = source
            .find(".invoke_handler(tauri::generate_handler!")
            .unwrap();
        assert!(setup < startup_show && startup_show < invoke_handler);
    }

    #[test]
    fn reminder_delivery_is_idempotent_and_snooze_is_respected() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("reminders.db");
        let key = random_key();
        let conn = open_database(&path, &key).unwrap();
        conn.execute_batch(
            "DELETE FROM reminder_deliveries;
             DELETE FROM plan_blocks;
             DELETE FROM tasks;
             UPDATE settings SET value='true' WHERE key='notifications_enabled';
             UPDATE settings SET value='15' WHERE key='notification_lead_minutes';
             UPDATE settings SET value='00:00' WHERE key='notification_quiet_start';
             UPDATE settings SET value='00:00' WHERE key='notification_quiet_end';
             UPDATE settings SET value='Etc/UTC' WHERE key='timezone';",
        )
        .unwrap();
        let now = Utc.with_ymd_and_hms(2030, 9, 12, 10, 0, 0).unwrap();
        let starts_at = (now + Duration::minutes(5)).to_rfc3339();
        let ends_at = (now + Duration::minutes(35)).to_rfc3339();
        conn.execute(
            "INSERT INTO tasks(id,title,minutes,created_at) VALUES('focus','Focus task',30,?1)",
            params![now.to_rfc3339()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO plan_blocks(id,task_id,starts_at,ends_at,title,kind,reason_codes)
             VALUES('focus','focus',?1,?2,'Focus task','study','[]')",
            params![starts_at, ends_at],
        )
        .unwrap();

        assert_eq!(take_due_reminders(&conn, now).unwrap().1.len(), 1);
        assert!(take_due_reminders(&conn, now).unwrap().1.is_empty());

        conn.execute(
            "UPDATE reminder_deliveries SET snoozed_until=?2 WHERE block_id='focus'",
            params!["focus", (now + Duration::minutes(10)).to_rfc3339()],
        )
        .unwrap();
        assert!(take_due_reminders(&conn, now + Duration::minutes(9))
            .unwrap()
            .1
            .is_empty());
        assert_eq!(
            take_due_reminders(&conn, now + Duration::minutes(10))
                .unwrap()
                .1
                .len(),
            1
        );
        conn.execute(
            "UPDATE reminder_deliveries SET dismissed_at=?2 WHERE block_id='focus'",
            params!["focus", (now + Duration::minutes(10)).to_rfc3339()],
        )
        .unwrap();
        assert!(take_due_reminders(&conn, now + Duration::minutes(11))
            .unwrap()
            .1
            .is_empty());
        conn.execute_batch(
            "UPDATE settings SET value='09:00' WHERE key='notification_quiet_start';
             UPDATE settings SET value='11:00' WHERE key='notification_quiet_end';",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks(id,title,minutes,created_at) VALUES('quiet','Private quiet task',30,?1)",
            params![now.to_rfc3339()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO plan_blocks(id,task_id,starts_at,ends_at,title,kind,reason_codes)
             VALUES('quiet','quiet',?1,?2,'Private quiet task','study','[]')",
            params![
                (now + Duration::minutes(12)).to_rfc3339(),
                (now + Duration::minutes(42)).to_rfc3339()
            ],
        )
        .unwrap();
        assert!(take_due_reminders(&conn, now + Duration::minutes(2))
            .unwrap()
            .1
            .is_empty());
        drop(conn);
        let reopened = open_database(&path, &key).unwrap();
        assert!(take_due_reminders(&reopened, now + Duration::minutes(11))
            .unwrap()
            .1
            .is_empty());
        assert_eq!(
            reminder_body(true, true, "Private task"),
            "A planned focus block starts soon. Open Student Center to review it."
        );
        assert!(reminder_body(true, false, "Private task").contains("Private task"));
    }

    #[test]
    fn prepared_ocr_runtime_renders_and_recognizes_a_critical_date() {
        let Some(runtime) = std::env::var_os("STUDENT_CENTER_OCR_RUNTIME").map(PathBuf::from)
        else {
            return;
        };
        let library = runtime.join("lib").join(if cfg!(windows) {
            "pdfium.dll"
        } else {
            "libpdfium.dylib"
        });
        let tesseract = runtime.join("bin").join(if cfg!(windows) {
            "tesseract.exe"
        } else {
            "tesseract"
        });
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("test-fixtures/ocr/render-smoke.pdf");
        let rendered = tempfile::tempdir().unwrap();
        let unicode_fixture = rendered.path().join("syllabus-大学-été.pdf");
        std::fs::copy(fixture, &unicode_fixture).unwrap();
        assert_eq!(
            pdf_renderer::render_for_test(&library, &unicode_fixture, rendered.path()).unwrap(),
            1
        );
        let output = Command::new(tesseract)
            .arg(rendered.path().join("page-0000.png"))
            .arg("stdout")
            .arg("--tessdata-dir")
            .arg(runtime.join("tessdata"))
            .args(["-l", "eng", "--psm", "6", "tsv"])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let words = String::from_utf8_lossy(&output.stdout);
        for expected in ["Assignment", "due", "Sep", "12", "2030"] {
            assert!(
                words.contains(expected),
                "OCR output omitted {expected}: {words}"
            );
        }
    }

    #[test]
    fn vault_round_trip_detects_wrong_keys() {
        let key = random_key();
        let wrong_key = random_key();
        let plain = b"private syllabus deadline";
        let (cipher, nonce) = encrypt(&key, plain).unwrap();
        assert_eq!(decrypt(&key, &nonce, &cipher).unwrap(), plain);
        assert!(decrypt(&wrong_key, &nonce, &cipher).is_err());
    }

    #[test]
    fn duplicate_hash_lookup_returns_the_original_document() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
      // Mirrors the real columns the lookup reads: a document only counts as a
      // duplicate while its bytes are still stored.
      "CREATE TABLE documents(file_name TEXT NOT NULL,sha256 TEXT NOT NULL,imported_at TEXT NOT NULL,
                              vault_path TEXT NOT NULL DEFAULT '',content_shredded INTEGER NOT NULL DEFAULT 0);
       INSERT INTO documents VALUES('syllabus.pdf','same-hash','2026-08-12T00:00:00Z','vault/a.vault',0);",
    )
    .unwrap();
        assert_eq!(
            duplicate_document_name(&conn, "same-hash")
                .unwrap()
                .as_deref(),
            Some("syllabus.pdf")
        );
        assert!(duplicate_document_name(&conn, "new-hash")
            .unwrap()
            .is_none());
    }

    #[test]
    fn schema_migration_adds_import_provenance_fields() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE import_candidates(id TEXT); CREATE TABLE documents(id TEXT);",
        )
        .unwrap();
        ensure_column(
            &conn,
            "import_candidates",
            "source_uid",
            "TEXT NOT NULL DEFAULT ''",
        )
        .unwrap();
        ensure_column(
            &conn,
            "documents",
            "extraction_status",
            "TEXT NOT NULL DEFAULT 'complete'",
        )
        .unwrap();
        let candidate_columns = table_columns(&conn, "import_candidates").unwrap();
        let document_columns = table_columns(&conn, "documents").unwrap();
        assert!(candidate_columns.contains("source_uid"));
        assert!(document_columns.contains("extraction_status"));
    }

    fn complete_test_onboarding(conn: &mut Connection) {
        profile::complete_onboarding(
            conn,
            &profile::OnboardingDraft {
                name: "Planner Test".into(),
                timezone: "Etc/UTC".into(),
                term_name: "Fall 2026".into(),
                term_starts_on: "2026-08-01".into(),
                term_ends_on: "2026-12-20".into(),
                term_no_class_dates: Vec::new(),
                course_title: "Planning 101".into(),
                course_code: "PLN 101".into(),
                institution: profile::InstitutionSelection::default(),
                courses: Vec::new(),
                appearance: profile::AppearancePreference::System,
                sleep_start: "23:00".into(),
                sleep_end: "07:00".into(),
                max_session_minutes: 60,
                break_minutes: 10,
                transition_minutes: 10,
                default_commute_minutes: 0,
                availability: (0..7)
                    .map(|weekday| profile::AvailabilityInput {
                        weekday,
                        starts_at_local: "08:00".into(),
                        ends_at_local: "21:00".into(),
                    })
                    .collect(),
                commitments: vec![profile::CommitmentInput {
                    title: "Fixed class".into(),
                    starts_at: "2026-08-17T16:00:00Z".into(),
                    ends_at: "2026-08-17T17:00:00Z".into(),
                    kind: "class".into(),
                    location: "campus".into(),
                    travel_before_minutes: 15,
                    travel_after_minutes: 15,
                }],
            },
        )
        .unwrap();
    }

    // The whole reason the class_meeting kind exists: a weekly calendar rule
    // has to land as one editable pattern, attached to a course and a term,
    // rather than as dozens of one-off commitments.
    #[test]
    fn approving_a_weekly_class_creates_one_meeting_series() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("class-import.db");
        let key = random_key();
        let conn = open_database(&path, &key).unwrap();
        conn.execute(
            "INSERT INTO academic_terms(id,name,starts_on,ends_on,active,created_at)
             VALUES('term-fall','Fall 2026','2026-08-20','2026-12-12',1,'2026-08-01T00:00:00Z'),
                   ('term-selected','Selected range','2026-08-15','2026-12-20',0,'2026-08-01T00:00:00Z')",
            [],
        )
        .unwrap();

        let candidate = PendingCandidate {
            id: "cand-1".into(),
            kind: "class_meeting".into(),
            title: "Statistics 201".into(),
            course: "Statistics 201".into(),
            starts_at: Some("2026-08-24T16:00:00Z".into()),
            source_uid: "ics:sta201:weekly".into(),
            weekdays: vec![1, 3, 5],
            starts_at_local: "09:00".into(),
            ends_at_local: "09:50".into(),
            timezone: "America/Phoenix".into(),
            term_id: "term-selected".into(),
            modality: "hybrid".into(),
            ..Default::default()
        };
        conn.execute(
            "INSERT INTO documents(id,file_name,mime,vault_path,wrapped_key,key_nonce,content_nonce,sha256,imported_at)
             VALUES('doc-1','sched.ics','text/calendar','v','k','n','c','s','2026-08-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO import_candidates(id,document_id,kind,title,course,evidence,source_locator,source_uid,confidence)
             VALUES('cand-1','doc-1','class_meeting','Statistics 201','Statistics 201','e','l','ics:sta201:weekly',1.0)",
            [],
        )
        .unwrap();

        let entity_id = apply_candidate(&conn, &candidate, None).unwrap();
        let (course_id, term_id, weekdays, starts, ends, timezone, modality): (
            String,
            String,
            String,
            String,
            String,
            String,
            String,
        ) = conn
            .query_row(
                "SELECT course_id,term_id,weekdays,starts_at_local,ends_at_local,timezone,modality
                 FROM class_meeting_series WHERE id=?1",
                params![entity_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(weekdays, "[1,3,5]");
        assert_eq!(starts, "09:00");
        assert_eq!(ends, "09:50");
        assert_eq!(timezone, "America/Phoenix");
        assert_eq!(modality, "hybrid");
        // The student's reviewed target term wins over automatic date matching.
        assert_eq!(term_id, "term-selected");

        let course_title: String = conn
            .query_row(
                "SELECT title FROM courses WHERE id=?1",
                params![course_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(course_title, "Statistics 201");

        // One series, not one row per occurrence.
        let series: i64 = conn
            .query_row("SELECT COUNT(*) FROM class_meeting_series", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(series, 1);
        assert_eq!(conn.query_row("SELECT term_id FROM class_meeting_series",[],|row|row.get::<_,String>(0)).unwrap(),"term-selected");

        // Importing the same schedule again produces a fresh candidate carrying
        // the same source_uid. It must update the class rather than add a second
        // one, which is what source_uid on class_meeting_series is for.
        conn.execute(
            "INSERT INTO import_candidates(id,document_id,kind,title,course,evidence,source_locator,source_uid,confidence)
             VALUES('cand-2','doc-1','class_meeting','Statistics 201','Statistics 201','e','l','ics:sta201:weekly',1.0)",
            [],
        )
        .unwrap();
        let reimported = PendingCandidate {
            id: "cand-2".into(),
            ..candidate
        };
        let again = apply_candidate(&conn, &reimported, None).unwrap();
        assert_eq!(again, entity_id, "re-importing should update the same class");
        let courses: i64 = conn
            .query_row("SELECT COUNT(*) FROM courses", [], |row| row.get(0))
            .unwrap();
        assert_eq!(courses, 1, "importing twice should not duplicate the course");
    }

    // The evidence query used to select fifteen columns and then read indices
    // fifteen through eighteen for the weekly pattern fields, so every call
    // failed the moment a document had any candidate at all. Reading a
    // class_meeting back is the case that regressed.
    #[test]
    fn document_evidence_returns_the_weekly_pattern_columns() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("evidence.db");
        let key = random_key();
        let conn = open_database(&path, &key).unwrap();
        conn.execute(
            "INSERT INTO documents(id,file_name,mime,vault_path,wrapped_key,key_nonce,content_nonce,sha256,imported_at)
             VALUES('doc-1','schedule.png','image/png','v','k','n','c','s','2026-08-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO import_candidates(id,document_id,kind,title,course,evidence,source_locator,source_uid,confidence,
                                           weekdays,starts_at_local,ends_at_local,timezone)
             VALUES('cand-1','doc-1','class_meeting','Statistics 201','Statistics 201','STA 201 MWF 9:00',
                    'screenshot','shot:sta201:weekly',0.9,'[1,3,5]','09:00','09:50','America/Phoenix')",
            [],
        )
        .unwrap();

        let evidence = document_evidence_in(&conn, "doc-1").unwrap();
        assert_eq!(evidence.len(), 1);
        let candidate = &evidence[0];
        assert_eq!(candidate.kind, "class_meeting");
        assert_eq!(candidate.evidence, "STA 201 MWF 9:00");
        assert_eq!(candidate.weekdays, vec![1, 3, 5]);
        assert_eq!(candidate.starts_at_local, "09:00");
        assert_eq!(candidate.ends_at_local, "09:50");
        assert_eq!(candidate.timezone, "America/Phoenix");

        // A document with no vault blob is not evidence anyone can open.
        assert!(document_evidence_in(&conn, "doc-missing").is_err());
    }

    // Managed AI used to collapse every kind it did not recognise to a task,
    // which included class_meeting. Widening the wire contract without fixing
    // this would have left a screenshot extraction arriving as a pile of tasks
    // with the weekly pattern silently dropped.
    #[test]
    fn managed_ai_kinds_map_onto_kinds_that_can_actually_be_applied() {
        assert_eq!(local_candidate_kind("class_meeting"), "class_meeting");
        assert_eq!(local_candidate_kind("commitment"), "commitment");
        for shade_of_task in ["task", "assignment", "exam", "academic_event"] {
            assert_eq!(local_candidate_kind(shade_of_task), "task");
        }

        // Every kind this maps to must be one apply_candidate accepts, or
        // approval fails at the point the student presses the button.
        let directory = tempfile::tempdir().unwrap();
        let conn = open_database(&directory.path().join("kinds.db"), &random_key()).unwrap();
        conn.execute(
            "INSERT INTO academic_terms(id,name,starts_on,ends_on,active,created_at)
             VALUES('term','Fall 2026','2026-08-20','2026-12-12',1,'2026-08-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO documents(id,file_name,mime,vault_path,wrapped_key,key_nonce,content_nonce,sha256,imported_at)
             VALUES('doc','shot.png','image/png','v','k','n','c','s','2026-08-01T00:00:00Z')",
            [],
        )
        .unwrap();
        for kind in ["task", "commitment", "class_meeting"] {
            // Approval records provenance against the candidate row, so it has
            // to exist before apply_candidate is asked to file anything.
            conn.execute(
                "INSERT INTO import_candidates(id,document_id,kind,title,course,evidence,source_locator,source_type,source_uid,observed_at,confidence,student_edited_fields,last_observed_payload)
                 VALUES(?1,'doc',?2,'Statistics 201','Statistics 201','e','l','managed_ai',?3,'2026-08-25T12:00:00Z',1.0,'[\"title\"]','{\"title\":\"Original Statistics\"}')",
                params![format!("cand-{kind}"), kind, format!("ai:{kind}")],
            )
            .unwrap();
            let candidate = PendingCandidate {
                id: format!("cand-{kind}"),
                kind: kind.into(),
                title: "Statistics 201".into(),
                course: "Statistics 201".into(),
                starts_at: Some("2026-08-24T16:00:00Z".into()),
                ends_at: Some("2026-08-24T16:50:00Z".into()),
                duration_minutes: Some(50),
                weekdays: vec![1],
                starts_at_local: "09:00".into(),
                ends_at_local: "09:50".into(),
                timezone: "America/Phoenix".into(),
                ..Default::default()
            };
            assert!(
                apply_candidate(&conn, &candidate, None).is_ok(),
                "{kind} is produced but cannot be applied"
            );
        }
        let provenance: (String, String, String, f64, String, i64) = conn
            .query_row(
                "SELECT source_kind,sanitized_source_identifier,external_stable_id,confidence,
                        last_observed_source_value,student_edited
                 FROM provenance_links WHERE candidate_id='cand-task' AND field_name='title'",
                [],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)),
            )
            .unwrap();
        assert_eq!(provenance.0, "managed_ai");
        assert_eq!(provenance.1, "doc");
        assert_eq!(provenance.2, "ai:task");
        assert_eq!(provenance.3, 1.0);
        assert_eq!(provenance.4, "Original Statistics");
        assert_eq!(provenance.5, 1);
    }

    // A settled source is retained until the student explicitly chooses. Delete
    // removes the encrypted original while the evidence row survives.
    #[test]
    fn a_settled_screenshot_waits_for_a_retention_choice_then_keeps_its_evidence() {
        let directory = tempfile::tempdir().unwrap();
        let vault = directory.path().join("vault");
        fs::create_dir_all(&vault).unwrap();
        let conn = open_database(&directory.path().join("shred.db"), &random_key()).unwrap();

        let make = |id: &str, mime: &str, status: &str| {
            let blob = vault.join(format!("{id}.vault"));
            fs::write(&blob, b"ciphertext").unwrap();
            conn.execute(
                "INSERT INTO documents(id,file_name,mime,vault_path,wrapped_key,key_nonce,content_nonce,sha256,imported_at)
                 VALUES(?1,?2,?3,?4,'k','n','c',?1,'2026-08-01T00:00:00Z')",
                params![id, format!("{id}.png"), mime, blob.to_string_lossy()],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO import_candidates(id,document_id,kind,title,course,evidence,source_locator,source_uid,confidence,status)
                 VALUES(?1,?2,'class_meeting','Statistics 201','STA 201','STA 201 MWF 9:00','screenshot',?1,0.9,?3)",
                params![format!("cand-{id}"), id, status],
            )
            .unwrap();
            blob
        };
        let settled = make("11111111-1111-4111-8111-111111111111", "image/png", "approved");
        let pending = make("22222222-2222-4222-8222-222222222222", "image/png", "pending");
        let syllabus = make("33333333-3333-4333-8333-333333333333", "application/pdf", "approved");

        settle_schedule_source_in(&conn,&vault,directory.path(),"11111111-1111-4111-8111-111111111111","keep_encrypted").unwrap();
        assert!(settled.exists(), "explicit keep retains the source");
        conn.execute("INSERT INTO settings(key,value) VALUES('screenshot_retention','shred_when_settled')",[]).unwrap();
        settle_schedule_source_in(&conn,&vault,directory.path(),"11111111-1111-4111-8111-111111111111","keep_encrypted").unwrap();
        assert!(settled.exists(), "a legacy global preference cannot override per-source keep");
        assert!(settle_schedule_source_in(&conn,&vault,directory.path(),"22222222-2222-4222-8222-222222222222","delete_now").is_err(),"pending review blocks deletion");
        settle_schedule_source_in(&conn,&vault,directory.path(),"11111111-1111-4111-8111-111111111111","delete_now").unwrap();
        settle_schedule_source_in(&conn,&vault,directory.path(),"33333333-3333-4333-8333-333333333333","keep_encrypted").unwrap();

        assert!(!settled.exists(), "a settled screenshot's image is deleted");
        assert!(pending.exists(), "a screenshot still under review is kept");
        assert!(
            syllabus.exists(),
            "a syllabus is a document a student reopens; settling its candidates says nothing about that"
        );

        // The row survives and its evidence still reads, which is the whole
        // point of shredding the blob rather than the record.
        let evidence =
            document_evidence_in(&conn, "11111111-1111-4111-8111-111111111111").unwrap();
        assert_eq!(evidence.len(), 1);
        assert_eq!(evidence[0].evidence, "STA 201 MWF 9:00");

        // Nothing is left behind that could decrypt an image that no longer
        // exists.
        let (path, wrapped, shredded): (String, String, i64) = conn
            .query_row(
                "SELECT vault_path,wrapped_key,content_shredded FROM documents WHERE id=?1",
                params!["11111111-1111-4111-8111-111111111111"],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(path, "");
        assert_eq!(wrapped, "");
        assert_eq!(shredded, 1);

        // Reapplying the explicit delete is idempotent.
        settle_schedule_source_in(&conn,&vault,directory.path(),"11111111-1111-4111-8111-111111111111","delete_now").unwrap();
    }

    // Approving every class from a screenshot shreds the image. Re-pasting that
    // same screenshot afterwards is an ordinary thing to do, and it used to be
    // answered with "this already exists in your vault" — naming a document
    // whose image had been deleted, importing nothing, and leaving no way
    // forward.
    // The registrar's holidays were harvested, shown on the term preset, and
    // then dropped on the floor: a student read "2 no-class dates" and still got
    // study blocks on Thanksgiving. The planner already knew how to honour them;
    // nothing was carrying them in.
    // A refresh proposes; the student disposes. This is the half that was
    // missing entirely in 0.10.0: the diff was computed and then discarded,
    // because nothing could apply it.
    #[test]
    fn an_approved_calendar_change_applies_and_a_students_own_edit_wins() {
        let directory = tempfile::tempdir().unwrap();
        let conn = open_database(&directory.path().join("apply.db"), &random_key()).unwrap();
        conn.execute(
            "INSERT INTO academic_terms(id,name,starts_on,ends_on,active,created_at)
             VALUES('t-fall','Fall 2026 — Session C','2026-08-20','2026-12-12',1,'2026-08-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO academic_terms(id,name,starts_on,ends_on,active,created_at)
             VALUES('t-spring','Spring 2027 — Session C','2027-01-11','2027-05-08',0,'2026-08-01T00:00:00Z')",
            [],
        )
        .unwrap();

        let change = |term: &str, field: &str, current: &str, proposed: &str| {
            school_calendar::TermChange {
                term_id: "descriptor-id".into(),
                term_name: term.into(),
                field: field.into(),
                current: current.into(),
                proposed: proposed.into(),
                evidence: "Classes begin".into(),
            }
        };

        // Accepted, matches what is stored -> applied.
        let accepted = change(
            "Fall 2026 — Session C",
            "startsOn",
            "2026-08-20",
            "2026-08-24",
        );
        // The student already moved this one themselves; their edit must win.
        let stale = change(
            "Spring 2027 — Session C",
            "endsOn",
            "2027-05-08",
            "2027-05-15",
        );
        conn.execute(
            "UPDATE academic_terms SET ends_on='2027-05-10' WHERE id='t-spring'",
            [],
        )
        .unwrap();
        // A term this profile does not have cannot be created by a refresh.
        let unknown = change("Summer 2027", "startsOn", "2027-05-17", "2027-05-18");

        let approval = CalendarDiffApproval {
            term_changes: vec![accepted, stale, unknown],
            no_class_dates: vec![
                school_provider::NoClassDate {
                    starts_on: "2026-11-26".into(),
                    ends_on: "2026-11-27".into(),
                    label: "Thanksgiving holiday".into(),
                },
                // Outside every term this student has.
                school_provider::NoClassDate {
                    starts_on: "2030-07-04".into(),
                    ends_on: String::new(),
                    label: "Independence Day".into(),
                },
            ],
        };
        let (applied, skipped) = apply_calendar_diff_in(&conn, &approval).unwrap();
        assert_eq!(applied, 2, "the start date and the holiday");
        assert_eq!(skipped, 3, "the student's edit, the unknown term, the stray date");

        let fall_start: String = conn
            .query_row(
                "SELECT starts_on FROM academic_terms WHERE id='t-fall'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(fall_start, "2026-08-24", "the approved change applied");

        let spring_end: String = conn
            .query_row(
                "SELECT ends_on FROM academic_terms WHERE id='t-spring'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(spring_end, "2027-05-10", "a student's own edit is never overwritten");

        let holidays: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM academic_calendar_events WHERE no_class=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(holidays, 1);

        // Applying the same diff twice adds nothing further.
        let (again, _) = apply_calendar_diff_in(&conn, &approval).unwrap();
        assert_eq!(again, 0, "applying twice is a no-op");
    }

    #[test]
    fn harvested_holidays_become_no_class_days_the_planner_honours() {
        let directory = tempfile::tempdir().unwrap();
        let mut conn = open_database(&directory.path().join("holidays.db"), &random_key()).unwrap();
        profile::complete_onboarding(
            &mut conn,
            &profile::OnboardingDraft {
                name: "Holiday Test".into(),
                timezone: "America/Phoenix".into(),
                term_name: "Fall 2026 — Session C".into(),
                term_starts_on: "2026-08-20".into(),
                term_ends_on: "2026-12-12".into(),
                term_no_class_dates: vec![
                    profile::NoClassDateInput {
                        starts_on: "2026-11-26".into(),
                        ends_on: "2026-11-27".into(),
                        label: "Thanksgiving holiday".into(),
                    },
                    profile::NoClassDateInput {
                        starts_on: "2026-10-10".into(),
                        ends_on: String::new(),
                        label: "Fall break".into(),
                    },
                    // Malformed rows are skipped rather than stored: an unlabelled
                    // or backwards range is not a holiday.
                    profile::NoClassDateInput {
                        starts_on: "2026-10-20".into(),
                        ends_on: "2026-10-19".into(),
                        label: "Backwards".into(),
                    },
                    profile::NoClassDateInput {
                        starts_on: "2026-10-21".into(),
                        ends_on: String::new(),
                        label: "   ".into(),
                    },
                ],
                course_title: String::new(),
                course_code: String::new(),
                institution: profile::InstitutionSelection::default(),
                courses: Vec::new(),
                appearance: profile::AppearancePreference::System,
                sleep_start: "23:00".into(),
                sleep_end: "07:00".into(),
                max_session_minutes: 60,
                break_minutes: 10,
                transition_minutes: 10,
                default_commute_minutes: 0,
                availability: (0..7)
                    .map(|weekday| profile::AvailabilityInput {
                        weekday,
                        starts_at_local: "08:00".into(),
                        ends_at_local: "22:00".into(),
                    })
                    .collect(),
                commitments: Vec::new(),
            },
        )
        .unwrap();

        let mut statement = conn
            .prepare("SELECT title,starts_on,ends_on,no_class,source FROM academic_calendar_events ORDER BY starts_on")
            .unwrap();
        let rows: Vec<(String, String, String, i64, String)> = statement
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        drop(statement);

        assert_eq!(rows.len(), 2, "malformed rows are skipped: {rows:?}");
        // A single-day holiday spans one day rather than being left open-ended.
        assert_eq!(
            rows[0],
            (
                "Fall break".into(),
                "2026-10-10".into(),
                "2026-10-10".into(),
                1,
                "registrar".into()
            )
        );
        assert_eq!(rows[1].1, "2026-11-26");
        assert_eq!(rows[1].2, "2026-11-27");

        // The point of all of it: the planner sees those days as occupied.
        let effective = chrono_tz::America::Phoenix
            .with_ymd_and_hms(2026, 11, 26, 9, 0, 0)
            .unwrap()
            .with_timezone(&Utc);
        let snapshot =
            planner_snapshot(&conn, effective, planner::PlannerTrigger::Initial).unwrap();
        assert!(
            snapshot
                .fixed_constraints
                .iter()
                .any(|constraint| constraint.title.contains("Thanksgiving")),
            "the holiday must reach the planner as a fixed constraint: {:?}",
            snapshot
                .fixed_constraints
                .iter()
                .map(|c| &c.title)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn a_shredded_screenshot_can_be_imported_again() {
        let directory = tempfile::tempdir().unwrap();
        let conn = open_database(&directory.path().join("dedupe.db"), &random_key()).unwrap();
        conn.execute(
            "INSERT INTO documents(id,file_name,mime,vault_path,wrapped_key,key_nonce,content_nonce,sha256,imported_at)
             VALUES('doc-live','schedule.png','image/png','v','k','n','c','samehash','2026-08-01T00:00:00Z')",
            [],
        )
        .unwrap();
        assert_eq!(
            duplicate_document_name(&conn, "samehash").unwrap().as_deref(),
            Some("schedule.png"),
            "a stored document is still a duplicate"
        );

        // Now shred it, exactly as the sweep does.
        conn.execute(
            "UPDATE documents SET vault_path='',wrapped_key='',key_nonce='',content_nonce='',
                                  content_shredded=1 WHERE id='doc-live'",
            [],
        )
        .unwrap();
        assert_eq!(
            duplicate_document_name(&conn, "samehash").unwrap(),
            None,
            "a shredded screenshot must be importable again"
        );

        // A Canvas stub has no blob either and was never importable content, so
        // it must not start counting as a duplicate for some unrelated file.
        conn.execute(
            "INSERT INTO documents(id,file_name,mime,vault_path,wrapped_key,key_nonce,content_nonce,sha256,imported_at)
             VALUES('doc-stub','Canvas','text/plain','','','','','stubhash','2026-08-01T00:00:00Z')",
            [],
        )
        .unwrap();
        assert_eq!(duplicate_document_name(&conn, "stubhash").unwrap(), None);
    }

    #[test]
    fn keeping_screenshots_is_an_explicit_choice() {
        let directory = tempfile::tempdir().unwrap();
        let vault = directory.path().join("vault");
        fs::create_dir_all(&vault).unwrap();
        let conn = open_database(&directory.path().join("keep.db"), &random_key()).unwrap();
        let id = "44444444-4444-4444-8444-444444444444";
        let blob = vault.join(format!("{id}.vault"));
        fs::write(&blob, b"ciphertext").unwrap();
        conn.execute(
            "INSERT INTO documents(id,file_name,mime,vault_path,wrapped_key,key_nonce,content_nonce,sha256,imported_at)
             VALUES(?1,'shot.png','image/png',?2,'k','n','c',?1,'2026-08-01T00:00:00Z')",
            params![id, blob.to_string_lossy()],
        )
        .unwrap();
        assert_eq!(conn.query_row("SELECT source_retention FROM documents WHERE id=?1",params![id],|row|row.get::<_,String>(0)).unwrap(),"ask");
        conn.execute(
            "INSERT INTO import_candidates(id,document_id,kind,title,course,evidence,source_locator,source_uid,confidence,status)
             VALUES('c1',?1,'class_meeting','S','S','e','screenshot','u',0.9,'approved')",
            params![id],
        )
        .unwrap();
        settle_schedule_source_in(&conn,&vault,directory.path(),id,"keep_encrypted").unwrap();
        assert!(blob.exists(), "the preference is honoured");
    }

    #[test]
    fn planner_ai_and_sync_schema_migrations_are_additive_and_versioned() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("planner-schema.db");
        let key = random_key();
        let conn = open_database(&path, &key).unwrap();
        assert_eq!(
            conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            CURRENT_SCHEMA_VERSION
        );
        let columns = table_columns(&conn, "plan_blocks").unwrap();
        assert!(columns.contains("session_index"));
        assert!(columns.contains("location"));
        assert_eq!(CURRENT_SCHEMA_VERSION, 25);
        assert!(table_columns(&conn,"scholarship_story_examples").is_ok());
        // 12 adds the weekly pattern a class_meeting candidate carries, which
        // the single-instant datetime columns cannot express.
        let candidate_columns = table_columns(&conn, "import_candidates").unwrap();
        for column in [
            "weekdays", "starts_at_local", "ends_at_local", "timezone",
            "section_number", "location", "modality", "student_edited_fields",
            "last_observed_payload", "term_id",
        ] {
            assert!(candidate_columns.contains(column), "missing {column}");
        }
        assert!(table_columns(&conn,"class_meeting_series").unwrap().contains("modality"));
        let provenance_columns = table_columns(&conn, "provenance_links").unwrap();
        for column in [
            "source_kind", "sanitized_source_identifier", "external_stable_id",
            "confidence", "import_time", "last_observed_source_value", "student_edited",
        ] {
            assert!(provenance_columns.contains(column), "missing {column}");
        }
        // 13 lets a screenshot's image be deleted once its candidates are
        // settled while the row survives, so the evidence quotes still read.
        // Distinct from the empty vault_path of a Canvas stub, which never had
        // an image at all.
        assert!(table_columns(&conn, "documents")
            .unwrap()
            .contains("content_shredded"));
        for table in ["sync_entity_versions", "sync_set_elements"] {
            assert_eq!(
                conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                    params![table],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
                1
            );
        }
        assert_eq!(
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_invocations')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1
        );
        for table in ["document_segments","study_materials","study_artifacts","study_reviews","grade_categories","grade_items","course_grading_scales","scholarship_opportunities","scholarship_applications","scholarship_drafts","scholarship_draft_versions","scholarship_story_examples","scholarship_crawler_runs","scholarship_sources","scholarship_opportunity_diffs","scholarship_profiles","scholarship_writing_suggestions","scholarship_requirement_documents"] {
            assert_eq!(conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",params![table],|row|row.get::<_,i64>(0)).unwrap(),1,"missing {table}");
        }
        drop(conn);
        let reopened = open_database(&path, &key).unwrap();
        assert_eq!(
            reopened
                .query_row("SELECT COUNT(*) FROM plan_blocks", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn retention_migration_preserves_old_sources_and_prompts_for_new_ones() {
        let directory=tempfile::tempdir().unwrap();
        let path=directory.path().join("retention-migration.db");
        let key=random_key();
        {
            let conn=open_keyed_database(&path,&key).unwrap();
            conn.execute_batch(
                "CREATE TABLE documents(
                   id TEXT PRIMARY KEY,file_name TEXT NOT NULL,mime TEXT NOT NULL,vault_path TEXT NOT NULL,
                   wrapped_key TEXT NOT NULL,key_nonce TEXT NOT NULL,content_nonce TEXT NOT NULL,
                   sha256 TEXT NOT NULL,imported_at TEXT NOT NULL,extraction_status TEXT NOT NULL DEFAULT 'complete',
                   extraction_error TEXT
                 );
                 INSERT INTO documents(id,file_name,mime,vault_path,wrapped_key,key_nonce,content_nonce,sha256,imported_at)
                 VALUES('existing','old.png','image/png','vault/old','k','n','c','hash','2026-08-01T00:00:00Z');
                 PRAGMA user_version=14;",
            ).unwrap();
        }
        let conn=open_database(&path,&key).unwrap();
        assert_eq!(conn.query_row("SELECT source_retention FROM documents WHERE id='existing'",[],|row|row.get::<_,String>(0)).unwrap(),"keep_encrypted");
        conn.execute(
            "INSERT INTO documents(id,file_name,mime,vault_path,wrapped_key,key_nonce,content_nonce,sha256,imported_at)
             VALUES('new','new.png','image/png','vault/new','k','n','c','new-hash','2026-08-26T00:00:00Z')",
            [],
        ).unwrap();
        assert_eq!(conn.query_row("SELECT source_retention FROM documents WHERE id='new'",[],|row|row.get::<_,String>(0)).unwrap(),"ask");
    }

    #[test]
    fn weighted_grades_include_missing_work_and_keep_planned_what_if_separate() {
        let categories=vec![GradeCategorySummary{id:"exams".into(),course_id:"course".into(),name:"Exams".into(),weight:60.0},GradeCategorySummary{id:"work".into(),course_id:"course".into(),name:"Work".into(),weight:40.0}];
        let items=vec![
            GradeItemSummary{id:"midterm".into(),course_id:"course".into(),category_id:Some("exams".into()),title:"Midterm".into(),score:Some(80.0),points_possible:100.0,due_at:None,status:"graded".into()},
            GradeItemSummary{id:"missing".into(),course_id:"course".into(),category_id:Some("work".into()),title:"Worksheet".into(),score:None,points_possible:20.0,due_at:None,status:"missing".into()},
            GradeItemSummary{id:"what-if".into(),course_id:"course".into(),category_id:Some("exams".into()),title:"Final".into(),score:Some(100.0),points_possible:100.0,due_at:None,status:"planned".into()},
        ];
        let category_refs=categories.iter().collect::<Vec<_>>();let item_refs=items.iter().collect::<Vec<_>>();
        assert_eq!(grade_percent(&category_refs,&item_refs,true),Some(48.0));
        assert_eq!(grade_percent(&category_refs,&item_refs,false),Some(80.0));
    }

    #[test]
    fn completed_onboarding_enqueues_canonical_profile_and_availability_snapshots() {
        let directory = tempfile::tempdir().unwrap();
        let mut conn =
            open_database(&directory.path().join("onboarding-sync.db"), &random_key()).unwrap();
        complete_test_onboarding(&mut conn);
        enqueue_initial_workspace_mutations(&conn).unwrap();
        assert!(
            conn.query_row(
                "SELECT COUNT(*) FROM mutations WHERE entity_type='student_profile'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
                > 0
        );
        assert!(
            conn.query_row(
                "SELECT COUNT(*) FROM mutations WHERE entity_type='availability_rule'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
                > 0
        );
        let readable_placeholder = conn
            .query_row(
                "SELECT COUNT(*) FROM mutations WHERE payload='{}'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(readable_placeholder, 0);
    }

    #[test]
    fn database_planner_is_stable_non_overlapping_and_surfaces_overload() {
        let directory = tempfile::tempdir().unwrap();
        let mut conn = open_database(&directory.path().join("planner.db"), &random_key()).unwrap();
        complete_test_onboarding(&mut conn);
        conn.execute(
            "INSERT INTO tasks(
               id,title,minutes,due_at,priority,academic_risk,energy_demand,location,
               splittable,min_session_minutes,max_session_minutes,completed,created_at
             ) VALUES('planner-task','Write paper',120,'2026-08-19T20:00:00Z',5,4,
                      'high','library',1,30,60,0,?1)",
            params![Utc::now().to_rfc3339()],
        )
        .unwrap();
        let effective = parse_rfc3339("2026-08-17T14:00:00Z").unwrap();
        let first =
            regenerate_plan_for_trigger(&conn, Some(effective), planner::PlannerTrigger::Initial)
                .unwrap();
        assert_eq!(first.blocks.len(), 2);
        assert!(first
            .blocks
            .iter()
            .all(|block| block.starts_at.timestamp().rem_euclid(300) == 0));
        for pair in first.blocks.windows(2) {
            assert!(pair[0].ends_at <= pair[1].starts_at);
        }
        let fixed_start: DateTime<Utc> = "2026-08-17T15:35:00Z".parse().unwrap();
        let fixed_end: DateTime<Utc> = "2026-08-17T17:25:00Z".parse().unwrap();
        assert!(first
            .blocks
            .iter()
            .all(|block| block.ends_at <= fixed_start || block.starts_at >= fixed_end));
        let first_decisions = first
            .blocks
            .iter()
            .map(|block| (block.id.clone(), block.starts_at, block.ends_at))
            .collect::<Vec<_>>();
        let second =
            regenerate_plan_for_trigger(&conn, Some(effective), planner::PlannerTrigger::Initial)
                .unwrap();
        assert_eq!(
            first_decisions,
            second
                .blocks
                .iter()
                .map(|block| (block.id.clone(), block.starts_at, block.ends_at))
                .collect::<Vec<_>>()
        );
        let agenda = calendar_agenda(&conn, Some("2026-08-17")).unwrap();
        assert_eq!(
            agenda
                .blocks
                .iter()
                .filter(|block| block.task_id.is_some())
                .count(),
            2
        );

        conn.execute(
            "INSERT INTO tasks(
               id,title,minutes,due_at,priority,academic_risk,energy_demand,location,
               splittable,min_session_minutes,max_session_minutes,completed,created_at
             ) VALUES('impossible','Impossible deadline',120,'2026-08-17T14:10:00Z',5,5,
                      'high','',0,20,120,0,?1)",
            params![Utc::now().to_rfc3339()],
        )
        .unwrap();
        let overloaded = regenerate_plan_for_trigger(
            &conn,
            Some(effective),
            planner::PlannerTrigger::DeadlineChanged,
        )
        .unwrap();
        assert!(overloaded
            .overload_conflicts
            .iter()
            .any(|conflict| conflict.task_id == "impossible"));
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM source_conflicts
                 WHERE kind='overload' AND entity_id='impossible' AND resolved=0",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1
        );
    }

    fn canvas_pull(due_at: &str) -> CanvasPull {
        CanvasPull {
            profile: canvas::CanvasProfile {
                id: "42".into(),
                name: "Test Student".into(),
            },
            candidates: vec![CanvasCandidate {
                source_type: "canvas_assignment".into(),
                source_uid: "canvas:course:7:assignment:99".into(),
                source_url: "https://canvas.example.edu/courses/7/assignments/99".into(),
                kind: "task".into(),
                title: "Research outline".into(),
                course: "Writing 101".into(),
                due_at: Some(due_at.into()),
                starts_at: None,
                ends_at: None,
                duration_minutes: Some(45),
                evidence: format!("Canvas lists this assignment due at {due_at}"),
                source_locator: "Canvas · Writing 101 · assignment".into(),
                confidence: 1.0,
                warnings: vec![],
                snapshot: serde_json::json!({ "id": 99, "dueAt": due_at }),
            }],
            next_cursor: "2026-08-12T12:00:00Z".into(),
        }
    }

    #[test]
    fn legacy_canvas_approvals_are_backfilled_before_conflict_resolution() {
        let directory = tempfile::tempdir().unwrap();
        let conn = open_database(&directory.path().join("legacy.db"), &random_key()).unwrap();
        conn.execute(
            "INSERT INTO integration_connections(id,provider,base_url,status,created_at)
             VALUES('legacy-connection','canvas','https://canvas.example.edu','connected',?1)",
            params![Utc::now().to_rfc3339()],
        )
        .unwrap();
        let document_id =
            ensure_canvas_source_document(&conn, "legacy-connection", "https://canvas.example.edu")
                .unwrap();
        conn.execute(
            "INSERT INTO tasks(id,title,minutes,due_at,created_at)
             VALUES('legacy-task','Legacy essay',45,'2026-09-12T23:59:00Z',?1)",
            params![Utc::now().to_rfc3339()],
        )
        .unwrap();
        for (id, due_at, status) in [
            ("legacy-approved", "2026-09-12T23:59:00Z", "approved"),
            ("legacy-pending", "2026-09-14T23:59:00Z", "pending"),
        ] {
            conn.execute(
                "INSERT INTO import_candidates(
                   id,document_id,kind,title,course,due_at,duration_minutes,evidence,
                   source_locator,source_type,source_uid,confidence,status
                 ) VALUES(?1,?2,'task','Legacy essay','Writing 101',?3,45,'Canvas evidence',
                          'Canvas assignment','canvas_assignment','legacy-assignment',1,?4)",
                params![id, document_id, due_at, status],
            )
            .unwrap();
        }
        let legacy_conflict_id = format!(
            "source-change-{}",
            hex::encode(Sha256::digest(b"legacy-assignment"))
        );
        conn.execute(
            "INSERT INTO source_conflicts(id,description,resolved)
             VALUES(?1,'old unstructured conflict',0)",
            params![legacy_conflict_id],
        )
        .unwrap();

        backfill_legacy_canvas_links(&conn).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT canonical_entity_id FROM import_candidates WHERE id='legacy-approved'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "legacy-task"
        );
        assert_eq!(
            conn.query_row(
                "SELECT source_uid FROM tasks WHERE id='legacy-task'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "legacy-assignment"
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM provenance_links WHERE entity_id='legacy-task' AND active=1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            4
        );
        assert_eq!(
            conn.query_row(
                "SELECT resolved FROM source_conflicts WHERE id=?1",
                params![legacy_conflict_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT candidate_id FROM source_conflicts WHERE resolved=0 AND kind='source_change'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "legacy-pending"
        );
    }

    #[test]
    fn ambiguous_legacy_canvas_links_preserve_the_original_warning() {
        let directory = tempfile::tempdir().unwrap();
        let conn = open_database(&directory.path().join("ambiguous.db"), &random_key()).unwrap();
        conn.execute(
            "INSERT INTO integration_connections(id,provider,base_url,status,created_at)
             VALUES('ambiguous-connection','canvas','https://canvas.example.edu','connected',?1)",
            params![Utc::now().to_rfc3339()],
        )
        .unwrap();
        let document_id = ensure_canvas_source_document(
            &conn,
            "ambiguous-connection",
            "https://canvas.example.edu",
        )
        .unwrap();
        for id in ["possible-task-one", "possible-task-two"] {
            conn.execute(
                "INSERT INTO tasks(id,title,minutes,due_at,created_at)
                 VALUES(?1,'Same title',45,'2026-09-12T23:59:00Z',?2)",
                params![id, Utc::now().to_rfc3339()],
            )
            .unwrap();
        }
        for (id, due_at, status) in [
            ("ambiguous-approved", "2026-09-12T23:59:00Z", "approved"),
            ("ambiguous-pending", "2026-09-14T23:59:00Z", "pending"),
        ] {
            conn.execute(
                "INSERT INTO import_candidates(
                   id,document_id,kind,title,course,due_at,duration_minutes,evidence,
                   source_locator,source_type,source_uid,confidence,status
                 ) VALUES(?1,?2,'task','Same title','Writing 101',?3,45,'Canvas evidence',
                          'Canvas assignment','canvas_assignment','ambiguous-assignment',1,?4)",
                params![id, document_id, due_at, status],
            )
            .unwrap();
        }
        let legacy_conflict_id = format!(
            "source-change-{}",
            hex::encode(Sha256::digest(b"ambiguous-assignment"))
        );
        conn.execute(
            "INSERT INTO source_conflicts(id,description,resolved)
             VALUES(?1,'old ambiguous warning',0)",
            params![legacy_conflict_id],
        )
        .unwrap();

        backfill_legacy_canvas_links(&conn).unwrap();
        assert!(conn
            .query_row(
                "SELECT canonical_entity_id FROM import_candidates WHERE id='ambiguous-approved'",
                [],
                |row| row.get::<_, Option<String>>(0),
            )
            .unwrap()
            .is_none());
        assert_eq!(
            conn.query_row(
                "SELECT resolved FROM source_conflicts WHERE id=?1",
                params![legacy_conflict_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM source_conflicts WHERE candidate_id='ambiguous-pending'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0
        );
    }

    #[test]
    fn canvas_date_conflicts_resolve_without_duplicate_tasks() {
        let directory = tempfile::tempdir().unwrap();
        let mut conn =
            open_database(&directory.path().join("canvas-test.db"), &random_key()).unwrap();
        let connection_id = "canvas-connection";
        conn.execute(
            "INSERT INTO integration_connections(id,provider,base_url,status,created_at) VALUES(?1,'canvas','https://canvas.example.edu','connecting',?2)",
            params![connection_id, Utc::now().to_rfc3339()],
        )
        .unwrap();

        let first = canvas_pull("2026-09-12T23:59:00Z");
        let first_run = begin_sync_run(&conn, connection_id).unwrap();
        assert_eq!(
            persist_canvas_pull(&conn, connection_id, &first, &first_run).unwrap(),
            1
        );
        let first_candidate_id: String = conn
            .query_row(
                "SELECT id FROM import_candidates WHERE source_type='canvas_assignment' AND status='pending'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let first_candidate = pending_candidate(&conn, &first_candidate_id)
            .unwrap()
            .unwrap();
        let canonical_task_id = apply_candidate(&conn, &first_candidate, None).unwrap();
        regenerate_plan(&conn, None).unwrap();

        let repeated_run = begin_sync_run(&conn, connection_id).unwrap();
        assert_eq!(
            persist_canvas_pull(&conn, connection_id, &first, &repeated_run).unwrap(),
            0
        );

        let changed = canvas_pull("2026-09-14T23:59:00Z");
        let changed_run = begin_sync_run(&conn, connection_id).unwrap();
        assert_eq!(
            persist_canvas_pull(&conn, connection_id, &changed, &changed_run).unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM source_objects", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM source_conflicts WHERE resolved=0",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        let first_conflict_id: String = conn
            .query_row(
                "SELECT id FROM source_conflicts WHERE resolved=0",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let changed_candidate_id: String = conn
            .query_row(
                "SELECT candidate_id FROM source_conflicts WHERE id=?1",
                params![first_conflict_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(has_unresolved_candidate_conflict(&conn, &changed_candidate_id).unwrap());

        resolve_source_conflict_in_db(&mut conn, &first_conflict_id, "keep_existing").unwrap();
        let (task_count, task_id, kept_due): (i64, String, String) = conn
            .query_row(
                "SELECT COUNT(*),id,due_at FROM tasks WHERE source_uid LIKE 'canvas:%assignment:99'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(task_count, 1);
        assert_eq!(task_id, canonical_task_id);
        assert_eq!(kept_due, "2026-09-12T23:59:00Z");
        assert_eq!(
            conn.query_row(
                "SELECT resolution FROM source_conflicts WHERE id=?1",
                params![first_conflict_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "keep_existing"
        );

        let newest = canvas_pull("2026-09-16T23:59:00Z");
        let newest_run = begin_sync_run(&conn, connection_id).unwrap();
        assert_eq!(
            persist_canvas_pull(&conn, connection_id, &newest, &newest_run).unwrap(),
            1
        );
        let newest_conflict_id: String = conn
            .query_row(
                "SELECT id FROM source_conflicts WHERE resolved=0",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let newest_candidate_id: String = conn
            .query_row(
                "SELECT candidate_id FROM source_conflicts WHERE id=?1",
                params![newest_conflict_id],
                |row| row.get(0),
            )
            .unwrap();
        resolve_source_conflict_in_db(&mut conn, &newest_conflict_id, "use_source").unwrap();
        let (updated_count, updated_id, updated_due): (i64, String, String) = conn
            .query_row(
                "SELECT COUNT(*),id,due_at FROM tasks WHERE source_uid LIKE 'canvas:%assignment:99'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(updated_count, 1);
        assert_eq!(updated_id, canonical_task_id);
        assert_eq!(updated_due, "2026-09-16T23:59:00Z");
        assert_eq!(
            conn.query_row(
                "SELECT candidate_id FROM provenance_links
                 WHERE entity_type='task' AND entity_id=?1 AND field_name='due_at' AND active=1",
                params![canonical_task_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            newest_candidate_id
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM source_conflicts WHERE resolved=0",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0
        );
        let stored: String = conn
            .query_row(
                "SELECT COALESCE(group_concat(payload,''),'') FROM source_objects",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!stored.contains("test-canvas-personal-token"));
    }

    #[test]
    fn canvas_daily_reconciliation_and_revoked_token_state_are_recoverable() {
        let directory = tempfile::tempdir().unwrap();
        let conn = open_database(&directory.path().join("canvas-daily.db"), &random_key()).unwrap();
        let now: DateTime<Utc> = "2026-08-14T12:00:00Z".parse().unwrap();
        conn.execute(
            "INSERT INTO integration_connections(
               id,provider,base_url,status,last_synced_at,created_at
             ) VALUES('due','canvas','https://due.example.edu','connected',?1,?2),
                     ('fresh','canvas','https://fresh.example.edu','connected',?3,?2)",
            params![
                (now - Duration::hours(25)).to_rfc3339(),
                (now - Duration::days(10)).to_rfc3339(),
                (now - Duration::hours(2)).to_rfc3339(),
            ],
        )
        .unwrap();
        assert_eq!(due_canvas_reconciliations(&conn, now).unwrap(), vec!["due"]);
        let run_id = begin_sync_run(&conn, "due").unwrap();
        fail_sync_run(&conn, "due", &run_id, "Canvas rejected the token", true).unwrap();
        let status: String = conn
            .query_row(
                "SELECT status FROM integration_connections WHERE id='due'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "needs_reauthentication");
        assert!(due_canvas_reconciliations(&conn, now).unwrap().is_empty());
    }

    fn insert_encrypted_test_document(
        conn: &Connection,
        vault: &Path,
        master_key: &[u8; 32],
        plaintext: &[u8],
    ) -> String {
        let id = Uuid::new_v4().to_string();
        let document_key = random_key();
        let (ciphertext, content_nonce) = encrypt(&document_key, plaintext).unwrap();
        let (wrapped_key, key_nonce) = encrypt(master_key, &document_key).unwrap();
        let path = vault.join(format!("{id}.vault"));
        fs::write(&path, ciphertext).unwrap();
        conn.execute(
            "INSERT INTO documents(
               id,file_name,mime,vault_path,wrapped_key,key_nonce,content_nonce,sha256,imported_at
             ) VALUES(?1,'private-syllabus.txt','text/plain',?2,?3,?4,?5,?6,?7)",
            params![
                id,
                path.to_string_lossy(),
                B64.encode(wrapped_key),
                B64.encode(key_nonce),
                B64.encode(content_nonce),
                hex::encode(Sha256::digest(plaintext)),
                Utc::now().to_rfc3339()
            ],
        )
        .unwrap();
        id
    }

    #[test]
    fn encrypted_backup_round_trip_rekeys_and_replaces_the_profile() {
        // Restore must exercise credential invalidation without opening or
        // mutating the developer machine's real operating-system keychain.
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        let base = tempfile::tempdir().unwrap();
        let source_root = base.path().join("source");
        let source_vault = source_root.join("vault");
        fs::create_dir_all(&source_vault).unwrap();
        let source_key = random_key();
        let source_db_path = source_root.join("student-center.db");
        let source_db = open_database(&source_db_path, &source_key).unwrap();
        source_db
            .execute(
                "INSERT INTO tasks(id,title,minutes,priority,created_at) VALUES('portable-task','Private capstone plan',75,3,?1)",
                params![Utc::now().to_rfc3339()],
            )
            .unwrap();
        source_db.execute("INSERT INTO scholarship_opportunities(id,payload,updated_at) VALUES('portable-scholarship',?1,?2)",params![serde_json::json!({"id":"portable-scholarship","title":"Private community scholarship","state":"saved"}).to_string(),Utc::now().to_rfc3339()]).unwrap();
        source_db.execute("INSERT INTO scholarship_drafts(id,opportunity_id,payload,updated_at) VALUES('portable-draft','portable-scholarship',?1,?2)",params![serde_json::json!({"id":"portable-draft","opportunityId":"portable-scholarship","content":"My private scholarship story"}).to_string(),Utc::now().to_rfc3339()]).unwrap();
        source_db.execute("INSERT INTO scholarship_story_examples(id,payload,updated_at) VALUES('portable-story',?1,?2)",params![serde_json::json!({"id":"portable-story","title":"Community tutoring","detail":"I organized private weekly tutoring sessions","tags":["leadership"]}).to_string(),Utc::now().to_rfc3339()]).unwrap();
        source_db
            .execute(
                "INSERT INTO integration_connections(id,provider,base_url,account_name,status,created_at,credential_ref)
                 VALUES('portable-canvas-feed','canvas_calendar','https://canvas.example.edu','Canvas calendar','connected',?1,'canvas-calendar-feed:portable-canvas-feed')",
                params![Utc::now().to_rfc3339()],
            )
            .unwrap();
        let private_document = b"Private syllabus: capstone presentation due 2030-09-12";
        let document_id = insert_encrypted_test_document(
            &source_db,
            &source_vault,
            &source_key,
            private_document,
        );
        source_db.execute("INSERT INTO scholarship_requirement_documents(id,opportunity_id,document_id,payload,imported_at) VALUES('portable-requirements','portable-scholarship',?1,?2,?3)",params![document_id,serde_json::json!({"id":"portable-requirements","opportunityId":"portable-scholarship","documentId":document_id.clone(),"fileName":"private-syllabus.txt","mime":"text/plain","importedAt":Utc::now().to_rfc3339(),"status":"reviewed","proposedRequirements":["Transcript"],"proposedPrompts":[],"warnings":[],"selectedRequirements":["Transcript"],"selectedPromptIds":[]}).to_string(),Utc::now().to_rfc3339()]).unwrap();
        let archive_path = base.path().join("portable.studentcenter");
        let passphrase = "correct horse battery staple";
        let exported = backup::export_archive(
            &source_db,
            &source_root,
            &source_vault,
            &source_key,
            &archive_path,
            passphrase,
        )
        .unwrap();
        let raw_archive = fs::read(&archive_path).unwrap();
        assert!(!raw_archive
            .windows("Private capstone plan".len())
            .any(|window| window == b"Private capstone plan"));
        assert!(!raw_archive
            .windows(private_document.len())
            .any(|window| window == private_document));
        assert!(!raw_archive.windows("My private scholarship story".len()).any(|window|window==b"My private scholarship story"));
        assert!(!raw_archive.windows("private weekly tutoring".len()).any(|window|window==b"private weekly tutoring"));
        assert!(!raw_archive
            .windows(source_key.len())
            .any(|window| window == source_key));
        assert!(
            backup::preview_archive(&archive_path, "this is definitely the wrong passphrase")
                .is_err()
        );
        assert_eq!(
            backup::preview_archive(&archive_path, passphrase)
                .unwrap()
                .fingerprint,
            exported.fingerprint
        );
        assert!(
            backup::stage_archive(&source_root, &archive_path, passphrase, &"00".repeat(32))
                .is_err()
        );

        let target_root = base.path().join("target");
        let target_vault = target_root.join("vault");
        fs::create_dir_all(&target_vault).unwrap();
        let target_key = random_key();
        let target_db_path = target_root.join("student-center.db");
        let target_db = open_database(&target_db_path, &target_key).unwrap();
        target_db
            .execute(
                "INSERT INTO tasks(id,title,minutes,priority,created_at) VALUES('old-only','Old profile marker',10,1,?1)",
                params![Utc::now().to_rfc3339()],
            )
            .unwrap();
        let state = AppState {
            db: Arc::new(Mutex::new(target_db)),
            master_key: target_key,
            root: target_root.clone(),
            db_path: target_db_path.clone(),
            vault: target_vault.clone(),
            ocr: OcrRuntime::discover(None),
            locked: Arc::new(AtomicBool::new(false)),
            pin_attempts: Arc::new(Mutex::new(PinAttempts::default())),
            pending_navigation: Arc::new(Mutex::new(None)),
            account: Arc::new(Mutex::new(auth::AccountRuntime::test_unconfigured())),
            sync_protection: Arc::new(Mutex::new(sync_crypto::SyncProtectionRuntime::default())),
        };
        let staged = backup::stage_archive(
            &target_root,
            &archive_path,
            passphrase,
            &exported.fingerprint,
        )
        .unwrap();
        prepare_staged_profile(&state, &staged).unwrap();
        install_staged_profile(&state, staged).unwrap();

        let restored = state.db.lock().unwrap();
        assert_eq!(
            restored
                .query_row(
                    "SELECT COUNT(*) FROM tasks WHERE id='portable-task'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        assert_eq!(
            restored
                .query_row(
                    "SELECT COUNT(*) FROM tasks WHERE id='old-only'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        assert_eq!(restored.query_row("SELECT COUNT(*) FROM scholarship_drafts WHERE id='portable-draft'",[],|row|row.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(restored.query_row("SELECT COUNT(*) FROM scholarship_story_examples WHERE id='portable-story'",[],|row|row.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(restored.query_row("SELECT COUNT(*) FROM scholarship_requirement_documents WHERE id='portable-requirements'",[],|row|row.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(
            restored
                .query_row(
                    "SELECT status FROM integration_connections WHERE id='portable-canvas-feed'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "needs_reauthentication"
        );
        let (vault_path, wrapped, key_nonce, content_nonce): (String, String, String, String) =
            restored
                .query_row(
                    "SELECT vault_path,wrapped_key,key_nonce,content_nonce FROM documents WHERE id=?1",
                    params![document_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .unwrap();
        assert_eq!(
            PathBuf::from(&vault_path),
            target_vault.join(format!("{document_id}.vault"))
        );
        let document_key = decrypt(
            &target_key,
            &decode_nonce(&key_nonce).unwrap(),
            &B64.decode(wrapped).unwrap(),
        )
        .unwrap();
        let document_key: [u8; 32] = document_key.try_into().unwrap();
        assert_eq!(
            decrypt(
                &document_key,
                &decode_nonce(&content_nonce).unwrap(),
                &fs::read(vault_path).unwrap(),
            )
            .unwrap(),
            private_document
        );
        assert!(!target_root.join("restore-journal.json").exists());
    }

    #[test]
    fn damaged_backups_and_unconfirmed_restore_are_rejected() {
        assert!(require_restore_confirmation(false).is_err());
        assert!(require_restore_confirmation(true).is_ok());

        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("source");
        let vault = root.join("vault");
        fs::create_dir_all(&vault).unwrap();
        let key = random_key();
        let conn = open_database(&root.join("student-center.db"), &key).unwrap();
        let archive = base.path().join("valid.studentcenter");
        backup::export_archive(
            &conn,
            &root,
            &vault,
            &key,
            &archive,
            "long enough test passphrase",
        )
        .unwrap();
        let damaged = base.path().join("damaged.studentcenter");
        let mut bytes = fs::read(&archive).unwrap();
        let index = bytes.len() - 20;
        bytes[index] ^= 0x40;
        fs::write(&damaged, bytes).unwrap();
        assert!(backup::preview_archive(&damaged, "long enough test passphrase").is_err());
    }

    #[test]
    fn interrupted_restore_recovery_prefers_the_previous_profile() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path();
        let journal = RestoreJournal {
            id: Uuid::new_v4().to_string(),
            stage_id: Uuid::new_v4().to_string(),
        };
        let (rollback_db, rollback_vault, stage) = restore_paths(root, &journal).unwrap();
        fs::write(root.join("student-center.db"), b"new database").unwrap();
        fs::create_dir(root.join("vault")).unwrap();
        fs::write(root.join("vault/new.vault"), b"new vault").unwrap();
        fs::write(&rollback_db, b"previous database").unwrap();
        fs::create_dir(&rollback_vault).unwrap();
        fs::write(rollback_vault.join("old.vault"), b"previous vault").unwrap();
        fs::create_dir(&stage).unwrap();
        fs::write(
            root.join("restore-journal.json"),
            serde_json::to_vec(&journal).unwrap(),
        )
        .unwrap();

        recover_interrupted_restore(root).unwrap();
        assert_eq!(
            fs::read(root.join("student-center.db")).unwrap(),
            b"previous database"
        );
        assert_eq!(
            fs::read(root.join("vault/old.vault")).unwrap(),
            b"previous vault"
        );
        assert!(!root.join("vault/new.vault").exists());
        assert!(!root.join("restore-journal.json").exists());
        assert!(!stage.exists());
    }

    #[test]
    fn encrypted_sync_outbox_is_stable_across_retries_and_contains_no_plaintext() {
        let directory = tempfile::tempdir().unwrap();
        let mut conn = open_database(&directory.path().join("sync.db"), &random_key()).unwrap();
        conn.execute("DELETE FROM mutations", []).unwrap();
        let mutation_id = Uuid::new_v4();
        let entity_id = Uuid::new_v4();
        let payload = serde_json::json!({
            "schemaVersion": 2,
            "entityType": "task",
            "entityId": entity_id,
            "operation": "completion_changed",
            "snapshot": {"completed": 1, "title": "Private homework"}
        })
        .to_string();
        conn.execute(
            "INSERT INTO mutations(id,entity_type,entity_id,operation,hlc,device_id,tombstone,payload) VALUES(?1,'task',?2,'completion_changed',?3,?4,0,?5)",
            params![mutation_id.to_string(), entity_id.to_string(), format!("1786700000000-0000000000-{}", material_device_id()), material_device_id(), payload],
        ).unwrap();
        let account_id = Uuid::new_v4();
        let material = sync_crypto::SyncKeyMaterial::for_test(Uuid::parse_str(&material_device_id()).unwrap(), [9_u8; 32]);

        let first = prepare_sync_outbox(&mut conn, account_id, &material).unwrap();
        let second = prepare_sync_outbox(&mut conn, account_id, &material).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(
            serde_json::to_value(&first[0]).unwrap(),
            serde_json::to_value(&second[0]).unwrap()
        );
        let stored: String = conn
            .query_row(
                "SELECT envelope FROM sync_outbox WHERE account_id=?1 AND mutation_id=?2",
                params![account_id.to_string(), mutation_id.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!stored.contains("Private homework"));
        assert!(!stored.contains("completion_changed"));
        assert!(!stored.contains("completed"));
    }

    /// Insert a mutation row directly, bypassing `mutation()`, so tests can stage arbitrary entity
    /// types without needing a matching canonical row to snapshot.
    fn insert_raw_mutation(
        conn: &Connection,
        entity_type: &str,
        entity_id: Uuid,
        counter: u32,
    ) -> Uuid {
        let mutation_id = Uuid::new_v4();
        let payload = serde_json::json!({
            "schemaVersion": 2,
            "entityType": entity_type,
            "entityId": entity_id,
            "operation": "updated",
            "snapshot": {"id": entity_id.to_string()},
        })
        .to_string();
        conn.execute(
            "INSERT INTO mutations(id,entity_type,entity_id,operation,hlc,device_id,tombstone,payload) VALUES(?1,?2,?3,'updated',?4,?5,0,?6)",
            params![
                mutation_id.to_string(),
                entity_type,
                entity_id.to_string(),
                format!("178670000{counter:04}-0000000000-{}", material_device_id()),
                material_device_id(),
                payload
            ],
        )
        .unwrap();
        mutation_id
    }

    #[test]
    fn local_only_mutations_never_enter_the_encrypted_outbox() {
        let directory = tempfile::tempdir().unwrap();
        let mut conn = open_database(&directory.path().join("local-only.db"), &random_key()).unwrap();
        conn.execute("DELETE FROM mutations", []).unwrap();
        for (index, entity_type) in LOCAL_ONLY_ENTITY_TYPES.iter().enumerate() {
            insert_raw_mutation(&conn, entity_type, Uuid::new_v4(), index as u32);
        }
        let account_id = Uuid::new_v4();
        let material = sync_crypto::SyncKeyMaterial::for_test(
            Uuid::parse_str(&material_device_id()).unwrap(),
            [9_u8; 32],
        );
        assert!(
            prepare_sync_outbox(&mut conn, account_id, &material)
                .unwrap()
                .is_empty(),
            "local-only records must never be encrypted and uploaded"
        );
        assert_eq!(
            pending_mutation_count(&conn, &account_id.to_string()).unwrap(),
            0,
            "the pending badge must not count work that will never be sent"
        );
    }

    #[test]
    fn local_only_outbox_filter_does_not_starve_the_batch() {
        let directory = tempfile::tempdir().unwrap();
        let mut conn = open_database(&directory.path().join("starve.db"), &random_key()).unwrap();
        conn.execute("DELETE FROM mutations", []).unwrap();
        // The outbox page is 100 rows. If the entity-type filter ran in Rust after the SQL LIMIT,
        // this replan churn would consume every page and the task below would never upload.
        for index in 0..150 {
            insert_raw_mutation(&conn, "plan_block", Uuid::new_v4(), index);
        }
        let task_id = Uuid::new_v4();
        insert_raw_mutation(&conn, "task", task_id, 200);
        let account_id = Uuid::new_v4();
        let material = sync_crypto::SyncKeyMaterial::for_test(
            Uuid::parse_str(&material_device_id()).unwrap(),
            [9_u8; 32],
        );
        let batch = prepare_sync_outbox(&mut conn, account_id, &material).unwrap();
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].entity_id, task_id);
    }

    #[test]
    fn mutation_does_not_advance_the_register_for_local_only_types() {
        let directory = tempfile::tempdir().unwrap();
        let conn = open_database(&directory.path().join("register.db"), &random_key()).unwrap();
        conn.execute("DELETE FROM sync_entity_versions", []).unwrap();
        let block_id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO plan_blocks(id,task_id,starts_at,ends_at,locked,completed) VALUES(?1,?2,'2030-01-01T10:00:00Z','2030-01-01T11:00:00Z',0,0)",
            params![block_id, Uuid::new_v4().to_string()],
        )
        .ok();
        mutation(&conn, "plan_block", &block_id, "started", "{}").unwrap();
        let registered: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_entity_versions WHERE entity_type='plan_block'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            registered, 0,
            "a never-replicated type must not leave a high water mark in the version register"
        );
    }

    #[test]
    fn unknown_entity_types_are_staged_without_advancing_the_register() {
        let directory = tempfile::tempdir().unwrap();
        let conn = open_database(&directory.path().join("staged.db"), &random_key()).unwrap();
        let entity_id = Uuid::new_v4();
        let envelope = sync_transport::EncryptedMutation {
            mutation_id: Uuid::new_v4(),
            account_id: Uuid::new_v4(),
            device_id: Uuid::new_v4(),
            logical_timestamp: format!("1786700000000-0000000001-{}", Uuid::new_v4()),
            entity_id,
            entity_type: "seminar_group".into(),
            nonce: "N".repeat(32),
            ciphertext: "C".repeat(64),
            schema_version: 3,
            signature: TEST_SIGNATURE.into(),
            tombstone: false,
        };
        let plaintext = sync_transport::DecryptedMutation {
            operation: "updated".into(),
            payload: serde_json::json!({
                "schemaVersion": 2,
                "entityType": "seminar_group",
                "entityId": entity_id,
                "operation": "updated",
                "snapshot": {"id": entity_id.to_string()},
            })
            .to_string(),
        };
        // A type this build does not know is held, not dropped: a newer peer's real data must
        // survive until this computer is upgraded.
        assert_eq!(
            apply_canonical_mutation(&conn, &envelope, &plaintext).unwrap(),
            ApplyOutcome::Deferred
        );
        let registered: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_entity_versions WHERE entity_type='seminar_group'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            registered, 0,
            "deferring must not advance the register, or the retry after upgrade would look stale"
        );
    }

    #[test]
    fn deferred_mutations_drain_in_logical_order() {
        let directory = tempfile::tempdir().unwrap();
        let conn = open_database(&directory.path().join("drain.db"), &random_key()).unwrap();
        let account_id = Uuid::new_v4().to_string();
        let task_id = Uuid::new_v4();
        let device_id = Uuid::new_v4();
        conn.execute(
            "INSERT INTO tasks(id,title,minutes,created_at) VALUES(?1,'Original',60,'2030-01-01T00:00:00Z')",
            params![task_id.to_string()],
        )
        .unwrap();
        // Staged out of order on purpose: draining must settle on the later logical timestamp.
        for (counter, title) in [("0000000001", "Earlier"), ("0000000009", "Later")] {
            let envelope = sync_transport::EncryptedMutation {
                mutation_id: Uuid::new_v4(),
                account_id: Uuid::parse_str(&account_id).unwrap(),
                device_id,
                logical_timestamp: format!("1786700000000-{counter}-{device_id}"),
                entity_id: task_id,
                entity_type: "task".into(),
                nonce: "N".repeat(32),
                ciphertext: "C".repeat(64),
                schema_version: 3,
                signature: TEST_SIGNATURE.into(),
                tombstone: false,
            };
            let payload = serde_json::json!({
                "schemaVersion": 2,
                "entityType": "task",
                "entityId": task_id,
                "operation": "updated",
                "snapshot": {"id": task_id.to_string(), "title": title, "minutes": 60, "created_at": "2030-01-01T00:00:00Z"},
            })
            .to_string();
            conn.execute(
                "INSERT INTO sync_received_mutations(account_id,mutation_id,envelope,operation,payload,received_at,applied,outcome,entity_type,logical_timestamp,device_id)
                 VALUES(?1,?2,?3,'updated',?4,'2030-01-01T00:00:00Z',0,'deferred_unknown_type','task',?5,?6)",
                params![
                    account_id,
                    envelope.mutation_id.to_string(),
                    serde_json::to_string(&envelope).unwrap(),
                    payload,
                    envelope.logical_timestamp,
                    device_id.to_string()
                ],
            )
            .unwrap();
        }
        assert_eq!(drain_deferred_mutations(&conn, &account_id).unwrap(), 2);
        let title: String = conn
            .query_row(
                "SELECT title FROM tasks WHERE id=?1",
                params![task_id.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, "Later", "a drained backlog must converge like a live apply");
        let still_deferred: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_received_mutations WHERE outcome='deferred_unknown_type'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(still_deferred, 0);
    }

    #[test]
    fn peer_signing_keys_are_pinned_on_first_use() {
        let directory = tempfile::tempdir().unwrap();
        let conn = open_database(&directory.path().join("pinned.db"), &random_key()).unwrap();
        let account_id = Uuid::new_v4().to_string();
        let device_id = Uuid::new_v4();
        let peer = sync_transport::PendingDevice {
            device_id,
            public_key: "P".repeat(43),
            signing_public_key: "S".repeat(43),
            display_name: "Alex's laptop".into(),
            platform: "windows-x64".into(),
        };
        upsert_peer_device(&conn, &account_id, &peer).unwrap();
        assert_eq!(
            peer_signing_key(&conn, &account_id, device_id).unwrap(),
            Some("S".repeat(43))
        );
        // A hostile server could otherwise swap in its own key and make verification meaningless.
        let impostor = sync_transport::PendingDevice {
            signing_public_key: "X".repeat(43),
            ..peer.clone()
        };
        assert!(
            upsert_peer_device(&conn, &account_id, &impostor).is_err(),
            "a changed peer signing key must be refused, not silently accepted"
        );
        assert_eq!(
            peer_signing_key(&conn, &account_id, device_id).unwrap(),
            Some("S".repeat(43))
        );
    }

    #[test]
    fn sync_registration_transactionally_binds_offline_hlcs_to_the_device_identity() {
        let directory = tempfile::tempdir().unwrap();
        let mut conn = open_database(&directory.path().join("binding.db"), &random_key()).unwrap();
        let entity_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        conn.execute(
            "INSERT INTO tasks(id,title,minutes,created_at) VALUES(?1,'Offline work',30,'2030-01-01T00:00:00Z')",
            params![entity_id],
        )
        .unwrap();
        mutation(&conn, "task", entity_id, "created", "{}").unwrap();
        let account_id = "11111111-1111-4111-8111-111111111111";
        let target = Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
        bind_local_mutation_device(&conn, account_id, target).unwrap();
        let (hlc, device_id) = conn
            .query_row("SELECT hlc,device_id FROM mutations LIMIT 1", [], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap();
        assert!(hlc.ends_with(&target.to_string()));
        assert_eq!(device_id, target.to_string());
        assert_eq!(persistent_device_id(&conn).unwrap(), target.to_string());

        let material = sync_crypto::SyncKeyMaterial::for_test(target, [9_u8; 32]);
        assert_eq!(
            prepare_sync_outbox(&mut conn, Uuid::parse_str(account_id).unwrap(), &material)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn canonical_sync_converges_with_stable_device_tie_breaking() {
        let source_root = tempfile::tempdir().unwrap();
        let source = open_database(&source_root.path().join("source.db"), &random_key()).unwrap();
        let entity_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        source
            .execute(
                "INSERT INTO tasks(id,title,minutes,due_at,created_at) VALUES(?1,'Device A title',30,'2030-09-20T18:00:00Z','2030-01-01T00:00:00Z')",
                params![entity_id],
            )
            .unwrap();
        let mut snapshot_a = canonical_entity_snapshot(&source, "task", entity_id)
            .unwrap()
            .unwrap()
            .as_object()
            .unwrap()
            .clone();
        let mut snapshot_b = snapshot_a.clone();
        snapshot_a.insert("title".into(), "Device A title".into());
        snapshot_b.insert("title".into(), "Device B title".into());

        let account_id = Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap();
        let device_a = Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
        let device_b = Uuid::parse_str("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").unwrap();
        let make = |device_id: Uuid,
                    mutation_id: &str,
                    snapshot: serde_json::Map<String, serde_json::Value>| {
            let payload = serde_json::json!({
                "schemaVersion": 2,
                "entityType": "task",
                "entityId": entity_id,
                "operation": "updated",
                "snapshot": snapshot,
            })
            .to_string();
            (
                sync_transport::EncryptedMutation {
                    mutation_id: Uuid::parse_str(mutation_id).unwrap(),
                    account_id,
                    device_id,
                    logical_timestamp: format!("1786700000000-0000000001-{device_id}"),
                    entity_id: Uuid::parse_str(entity_id).unwrap(),
                    entity_type: "task".into(),
                    nonce: "N".repeat(32),
                    ciphertext: "C".repeat(64),
                    schema_version: 3,
                    signature: TEST_SIGNATURE.into(),
                    tombstone: false,
                },
                sync_transport::DecryptedMutation {
                    operation: "updated".into(),
                    payload,
                },
            )
        };
        let a = make(device_a, "aaaaaaaa-1111-4111-8111-111111111111", snapshot_a);
        let b = make(device_b, "bbbbbbbb-2222-4222-8222-222222222222", snapshot_b);

        let left_root = tempfile::tempdir().unwrap();
        let right_root = tempfile::tempdir().unwrap();
        let left = open_database(&left_root.path().join("left.db"), &random_key()).unwrap();
        let right = open_database(&right_root.path().join("right.db"), &random_key()).unwrap();
        apply_canonical_mutation(&left, &a.0, &a.1).unwrap();
        apply_canonical_mutation(&left, &b.0, &b.1).unwrap();
        apply_canonical_mutation(&right, &b.0, &b.1).unwrap();
        apply_canonical_mutation(&right, &a.0, &a.1).unwrap();
        let title = |conn: &Connection| {
            conn.query_row(
                "SELECT title FROM tasks WHERE id=?1",
                params![entity_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap()
        };
        assert_eq!(title(&left), "Device B title");
        assert_eq!(title(&right), "Device B title");
    }

    // canonical_table silently skips anything it does not map, which is correct
    // for derived local-only state but meant that three shipped entity types
    // replicated as nothing at all. Every replicable type must be classified
    // deliberately, not by omission.
    #[test]
    fn appearance_accepts_every_shipped_theme_and_migrates_the_legacy_dark_name() {
        let directory = tempfile::tempdir().unwrap();
        let conn = open_database(&directory.path().join("appearance.db"), &random_key()).unwrap();
        for theme in ["system", "coqui-dark", "midnight", "graphite", "forest", "light"] {
            profile::set_appearance(&conn, theme).unwrap();
            assert_eq!(profile::workspace(&conn).unwrap().appearance.as_str(), theme);
        }
        // Profiles written before 0.9 stored the only dark theme as "dark".
        profile::set_appearance(&conn, "dark").unwrap();
        assert_eq!(
            profile::workspace(&conn).unwrap().appearance.as_str(),
            "coqui-dark"
        );
        assert!(profile::set_appearance(&conn, "neon").is_err());

        for accent in profile::ACCENTS {
            profile::set_accent(&conn, accent).unwrap();
            assert_eq!(profile::workspace(&conn).unwrap().accent, accent);
        }
        assert!(profile::set_accent(&conn, "chartreuse").is_err());
        assert_eq!(
            profile::workspace(
                &open_database(&directory.path().join("fresh.db"), &random_key()).unwrap()
            )
            .unwrap()
            .accent,
            "green"
        );
    }

    #[test]
    fn every_canonical_entity_type_is_either_replicated_or_explicitly_local() {
        // Consumes the production constants rather than restating them, so the test cannot drift
        // away from the lists the outbox and apply path actually use.
        const LOCAL_ONLY: [&str; 10] = LOCAL_ONLY_ENTITY_TYPES;
        // Every entity type canonical_entity_snapshot can produce a payload for.
        const SNAPSHOTTABLE: [&str; 24] = [
            "task",
            "assignment",
            "exam",
            "course",
            "commitment",
            "academic_term",
            "instructor",
            "class_meeting_series",
            "academic_calendar_event",
            "student_profile",
            "planning_preferences",
            "availability_rule",
            "import_candidate",
            "source_conflict",
            "plan",
            "plan_block",
            "document",
            "reminder",
            "notification_preferences",
            "integration_connection",
            "scholarship_opportunity",
            "scholarship_application",
            "scholarship_draft",
            "scholarship_story",
        ];
        let directory = tempfile::tempdir().unwrap();
        let conn = open_database(&directory.path().join("classify.db"), &random_key()).unwrap();
        let tables = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<std::result::Result<std::collections::HashSet<_>, _>>()
            .unwrap();
        for entity_type in SNAPSHOTTABLE {
            match canonical_table(entity_type) {
                Some((table, _)) => {
                    assert!(
                        !LOCAL_ONLY.contains(&entity_type),
                        "{entity_type} is both replicated and marked local-only"
                    );
                    assert!(
                        tables.contains(table),
                        "{entity_type} maps to missing table {table}"
                    );
                }
                None => assert!(
                    LOCAL_ONLY.contains(&entity_type),
                    "{entity_type} would be dropped on apply without being declared local-only"
                ),
            }
        }
        // The outbox SQL binds REPLICATED_ENTITY_TYPES literally, so it must agree with the
        // predicate derived from canonical_table or uploads would silently omit a live type.
        for entity_type in REPLICATED_ENTITY_TYPES {
            assert!(
                is_replicated_entity_type(entity_type),
                "{entity_type} is listed for upload but has no canonical table"
            );
        }
        for entity_type in SNAPSHOTTABLE {
            assert_eq!(
                is_replicated_entity_type(entity_type),
                REPLICATED_ENTITY_TYPES.contains(&entity_type),
                "{entity_type} disagrees between the upload list and the apply mapping"
            );
        }
    }

    #[test]
    fn schedule_entities_record_snapshots_and_converge_on_a_second_device() {
        let directory = tempfile::tempdir().unwrap();
        let mut conn =
            open_database(&directory.path().join("schedule-sync.db"), &random_key()).unwrap();
        complete_test_onboarding(&mut conn);
        enqueue_initial_workspace_mutations(&conn).unwrap();
        let course_id = conn
            .query_row("SELECT id FROM courses LIMIT 1", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap();
        let term_id = conn
            .query_row("SELECT id FROM academic_terms LIMIT 1", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap();

        let instructor_id = profile::create_instructor(
            &conn,
            &profile::InstructorInput {
                course_id: course_id.clone(),
                name: "Dr. Rivera".into(),
                email: "rivera@example.edu".into(),
                office_location: "COOR 3140".into(),
                office_hours: "Tue 10:00-12:00".into(),
                expected_version: None,
            },
        )
        .unwrap();
        mutation(&conn, "instructor", &instructor_id, "created", "{}").unwrap();

        let meeting_id = profile::create_class_meeting(
            &conn,
            &profile::ClassMeetingSeriesInput {
                course_id: course_id.clone(),
                term_id: term_id.clone(),
                timezone: "Etc/UTC".into(),
                weekdays: vec![1, 3],
                starts_at_local: "09:00".into(),
                ends_at_local: "10:15".into(),
                component: "lecture".into(),
                location: "COOR 170".into(),
                modality: "in_person".into(),
                instructor_id: Some(instructor_id.clone()),
                rotation_interval_weeks:1,
                rotation_offset_weeks:0,
                expected_version: None,
            },
        )
        .unwrap();
        mutation(&conn, "class_meeting_series", &meeting_id, "created", "{}").unwrap();

        let event_id = profile::create_academic_event(
            &conn,
            &profile::AcademicCalendarEventInput {
                term_id: Some(term_id),
                title: "Fall break".into(),
                starts_on: "2026-10-12".into(),
                ends_on: "2026-10-13".into(),
                all_day: true,
                no_class: true,
                source: "user".into(),
                expected_version: None,
            },
        )
        .unwrap();
        mutation(&conn, "academic_calendar_event", &event_id, "created", "{}").unwrap();

        // A missing snapshot is silently recorded as a tombstone, which would
        // replicate a create as a delete.
        for (entity_type, entity_id) in [
            ("instructor", &instructor_id),
            ("class_meeting_series", &meeting_id),
            ("academic_calendar_event", &event_id),
        ] {
            let (tombstone, payload) = conn
                .query_row(
                    "SELECT tombstone,payload FROM mutations WHERE entity_type=?1 AND entity_id=?2",
                    params![entity_type, entity_id],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                )
                .unwrap();
            assert_eq!(tombstone, 0, "{entity_type} was recorded as a tombstone");
            let payload: CanonicalMutationV2 = serde_json::from_str(&payload).unwrap();
            assert!(
                payload.snapshot.is_some(),
                "{entity_type} carried no canonical snapshot"
            );
        }

        // Replay onto a second device and assert the rows actually land. The
        // term and course come first because the schedule tables reference
        // them; a real pull applies mutations in the same logical order.
        let replica_root = tempfile::tempdir().unwrap();
        let replica =
            open_database(&replica_root.path().join("replica.db"), &random_key()).unwrap();
        let account_id = Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap();
        let device_id = Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
        let mut statement = conn
            .prepare("SELECT entity_type,entity_id,operation,payload FROM mutations WHERE entity_type IN ('academic_term','course','instructor','class_meeting_series','academic_calendar_event') ORDER BY hlc")
            .unwrap();
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(rows.len(), 5);
        for (index, (entity_type, entity_id, operation, payload)) in rows.into_iter().enumerate() {
            let envelope = sync_transport::EncryptedMutation {
                mutation_id: Uuid::new_v4(),
                account_id,
                device_id,
                logical_timestamp: format!("178670000000{index}-000000000{index}-{device_id}"),
                entity_id: Uuid::parse_str(&entity_id).unwrap(),
                entity_type,
                nonce: "N".repeat(32),
                ciphertext: "C".repeat(64),
                schema_version: 3,
                signature: TEST_SIGNATURE.into(),
                tombstone: false,
            };
            let decrypted = sync_transport::DecryptedMutation { operation, payload };
            apply_canonical_mutation(&replica, &envelope, &decrypted).unwrap();
        }
        let count = |table: &str, id: &str| {
            replica
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE id=?1"),
                    params![id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap()
        };
        assert_eq!(count("instructors", &instructor_id), 1);
        assert_eq!(count("class_meeting_series", &meeting_id), 1);
        assert_eq!(count("academic_calendar_events", &event_id), 1);
        assert_eq!(
            replica
                .query_row(
                    "SELECT name FROM instructors WHERE id=?1",
                    params![instructor_id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "Dr. Rivera"
        );
    }

    #[test]
    fn canonical_sync_merges_dependency_sets_by_element_identity() {
        let task_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        let dependency_a = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
        let dependency_b = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
        let account_id = Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap();
        let device_a = Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
        let device_b = Uuid::parse_str("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").unwrap();
        let make = |device_id: Uuid, mutation_id: &str, dependency: &str| {
            let payload = serde_json::json!({
                "schemaVersion": 2,
                "entityType": "task",
                "entityId": task_id,
                "operation": "updated",
                "snapshot": {
                    "id": task_id,
                    "title": "Concurrent dependency merge",
                    "minutes": 30,
                    "due_at": "2030-09-20T18:00:00Z",
                    "created_at": "2030-01-01T00:00:00Z",
                    "dependencies": [dependency]
                },
                "setChanges": [{
                    "fieldName": "dependencies",
                    "elementId": dependency,
                    "tombstone": false
                }]
            })
            .to_string();
            (
                sync_transport::EncryptedMutation {
                    mutation_id: Uuid::parse_str(mutation_id).unwrap(),
                    account_id,
                    device_id,
                    logical_timestamp: format!("1786700000000-0000000001-{device_id}"),
                    entity_id: Uuid::parse_str(task_id).unwrap(),
                    entity_type: "task".into(),
                    nonce: "N".repeat(32),
                    ciphertext: "C".repeat(64),
                    schema_version: 3,
                    signature: TEST_SIGNATURE.into(),
                    tombstone: false,
                },
                sync_transport::DecryptedMutation {
                    operation: "updated".into(),
                    payload,
                },
            )
        };
        let a = make(
            device_a,
            "aaaaaaaa-1111-4111-8111-111111111111",
            dependency_a,
        );
        let b = make(
            device_b,
            "bbbbbbbb-2222-4222-8222-222222222222",
            dependency_b,
        );
        let open = || {
            let root = tempfile::tempdir().unwrap();
            let connection = open_database(&root.path().join("sync.db"), &random_key()).unwrap();
            for id in [dependency_a, dependency_b] {
                connection.execute(
                    "INSERT INTO tasks(id,title,minutes,created_at) VALUES(?1,'Prerequisite',10,'2030-01-01T00:00:00Z')",
                    params![id],
                ).unwrap();
            }
            (root, connection)
        };
        let (_left_root, left) = open();
        let (_right_root, right) = open();
        apply_canonical_mutation(&left, &a.0, &a.1).unwrap();
        apply_canonical_mutation(&left, &b.0, &b.1).unwrap();
        apply_canonical_mutation(&right, &b.0, &b.1).unwrap();
        apply_canonical_mutation(&right, &a.0, &a.1).unwrap();
        let dependencies = |connection: &Connection| {
            connection
                .prepare("SELECT depends_on_task_id FROM task_dependencies WHERE task_id=?1 ORDER BY depends_on_task_id")
                .unwrap()
                .query_map(params![task_id], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<std::result::Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(
            dependencies(&left),
            vec![dependency_a.to_string(), dependency_b.to_string()]
        );
        assert_eq!(dependencies(&right), dependencies(&left));
    }

    #[test]
    fn institution_setup_provider_has_sourced_asu_campuses_and_dates() {
        let providers: Vec<SchoolProvider> = serde_json::from_str(include_str!(
            "../resources/institution-setup-providers.json"
        ))
        .unwrap();
        let asu = providers
            .iter()
            .find(|provider| provider.institution_id == "104151")
            .unwrap();
        assert_eq!(
            asu.campuses
                .iter()
                .take(4)
                .map(|campus| campus.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Tempe", "Downtown Phoenix", "West Valley", "Polytechnic"]
        );
        assert_eq!(asu.terms[0].starts_on, "2026-08-20");
        assert_eq!(asu.terms[0].ends_on, "2026-12-12");
        assert_eq!(asu.terms[0].class_ends_on, "2026-12-04");
        assert_eq!(asu.terms[0].exam_starts_on, "2026-12-07");
        assert!(asu.terms[0]
            .source_url
            .starts_with("https://registrar.asu.edu/"));

        // ASU's class search sits behind weblogin, so the honest descriptor says
        // there is no readable catalog. That has to stay a supported state: the
        // screenshot path is what covers it, and the UI must not read as broken.
        assert!(!asu.has_readable_catalog());
        assert!(!asu
            .catalog_source
            .as_ref()
            .expect("the reason for having no catalog is worth stating")
            .note
            .is_empty());
    }

    /// What the setup screen receives, pinned by shape rather than by value.
    ///
    /// The descriptor carries far more than this — calendar sources, date
    /// patterns, schedule layouts — and none of it may appear here; the
    /// projection is what keeps the file free to grow without changing the API.
    /// Pinning the key sets rather than the whole document is deliberate: a
    /// calendar harvest legitimately changes the dates, and a test that has to
    /// be rewritten every time one runs stops being read.
    #[test]
    fn setup_receives_the_descriptor_projection_and_nothing_more() {
        let options = institution_setup_options_for("104151".into()).unwrap();
        let json = serde_json::to_value(&options).unwrap();

        let keys = |value: &serde_json::Value| {
            let mut names: Vec<String> =
                value.as_object().expect("an object").keys().cloned().collect();
            names.sort();
            names
        };
        assert_eq!(
            keys(&json),
            vec![
                "campuses".to_string(),
                "generatedAt".into(),
                "institutionId".into(),
                "sourceLabel".into(),
                "sourceUrl".into(),
                "terms".into(),
            ],
            "a descriptor field leaked into what setup receives"
        );
        assert_eq!(
            keys(&json["terms"][0]),
            vec![
                "classEndsOn".to_string(),
                "details".into(),
                "endsOn".into(),
                "examStartsOn".into(),
                "id".into(),
                "name".into(),
                "noClassDates".into(),
                "sessionCode".into(),
                "sourceLabel".into(),
                "sourceUrl".into(),
                "startsOn".into(),
            ]
        );
        assert_eq!(keys(&json["campuses"][0]).len(), 6);

        // Spot values, so the projection is carrying real data and not defaults.
        assert_eq!(json["institutionId"], "104151");
        assert_eq!(json["terms"][0]["id"], "asu-fall-2026-c");
        assert_eq!(json["terms"][0]["startsOn"], "2026-08-20");
        assert_eq!(json["campuses"][0]["name"], "Tempe");
        assert!(
            json["generatedAt"].as_str().is_some_and(|value| !value.is_empty()),
            "a pre-filled date has to say how old it is"
        );

        // An unknown school is still an empty answer rather than an error: the
        // student types their dates in by hand and setup continues.
        let unknown = institution_setup_options_for("000000".into()).unwrap();
        assert_eq!(unknown.institution_id, "000000");
        assert!(unknown.campuses.is_empty() && unknown.terms.is_empty());
    }

    /// The holidays came off the live registrar page, not out of anyone's head.
    /// A planner that skips a study day for a holiday the school does not
    /// observe is wrong in the same way as one that schedules through a real one.
    #[test]
    fn harvested_no_class_dates_sit_inside_their_term() {
        let options = institution_setup_options_for("104151".into()).unwrap();
        let fall = &options.terms[0];
        assert!(
            !fall.no_class_dates.is_empty(),
            "the harvest has been run against the live page"
        );
        for date in &fall.no_class_dates {
            assert!(date.starts_on >= fall.starts_on && date.starts_on <= fall.ends_on);
            if !date.ends_on.is_empty() {
                assert!(date.ends_on > date.starts_on);
            }
            assert!(!date.label.trim().is_empty());
        }
    }

    // The reported bug: ASU has 17 directory entries and the twelve that sorted
    // first were all satellite locations, so the main campus entry -- the only
    // one carrying the campus picker and registrar term dates -- was cut off.
    #[test]
    fn searching_for_a_university_ranks_the_campus_bearing_entry_first() {
        for query in ["arizona state", "arizona state university", "asu"] {
            let results = search_institutions_in(query).unwrap();
            assert_eq!(
                results[0].id, "104151",
                "{query:?} should surface the entry with campus and term presets, got {:?}",
                results.iter().map(|r| r.name.as_str()).collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn searching_for_a_campus_name_selects_that_campus() {
        for (query, campus) in [
            ("tempe", "Tempe"),
            ("downtown phoenix", "Downtown Phoenix"),
            ("west valley", "West Valley"),
        ] {
            let results = search_institutions_in(query).unwrap();
            let asu = results
                .iter()
                .find(|result| result.id == "104151")
                .unwrap_or_else(|| panic!("{query:?} did not reach Arizona State"));
            assert_eq!(asu.matched_campus_name, campus);
            assert!(!asu.matched_campus_id.is_empty());
        }
    }

    // "measure" and "treasure" contain "asu"; a plain substring search returned
    // barbering and technical colleges while hiding every Arizona State campus.
    #[test]
    fn short_queries_do_not_match_mid_word() {
        let results = search_institutions_in("asu").unwrap();
        assert!(
            !results
                .iter()
                .any(|result| result.name.contains("Beyond Measure")
                    || result.name.contains("Treasure Coast")),
            "mid-word matches leaked in: {:?}",
            results.iter().map(|r| r.name.as_str()).collect::<Vec<_>>()
        );
    }

    // search_course_suggestions bound its institution parameter to
    // `_institution_id` and never read it, so course suggestions were identical
    // for every school. This guards the seam that fix introduced.
    #[test]
    fn course_catalogs_are_keyed_by_institution() {
        let catalogs = institution_catalogs().unwrap();
        assert!(
            institution_catalog_for("104151").unwrap().is_some(),
            "the school with campus and term presets should have a catalog entry"
        );
        assert!(
            institution_catalog_for("000000").unwrap().is_none(),
            "an unknown school must not inherit another school's courses"
        );
        for catalog in catalogs {
            assert!(!catalog.institution_id.is_empty());
            for course in &catalog.courses {
                // A code with no title would render as a blank suggestion.
                assert!(!course.code.trim().is_empty(), "catalog course needs a code");
                assert!(
                    !course.title.trim().is_empty(),
                    "catalog course {} needs a title",
                    course.code
                );
            }
            // Shipping courses without saying where they came from is what the
            // rest of this app refuses to do; keep the catalog to that standard.
            if !catalog.courses.is_empty() {
                assert!(
                    !catalog.source_label.trim().is_empty()
                        && !catalog.source_url.trim().is_empty(),
                    "catalog {} ships courses without provenance",
                    catalog.institution_id
                );
            }
        }
    }

    // Profiles saved before multi-campus support hold no campusIds. They must
    // keep loading with their single campus intact rather than losing it.
    #[test]
    fn institution_selections_saved_before_multi_campus_still_load() {
        let legacy = r#"{"id":"104151","name":"Arizona State University","country":"US","source":"college_scorecard","catalogProviderStatus":"unavailable","custom":false,"campusId":"tempe","campusName":"Tempe"}"#;
        let selection: profile::InstitutionSelection = serde_json::from_str(legacy).unwrap();
        assert_eq!(selection.campus_id, "tempe");
        assert_eq!(selection.campus_name, "Tempe");
        assert!(selection.campus_ids.is_empty());

        let multi = r#"{"id":"104151","name":"Arizona State University","country":"US","source":"college_scorecard","catalogProviderStatus":"unavailable","custom":false,"campusId":"tempe","campusName":"Tempe","campusIds":["tempe","west-valley","downtown-phoenix"],"campusNames":["Tempe","West Valley","Downtown Phoenix"]}"#;
        let selection: profile::InstitutionSelection = serde_json::from_str(multi).unwrap();
        assert_eq!(selection.campus_ids.len(), 3);
        // The primary stays first so it keeps driving class-meeting defaults.
        assert_eq!(selection.campus_id, selection.campus_ids[0]);
        let encoded = serde_json::to_string(&selection).unwrap();
        assert!(encoded.contains("\"campusIds\""));
    }

    #[test]
    fn acronyms_resolve_to_the_institution_they_abbreviate() {
        assert_eq!(institution_acronym("Arizona State University"), "asu");
        assert_eq!(
            institution_acronym("University of California-Los Angeles"),
            "ucla"
        );
        assert!(matches_at_word_boundary("arizona state university", "state"));
        assert!(!matches_at_word_boundary("beyond measure", "asu"));
    }

    fn material_device_id() -> String {
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into()
    }
}
