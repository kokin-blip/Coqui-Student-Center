use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelightPreferences {
    pub interface_sounds: bool,
    pub completion_sounds: bool,
    pub reminder_sounds: bool,
    pub volume: f64,
    pub celebrations: bool,
    pub momentum_display: bool,
    #[serde(default)]
    pub weekly_goal_tasks: u8,
    #[serde(default)]
    pub last_weekly_goal_week: String,
}

impl Default for DelightPreferences {
    fn default() -> Self { Self { interface_sounds:false, completion_sounds:false, reminder_sounds:false, volume:0.55, celebrations:true, momentum_display:true, weekly_goal_tasks:0, last_weekly_goal_week:String::new() } }
}

fn validate(value:&DelightPreferences)->crate::Result<()> {
    if !value.volume.is_finite() || !(0.0..=1.0).contains(&value.volume) { return Err(crate::AppError::Invalid("Sound volume must be between 0 and 100 percent".into())); }
    if value.weekly_goal_tasks > 20 || (!value.last_weekly_goal_week.is_empty() && chrono::NaiveDate::parse_from_str(&value.last_weekly_goal_week,"%Y-%m-%d").is_err()) { return Err(crate::AppError::Invalid("Weekly goal settings are invalid".into())); }
    Ok(())
}
pub fn load(conn:&Connection)->crate::Result<DelightPreferences>{
    let raw:Option<String>=conn.query_row("SELECT value FROM settings WHERE key='delight_preferences_v1'",[],|row|row.get(0)).optional()?;
    let value=raw.and_then(|raw|serde_json::from_str(&raw).ok()).unwrap_or_default(); validate(&value)?; Ok(value)
}
pub fn save(conn:&Connection,value:&DelightPreferences)->crate::Result<()> { validate(value)?; let raw=serde_json::to_string(value).map_err(|_|crate::AppError::Invalid("Delight preferences could not be saved".into()))?; conn.execute("INSERT INTO settings(key,value) VALUES('delight_preferences_v1',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![raw])?; Ok(()) }

pub fn reminder_sound_name(enabled: bool) -> Option<&'static str> {
    if !enabled { return None; }
    #[cfg(target_os = "macos")]
    { return Some("NSUserNotificationDefaultSoundName"); }
    #[cfg(target_os = "windows")]
    { return Some("Reminder"); }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reminder_audio_is_off_until_explicitly_enabled() {
        assert!(!DelightPreferences::default().reminder_sounds);
        assert_eq!(reminder_sound_name(false), None);
        #[cfg(target_os = "macos")]
        assert_eq!(reminder_sound_name(true), Some("NSUserNotificationDefaultSoundName"));
        #[cfg(target_os = "windows")]
        assert_eq!(reminder_sound_name(true), Some("Reminder"));
        let directory = tempfile::tempdir().unwrap();
        let conn = crate::open_database(&directory.path().join("delight.db"), &crate::random_key()).unwrap();
        assert!(!load(&conn).unwrap().reminder_sounds);
        let enabled = DelightPreferences { reminder_sounds: true, ..DelightPreferences::default() };
        save(&conn, &enabled).unwrap();
        assert!(load(&conn).unwrap().reminder_sounds);
    }

    #[test]
    fn older_preferences_keep_weekly_goals_off_and_goal_state_round_trips() {
        let legacy = r#"{"interfaceSounds":false,"completionSounds":false,"reminderSounds":false,"volume":0.55,"celebrations":true,"momentumDisplay":true}"#;
        let old: DelightPreferences = serde_json::from_str(legacy).unwrap();
        assert_eq!(old.weekly_goal_tasks, 0);
        assert!(old.last_weekly_goal_week.is_empty());
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)").unwrap();
        let enabled = DelightPreferences { weekly_goal_tasks:5, last_weekly_goal_week:"2026-09-21".into(), ..old };
        save(&conn,&enabled).unwrap();
        let loaded = load(&conn).unwrap();
        assert_eq!(loaded.weekly_goal_tasks, 5);
        assert_eq!(loaded.last_weekly_goal_week, "2026-09-21");
        assert!(save(&conn,&DelightPreferences { weekly_goal_tasks:21, ..loaded }).is_err());
    }
}
