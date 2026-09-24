use super::*;

#[derive(Debug, PartialEq, Eq)]
struct FundingAlert {
    opportunity_id: String,
    kind: &'static str,
    anchor: String,
    title: String,
}

fn candidates(conn: &Connection, now: DateTime<Utc>) -> Result<Vec<FundingAlert>> {
    let profile = scholarship_profile_in(conn)?;
    if profile.get("notificationsEnabled").and_then(|value| value.as_bool()) != Some(true) {
        return Ok(Vec::new());
    }
    let settings = notification_settings_from_db(conn, true);
    if in_quiet_hours(
        student_local_minutes(conn, now),
        parse_clock(&settings.quiet_start).unwrap_or(22 * 60),
        parse_clock(&settings.quiet_end).unwrap_or(7 * 60),
    ) {
        return Ok(Vec::new());
    }
    // Limit discovery bursts after a source refresh or a long time offline.
    let sent_today: i64 = conn.query_row(
        "SELECT COUNT(*) FROM funding_alert_deliveries WHERE datetime(delivered_at)>=datetime(?1)",
        params![(now - Duration::hours(24)).to_rfc3339()],
        |row| row.get(0),
    )?;
    if sent_today >= 3 {
        return Ok(Vec::new());
    }
    let opt_in = profile.get("notificationOptedInAt").and_then(|value| value.as_str())
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc));
    let local_date = now.with_timezone(&canvas_calendar_timezone(conn)).date_naive();
    let mut alerts = Vec::new();
    let opportunities = scholarship_payloads(conn, "SELECT payload FROM scholarship_opportunities ORDER BY updated_at DESC")?;
    let applications = scholarship_payloads(conn, "SELECT payload FROM scholarship_applications")?;
    for opportunity in opportunities {
        let Some(id) = opportunity.get("id").and_then(|value| value.as_str()) else { continue };
        let state = opportunity.get("state").and_then(|value| value.as_str()).unwrap_or("discovered");
        if matches!(state, "submitted" | "awarded" | "declined" | "archived")
            || opportunity.get("freshness").and_then(|value| value.as_str()) == Some("stale")
            || opportunity.get("verificationStatus").and_then(|value| value.as_str()) == Some("changed") {
            continue;
        }
        let matched = scholarship_match(&opportunity, &profile);
        if matched.get("ineligible").and_then(|value| value.as_array()).is_some_and(|values| !values.is_empty()) {
            continue;
        }
        let title = opportunity.get("title").and_then(|value| value.as_str()).unwrap_or("Funding opportunity").to_string();
        let deadline = opportunity.get("deadline").and_then(|value| value.as_str())
            .and_then(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok());
        if deadline.is_some_and(|date| date < local_date) { continue; }
        let saved = matches!(state, "saved" | "researching" | "preparing");
        if saved {
            if let Some(date) = deadline {
                let days = date.signed_duration_since(local_date).num_days();
                if days <= 14 {
                    let incomplete = applications.iter().any(|application| {
                        application.get("opportunityId").and_then(|value| value.as_str()) == Some(id)
                            && application.get("checklist").and_then(|value| value.as_array())
                                .is_some_and(|items| items.iter().any(|item| item.get("completed") == Some(&serde_json::Value::Bool(false))))
                    });
                    let kind = if incomplete && days <= 7 { "incomplete_application" } else { "deadline" };
                    alerts.push(FundingAlert { opportunity_id: id.to_string(), kind, anchor: date.to_string(), title });
                    continue;
                }
            }
        }
        let Some(first_seen) = opportunity.get("firstSeenAt").and_then(|value| value.as_str())
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.with_timezone(&Utc)) else { continue };
        if opt_in.is_none_or(|value| first_seen < value) || first_seen > now { continue; }
        if matched.get("matched").and_then(|value| value.as_array()).is_none_or(|values| values.len() < 2) { continue; }
        let school = profile.get("school").and_then(|value| value.as_str()).unwrap_or("").trim().to_ascii_lowercase();
        let provider = opportunity.get("provider").and_then(|value| value.as_str()).unwrap_or("").to_ascii_lowercase();
        let award = opportunity.get("awardMaximum").or_else(|| opportunity.get("awardMinimum"))
            .and_then(|value| value.as_f64()).unwrap_or(0.0);
        let kind = if school.len() >= 4 && provider.contains(&school) { "institution_match" }
            else if award >= 5000.0 { "high_value_match" } else { "strong_match" };
        alerts.push(FundingAlert { opportunity_id: id.to_string(), kind, anchor: first_seen.to_rfc3339(), title });
    }
    let mut undelivered = Vec::new();
    for alert in alerts {
        let delivered = conn.query_row(
            "SELECT 1 FROM funding_alert_deliveries WHERE opportunity_id=?1 AND kind=?2 AND anchor=?3",
            params![alert.opportunity_id, alert.kind, alert.anchor], |row| row.get::<_, i64>(0),
        ).optional()?.is_some();
        if !delivered { undelivered.push(alert); }
    }
    let mut alerts = undelivered;
    alerts.sort_by_key(|alert| match alert.kind { "incomplete_application" => 0, "deadline" => 1, "institution_match" => 2, "high_value_match" => 3, _ => 4 });
    alerts.truncate((3 - sent_today) as usize);
    Ok(alerts)
}

