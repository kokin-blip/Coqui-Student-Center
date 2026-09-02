//! Narrow, public scholarship source adapters.
//!
//! This is intentionally not a web crawler. Each adapter owns one exact HTTPS
//! origin and path, checks the site's current robots policy before every fetch,
//! refuses redirects and proxies, pins public DNS answers, and caps responses.

use crate::{canvas::resolve_public_addresses, school_calendar::{collapse, strip_tags}};
use chrono::Utc;
use regex::Regex;
use reqwest::{blocking::Client, redirect::Policy, Url};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{io::Read, time::Duration};

const MAX_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_OPPORTUNITIES: usize = 500;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind { Onsa, GlobalEducation }

#[derive(Debug, Clone, Copy)]
pub struct SourceDescriptor {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: SourceKind,
    pub origin: &'static str,
    pub path: &'static str,
    pub attribution: &'static str,
    pub parser_version: &'static str,
}

pub const SOURCES: [SourceDescriptor; 2] = [
    SourceDescriptor { id:"asu-onsa", name:"ASU ONSA scholarships", kind:SourceKind::Onsa, origin:"https://onsa.asu.edu", path:"/scholarships", attribution:"Arizona State University Office of National Scholarships Advisement", parser_version:"onsa-table-1" },
    SourceDescriptor { id:"asu-global-education", name:"ASU Global Education scholarships", kind:SourceKind::GlobalEducation, origin:"https://goglobal.asu.edu", path:"/scholarship-search", attribution:"Arizona State University Global Education Office", parser_version:"global-table-1" },
];

#[derive(Debug, thiserror::Error)]
pub enum ScholarshipError {
    #[error("unknown scholarship source")]
    UnknownSource,
    #[error("the scholarship source host could not be validated")]
    Dns,
    #[error("the scholarship source could not be reached")]
    Network,
    #[error("the scholarship source request timed out")]
    Timeout,
    #[error("the scholarship source refused access")]
    Robots,
    #[error("the scholarship source returned status {0}")]
    Status(u16),
    #[error("the scholarship source response was invalid")]
    InvalidResponse,
    #[error("the scholarship source contained no usable opportunities")]
    Empty,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct DiscoveredOpportunity {
    pub id:String,
    pub source_id:String,
    pub canonical_url:String,
    pub provider:String,
    pub title:String,
    pub award_minimum:Option<f64>,
    pub award_maximum:Option<f64>,
    pub currency:String,
    pub deadline_label:String,
    pub application_url:String,
    pub summary:String,
    pub fetched_at:String,
    pub freshness:String,
    pub verification_status:String,
    pub ai_policy:String,
    pub notes:String,
    pub priority:String,
    pub state:String,
    pub task_ids:Vec<String>,
    pub essay_prompts:Vec<serde_json::Value>,
    pub required_documents:Vec<String>,
}

#[derive(Debug, Clone)]
pub struct SourceRefresh {
    pub source:SourceDescriptor,
    pub opportunities:Vec<DiscoveredOpportunity>,
    pub fetched_at:String,
}

pub fn descriptor(source_id:&str)->Result<SourceDescriptor,ScholarshipError>{
    SOURCES.iter().copied().find(|source|source.id==source_id).ok_or(ScholarshipError::UnknownSource)
}

pub fn refresh(source_id:&str)->Result<SourceRefresh,ScholarshipError>{
    let source=descriptor(source_id)?;
    let robots=fetch_exact(source.origin,"/robots.txt","text/plain")?;
    if !robots_allows(&robots,source.path){return Err(ScholarshipError::Robots);}
    let html=fetch_exact(source.origin,source.path,"text/html")?;
    let fetched_at=Utc::now().to_rfc3339();
    let opportunities=parse(&html,source,&fetched_at);
    if opportunities.is_empty(){return Err(ScholarshipError::Empty);}
    Ok(SourceRefresh{source,opportunities,fetched_at})
}

fn fetch_exact(origin:&str,path:&str,expected_type:&str)->Result<String,ScholarshipError>{
    let base=Url::parse(origin).map_err(|_|ScholarshipError::InvalidResponse)?;
    let url=base.join(path).map_err(|_|ScholarshipError::InvalidResponse)?;
    if url.origin()!=base.origin()||url.path()!=path||url.query().is_some(){return Err(ScholarshipError::InvalidResponse);}
    let host=url.host_str().ok_or(ScholarshipError::InvalidResponse)?;
    let addresses=resolve_public_addresses(host).map_err(|_|ScholarshipError::Dns)?;
    let client=Client::builder().redirect(Policy::none()).no_proxy().connect_timeout(Duration::from_secs(10)).timeout(REQUEST_TIMEOUT)
        .resolve_to_addrs(host,&addresses).user_agent(concat!("CoquiStudentCenter/",env!("CARGO_PKG_VERSION")," ScholarshipReadOnly"))
        .build().map_err(|_|ScholarshipError::Network)?;
    let response=client.get(url).header(reqwest::header::ACCEPT,format!("{expected_type};q=1.0")).send().map_err(|error|if error.is_timeout(){ScholarshipError::Timeout}else{ScholarshipError::Network})?;
    if response.status().is_redirection(){return Err(ScholarshipError::InvalidResponse);}
    if !response.status().is_success(){return Err(ScholarshipError::Status(response.status().as_u16()));}
    let content_type=response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|value|value.to_str().ok()).unwrap_or_default().to_ascii_lowercase();
    if !content_type.starts_with(expected_type){return Err(ScholarshipError::InvalidResponse);}
    if response.content_length().is_some_and(|size|size>MAX_RESPONSE_BYTES){return Err(ScholarshipError::InvalidResponse);}
    let mut bytes=Vec::new(); response.take(MAX_RESPONSE_BYTES+1).read_to_end(&mut bytes).map_err(|_|ScholarshipError::Network)?;
    if bytes.len() as u64>MAX_RESPONSE_BYTES{return Err(ScholarshipError::InvalidResponse);}
    String::from_utf8(bytes).map_err(|_|ScholarshipError::InvalidResponse)
}

