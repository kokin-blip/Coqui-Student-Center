use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{imports, AppError, Result};

const PROFILE_KEY: &str = "semester_planner_profile_v1";
const ROADMAPS_KEY: &str = "semester_roadmaps_v1";
const REPORTS_KEY: &str = "semester_analysis_reports_v1";

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlannerProfile {
    pub program: String,
    pub catalog_year: String,
    pub study_goals: String,
    pub career_interests: String,
    pub constraints: String,
    pub version: u32,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoadmapEvidence {
    pub id: String,
    pub institution_id: String,
    pub program: String,
    pub catalog_year: String,
    pub source_url: String,
    pub source_label: String,
    pub format: String,
    pub approved_excerpt: String,
    pub fetched_at: String,
    pub version: u32,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoadmapPreview {
    pub institution_id: String,
    pub program: String,
    pub catalog_year: String,
    pub source_url: String,
    pub source_label: String,
    pub format: String,
    pub excerpt: String,
    pub fetched_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadmapDiscoveryMatch {
    pub program: String,
    pub degree: String,
    pub catalog_year: String,
    pub source_url: String,
    pub institution_id: String,
}

trait RoadmapDiscoveryAdapter {
    fn discover(&self, program: &str, catalog_year: &str) -> Result<Vec<RoadmapDiscoveryMatch>>;
}

struct AsuDegreeSearchAdapter;

fn valid_catalog_year(value: &str) -> bool {
    value.len() == 4 && value.chars().all(|character| character.is_ascii_digit())
}

fn parse_asu_programs(raw: &str, program: &str, catalog_year: &str) -> Result<Vec<RoadmapDiscoveryMatch>> {
    let data: serde_json::Value = serde_json::from_str(raw).map_err(|_| AppError::Background("ASU Degree Search returned unreadable program data".into()))?;
    let programs = data.get("programs").and_then(serde_json::Value::as_array).ok_or_else(|| AppError::Background("ASU Degree Search returned no program list".into()))?;
    let query = program.to_ascii_lowercase();
    let mut matches = programs.iter().filter_map(|item| {
        let name = item.get("Descr100")?.as_str()?;
        let degree = item.get("Degree")?.as_str()?;
        let college = item.get("CollegeAcadOrg")?.as_str()?;
        let plan = item.get("AcadPlan")?.as_str()?;
        if !name.to_ascii_lowercase().contains(&query) || ![college, plan].iter().all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric())) { return None; }
        Some(RoadmapDiscoveryMatch { program: format!("{name}, {degree}"), degree: degree.into(), catalog_year: catalog_year.into(), source_url: format!("https://degrees.asu.edu/checksheet/{catalog_year}/{college}/{plan}/null"), institution_id: "104151".into() })
    }).collect::<Vec<_>>();
    matches.sort_by_key(|item| (!item.program.to_ascii_lowercase().starts_with(&query), item.program.len()));
    matches.dedup_by(|a, b| a.source_url == b.source_url);
    matches.truncate(12);
    Ok(matches)
}

impl RoadmapDiscoveryAdapter for AsuDegreeSearchAdapter {
    fn discover(&self, program: &str, catalog_year: &str) -> Result<Vec<RoadmapDiscoveryMatch>> {
        if program.trim().len() < 3 || program.len() > 160 || !valid_catalog_year(catalog_year) {
            return Err(AppError::Invalid("Enter at least three program letters and a four-digit catalog year".into()));
        }
        // This fixed, public endpoint is documented by ASU's Degree Search WordPress plugin.
        const INDEX: &str = "https://degrees.asu.edu/t5/service?method=findAllDegrees&init=false&fields=Descr100,Degree,CollegeAcadOrg,AcadPlan,AcadProg&cert=false&program=undergrad";
        let client = reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(15)).redirect(reqwest::redirect::Policy::none()).build().map_err(|_| AppError::Background("ASU Degree Search connection could not be prepared".into()))?;
        let response = client.get(INDEX).send().map_err(|_| AppError::Background("ASU Degree Search is unavailable; paste a roadmap link or upload a file".into()))?;
        if !response.status().is_success() || response.content_length().is_some_and(|size| size > 2 * 1024 * 1024) {
            return Err(AppError::Background("ASU Degree Search is unavailable or returned too much data".into()));
        }
        let bytes = response.bytes().map_err(|_| AppError::Background("ASU Degree Search could not be read".into()))?;
        if bytes.len() > 2 * 1024 * 1024 { return Err(AppError::Background("ASU Degree Search returned too much data".into())); }
        parse_asu_programs(std::str::from_utf8(&bytes).map_err(|_| AppError::Background("ASU Degree Search response was not text".into()))?, program.trim(), catalog_year)
    }
}

