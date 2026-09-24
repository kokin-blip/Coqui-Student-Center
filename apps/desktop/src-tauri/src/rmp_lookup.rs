//! Local lookup adapted from ASU ProfessorView's campus/name search pattern.
//! https://github.com/joshuamanigault/ASUProfessorView (Apache-2.0).
use chrono::Utc;
use reqwest::blocking::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::{professor_ratings::ProfessorRatingSummary, AppError, ProfessorRecord, Result};

const ENDPOINT: &str = "https://www.ratemyprofessors.com/graphql";
const CAMPUSES: [&str; 3] = ["Arizona State University", "Arizona State University - Polytechnic Campus", "Arizona State University - West"];
const SCHOOL_QUERY: &str = "query($query: SchoolSearchQuery!) { newSearch { schools(query: $query) { edges { node { id name } } } } }";
const TEACHER_QUERY: &str = "query($query: TeacherSearchQuery!) { newSearch { teachers(query: $query, first: 8) { edges { node { firstName lastName avgRating numRatings legacyId school { id name } } } } } }";
const TEN_MINUTES: i64 = 10 * 60;
static RATE_GATE: OnceLock<Mutex<(Instant, Option<Instant>)>> = OnceLock::new();
static SCHOOL_CACHE: OnceLock<Mutex<Option<(Instant, Vec<(String, String)>)>>> = OnceLock::new();

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedRating { expires_at: i64, rating: Option<ProfessorRatingSummary> }

fn normalized(name: &str) -> String { name.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase() }

fn name_variants(name: &str) -> Vec<String> {
    let normalized_name = name.trim().split_whitespace().collect::<Vec<_>>().join(" ").replace('-', " ");
    let parts = normalized_name.split_whitespace().collect::<Vec<_>>();
    if parts.len() < 2 { return vec![normalized_name]; }
    let mut names = vec![normalized_name.clone(), format!("{} {}", parts[0], parts[parts.len() - 1])];
    if parts.len() == 3 { names.push(format!("{} {}-{}", parts[0], parts[1], parts[2])); }
    names.dedup();
    names
}

fn cache_key(professor: &ProfessorRecord) -> String {
    let digest = Sha256::digest(format!("{}|{}|{}", professor.institution_id, normalized(&professor.name), professor.source.campus_id.to_lowercase()).as_bytes());
    format!("professor_rmp_v1:{}", hex::encode(digest))
}

pub fn cached(conn: &Connection, professor: &ProfessorRecord) -> Result<Option<Option<ProfessorRatingSummary>>> {
    let key = cache_key(professor);
    let raw: Option<String> = conn.query_row("SELECT value FROM settings WHERE key=?1", [&key], |row| row.get(0)).optional()?;
    let Some(raw) = raw else { return Ok(None); };
    let Some(entry) = serde_json::from_str::<CachedRating>(&raw).ok().filter(|item| item.expires_at > Utc::now().timestamp()) else {
        conn.execute("DELETE FROM settings WHERE key=?1", [&key])?;
        return Ok(None);
    };
    Ok(Some(entry.rating))
}

pub fn cache(conn: &Connection, professor: &ProfessorRecord, rating: Option<ProfessorRatingSummary>) -> Result<()> {
    let key = cache_key(professor);
    let value = serde_json::to_string(&CachedRating { expires_at: Utc::now().timestamp() + TEN_MINUTES, rating }).map_err(|_| AppError::Background("Rating cache could not be encoded".into()))?;
    conn.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, value])?;
    Ok(())
}

fn post(client: &Client, query: &str, variables: Value) -> Result<Value> {
    {
        let mut gate = RATE_GATE.get_or_init(|| Mutex::new((Instant::now(), None))).lock().unwrap();
        if gate.1.is_some_and(|until| until > Instant::now()) { return Err(AppError::Background("Professor ratings are rate-limited; try again shortly".into())); }
        let now = Instant::now();
        if gate.0 > now { std::thread::sleep(gate.0.saturating_duration_since(now)); }
        gate.0 = Instant::now() + Duration::from_millis(500);
    }
    let response = client.post(ENDPOINT).header("Authorization", "Basic dGVzdDp0ZXN0")
        .json(&json!({"query":query,"variables":variables})).send()
        .map_err(|_| AppError::Background("Professor ratings could not be reached".into()))?;
    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        RATE_GATE.get().unwrap().lock().unwrap().1 = Some(Instant::now() + Duration::from_secs(60));
        return Err(AppError::Background("Professor ratings are rate-limited; try again shortly".into()));
    }
    if !response.status().is_success() { return Err(AppError::Background("Professor ratings are temporarily unavailable".into())); }
    if response.content_length().is_some_and(|size| size > 256 * 1024) { return Err(AppError::Background("Professor rating response was too large".into())); }
    let bytes = response.bytes().map_err(|_| AppError::Background("Professor rating response could not be read".into()))?;
    if bytes.len() > 256 * 1024 { return Err(AppError::Background("Professor rating response was too large".into())); }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| AppError::Background("Professor rating response was invalid".into()))?;
    if value.get("errors").is_some() { return Err(AppError::Background("Professor rating search returned an error".into())); }
    Ok(value)
}

fn school_ids(value: &Value) -> Vec<(String, String)> {
    value.pointer("/data/newSearch/schools/edges").and_then(Value::as_array).into_iter().flatten().filter_map(|item| {
        let name = item.pointer("/node/name")?.as_str()?;
        let id = item.pointer("/node/id")?.as_str()?;
        CAMPUSES.contains(&name).then(|| (name.to_owned(), id.to_owned()))
    }).collect()
}

