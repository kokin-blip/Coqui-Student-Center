use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

use crate::{AppError, Result};

const KEY: &str = "semester_scenarios_v1";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemesterScenarioSection {
    pub id: String,
    pub course_id: String,
    #[serde(default)]
    pub imported_course_label: Option<String>,
    pub instructor_id: Option<String>,
    #[serde(default)]
    pub professor_record_id: Option<String>,
    #[serde(default)]
    pub catalog_section_line_number: Option<String>,
    pub weekdays: Vec<u32>,
    pub starts_at_local: String,
    pub ends_at_local: String,
    pub location: String,
    pub modality: String,
    #[serde(default = "default_rotation_interval")]
    pub rotation_interval_weeks: u32,
    #[serde(default)]
    pub rotation_offset_weeks: u32,
    pub source_meeting_id: Option<String>,
}

fn default_rotation_interval() -> u32 { 1 }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemesterScenario {
    pub id: String,
    pub term_id: String,
    pub name: String,
    pub sections: Vec<SemesterScenarioSection>,
    pub version: u32,
}

pub fn load(conn: &Connection) -> Result<Vec<SemesterScenario>> {
    let raw: Option<String> = conn.query_row("SELECT value FROM settings WHERE key=?1", [KEY], |row| row.get(0)).optional()?;
    match raw {
        Some(raw) => serde_json::from_str(&raw).map_err(|_| AppError::Invalid("Saved semester scenarios could not be read".into())),
        None => Ok(Vec::new()),
    }
}

fn valid_clock(value: &str) -> Option<u32> {
    let (hour, minute) = value.split_once(':')?;
    if hour.len() != 2 || minute.len() != 2 { return None; }
    let hour = hour.parse::<u32>().ok()?;
    let minute = minute.parse::<u32>().ok()?;
    (hour < 24 && minute < 60).then_some(hour * 60 + minute)
}

fn exists(conn: &Connection, query: &str, first: &str, second: Option<&str>) -> Result<bool> {
    let found = if let Some(second) = second {
        conn.query_row(query, params![first, second], |row| row.get::<_, i64>(0))?
    } else {
        conn.query_row(query, [first], |row| row.get::<_, i64>(0))?
    };
    Ok(found != 0)
}

fn validate(conn: &Connection, scenario: &SemesterScenario, catalog_professors: &HashMap<String, String>, catalog_sections: &HashMap<String, String>) -> Result<()> {
    if uuid::Uuid::parse_str(&scenario.id).is_err() || scenario.name.trim().is_empty() || scenario.name.trim().len() > 80 || scenario.name != scenario.name.trim() || scenario.sections.len() > 80 {
        return Err(AppError::Invalid("Scenario name or size is invalid".into()));
    }
    if !exists(conn, "SELECT EXISTS(SELECT 1 FROM academic_terms WHERE id=?1)", &scenario.term_id, None)? {
        return Err(AppError::Invalid("The selected academic term no longer exists".into()));
    }
    let mut ids = HashSet::new();
    for section in &scenario.sections {
        let start = valid_clock(&section.starts_at_local);
        let end = valid_clock(&section.ends_at_local);
        let mut days = HashSet::new();
        if uuid::Uuid::parse_str(&section.id).is_err() || !ids.insert(&section.id)
            || section.weekdays.is_empty() || section.weekdays.iter().any(|day| *day > 6 || !days.insert(day))
            || start.zip(end).is_none_or(|(start, end)| start >= end)
            || section.location.len() > 160 || section.imported_course_label.as_ref().is_some_and(|label| label.len() > 160) || !matches!(section.modality.as_str(), "in_person" | "online" | "hybrid" | "unknown")
            || !(1..=8).contains(&section.rotation_interval_weeks) || section.rotation_offset_weeks >= section.rotation_interval_weeks {
            return Err(AppError::Invalid("A scenario section has invalid days, times, or details".into()));
        }
        if !exists(conn, "SELECT EXISTS(SELECT 1 FROM courses WHERE id=?1 AND (term_id IS NULL OR term_id=?2))", &section.course_id, Some(&scenario.term_id))? {
            return Err(AppError::Invalid("A scenario course no longer belongs to this term".into()));
        }
        if let Some(instructor_id) = &section.instructor_id {
            if !exists(conn, "SELECT EXISTS(SELECT 1 FROM instructors WHERE id=?1 AND course_id=?2)", instructor_id, Some(&section.course_id))? {
                return Err(AppError::Invalid("A scenario instructor no longer belongs to this course".into()));
            }
        }
        if section.instructor_id.is_some() && section.professor_record_id.is_some() {
            return Err(AppError::Invalid("Choose one instructor source for a scenario section".into()));
        }
        if let Some(professor_id) = &section.professor_record_id {
            if catalog_professors.get(professor_id) != Some(&section.course_id) {
                return Err(AppError::Invalid("This catalog instructor is no longer listed for the selected course".into()));
            }
        }
        if let Some(line_number) = &section.catalog_section_line_number {
            if catalog_sections.get(&format!("{}|{}", section.course_id, line_number)) != Some(&section.course_id) {
                return Err(AppError::Invalid("This catalog section is no longer listed for the selected course and term".into()));
            }
        }
    }
    Ok(())
}

