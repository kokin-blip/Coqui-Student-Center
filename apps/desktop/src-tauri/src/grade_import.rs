//! Grade-only, local extraction. This module never invokes the schedule parser.
use crate::{AppError, AppState, Result, StudyWorkspace, imports, study_workspace_in};
use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Row {
    pub id:String, pub title:String, pub score:Option<f64>, pub points_possible:Option<f64>,
    pub category_id:Option<String>, pub status:String, pub selected:bool, pub action:String,
    pub replace_id:Option<String>, pub source_id:Option<String>, pub evidence:String,
    pub locator:String, pub confidence:f64, pub warnings:Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Mapping { pub title:usize, pub score:Option<usize>, pub possible:Option<usize>, pub category:Option<usize> }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Preview {
    pub id:String, pub course_id:String, pub file_name:String, pub rows:Vec<Row>,
    pub headers:Vec<String>, pub records:Vec<Vec<String>>, pub student_row:Option<usize>,
    pub layout:String, pub mapping:Option<Mapping>, pub baseline:String, pub revision:i64,
    pub warnings:Vec<String>, pub source_image:Option<String>,
}
fn invalid(message:&str)->AppError { AppError::Invalid(message.into()) }
pub fn migrate(db:&Connection)->Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS grade_imports_local(id TEXT PRIMARY KEY,course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,source BLOB NOT NULL,payload TEXT NOT NULL,applied_at TEXT);
    CREATE TABLE IF NOT EXISTS grade_import_evidence_local(id TEXT PRIMARY KEY,grade_id TEXT NOT NULL REFERENCES grade_items(id) ON DELETE CASCADE,import_id TEXT NOT NULL REFERENCES grade_imports_local(id) ON DELETE CASCADE,source_id TEXT,evidence TEXT NOT NULL,locator TEXT NOT NULL,confidence REAL NOT NULL,reviewed_row TEXT NOT NULL);")?; Ok(())
}
fn baseline(db:&Connection,course:&str)->Result<String> {
    let mut q=db.prepare("SELECT id,title,COALESCE(category_id,''),score,points_possible,status FROM grade_items WHERE course_id=?1 ORDER BY id")?;
    let rows=q.query_map([course],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<f64>>(3)?,r.get::<_,f64>(4)?,r.get::<_,String>(5)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
    let mut c=db.prepare("SELECT id,name,weight FROM grade_categories WHERE course_id=?1 ORDER BY id")?;
    let categories=c.query_map([course],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,f64>(2)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(&(rows,categories)).map_err(|_|invalid("Gradebook could not be read"))?)))
}
fn number(value:&str)->Option<f64>{let text=value.trim();if text.is_empty(){return None;}text.parse::<f64>().ok().filter(|n|n.is_finite()&&*n>=0.0)}
fn row(title:String,score:Option<f64>,possible:Option<f64>,evidence:String,locator:String,source_id:Option<String>,confidence:f64)->Row{
    let mut warnings=Vec::new();if possible.is_none(){warnings.push("Confirm points possible from the source".into());}if score.is_none(){warnings.push("Blank or unreadable earned points; never treated as zero".into());}
    Row{id:Uuid::new_v4().to_string(),title,score,points_possible:possible,category_id:None,status:"graded".into(),selected:warnings.is_empty()&&confidence>=0.85,action:"add".into(),replace_id:None,source_id,evidence,locator,confidence,warnings}
}
fn administrative(title:&str)->bool { let t=title.trim().to_ascii_lowercase(); t.is_empty()||["current score","final score","current grade","final grade","total","totals","points possible","student","id","sis user id","sis login id","section","unposted current score","unposted final score"].contains(&t.as_str())||t.ends_with(" current score")||t.ends_with(" final score")||t.ends_with(" current grade")||t.ends_with(" final grade")||t.ends_with(" unposted current score")||t.ends_with(" unposted final score") }
fn find(headers:&[String],names:&[&str])->Option<usize>{headers.iter().position(|h|names.contains(&h.trim().to_ascii_lowercase().as_str()))}
fn parse_csv(bytes:&[u8])->Result<(Vec<String>,Vec<Vec<String>>)> {
    let mut reader=csv::ReaderBuilder::new().flexible(true).from_reader(bytes);
    let headers=reader.headers().map_err(|_|invalid("CSV headers could not be read. Export a UTF-8 gradebook CSV."))?.iter().map(|s|s.trim_start_matches('\u{feff}').to_string()).collect::<Vec<_>>();
    if headers.len()>5000{return Err(invalid("CSV has too many columns"));}
    let records=reader.records().take(5001).map(|r|r.map(|r|r.iter().map(String::from).collect::<Vec<_>>()).map_err(|_|invalid("A CSV row is malformed. Correct it and retry."))).collect::<Result<Vec<_>>>()?;
    if records.len()>5000{return Err(invalid("Import at most 5,000 CSV rows at a time"));}Ok((headers,records))
}
fn parse_rows(preview:&Preview)->Vec<Row> {
    fn get(r:&[String],i:Option<usize>)->&str {i.and_then(|i|r.get(i)).map(String::as_str).unwrap_or("")}
    if preview.layout=="canvas_columns" {
        let Some(index)=preview.student_row else{return Vec::new()};let Some(student)=preview.records.get(index)else{return Vec::new()};
        if student.first().is_some_and(|s|s.eq_ignore_ascii_case("points possible")){return Vec::new();}
        let possible=preview.records.iter().find(|r|r.first().is_some_and(|s|s.trim().eq_ignore_ascii_case("points possible")));
        preview.headers.iter().enumerate().filter(|(i,title)|*i>=4&&!administrative(title)).map(|(i,title)| {
            let mut r=row(title.clone(),number(get(student,Some(i))),possible.and_then(|p|number(get(p,Some(i)))),format!("{}: {} / {}",title,get(student,Some(i)),possible.map(|p|get(p,Some(i))).unwrap_or("not reported")),format!("CSV row {}, column {}",index+2,i+1),Some(format!("canvas:{}",regex::Regex::new(r"\((\d+)\)").unwrap().captures(title).map(|c|c[1].to_string()).unwrap_or_else(||title.clone()))),1.0);
            // Percentage/category summary columns are not assignments.
            if !title.contains('('){r.selected=false;r.warnings.push("Confirm this column is an assignment, not a category summary".into());} r
        }).collect()
    }else if let Some(mapping)=&preview.mapping {
        preview.records.iter().enumerate().filter_map(|(i,record)| {let title=get(record,Some(mapping.title));if administrative(title){return None;}
            let mut r=row(title.into(),number(get(record,mapping.score)),number(get(record,mapping.possible)),record.join(" | "),format!("CSV row {}",i+2),find(&preview.headers,&["assignment id","assignment_id"]).and_then(|index|record.get(index)).filter(|value|!value.is_empty()).map(|id|format!("canvas:{id}")),1.0);
            if let Some(category)=mapping.category {let value=get(record,Some(category));if !value.is_empty(){r.warnings.push(format!("Source category: {value}. Select an existing category; no weight is imported."));}}
            Some(r)
        }).collect()
    }else{Vec::new()}
}
fn duplicates(db:&Connection,p:&mut Preview)->Result<()> {
    let mut q=db.prepare("SELECT id,title FROM grade_items WHERE course_id=?1")?;
    let existing=q.query_map([&p.course_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
    for row in &mut p.rows {
        let linked=if let Some(source_id)=&row.source_id {db.query_row("SELECT e.grade_id FROM grade_import_evidence_local e JOIN grade_items g ON g.id=e.grade_id WHERE g.course_id=?1 AND e.source_id=?2 LIMIT 1",params![p.course_id,source_id],|r|r.get::<_,String>(0)).optional()?}else{None};
        if let Some(id)=linked.or_else(||existing.iter().find(|(_,title)|title.trim().eq_ignore_ascii_case(row.title.trim())).map(|(id,_)|id.clone())) {row.selected=false;row.action="skip".into();row.replace_id=Some(id);row.warnings.push("Possible duplicate. Review and choose add, replace, or skip.".into());}
    }Ok(())
}
fn image_rows(segments:&[imports::Segment])->Vec<Row> {
    let fraction=regex::Regex::new(r"(?P<score>\d+(?:\.\d+)?)\s*/\s*(?P<possible>\d+(?:\.\d+)?)").unwrap();
    let mut result=Vec::new();
    for segment in segments {
        // Preserve geometry: read rows in y order and words in x order, never schedule candidates.
        let mut tokens=segment.tokens.iter().collect::<Vec<_>>();tokens.sort_by_key(|t|(t.center_y(),t.left));
        let mut lines:Vec<Vec<&imports::OcrToken>>=Vec::new();
        for token in tokens {if let Some(line)=lines.last_mut().filter(|line|(line[0].center_y()-token.center_y()).abs()<=token.height.max(8)/2){line.push(token);}else{lines.push(vec![token]);}}
        let header=lines.iter().find_map(|line|{let score=line.iter().find(|t|matches!(t.text.to_ascii_lowercase().as_str(),"score"|"earned"));let possible=line.iter().find(|t|t.text.eq_ignore_ascii_case("possible"));match(score,possible){(Some(s),Some(p)) if s.left!=p.left=>Some((s.center_x(),p.center_x(),s.center_y().max(p.center_y()))),_=>None}});
        for mut line in lines {line.sort_by_key(|t|t.left);let text=line.iter().map(|t|t.text.as_str()).collect::<Vec<_>>().join(" ");if text.len()<2||administrative(&text){continue;}
            if header.is_some_and(|(_,_,y)|line[0].center_y()<=y+4){continue;}
            let found=fraction.captures(&text);
            let mut title=found.as_ref().map(|c|text[..c.get(0).unwrap().start()].trim().to_string()).unwrap_or_else(||text.clone());
            let mut score=found.as_ref().and_then(|c|number(&c["score"]));let mut possible=found.as_ref().and_then(|c|number(&c["possible"]));
            if found.is_none(){if let Some((sx,px,_))=header{let start=sx.min(px)-40;title=line.iter().filter(|t|t.center_x()<start).map(|t|t.text.as_str()).collect::<Vec<_>>().join(" ");let scores=line.iter().filter(|t|t.center_x()>=start).filter_map(|t|number(&t.text).map(|n|(t.center_x(),n))).collect::<Vec<_>>();score=scores.iter().filter(|(x,_)|(x-sx).abs()<(x-px).abs()).min_by_key(|(x,_)|(x-sx).abs()).map(|(_,n)|*n);possible=scores.iter().filter(|(x,_)|(x-px).abs()<(x-sx).abs()).min_by_key(|(x,_)|(x-px).abs()).map(|(_,n)|*n);}}
            if administrative(&title){continue;}
            if title.is_empty()||["assignment","name","score","grade","points"].iter().any(|h|title.to_ascii_lowercase()==*h){continue;}
            let left=line.iter().map(|t|t.left).min().unwrap_or(0);let top=line.iter().map(|t|t.top).min().unwrap_or(0);let right=line.iter().map(|t|t.right()).max().unwrap_or(0);let bottom=line.iter().map(|t|t.bottom()).max().unwrap_or(0);
            let mut r=row(title,score,possible,text.clone(),format!("{} · image region x={} y={} width={} height={}",segment.locator,left,top,right-left,bottom-top),None,line.iter().map(|t|t.confidence).fold(1.0,f64::min));
            r.selected=false;r.warnings.push("OCR row: confirm the title, earned points, and possible points before selecting".into());result.push(r);
        }
    }result
}
fn encode(p:&Preview)->Result<String>{serde_json::to_string(p).map_err(|_|invalid("Import draft could not be saved"))}
fn read(db:&Connection,id:&str)->Result<Preview>{let raw=db.query_row("SELECT payload FROM grade_imports_local WHERE id=?1 AND applied_at IS NULL",[id],|r|r.get::<_,String>(0)).optional()?.ok_or_else(||invalid("This import is no longer available for review"))?;serde_json::from_str(&raw).map_err(|_|invalid("Import draft could not be read"))}
#[tauri::command]
pub async fn preview_grade_import(state:tauri::State<'_,AppState>,course_id:String,file_name:String,bytes:Vec<u8>)->Result<Preview>{
    state.require_unlocked()?;let state=state.inner().clone();
    tauri::async_runtime::spawn_blocking(move||{
        if bytes.is_empty()||bytes.len() as u64>crate::MAX_IMPORT_BYTES{return Err(invalid("Choose a non-empty file of 25 MB or smaller"));}
        let name=std::path::Path::new(&file_name).file_name().and_then(|v|v.to_str()).unwrap_or("grades").to_string();
        let db=state.db.lock().unwrap();if !db.query_row("SELECT EXISTS(SELECT 1 FROM courses WHERE id=?1)",[&course_id],|r|r.get::<_,bool>(0))?{return Err(invalid("Choose an existing course"));}
        let base=baseline(&db,&course_id)?;drop(db);
        let mut p=Preview{id:Uuid::new_v4().to_string(),course_id,file_name:name.clone(),rows:vec![],headers:vec![],records:vec![],student_row:None,layout:"assignment_rows".into(),mapping:None,baseline:base,revision:1,warnings:vec![],source_image:None};
        if name.to_ascii_lowercase().ends_with(".csv") {
            let (headers,records)=parse_csv(&bytes)?;p.mapping=find(&headers,&["assignment","assignment name","title","name"]).map(|title|Mapping{title,score:find(&headers,&["score","earned","earned points","points earned"]),possible:find(&headers,&["points possible","possible","out of","points_possible"]),category:find(&headers,&["category","assignment group"])});
            if find(&headers,&["student"]).is_some()&&find(&headers,&["id","sis user id"]).is_some(){p.layout="canvas_columns".into();p.mapping=None;p.warnings.push("Choose the student row explicitly. Other students' data stays on this device.".into());}
            else if p.mapping.is_none(){p.warnings.push("Map the assignment, earned-points, and possible-points columns to continue.".into());}
            p.headers=headers;p.records=records;p.rows=parse_rows(&p);
        }else{
            let kind=imports::detect_document(&bytes,&name).map_err(|_|invalid("Use a gradebook CSV, PNG, or JPEG image"))?;
            if !matches!(kind,imports::DocumentKind::Image("image/png")|imports::DocumentKind::Image("image/jpeg")){return Err(invalid("Use a gradebook CSV, PNG, or JPEG image"));}
            use base64::Engine;
            p.source_image=Some(format!("data:{};base64,{}",kind.mime(),base64::engine::general_purpose::STANDARD.encode(&bytes)));
            p.layout="image".into();
            match imports::extract_grade_segments(&bytes,&name,&state.ocr){Ok(segments)=>p.rows=image_rows(&segments),Err(e)=>p.warnings.push(format!("{e}. Your source is kept locally. Retry after OCR is ready, or export a CSV."))};
            if p.rows.is_empty(){p.warnings.push("No grade rows were read. Use a clearer image, retry local OCR, or export a CSV.".into());}
        }
        let db=state.db.lock().unwrap();duplicates(&db,&mut p)?;db.execute("INSERT INTO grade_imports_local(id,course_id,source,payload) VALUES(?1,?2,?3,?4)",params![p.id,p.course_id,bytes,encode(&p)?])?;Ok(p)
    }).await.map_err(|_|invalid("Local grade reader stopped. Retry the import."))?
}
#[tauri::command]
pub async fn retry_grade_import(state:tauri::State<'_,AppState>,id:String,expected_revision:i64)->Result<Preview>{
 state.require_unlocked()?;let state=state.inner().clone();
 tauri::async_runtime::spawn_blocking(move||{
  let db=state.db.lock().unwrap();let mut p=read(&db,&id)?;
  if p.revision!=expected_revision||p.layout!="image"||!p.rows.is_empty(){return Err(invalid("Reopen the unchanged image draft before retrying OCR. Existing corrections are retained."));}
  let bytes=db.query_row("SELECT source FROM grade_imports_local WHERE id=?1",[&id],|r|r.get::<_,Vec<u8>>(0))?;drop(db);
  let segments=imports::extract_grade_segments(&bytes,&p.file_name,&state.ocr).map_err(|_|invalid("Local grade OCR could not read this image. Check OCR readiness, choose a clearer image, or export a CSV. Your saved source remains recoverable."))?;
  p.rows=image_rows(&segments);p.warnings.clear();if p.rows.is_empty(){p.warnings.push("No grade rows were read. Choose a clearer image or export a CSV.".into());}
  let db=state.db.lock().unwrap();if read(&db,&id)?.revision!=expected_revision{return Err(invalid("The review changed during OCR. Reopen it; your edits were retained."));}
  duplicates(&db,&mut p)?;p.revision+=1;db.execute("UPDATE grade_imports_local SET payload=?2 WHERE id=?1",params![id,encode(&p)?])?;Ok(p)
 }).await.map_err(|e|AppError::Background(e.to_string()))?
}
#[tauri::command]
pub fn list_grade_imports(state:tauri::State<AppState>,course_id:String)->Result<Vec<Preview>>{state.require_unlocked()?;let db=state.db.lock().unwrap();let mut q=db.prepare("SELECT payload FROM grade_imports_local WHERE course_id=?1 AND applied_at IS NULL ORDER BY rowid DESC")?;let raws=q.query_map([course_id],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;raws.into_iter().map(|v|serde_json::from_str(&v).map_err(|_|invalid("A saved import needs recovery"))).collect()}
#[tauri::command]
pub fn save_grade_import_review(state:tauri::State<AppState>,preview:Preview,reparse:bool)->Result<Preview>{state.require_unlocked()?;save_review(&state.db.lock().unwrap(),preview,reparse)}
fn save_review(db:&Connection,mut p:Preview,reparse:bool)->Result<Preview>{let saved=read(db,&p.id)?;if saved.revision!=p.revision||saved.course_id!=p.course_id{return Err(invalid("This import changed. Reopen the saved draft before saving."));}
    if p.rows.len()>5000||p.rows.iter().map(|r|&r.id).collect::<std::collections::HashSet<_>>().len()!=p.rows.len(){return Err(invalid("Import rows must be unique"));}
    // Source and provenance are immutable. Only review fields and mappings may change.
    p.file_name=saved.file_name;p.headers=saved.headers;p.records=saved.records;p.layout=saved.layout;p.source_image=saved.source_image;p.warnings=saved.warnings;
    if reparse {p.rows=parse_rows(&p);duplicates(db,&mut p)?;}else {for row in &mut p.rows {let original=saved.rows.iter().find(|r|r.id==row.id).ok_or_else(||invalid("Import row is no longer available"))?;row.evidence=original.evidence.clone();row.locator=original.locator.clone();row.confidence=original.confidence;row.source_id=original.source_id.clone();row.warnings=original.warnings.clone();}}
    p.baseline=saved.baseline;p.revision+=1;db.execute("UPDATE grade_imports_local SET payload=?2 WHERE id=?1",params![p.id,encode(&p)?])?;Ok(p)
}
#[tauri::command]
pub fn refresh_grade_import(state:tauri::State<AppState>,id:String)->Result<Preview>{state.require_unlocked()?;let db=state.db.lock().unwrap();let mut p=read(&db,&id)?;p.baseline=baseline(&db,&p.course_id)?;duplicates(&db,&mut p)?;for r in &mut p.rows{r.selected=false;}p.revision+=1;db.execute("UPDATE grade_imports_local SET payload=?2 WHERE id=?1",params![p.id,encode(&p)?])?;Ok(p)}
#[tauri::command]
pub fn discard_grade_import(state:tauri::State<AppState>,id:String)->Result<()>{state.require_unlocked()?;state.db.lock().unwrap().execute("DELETE FROM grade_imports_local WHERE id=?1 AND applied_at IS NULL",[id])?;Ok(())}
#[tauri::command]
pub fn apply_grade_import(state:tauri::State<AppState>,id:String,expected_revision:i64)->Result<StudyWorkspace>{state.require_unlocked()?;let db=state.db.lock().unwrap();apply(&db,&id,expected_revision)?;study_workspace_in(&db)}
fn apply(db:&Connection,id:&str,revision:i64)->Result<()> {
    let tx=db.unchecked_transaction()?;let p=read(&tx,id)?;
    if p.revision!=revision||p.baseline!=baseline(&tx,&p.course_id)?{return Err(invalid("The gradebook or import changed. Refresh this review before applying."));}
    let selected=p.rows.iter().filter(|r|r.selected&&r.action!="skip").collect::<Vec<_>>();if selected.is_empty(){return Err(invalid("Select at least one reviewed grade"));}
    let mut replaced=std::collections::HashSet::new();
    for row in selected {
        if row.title.trim().is_empty()||row.title.len()>200||row.score.is_some_and(|v|!v.is_finite()||v<0.0)||row.points_possible.is_none_or(|v|!v.is_finite()||v<=0.0)||!matches!(row.status.as_str(),"graded"|"missing")||!matches!(row.action.as_str(),"add"|"replace"){return Err(invalid("Correct selected titles, scores, possible points, and statuses before applying."));}
        if let Some(category)=&row.category_id {if !tx.query_row("SELECT EXISTS(SELECT 1 FROM grade_categories WHERE id=?1 AND course_id=?2)",params![category,p.course_id],|r|r.get::<_,bool>(0))?{return Err(invalid("Select a category belonging to this course"));}}
        let grade=if row.action=="replace" {let id=row.replace_id.clone().ok_or_else(||invalid("Choose the grade to replace"))?;if !replaced.insert(id.clone())||!tx.query_row("SELECT EXISTS(SELECT 1 FROM grade_items WHERE id=?1 AND course_id=?2)",params![id,p.course_id],|r|r.get::<_,bool>(0))?{return Err(invalid("A replacement is duplicated or no longer belongs to this course"));}id}else{Uuid::new_v4().to_string()};
        tx.execute("INSERT INTO grade_items(id,course_id,title,score,points_possible,category_id,status) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET title=excluded.title,score=excluded.score,points_possible=excluded.points_possible,category_id=excluded.category_id,status=excluded.status",params![grade,p.course_id,row.title.trim(),row.score,row.points_possible,row.category_id,row.status])?;
        tx.execute("INSERT INTO grade_import_evidence_local(id,grade_id,import_id,source_id,evidence,locator,confidence,reviewed_row) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![Uuid::new_v4().to_string(),grade,p.id,row.source_id,row.evidence,row.locator,row.confidence,serde_json::to_string(row).map_err(|_|invalid("Grade evidence could not be saved"))?])?;
    }
    tx.execute("UPDATE grade_imports_local SET applied_at=?2 WHERE id=?1",params![id,Utc::now().to_rfc3339()])?;tx.commit()?;Ok(())
}
#[cfg(test)]
mod tests {
 use super::*;
 #[test]fn blank_is_not_zero(){assert_eq!(number(""),None);assert_eq!(number("0"),Some(0.0));assert_eq!(number("EX"),None);}
 #[test]fn csv_handles_quotes_and_bom(){let(h,r)=parse_csv("\u{feff}Assignment,Score,Points Possible\n\"Quiz, one\",0,10\nBlank,,10\n".as_bytes()).unwrap();assert_eq!(h[0],"Assignment");assert_eq!(r[0][0],"Quiz, one");assert_eq!(r[1][1],"");}
 #[test]fn summaries_are_not_assignments(){assert!(administrative("Final Score"));assert!(administrative("Exams Current Score"));assert!(!administrative("Quiz (42)"));}
}

#[derive(Serialize)]#[serde(rename_all="camelCase")]
pub struct Evidence {evidence:String,locator:String,confidence:f64,reviewed_row:String,file_name:String,source_image:Option<String>}
#[tauri::command]
pub fn get_grade_import_evidence(state:tauri::State<AppState>,grade_id:String)->Result<Vec<Evidence>>{state.require_unlocked()?;let db=state.db.lock().unwrap();let mut q=db.prepare("SELECT e.evidence,e.locator,e.confidence,e.reviewed_row,i.payload FROM grade_import_evidence_local e JOIN grade_imports_local i ON i.id=e.import_id WHERE e.grade_id=?1 ORDER BY e.rowid DESC")?;let rows=q.query_map([grade_id],|r|{let raw:String=r.get(4)?;let p:Preview=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;Ok(Evidence{evidence:r.get(0)?,locator:r.get(1)?,confidence:r.get(2)?,reviewed_row:r.get(3)?,file_name:p.file_name,source_image:p.source_image})})?.collect::<std::result::Result<Vec<_>,_>>()?;Ok(rows)}

#[cfg(test)]mod review_tests {
 use super::*;
 fn db()->Connection{let db=Connection::open_in_memory().unwrap();db.execute_batch("PRAGMA foreign_keys=ON;CREATE TABLE courses(id TEXT PRIMARY KEY);INSERT INTO courses VALUES('course'),('other');CREATE TABLE grade_items(id TEXT PRIMARY KEY,course_id TEXT NOT NULL REFERENCES courses(id),title TEXT NOT NULL,score REAL,points_possible REAL,category_id TEXT,status TEXT);CREATE TABLE grade_categories(id TEXT PRIMARY KEY,course_id TEXT,name TEXT,weight REAL);").unwrap();migrate(&db).unwrap();db}
 fn preview(db:&Connection)->Preview{Preview{id:"import".into(),course_id:"course".into(),file_name:"canvas.csv".into(),rows:vec![row("Quiz".into(),Some(0.0),Some(10.0),"Quiz,0,10".into(),"CSV row 2".into(),Some("canvas:42".into()),1.0)],headers:vec!["Assignment".into(),"Score".into(),"Points Possible".into()],records:vec![vec!["Quiz".into(),"0".into(),"10".into()]],student_row:None,layout:"assignment_rows".into(),mapping:Some(Mapping{title:0,score:Some(1),possible:Some(2),category:None}),baseline:baseline(db,"course").unwrap(),revision:1,warnings:vec![],source_image:None}}
 fn store(db:&Connection,p:&Preview){db.execute("INSERT INTO grade_imports_local(id,course_id,source,payload) VALUES(?1,?2,?3,?4)",params![p.id,p.course_id,b"source".as_slice(),encode(p).unwrap()]).unwrap();}
 #[test]fn preview_does_not_write_and_explicit_apply_preserves_zero_and_provenance(){let db=db();let p=preview(&db);store(&db,&p);assert_eq!(db.query_row("SELECT COUNT(*) FROM grade_items",[],|r|r.get::<_,i64>(0)).unwrap(),0);apply(&db,&p.id,1).unwrap();assert_eq!(db.query_row("SELECT score FROM grade_items",[],|r|r.get::<_,Option<f64>>(0)).unwrap(),Some(0.0));assert_eq!(db.query_row("SELECT evidence FROM grade_import_evidence_local",[],|r|r.get::<_,String>(0)).unwrap(),"Quiz,0,10");assert!(apply(&db,&p.id,1).is_err());}
 #[test]fn stale_gradebooks_fail_without_losing_the_draft(){let db=db();let p=preview(&db);store(&db,&p);db.execute("INSERT INTO grade_items VALUES('existing','course','Other',5,10,NULL,'graded')",[]).unwrap();assert!(apply(&db,&p.id,1).unwrap_err().to_string().contains("changed"));assert_eq!(read(&db,&p.id).unwrap().rows[0].title,"Quiz");assert_eq!(db.query_row("SELECT COUNT(*) FROM grade_items",[],|r|r.get::<_,i64>(0)).unwrap(),1);}
 #[test]fn invalid_later_row_rolls_back_every_grade(){let db=db();let mut p=preview(&db);let mut bad=p.rows[0].clone();bad.id="bad".into();bad.points_possible=None;p.rows.push(bad);store(&db,&p);assert!(apply(&db,&p.id,1).is_err());assert_eq!(db.query_row("SELECT COUNT(*) FROM grade_items",[],|r|r.get::<_,i64>(0)).unwrap(),0);assert!(read(&db,&p.id).is_ok());}
 #[test]fn categories_and_replacements_are_scoped_to_the_course(){let db=db();let mut p=preview(&db);p.rows[0].category_id=Some("foreign".into());db.execute("INSERT INTO grade_categories VALUES('foreign','other','Exams',50)",[]).unwrap();store(&db,&p);assert!(apply(&db,&p.id,1).is_err());}
 #[test]fn duplicate_checks_default_to_skip_and_keep_blank_separate(){let db=db();let mut p=preview(&db);db.execute("INSERT INTO grade_items VALUES('quiz','course','Quiz',5,10,NULL,'graded')",[]).unwrap();duplicates(&db,&mut p).unwrap();assert!(!p.rows[0].selected);assert_eq!(p.rows[0].action,"skip");assert_eq!(p.rows[0].replace_id.as_deref(),Some("quiz"));p.records.push(vec!["Blank".into(),"".into(),"10".into()]);let rows=parse_rows(&p);assert_eq!(rows[1].score,None);assert!(!rows[1].selected);}
 #[test]fn csv_preserves_quoted_titles_and_blank_earned_points(){
  let(headers,records)=parse_csv(b"\xef\xbb\xbfAssignment,Score,Points Possible\n\"Quiz, part one\",0,10\nLab,,20\n").unwrap();
  assert_eq!(headers[0],"Assignment");assert_eq!(records[0][0],"Quiz, part one");assert_eq!(number(&records[0][1]),Some(0.0));assert_eq!(number(&records[1][1]),None);
 }
 #[test]fn canvas_requires_student_selection_and_uses_possible_points_row(){let db=db();let mut p=preview(&db);p.layout="canvas_columns".into();p.headers=vec!["Student","ID","SIS User ID","SIS Login ID","Section","Quiz (42)","Final Score"].into_iter().map(String::from).collect();p.records=vec![vec!["Points Possible","","","","","10",""],vec!["Student A","1","","","Course","0","0"],vec!["Student B","2","","","Course","8","80"]].into_iter().map(|r|r.into_iter().map(String::from).collect()).collect();assert!(parse_rows(&p).is_empty());p.student_row=Some(1);let rows=parse_rows(&p);assert_eq!(rows.len(),1);assert_eq!(rows[0].score,Some(0.0));assert_eq!(rows[0].points_possible,Some(10.0));assert_eq!(rows[0].source_id.as_deref(),Some("canvas:42"));}
 #[test]fn review_edits_cannot_rewrite_the_source_or_skip_revisions(){let db=db();let p=preview(&db);store(&db,&p);let mut edited=p.clone();edited.rows[0].evidence="fabricated".into();edited.rows[0].score=Some(7.0);let saved=save_review(&db,edited,false).unwrap();assert_eq!(saved.rows[0].evidence,"Quiz,0,10");assert_eq!(saved.rows[0].score,Some(7.0));assert_eq!(saved.revision,2);assert!(save_review(&db,p,false).is_err());}
 #[test]
 #[ignore = "requires a staged or installed packaged OCR runtime"]
 fn packaged_grade_ocr_reads_a_real_image_without_schedule_parsing(){
  let root=std::env::var_os("COQUI_OCR_TEST_RESOURCES").expect("provide the packaged Resources directory");
  let runtime=imports::OcrRuntime::discover(Some(std::path::Path::new(&root)));
  let bytes=include_bytes!("../test-fixtures/grades/gradebook.png");
  let segments=imports::extract_grade_segments(bytes,"Grades — fall.png",&runtime).unwrap();
  let rows=image_rows(&segments);
  assert_eq!(rows.len(),2);
  assert_eq!(rows[0].score,Some(0.0));
  assert_eq!(rows[1].score,Some(8.0));
  assert!(rows.iter().all(|r|r.points_possible==Some(10.0)&&!r.selected&&r.locator.contains("image region")));
 }
 #[test]fn image_table_reader_uses_grade_columns_and_retains_regions(){
  let tsv="level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t10\t10\t80\t20\t90\tAssignment\n5\t1\t1\t1\t1\t2\t220\t10\t60\t20\t90\tScore\n5\t1\t1\t1\t1\t3\t340\t10\t60\t20\t90\tPossible\n5\t1\t1\t1\t2\t1\t10\t50\t80\t20\t90\tQuiz\n5\t1\t1\t1\t2\t2\t220\t50\t20\t20\t95\t0\n5\t1\t1\t1\t2\t3\t340\t50\t20\t20\t95\t10\n";
  let segment=imports::parse_tesseract_tsv_for_test(tsv,"gradebook").unwrap();let rows=image_rows(&[segment]);assert_eq!(rows.len(),1);assert_eq!(rows[0].title,"Quiz");assert_eq!(rows[0].score,Some(0.0));assert_eq!(rows[0].points_possible,Some(10.0));assert!(!rows[0].selected);assert!(rows[0].locator.contains("image region"));
 }
}