fn robots_allows(body:&str,path:&str)->bool{
    let mut applies=false;
    for raw in body.lines(){
        let line=raw.split('#').next().unwrap_or_default().trim();
        let Some((name,value))=line.split_once(':') else {continue};
        match name.trim().to_ascii_lowercase().as_str(){
            "user-agent"=>applies=value.trim()=="*",
            "disallow" if applies=>{let rule=value.trim();if !rule.is_empty()&&path.starts_with(rule.trim_end_matches('$')){return false;}},
            _=>{}
        }
    }
    true
}

pub fn parse(html:&str,source:SourceDescriptor,fetched_at:&str)->Vec<DiscoveredOpportunity>{
    let rows=Regex::new(r"(?is)<tr\b[^>]*>(.*?)</tr>").unwrap();
    let mut values=rows.captures_iter(html).filter_map(|capture|parse_row(capture.get(1)?.as_str(),source,fetched_at)).collect::<Vec<_>>();
    values.sort_by(|left,right|left.title.to_ascii_lowercase().cmp(&right.title.to_ascii_lowercase()));
    values.dedup_by(|left,right|left.canonical_url==right.canonical_url);
    values.truncate(MAX_OPPORTUNITIES);
    values
}

fn parse_row(row:&str,source:SourceDescriptor,fetched_at:&str)->Option<DiscoveredOpportunity>{
    let path_pattern=match source.kind{SourceKind::Onsa=>r#"(?is)<a\b[^>]*href=["'](?P<href>/scholarship/[^"'#?]+)["'][^>]*>(?P<title>.*?)</a>"#,SourceKind::GlobalEducation=>r#"(?is)<a\b[^>]*href=["'](?P<href>/scholarship_criteria/[^"'#?]+)["'][^>]*>(?P<title>.*?)</a>"#};
    let link=Regex::new(path_pattern).ok()?.captures(row)?;
    let href=link.name("href")?.as_str();
    let title=collapse(&strip_tags(link.name("title")?.as_str()));
    if title.len()<3||title.len()>240{return None;}
    let canonical_url=format!("{}{}",source.origin,href);
    let deadline_label=if source.kind==SourceKind::Onsa{cell(row,"views-field-field-deadline")}else{String::new()};
    let award_text=if source.kind==SourceKind::GlobalEducation{cell(row,"views-field-field-award-amount")}else{String::new()};
    let summary=if source.kind==SourceKind::Onsa{cell(row,"views-field-body")}else{String::new()};
    let application_url=if source.kind==SourceKind::GlobalEducation{external_link(row,"views-field-field-learn-apply").unwrap_or_else(||canonical_url.clone())}else{canonical_url.clone()};
    let amounts=dollar_amounts(&award_text);
    let digest=hex::encode(Sha256::digest(canonical_url.as_bytes()));
    Some(DiscoveredOpportunity{id:format!("{}:{}",source.id,&digest[..24]),source_id:source.id.into(),canonical_url,provider:source.attribution.into(),title,
        award_minimum:amounts.iter().copied().reduce(f64::min),award_maximum:amounts.iter().copied().reduce(f64::max),currency:"USD".into(),deadline_label,
        application_url,summary:summary.chars().take(1200).collect(),fetched_at:fetched_at.into(),freshness:"fresh".into(),verification_status:"unverified".into(),ai_policy:"unknown".into(),notes:String::new(),priority:"medium".into(),state:"discovered".into(),task_ids:Vec::new(),essay_prompts:Vec::new(),required_documents:Vec::new()})
}

fn cell(row:&str,class_name:&str)->String{
    let pattern=format!(r#"(?is)<td\b[^>]*class=["'][^"']*\b{}\b[^"']*["'][^>]*>(.*?)</td>"#,regex::escape(class_name));
    Regex::new(&pattern).ok().and_then(|pattern|pattern.captures(row)).and_then(|capture|capture.get(1)).map(|value|collapse(&strip_tags(value.as_str()))).unwrap_or_default()
}

fn external_link(row:&str,class_name:&str)->Option<String>{
    let pattern=format!(r#"(?is)<td\b[^>]*class=["'][^"']*\b{}\b[^"']*["'][^>]*>.*?<a\b[^>]*href=["'](https://[^"']+)["']"#,regex::escape(class_name));
    let raw=Regex::new(&pattern).ok()?.captures(row)?.get(1)?.as_str().replace("&amp;","&");
    let url=Url::parse(&raw).ok()?; if url.scheme()=="https"&&url.username().is_empty()&&url.password().is_none(){Some(url.to_string())}else{None}
}

fn dollar_amounts(value:&str)->Vec<f64>{
    Regex::new(r"\$\s*([0-9][0-9,]*)").unwrap().captures_iter(value).filter_map(|capture|capture.get(1)?.as_str().replace(',',"").parse().ok()).collect()
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test] fn robots_rules_are_enforced_for_the_exact_path(){assert!(robots_allows("User-agent: *\nDisallow: /admin/\n","/scholarships"));assert!(!robots_allows("User-agent: *\nDisallow: /scholarship-search\n","/scholarship-search"));}
    #[test] fn onsa_rows_keep_attribution_and_unresolved_deadline_precision(){let html=r#"<table><tr><td class='views-field views-field-title'><a href='/scholarship/alpha'>Alpha Fellowship</a></td><td class='views-field views-field-field-deadline'>November 30</td><td class='views-field views-field-body'><p>Supports public service.</p></td></tr></table>"#;let rows=parse(html,SOURCES[0],"2026-08-30T00:00:00Z");assert_eq!(rows.len(),1);assert_eq!(rows[0].deadline_label,"November 30");assert!(rows[0].canonical_url.ends_with("/scholarship/alpha"));assert_eq!(rows[0].state,"discovered");}
    #[test] fn global_rows_extract_bounded_https_application_and_award_range(){let html=r#"<tr><td class='views-field views-field-title'><a href='/scholarship_criteria/42'>Global Grant</a></td><td class='views-field views-field-field-award-amount'>$500 - $2,000</td><td class='views-field views-field-field-learn-apply'><a href='https://example.org/apply'>Apply</a></td></tr>"#;let rows=parse(html,SOURCES[1],"2026-08-30T00:00:00Z");assert_eq!(rows[0].award_minimum,Some(500.0));assert_eq!(rows[0].award_maximum,Some(2000.0));assert_eq!(rows[0].application_url,"https://example.org/apply");}
    #[test] #[ignore="live public-source certification"] fn live_asu_sources_obey_robots_and_yield_bounded_results(){for source in SOURCES{let result=refresh(source.id).unwrap();assert!(!result.opportunities.is_empty());assert!(result.opportunities.len()<=MAX_OPPORTUNITIES);assert!(result.opportunities.iter().all(|item|item.canonical_url.starts_with(source.origin)));}}
}
