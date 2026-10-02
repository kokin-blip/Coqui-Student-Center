use crate::{AppError,AppState,Result,ai_providers,managed_ai};
use rusqlite::{Connection,OptionalExtension};
use serde::{Serialize,Deserialize};
use serde_json::{Value,json};
#[derive(Deserialize)]#[serde(rename_all="camelCase")]
pub struct Input {pub goals:String,pub opportunity_ids:Vec<String>,pub source_scope:String,pub expected_provider:String,pub expected_model:String,pub consent:bool}
#[derive(Serialize)]#[serde(rename_all="camelCase")]
pub struct Response {pub terms:Vec<String>,pub provider:String,pub model:String}
pub fn scope(db:&Connection,goals:&str,ids:&[String])->Result<Value>{
 if goals.trim().is_empty()||goals.len()>2000||ids.len()>4{return Err(AppError::Invalid("Enter goals up to 2,000 characters and select up to four opportunities".into()));}
 let mut sources=Vec::new();for id in ids{let raw=db.query_row("SELECT payload FROM scholarship_opportunities WHERE id=?1",[id],|r|r.get::<_,String>(0)).optional()?.ok_or_else(||AppError::Invalid("Selected opportunity is no longer available".into()))?;let item:Value=serde_json::from_str(&raw).map_err(|_|AppError::Invalid("Source evidence could not be read".into()))?;
 // Explicit public-source allowlist. Never read a funding profile, student notes, or identity fields.
 sources.push(json!({"id":item["id"],"title":item["title"],"summary":item.get("summary").cloned().unwrap_or(json!("")),"sourceUrl":item["canonicalUrl"],"fetchedAt":item["fetchedAt"]}));}
 Ok(json!({"goals":goals,"opportunities":sources}))
}
#[tauri::command]
pub fn prepare_funding_search(state:tauri::State<AppState>,goals:String,opportunity_ids:Vec<String>)->Result<Value>{state.require_unlocked()?;scope(&state.db.lock().unwrap(),&goals,&opportunity_ids)}
#[tauri::command]
pub async fn request_funding_search(state:tauri::State<'_,AppState>,input:Input)->Result<Response>{state.require_unlocked()?;if !input.consent{return Err(AppError::Invalid("Review the exact data and consent before asking AI".into()));}let state=state.inner().clone();tauri::async_runtime::spawn_blocking(move||{
 let(provider,key,model,scope)={let db=state.db.lock().unwrap();crate::require_onboarded(&db)?;let reviewed:Value=serde_json::from_str(&input.source_scope).map_err(|_|AppError::Invalid("Review the data scope again".into()))?;let current=scope(&db,&input.goals,&input.opportunity_ids)?;if reviewed!=current{return Err(AppError::Invalid("Source evidence changed. Review the data scope again".into()));}let resolved=crate::resolve_ai_provider(&db,managed_ai::AiCapability::FundingSearch)?;if resolved.0.as_str()!=input.expected_provider||resolved.2!=input.expected_model{return Err(AppError::Invalid("AI settings changed. Review the provider and data again".into()));}(resolved.0,resolved.1,resolved.2,current)};
 let started=std::time::Instant::now();let result=ai_providers::request_funding_search(provider,&key,&model,&scope.to_string());let db=state.db.lock().unwrap();match result{Ok((terms,usage))=>{crate::record_ai_invocation(&db,provider.as_str(),managed_ai::AiCapability::FundingSearch,Some(&model),started.elapsed().as_millis() as i64,usage.input_tokens,usage.output_tokens,"success",None)?;Ok(Response{terms,provider:provider.as_str().into(),model})},Err(error)=>{crate::record_ai_invocation(&db,provider.as_str(),managed_ai::AiCapability::FundingSearch,Some(&model),started.elapsed().as_millis() as i64,0,0,"failed",Some(crate::ai_error_category(&error)))?;Err(AppError::ManagedAi(error))}}
 }).await.map_err(|_|AppError::Invalid("AI search guidance stopped. Local search remains available".into()))?}

pub fn validate_criteria(value:&Value)->Result<()> {
 let criteria=value.as_array().ok_or_else(||AppError::Invalid("Eligibility criteria must be a list".into()))?;
 if criteria.len()>25{return Err(AppError::Invalid("Record up to 25 explicit criteria".into()));}
 for c in criteria {
  let attribute=c["attribute"].as_str().unwrap_or_default();let quote=c["sourceQuote"].as_str().unwrap_or_default();let url=c["sourceUrl"].as_str().unwrap_or_default();let values=c["values"].as_array().ok_or_else(||AppError::Invalid("Criterion values must be a list".into()))?;
  if !matches!(attribute,"culturalBackground"|"religion"|"affiliations")||quote.trim().is_empty()||quote.len()>2000||crate::canvas_calendar::validate_url(url).is_err()||c["capturedAt"].as_str().is_none_or(|s|chrono::DateTime::parse_from_rfc3339(s).is_err())||c["ambiguous"].as_bool().is_none()||values.len()>25||values.iter().any(|v|v.as_str().is_none_or(|s|s.trim().is_empty()||s.len()>120)){
   return Err(AppError::Invalid("Record an explicit criterion, its source URL, and captured date".into()));
  }
  if c["ambiguous"]==false&&(values.is_empty()||values.iter().any(|v|!quote.to_lowercase().contains(&v.as_str().unwrap_or_default().to_lowercase()))){return Err(AppError::Invalid("Unambiguous values need literal source support".into()));}
 }Ok(())
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn reviewed_scope_never_reads_identity_or_student_notes(){let db=Connection::open_in_memory().unwrap();db.execute_batch("CREATE TABLE scholarship_opportunities(id TEXT,payload TEXT);CREATE TABLE scholarship_profiles(payload TEXT);INSERT INTO scholarship_profiles VALUES('{\"religion\":[\"Private identity\"]}');").unwrap();db.execute("INSERT INTO scholarship_opportunities VALUES('o',?1)",[json!({"id":"o","title":"Public opportunity","summary":"Published requirements","canonicalUrl":"https://example.edu","fetchedAt":"2026-10-02","notes":"Private student note","religion":"Private saved trait"}).to_string()]).unwrap();let scope=scope(&db,"Summer research",&["o".into()]).unwrap().to_string();assert!(scope.contains("Published requirements"));assert!(!scope.contains("Private"));assert!(!scope.contains("religion"));}
 #[test]fn unsupported_criteria_cannot_claim_an_unambiguous_match(){let mut c=json!([{"attribute":"religion","values":["Quaker"],"sourceQuote":"Students may apply","sourceUrl":"https://example.edu","capturedAt":"2026-10-02T12:00:00Z","ambiguous":false}]);assert!(validate_criteria(&c).is_err());c[0]["ambiguous"]=json!(true);assert!(validate_criteria(&c).is_ok());}
}
