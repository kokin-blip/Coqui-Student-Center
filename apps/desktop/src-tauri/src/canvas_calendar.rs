use crate::{canvas::{resolve_public_addresses, CanvasError}, imports};
use chrono_tz::Tz;
use reqwest::{blocking::Client, redirect::Policy, StatusCode, Url};
use sha2::{Digest, Sha256};
use std::{io::Read, time::Duration};

const MAX_FEED_BYTES: u64 = 8 * 1024 * 1024;
const MAX_REDIRECTS: usize = 3;

#[derive(Debug)]
pub struct FeedPull {
    pub origin: String,
    pub hash: String,
    pub candidates: Vec<imports::ExtractedCandidate>,
}

pub fn fetch(raw_url: &str, fallback_tz: Tz) -> Result<FeedPull, CanvasError> {
    let mut url = validate_url(raw_url)?;
    for redirects in 0..=MAX_REDIRECTS {
        let host = url.host_str().ok_or_else(|| CanvasError::InvalidUrl("host is required".into()))?;
        let addresses = resolve_public_addresses(host)?;
        let client = Client::builder().redirect(Policy::none()).no_proxy().connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(25)).resolve_to_addrs(host, &addresses)
            .user_agent(concat!("CoquiStudentCenter/", env!("CARGO_PKG_VERSION"), " CanvasCalendarReadOnly"))
            .build().map_err(|_| CanvasError::InvalidResponse("calendar feed client could not start".into()))?;
        // A reqwest error may render its request URL. The calendar URL is a
        // bearer secret, so no network failure carrying it may cross IPC.
        let response = client.get(url.clone()).header(reqwest::header::ACCEPT, "text/calendar, application/ics;q=0.9").send().map_err(|error| {
            CanvasError::InvalidResponse(if error.is_timeout() {
                "calendar feed request timed out"
            } else {
                "calendar feed request failed"
            }.into())
        })?;
        if response.status().is_redirection() {
            let location = response.headers().get(reqwest::header::LOCATION).and_then(|value| value.to_str().ok())
                .ok_or_else(|| CanvasError::InvalidResponse("calendar feed redirect was invalid".into()))?;
            url = redirect_target(&url,location,redirects)?;
            continue;
        }
        if response.status() == StatusCode::UNAUTHORIZED || response.status() == StatusCode::FORBIDDEN { return Err(CanvasError::Unauthorized); }
        if !response.status().is_success() { return Err(CanvasError::Status(response.status().as_u16())); }
        let advertised_size=response.content_length();
        let media_type = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|value| value.to_str().ok()).map(str::to_owned);
        let mut bytes=Vec::new(); response.take(MAX_FEED_BYTES+1).read_to_end(&mut bytes).map_err(|_| CanvasError::InvalidResponse("calendar feed could not be read".into()))?;
        validate_feed_bytes(media_type.as_deref(),advertised_size,&bytes)?;
        let hash=hex::encode(Sha256::digest(&bytes));
        let mut candidates=imports::extract_calendar_bytes(&bytes, fallback_tz).map_err(|_| CanvasError::InvalidResponse("calendar feed was malformed".into()))?;
        normalize_candidates(&mut candidates);
        let origin=format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default());
        return Ok(FeedPull{origin,hash,candidates});
    }
    unreachable!()
}

fn redirect_target(current:&Url,location:&str,redirects:usize)->Result<Url,CanvasError>{
    if redirects>=MAX_REDIRECTS{return Err(CanvasError::InvalidResponse("calendar feed redirected too many times".into()));}
    let joined=current.join(location).map_err(|_|CanvasError::InvalidUrl("redirect was invalid".into()))?;
    validate_url(joined.as_str())
}

fn validate_feed_bytes(content_type:Option<&str>,advertised_size:Option<u64>,bytes:&[u8])->Result<(),CanvasError>{
    if advertised_size.is_some_and(|size|size>MAX_FEED_BYTES)||bytes.len() as u64>MAX_FEED_BYTES{return Err(CanvasError::InvalidResponse("calendar feed exceeded the size limit".into()));}
    if !identifies_as_icalendar(content_type,bytes){return Err(CanvasError::InvalidResponse("link did not return an iCalendar feed".into()));}
    Ok(())
}

fn identifies_as_icalendar(content_type: Option<&str>, bytes: &[u8]) -> bool {
    let media_type = content_type
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .unwrap_or_default();
    (media_type.eq_ignore_ascii_case("text/calendar") || media_type.eq_ignore_ascii_case("application/ics"))
        && String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).contains("BEGIN:VCALENDAR")
}

