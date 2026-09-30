//! Notes extend study_artifacts and study_materials; no parallel document library.
use crate::*;
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct PrepareInput{pub kind:String,pub course_ids:Vec<String>,pub document_ids:Vec<String>,pub prompt:String,pub title:String}
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Prepared{pub id:String,pub provider:String,pub model:String,pub input:PrepareInput,pub sources:Vec<ai_providers::GroundedSource>,pub fingerprint:String,#[serde(default)] pub request_text:String}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct GenerateInput{pub prepared_id:String,pub expected_provider:String,pub expected_model:String,pub consent:bool}
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Preview{pub preview_id:String,pub course_id:String,pub kind:String,pub title:String,pub content:String,pub citations:Vec<ai_providers::GroundedCitation>,pub source_ids:Vec<String>,pub provider:String,pub model:String}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct NoteInput{pub id:Option<String>,pub expected_revision:i64,pub course_id:String,pub kind:String,pub title:String,pub content:String,pub tags:Vec<String>,pub pinned:bool,pub source_ids:Vec<String>,pub preview_id:Option<String>}
fn invalid(s:&str)->AppError{AppError::Invalid(s.into())}
pub fn migrate(db:&Connection)->Result<()> {
    ensure_column(db,"study_artifacts","tags","TEXT NOT NULL DEFAULT '[]'")?;
    ensure_column(db,"study_artifacts","pinned","INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(db,"study_artifacts","source_ids","TEXT NOT NULL DEFAULT '[]'")?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS study_requests_local(id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS study_previews_local(id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS study_note_history_local(id TEXT NOT NULL,revision INTEGER NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,recorded_at TEXT NOT NULL,PRIMARY KEY(id,revision));")?;
    db.execute("DELETE FROM study_requests_local WHERE julianday(created_at)<julianday('now')-1",[])?;
    db.execute("DELETE FROM study_previews_local WHERE julianday(created_at)<julianday('now')-1",[])?;
    let existing={let mut q=db.prepare("SELECT id,citations FROM study_artifacts WHERE source_ids='[]'")?;let rows=q.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;rows};
    for(id,raw)in existing{let citations:Vec<ai_providers::GroundedCitation>=serde_json::from_str(&raw).unwrap_or_default();let mut sources=Vec::new();for c in citations{if let Some(doc)=db.query_row("SELECT document_id FROM document_segments WHERE id=?1 UNION SELECT document_id FROM import_candidates WHERE id=?1 LIMIT 1",[c.source_id],|r|r.get::<_,String>(0)).optional()?{sources.push(doc);}}sources.sort();sources.dedup();db.execute("UPDATE study_artifacts SET source_ids=?2 WHERE id=?1",params![id,serde_json::to_string(&sources).map_err(|_|invalid("Source references need recovery."))?])?;}
    Ok(())
}
fn capability(kind:&str)->Result<managed_ai::AiCapability>{
    use managed_ai::AiCapability::*;
    Ok(match kind{"notes"|"summary"|"outline"|"slides"=>SourceQa,"source_qa"=>SourceQa,"study_guide"=>StudyGuide,"flashcards"=>Flashcards,"practice_questions"=>PracticeQuestions,"practice_test"=>PracticeTest,_=>return Err(invalid("Unsupported notes format."))})
}
fn sources(db:&Connection,input:&PrepareInput)->Result<Vec<ai_providers::GroundedSource>>{
    if input.course_ids.is_empty()||input.course_ids.len()>20||input.document_ids.is_empty()||input.document_ids.len()>100||input.prompt.trim().is_empty()||input.prompt.chars().count()>3500||input.title.chars().count()>200{return Err(invalid("Select a course, source, and a request of up to 3,500 characters."));}
    let mut result=Vec::new();let mut ids=input.document_ids.clone();ids.sort();ids.dedup();
    for id in ids {
      if !input.course_ids.iter().any(|course|db.query_row("SELECT EXISTS(SELECT 1 FROM study_materials WHERE document_id=?1 AND course_id=?2)",params![id,course],|r|r.get::<_,bool>(0)).unwrap_or(false)){return Err(invalid("Each source must belong to a selected course."));}
      let mut query=db.prepare("SELECT id,locator,text FROM document_segments WHERE document_id=?1 ORDER BY position,id")?;
      let mut segments=query.query_map([&id],|r|Ok(ai_providers::GroundedSource{id:r.get(0)?,locator:r.get(1)?,text:r.get(2)?}))?.collect::<std::result::Result<Vec<_>,_>>()?;
      if segments.is_empty(){let mut query=db.prepare("SELECT id,source_locator,evidence FROM import_candidates WHERE document_id=?1 AND evidence!='' ORDER BY id")?;segments=query.query_map([&id],|r|Ok(ai_providers::GroundedSource{id:r.get(0)?,locator:r.get(1)?,text:r.get(2)?}))?.collect::<std::result::Result<Vec<_>,_>>()?;}
      result.extend(segments);
    }
    if result.is_empty(){return Err(invalid("No extracted text is available. Add a text transcript or inspect extraction status."));}
    if result.len()>100||result.iter().map(|s|s.text.chars().count()).sum::<usize>()>60_000{return Err(invalid("Select fewer materials: requests support at most 100 sections and 60,000 characters."));}
    Ok(result)
}
fn fingerprint(input:&PrepareInput,sources:&[ai_providers::GroundedSource])->Result<String>{Ok(hex::encode(Sha256::digest(serde_json::to_vec(&(input,sources)).map_err(|_|invalid("Request could not be prepared."))?)))}
fn formatted_prompt(input:&PrepareInput)->String {
    let format=match input.kind.as_str(){"slides"=>"Create an editable slide draft using Markdown headings for each slide, bullet points, and speaker notes. Do not claim an exported presentation file.","outline"=>"Create a structured editable outline.","summary"=>"Create an editable concise summary.","notes"=>"Create structured editable notes with key ideas and action items.",_=>"Create the requested editable study artifact."};
    format!("{format}\n{}",input.prompt.trim())
}
pub fn prepare(db:&Connection,input:PrepareInput)->Result<Prepared>{
    let cap=capability(&input.kind)?;let (provider,_key,model)=resolve_ai_provider(db,cap)?;
    let sources=sources(db,&input)?;let fingerprint=fingerprint(&input,&sources)?;
    let request_text=ai_providers::grounded_request_text(cap,&formatted_prompt(&input),&sources)?;
    let value=Prepared{id:Uuid::new_v4().to_string(),provider:provider.as_str().into(),model,input,sources,fingerprint,request_text};
    db.execute("DELETE FROM study_requests_local WHERE used=1 OR julianday(created_at)<julianday('now')-1",[])?;
    db.execute("INSERT INTO study_requests_local(id,payload,created_at) VALUES(?1,?2,?3)",params![value.id,serde_json::to_string(&value).map_err(|_|invalid("Request could not be prepared."))?,Utc::now().to_rfc3339()])?;Ok(value)
}
pub fn claim(db:&Connection,input:&GenerateInput)->Result<(Prepared,ai_providers::ProviderId,Zeroizing<String>,managed_ai::AiCapability)>{
    if !input.consent{return Err(invalid("Explicit consent is required for this request."));}
    let raw=db.query_row("SELECT payload FROM study_requests_local WHERE id=?1 AND used=0 AND julianday(created_at)>julianday('now')-1",[&input.prepared_id],|r|r.get::<_,String>(0)).optional()?.ok_or_else(||invalid("Prepare this request again and give fresh consent."))?;
    // One-use consent is consumed even if provider configuration or source revisions changed.
    db.execute("UPDATE study_requests_local SET used=1 WHERE id=?1",[&input.prepared_id])?;
    let p:Prepared=serde_json::from_str(&raw).map_err(|_|invalid("Request needs recovery."))?;
    if p.provider!=input.expected_provider||p.model!=input.expected_model{return Err(invalid("The provider or model changed. Review the disclosure and consent again."));}
    if p.fingerprint!=fingerprint(&p.input,&sources(db,&p.input)?)?{return Err(invalid("Selected material changed. Prepare and approve the updated text."));}
    let cap=capability(&p.input.kind)?;
    if p.request_text!=ai_providers::grounded_request_text(cap,&formatted_prompt(&p.input),&p.sources)?{return Err(invalid("Request format changed. Prepare and approve the request again."));}
    let(provider,key,model)=resolve_ai_provider(db,cap)?;
    if p.provider!=provider.as_str()||p.model!=model{return Err(invalid("The provider or model changed. Review the disclosure and consent again."));}
    Ok((p,provider,key,cap))
}
pub async fn generate(state:AppState,input:GenerateInput)->Result<Preview>{
    tauri::async_runtime::spawn_blocking(move||{
      state.require_unlocked()?;
      let (p,provider,key,cap)={let db=state.db.lock().unwrap();claim(&db,&input)?};
      let prompt=formatted_prompt(&p.input);let started=Instant::now();
      let response=ai_providers::request_grounded(provider,&key,&p.model,cap,&prompt,&p.sources);
      let db=state.db.lock().unwrap();state.require_unlocked()?;
      let response=match response{Ok(r)=>r,Err(e)=>{record_ai_invocation(&db,provider.as_str(),cap,Some(&p.model),started.elapsed().as_millis() as i64,0,0,"failed",Some(ai_error_category(&e)))?;return Err(AppError::ManagedAi(e));}};
      let preview=Preview{preview_id:Uuid::new_v4().to_string(),course_id:p.input.course_ids[0].clone(),kind:p.input.kind,title:if p.input.title.trim().is_empty(){"Study draft".into()}else{p.input.title},content:response.content,citations:response.citations,source_ids:p.input.document_ids,provider:p.provider,model:response.model};
      db.execute("INSERT INTO study_previews_local(id,payload,created_at) VALUES(?1,?2,?3)",params![preview.preview_id,serde_json::to_string(&preview).map_err(|_|invalid("Preview could not be retained."))?,Utc::now().to_rfc3339()])?;
      record_ai_invocation(&db,provider.as_str(),cap,Some(&preview.model),started.elapsed().as_millis() as i64,response.usage.input_tokens,response.usage.output_tokens,"preview_created",None)?;
      Ok(preview)
    }).await.map_err(|e|AppError::Background(e.to_string()))?
}
pub fn save(db:&Connection,input:NoteInput)->Result<StudyWorkspace>{
    if input.title.trim().is_empty()||input.title.chars().count()>200||input.content.trim().is_empty()||input.content.chars().count()>40_000||input.tags.len()>30||input.tags.iter().any(|t|t.trim().is_empty()||t.chars().count()>60){return Err(invalid("Add a title and content. Notes support 40,000 characters and 30 tags."));}
    capability(&input.kind)?;
    if !db.query_row("SELECT EXISTS(SELECT 1 FROM courses WHERE id=?1)",[&input.course_id],|r|r.get::<_,bool>(0))?{return Err(invalid("Choose an available course."));}
    let tx=db.unchecked_transaction()?;let now=Utc::now().to_rfc3339();let tags=serde_json::to_string(&input.tags).map_err(|_|invalid("Invalid tags."))?;
    if let Some(id)=&input.id {
      tx.execute("INSERT OR IGNORE INTO study_note_history_local(id,revision,title,content,recorded_at) SELECT id,version,title,content,?3 FROM study_artifacts WHERE id=?1 AND version=?2",params![id,input.expected_revision,now])?;
      if tx.execute("UPDATE study_artifacts SET title=?2,content=?3,tags=?4,pinned=?5,updated_at=?6,version=version+1 WHERE id=?1 AND version=?7",params![id,input.title.trim(),input.content,tags,input.pinned,now,input.expected_revision])?!=1{return Err(invalid("This note changed. Reload before saving."));}
    }else{
      if input.expected_revision!=0{return Err(invalid("A new note must start at revision zero."));}
      let (citations,provider,model,source_ids)=if let Some(id)=&input.preview_id {
        let raw=tx.query_row("SELECT payload FROM study_previews_local WHERE id=?1",[id],|r|r.get::<_,String>(0)).optional()?.ok_or_else(||invalid("This preview was already saved or is unavailable."))?;
        let p:Preview=serde_json::from_str(&raw).map_err(|_|invalid("This preview needs recovery."))?;
        if p.course_id!=input.course_id||p.kind!=input.kind{return Err(invalid("Keep the preview's course and format when saving."));}
        tx.execute("DELETE FROM study_previews_local WHERE id=?1",[id])?;
        (serde_json::to_string(&p.citations).map_err(|_|invalid("Invalid references."))?,p.provider,p.model,p.source_ids)
      }else{("[]".into(),"manual".into(),"local".into(),input.source_ids)};
      for id in &source_ids {if !tx.query_row("SELECT EXISTS(SELECT 1 FROM study_materials WHERE document_id=?1 AND course_id=?2)",params![id,input.course_id],|r|r.get::<_,bool>(0))?{return Err(invalid("A linked source is no longer available for this course."));}}
      let artifact_id=Uuid::new_v4().to_string();
      tx.execute("INSERT INTO study_artifacts(id,course_id,kind,title,content,citations,provider,model,created_at,updated_at,tags,pinned,source_ids) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,?10,?11,?12)",params![artifact_id,input.course_id,input.kind,input.title.trim(),input.content,citations,provider,model,now,tags,input.pinned,serde_json::to_string(&source_ids).map_err(|_|invalid("Invalid sources."))?])?;
      tx.execute("INSERT INTO study_reviews(id,artifact_id,next_review_at) VALUES(?1,?2,?3)",params![Uuid::new_v4().to_string(),artifact_id,(Utc::now()+chrono::Duration::days(1)).to_rfc3339()])?;
    }tx.commit()?;study_workspace_in(db)
}
pub fn delete(db:&Connection,id:&str,revision:i64)->Result<StudyWorkspace>{if db.execute("DELETE FROM study_artifacts WHERE id=?1 AND version=?2",params![id,revision])?!=1{return Err(invalid("This note changed. Reload before deleting."));}study_workspace_in(db)}
pub fn source_text(db:&Connection,id:&str)->Result<Vec<ai_providers::GroundedSource>>{
    let mut query=db.prepare("SELECT id,locator,text FROM document_segments WHERE document_id=?1 ORDER BY position,id")?;
    let result=query.query_map([id],|r|Ok(ai_providers::GroundedSource{id:r.get(0)?,locator:r.get(1)?,text:r.get(2)?}))?.collect::<std::result::Result<Vec<_>,_>>()?;
    if result.is_empty(){return Err(invalid("Source text is unavailable. Check extraction status or reimport the source."));}Ok(result)
}
// Separate from schedule ingestion: never produces schedule/task candidates.
pub fn import(state:&AppState,course_id:String,file_name:String,bytes:Vec<u8>)->Result<StudyWorkspace>{
    state.require_unlocked()?;if bytes.is_empty()||bytes.len() as u64>MAX_IMPORT_BYTES{return Err(invalid("Choose a non-empty file up to 25 MB."));}
    let name=Path::new(&file_name).file_name().and_then(|s|s.to_str()).ok_or_else(||invalid("Invalid file name."))?.to_string();
    let detected=imports::detect_document(&bytes,&name).map_err(|e|AppError::Extract(e.to_string()))?;
    if !matches!(Path::new(&name).extension().and_then(|s|s.to_str()).unwrap_or("").to_lowercase().as_str(),"pdf"|"docx"|"pptx"|"txt"|"png"|"jpg"|"jpeg"|"tif"|"tiff"){return Err(invalid("Use PDF, DOCX, PPTX, TXT, PNG, JPEG, or TIFF. Audio transcription is unavailable."));}
    let mut scratch=tempfile::Builder::new().prefix("coqui-material-").suffix(&format!(".{}",Path::new(&name).extension().unwrap().to_string_lossy())).tempfile()?;
    std::io::Write::write_all(&mut scratch,&bytes)?;
    let db=state.db.lock().unwrap();if !db.query_row("SELECT EXISTS(SELECT 1 FROM courses WHERE id=?1)",[&course_id],|r|r.get::<_,bool>(0))?{return Err(invalid("Choose an available course."));}
    let extraction=imports::extract_document(imports::DocumentSource::File(scratch.path()),&bytes,&name,&db_setting(&db,"timezone","Etc/UTC"),&state.ocr,&[],&[]);
    let hash=hex::encode(Sha256::digest(&bytes));
    let existing=db.query_row("SELECT id FROM documents WHERE sha256=?1 AND content_shredded=0 ORDER BY imported_at LIMIT 1",[&hash],|r|r.get::<_,String>(0)).optional()?;
    let tx=db.unchecked_transaction()?;let now=Utc::now().to_rfc3339();let mut new_path=None;
    let result=(||->Result<StudyWorkspace>{
      let id=if let Some(id)=existing{id}else{
        let id=Uuid::new_v4().to_string();let key=Zeroizing::new(random_key());let(encrypted,nonce)=encrypt(&key,&bytes)?;let(wrapped,key_nonce)=encrypt(&state.master_key,&*key)?;let path=state.vault.join(format!("{id}.vault"));fs::write(&path,encrypted)?;new_path=Some(path.clone());
        let(status,error)=match &extraction{Ok(e) if !e.segments.is_empty()=>(if e.warnings.is_empty(){"complete"}else{"complete_with_warnings"},if e.warnings.is_empty(){None}else{Some(e.warnings.join(" · "))}),Ok(_)=>("needs_attention",Some("No locally extractable text. Paste a text transcript instead.".into())),Err(e)=>("needs_attention",Some(e.to_string()))};
        tx.execute("INSERT INTO documents(id,file_name,mime,vault_path,wrapped_key,key_nonce,content_nonce,sha256,imported_at,extraction_status,extraction_error,source_retention) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'keep_encrypted')",params![id,name,detected.mime(),path.to_string_lossy(),B64.encode(wrapped),B64.encode(key_nonce),B64.encode(nonce),hash,now,status,error])?;
        if let Ok(e)=&extraction{for(position,segment)in e.segments.iter().take(250).enumerate(){tx.execute("INSERT INTO document_segments(id,document_id,locator,text,confidence,position) VALUES(?1,?2,?3,?4,?5,?6)",params![Uuid::new_v4().to_string(),id,segment.locator,segment.text.chars().take(50_000).collect::<String>(),segment.confidence,position as i64])?;}}
        id
      };
      tx.execute("INSERT OR IGNORE INTO study_materials(document_id,course_id,added_at) VALUES(?1,?2,?3)",params![id,course_id,now])?;
      tx.execute("INSERT OR IGNORE INTO study_material_metadata(document_id,title,material_type,source,updated_at) VALUES(?1,?2,'notes','Student import',?3)",params![id,name,now])?;
      study_workspace_in(&tx)
    })();
    match result{Ok(workspace)=>{tx.commit()?;Ok(workspace)},Err(e)=>{drop(tx);if let Some(path)=new_path{let _=fs::remove_file(path);}Err(e)}}
}

#[cfg(test)]
mod tests {
 use super::*;
 fn db()->(tempfile::TempDir,Connection,[u8;32]){let dir=tempfile::tempdir().unwrap();let key=random_key();let db=open_database(&dir.path().join("notes.db"),&key).unwrap();db.execute("INSERT INTO courses(id,title,source_uid) VALUES('course','Biology','course')",[]).unwrap();(dir,db,key)}
 fn note()->NoteInput{NoteInput{id:None,expected_revision:0,course_id:"course".into(),kind:"notes".into(),title:"My notes".into(),content:"Locally authored text".into(),tags:vec!["biology".into()],pinned:true,source_ids:vec![],preview_id:None}}
 fn source(db:&Connection){db.execute("INSERT INTO documents(id,file_name,mime,vault_path,wrapped_key,key_nonce,content_nonce,sha256,imported_at) VALUES('source','transcript.txt','text/plain','vault/source','key','nonce','nonce','hash','2026-09-01T00:00:00Z')",[]).unwrap();db.execute("INSERT INTO study_materials(document_id,course_id,added_at) VALUES('source','course','2026-09-01T00:00:00Z')",[]).unwrap();db.execute("INSERT INTO document_segments(id,document_id,locator,text,confidence,position) VALUES('segment','source','Section 1','Exact meeting transcript',1,0)",[]).unwrap();}
 #[test] fn authored_notes_retain_history_metadata_and_persist_after_reopen(){
  let(dir,db,key)=db();let saved=save(&db,note()).unwrap();let n=&saved.artifacts[0];assert_eq!(n.provider,"manual");assert!(n.pinned);assert_eq!(n.tags,vec!["biology"]);
  let mut edit=note();edit.id=Some(n.id.clone());edit.expected_revision=0;assert!(save(&db,edit).is_err());
  let mut edit=note();edit.id=Some(n.id.clone());edit.expected_revision=1;edit.content="Updated notes".into();save(&db,edit).unwrap();assert_eq!(db.query_row("SELECT content FROM study_note_history_local WHERE id=?1",[&n.id],|r|r.get::<_,String>(0)).unwrap(),"Locally authored text");
  drop(db);let db=open_database(&dir.path().join("notes.db"),&key).unwrap();assert_eq!(study_workspace_in(&db).unwrap().artifacts[0].revision,2);assert!(delete(&db,&n.id,1).is_err());delete(&db,&n.id,2).unwrap();assert!(study_workspace_in(&db).unwrap().artifacts.is_empty());
 }
 #[test] fn previews_are_not_artifacts_until_reviewed_save_and_keep_references(){
  let(_dir,db,_)=db();source(&db);let preview=Preview{preview_id:"preview".into(),course_id:"course".into(),kind:"slides".into(),title:"Slides".into(),content:"# Slide 1".into(),citations:vec![ai_providers::GroundedCitation{source_id:"segment".into(),locator:"Section 1".into(),quote:"Exact meeting transcript".into()}],source_ids:vec!["source".into()],provider:"openai".into(),model:"reviewed-model".into()};
  db.execute("INSERT INTO study_previews_local(id,payload,created_at) VALUES('preview',?1,?2)",params![serde_json::to_string(&preview).unwrap(),Utc::now().to_rfc3339()]).unwrap();assert!(study_workspace_in(&db).unwrap().artifacts.is_empty());
  let mut input=note();input.kind="slides".into();input.preview_id=Some("preview".into());input.content="# Slide 1\nStudent edits".into();let saved=save(&db,input).unwrap();assert_eq!(saved.artifacts[0].content,"# Slide 1\nStudent edits");assert_eq!(saved.artifacts[0].source_ids,vec!["source"]);assert_eq!(saved.artifacts[0].citations.len(),1);
  let mut again=note();again.kind="slides".into();again.preview_id=Some("preview".into());assert!(save(&db,again).is_err());assert_eq!(get_count(&db,"study_artifacts"),1);
 }
 fn get_count(db:&Connection,table:&str)->i64{db.query_row(&format!("SELECT COUNT(*) FROM {table}"),[],|r|r.get(0)).unwrap()}
 #[test] fn changed_sources_and_models_consume_consent_without_network(){
  let(_dir,db,_)=db();source(&db);let input=PrepareInput{kind:"notes".into(),course_ids:vec!["course".into()],document_ids:vec!["source".into()],prompt:"Organize the transcript".into(),title:"Notes".into()};let sources=sources(&db,&input).unwrap();let prepared=Prepared{request_text:ai_providers::grounded_request_text(capability(&input.kind).unwrap(),&formatted_prompt(&input),&sources).unwrap(),id:"prepared".into(),provider:"openai".into(),model:"model-a".into(),fingerprint:fingerprint(&input,&sources).unwrap(),input,sources};
  let store=|id:&str|{let mut p=prepared.clone();p.id=id.into();db.execute("INSERT INTO study_requests_local(id,payload,created_at) VALUES(?1,?2,?3)",params![id,serde_json::to_string(&p).unwrap(),Utc::now().to_rfc3339()]).unwrap();};
  store("model");let request=GenerateInput{prepared_id:"model".into(),expected_provider:"openai".into(),expected_model:"model-b".into(),consent:true};assert!(claim(&db,&request).err().unwrap().to_string().contains("model changed"));assert_eq!(db.query_row("SELECT used FROM study_requests_local WHERE id='model'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
  store("source");db.execute("UPDATE document_segments SET text='Changed transcript' WHERE id='segment'",[]).unwrap();let request=GenerateInput{prepared_id:"source".into(),expected_provider:"openai".into(),expected_model:"model-a".into(),consent:true};assert!(claim(&db,&request).err().unwrap().to_string().contains("material changed"));
  let denied=GenerateInput{prepared_id:"source".into(),expected_provider:"openai".into(),expected_model:"model-a".into(),consent:false};assert!(claim(&db,&denied).is_err());assert_eq!(get_count(&db,"ai_invocations"),0);
 }
 #[test] fn sources_are_scoped_complete_and_unsupported_formats_are_not_claimed(){
  let(_dir,db,_)=db();source(&db);let mut input=PrepareInput{kind:"notes".into(),course_ids:vec!["course".into()],document_ids:vec!["source".into()],prompt:"Read".into(),title:"Notes".into()};assert_eq!(sources(&db,&input).unwrap()[0].text,"Exact meeting transcript");input.course_ids=vec!["another".into()];assert!(sources(&db,&input).is_err());assert!(source_text(&db,"missing").is_err());assert!(capability("audio_transcription").is_err());assert!(capability("pptx_export").is_err());
 }
 #[test] fn materials_import_keeps_sources_encrypted_without_schedule_candidates(){
  let(dir,db,key)=db();let vault=dir.path().join("vault");fs::create_dir_all(&vault).unwrap();
  let state=AppState{db:Arc::new(Mutex::new(db)),master_key:key,root:dir.path().into(),db_path:dir.path().join("notes.db"),vault,ocr:OcrRuntime::discover(None),locked:Arc::new(AtomicBool::new(false)),pin_attempts:Arc::new(Mutex::new(PinAttempts::default())),pending_navigation:Arc::new(Mutex::new(None)),account:Arc::new(Mutex::new(auth::AccountRuntime::test_unconfigured())),sync_protection:Arc::new(Mutex::new(sync_crypto::SyncProtectionRuntime::default()))};
  let content=b"Meeting notes: Project due October 10, 2026. Discuss the research outline.";
  let workspace=import(&state,"course".into(),"meeting.txt".into(),content.to_vec()).unwrap();assert_eq!(workspace.materials.len(),1);let id=&workspace.materials[0].id;
  let db=state.db.lock().unwrap();assert_eq!(get_count(&db,"import_candidates"),0);assert!(!source_text(&db,id).unwrap().is_empty());let decrypted=decrypt_original_document(&state,&db,id).unwrap().0;assert_eq!(decrypted,content);drop(db);
  import(&state,"course".into(),"meeting.txt".into(),content.to_vec()).unwrap();assert_eq!(get_count(&state.db.lock().unwrap(),"documents"),1);
  assert!(import(&state,"course".into(),"audio.mp3".into(),b"fake audio".to_vec()).is_err());
  state.locked.store(true,Ordering::Release);assert!(import(&state,"course".into(),"meeting.txt".into(),content.to_vec()).is_err());
  state.locked.store(false,Ordering::Release);
  {let db=state.db.lock().unwrap();crate::student_workflows::save_note(&db,crate::student_workflows::NoteInput{id:None,expected_revision:0,content:"Disposable private sticky".into(),course_id:None,task_id:None,pinned:true}).unwrap();save(&db,note()).unwrap();db.execute("INSERT INTO tasks(id,title,minutes,due_at,task_kind,created_at) VALUES('scored','Scored',30,'2000-01-01T00:00:00Z','assignment','1999-01-01T00:00:00Z')",[]).unwrap();}
  crate::reset_local_database(&state).unwrap();let db=state.db.lock().unwrap();for table in ["quick_notes_local","day_checkins_local","checkin_items_local","assignment_streak_local","assignment_history_local","study_artifacts","study_note_history_local","study_reviews","study_requests_local","study_previews_local"]{assert_eq!(get_count(&db,table),0,"reset left data in {table}");}
 }
}