pub fn discover_asu_roadmaps(program: &str, catalog_year: &str) -> Result<Vec<RoadmapDiscoveryMatch>> {
    AsuDegreeSearchAdapter.discover(program, catalog_year)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisFinding {
    pub title: String,
    pub detail: String,
    pub evidence_ids: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisReport {
    pub id: String,
    pub scenario_key: String,
    pub input_fingerprint: String,
    pub generated_at: String,
    pub facts_json: String,
    pub ai_findings: Vec<AnalysisFinding>,
    pub provider: String,
    pub model: String,
    pub version: u32,
}

fn load<T: serde::de::DeserializeOwned + Default>(conn: &Connection, key: &str) -> Result<T> {
    let raw: Option<String> = conn.query_row("SELECT value FROM settings WHERE key=?1", [key], |row| row.get(0)).optional()?;
    raw.map(|value| serde_json::from_str(&value).map_err(|_| AppError::Invalid(format!("Saved {key} could not be read")))).unwrap_or_else(|| Ok(T::default()))
}

fn store<T: Serialize>(conn: &Connection, key: &str, value: &T) -> Result<()> {
    let raw = serde_json::to_string(value).map_err(|_| AppError::Invalid("Planner data could not be saved".into()))?;
    conn.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, raw])?;
    Ok(())
}

pub fn profile(conn: &Connection) -> Result<PlannerProfile> { load(conn, PROFILE_KEY) }

pub fn save_profile(conn: &Connection, mut next: PlannerProfile) -> Result<PlannerProfile> {
    let old = profile(conn)?;
    if next.version != old.version || next.program.len() > 160 || next.catalog_year.len() > 20 || next.study_goals.len() > 2000 || next.career_interests.len() > 2000 || next.constraints.len() > 2000 {
        return Err(AppError::Invalid("Planner profile is too long or has changed; reopen it before saving".into()));
    }
    next.version += 1;
    store(conn, PROFILE_KEY, &next)?;
    Ok(next)
}

pub fn roadmaps(conn: &Connection) -> Result<Vec<RoadmapEvidence>> { load(conn, ROADMAPS_KEY) }

pub fn save_roadmap(conn: &Connection, preview: RoadmapPreview) -> Result<Vec<RoadmapEvidence>> {
    if preview.program.trim().is_empty() || preview.program.len() > 160 || preview.catalog_year.len() > 20 || preview.excerpt.trim().len() < 20 || preview.excerpt.len() > 12_000 || preview.source_label.len() > 200 || preview.source_url.len() > 2000 || !matches!(preview.format.as_str(), "sequenced_major_map" | "unsequenced_checksheet" | "unknown") {
        return Err(AppError::Invalid("Review a valid roadmap excerpt before saving".into()));
    }
    if preview.source_label == "ASU Degree Search" {
        let url = reqwest::Url::parse(&preview.source_url).map_err(|_| AppError::Invalid("Official roadmap source URL is invalid".into()))?;
        if preview.institution_id != "104151" || url.scheme() != "https" || !matches!(url.host_str(), Some("degrees.asu.edu" | "degrees.apps.asu.edu")) || !url.path().split('/').any(|part| part == preview.catalog_year) {
            return Err(AppError::Invalid("ASU roadmap source and catalog year do not match".into()));
        }
    } else if !preview.source_url.is_empty() && !preview.source_url.starts_with("https://") {
        return Err(AppError::Invalid("Roadmap links must use HTTPS".into()));
    }
    let mut records = roadmaps(conn)?;
    if records.len() >= 20 { return Err(AppError::Invalid("Remove an old roadmap before adding another".into())); }
    records.push(RoadmapEvidence { id: Uuid::new_v4().to_string(), institution_id: preview.institution_id, program: preview.program, catalog_year: preview.catalog_year, source_url: preview.source_url, source_label: preview.source_label, format: preview.format, approved_excerpt: preview.excerpt, fetched_at: preview.fetched_at, version: 1 });
    store(conn, ROADMAPS_KEY, &records)?;
    Ok(records)
}

pub fn reports(conn: &Connection) -> Result<Vec<AnalysisReport>> { load(conn, REPORTS_KEY) }

