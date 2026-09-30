//! Student-confirmed, device-local workflows. The encrypted profile and full database
//! backup own persistence; these records must never enter canonical sync.
use crate::{AppError, Result, db_setting};
use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

fn invalid(message: &str) -> AppError { AppError::Invalid(message.into()) }
const ELIGIBLE: &str = "'assignment','homework','project','paper','lab','quiz','test','exam','midterm','final'";

pub fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS quick_notes_local(
      id TEXT PRIMARY KEY,content TEXT NOT NULL,course_id TEXT,task_id TEXT,pinned INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS day_checkins_local(
      day TEXT PRIMARY KEY,timezone TEXT NOT NULL,due_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
      offered_at TEXT,snoozed_until TEXT,notified_at TEXT);
      CREATE TABLE IF NOT EXISTS checkin_items_local(day TEXT NOT NULL,task_id TEXT NOT NULL,title TEXT NOT NULL,
      response TEXT,responded_at TEXT,initial_due_at TEXT,PRIMARY KEY(day,task_id));
      CREATE TABLE IF NOT EXISTS assignment_streak_local(task_id TEXT PRIMARY KEY,title TEXT NOT NULL,kind TEXT NOT NULL,
      due_at TEXT NOT NULL,completed INTEGER NOT NULL,completed_at TEXT,frozen INTEGER NOT NULL DEFAULT 0,
      legacy INTEGER NOT NULL DEFAULT 0,deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS assignment_history_local(sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,kind TEXT NOT NULL,due_at TEXT,completed_at TEXT,recorded_at TEXT NOT NULL);")?;
    crate::ensure_column(db,"checkin_items_local","initial_due_at","TEXT")?;
    // A trigger observes every task mutation path, including imports and received edits.
    db.execute_batch(&format!("INSERT OR IGNORE INTO assignment_streak_local(task_id,title,kind,due_at,completed,completed_at,frozen,legacy)
      SELECT id,title,task_kind,due_at,completed,completed_at,CASE WHEN completed=1 OR julianday(due_at)<=julianday('now') THEN 1 ELSE 0 END,1
      FROM tasks WHERE due_at IS NOT NULL AND task_kind IN ({ELIGIBLE});
      CREATE TRIGGER IF NOT EXISTS streak_insert AFTER INSERT ON tasks WHEN NEW.due_at IS NOT NULL AND NEW.task_kind IN ({ELIGIBLE}) BEGIN
        INSERT OR IGNORE INTO assignment_streak_local(task_id,title,kind,due_at,completed,completed_at,frozen)
        VALUES(NEW.id,NEW.title,NEW.task_kind,NEW.due_at,NEW.completed,NEW.completed_at,NEW.completed);
      END;
      CREATE TRIGGER IF NOT EXISTS streak_update BEFORE UPDATE ON tasks BEGIN
        UPDATE assignment_streak_local SET frozen=1 WHERE task_id=OLD.id AND (OLD.completed=1 OR julianday(due_at)<=julianday('now'));
        INSERT INTO assignment_history_local(task_id,kind,due_at,completed_at,recorded_at)
        SELECT OLD.id,CASE WHEN NEW.completed!=OLD.completed THEN CASE WHEN NEW.completed=1 THEN 'completed' ELSE 'reopened' END ELSE 'edited' END,
          NEW.due_at,NEW.completed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE NEW.due_at IS NOT OLD.due_at OR NEW.completed!=OLD.completed OR NEW.completed_at IS NOT OLD.completed_at OR NEW.task_kind!=OLD.task_kind;
        DELETE FROM assignment_streak_local WHERE task_id=OLD.id AND frozen=0 AND (NEW.due_at IS NULL OR NEW.task_kind NOT IN ({ELIGIBLE}));
        INSERT INTO assignment_streak_local(task_id,title,kind,due_at,completed,completed_at,frozen)
          SELECT NEW.id,NEW.title,NEW.task_kind,NEW.due_at,NEW.completed,NEW.completed_at,NEW.completed
          WHERE NEW.due_at IS NOT NULL AND NEW.task_kind IN ({ELIGIBLE})
          ON CONFLICT(task_id) DO UPDATE SET title=excluded.title,due_at=CASE WHEN frozen=0 THEN excluded.due_at ELSE due_at END,
          completed=excluded.completed,completed_at=excluded.completed_at,frozen=MAX(frozen,excluded.frozen);
        UPDATE assignment_streak_local SET completed=NEW.completed,completed_at=NEW.completed_at WHERE task_id=OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS streak_delete BEFORE DELETE ON tasks BEGIN
        DELETE FROM assignment_streak_local WHERE task_id=OLD.id AND frozen=0 AND completed=0 AND julianday(due_at)>julianday('now');
        UPDATE assignment_streak_local SET deleted=1,frozen=1 WHERE task_id=OLD.id;
        INSERT INTO assignment_history_local(task_id,kind,due_at,completed_at,recorded_at)
        VALUES(OLD.id,'deleted',OLD.due_at,OLD.completed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END;"))?;
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct QuickNote { pub id:String,pub content:String,pub course_id:Option<String>,pub task_id:Option<String>,pub pinned:bool,pub revision:i64,pub created_at:String,pub updated_at:String }
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct NoteInput { pub id:Option<String>,pub expected_revision:i64,pub content:String,pub course_id:Option<String>,pub task_id:Option<String>,pub pinned:bool }
pub fn notes(db:&Connection, query:&str)->Result<Vec<QuickNote>> {
    let mut sql=db.prepare("SELECT id,content,course_id,task_id,pinned,revision,created_at,updated_at FROM quick_notes_local ORDER BY pinned DESC,updated_at DESC,id")?;
    let all=sql.query_map([],|r|Ok(QuickNote{id:r.get(0)?,content:r.get(1)?,course_id:r.get(2)?,task_id:r.get(3)?,pinned:r.get(4)?,revision:r.get(5)?,created_at:r.get(6)?,updated_at:r.get(7)?}))?.collect::<std::result::Result<Vec<_>,_>>()?;
    let query=query.to_lowercase(); Ok(all.into_iter().filter(|n|n.content.to_lowercase().contains(&query)).collect())
}
pub fn save_note(db:&Connection, input:NoteInput)->Result<Vec<QuickNote>> {
    if input.content.trim().is_empty()||input.content.chars().count()>4000 {return Err(invalid("Write a note of 1–4,000 characters."));}
    for (table,id) in [("courses",input.course_id.as_ref()),("tasks",input.task_id.as_ref())] {
      if let Some(id)=id {if !db.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id=?1)"),[id],|r|r.get::<_,bool>(0))? {return Err(invalid("The linked course or task is no longer available."));}}
    }
    let now=Utc::now().to_rfc3339();
    if let Some(id)=input.id {
      if db.execute("UPDATE quick_notes_local SET content=?2,course_id=?3,task_id=?4,pinned=?5,revision=revision+1,updated_at=?6 WHERE id=?1 AND revision=?7",params![id,input.content,input.course_id,input.task_id,input.pinned,now,input.expected_revision])?!=1 {return Err(invalid("This note changed. Reload before saving."));}
    } else {
      if input.expected_revision!=0 {return Err(invalid("New notes must start at revision zero."));}
      db.execute("INSERT INTO quick_notes_local(id,content,course_id,task_id,pinned,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6)",params![Uuid::new_v4().to_string(),input.content,input.course_id,input.task_id,input.pinned,now])?;
    } notes(db,"")
}
pub fn delete_note(db:&Connection,id:&str,revision:i64)->Result<Vec<QuickNote>> {
    if db.execute("DELETE FROM quick_notes_local WHERE id=?1 AND revision=?2",params![id,revision])?!=1 {return Err(invalid("This note changed. Reload before deleting."));} notes(db,"")
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct CheckinSettings { pub enabled:bool,pub time:String,pub follow_rhythm:bool,pub offer_dismissed:bool,pub streak_visible:bool }
impl Default for CheckinSettings {fn default()->Self{Self{enabled:false,time:"20:00".into(),follow_rhythm:true,offer_dismissed:false,streak_visible:true}}}
pub fn settings(db:&Connection)->Result<CheckinSettings> {
    let raw=db_setting(db,"student_workflow_settings","");
    if raw.is_empty(){Ok(CheckinSettings::default())}else{serde_json::from_str(&raw).map_err(|_|invalid("Check-in settings need recovery."))}
}
pub fn save_settings(db:&Connection,input:CheckinSettings)->Result<CheckinSettings> {
    if crate::parse_clock(&input.time).is_none(){return Err(invalid("Choose a valid check-in time."));}
    db.execute("INSERT INTO settings(key,value) VALUES('student_workflow_settings',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[serde_json::to_string(&input).map_err(|_|invalid("Settings could not be saved."))?])?;Ok(input)
}
fn zone(db:&Connection)->Tz{db_setting(db,"timezone","Etc/UTC").parse().unwrap_or(chrono_tz::UTC)}
// DST gaps advance to the first valid minute. Ambiguous times use the earlier occurrence.
fn local_at(day:NaiveDate,minutes:u32,tz:Tz)->Result<DateTime<Utc>> {
    let naive=day.and_hms_opt(minutes/60,minutes%60,0).ok_or_else(||invalid("Invalid local time."))?;
    for offset in 0..=180 {if let Some(value)=tz.from_local_datetime(&(naive+Duration::minutes(offset))).earliest(){return Ok(value.with_timezone(&Utc));}}
    Err(invalid("The check-in time is not available in your timezone."))
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct CheckinItem {pub task_id:String,pub title:String,pub response:Option<String>,pub completed:bool,pub unavailable:bool,pub task_version:Option<i64>,pub rescheduled:bool}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Checkin {pub day:String,pub timezone:String,pub due_at:String,pub items:Vec<CheckinItem>}

pub fn capture_days(db:&Connection,now:DateTime<Utc>)->Result<()> {
    let prefs=settings(db)?;
    if !prefs.enabled || crate::require_onboarded(db).is_err(){return Ok(());}
    let tz=zone(db);let today=now.with_timezone(&tz).date_naive();
    let rhythm=db.query_row("SELECT sleep_start,sleep_end FROM planning_preferences WHERE sleep_start!='23:00' OR sleep_end!='07:00' OR version>1 OR EXISTS(SELECT 1 FROM settings WHERE key='student_rhythm_confirmed' AND value='true') OR EXISTS(SELECT 1 FROM weekly_rhythm_rules) LIMIT 1",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()?;
    for offset in [-1,0,1] {
      let day=today+Duration::days(offset);let key=day.to_string();
      let already=db.query_row("SELECT offered_at IS NOT NULL OR status!='pending' FROM day_checkins_local WHERE day=?1",[&key],|r|r.get::<_,bool>(0)).optional()?.unwrap_or(false);
      if already {continue;}
      let (start,end,sleep)=if let Some((sleep,wake))=&rhythm {
        let sleep=crate::parse_clock(sleep).unwrap_or(23*60);let wake=crate::parse_clock(wake).unwrap_or(7*60);
        let sleep_day=if sleep<=wake{day+Duration::days(1)}else{day};
        (local_at(day,wake,tz)?,local_at(day+Duration::days(1),wake,tz)?,Some(local_at(sleep_day,sleep,tz)?))
      }else{(local_at(day,0,tz)?,local_at(day+Duration::days(1),0,tz)?,None)};
      let manual_minutes=crate::parse_clock(&prefs.time).unwrap_or(1200);
      let mut due=local_at(day,manual_minutes,tz)?;
      if due<start { due=local_at(day+Duration::days(1),manual_minutes,tz)?; }
      if prefs.follow_rhythm {if let Some(sleep)=sleep {
        let last:Option<String>=db.query_row("SELECT ends_at FROM plan_blocks WHERE julianday(starts_at)>=julianday(?1) AND julianday(starts_at)<julianday(?2) AND (task_id IS NOT NULL OR kind IN ('class','work','commitment')) ORDER BY julianday(ends_at) DESC LIMIT 1",params![start.to_rfc3339(),end.to_rfc3339()],|r|r.get(0)).optional()?.flatten();
        due=last.as_deref().and_then(crate::parse_utc).map(|v|v+Duration::minutes(30)).unwrap_or(sleep-Duration::minutes(30)).min(sleep-Duration::minutes(30)).max(start);
      }}
      db.execute("INSERT INTO day_checkins_local(day,timezone,due_at) VALUES(?1,?2,?3) ON CONFLICT(day) DO UPDATE SET timezone=excluded.timezone,due_at=excluded.due_at WHERE offered_at IS NULL AND status='pending'",params![key,tz.name(),due.to_rfc3339()])?;
      let mut tasks=db.prepare("SELECT id,title,due_at FROM tasks WHERE completed=0")?;
      for row in tasks.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?)))? {
        let (id,title,deadline)=row?;
        let due_today=deadline.as_deref().and_then(crate::parse_utc).is_some_and(|v|v.with_timezone(&tz).date_naive()==day);
        let planned=db.query_row("SELECT EXISTS(SELECT 1 FROM plan_blocks WHERE task_id=?1 AND julianday(starts_at)>=julianday(?2) AND julianday(starts_at)<julianday(?3))",params![id,start.to_rfc3339(),end.to_rfc3339()],|r|r.get::<_,bool>(0))?;
        if due_today||planned{db.execute("INSERT OR IGNORE INTO checkin_items_local(day,task_id,title,initial_due_at) VALUES(?1,?2,?3,?4)",params![key,id,title,deadline])?;}
      }
    }
    db.execute("UPDATE day_checkins_local SET status='expired' WHERE status='pending' AND julianday(due_at)<julianday(?1)-2",[now.to_rfc3339()])?;Ok(())
}
pub fn pending(db:&Connection,now:DateTime<Utc>,offer:bool)->Result<Option<Checkin>> {
    capture_days(db,now)?;let prefs=settings(db)?;if !prefs.enabled {return Ok(None);}
    let quiet=crate::in_quiet_hours(crate::student_local_minutes(db,now),crate::parse_clock(&db_setting(db,"notification_quiet_start","22:00")).unwrap_or(1320),crate::parse_clock(&db_setting(db,"notification_quiet_end","07:00")).unwrap_or(420));
    if quiet{return Ok(None);}
    db.execute("UPDATE day_checkins_local SET status='resolved' WHERE status='pending' AND offered_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM checkin_items_local i LEFT JOIN tasks t ON t.id=i.task_id WHERE i.day=day_checkins_local.day AND i.response IS NULL AND COALESCE(t.completed,0)=0 AND t.id IS NOT NULL)",[])?;
    let candidate=db.query_row("SELECT day,timezone,due_at FROM day_checkins_local d WHERE status='pending' AND julianday(due_at)<=julianday(?1) AND (snoozed_until IS NULL OR julianday(snoozed_until)<=julianday(?1)) AND EXISTS(SELECT 1 FROM checkin_items_local i WHERE i.day=d.day AND i.response IS NULL) ORDER BY due_at DESC LIMIT 1",[now.to_rfc3339()],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).optional()?;
    let Some((day,timezone,due_at))=candidate else{return Ok(None)};
    // Older check-ins never stack behind the newest one.
    if offer {db.execute("UPDATE day_checkins_local SET status='expired' WHERE status='pending' AND day<?1",[&day])?;db.execute("UPDATE day_checkins_local SET offered_at=COALESCE(offered_at,?2) WHERE day=?1",params![day,now.to_rfc3339()])?;}
    let mut query=db.prepare("SELECT i.task_id,i.title,i.response,COALESCE(t.completed,0),t.id IS NULL,t.version,t.due_at IS NOT i.initial_due_at FROM checkin_items_local i LEFT JOIN tasks t ON t.id=i.task_id WHERE day=?1 ORDER BY i.title,i.task_id")?;
    let items=query.query_map([&day],|r|Ok(CheckinItem{task_id:r.get(0)?,title:r.get(1)?,response:r.get(2)?,completed:r.get(3)?,unavailable:r.get(4)?,task_version:r.get(5)?,rescheduled:r.get(6)?}))?.collect::<std::result::Result<Vec<_>,_>>()?;
    Ok(Some(Checkin{day,timezone,due_at,items}))
}
pub fn control(db:&Connection,day:&str,action:&str,now:DateTime<Utc>)->Result<()> {
    let changed=match action {
      "dismiss"=>db.execute("UPDATE day_checkins_local SET status='dismissed' WHERE day=?1",[day])?,
      "snooze"=>db.execute("UPDATE day_checkins_local SET snoozed_until=?2 WHERE day=?1 AND status='pending'",params![day,(now+Duration::minutes(30)).to_rfc3339()])?,
      _=>return Err(invalid("Unknown check-in action."))};
    if changed!=1{return Err(invalid("This check-in is no longer available."));}Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Response {pub day:String,pub task_id:String,pub action:String,pub expected_version:i64,pub completed_at:Option<String>}
pub fn respond(db:&Connection,input:Response,now:DateTime<Utc>)->Result<()> {
    let tx=db.unchecked_transaction()?;
    if !tx.query_row("SELECT EXISTS(SELECT 1 FROM checkin_items_local i JOIN day_checkins_local d ON d.day=i.day WHERE i.day=?1 AND i.task_id=?2 AND i.response IS NULL AND d.status='pending')",params![input.day,input.task_id],|r|r.get::<_,bool>(0))?{return Err(invalid("This check-in is no longer available."));}
    let (version,completed)=tx.query_row("SELECT version,completed FROM tasks WHERE id=?1",[&input.task_id],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,bool>(1)?))).optional()?.ok_or_else(||invalid("This task is no longer available."))?;
    if version!=input.expected_version{return Err(invalid("This task changed. Reload and review it before confirming."));}
    match input.action.as_str() {
      "complete"=>{
        if !completed {
          let at=input.completed_at.as_deref().map(|s|crate::parse_utc(s).ok_or_else(||invalid("Invalid completion time."))).transpose()?.unwrap_or(now);
          if at>now{return Err(invalid("Completion time cannot be in the future."));}
          // Work may have finished before the local record was imported. Keep
          // the student's assertion and the entry time as separate history.
          tx.execute("UPDATE tasks SET completed=1,completed_at=?2,version=version+1 WHERE id=?1",params![input.task_id,at.to_rfc3339()])?;
          tx.execute("UPDATE plan_blocks SET completed=1 WHERE task_id=?1",[&input.task_id])?;
          crate::invalidate_generated_plan_undo(&tx)?;crate::mutation(&tx,"task",&input.task_id,"completion_changed","{}")?;
          tx.execute("INSERT INTO assignment_history_local(task_id,kind,completed_at,recorded_at) VALUES(?1,'student_confirmed_completion',?2,?3)",params![input.task_id,at.to_rfc3339(),now.to_rfc3339()])?;
        }
      },
      "in_progress"|"not_completed"=>{
        if completed{return Err(invalid("This task is already complete. Reopen it in Work before changing progress."));}
        let details=crate::task_details::load(&tx,&input.task_id)?;
        crate::task_details::save_in(&tx,&input.task_id,&crate::task_details::TaskDetailsInput{expected_revision:details.revision,description:details.description,tags:details.tags,progress:if input.action=="in_progress"{crate::task_details::TaskProgress::InProgress}else{crate::task_details::TaskProgress::Todo},subtasks:details.subtasks})?;
      },
      "rescheduled"=>{
        if !tx.query_row("SELECT t.due_at IS NOT i.initial_due_at FROM tasks t JOIN checkin_items_local i ON i.task_id=t.id WHERE i.day=?1 AND t.id=?2",params![input.day,input.task_id],|r|r.get::<_,bool>(0))?{return Err(invalid("Review and save the changed deadline in Work first."));}
      },
      _=>return Err(invalid("Unknown task response."))
    }
    tx.execute("UPDATE checkin_items_local SET response=?3,responded_at=?4 WHERE day=?1 AND task_id=?2",params![input.day,input.task_id,input.action,now.to_rfc3339()])?;
    tx.execute("UPDATE day_checkins_local SET status='resolved' WHERE day=?1 AND NOT EXISTS(SELECT 1 FROM checkin_items_local i LEFT JOIN tasks t ON t.id=i.task_id WHERE i.day=?1 AND i.response IS NULL AND COALESCE(t.completed,0)=0 AND t.id IS NOT NULL)",[input.day])?;
    tx.commit()?;Ok(())
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct AssignmentHistory { pub kind:String,pub due_at:Option<String>,pub completed_at:Option<String>,pub recorded_at:String }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct StreakEntry {pub task_id:String,pub title:String,pub kind:String,pub due_at:String,pub completed_at:Option<String>,pub outcome:String,pub frozen:bool,pub legacy:bool,pub deleted:bool,pub current_due_at:Option<String>,pub history:Vec<AssignmentHistory>}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Streak {pub count:usize,pub entries:Vec<StreakEntry>}
pub fn streak(db:&Connection,now:DateTime<Utc>)->Result<Streak> {
    db.execute("UPDATE assignment_streak_local SET frozen=1 WHERE julianday(due_at)<=julianday(?1)",[now.to_rfc3339()])?;
    let mut query=db.prepare("SELECT s.task_id,s.title,s.kind,s.due_at,s.completed,s.completed_at,s.frozen,s.legacy,s.deleted,t.due_at FROM assignment_streak_local s LEFT JOIN tasks t ON t.id=s.task_id ORDER BY julianday(s.due_at),s.task_id")?;
    let mut entries=Vec::new();let mut count=0;
    for row in query.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,bool>(4)?,r.get::<_,Option<String>>(5)?,r.get::<_,bool>(6)?,r.get::<_,bool>(7)?,r.get::<_,bool>(8)?,r.get::<_,Option<String>>(9)?)))? {
      let(id,title,kind,due_at,completed,completed_at,frozen,legacy,deleted,current_due_at)=row?;
      let due=crate::parse_utc(&due_at);let at=completed_at.as_deref().and_then(crate::parse_utc);
      let outcome=if due.is_none()||completed&&(at.is_none()||at.is_some_and(|v|v>now)){"unknown"}else if completed{if at<=due{"on_time"}else{"late"}}else if due.is_some_and(|v|v<=now){"missing"}else{"pending"};
      match outcome {"on_time"=>count+=1,"late"|"missing"=>count=0,_=>{}}
      let mut history_query=db.prepare("SELECT kind,due_at,completed_at,recorded_at FROM assignment_history_local WHERE task_id=?1 ORDER BY sequence")?;
      let history=history_query.query_map([&id],|r|Ok(AssignmentHistory{kind:r.get(0)?,due_at:r.get(1)?,completed_at:r.get(2)?,recorded_at:r.get(3)?}))?.collect::<std::result::Result<Vec<_>,_>>()?;
      entries.push(StreakEntry{task_id:id,title,kind,due_at,completed_at,outcome:outcome.into(),frozen,legacy,deleted,current_due_at,history});
    }Ok(Streak{count,entries})
}

pub fn run_tick<R:tauri::Runtime>(app:&tauri::AppHandle<R>,state:&crate::AppState)->Result<()> {
    use tauri_plugin_notification::{NotificationExt,PermissionState};
    use tauri::Manager;
    if state.locked.load(std::sync::atomic::Ordering::Acquire){return Ok(());}
    // Foreground review waits for dialogs to close; avoid interrupting it with an OS prompt.
    if app.get_webview_window("main").is_some_and(|window| window.is_focused().unwrap_or(false)) { return Ok(()); }
    let db=state.db.lock().unwrap();let now=Utc::now();
    if db_setting(&db,"notifications_enabled","false")!="true"||!matches!(app.notification().permission_state().map_err(|e|AppError::Background(e.to_string()))?,PermissionState::Granted){return Ok(());}
    if let Some(day)=pending(&db,now,false)?{
      // Do not notify about a backlog: foreground recovery owns missed check-ins.
      if crate::parse_utc(&day.due_at).is_some_and(|due|now-due>Duration::minutes(10)){return Ok(());}
      let notified:bool=db.query_row("SELECT notified_at IS NOT NULL FROM day_checkins_local WHERE day=?1",[&day.day],|r|r.get(0))?;
      if !notified {
        let mut notification=app.notification().builder().title("Coqui daily check-in").body("Take a moment to review today's tasks in Today.");
        if let Some(sound)=crate::delight_preferences::reminder_sound_name(crate::delight_preferences::load(&db)?.reminder_sounds){notification=notification.sound(sound);}
        notification.show().map_err(|e|AppError::Background(e.to_string()))?;
        db.execute("UPDATE day_checkins_local SET notified_at=?2,offered_at=COALESCE(offered_at,?2) WHERE day=?1",params![day.day,now.to_rfc3339()])?;
      }
    }Ok(())
}

#[cfg(test)]
mod tests {
 use super::*;
 fn db()->(tempfile::TempDir,Connection,[u8;32]){
  let dir=tempfile::tempdir().unwrap();let key=crate::random_key();let db=crate::open_database(&dir.path().join("profile.db"),&key).unwrap();
  db.execute("INSERT OR REPLACE INTO student_profiles(id,name,timezone,onboarding_version,created_at,updated_at) VALUES(?1,'Student','America/Phoenix',2,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",[crate::profile::PROFILE_ID]).unwrap();
  db.execute("INSERT INTO settings(key,value) VALUES('timezone','America/Phoenix') ON CONFLICT(key) DO UPDATE SET value=excluded.value",[]).unwrap();
  db.execute("DELETE FROM tasks",[]).unwrap();
  (dir,db,key)
 }
 fn task(db:&Connection,id:&str,kind:&str,due:&str){db.execute("INSERT INTO tasks(id,title,minutes,due_at,created_at,task_kind) VALUES(?1,?1,30,?2,'2026-01-01T00:00:00Z',?3)",params![id,due,kind]).unwrap();}
 fn now()->DateTime<Utc>{crate::parse_utc("2026-10-02T03:30:00Z").unwrap()}
 #[test] fn quick_notes_are_revision_checked_private_and_persisted(){
  let(dir,db,key)=db();let saved=save_note(&db,NoteInput{id:None,expected_revision:0,content:"Private sticky biology".into(),course_id:None,task_id:None,pinned:true}).unwrap();let id=&saved[0].id;
  assert_eq!(notes(&db,"BIOLOGY").unwrap().len(),1);
  assert!(save_note(&db,NoteInput{id:Some(id.clone()),expected_revision:0,content:"lost".into(),course_id:None,task_id:None,pinned:false}).is_err());
  assert!(delete_note(&db,id,0).is_err());drop(db);
  let reopened=crate::open_database(&dir.path().join("profile.db"),&key).unwrap();assert_eq!(notes(&reopened,"").unwrap()[0].revision,1);assert!(notes(&reopened,"").unwrap()[0].pinned);
  assert!(!std::fs::read(dir.path().join("profile.db")).unwrap().windows(14).any(|v|v==b"Private sticky"));
  delete_note(&reopened,id,1).unwrap();assert!(notes(&reopened,"").unwrap().is_empty());
 }
 #[test] fn streak_uses_actual_times_eligibility_and_deadline_order(){
  let(_dir,db,_)=db();task(&db,"a","assignment","2026-10-01T23:00:00Z");task(&db,"b","quiz","2026-10-02T01:00:00Z");task(&db,"r","reading","2026-10-01T21:00:00Z");task(&db,"generic","task","2026-10-01T21:00:00Z");
  db.execute("UPDATE tasks SET completed=1,completed_at=due_at WHERE id IN ('a','b')",[]).unwrap();
  assert_eq!(streak(&db,now()).unwrap().count,2);assert_eq!(streak(&db,now()).unwrap().entries.len(),2);
  task(&db,"missing","paper","2026-10-02T03:00:00Z");assert_eq!(streak(&db,now()).unwrap().count,0);
  db.execute("UPDATE tasks SET completed=1,completed_at='2026-10-02T03:01:00Z' WHERE id='missing'",[]).unwrap();assert_eq!(streak(&db,now()).unwrap().entries[2].outcome,"late");
  task(&db,"future","lab","2026-11-01T01:00:00Z");assert_eq!(streak(&db,now()).unwrap().entries.last().unwrap().outcome,"pending");
  db.execute("UPDATE tasks SET completed=1,completed_at=NULL WHERE id='a'",[]).unwrap();assert_eq!(streak(&db,now()).unwrap().entries[0].outcome,"unknown");
 }
 #[test] fn streak_freezes_and_retains_reopen_delete_and_reschedule_history(){
  let(_dir,db,_)=db();task(&db,"a","assignment","2099-10-01T23:00:00Z");
  db.execute("UPDATE tasks SET due_at='2099-10-02T23:00:00Z' WHERE id='a'",[]).unwrap();assert_eq!(streak(&db,now()).unwrap().entries[0].due_at,"2099-10-02T23:00:00Z");
  db.execute("UPDATE tasks SET completed=1,completed_at='2099-10-02T23:00:00Z' WHERE id='a'",[]).unwrap();
  db.execute("UPDATE tasks SET due_at='2099-10-09T23:00:00Z',task_kind='reading' WHERE id='a'",[]).unwrap();assert_eq!(streak(&db,now()).unwrap().entries[0].due_at,"2099-10-02T23:00:00Z");
  db.execute("UPDATE tasks SET completed=0,completed_at=NULL WHERE id='a'",[]).unwrap();assert_eq!(streak(&db,now()).unwrap().entries[0].outcome,"pending");
  db.execute("DELETE FROM tasks WHERE id='a'",[]).unwrap();assert!(streak(&db,now()).unwrap().entries[0].deleted);
  assert!(db.query_row("SELECT COUNT(*) FROM assignment_history_local WHERE task_id='a'",[],|r|r.get::<_,i64>(0)).unwrap()>=4);
 }
 #[test] fn checkin_snapshots_survive_replanning_snooze_dismiss_and_restart(){
  let(dir,db,key)=db();task(&db,"due","assignment","2026-10-02T02:00:00Z");task(&db,"planned","task","2099-01-01T00:00:00Z");
  db.execute("INSERT INTO plan_blocks(id,task_id,starts_at,ends_at,title,kind,reason_codes) VALUES('block','planned','2026-10-01T19:00:00Z','2026-10-01T20:00:00Z','plan','study','[]')",[]).unwrap();
  save_settings(&db,CheckinSettings{enabled:true,follow_rhythm:false,..Default::default()}).unwrap();
  capture_days(&db,now()-Duration::hours(2)).unwrap();db.execute("DELETE FROM plan_blocks",[]).unwrap();
  let day=pending(&db,now(),true).unwrap().unwrap();assert_eq!(day.day,"2026-10-01");assert_eq!(day.items.len(),2);
  control(&db,&day.day,"snooze",now()).unwrap();assert!(pending(&db,now()+Duration::minutes(29),true).unwrap().is_none());
  assert!(pending(&db,now()+Duration::minutes(30),true).unwrap().is_some());
  control(&db,&day.day,"dismiss",now()).unwrap();drop(db);let db=crate::open_database(&dir.path().join("profile.db"),&key).unwrap();assert!(pending(&db,now(),true).unwrap().is_none());
 }
 #[test] fn missed_checkins_expire_and_do_not_stack(){
  let(_dir,db,_)=db();task(&db,"past","assignment","2026-09-29T23:00:00Z");save_settings(&db,CheckinSettings{enabled:true,follow_rhythm:false,..Default::default()}).unwrap();capture_days(&db,now()-Duration::days(3)).unwrap();assert!(pending(&db,now(),true).unwrap().is_none());
  task(&db,"today","assignment","2026-10-02T02:00:00Z");assert!(pending(&db,now(),true).unwrap().is_some());
  assert_eq!(db.query_row("SELECT status FROM day_checkins_local WHERE day='2026-09-28'",[],|r|r.get::<_,String>(0)).unwrap(),"expired");
 }
 #[test] fn quiet_hours_onboarding_and_disabled_preferences_gate_checkins(){
  let(_dir,db,_)=db();task(&db,"due","assignment","2026-10-02T02:00:00Z");assert!(pending(&db,now(),true).unwrap().is_none());
  save_settings(&db,CheckinSettings{enabled:true,follow_rhythm:false,..Default::default()}).unwrap();assert!(pending(&db,crate::parse_utc("2026-10-02T06:00:00Z").unwrap(),true).unwrap().is_none());
  db.execute("UPDATE student_profiles SET onboarding_version=0",[]).unwrap();db.execute("DELETE FROM day_checkins_local",[]).unwrap();assert!(pending(&db,now(),true).unwrap().is_none());
 }
 #[test] fn unpersonalized_defaults_keep_eight_pm_and_changed_rhythm_recalculates_before_offer(){
  let(_dir,db,_)=db();save_settings(&db,CheckinSettings{enabled:true,..Default::default()}).unwrap();
  db.execute("INSERT INTO planning_preferences(profile_id,sleep_start,sleep_end,max_session_minutes,break_minutes,transition_minutes,default_commute_minutes) VALUES(?1,'23:00','07:00',50,10,5,15)",[crate::profile::PROFILE_ID]).unwrap();
  task(&db,"due","assignment","2026-10-02T02:00:00Z");capture_days(&db,now()-Duration::hours(2)).unwrap();
  assert_eq!(db.query_row("SELECT due_at FROM day_checkins_local WHERE day='2026-10-01'",[],|r|r.get::<_,String>(0)).unwrap(),"2026-10-02T03:00:00+00:00");
  db.execute("UPDATE planning_preferences SET sleep_start='22:00',version=version+1",[]).unwrap();capture_days(&db,now()-Duration::hours(2)).unwrap();
  assert_eq!(db.query_row("SELECT due_at FROM day_checkins_local WHERE day='2026-10-01'",[],|r|r.get::<_,String>(0)).unwrap(),"2026-10-02T04:30:00+00:00");
 }
 #[test] fn daylight_saving_and_overnight_rhythm_use_student_time(){
  let gap=local_at(NaiveDate::from_ymd_opt(2026,3,8).unwrap(),150,chrono_tz::America::New_York).unwrap();assert_eq!(gap.to_rfc3339(),"2026-03-08T07:00:00+00:00");
  let fold=local_at(NaiveDate::from_ymd_opt(2026,11,1).unwrap(),90,chrono_tz::America::New_York).unwrap();assert_eq!(fold.to_rfc3339(),"2026-11-01T05:30:00+00:00");
  let(_dir,db,_)=db();save_settings(&db,CheckinSettings{enabled:true,..Default::default()}).unwrap();
  db.execute("INSERT INTO planning_preferences(profile_id,sleep_start,sleep_end,max_session_minutes,break_minutes,transition_minutes,default_commute_minutes) VALUES(?1,'02:00','10:00',50,10,5,15) ON CONFLICT(profile_id) DO UPDATE SET sleep_start='02:00',sleep_end='10:00'",[crate::profile::PROFILE_ID]).unwrap();
  task(&db,"night","task","2099-01-01T00:00:00Z");db.execute("INSERT INTO plan_blocks(id,task_id,starts_at,ends_at,title,kind,reason_codes) VALUES('night','night','2026-10-02T07:00:00Z','2026-10-02T08:00:00Z','night','study','[]')",[]).unwrap();capture_days(&db,crate::parse_utc("2026-10-02T08:00:00Z").unwrap()).unwrap();
  let due:String=db.query_row("SELECT due_at FROM day_checkins_local WHERE day='2026-10-01'",[],|r|r.get(0)).unwrap();assert_eq!(due,"2026-10-02T08:30:00+00:00");
  save_settings(&db,CheckinSettings{enabled:true,follow_rhythm:false,time:"01:00".into(),..Default::default()}).unwrap();capture_days(&db,crate::parse_utc("2026-10-02T06:00:00Z").unwrap()).unwrap();let manual:String=db.query_row("SELECT due_at FROM day_checkins_local WHERE day='2026-10-01'",[],|r|r.get(0)).unwrap();assert_eq!(manual,"2026-10-02T08:00:00+00:00");
 }
 #[test] fn streak_ties_history_and_milestones_survive_restart(){
  let(dir,db,key)=db();
  for id in ["e","d","c","b","a"] {task(&db,id,"assignment","2026-10-01T23:00:00Z");db.execute("UPDATE tasks SET completed=1,completed_at=due_at WHERE id=?1",[id]).unwrap();}
  let result=streak(&db,now()).unwrap();assert_eq!(result.entries.iter().map(|e|e.task_id.as_str()).collect::<Vec<_>>(),vec!["a","b","c","d","e"]);assert_eq!(result.count,5);assert_eq!(result.entries[0].history[0].kind,"completed");assert!(result.entries[0].history[0].completed_at.is_some());assert!(claim_celebration(&db,now()).unwrap());assert!(!claim_celebration(&db,now()).unwrap());
  drop(db);let db=crate::open_database(&dir.path().join("profile.db"),&key).unwrap();assert_eq!(streak(&db,now()).unwrap().count,5);assert!(!claim_celebration(&db,now()).unwrap());
 }
 #[test] fn responses_are_confirmed_revision_checked_and_do_not_change_deadlines(){
  let(_dir,db,_)=db();task(&db,"due","assignment","2026-10-02T02:00:00Z");save_settings(&db,CheckinSettings{enabled:true,follow_rhythm:false,..Default::default()}).unwrap();pending(&db,now(),true).unwrap();
  let response=|action:&str,version:i64,at:Option<&str>|Response{day:"2026-10-01".into(),task_id:"due".into(),action:action.into(),expected_version:version,completed_at:at.map(Into::into)};
  assert!(respond(&db,response("complete",0,None),now()).is_err());
  task(&db,"progress","assignment","2026-10-02T02:00:00Z");
  db.execute("INSERT INTO checkin_items_local(day,task_id,title) VALUES('2026-10-01','progress','progress')",[]).unwrap();
  respond(&db,Response{day:"2026-10-01".into(),task_id:"progress".into(),action:"in_progress".into(),expected_version:1,completed_at:None},now()).unwrap();assert_eq!(crate::task_details::load(&db,"progress").unwrap().progress,crate::task_details::TaskProgress::InProgress);
  assert!(respond(&db,response("rescheduled",1,None),now()).is_err());
  db.execute("UPDATE tasks SET created_at='2026-10-02T02:30:00Z' WHERE id='due'",[]).unwrap();
  respond(&db,response("complete",1,Some("2026-10-02T01:00:00Z")),now()).unwrap();assert_eq!(streak(&db,now()).unwrap().entries.iter().find(|e|e.task_id=="due").unwrap().outcome,"on_time");
  assert_eq!(db.query_row("SELECT due_at FROM tasks WHERE id='due'",[],|r|r.get::<_,String>(0)).unwrap(),"2026-10-02T02:00:00Z");
  assert_eq!(db.query_row("SELECT COUNT(*) FROM assignment_history_local WHERE kind='student_confirmed_completion'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
 }
}

pub fn claim_celebration(db:&Connection,now:DateTime<Utc>)->Result<bool>{
    if !settings(db)?.streak_visible{return Ok(false);}
    let count=streak(db,now)?.count;
    if count==0||count%5!=0{return Ok(false);}
    let last=db_setting(db,"last_assignment_streak_milestone","0").parse::<usize>().unwrap_or(0);
    if count<=last{return Ok(false);}
    db.execute("INSERT INTO settings(key,value) VALUES('last_assignment_streak_milestone',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[count.to_string()])?;Ok(true)
}
