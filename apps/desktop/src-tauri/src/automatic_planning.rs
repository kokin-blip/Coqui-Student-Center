//! Device-local authorization and two-phase planning. No provider output writes
//! canonical work until the reviewed preview passes the native apply gate.
use crate::*;
use serde_json::{json, Value};

const PREFERENCES: &str = "automatic_planning_v1";
const DISCLOSURE: &str = "automatic_planning_disclosure";
const PREVIEW: &str = "automatic_planning_preview";
static REQUEST_ACTIVE: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all="snake_case")]
pub enum Choice { Undecided, Enabled, Disabled }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all="snake_case")]
pub enum ConsentMode { PerRequest, StandingDeidentified }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct Preferences { pub version:u32, pub choice:Choice, pub consent_mode:ConsentMode, pub revision:u64 }
impl Default for Preferences {
    fn default()->Self { Self { version:1, choice:Choice::Undecided, consent_mode:ConsentMode::PerRequest, revision:0 } }
}
fn read<T:serde::de::DeserializeOwned>(conn:&Connection,key:&str)->Result<Option<T>> {
    conn.query_row("SELECT value FROM settings WHERE key=?1",[key],|row|row.get::<_,String>(0)).optional()?
        .map(|raw|serde_json::from_str(&raw).map_err(|_|AppError::Invalid("Local AI planning settings need recovery".into()))).transpose()
}
fn write<T:Serialize>(conn:&Connection,key:&str,value:&T)->Result<()> {
    conn.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,serde_json::to_string(value).map_err(|_|AppError::Invalid("Could not save planning state".into()))?])?;
    Ok(())
}
pub fn preferences(conn:&Connection)->Result<Preferences> {
    let value:Preferences=read(conn,PREFERENCES)?.unwrap_or_default();
    if value.version!=1 {return Err(AppError::Invalid("This AI planning preference version is unsupported".into()));}
    Ok(value)
}
pub fn save_preferences(conn:&Connection,choice:Choice,mode:ConsentMode,standing_confirmed:bool)->Result<Preferences> {
    if mode==ConsentMode::StandingDeidentified && (choice!=Choice::Enabled || !standing_confirmed) {
        return Err(AppError::Invalid("Explicit standing consent is required for automatic de-identified requests".into()));
    }
    let old=preferences(conn)?;
    let next=Preferences { version:1, choice, consent_mode:mode, revision:old.revision+1 };
    let tx=conn.unchecked_transaction()?;
    write(&tx,PREFERENCES,&next)?;
    tx.execute("DELETE FROM settings WHERE key IN (?1,?2)",params![DISCLOSURE,PREVIEW])?;
    tx.commit()?;
    Ok(next)
}
pub fn clear_restore_authorization(conn:&Connection)->Result<()> {
    let mut value=preferences(conn)?;
    value.consent_mode=ConsentMode::PerRequest; value.revision+=1;
    write(conn,PREFERENCES,&value)?;
    conn.execute("DELETE FROM settings WHERE key IN (?1,?2)",params![DISCLOSURE,PREVIEW])?;
    Ok(())
}
#[tauri::command]
pub fn get_automatic_planning_preferences(state:tauri::State<AppState>)->Result<Preferences> {
    state.require_unlocked()?; preferences(&state.db.lock().unwrap())
}
#[tauri::command]
pub fn set_automatic_planning_preferences(state:tauri::State<AppState>,choice:Choice,consent_mode:ConsentMode,standing_confirmed:bool)->Result<Preferences> {
    state.require_unlocked()?; save_preferences(&state.db.lock().unwrap(),choice,consent_mode,standing_confirmed)
}
fn hash(value:&impl Serialize)->Result<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(value).map_err(|_|AppError::Invalid("Could not read planning facts".into()))?)))
}
fn ai_snapshot(conn:&Connection,effective:DateTime<Utc>)->Result<planner::PlannerSnapshot> {
    let mut snapshot=planner_snapshot(conn,effective,planner::PlannerTrigger::Initial)?;
    let all=all_plan_blocks(conn)?;
    let horizon=effective+Duration::days(snapshot.horizon_days);
    for block in &mut snapshot.existing_blocks {
        if block.ends_at>horizon || all.iter().any(|old|old.id==block.id && old.reason_codes.iter().any(|reason|reason=="manual_calendar_move")) {block.locked=true;}
    }
    Ok(snapshot)
}
fn fingerprint(conn:&Connection,effective:DateTime<Utc>)->Result<String> {
    hash(&(ai_snapshot(conn,effective)?,all_plan_blocks(conn)?,semester_analysis::profile(conn)?))
}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct TaskLabel { pub reference:String, pub title:String, pub task_id:String }
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Disclosure {
    pub token:String, pub provider:String, pub model:String, pub disclosure_url:String,
    pub facts:Value, pub labels:Vec<TaskLabel>, pub include_identifying:bool,
}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
struct Prepared { disclosure:Disclosure, snapshot:planner::PlannerSnapshot, fingerprint:String, revision:u64, refs:Vec<String> }