pub fn save_report(conn: &Connection, mut report: AnalysisReport) -> Result<Vec<AnalysisReport>> {
    if report.scenario_key.trim().is_empty() || report.scenario_key.len() > 100 || report.input_fingerprint.len() != 64 || report.facts_json.len() > 60_000 || serde_json::from_str::<serde_json::Value>(&report.facts_json).is_err() || report.ai_findings.len() > 8 || report.ai_findings.iter().any(|finding| finding.title.len() > 160 || finding.detail.len() > 1500 || finding.evidence_ids.len() > 12) {
        return Err(AppError::Invalid("Analysis report is invalid".into()));
    }
    let mut records = reports(conn)?;
    if report.id.is_empty() { report.id = Uuid::new_v4().to_string(); }
    if let Some(index) = records.iter().position(|existing| existing.id == report.id) {
        if records[index].version != report.version { return Err(AppError::Invalid("Report changed; reopen it before saving".into())); }
        report.version += 1; records[index] = report;
    } else {
        if report.version != 0 { return Err(AppError::Invalid("New report version is invalid".into())); }
        report.version = 1; records.push(report);
    }
    records.sort_by(|a, b| b.generated_at.cmp(&a.generated_at));
    records.truncate(30);
    store(conn, REPORTS_KEY, &records)?;
    Ok(records)
}

pub fn preview_file(bytes: &[u8], file_name: &str, program: &str, catalog_year: &str, institution_id: &str, ocr: &imports::OcrRuntime) -> Result<RoadmapPreview> {
    if bytes.len() > 25 * 1024 * 1024 { return Err(AppError::Invalid("Roadmap file must be 25 MB or smaller".into())); }
    let kind = imports::detect_document(bytes, file_name).map_err(|error| AppError::Extract(error.to_string()))?;
    if !matches!(kind, imports::DocumentKind::Pdf | imports::DocumentKind::Image("image/png" | "image/jpeg")) { return Err(AppError::Invalid("Use a PDF, PNG, or JPEG roadmap".into())); }
    let result = imports::extract_document(imports::DocumentSource::Bytes, bytes, file_name, "UTC", ocr, &[], &[]).map_err(|error| AppError::Extract(error.to_string()))?;
    let excerpt = result.segments.into_iter().map(|segment| segment.text).collect::<Vec<_>>().join("\n").chars().take(12_000).collect::<String>();
    if excerpt.trim().len() < 20 { return Err(AppError::Invalid("No readable roadmap text was found; use a clearer image or paste an official link".into())); }
    Ok(RoadmapPreview { institution_id: institution_id.into(), program: program.into(), catalog_year: catalog_year.into(), source_url: String::new(), source_label: file_name.into(), format: "unknown".into(), excerpt, fetched_at: chrono::Utc::now().to_rfc3339() })
}

