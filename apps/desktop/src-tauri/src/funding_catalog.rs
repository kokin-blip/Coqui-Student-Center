//! Signed, public funding batches. No student profile or account token is sent.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, NaiveDate};
use reqwest::{blocking::Client, redirect::Policy, Url};
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{io::Read, time::Duration};

const MAX_BATCH_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PAGES: usize = 100;

#[derive(Debug, thiserror::Error)]
pub enum CatalogError {
    #[error("the public funding catalog is not configured in this build")]
    NotConfigured,
    #[error("the public funding catalog configuration is invalid")]
    InvalidConfiguration,
    #[error("the public funding catalog could not be reached")]
    Network,
    #[error("the public funding catalog returned invalid or unsigned data")]
    InvalidResponse,
}

#[derive(Deserialize)]
struct SignedEnvelope { payload:String,signature:String,algorithm:String }

#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
struct CatalogBatch { version:u8,fetched_at:String,cursor:usize,next_cursor:Option<String>,#[serde(default)] partial:bool,#[serde(default)] source_failures:Vec<String>,opportunities:Vec<CatalogOpportunity> }

#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
struct CatalogOpportunity {
    canonical_url:String,source_url:String,application_url:String,provider:String,title:String,
    opportunity_type:String,summary:String,updated_at:String,parser_version:String,
    #[serde(default)] eligibility_criteria:Vec<Value>,
    #[serde(default)] study_levels:Vec<String>,
    #[serde(default)] fields_of_study:Vec<String>,
    #[serde(default)] locations:Vec<String>,
    #[serde(default)] citizenship:Vec<String>,
    #[serde(default)] residency:Vec<String>,
    #[serde(default)] required_documents:Vec<String>,
    award_minimum:Option<f64>,award_maximum:Option<f64>,currency:Option<String>,
    deadline:Option<String>,deadline_label:Option<String>,minimum_gpa:Option<f64>,
    recommendations_required:Option<u32>,
}

fn public_https(raw:&str)->bool{
    Url::parse(raw).is_ok_and(|url|url.scheme()=="https"&&url.host_str().is_some()&&url.username().is_empty()&&url.password().is_none()&&url.fragment().is_none())
}

fn verify_batch(envelope:SignedEnvelope,key:&[u8],expected_cursor:usize)->Result<CatalogBatch,CatalogError>{
    if envelope.algorithm!="Ed25519"||key.len()!=32{return Err(CatalogError::InvalidResponse);}
    let payload=URL_SAFE_NO_PAD.decode(envelope.payload).map_err(|_|CatalogError::InvalidResponse)?;
    let signature=URL_SAFE_NO_PAD.decode(envelope.signature).map_err(|_|CatalogError::InvalidResponse)?;
    if payload.len()>MAX_BATCH_BYTES as usize||signature.len()!=64||UnparsedPublicKey::new(&ED25519,key).verify(&payload,&signature).is_err(){return Err(CatalogError::InvalidResponse);}
    let batch:CatalogBatch=serde_json::from_slice(&payload).map_err(|_|CatalogError::InvalidResponse)?;
    if batch.version!=1||DateTime::parse_from_rfc3339(&batch.fetched_at).is_err()||batch.opportunities.len()>100||batch.cursor!=expected_cursor+batch.opportunities.len()||batch.source_failures.len()>5||batch.source_failures.iter().any(|failure|failure.len()>160){return Err(CatalogError::InvalidResponse);}
    if batch.next_cursor.as_deref().is_some_and(|next|next.parse::<usize>().ok()!=Some(batch.cursor)||batch.opportunities.is_empty()){return Err(CatalogError::InvalidResponse);}
    Ok(batch)
}

fn normalized(item:CatalogOpportunity,fetched_at:&str)->Result<Value,CatalogError>{
    if !public_https(&item.canonical_url)||!public_https(&item.source_url)||!public_https(&item.application_url)||item.provider.trim().is_empty()||item.title.trim().len()<3||item.title.len()>240||item.summary.len()>2000||item.parser_version.trim().is_empty()||DateTime::parse_from_rfc3339(&item.updated_at).is_err()||!matches!(item.opportunity_type.as_str(),"scholarship"|"grant"|"fellowship"|"stipend"|"award"|"emergency_fund"|"tuition_assistance"|"research_funding"|"internship_stipend"|"competition") {return Err(CatalogError::InvalidResponse);}
    if item.deadline.as_deref().is_some_and(|date|NaiveDate::parse_from_str(date,"%Y-%m-%d").is_err())||item.minimum_gpa.is_some_and(|value|!value.is_finite()||!(0.0..=5.0).contains(&value))||item.award_minimum.is_some_and(|value|!value.is_finite()||value<0.0)||item.award_maximum.is_some_and(|value|!value.is_finite()||value<0.0)||item.award_minimum.zip(item.award_maximum).is_some_and(|(min,max)|min>max){return Err(CatalogError::InvalidResponse);}
    let digest=hex::encode(Sha256::digest(item.canonical_url.as_bytes()));
    crate::funding_search::validate_criteria(&json!(item.eligibility_criteria)).map_err(|_|CatalogError::InvalidResponse)?;
    let date_precision=item.deadline.as_ref().map(|_|"date");
    Ok(json!({"id":format!("coqui-public-catalog:{}",&digest[..24]),"sourceId":"coqui-public-catalog","canonicalUrl":item.canonical_url,"sourceUrl":item.source_url,"applicationUrl":item.application_url,"provider":item.provider,"title":item.title,"opportunityType":item.opportunity_type,"summary":item.summary,"parserVersion":item.parser_version,"sourceUpdatedAt":item.updated_at,"awardMinimum":item.award_minimum,"awardMaximum":item.award_maximum,"currency":item.currency.unwrap_or_else(||"USD".into()),"deadline":item.deadline,"deadlineLabel":item.deadline_label,"datePrecision":date_precision,"eligibilityCriteria":item.eligibility_criteria,"studyLevels":item.study_levels,"fieldsOfStudy":item.fields_of_study,"locations":item.locations,"citizenship":item.citizenship,"residency":item.residency,"minimumGpa":item.minimum_gpa,"requiredDocuments":item.required_documents,"recommendationsRequired":item.recommendations_required,"essayPrompts":[],"fetchedAt":fetched_at,"freshness":"fresh","verificationStatus":"unverified","aiPolicy":"unknown","notes":"","priority":"medium","state":"discovered","taskIds":[]}))
}

pub struct CatalogRefresh { pub opportunities:Vec<Value>,pub fetched_at:String,pub partial:bool,pub source_failures:Vec<String> }

pub fn configured()->bool{option_env!("STUDENT_CENTER_CLOUD_API_URL").is_some()&&option_env!("STUDENT_CENTER_FUNDING_CATALOG_PUBLIC_KEY").is_some()}

pub fn fetch()->Result<CatalogRefresh,CatalogError>{
    let origin=option_env!("STUDENT_CENTER_CLOUD_API_URL").ok_or(CatalogError::NotConfigured)?;
    let key=option_env!("STUDENT_CENTER_FUNDING_CATALOG_PUBLIC_KEY").ok_or(CatalogError::NotConfigured)?;
    let key=URL_SAFE_NO_PAD.decode(key).map_err(|_|CatalogError::InvalidConfiguration)?;
    if key.len()!=32{return Err(CatalogError::InvalidConfiguration);}
    let base=Url::parse(origin).map_err(|_|CatalogError::InvalidConfiguration)?;
    if base.scheme()!="https"||base.host_str().is_none()||base.username()!=""||base.password().is_some()||base.path()!="/"||base.query().is_some()||base.fragment().is_some(){return Err(CatalogError::InvalidConfiguration);}
    let client=Client::builder().redirect(Policy::none()).no_proxy().connect_timeout(Duration::from_secs(8)).timeout(Duration::from_secs(20)).build().map_err(|_|CatalogError::Network)?;
    let mut cursor=0usize;let mut all=Vec::new();let mut partial=false;let mut source_failures=Vec::new();
    for _ in 0..MAX_PAGES{
        let mut endpoint=base.join("v1/funding/catalog").map_err(|_|CatalogError::InvalidConfiguration)?;
        endpoint.query_pairs_mut().append_pair("cursor",&cursor.to_string());
        let response=client.get(endpoint).send().map_err(|_|CatalogError::Network)?;
        if !response.status().is_success()||response.content_length().is_some_and(|size|size>MAX_BATCH_BYTES){return Err(CatalogError::Network);}
        let mut bytes=Vec::new();response.take(MAX_BATCH_BYTES+1).read_to_end(&mut bytes).map_err(|_|CatalogError::Network)?;
        if bytes.len() as u64>MAX_BATCH_BYTES{return Err(CatalogError::InvalidResponse);}
        let envelope:SignedEnvelope=serde_json::from_slice(&bytes).map_err(|_|CatalogError::InvalidResponse)?;
        let batch=verify_batch(envelope,&key,cursor)?;
        let fetched_at=batch.fetched_at.clone();
        partial|=batch.partial;
        for failure in &batch.source_failures{if !source_failures.contains(failure){source_failures.push(failure.clone());}}
        for item in batch.opportunities{all.push(normalized(item,&fetched_at)?);}
        if batch.next_cursor.is_none(){return if all.is_empty(){Err(CatalogError::InvalidResponse)}else{Ok(CatalogRefresh{opportunities:all,fetched_at,partial,source_failures})};}
        cursor=batch.cursor;
    }
    Err(CatalogError::InvalidResponse)
}

#[cfg(test)]
mod tests{
    use super::*;
    use ring::{rand::SystemRandom,signature::{Ed25519KeyPair,KeyPair}};
    #[test] fn tampered_or_untrusted_batches_are_rejected(){
        let key=Ed25519KeyPair::from_pkcs8(Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap().as_ref()).unwrap();
        let payload=serde_json::to_vec(&json!({"version":1,"fetchedAt":"2026-09-22T00:00:00Z","cursor":0,"nextCursor":null,"partial":true,"sourceFailures":["Grants.gov could not be checked"],"opportunities":[]})).unwrap();
        let envelope=SignedEnvelope{payload:URL_SAFE_NO_PAD.encode(&payload),signature:URL_SAFE_NO_PAD.encode(key.sign(&payload).as_ref()),algorithm:"Ed25519".into()};
        let verified=verify_batch(SignedEnvelope{payload:envelope.payload.clone(),signature:envelope.signature.clone(),algorithm:envelope.algorithm.clone()},key.public_key().as_ref(),0).unwrap();
        assert!(verified.partial);
        assert_eq!(verified.source_failures,["Grants.gov could not be checked"]);
        assert!(verify_batch(SignedEnvelope{payload:URL_SAFE_NO_PAD.encode(b"{}"),..envelope},key.public_key().as_ref(),0).is_err());
    }
}