/// Allowlist structural fields. Never sanitize arbitrary free text and call it
/// anonymous: default and standing requests contain no user-authored strings.
fn facts(snapshot:&planner::PlannerSnapshot,identifying:bool,goals:&semester_analysis::PlannerProfile)->(Value,Vec<TaskLabel>,Vec<String>) {
    let tasks=snapshot.tasks.iter().filter(|task|!task.completed).collect::<Vec<_>>();
    let refs=tasks.iter().map(|task|task.id.clone()).collect::<Vec<_>>();
    let reference=|id:&str|refs.iter().position(|value|value==id).map(|index|format!("work-{}",index+1));
    let labels=tasks.iter().enumerate().map(|(index,task)|TaskLabel{ reference:format!("work-{}",index+1),title:task.title.clone(),task_id:task.id.clone() }).collect();
    let floor=snapshot.effective_time;
    let work=tasks.iter().enumerate().map(|(index,task)| {
        let protected=snapshot.existing_blocks.iter().filter(|block|block.task_id==task.id && (block.completed || block.locked || block.starts_at<floor)).map(|block|(block.ends_at-block.starts_at).num_minutes()).sum::<i64>();
        let mut value=json!({"reference":format!("work-{}",index+1),"remainingMinutes":(task.duration_minutes-protected).max(0),"dueAt":task.due_at,"earliestStart":task.earliest_start,"priority":task.priority,"academicRisk":task.academic_risk,"splittable":task.splittable,"minSessionMinutes":task.min_session_minutes.max(snapshot.preferences.min_session_minutes).min(task.max_session_minutes.min(snapshot.preferences.max_session_minutes)),"maxSessionMinutes":task.max_session_minutes.min(snapshot.preferences.max_session_minutes),"dependencies":task.dependencies.iter().filter_map(|id|reference(id)).collect::<Vec<_>>()});
        if identifying { value["title"]=json!(task.title); }
        value
    }).collect::<Vec<_>>();
    let horizon=floor+Duration::days(snapshot.horizon_days);
    let occupied=snapshot.fixed_constraints.iter().filter(|block|block.ends_at>floor && block.starts_at<horizon).map(|block| {
        let mut value=json!({"startsAt":block.starts_at-Duration::minutes(block.travel_before_minutes+block.transition_before_minutes),"endsAt":block.ends_at+Duration::minutes(block.travel_after_minutes+block.transition_after_minutes)});
        if identifying {value["title"]=json!(block.title);}
        value
    }).chain(snapshot.existing_blocks.iter().filter(|block|(block.locked||block.completed||block.starts_at<floor) && block.ends_at>floor && block.starts_at<horizon).map(|block|json!({"startsAt":block.starts_at,"endsAt":block.ends_at,"reference":reference(&block.task_id)}))).collect::<Vec<_>>();
    let mut value=json!({"effectiveTime":floor,"horizonDays":snapshot.horizon_days,"timezone":snapshot.timezone,"preferences":snapshot.preferences,"tasks":work,"occupied":occupied});
    if identifying { value["writtenGoals"]=json!({"studyGoals":goals.study_goals,"careerInterests":goals.career_interests,"constraints":goals.constraints}); }
    (value,labels,refs)
}
fn prepare(conn:&Connection,provider:ai_providers::ProviderId,model:String,identifying:bool)->Result<Disclosure> {
    require_onboarded(conn)?;
    let prefs=preferences(conn)?;
    if prefs.choice!=Choice::Enabled {return Err(AppError::Invalid("Enable AI-assisted planning in Settings first".into()));}
    if REQUEST_ACTIVE.load(Ordering::Acquire) || read::<Preview>(conn,PREVIEW)?.is_some() { return Err(AppError::Invalid("Review or discard the pending plan before requesting another".into())); }
    let effective=Utc::now();
    let snapshot=ai_snapshot(conn,effective)?;
    let (facts,labels,refs)=facts(&snapshot,identifying,&semester_analysis::profile(conn)?);
    if labels.is_empty() { return Err(AppError::Invalid("Add unfinished work before asking AI to plan".into())); }
    if serde_json::to_vec(&facts).unwrap_or_default().len()>60_000 { return Err(AppError::Invalid("The planning scope is too large for a single request".into())); }
    let disclosure=Disclosure {token:Uuid::new_v4().to_string(),provider:provider.as_str().into(),model,disclosure_url:provider.disclosure_url().into(),facts,labels,include_identifying:identifying};
    write(conn,DISCLOSURE,&Prepared {disclosure:disclosure.clone(),snapshot,fingerprint:fingerprint(conn,effective)?,revision:prefs.revision,refs})?;
    Ok(disclosure)
}
#[tauri::command]
pub fn prepare_automatic_planning(state:tauri::State<AppState>,include_identifying:bool)->Result<Disclosure> {
    state.require_unlocked()?;let conn=state.db.lock().unwrap();
    let (provider,_key,model)=resolve_ai_provider(&conn,managed_ai::AiCapability::AutomaticPlanning)?;
    prepare(&conn,provider,model,include_identifying)
}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct SuggestedSession { pub reference:String, pub starts_at:DateTime<Utc>, pub ends_at:DateTime<Utc> }
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Suggestion { pub order:Vec<String>, pub sessions:Vec<SuggestedSession>, pub explanation:String }
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Preview { pub token:String, pub review_id:String, pub provider:String, pub model:String, pub labels:Vec<TaskLabel>, pub order:Vec<String>, pub sessions:Vec<SuggestedSession>, pub explanation:String, pub before:Vec<PlanBlock>, pub protected:Vec<PlanBlock>, pub outcome:planner::PlanOutcome, pub excluded:Vec<String> }
fn prepared(conn:&Connection,token:&str)->Result<Prepared> {
    let value=read::<Prepared>(conn,DISCLOSURE)?.filter(|value|value.disclosure.token==token).ok_or_else(||AppError::Invalid("Review the planning disclosure again".into()))?;
    check_prepared(conn,&value)?;
    let (provider,_key,model)=resolve_ai_provider(conn,managed_ai::AiCapability::AutomaticPlanning)?;
    check_provider_binding(&value,provider,&model)?;
    Ok(value)
}
fn check_provider_binding(value:&Prepared,provider:ai_providers::ProviderId,model:&str)->Result<()> {
    if provider.as_str()!=value.disclosure.provider || model!=value.disclosure.model {return Err(AppError::Invalid("Provider or model changed. Review a fresh disclosure".into()));}
    Ok(())
}
fn check_prepared(conn:&Connection,value:&Prepared)->Result<()> {
    let now=Utc::now();
    if now-value.snapshot.effective_time>Duration::minutes(30) || value.snapshot.existing_blocks.iter().any(|block|!block.completed && !block.locked && block.starts_at>=value.snapshot.effective_time && block.starts_at<now) {
        return Err(AppError::Invalid("This planning review expired or a session has started. Review a fresh disclosure before requesting or applying a plan".into()));
    }
    let prefs=preferences(conn)?;
    if prefs.choice!=Choice::Enabled || prefs.revision!=value.revision || fingerprint(conn,value.snapshot.effective_time)?!=value.fingerprint {
        return Err(AppError::Invalid("Planning facts or consent changed. Review a fresh disclosure and request a new plan".into()));
    }
    Ok(())
}
fn authorize(conn:&Connection,value:&Prepared,consent:bool,standing:bool,identifying_consent:bool)->Result<()> {
    let prefs=preferences(conn)?;
    if standing {
        if prefs.consent_mode!=ConsentMode::StandingDeidentified || value.disclosure.include_identifying {
            return Err(AppError::Invalid("Standing authorization permits only de-identified planning facts".into()));
        }
    } else if !consent { return Err(AppError::Invalid("Explicit request consent is required".into())); }
    if value.disclosure.include_identifying && !identifying_consent {return Err(AppError::Invalid("Explicit identifying-data consent is required".into()));}
    Ok(())
}
fn task_id<'a>(value:&'a Prepared,reference:&str)->Result<&'a String> {
    let index=value.disclosure.labels.iter().position(|label|label.reference==reference).ok_or_else(||AppError::Invalid("AI referenced work outside the reviewed scope".into()))?;
    Ok(&value.refs[index])
}
fn protected(block:&PlanBlock,snapshot:&planner::PlannerSnapshot)->bool {
    block.task_id.is_none() || block.completed || block.locked || snapshot.existing_blocks.iter().any(|old|old.id==block.id && old.locked) || parse_utc(&block.starts_at).is_some_and(|time|time<snapshot.effective_time) || block.reason_codes.iter().any(|reason|reason=="manual_calendar_move")
}
fn build_preview(conn:&Connection,value:&Prepared,suggestion:Suggestion,excluded:Vec<String>)->Result<Preview> {
    if suggestion.sessions.len()>512 {return Err(AppError::Invalid("Too many proposed sessions".into()));}
    let expected=value.disclosure.labels.iter().map(|label|label.reference.clone()).collect::<std::collections::BTreeSet<_>>();
    let actual=suggestion.order.iter().cloned().collect::<std::collections::BTreeSet<_>>();
    if actual!=expected || suggestion.order.len()!=expected.len() || excluded.iter().any(|reference|!expected.contains(reference)) || suggestion.explanation.len()>4000 {
        return Err(AppError::Invalid("AI returned an invalid work order or explanation".into()));
    }
    let before=all_plan_blocks(conn)?;
    let protected_blocks=before.iter().filter(|block|protected(block,&value.snapshot)).cloned().collect::<Vec<_>>();
    let mut blocks=Vec::new();
    let mut sessions=suggestion.sessions.into_iter().filter(|session|!excluded.contains(&session.reference)).collect::<Vec<_>>();
    for reference in &excluded {
        let id=task_id(value,reference)?;
        sessions.extend(before.iter().filter(|block|block.task_id.as_ref()==Some(id)&&!protected(block,&value.snapshot)).map(|block|SuggestedSession { reference:reference.clone(),starts_at:parse_utc(&block.starts_at).unwrap(),ends_at:parse_utc(&block.ends_at).unwrap() }));
    }
    for (index,session) in sessions.iter().enumerate() {
        let id=task_id(value,&session.reference)?;
        let task=value.snapshot.tasks.iter().find(|task|&task.id==id).unwrap();
        blocks.push(planner::PlannedBlock {id:format!("ai-{}-{index}",value.disclosure.token),task_id:id.clone(),session_index:index as i64,title:task.title.clone(),starts_at:session.starts_at,ends_at:session.ends_at,location:task.location.clone(),reason_codes:vec!["ai_assisted_reviewed".into()]});
    }
    let mut snapshot=value.snapshot.clone();
    snapshot.generated_at=Utc::now();
    let gap=Duration::minutes(snapshot.preferences.break_minutes.max(snapshot.preferences.transition_minutes));
    if blocks.iter().any(|proposed|snapshot.existing_blocks.iter().any(|old| (old.completed||old.locked) && proposed.ends_at<=old.starts_at && proposed.ends_at+gap>old.starts_at)) {
        return Err(AppError::Invalid("Proposed sessions must leave a break before protected work".into()));
    }
    let outcome=planner::validate_proposed(&snapshot,&blocks).map_err(AppError::Invalid)?;
    Ok(Preview {token:value.disclosure.token.clone(),review_id:Uuid::new_v4().to_string(),provider:value.disclosure.provider.clone(),model:value.disclosure.model.clone(),labels:value.disclosure.labels.clone(),order:suggestion.order,sessions,explanation:suggestion.explanation,before,protected:protected_blocks,outcome,excluded})
}
struct RequestGuard;
impl Drop for RequestGuard {fn drop(&mut self){REQUEST_ACTIVE.store(false,Ordering::Release);}}
#[tauri::command]
pub async fn request_automatic_planning(state:tauri::State<'_,AppState>,token:String,consent:bool,standing:bool,identifying_consent:bool)->Result<Preview> {
    state.require_unlocked()?;
    let state=state.inner().clone();
    tauri::async_runtime::spawn_blocking(move|| {
        if REQUEST_ACTIVE.compare_exchange(false,true,Ordering::AcqRel,Ordering::Acquire).is_err(){return Err(AppError::Invalid("An AI planning request is already running".into()));}
        let _guard=RequestGuard;
        let (value,provider,key)={let conn=state.db.lock().unwrap();state.require_unlocked()?;let value=prepared(&conn,&token)?;authorize(&conn,&value,consent,standing,identifying_consent)?;let (provider,key,_)=resolve_ai_provider(&conn,managed_ai::AiCapability::AutomaticPlanning)?;(value,provider,key)};
        let started=Instant::now();
        let result=ai_providers::request_automatic_plan(provider,&key,&value.disclosure.model,&value.disclosure.facts);
        let conn=state.db.lock().unwrap();
        let elapsed=started.elapsed().as_millis().min(i64::MAX as u128) as i64;
        match result {
            Ok((suggestion,usage))=> {
                record_ai_invocation(&conn,provider.as_str(),managed_ai::AiCapability::AutomaticPlanning,Some(&value.disclosure.model),elapsed,usage.input_tokens,usage.output_tokens,"success",None)?;
                state.require_unlocked()?; prepared(&conn,&token)?;
                let preview=build_preview(&conn,&value,suggestion,vec![])?;
                write(&conn,PREVIEW,&preview)?;Ok(preview)
            }
            Err(error)=> {record_ai_invocation(&conn,provider.as_str(),managed_ai::AiCapability::AutomaticPlanning,Some(&value.disclosure.model),elapsed,0,0,"failed",Some(ai_error_category(&error)))?;Err(error.into())}
        }
    }).await.map_err(|error|AppError::Background(error.to_string()))?
}
#[tauri::command]
pub fn validate_automatic_planning(state:tauri::State<AppState>,token:String,order:Vec<String>,sessions:Option<Vec<SuggestedSession>>,excluded:Vec<String>)->Result<Preview> {
    state.require_unlocked()?;let conn=state.db.lock().unwrap();let value=prepared(&conn,&token)?;
    let old=read::<Preview>(&conn,PREVIEW)?.filter(|preview|preview.token==token).ok_or_else(||AppError::Invalid("No AI plan is pending".into()))?;
    let sessions=if let Some(sessions)=sessions {sessions} else {
        let ids=order.iter().map(|reference|task_id(&value,reference).cloned()).collect::<Result<Vec<_>>>()?;
        let outcome=planner::generate_ordered(&value.snapshot,&ids).map_err(AppError::Invalid)?;
        outcome.blocks.iter().map(|block|SuggestedSession {reference:value.disclosure.labels[value.refs.iter().position(|id|id==&block.task_id).unwrap()].reference.clone(),starts_at:block.starts_at,ends_at:block.ends_at}).collect()
    };
    let preview=build_preview(&conn,&value,Suggestion {order,sessions,explanation:old.explanation},excluded)?;
    write(&conn,PREVIEW,&preview)?;Ok(preview)
}
#[derive(Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Status {pub preferences:Preferences,pub prompt:bool,pub fingerprint:Option<String>,pub pending:Option<Preview>}
#[tauri::command]
pub fn get_automatic_planning_status(state:tauri::State<AppState>)->Result<Status> {
    state.require_unlocked()?;let conn=state.db.lock().unwrap();let prefs=preferences(&conn)?;
    let ready=resolve_ai_provider(&conn,managed_ai::AiCapability::AutomaticPlanning).is_ok();
    let fingerprint=if !profile::onboarding_state(&conn)?.required {
        let mut snapshot=ai_snapshot(&conn,Utc::now().date_naive().and_hms_opt(0,0,0).unwrap().and_utc())?;
        snapshot.existing_blocks.retain(|block|block.locked||block.completed);
        Some(hash(&snapshot)?)
    }else{None};
    Ok(Status {prompt:prefs.choice==Choice::Undecided && ready,preferences:prefs,fingerprint,pending:read(&conn,PREVIEW)?})
}
#[tauri::command]
pub fn discard_automatic_planning(state:tauri::State<AppState>)->Result<()> {
    state.require_unlocked()?;let conn=state.db.lock().unwrap();conn.execute("DELETE FROM settings WHERE key IN (?1,?2)",params![DISCLOSURE,PREVIEW])?;Ok(())
}