pub fn preview_asu_url(raw_url: &str, program: &str, catalog_year: &str) -> Result<RoadmapPreview> {
    let url = reqwest::Url::parse(raw_url).map_err(|_| AppError::Invalid("Enter a valid ASU degree URL".into()))?;
    if url.scheme() != "https" || !matches!(url.host_str(), Some("degrees.asu.edu" | "degrees.apps.asu.edu")) || !["/checksheet/", "/major-map/", "/bachelors/major/"].iter().any(|prefix| url.path().starts_with(prefix)) || !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
        return Err(AppError::Invalid("Use an official ASU Degree Search roadmap URL".into()));
    }
    if program.trim().len() < 3 || program.len() > 160 || catalog_year.len() != 4 || !catalog_year.chars().all(|character| character.is_ascii_digit()) {
        return Err(AppError::Invalid("Choose a program and four-digit catalog year".into()));
    }
    let year_in_url = url.path().split('/').find(|part| part.len() == 4 && part.chars().all(|character| character.is_ascii_digit()));
    if year_in_url.is_some_and(|year| year != catalog_year) {
        return Err(AppError::Invalid("This ASU page is for a different catalog year".into()));
    }
    let client = reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(15)).redirect(reqwest::redirect::Policy::none()).build().map_err(|_| AppError::Background("Roadmap connection could not be prepared".into()))?;
    let response = client.get(url.clone()).send().map_err(|_| AppError::Background("ASU roadmap could not be reached; use a saved PDF instead".into()))?;
    if !response.status().is_success() { return Err(AppError::Background("ASU roadmap is unavailable; verify the URL".into())); }
    if response.content_length().is_some_and(|size| size > 2 * 1024 * 1024) { return Err(AppError::Invalid("ASU roadmap page is too large".into())); }
    let bytes = response.bytes().map_err(|_| AppError::Background("ASU roadmap could not be read".into()))?;
    if bytes.len() > 2 * 1024 * 1024 { return Err(AppError::Invalid("ASU roadmap page is too large".into())); }
    let html = std::str::from_utf8(&bytes).map_err(|_| AppError::Invalid("ASU roadmap page was not readable".into()))?;
    let without_scripts = regex::Regex::new("(?is)<(script|style)[^>]*>.*?</(script|style)>").unwrap().replace_all(html, " ");
    let text = regex::Regex::new("(?is)<[^>]+>").unwrap().replace_all(&without_scripts, "\n")
        .replace("&nbsp;", " ").replace("&amp;", "&").replace("&#39;", "'");
    let lines = text.lines().map(str::trim).filter(|line| !line.is_empty()).collect::<Vec<_>>().join("\n");
    if !lines.to_ascii_lowercase().contains(&program.trim().to_ascii_lowercase()) { return Err(AppError::Invalid("The program name was not found on this ASU page; check the selected degree".into())); }
    let format = if url.path().contains("/major-map/") { "sequenced_major_map" } else if url.path().contains("/checksheet/") { "unsequenced_checksheet" } else { "unknown" };
    Ok(RoadmapPreview { institution_id: "104151".into(), program: program.trim().into(), catalog_year: catalog_year.into(), source_url: url.into(), source_label: "ASU Degree Search".into(), format: format.into(), excerpt: lines.chars().take(12_000).collect(), fetched_at: chrono::Utc::now().to_rfc3339() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection { let db = Connection::open_in_memory().unwrap(); db.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)").unwrap(); db }

    #[test]
    fn profile_and_roadmap_are_local_versioned_records() {
        let db = db();
        let mut profile = PlannerProfile { program: "Computer Science, BS".into(), catalog_year: "2026".into(), ..Default::default() };
        profile = save_profile(&db, profile).unwrap();
        assert_eq!(profile.version, 1);
        assert!(save_profile(&db, PlannerProfile { version: 0, ..profile.clone() }).is_err());
        let roadmaps = save_roadmap(&db, RoadmapPreview { institution_id: "104151".into(), program: profile.program, catalog_year: profile.catalog_year, source_url: "https://degrees.asu.edu/checksheet/2026/CES/ESCSEBS/null".into(), source_label: "ASU Degree Search".into(), format: "unsequenced_checksheet".into(), excerpt: "CSE 110 Principles of Programming is required.".into(), fetched_at: "2026-09-23T00:00:00Z".into() }).unwrap();
        assert_eq!(roadmaps.len(), 1);
        assert_eq!(roadmaps[0].version, 1);
        assert_eq!(roadmaps[0].format, "unsequenced_checksheet");
    }

    #[test]
    fn rejects_unapproved_roadmap_hosts_and_catalog_year_mismatch_before_network() {
        assert!(preview_asu_url("https://evil.example/checksheet/2026/CES/ESCSEBS/null", "Computer Science", "2026").is_err());
        assert!(preview_asu_url("https://degrees.asu.edu/checksheet/2025/CES/ESCSEBS/null", "Computer Science", "2026").is_err());
        assert!(preview_asu_url("http://degrees.asu.edu/checksheet/2026/CES/ESCSEBS/null", "Computer Science", "2026").is_err());
    }

    #[test]
    fn official_discovery_matches_program_and_builds_selected_year_url() {
        let raw = r#"{"programs":[{"Descr100":"Computer Science","Degree":"BS","CollegeAcadOrg":"CES","AcadPlan":"ESCSEBS"},{"Descr100":"Biology","Degree":"BS","CollegeAcadOrg":"CLA","AcadPlan":"LABIOBS"}]}"#;
        let found = parse_asu_programs(raw, "computer science", "2026").unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].source_url, "https://degrees.asu.edu/checksheet/2026/CES/ESCSEBS/null");
    }

    #[test]
    fn reports_survive_reload_and_reject_stale_versions() {
        let db = db();
        let report = AnalysisReport { id: String::new(), scenario_key: "current:term".into(), input_fingerprint: "a".repeat(64), generated_at: "2026-09-23T00:00:00Z".into(), facts_json: "{}".into(), ai_findings: Vec::new(), provider: String::new(), model: String::new(), version: 0 };
        let saved = save_report(&db, report).unwrap();
        assert_eq!(reports(&db).unwrap()[0].id, saved[0].id);
        assert!(save_report(&db, AnalysisReport { version: 0, ..saved[0].clone() }).is_err());
    }
}
