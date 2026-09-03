use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum InterfaceMode { Comfy, Compact }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ModeThemes { pub comfy: String, pub compact: String }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct InterfacePreferences { pub mode: InterfaceMode, pub themes: ModeThemes }

fn valid_theme(theme: &str) -> bool {
    matches!(theme, "system" | "light" | "coqui-dark" | "midnight" | "graphite" | "forest")
}

pub fn load(conn: &Connection, legacy_mode: InterfaceMode) -> crate::Result<InterfacePreferences> {
    let raw: Option<String> = conn.query_row("SELECT value FROM settings WHERE key='interface_preferences_v1'", [], |r| r.get(0)).optional()?;
    if let Some(raw) = raw {
        let value: InterfacePreferences = serde_json::from_str(&raw)
            .map_err(|_| crate::AppError::Invalid("Stored interface preferences need recovery".into()))?;
        validate(&value)?;
        return Ok(value);
    }
    let legacy: Option<String> = conn.query_row("SELECT value FROM settings WHERE key='appearance'", [], |r| r.get(0)).optional()?;
    let mut themes = ModeThemes { comfy: "light".into(), compact: "coqui-dark".into() };
    if let Some(theme) = legacy {
        let theme = if theme == "dark" { "coqui-dark".to_owned() } else { theme };
        if valid_theme(&theme) { match legacy_mode { InterfaceMode::Comfy => themes.comfy = theme, InterfaceMode::Compact => themes.compact = theme } }
    }
    Ok(InterfacePreferences { mode: legacy_mode, themes })
}

fn validate(value: &InterfacePreferences) -> crate::Result<()> {
    if !valid_theme(&value.themes.comfy) || !valid_theme(&value.themes.compact) {
        return Err(crate::AppError::Invalid("Choose a supported color theme".into()));
    }
    Ok(())
}

pub fn save(conn: &Connection, value: &InterfacePreferences) -> crate::Result<()> {
    validate(value)?;
    let raw = serde_json::to_string(value).map_err(|_| crate::AppError::Invalid("Interface preferences could not be saved".into()))?;
    let tx = conn.unchecked_transaction()?;
    tx.execute("INSERT INTO settings(key,value) VALUES('interface_preferences_v1',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![raw])?;
    let theme = match value.mode { InterfaceMode::Comfy => &value.themes.comfy, InterfaceMode::Compact => &value.themes.compact };
    tx.execute("INSERT INTO settings(key,value) VALUES('appearance',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![theme])?;
    tx.commit()?;
    // Device-local settings are in encrypted backups, never the replicated mutation log.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)").unwrap(); c
    }
    #[test]
    fn defaults_and_legacy_preferences_are_preserved() {
        let c = db(); let default = load(&c, InterfaceMode::Comfy).unwrap();
        assert_eq!(default.themes.comfy, "light"); assert_eq!(default.themes.compact, "coqui-dark");
        c.execute("INSERT INTO settings VALUES('appearance','forest')", []).unwrap();
        assert_eq!(load(&c, InterfaceMode::Compact).unwrap().themes.compact, "forest");
    }
    #[test]
    fn mode_themes_round_trip_and_invalid_values_do_not_write() {
        let c = db(); let mut p = load(&c, InterfaceMode::Comfy).unwrap();
        p.mode = InterfaceMode::Compact; p.themes.comfy = "system".into(); save(&c, &p).unwrap();
        assert_eq!(load(&c, InterfaceMode::Comfy).unwrap(), p);
        p.themes.compact = "invalid".into(); assert!(save(&c, &p).is_err());
        assert_eq!(load(&c, InterfaceMode::Compact).unwrap().themes.compact, "coqui-dark");
    }
}
