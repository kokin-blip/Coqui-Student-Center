//! Device-local task metadata. Never add these tables to canonical sync snapshots.
//! The profile database and vault already provide encryption and backup coverage.
use crate::{AppError, Result};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskProgress { Todo, InProgress }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskSubtask { pub id: String, pub title: String, pub completed: bool }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskAttachment {
    pub document_id: String,
    pub file_name: String,
    pub mime: String,
    pub attached_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskDetails {
    pub task_id: String,
    pub revision: i64,
    pub description: String,
    pub tags: Vec<String>,
    pub progress: TaskProgress,
    pub subtasks: Vec<TaskSubtask>,
    pub attachments: Vec<TaskAttachment>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskDetailsInput {
    pub expected_revision: i64,
    pub description: String,
    pub tags: Vec<String>,
    pub progress: TaskProgress,
    pub subtasks: Vec<TaskSubtask>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskActivity {
    pub sequence: i64,
    pub task_id: String,
    pub kind: String,
    pub origin: String,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskActivityPage {
    pub entries: Vec<TaskActivity>,
    pub next_cursor: Option<i64>,
}

pub fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch("SAVEPOINT task_details_migration;
        CREATE TABLE IF NOT EXISTS task_details_local(
            task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
            revision INTEGER NOT NULL DEFAULT 0,
            description TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
            progress TEXT NOT NULL DEFAULT 'todo' CHECK(progress IN ('todo','in_progress')));
        CREATE TABLE IF NOT EXISTS task_subtasks_local(
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            id TEXT NOT NULL, position INTEGER NOT NULL, title TEXT NOT NULL,
            completed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(task_id,id));
        CREATE TABLE IF NOT EXISTS task_attachments_local(
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            document_id TEXT NOT NULL REFERENCES documents(id), attached_at TEXT NOT NULL,
            PRIMARY KEY(task_id,document_id));
        CREATE INDEX IF NOT EXISTS task_attachments_document_idx ON task_attachments_local(document_id);
        CREATE TABLE IF NOT EXISTS task_private_documents(
            document_id TEXT PRIMARY KEY REFERENCES documents(id));
        CREATE TABLE IF NOT EXISTS task_activity_local(
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            kind TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin IN ('local','received')),
            created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS task_activity_page_idx ON task_activity_local(task_id,sequence DESC);
        CREATE TRIGGER IF NOT EXISTS task_local_cleanup BEFORE DELETE ON tasks BEGIN
            DELETE FROM task_details_local WHERE task_id=OLD.id;
            DELETE FROM task_subtasks_local WHERE task_id=OLD.id;
            DELETE FROM task_attachments_local WHERE task_id=OLD.id;
            DELETE FROM task_activity_local WHERE task_id=OLD.id;
        END;
        RELEASE task_details_migration;")?;
    Ok(())
}

fn require_task(conn: &Connection, id: &str) -> Result<()> {
    if !conn.query_row("SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1)", [id], |r| r.get::<_, bool>(0))? {
        return Err(AppError::Invalid("This task is no longer available".into()));
    }
    Ok(())
}

pub fn load(conn: &Connection, id: &str) -> Result<TaskDetails> {
    require_task(conn, id)?;
    let stored = conn.query_row("SELECT revision,description,tags,progress FROM task_details_local WHERE task_id=?1", [id], |r| {
        Ok((r.get::<_,i64>(0)?, r.get::<_,String>(1)?, r.get::<_,String>(2)?, r.get::<_,String>(3)?))
    }).optional()?;
    let (revision, description, tags, progress) = stored.unwrap_or((0, String::new(), "[]".into(), "todo".into()));
    let tags = serde_json::from_str(&tags).map_err(|_| AppError::Invalid("Task details need recovery".into()))?;
    let mut subtasks = conn.prepare("SELECT id,title,completed FROM task_subtasks_local WHERE task_id=?1 ORDER BY position,id")?;
    let subtasks = subtasks.query_map([id], |r| Ok(TaskSubtask { id:r.get(0)?, title:r.get(1)?, completed:r.get(2)? }))?.collect::<std::result::Result<Vec<_>,_>>()?;
    let mut attachments = conn.prepare("SELECT a.document_id,d.file_name,d.mime,a.attached_at FROM task_attachments_local a JOIN documents d ON d.id=a.document_id WHERE a.task_id=?1 ORDER BY a.attached_at,a.document_id")?;
    let attachments = attachments.query_map([id], |r| Ok(TaskAttachment { document_id:r.get(0)?, file_name:r.get(1)?, mime:r.get(2)?, attached_at:r.get(3)? }))?.collect::<std::result::Result<Vec<_>,_>>()?;
    Ok(TaskDetails { task_id:id.into(), revision, description, tags, progress:if progress=="in_progress" {TaskProgress::InProgress} else {TaskProgress::Todo}, subtasks, attachments })
}

fn conflict() -> AppError { AppError::Invalid("Task details changed. Reload and review the latest version before saving.".into()) }

pub fn require_revision(conn: &Connection, id: &str, expected: i64) -> Result<()> {
    require_task(conn, id)?;
    let revision = conn.query_row("SELECT revision FROM task_details_local WHERE task_id=?1", [id], |r| r.get::<_,i64>(0)).optional()?.unwrap_or(0);
    if expected < 0 || revision != expected { return Err(conflict()); }
    Ok(())
}

fn advance_revision(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("INSERT INTO task_details_local(task_id,revision) VALUES(?1,1) ON CONFLICT(task_id) DO UPDATE SET revision=revision+1", [id])?;
    Ok(())
}

/// Only safe action categories are kept; no copied titles, descriptions or file paths.
pub fn record_activity(conn: &Connection, id: &str, kind: &str, origin: &str) -> Result<()> {
    conn.execute("INSERT INTO task_activity_local(task_id,kind,origin,created_at) SELECT id,?2,?3,?4 FROM tasks WHERE id=?1", params![id,kind,origin,Utc::now().to_rfc3339()])?;
    Ok(())
}

pub fn save(conn: &Connection, id: &str, input: &TaskDetailsInput) -> Result<TaskDetails> {
    let mut ids = HashSet::new();
    let mut tags = HashSet::new();
    if input.description.chars().count()>20_000 || input.tags.len()>30 || input.subtasks.len()>200
        || input.tags.iter().any(|t| t.trim().is_empty() || t.chars().count()>60 || !tags.insert(t.trim().to_lowercase()))
        || input.subtasks.iter().any(|s| Uuid::parse_str(&s.id).is_err() || !ids.insert(&s.id) || s.title.trim().is_empty() || s.title.chars().count()>500) {
        return Err(AppError::Invalid("Check task details: description up to 20,000 characters, 30 unique tags and 200 named subtasks.".into()));
    }
    let tx = conn.unchecked_transaction()?;
    require_revision(&tx,id,input.expected_revision)?;
    let before = load(&tx,id)?;
    let tags:Vec<String> = input.tags.iter().map(|s|s.trim().into()).collect();
    let subtasks:Vec<TaskSubtask> = input.subtasks.iter().map(|s|TaskSubtask {id:s.id.clone(),title:s.title.trim().into(),completed:s.completed}).collect();
    if before.description==input.description && before.tags==tags && before.progress==input.progress && before.subtasks==subtasks {
        tx.commit()?; return Ok(before);
    }
    advance_revision(&tx,id)?;
    let encoded_tags = serde_json::to_string(&tags).map_err(|_|AppError::Invalid("Task tags could not be saved".into()))?;
    tx.execute("UPDATE task_details_local SET description=?2,tags=?3,progress=?4 WHERE task_id=?1", params![id,input.description,encoded_tags,match input.progress {TaskProgress::Todo=>"todo",TaskProgress::InProgress=>"in_progress"}])?;
    tx.execute("DELETE FROM task_subtasks_local WHERE task_id=?1", [id])?;
    for (position,subtask) in subtasks.iter().enumerate() {
        tx.execute("INSERT INTO task_subtasks_local(task_id,id,position,title,completed) VALUES(?1,?2,?3,?4,?5)", params![id,subtask.id,position as i64,subtask.title,subtask.completed])?;
    }
    for (changed,kind) in [(before.description!=input.description,"description_updated"),(before.tags!=tags,"tags_updated"),(before.progress!=input.progress,"progress_updated"),(before.subtasks!=subtasks,"subtasks_updated")] {
        if changed { record_activity(&tx,id,kind,"local")?; }
    }
    let result = load(&tx,id)?;
    tx.commit()?;
    Ok(result)
}

/// Caller owns the transaction spanning encrypted document insertion and linking.
pub fn attach(conn: &Connection, id: &str, document: &str, revision: i64) -> Result<TaskDetails> {
    require_revision(conn,id,revision)?;
    let available:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM documents WHERE id=?1 AND vault_path!='' AND content_shredded=0)",[document],|r|r.get(0))?;
    if !available { return Err(AppError::Invalid("This file is no longer in the vault".into())); }
    if conn.query_row("SELECT EXISTS(SELECT 1 FROM task_attachments_local WHERE task_id=?1 AND document_id=?2)",params![id,document],|r|r.get::<_,bool>(0))? {
        return load(conn,id);
    }
    let count:i64=conn.query_row("SELECT COUNT(*) FROM task_attachments_local WHERE task_id=?1",[id],|r|r.get(0))?;
    if count>=100 {return Err(AppError::Invalid("A task can have up to 100 attached files".into()));}
    if conn.execute("INSERT OR IGNORE INTO task_attachments_local(task_id,document_id,attached_at) VALUES(?1,?2,?3)",params![id,document,Utc::now().to_rfc3339()])?>0 {
        advance_revision(conn,id)?;
        record_activity(conn,id,"attachment_added","local")?;
    }
    load(conn,id)
}

pub fn detach(conn: &Connection, id: &str, document: &str, revision: i64) -> Result<TaskDetails> {
    let tx=conn.unchecked_transaction()?;
    require_revision(&tx,id,revision)?;
    if tx.execute("DELETE FROM task_attachments_local WHERE task_id=?1 AND document_id=?2",params![id,document])?>0 {
        advance_revision(&tx,id)?;
        record_activity(&tx,id,"attachment_removed","local")?;
    }
    let result=load(&tx,id)?;
    tx.commit()?;
    // Detaching never shreds the shared vault document or clears its local-only marker.
    Ok(result)
}

pub fn activity(conn: &Connection, id: &str, before: Option<i64>, limit: usize) -> Result<TaskActivityPage> {
    require_task(conn,id)?;
    if limit==0 || limit>100 || before.is_some_and(|v|v<=0) {return Err(AppError::Invalid("Choose a valid activity page".into()));}
    let mut stmt=conn.prepare("SELECT sequence,task_id,kind,origin,created_at FROM task_activity_local WHERE task_id=?1 AND (?2 IS NULL OR sequence<?2) ORDER BY sequence DESC LIMIT ?3")?;
    let mut entries=stmt.query_map(params![id,before,(limit+1) as i64],|r|Ok(TaskActivity {sequence:r.get(0)?,task_id:r.get(1)?,kind:r.get(2)?,origin:r.get(3)?,created_at:r.get(4)?}))?.collect::<std::result::Result<Vec<_>,_>>()?;
    let more=entries.len()>limit;
    entries.truncate(limit);
    let next_cursor=if more {entries.last().map(|entry|entry.sequence)} else {None};
    Ok(TaskActivityPage {entries,next_cursor})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let conn=Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE tasks(id TEXT PRIMARY KEY,completed INTEGER DEFAULT 0); CREATE TABLE documents(id TEXT PRIMARY KEY,file_name TEXT,mime TEXT,vault_path TEXT,content_shredded INTEGER DEFAULT 0); INSERT INTO tasks(id) VALUES('task'); INSERT INTO documents VALUES('doc','private.txt','text/plain','encrypted.vault',0);").unwrap();
        migrate(&conn).unwrap(); conn
    }
    fn input() -> TaskDetailsInput { TaskDetailsInput { expected_revision:0, description:"A private description".into(),tags:vec!["Homework".into()],progress:TaskProgress::InProgress,subtasks:vec![TaskSubtask {id:Uuid::new_v4().to_string(),title:"Read chapter".into(),completed:true}]} }
    #[test]
    fn repeat_migration_preserves_details_and_subtasks_do_not_complete_parent() {
        let conn=db();let result=save(&conn,"task",&input()).unwrap();migrate(&conn).unwrap();
        assert_eq!(load(&conn,"task").unwrap(),result);
        assert!(!conn.query_row("SELECT completed FROM tasks",[],|r|r.get::<_,bool>(0)).unwrap());
        assert_eq!(activity(&conn,"task",None,100).unwrap().entries.len(),4);
    }
    #[test]
    fn stale_and_invalid_edits_are_atomic_and_noops_do_not_add_history() {
        let conn=db();let mut edit=input();save(&conn,"task",&edit).unwrap();
        edit.description="stale".into();assert!(save(&conn,"task",&edit).is_err());
        edit.expected_revision=1;edit.tags=vec!["same".into()," SAME ".into()];assert!(save(&conn,"task",&edit).is_err());
        let current=load(&conn,"task").unwrap();assert_eq!(current.description,"A private description");
        let noop=TaskDetailsInput {expected_revision:1,description:current.description,tags:current.tags,progress:current.progress,subtasks:current.subtasks};
        assert_eq!(save(&conn,"task",&noop).unwrap().revision,1);
        assert_eq!(activity(&conn,"task",None,100).unwrap().entries.len(),4);
    }
    #[test]
    fn pages_are_stable_and_deletion_cleans_local_rows_without_shredding_files() {
        let conn=db();save(&conn,"task",&input()).unwrap();attach(&conn,"task","doc",1).unwrap();
        let first=activity(&conn,"task",None,2).unwrap();let second=activity(&conn,"task",first.next_cursor,2).unwrap();
        assert!(first.entries[1].sequence>second.entries[0].sequence);
        assert!(detach(&conn,"task","doc",1).is_err());
        assert_eq!(detach(&conn,"task","doc",2).unwrap().revision,3);
        attach(&conn,"task","doc",3).unwrap();
        conn.execute("DELETE FROM tasks WHERE id='task'",[]).unwrap();
        for table in ["task_details_local","task_subtasks_local","task_attachments_local","task_activity_local"] {
            assert_eq!(conn.query_row(&format!("SELECT COUNT(*) FROM {table}"),[],|r|r.get::<_,i64>(0)).unwrap(),0);
        }
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM documents",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert!(load(&conn,"task").is_err());
    }
}