pub fn upsert(conn: &Connection, mut scenario: SemesterScenario, catalog_professors: &HashMap<String, String>, catalog_sections: &HashMap<String, String>) -> Result<Vec<SemesterScenario>> {
    validate(conn, &scenario, catalog_professors, catalog_sections)?;
    let mut scenarios = load(conn)?;
    if let Some(index) = scenarios.iter().position(|item| item.id == scenario.id) {
        if scenarios[index].version != scenario.version { return Err(AppError::Invalid("This scenario changed elsewhere; reopen it before saving".into())); }
        scenario.version += 1;
        scenarios[index] = scenario;
    } else {
        if scenario.version != 0 || scenarios.len() >= 30 { return Err(AppError::Invalid("Too many scenarios or an invalid new scenario version".into())); }
        scenario.version = 1;
        scenarios.push(scenario);
    }
    persist(conn, &scenarios)?;
    Ok(scenarios)
}

pub fn delete(conn: &Connection, id: &str, expected_version: u32) -> Result<Vec<SemesterScenario>> {
    let mut scenarios = load(conn)?;
    let index = scenarios.iter().position(|item| item.id == id && item.version == expected_version)
        .ok_or_else(|| AppError::Invalid("This scenario changed or was removed; reopen it before deleting".into()))?;
    scenarios.remove(index);
    persist(conn, &scenarios)?;
    Ok(scenarios)
}

fn persist(conn: &Connection, scenarios: &[SemesterScenario]) -> Result<()> {
    let raw = serde_json::to_string(scenarios).map_err(|_| AppError::Invalid("Scenario could not be saved".into()))?;
    conn.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![KEY, raw])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_drafts_and_rejects_stale_or_invalid_sections() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE academic_terms(id TEXT PRIMARY KEY); CREATE TABLE courses(id TEXT PRIMARY KEY,term_id TEXT); CREATE TABLE instructors(id TEXT PRIMARY KEY,course_id TEXT); INSERT INTO academic_terms VALUES('term'); INSERT INTO courses VALUES('course','term');").unwrap();
        let mut scenario = SemesterScenario { id: uuid::Uuid::new_v4().to_string(), term_id: "term".into(), name: "Earlier classes".into(), sections: vec![SemesterScenarioSection { id: uuid::Uuid::new_v4().to_string(), course_id: "course".into(), imported_course_label: None, instructor_id: None, professor_record_id: None, catalog_section_line_number: None, weekdays: vec![1,3], starts_at_local: "09:00".into(), ends_at_local: "10:15".into(), location: "Campus".into(), modality: "in_person".into(), rotation_interval_weeks: 1, rotation_offset_weeks: 0, source_meeting_id: None }], version: 0 };
        let professors = HashMap::from([("catalog:one".to_string(), "course".to_string())]);
        let sections = HashMap::from([("course|123".to_string(), "course".to_string())]);
        assert_eq!(upsert(&conn, scenario.clone(), &professors, &sections).unwrap()[0].version, 1);
        assert!(upsert(&conn, scenario.clone(), &professors, &sections).is_err());
        scenario.version = 1;
        scenario.sections[0].ends_at_local = "08:00".into();
        assert!(upsert(&conn, scenario.clone(), &professors, &sections).is_err());
        scenario.sections[0].ends_at_local = "10:15".into();
        scenario.sections[0].weekdays = vec![1,1];
        assert!(upsert(&conn, scenario.clone(), &professors, &sections).is_err());
        scenario.sections[0].weekdays = vec![1,3];
        scenario.sections[0].rotation_interval_weeks = 2;
        scenario.sections[0].rotation_offset_weeks = 2;
        assert!(upsert(&conn, scenario.clone(), &professors, &sections).is_err());
        scenario.sections[0].rotation_interval_weeks = 1;
        scenario.sections[0].rotation_offset_weeks = 0;
        scenario.sections[0].professor_record_id = Some("catalog:other".into());
        assert!(upsert(&conn, scenario.clone(), &professors, &sections).is_err());
        scenario.sections[0].professor_record_id = Some("catalog:one".into());
        assert!(upsert(&conn, scenario.clone(), &HashMap::from([("catalog:one".to_string(), "other-course".to_string())]), &sections).is_err());
        scenario.sections[0].catalog_section_line_number = Some("missing".into());
        assert!(upsert(&conn, scenario.clone(), &professors, &sections).is_err());
        scenario.sections[0].catalog_section_line_number = Some("123".into());
        assert_eq!(upsert(&conn, scenario.clone(), &professors, &sections).unwrap()[0].version, 2);
        scenario.version = 2;
        scenario.sections[0].instructor_id = Some("local".into());
        assert!(upsert(&conn, scenario.clone(), &professors, &sections).is_err());
        assert!(delete(&conn, &scenario.id, 1).is_err());
        assert!(delete(&conn, &scenario.id, 2).unwrap().is_empty());
    }

    #[test]
    fn older_scenarios_default_to_every_week() {
        let section: SemesterScenarioSection = serde_json::from_str(r#"{"id":"a","courseId":"b","instructorId":null,"weekdays":[1],"startsAtLocal":"09:00","endsAtLocal":"10:00","location":"","modality":"online","sourceMeetingId":null}"#).unwrap();
        assert_eq!((section.rotation_interval_weeks, section.rotation_offset_weeks), (1, 0));
    }
}