fn cached_schools(client: &Client) -> Result<Vec<(String, String)>> {
    let cache = SCHOOL_CACHE.get_or_init(|| Mutex::new(None));
    if let Some((_, ids)) = cache.lock().unwrap().as_ref().filter(|(until, _)| *until > Instant::now()) { return Ok(ids.clone()); }
    let ids = school_ids(&post(client, SCHOOL_QUERY, json!({"query":{"text":"Arizona State University"}}))?);
    if ids.is_empty() { return Err(AppError::Background("ASU campus listings could not be found".into())); }
    *cache.lock().unwrap() = Some((Instant::now() + Duration::from_secs(60 * 60), ids.clone()));
    Ok(ids)
}

fn exact_match(value: &Value, searched_name: &str, school_id: &str) -> Option<ProfessorRatingSummary> {
    let edges = value.pointer("/data/newSearch/teachers/edges")?.as_array()?;
    let matches = edges.iter().filter_map(|edge| {
        let node = edge.get("node")?;
        let full = format!("{} {}", node.get("firstName")?.as_str()?, node.get("lastName")?.as_str()?);
        (normalized(&full) == normalized(searched_name) && node.pointer("/school/id")?.as_str()? == school_id).then_some(node)
    }).collect::<Vec<_>>();
    if matches.len() != 1 { return None; }
    let found = matches[0];
    let score = found.get("avgRating")?.as_f64()? as f32;
    let count = u32::try_from(found.get("numRatings")?.as_u64()?).ok()?;
    let legacy_id = found.get("legacyId")?.as_u64()?;
    if !(0.0..=5.0).contains(&score) || count == 0 { return None; }
    Some(ProfessorRatingSummary { value: score, review_count: count, source_url: format!("https://www.ratemyprofessors.com/professor/{legacy_id}"), updated_at: Utc::now().to_rfc3339(), bias_warning: "Student reviews are self-selected and may not represent every student's experience.".into() })
}

pub fn lookup(professor: &ProfessorRecord) -> Result<Option<ProfessorRatingSummary>> {
    if professor.institution_id != "104151" || professor.name.split_whitespace().count() < 2
        || ["staff", "to be announced", "tba"].contains(&professor.name.trim().to_lowercase().as_str()) { return Ok(None); }
    let client = Client::builder().timeout(std::time::Duration::from_secs(12)).redirect(reqwest::redirect::Policy::none()).build().map_err(|_| AppError::Background("Professor rating connection could not be prepared".into()))?;
    let schools = cached_schools(&client)?;
    let preferred = if professor.source.campus_id.to_lowercase().contains("poly") { CAMPUSES[1] }
        else if professor.source.campus_id.to_lowercase().contains("west") { CAMPUSES[2] }
        else { CAMPUSES[0] };
    let campus_order = std::iter::once(preferred).chain(CAMPUSES.into_iter().filter(|campus| *campus != preferred));
    for name in name_variants(&professor.name) {
        for campus in campus_order.clone() {
            let Some((_, school_id)) = schools.iter().find(|(found, _)| found == campus) else { continue; };
            let result = post(&client, TEACHER_QUERY, json!({"query":{"text":name,"schoolID":school_id,"fallback":true,"departmentID":null}}))?;
            if let Some(rating) = exact_match(&result, &name, school_id) { return Ok(Some(rating)); }
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_exact_teacher_and_school_not_first_fuzzy_result() {
        let response = json!({"data":{"newSearch":{"teachers":{"edges":[
            {"node":{"firstName":"Jane","lastName":"Smith","school":{"id":"wrong"},"avgRating":5,"numRatings":99,"legacyId":1}},
            {"node":{"firstName":"Jane","lastName":"Smith","school":{"id":"asu"},"avgRating":4.3,"numRatings":12,"legacyId":42}}
        ]}}}});
        let result = exact_match(&response, "Jane Smith", "asu").unwrap();
        assert_eq!(result.review_count, 12);
        assert!(result.source_url.ends_with("/42"));
        assert!(exact_match(&response, "John Smith", "asu").is_none());
    }

    #[test]
    fn tries_extension_style_name_variants() {
        assert_eq!(name_variants("Jane A Smith"), vec!["Jane A Smith", "Jane Smith", "Jane A-Smith"]);
    }

    #[test]
    fn caches_found_and_missing_results_for_ten_minutes() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)").unwrap();
        let professor = ProfessorRecord { id:"catalog:jane".into(), name:"Jane Smith".into(), institution_id:"104151".into(), course_id:"course".into(), course_code:"CSE 110".into(), email:String::new(), office_location:String::new(), office_hours:String::new(), rating:None, source:crate::ProfessorSourceSnapshot { kind:"official_course_catalog".into(), label:"ASU Class Search".into(), url:String::new(), term_label:String::new(), campus_id:"tempe".into(), section_numbers:vec![], captured_at:None } };
        assert!(cached(&db, &professor).unwrap().is_none());
        cache(&db, &professor, None).unwrap();
        assert!(matches!(cached(&db, &professor).unwrap(), Some(None)));
        let rating = ProfessorRatingSummary { value:4.3, review_count:12, source_url:"https://www.ratemyprofessors.com/professor/42".into(), updated_at:Utc::now().to_rfc3339(), bias_warning:String::new() };
        cache(&db, &professor, Some(rating)).unwrap();
        assert_eq!(cached(&db, &professor).unwrap().flatten().unwrap().review_count, 12);
    }
}