pub(super) fn run_tick<R: tauri::Runtime>(app: &tauri::AppHandle<R>, state: &AppState) -> Result<()> {
    if !matches!(app.notification().permission_state().map_err(|error| AppError::Background(error.to_string()))?, PermissionState::Granted) {
        return Ok(());
    }
    let now = Utc::now();
    let db = state.db.lock().unwrap();
    let show_titles = db_setting(&db, "notification_show_titles", "false") == "true" && !state.locked.load(Ordering::Acquire);
    let sound = delight_preferences::reminder_sound_name(delight_preferences::load(&db)?.reminder_sounds);
    for alert in candidates(&db, now)? {
        let body = if show_titles { format!("{}: {}. Open Funding to review.", alert.kind.replace('_', " "), alert.title) }
            else { "A funding opportunity needs your attention. Open Funding to review.".into() };
        let mut notification = app.notification().builder().title("Coqui Funding").body(body);
        if let Some(name) = sound { notification = notification.sound(name); }
        notification.show()
            .map_err(|error| AppError::Background(error.to_string()))?;
        db.execute("INSERT OR IGNORE INTO funding_alert_deliveries(opportunity_id,kind,anchor,delivered_at) VALUES(?1,?2,?3,?4)",
            params![alert.opportunity_id, alert.kind, alert.anchor, now.to_rfc3339()])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alerts_require_opt_in_and_do_not_repeat_after_delivery() {
        let directory = tempfile::tempdir().unwrap();
        let conn = open_database(&directory.path().join("funding-alerts.db"), &random_key()).unwrap();
        let now = Utc::now();
        let seen = (now - Duration::minutes(1)).to_rfc3339();
        let profile = serde_json::json!({"studyLevel":"undergraduate","fieldsOfStudy":["engineering"],"locations":[],"citizenship":[],"residency":[],"gpa":null,"notificationsEnabled":true,"notificationOptedInAt":(now-Duration::minutes(2)).to_rfc3339()});
        conn.execute("INSERT INTO scholarship_profiles(id,payload,updated_at) VALUES('local',?1,?2)", params![profile.to_string(),now.to_rfc3339()]).unwrap();
        let opportunity = serde_json::json!({"id":"test","title":"Engineering grant","provider":"Example","studyLevels":["undergraduate"],"fieldsOfStudy":["engineering"],"freshness":"fresh","verificationStatus":"verified","firstSeenAt":seen});
        conn.execute("INSERT INTO scholarship_opportunities(id,payload,updated_at) VALUES('test',?1,?2)", params![opportunity.to_string(),now.to_rfc3339()]).unwrap();
        conn.execute("INSERT INTO settings(key,value) VALUES('notification_quiet_start','00:00') ON CONFLICT(key) DO UPDATE SET value=excluded.value",[]).unwrap();
        conn.execute("INSERT INTO settings(key,value) VALUES('notification_quiet_end','00:00') ON CONFLICT(key) DO UPDATE SET value=excluded.value",[]).unwrap();
        let alerts = candidates(&conn,now).unwrap();
        assert_eq!(alerts.len(),1);
        assert_eq!(alerts[0].kind,"strong_match");
        conn.execute("INSERT INTO funding_alert_deliveries(opportunity_id,kind,anchor,delivered_at) VALUES(?1,?2,?3,?4)",params![alerts[0].opportunity_id,alerts[0].kind,alerts[0].anchor,now.to_rfc3339()]).unwrap();
        assert!(candidates(&conn,now).unwrap().is_empty());
        let mut disabled = profile;
        disabled["notificationsEnabled"] = serde_json::json!(false);
        conn.execute("UPDATE scholarship_profiles SET payload=?1 WHERE id='local'",params![disabled.to_string()]).unwrap();
        conn.execute("DELETE FROM funding_alert_deliveries",[]).unwrap();
        assert!(candidates(&conn,now).unwrap().is_empty());
    }

    #[test]
    fn saved_deadline_alerts_do_not_require_a_new_discovery() {
        let directory = tempfile::tempdir().unwrap();
        let conn = open_database(&directory.path().join("funding-deadline.db"), &random_key()).unwrap();
        let now = Utc::now();
        let profile = serde_json::json!({"studyLevel":"undergraduate","fieldsOfStudy":[],"locations":[],"citizenship":[],"residency":[],"gpa":null,"notificationsEnabled":true,"notificationOptedInAt":now.to_rfc3339()});
        conn.execute("INSERT INTO scholarship_profiles(id,payload,updated_at) VALUES('local',?1,?2)",params![profile.to_string(),now.to_rfc3339()]).unwrap();
        let opportunity = serde_json::json!({"id":"saved","title":"Saved grant","state":"saved","deadline":(now+Duration::days(5)).date_naive().to_string(),"freshness":"fresh","verificationStatus":"verified"});
        conn.execute("INSERT INTO scholarship_opportunities(id,payload,updated_at) VALUES('saved',?1,?2)",params![opportunity.to_string(),now.to_rfc3339()]).unwrap();
        conn.execute("INSERT INTO settings(key,value) VALUES('notification_quiet_start','00:00') ON CONFLICT(key) DO UPDATE SET value=excluded.value",[]).unwrap();
        conn.execute("INSERT INTO settings(key,value) VALUES('notification_quiet_end','00:00') ON CONFLICT(key) DO UPDATE SET value=excluded.value",[]).unwrap();
        let alerts = candidates(&conn,now).unwrap();
        assert_eq!(alerts.len(),1);
        assert_eq!(alerts[0].kind,"deadline");
    }
}