pub fn validate_url(raw: &str) -> Result<Url, CanvasError> {
    if raw.len()>16_384 || raw.trim()!=raw { return Err(CanvasError::InvalidUrl("paste the exact HTTPS calendar link".into())); }
    let url=Url::parse(raw).map_err(|_| CanvasError::InvalidUrl("paste a complete HTTPS calendar link".into()))?;
    if url.scheme()!="https" || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some()
        || url.port_or_known_default()!=Some(443) || url.fragment().is_some() {
        return Err(CanvasError::InvalidUrl("calendar links must use public HTTPS on port 443".into()));
    }
    Ok(url)
}

fn normalize_candidates(candidates: &mut [imports::ExtractedCandidate]) {
    for candidate in candidates {
        candidate.source_uid = candidate.source_uid.replacen("ics:", "canvas-calendar:", 1);
        candidate.source_locator = format!("Canvas calendar · {}", candidate.source_locator);
        let title=candidate.title.to_ascii_lowercase();
        let task_like=["assignment","exam","quiz","homework","project due","paper due","due:"].iter().any(|word| title.contains(word));
        if candidate.kind=="commitment" && task_like {
            candidate.kind="task".into(); candidate.due_at=candidate.starts_at.take(); candidate.ends_at=None;
            candidate.duration_minutes=Some(45); candidate.course="Canvas".into();
            candidate.warnings.push("Classified from the explicit Canvas event title; confirm the due date before approval".into());
            candidate.confidence=0.82;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn feed_urls_fail_closed() { for value in ["http://canvas.example.edu/feed.ics","https://user@canvas.example.edu/feed.ics","https://canvas.example.edu:8443/feed.ics"," https://canvas.example.edu/feed.ics"] { assert!(validate_url(value).is_err(),"accepted {value}"); } assert!(validate_url("https://canvas.example.edu/feeds/calendars/user_deadbeef.ics").is_ok()); }
    #[test] fn feeds_require_both_calendar_media_type_and_calendar_body() {
        let body = b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR";
        assert!(identifies_as_icalendar(Some("text/calendar; charset=utf-8"), body));
        assert!(!identifies_as_icalendar(Some("text/plain"), body));
        assert!(!identifies_as_icalendar(Some("text/calendar"), b"<html>login</html>"));
        assert!(!identifies_as_icalendar(None, body));
        assert!(identifies_as_icalendar(Some("TEXT/CALENDAR"),body));
    }
    #[test] fn redirect_targets_are_revalidated_and_bounded() {
        let current=validate_url("https://canvas.example.edu/feed.ics").unwrap();
        assert_eq!(redirect_target(&current,"/next.ics",0).unwrap().as_str(),"https://canvas.example.edu/next.ics");
        for unsafe_target in ["http://canvas.example.edu/feed.ics","https://user@canvas.example.edu/feed.ics","https://canvas.example.edu:8443/feed.ics"] {assert!(redirect_target(&current,unsafe_target,0).is_err(),"accepted {unsafe_target}");}
        assert!(redirect_target(&current,"/fourth.ics",MAX_REDIRECTS).is_err());
    }
    #[test] fn feed_download_validation_enforces_advertised_and_actual_limits() {
        let body=b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR";
        assert!(validate_feed_bytes(Some("text/calendar"),Some(body.len() as u64),body).is_ok());
        assert!(validate_feed_bytes(Some("text/calendar"),Some(MAX_FEED_BYTES+1),body).is_err());
        assert!(validate_feed_bytes(Some("text/calendar"),None,&vec![b'x';MAX_FEED_BYTES as usize+1]).is_err());
        assert!(validate_feed_bytes(Some("text/html"),None,b"<html>sign in</html>").is_err());
    }
    #[test] fn canvas_ids_are_namespaced_and_explicit_due_titles_become_tasks() {
        let mut values=vec![imports::ExtractedCandidate{kind:"commitment".into(),title:"Midterm Exam".into(),starts_at:Some("2026-09-01T12:00:00Z".into()),ends_at:Some("2026-09-01T13:00:00Z".into()),source_uid:"ics:abc:1".into(),source_locator:"event abc".into(),..Default::default()}];
        normalize_candidates(&mut values); assert_eq!(values[0].kind,"task"); assert!(values[0].source_uid.starts_with("canvas-calendar:")); assert!(values[0].due_at.is_some());
    }
}