#[derive(Debug,Serialize,Deserialize,PartialEq)]
pub struct Auxiliary {capacity:Option<String>,conflicts:Vec<Value>}
const CONFLICT_COLUMNS:&str="id,description,resolved,kind,candidate_id,entity_type,entity_id,current_due_at,proposed_due_at,current_starts_at,proposed_starts_at,current_ends_at,proposed_ends_at,detected_at,resolved_at,resolution";
pub fn capture_auxiliary(conn:&Connection)->Result<Auxiliary> {
    let pairs=CONFLICT_COLUMNS.split(',').map(|name|format!("'{name}',{name}")).collect::<Vec<_>>().join(",");
    let mut query=conn.prepare(&format!("SELECT json_object({pairs}) FROM source_conflicts WHERE kind='overload' ORDER BY id"))?;
    let raw=query.query_map([],|row|row.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
    Ok(Auxiliary {capacity:conn.query_row("SELECT value FROM settings WHERE key='plan_capacity'",[],|row|row.get(0)).optional()?,conflicts:raw.iter().map(|raw|serde_json::from_str(raw).map_err(|_|AppError::Invalid("Invalid capacity state".into()))).collect::<Result<_>>()?})
}
pub fn restore_auxiliary(conn:&Connection,value:&Auxiliary)->Result<()> {
    conn.execute("DELETE FROM settings WHERE key='plan_capacity'",[])?;
    if let Some(capacity)=&value.capacity {conn.execute("INSERT INTO settings(key,value) VALUES('plan_capacity',?1)",[capacity])?;}
    conn.execute("DELETE FROM source_conflicts WHERE kind='overload'",[])?;
    let expressions=CONFLICT_COLUMNS.split(',').map(|name|format!("json_extract(?1,'$.{name}')")).collect::<Vec<_>>().join(",");
    for conflict in &value.conflicts {conn.execute(&format!("INSERT INTO source_conflicts({CONFLICT_COLUMNS}) SELECT {expressions}"),[conflict.to_string()])?;}
    Ok(())
}
fn apply_reviewed(conn:&Connection,value:&Prepared,review_id:&str,confirmed:bool)->Result<()> {
    check_prepared(conn,value)?;
    let token=&value.disclosure.token;
    if !confirmed {return Err(AppError::Invalid("Confirm applying the reviewed calendar changes".into()));}
    let preview=read::<Preview>(conn,PREVIEW)?.filter(|preview|&preview.token==token).ok_or_else(||AppError::Invalid("No reviewed AI plan is pending".into()))?;
    if preview.review_id!=review_id { return Err(AppError::Invalid("The preview changed; review its current changes before applying".into())); }
    let checked=build_preview(conn,value,Suggestion {order:preview.order,sessions:preview.sessions,explanation:preview.explanation},preview.excluded)?;
    let before_auxiliary=capture_auxiliary(conn)?;
    let tx=conn.unchecked_transaction()?;
    let excluded_ids=checked.excluded.iter().map(|reference|task_id(value,reference).cloned()).collect::<Result<Vec<_>>>()?;
    // Delete only replaceable work. Fixed/protected records are never upserted.
    for block in checked.before.iter().filter(|block|!protected(block,&value.snapshot) && !block.task_id.as_ref().is_some_and(|id|excluded_ids.contains(id))) {tx.execute("DELETE FROM plan_blocks WHERE id=?1",[&block.id])?;}
    for block in checked.outcome.blocks.iter().filter(|block|!excluded_ids.contains(&block.task_id)) {
        tx.execute("INSERT INTO plan_blocks(id,task_id,starts_at,ends_at,title,kind,completed,locked,started_at,session_index,location,reason_codes) VALUES(?1,?2,?3,?4,?5,'study',0,0,NULL,?6,?7,?8)",params![block.id,block.task_id,block.starts_at.to_rfc3339(),block.ends_at.to_rfc3339(),block.title,block.session_index,block.location,serde_json::to_string(&block.reason_codes).unwrap()])?;
    }
    write(&tx,"plan_capacity",&checked.outcome.capacity)?;
    tx.execute("UPDATE source_conflicts SET resolved=1,resolved_at=?1,resolution='capacity_recomputed' WHERE kind='overload' AND resolved=0",[Utc::now().to_rfc3339()])?;
    for conflict in &checked.outcome.overload_conflicts {
        tx.execute("INSERT INTO source_conflicts(id,description,resolved,kind,entity_type,entity_id,detected_at) VALUES(?1,?2,0,'overload','task',?3,?4) ON CONFLICT(id) DO UPDATE SET description=excluded.description,resolved=0,resolved_at=NULL,resolution=NULL,detected_at=excluded.detected_at",params![format!("overload-{}",conflict.task_id),format!("{} has {} unscheduled minutes",conflict.title,conflict.unscheduled_minutes),conflict.task_id,Utc::now().to_rfc3339()])?;
    }
    let after_blocks=all_plan_blocks(&tx)?;
    write(&tx,"plan_generation_undo",&PlanGenerationUndo {token:token.clone(),before_blocks:checked.before,after_blocks,before_auxiliary:Some(before_auxiliary),after_auxiliary:Some(capture_auxiliary(&tx)?)})?;
    write(&tx,"plan_generation_summary",&PlanGenerationSummary {ai_assisted:true,undo_token:token.clone(),generated_at:Utc::now().to_rfc3339(),imported_assignments:0,assessments:0,available_study_minutes:checked.outcome.capacity.available_minutes,generated_sessions:checked.outcome.blocks.len() as i64,preserved_sessions:checked.protected.len() as i64,conflict_count:checked.outcome.overload_conflicts.len() as i64})?;
    tx.execute("DELETE FROM settings WHERE key IN (?1,?2)",params![DISCLOSURE,PREVIEW])?;
    mutation(&tx,"plan",token,"ai_plan_applied","{}")?;
    tx.commit()?;Ok(())
}
#[tauri::command]
pub fn apply_automatic_planning(state:tauri::State<AppState>,token:String,review_id:String,confirmed:bool)->Result<Dashboard> {
    state.require_unlocked()?;let conn=state.db.lock().unwrap();let value=prepared(&conn,&token)?;apply_reviewed(&conn,&value,&review_id,confirmed)?;dashboard_with_notice(&conn,&state.ocr,Some("Reviewed AI-assisted plan applied. Undo is available on Today.".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture()->(tempfile::TempDir,Connection) {
        let directory=tempfile::tempdir().unwrap();
        let mut conn=open_database(&directory.path().join("planning.db"),&random_key()).unwrap();
        crate::tests::complete_test_onboarding(&mut conn);
        conn.execute("INSERT INTO tasks(id,title,minutes,priority,created_at) VALUES('private-task-id','Email Dr. Jane Student at jane@example.com',60,3,?1)",[Utc::now().to_rfc3339()]).unwrap();
        save_preferences(&conn,Choice::Enabled,ConsentMode::PerRequest,false).unwrap();
        (directory,conn)
    }
    fn prepared_fixture(conn:&Connection)->Prepared {
        let effective=Utc::now();
        let snapshot=ai_snapshot(conn,effective).unwrap();
        let (facts,labels,refs)=facts(&snapshot,false,&semester_analysis::PlannerProfile {study_goals:"Jane's private goal".into(),..Default::default()});
        Prepared {disclosure:Disclosure {token:Uuid::new_v4().to_string(),provider:"openai".into(),model:"fixture".into(),disclosure_url:"https://example.com".into(),facts,labels,include_identifying:false},snapshot,fingerprint:fingerprint(conn,effective).unwrap(),revision:preferences(conn).unwrap().revision,refs}
    }
    fn suggestion(value:&Prepared)->Suggestion {
        let outcome=planner::generate(&value.snapshot).unwrap();
        Suggestion {order:value.disclosure.labels.iter().map(|label|label.reference.clone()).collect(),sessions:outcome.blocks.iter().map(|block|SuggestedSession {reference:value.disclosure.labels[value.refs.iter().position(|id|id==&block.task_id).unwrap()].reference.clone(),starts_at:block.starts_at,ends_at:block.ends_at}).collect(),explanation:"Fixture proposes existing work only".into()}
    }
    #[test]
    fn choices_and_standing_consent_persist_across_database_reopen() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("prefs.db");let key=random_key();
        let conn=open_database(&path,&key).unwrap();assert_eq!(preferences(&conn).unwrap().choice,Choice::Undecided);
        assert!(save_preferences(&conn,Choice::Enabled,ConsentMode::StandingDeidentified,false).is_err());
        save_preferences(&conn,Choice::Disabled,ConsentMode::PerRequest,false).unwrap();drop(conn);
        let conn=open_database(&path,&key).unwrap();assert_eq!(preferences(&conn).unwrap().choice,Choice::Disabled);
        save_preferences(&conn,Choice::Enabled,ConsentMode::StandingDeidentified,true).unwrap();drop(conn);
        let conn=open_database(&path,&key).unwrap();assert_eq!(preferences(&conn).unwrap().consent_mode,ConsentMode::StandingDeidentified);
        write(&conn,PREVIEW,&json!({"pending":true})).unwrap();
        clear_restore_authorization(&conn).unwrap();assert_eq!(preferences(&conn).unwrap().consent_mode,ConsentMode::PerRequest);assert!(read::<Value>(&conn,PREVIEW).unwrap().is_none());
        save_preferences(&conn,Choice::Undecided,ConsentMode::PerRequest,false).unwrap();assert_eq!(preferences(&conn).unwrap().choice,Choice::Undecided);
    }
    #[test]
    fn default_facts_never_include_private_ids_or_free_text() {
        let (_directory,conn)=fixture();let value=prepared_fixture(&conn);let raw=value.disclosure.facts.to_string();
        for secret in ["private-task-id","Jane","jane@example.com","Planner Test","Fixed class","campus","private goal"] {assert!(!raw.contains(secret),"leaked {secret}");}
        assert!(raw.contains("work-1"));
        let (identified,_,_)=facts(&value.snapshot,true,&semester_analysis::PlannerProfile {study_goals:"Jane's private goal".into(),..Default::default()});
        assert!(identified.to_string().contains("jane@example.com"));assert!(identified.to_string().contains("private goal"));
        assert!(!identified.to_string().contains("private-task-id"));
    }
    #[test]
    fn requests_require_explicit_scope_authorization_and_revocation_invalidates_work() {
        let (_dir,conn)=fixture();let mut value=prepared_fixture(&conn);
        assert!(authorize(&conn,&value,false,false,false).is_err());assert!(authorize(&conn,&value,true,false,false).is_ok());
        assert!(authorize(&conn,&value,false,true,false).is_err());
        save_preferences(&conn,Choice::Enabled,ConsentMode::StandingDeidentified,true).unwrap();
        assert!(check_prepared(&conn,&value).is_err());
        value=prepared_fixture(&conn);assert!(authorize(&conn,&value,false,true,false).is_ok());
        value.disclosure.include_identifying=true;
        assert!(authorize(&conn,&value,false,true,true).is_err());assert!(authorize(&conn,&value,true,false,false).is_err());assert!(authorize(&conn,&value,true,false,true).is_ok());
        save_preferences(&conn,Choice::Disabled,ConsentMode::PerRequest,false).unwrap();assert!(check_prepared(&conn,&value).is_err());
    }
    #[test]
    fn proposals_are_read_only_and_reject_unknown_work_bad_times_and_durations() {
        let (_dir,conn)=fixture();let value=prepared_fixture(&conn);let before=all_plan_blocks(&conn).unwrap();
        let proposed=suggestion(&value);assert!(!proposed.sessions.is_empty());
        let preview=build_preview(&conn,&value,proposed.clone(),vec![]).unwrap();assert!(!preview.outcome.blocks.is_empty());assert_eq!(all_plan_blocks(&conn).unwrap(),before);
        let mut invalid=proposed.clone();invalid.sessions[0].reference="invented".into();assert!(build_preview(&conn,&value,invalid,vec![]).is_err());
        let mut invalid=proposed.clone();invalid.order.push(invalid.order[0].clone());assert!(build_preview(&conn,&value,invalid,vec![]).is_err());
        let mut invalid=proposed.clone();invalid.sessions[0].ends_at+=Duration::minutes(500);assert!(build_preview(&conn,&value,invalid,vec![]).is_err());
        let mut invalid=proposed;invalid.sessions[0].starts_at=Utc::now()-Duration::hours(1);invalid.sessions[0].ends_at=invalid.sessions[0].starts_at+Duration::minutes(60);assert!(build_preview(&conn,&value,invalid,vec![]).is_err());
    }
    #[test]
    fn reviewed_apply_and_undo_restore_calendar_capacity_and_conflicts_exactly() {
        let (_dir,conn)=fixture();regenerate_plan(&conn,None).unwrap();
        let value=prepared_fixture(&conn);let preview=build_preview(&conn,&value,suggestion(&value),vec![]).unwrap();
        let before=all_plan_blocks(&conn).unwrap();let auxiliary=capture_auxiliary(&conn).unwrap();
        write(&conn,PREVIEW,&preview).unwrap();assert!(apply_reviewed(&conn,&value,&preview.review_id,false).is_err());assert!(apply_reviewed(&conn,&value,"old-review",true).is_err());
        apply_reviewed(&conn,&value,&preview.review_id,true).unwrap();assert!(read::<Preview>(&conn,PREVIEW).unwrap().is_none());
        undo_generated_plan_in(&conn,&preview.token).unwrap();assert_eq!(all_plan_blocks(&conn).unwrap(),before);assert_eq!(capture_auxiliary(&conn).unwrap(),auxiliary);
    }
    #[test]
    fn stale_preview_and_newer_calendar_edits_cannot_be_overwritten() {
        let (_dir,conn)=fixture();let value=prepared_fixture(&conn);let preview=build_preview(&conn,&value,suggestion(&value),vec![]).unwrap();write(&conn,PREVIEW,&preview).unwrap();
        conn.execute("UPDATE tasks SET priority=4 WHERE id='private-task-id'",[]).unwrap();assert!(apply_reviewed(&conn,&value,&preview.review_id,true).is_err());
        let value=prepared_fixture(&conn);let preview=build_preview(&conn,&value,suggestion(&value),vec![]).unwrap();write(&conn,PREVIEW,&preview).unwrap();apply_reviewed(&conn,&value,&preview.review_id,true).unwrap();
        conn.execute("UPDATE plan_blocks SET locked=1 WHERE task_id='private-task-id'",[]).unwrap();assert!(undo_generated_plan_in(&conn,&preview.token).is_err());
    }
    #[test]
    fn manual_provenance_is_protected_even_after_unlocking() {
        let (_dir,conn)=fixture();regenerate_plan(&conn,None).unwrap();
        let id=all_plan_blocks(&conn).unwrap().into_iter().find(|block|block.task_id.as_deref()==Some("private-task-id")).unwrap().id;
        conn.execute("UPDATE plan_blocks SET locked=0,reason_codes='[\"manual_calendar_move\"]' WHERE id=?1",[&id]).unwrap();
        let manual=all_plan_blocks(&conn).unwrap().into_iter().find(|block|block.id==id).unwrap();
        let value=prepared_fixture(&conn);assert!(value.snapshot.existing_blocks.iter().find(|block|block.id==id).unwrap().locked);
        let preview=build_preview(&conn,&value,suggestion(&value),vec![]).unwrap();assert!(preview.protected.contains(&manual));
        write(&conn,PREVIEW,&preview).unwrap();apply_reviewed(&conn,&value,&preview.review_id,true).unwrap();assert!(all_plan_blocks(&conn).unwrap().contains(&manual));
        let deterministic=planner_snapshot(&conn,value.snapshot.effective_time,planner::PlannerTrigger::Initial).unwrap();
        assert!(!deterministic.existing_blocks.iter().find(|block|block.id==id).unwrap().locked,"AI-specific protection must not change the deterministic planner after decline");
    }
    #[test]
    fn provider_or_model_changes_require_fresh_disclosure_and_no_fallback() {
        let (_dir,conn)=fixture();let value=prepared_fixture(&conn);
        assert!(check_provider_binding(&value,ai_providers::ProviderId::Openai,"fixture").is_ok());
        assert!(check_provider_binding(&value,ai_providers::ProviderId::Anthropic,"fixture").is_err());
        assert!(check_provider_binding(&value,ai_providers::ProviderId::Openai,"changed-model").is_err());
    }
    #[test]
    fn exclusions_retain_sessions_and_changed_goals_invalidate_scope() {
        let (_dir,conn)=fixture();regenerate_plan(&conn,None).unwrap();let value=prepared_fixture(&conn);
        let before=all_plan_blocks(&conn).unwrap();let preview=build_preview(&conn,&value,suggestion(&value),vec!["work-1".into()]).unwrap();
        let task_sessions=before.iter().filter(|block|block.task_id.as_deref()==Some("private-task-id")).collect::<Vec<_>>();
        assert_eq!(preview.sessions.len(),task_sessions.len());
        for original in task_sessions { assert!(preview.sessions.iter().any(|session|session.starts_at==parse_utc(&original.starts_at).unwrap()&&session.ends_at==parse_utc(&original.ends_at).unwrap())); }
        semester_analysis::save_profile(&conn,semester_analysis::PlannerProfile {study_goals:"New goals".into(),..Default::default()}).unwrap();
        assert!(check_prepared(&conn,&value).is_err());
    }

    #[test]
    fn excluded_tasks_keep_exact_canonical_block_identity_and_metadata() {
        let (_dir,conn)=fixture();regenerate_plan(&conn,None).unwrap();let value=prepared_fixture(&conn);
        let before=all_plan_blocks(&conn).unwrap();let preview=build_preview(&conn,&value,suggestion(&value),vec!["work-1".into()]).unwrap();
        write(&conn,PREVIEW,&preview).unwrap();apply_reviewed(&conn,&value,&preview.review_id,true).unwrap();assert_eq!(all_plan_blocks(&conn).unwrap(),before);
    }

    #[test]
    fn time_passage_cannot_make_previous_future_blocks_replaceable_past_work() {
        let (_dir,conn)=fixture();let mut value=prepared_fixture(&conn);
        value.snapshot.effective_time=Utc::now()-Duration::minutes(31);
        value.fingerprint=fingerprint(&conn,value.snapshot.effective_time).unwrap();
        assert!(check_prepared(&conn,&value).is_err());
        let mut value=prepared_fixture(&conn);
        value.snapshot.existing_blocks.push(planner::ExistingBlock {id:"just-started".into(),task_id:"private-task-id".into(),starts_at:Utc::now()-Duration::seconds(1),ends_at:Utc::now()+Duration::minutes(30),completed:false,locked:false,location:String::new(),course_id:None});
        value.snapshot.effective_time=Utc::now()-Duration::seconds(2);
        assert!(check_prepared(&conn,&value).is_err());
    }

}
