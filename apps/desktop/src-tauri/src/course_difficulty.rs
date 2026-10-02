use crate::{AppError, Result, AppState};
use rusqlite::{Connection, params, OptionalExtension};
use serde::{Serialize, Deserialize};
use chrono::Utc;
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Difficulty {pub id:String,pub course_id:String,pub concept:String,pub note:String,pub confidence:Option<i64>,pub easier:bool,pub created_at:String,pub updated_at:String,pub revision:i64}
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Input {pub id:Option<String>,pub course_id:String,pub concept:String,pub note:String,pub confidence:Option<i64>,pub easier:bool,pub expected_revision:i64}
pub fn migrate(db:&Connection)->Result<()>{db.execute_batch("CREATE TABLE IF NOT EXISTS course_difficulties_local(id TEXT PRIMARY KEY,course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,concept TEXT NOT NULL,note TEXT NOT NULL,confidence INTEGER,easier INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,revision INTEGER NOT NULL);")?;Ok(())}
pub fn list(db:&Connection,course:&str)->Result<Vec<Difficulty>>{let mut q=db.prepare("SELECT id,course_id,concept,note,confidence,easier,created_at,updated_at,revision FROM course_difficulties_local WHERE course_id=?1 ORDER BY updated_at DESC,id")?;let rows=q.query_map([course],|r|Ok(Difficulty{id:r.get(0)?,course_id:r.get(1)?,concept:r.get(2)?,note:r.get(3)?,confidence:r.get(4)?,easier:r.get(5)?,created_at:r.get(6)?,updated_at:r.get(7)?,revision:r.get(8)?}))?.collect::<std::result::Result<Vec<_>,_>>()?;Ok(rows)}
pub fn save(db:&Connection,input:Input)->Result<Vec<Difficulty>>{
 if input.concept.trim().is_empty()||input.concept.len()>200||input.note.len()>2000||input.confidence.is_some_and(|v|!(1..=5).contains(&v)){return Err(AppError::Invalid("Enter a concept, a note up to 2,000 characters, and optional confidence from 1 to 5".into()));}
 let now=Utc::now().to_rfc3339();let tx=db.unchecked_transaction()?;
 if let Some(id)=input.id {let changed=tx.execute("UPDATE course_difficulties_local SET concept=?3,note=?4,confidence=?5,easier=?6,updated_at=?7,revision=revision+1 WHERE id=?1 AND course_id=?2 AND revision=?8",params![id,input.course_id,input.concept.trim(),input.note,input.confidence,input.easier,now,input.expected_revision])?;if changed!=1{return Err(AppError::Invalid("This concept changed. Reload it before saving; your draft is kept.".into()));}}
 else{if input.expected_revision!=0{return Err(AppError::Invalid("New concept must start at revision zero".into()));}tx.execute("INSERT INTO course_difficulties_local(id,course_id,concept,note,confidence,easier,created_at,updated_at,revision) VALUES(?1,?2,?3,?4,?5,?6,?7,?7,1)",params![uuid::Uuid::new_v4().to_string(),input.course_id,input.concept.trim(),input.note,input.confidence,input.easier,now])?;}
 tx.commit()?;list(db,&input.course_id)
}
#[tauri::command]
pub fn list_course_difficulties(state:tauri::State<AppState>,course_id:String)->Result<Vec<Difficulty>>{state.require_unlocked()?;list(&state.db.lock().unwrap(),&course_id)}
#[tauri::command]
pub fn save_course_difficulty(state:tauri::State<AppState>,input:Input)->Result<Vec<Difficulty>>{state.require_unlocked()?;save(&state.db.lock().unwrap(),input)}
#[tauri::command]
pub fn delete_course_difficulties(state:tauri::State<AppState>,course_id:String,records:Vec<(String,i64)>)->Result<Vec<Difficulty>>{state.require_unlocked()?;let db=state.db.lock().unwrap();let tx=db.unchecked_transaction()?;for(id,revision)in records{let current=tx.query_row("SELECT revision FROM course_difficulties_local WHERE id=?1 AND course_id=?2",params![id,course_id],|r|r.get::<_,i64>(0)).optional()?;if current!=Some(revision){return Err(AppError::Invalid("A concept changed. Reload before clearing.".into()));}tx.execute("DELETE FROM course_difficulties_local WHERE id=?1",[id])?;}tx.commit()?;list(&db,&course_id)}
#[cfg(test)]mod tests{use super::*;#[test]fn authored_records_and_stale_edits(){let db=Connection::open_in_memory().unwrap();db.execute_batch("CREATE TABLE courses(id TEXT PRIMARY KEY);INSERT INTO courses VALUES('course');").unwrap();migrate(&db).unwrap();let records=save(&db,Input{id:None,course_id:"course".into(),concept:"Recursion".into(),note:"Base cases".into(),confidence:Some(2),easier:false,expected_revision:0}).unwrap();let r=&records[0];assert_eq!(r.revision,1);assert!(!r.easier);assert!(save(&db,Input{id:Some(r.id.clone()),course_id:"course".into(),concept:r.concept.clone(),note:r.note.clone(),confidence:Some(5),easier:true,expected_revision:0}).is_err());}}
