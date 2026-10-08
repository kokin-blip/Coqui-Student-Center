//! Atomic manual calendar edits and conservative, full-plan undo.
use crate::{
    all_plan_blocks, automatic_planning, ensure_fresh_local_plan,
    invalidate_generated_plan_undo, mutation, parse_utc, profile, regenerate_plan_in,
    require_onboarded, student_workflows, AppError, PlanBlock, Result,
};
use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Serialize, Deserialize, PartialEq)]
struct Auxiliary {
    scheduling: automatic_planning::Auxiliary,
    settings: Vec<(String, Option<String>)>,
}

impl Auxiliary {
    fn capture(conn: &Connection) -> Result<Self> {
        let keys = [
            "local_plan_conflicts",
            "local_plan_generated_at",
            "local_plan_rules_revision",
        ];
        let settings = keys.into_iter().map(|key| {
            let value = conn.query_row(
                "SELECT value FROM settings WHERE key=?1", [key], |row| row.get(0),
            ).optional()?;
            Ok((key.into(), value))
        }).collect::<Result<_>>()?;
        Ok(Self {
            scheduling: automatic_planning::capture_auxiliary(conn)?,
            settings,
        })
    }

    fn restore(&self, conn: &Connection) -> Result<()> {
        automatic_planning::restore_auxiliary(conn, &self.scheduling)?;
        for (key, value) in &self.settings {
            conn.execute("DELETE FROM settings WHERE key=?1", [key])?;
            if let Some(value) = value {
                conn.execute(
                    "INSERT INTO settings(key,value) VALUES(?1,?2)", params![key,value],
                )?;
            }
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
struct CalendarUndo {
    version: u32,
    before: Vec<PlanBlock>,
    after: Vec<PlanBlock>,
    before_auxiliary: Auxiliary,
    after_auxiliary: Auxiliary,
    fingerprint: String,
}

fn fingerprint(conn: &Connection) -> Result<String> {
    let workspace = profile::workspace(conn)?;
    // Include inputs beyond the current horizon. Changing a future term or
    // meeting must invalidate undo even before it affects generated blocks.
    let inputs = (
        workspace.profile.as_ref().map(|value| value.timezone.as_str()),
        &workspace.terms, &workspace.courses, &workspace.tasks,
        &workspace.commitments, &workspace.class_meetings, &workspace.academic_events,
        &workspace.preferences, &workspace.availability, &workspace.rhythm_rules,
    );
    let bytes = serde_json::to_vec(&inputs)
        .map_err(|error| AppError::Background(error.to_string()))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn invalid(message: &str) -> AppError {
    AppError::Invalid(message.into())
}

pub fn move_block(
    conn: &Connection, id: &str, start: &str, end: &str, now: DateTime<Utc>,
) -> Result<()> {
    require_onboarded(conn)?;
    let starts = parse_utc(start).ok_or_else(|| invalid("calendar start is invalid"))?;
    let ends = parse_utc(end).ok_or_else(|| invalid("calendar end is invalid"))?;
    if starts < now - Duration::minutes(1)
        || !(5..=480).contains(&(ends - starts).num_minutes())
    {
        return Err(invalid("calendar block must be 5–480 minutes in the future"));
    }
    ensure_fresh_local_plan(conn, now)?;
    let tx = conn.unchecked_transaction()?;
    student_workflows::capture_days(&tx, now)?;
    let before = all_plan_blocks(&tx)?;
    if !before.iter().any(|block| {
        block.id == id && block.task_id.is_some()
            && !block.completed && block.started_at.is_none()
    }) {
        return Err(invalid("only unfinished, unstarted study blocks can be moved"));
    }
    if before.iter().any(|block| {
        block.id != id && !block.completed
            && parse_utc(&block.starts_at).is_some_and(|time| time < ends)
            && parse_utc(&block.ends_at).is_some_and(|time| time > starts)
    }) {
        return Err(invalid("that time overlaps another class, commitment, or study block"));
    }
    let before_auxiliary = Auxiliary::capture(&tx)?;
    tx.execute(
        "UPDATE plan_blocks SET starts_at=?2,ends_at=?3,locked=1,
         reason_codes='[\"manual_calendar_move\"]' WHERE id=?1",
        params![id,starts.to_rfc3339(),ends.to_rfc3339()],
    )?;
    regenerate_plan_in(&tx, now, crate::planner::PlannerTrigger::PreferenceChanged)?;
    mutation(&tx, "plan_block", id, "moved", "{}")?;
    let undo = CalendarUndo {
        version: 2,
        before,
        after: all_plan_blocks(&tx)?,
        before_auxiliary,
        after_auxiliary: Auxiliary::capture(&tx)?,
        fingerprint: fingerprint(&tx)?,
    };
    tx.execute(
        "INSERT INTO settings(key,value) VALUES('calendar_undo',?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [serde_json::to_string(&undo)
            .map_err(|error| AppError::Background(error.to_string()))?],
    )?;
    tx.commit()?;
    Ok(())
}

pub fn undo(conn: &Connection, now: DateTime<Utc>) -> Result<()> {
    require_onboarded(conn)?;
    ensure_fresh_local_plan(conn, now)?;
    let tx = conn.unchecked_transaction()?;
    let raw: String = tx.query_row(
        "SELECT value FROM settings WHERE key='calendar_undo'", [], |row| row.get(0),
    ).optional()?.ok_or_else(|| invalid("there is no calendar change to undo"))?;
    let undo: CalendarUndo = serde_json::from_str(&raw).map_err(|_| invalid(
        "This calendar undo is from an older version. Make a new calendar edit to enable undo.",
    ))?;
    if undo.version != 2
        || all_plan_blocks(&tx)? != undo.after
        || Auxiliary::capture(&tx)? != undo.after_auxiliary
        || fingerprint(&tx)? != undo.fingerprint
    {
        return Err(invalid(
            "Your schedule changed after this calendar edit. Undo would overwrite newer work.",
        ));
    }
    // Unchanged historical/protected blocks are retained, not resurrected.
    if undo.before.iter().any(|block| {
        block.task_id.is_some() && !block.completed && block.started_at.is_none()
            && parse_utc(&block.starts_at).is_none_or(|start| start < now)
            && !undo.after.iter().any(|current| current == block)
    }) {
        return Err(invalid(
            "The previous plan contains an elapsed study session and can no longer be restored.",
        ));
    }
    restore_blocks(&tx, &undo.before)?;
    undo.before_auxiliary.restore(&tx)?;
    invalidate_generated_plan_undo(&tx)?;
    mutation(&tx, "plan", "calendar-undo", "move_undone", "{}")?;
    tx.execute("DELETE FROM settings WHERE key='calendar_undo'", [])?;
    tx.commit()?;
    Ok(())
}

fn restore_blocks(conn: &Connection, blocks: &[PlanBlock]) -> Result<()> {
    let ids = blocks.iter().map(|block| block.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    for current in all_plan_blocks(conn)? {
        if !ids.contains(current.id.as_str()) {
            conn.execute("DELETE FROM plan_blocks WHERE id=?1", [&current.id])?;
        }
    }
    for block in blocks {
        conn.execute(
            "INSERT INTO plan_blocks(id,task_id,starts_at,ends_at,title,kind,completed,
             locked,started_at,session_index,location,reason_codes)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
             ON CONFLICT(id) DO UPDATE SET task_id=excluded.task_id,
             starts_at=excluded.starts_at,ends_at=excluded.ends_at,title=excluded.title,
             kind=excluded.kind,completed=excluded.completed,locked=excluded.locked,
             started_at=excluded.started_at,session_index=excluded.session_index,
             location=excluded.location,reason_codes=excluded.reason_codes",
            params![
                block.id, block.task_id, block.starts_at, block.ends_at,
                block.title, block.kind, block.completed, block.locked,
                block.started_at, block.session_index, block.location,
                serde_json::to_string(&block.reason_codes)
                    .map_err(|error| AppError::Background(error.to_string()))?,
            ],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::*;

    fn fixture(minutes: i64) -> (tempfile::TempDir, Connection, DateTime<Utc>, String, PlanBlock) {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = open_database(&dir.path().join("calendar.db"), &random_key()).unwrap();
        crate::tests::complete_test_onboarding(&mut conn);
        let now = Utc.with_ymd_and_hms(2026, 10, 5, 7, 0, 0).unwrap();
        let task = insert_task(&conn, "Calendar work", minutes, None, None).unwrap();
        conn.execute("UPDATE planning_preferences SET scheduling_style='earliest'", []).unwrap();
        regenerate_plan_for_trigger(&conn, Some(now.with_timezone(&Local)), planner::PlannerTrigger::Initial).unwrap();
        let block = all_plan_blocks(&conn).unwrap().into_iter().find(|b| b.task_id.as_deref() == Some(&task)).unwrap();
        (dir, conn, now, task, block)
    }
    fn minutes(conn: &Connection, task: &str) -> i64 {
        all_plan_blocks(conn).unwrap().iter().filter(|b| b.task_id.as_deref() == Some(task)).map(|b| (parse_utc(&b.ends_at).unwrap()-parse_utc(&b.starts_at).unwrap()).num_minutes()).sum()
    }

    #[test]
    fn resize_recomputes_remaining_work_and_full_undo_restores_reminders() {
        let (_dir, conn, now, task, block) = fixture(60);
        conn.execute("INSERT INTO reminder_deliveries(block_id,plan_starts_at,dismissed_at) VALUES(?1,?2,?3)", params![block.id,block.starts_at,now.to_rfc3339()]).unwrap();
        let before = all_plan_blocks(&conn).unwrap();
        let aux = Auxiliary::capture(&conn).unwrap();
        let start = parse_utc(&block.starts_at).unwrap();
        move_block(&conn, &block.id, &block.starts_at, &(start+Duration::minutes(30)).to_rfc3339(), now).unwrap();
        let moved = all_plan_blocks(&conn).unwrap().into_iter().find(|b| b.id == block.id).unwrap();
        assert!(moved.locked);
        assert_eq!(moved.reason_codes, ["manual_calendar_move"]);
        assert_eq!(minutes(&conn, &task), 60);
        assert_eq!(task_plan_in(&conn, &task, now).unwrap().unscheduled_minutes, 0);
        assert_eq!(conn.query_row("SELECT minutes FROM tasks WHERE id=?1", [&task], |r| r.get::<_,i64>(0)).unwrap(),60);
        undo(&conn, now).unwrap();
        assert_eq!(all_plan_blocks(&conn).unwrap(), before);
        assert!(Auxiliary::capture(&conn).unwrap() == aux);
        assert_eq!(conn.query_row("SELECT dismissed_at FROM reminder_deliveries WHERE block_id=?1", [&block.id], |r| r.get::<_,String>(0)).unwrap(), now.to_rfc3339());
        assert!(undo(&conn, now).is_err());
    }

    #[test]
    fn resize_reports_capacity_shortfall_immediately() {
        let (_dir, conn, now, task, block) = fixture(60);
        conn.execute("UPDATE tasks SET due_at='2026-10-05T09:00:00Z' WHERE id=?1", [&task]).unwrap();
        regenerate_plan_for_trigger(&conn, Some(now.with_timezone(&Local)), planner::PlannerTrigger::Initial).unwrap();
        let start = parse_utc(&block.starts_at).unwrap();
        move_block(&conn, &block.id, &block.starts_at, &(start+Duration::minutes(30)).to_rfc3339(), now).unwrap();
        let plan = task_plan_in(&conn,&task,now).unwrap();
        assert_eq!(plan.unscheduled_minutes,30);
        assert!(plan.reason_codes.iter().any(|r| r == "insufficient_capacity"));
        assert_eq!(calendar_agenda(&conn,Some("2026-10-05")).unwrap().overload_conflicts.len(),1);
        let capacity: planner::CapacitySummary = serde_json::from_str(&db_setting(&conn,"plan_capacity", "")).unwrap();
        assert_eq!(capacity.overload_minutes,30);
        assert!(db_setting(&conn,"local_plan_conflicts", "").contains("30"));
        assert_eq!(conn.query_row("SELECT due_at FROM tasks WHERE id=?1", [&task], |r| r.get::<_,String>(0)).unwrap(), "2026-10-05T09:00:00Z");
    }

    #[test]
    fn lengthening_replaces_excess_movable_work_and_retains_protected_sessions() {
        let (_dir, conn, now, task, block) = fixture(120);
        let other = insert_task(&conn,"Protected",30,None,None).unwrap();
        conn.execute("INSERT INTO plan_blocks(id,task_id,starts_at,ends_at,title,kind,locked,started_at,reason_codes) VALUES('protected',?1,'2026-10-05T17:00:00Z','2026-10-05T17:30:00Z','Protected','study',1,?2,'[]')", params![other,now.to_rfc3339()]).unwrap();
        move_block(&conn,&block.id,"2026-10-05T12:00:00Z","2026-10-05T13:30:00Z",now).unwrap();
        assert_eq!(minutes(&conn,&task),120);
        let moved = all_plan_blocks(&conn).unwrap().into_iter().find(|b| b.id == block.id).unwrap();
        assert_eq!(moved.starts_at, "2026-10-05T12:00:00+00:00");
        assert_eq!(moved.ends_at, "2026-10-05T13:30:00+00:00");
        assert!(moved.locked);
        assert_eq!(moved.reason_codes, ["manual_calendar_move"]);
        assert_eq!(all_plan_blocks(&conn).unwrap().iter().filter(|b| b.task_id.as_deref()==Some(&task)).count(),2);
        let protected = all_plan_blocks(&conn).unwrap().into_iter().find(|b| b.id=="protected").unwrap();
        assert!(protected.locked && protected.started_at.is_some());
        undo(&conn,now).unwrap();
        assert_eq!(all_plan_blocks(&conn).unwrap().into_iter().find(|b| b.id=="protected").unwrap(),protected);
    }

    #[test]
    fn undo_rejects_new_commitment_or_scheduling_inputs_without_overwriting_them() {
        for change in ["commitment", "preferences", "future-term"] {
            let (_dir, conn, now, _task, block) = fixture(60);
            move_block(&conn,&block.id,"2026-10-05T12:00:00Z","2026-10-05T13:00:00Z",now).unwrap();
            if change == "commitment" {
                conn.execute("INSERT INTO commitments(id,title,starts_at,ends_at,kind) VALUES('new','New',?1,?2,'work')",params![block.starts_at,block.ends_at]).unwrap();
                regenerate_plan_for_trigger(&conn,Some(now.with_timezone(&Local)),planner::PlannerTrigger::Initial).unwrap();
            } else if change == "preferences" {
                conn.execute("UPDATE planning_preferences SET break_minutes=15",[]).unwrap();
            } else {
                conn.execute("UPDATE academic_terms SET ends_on='2026-12-21',version=version+1",[]).unwrap();
            }
            let before=all_plan_blocks(&conn).unwrap();
            let aux=Auxiliary::capture(&conn).unwrap();
            assert!(undo(&conn,now).unwrap_err().to_string().contains("changed"));
            assert_eq!(all_plan_blocks(&conn).unwrap(),before);
            assert!(Auxiliary::capture(&conn).unwrap()==aux);
            assert!(!db_setting(&conn,"calendar_undo", "").is_empty());
        }
    }

    #[test]
    fn undo_rejects_started_completed_and_elapsed_work_and_legacy_payloads() {
        for change in ["started","completed","elapsed","legacy"] {
            let (_dir,conn,now,_task,block)=fixture(60);
            move_block(&conn,&block.id,"2026-10-05T12:00:00Z","2026-10-05T13:00:00Z",now).unwrap();
            match change {
                "started" => {conn.execute("UPDATE plan_blocks SET started_at=?2 WHERE id=?1",params![block.id,now.to_rfc3339()]).unwrap();},
                "completed" => {conn.execute("UPDATE plan_blocks SET completed=1 WHERE id=?1",[&block.id]).unwrap();},
                "legacy" => {conn.execute("UPDATE settings SET value='{\"block_id\":\"old\"}' WHERE key='calendar_undo'",[]).unwrap();},
                _ => (),
            }
            let before=all_plan_blocks(&conn).unwrap();
            let clock=if change=="elapsed" {parse_utc(&block.starts_at).unwrap()+Duration::minutes(1)}else{now};
            assert!(undo(&conn,clock).is_err());
            assert_eq!(all_plan_blocks(&conn).unwrap(),before);
        }
    }

    #[test]
    fn undo_retains_unchanged_elapsed_locked_sessions() {
        let (_dir,conn,now,_task,block)=fixture(60);
        let historical = insert_task(&conn,"Missed locked session",30,None,None).unwrap();
        conn.execute("INSERT INTO plan_blocks(id,task_id,starts_at,ends_at,title,kind,locked,reason_codes) VALUES('historical',?1,'2026-10-04T17:00:00Z','2026-10-04T17:30:00Z','Missed locked session','study',1,'[]')", [&historical]).unwrap();
        regenerate_plan_for_trigger(&conn,Some(now.with_timezone(&Local)),planner::PlannerTrigger::Initial).unwrap();
        let before=all_plan_blocks(&conn).unwrap();
        move_block(&conn,&block.id,"2026-10-05T12:00:00Z","2026-10-05T13:00:00Z",now).unwrap();
        undo(&conn,now).unwrap();
        assert_eq!(all_plan_blocks(&conn).unwrap(),before);
    }

    #[test]
    fn persistence_failures_roll_back_calendar_edit_and_undo() {
        let (_dir,conn,now,_task,block)=fixture(60);
        let before=all_plan_blocks(&conn).unwrap();
        let aux=Auxiliary::capture(&conn).unwrap();
        let count=conn.query_row("SELECT COUNT(*) FROM mutations",[],|r|r.get::<_,i64>(0)).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_calendar_edit BEFORE INSERT ON settings WHEN NEW.key='calendar_undo' BEGIN SELECT RAISE(ABORT,'injected edit failure'); END;").unwrap();
        assert!(move_block(&conn,&block.id,"2026-10-05T12:00:00Z","2026-10-05T12:30:00Z",now).is_err());
        assert_eq!(all_plan_blocks(&conn).unwrap(),before);
        assert!(Auxiliary::capture(&conn).unwrap()==aux);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM mutations",[],|r|r.get::<_,i64>(0)).unwrap(),count);
        conn.execute_batch("DROP TRIGGER fail_calendar_edit;").unwrap();
        move_block(&conn,&block.id,"2026-10-05T12:00:00Z","2026-10-05T12:30:00Z",now).unwrap();
        let edited=all_plan_blocks(&conn).unwrap();let edited_aux=Auxiliary::capture(&conn).unwrap();let undo_payload=db_setting(&conn,"calendar_undo", "");
        let count=conn.query_row("SELECT COUNT(*) FROM mutations",[],|r|r.get::<_,i64>(0)).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_calendar_undo BEFORE DELETE ON settings WHEN OLD.key='calendar_undo' BEGIN SELECT RAISE(ABORT,'injected undo failure'); END;").unwrap();
        assert!(undo(&conn,now).is_err());
        assert_eq!(all_plan_blocks(&conn).unwrap(),edited);
        assert!(Auxiliary::capture(&conn).unwrap()==edited_aux);
        assert_eq!(db_setting(&conn,"calendar_undo", ""),undo_payload);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM mutations",[],|r|r.get::<_,i64>(0)).unwrap(),count);
    }

    #[test]
    fn holidays_filter_native_agenda_in_meeting_timezone_and_upgrade_once() {
        let (_dir,conn,_,_,_)=fixture(60);
        let (course,term):(String,String)=conn.query_row("SELECT id,term_id FROM courses LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        conn.execute("INSERT INTO class_meeting_series(id,course_id,term_id,timezone,weekdays,starts_at_local,ends_at_local) VALUES('daily',?1,?2,'Asia/Tokyo','[0,1,2,3,4,5,6]','00:30','01:30')",params![course,term]).unwrap();
        conn.execute("INSERT INTO academic_terms(id,name,starts_on,ends_on,created_at) VALUES('other','Other','2026-08-01','2026-12-20','2026-01-01')",[]).unwrap();
        let now=Utc.with_ymd_and_hms(2026,10,4,0,0,0).unwrap();
        for (scope,no_class,expected) in [(Some(term.as_str()),true,false),(None,true,false),(Some("other"),true,true),(Some(term.as_str()),false,true)] {
            conn.execute("DELETE FROM academic_calendar_events",[]).unwrap();
            conn.execute("INSERT INTO academic_calendar_events(id,term_id,title,starts_on,ends_on,no_class) VALUES('break',?1,'Break','2026-10-05','2026-10-07',?2)",params![scope,no_class]).unwrap();
            regenerate_plan_for_trigger(&conn,Some(now.with_timezone(&Local)),planner::PlannerTrigger::Initial).unwrap();
            let agenda=calendar_agenda(&conn,Some("2026-10-04")).unwrap();
            for day in ["2026-10-05","2026-10-06","2026-10-07"] {
                assert_eq!(agenda.blocks.iter().any(|b|b.id==format!("daily:{day}")),expected);
            }
            assert!(agenda.blocks.iter().any(|b|b.id=="daily:2026-10-08"));
        }
        // An upgrade must repair persisted classes even when today's plan is fresh.
        conn.execute("UPDATE academic_calendar_events SET no_class=1,ends_on=starts_on",[]).unwrap();
        conn.execute("DELETE FROM settings WHERE key='local_plan_rules_revision'",[]).unwrap();
        ensure_fresh_local_plan(&conn,now).unwrap();
        assert!(!all_plan_blocks(&conn).unwrap().iter().any(|b|b.id=="daily:2026-10-05"));
        assert!(all_plan_blocks(&conn).unwrap().iter().any(|b|b.id=="daily:2026-10-06"));
        let repaired=all_plan_blocks(&conn).unwrap();
        let stamp=db_setting(&conn,"local_plan_generated_at", "");
        ensure_fresh_local_plan(&conn,now+Duration::minutes(1)).unwrap();
        assert_eq!(all_plan_blocks(&conn).unwrap(),repaired);
        assert_eq!(db_setting(&conn,"local_plan_generated_at", ""),stamp);
        assert_eq!(db_setting(&conn,"local_plan_rules_revision", ""),LOCAL_PLAN_RULES_REVISION);
    }
}
