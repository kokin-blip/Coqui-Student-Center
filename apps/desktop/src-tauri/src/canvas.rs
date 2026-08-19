use chrono::{Duration as ChronoDuration, Utc};
use reqwest::{
    blocking::{Client, Response},
    header::{HeaderMap, LINK, RETRY_AFTER},
    redirect::Policy,
    StatusCode, Url,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Read,
    net::{IpAddr, SocketAddr, ToSocketAddrs},
    thread,
    time::Duration,
};
use zeroize::Zeroizing;

const MAX_PAGES: usize = 50;
const MAX_OBJECTS: usize = 10_000;
const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(thiserror::Error, Debug)]
pub enum CanvasError {
    #[error("Canvas URL is invalid: {0}")]
    InvalidUrl(String),
    #[error("Canvas host could not be validated: {0}")]
    Dns(String),
    #[error("Canvas request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("Canvas rejected the token or does not permit this request")]
    Unauthorized,
    #[error("Canvas returned HTTP {0}")]
    Status(u16),
    #[error("Canvas response was invalid: {0}")]
    InvalidResponse(String),
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasProfile {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug)]
pub struct CanvasCandidate {
    pub source_type: String,
    pub source_uid: String,
    pub source_url: String,
    pub kind: String,
    pub title: String,
    pub course: String,
    pub due_at: Option<String>,
    pub starts_at: Option<String>,
    pub ends_at: Option<String>,
    pub duration_minutes: Option<i64>,
    pub evidence: String,
    pub source_locator: String,
    pub confidence: f64,
    pub warnings: Vec<String>,
    pub snapshot: Value,
}

#[derive(Debug)]
pub struct CanvasPull {
    pub profile: CanvasProfile,
    pub candidates: Vec<CanvasCandidate>,
    pub next_cursor: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
enum CanvasId {
    Number(u64),
    Text(String),
}

impl CanvasId {
    fn text(&self) -> String {
        match self {
            Self::Number(value) => value.to_string(),
            Self::Text(value) => value.clone(),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
struct ProfilePayload {
    id: CanvasId,
    name: String,
}

#[derive(Clone, Debug, Deserialize)]
struct CoursePayload {
    id: CanvasId,
    name: String,
    course_code: Option<String>,
    workflow_state: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct AssignmentPayload {
    id: CanvasId,
    name: String,
    due_at: Option<String>,
    html_url: Option<String>,
    published: Option<bool>,
    workflow_state: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct CalendarPayload {
    id: CanvasId,
    title: String,
    start_at: Option<String>,
    end_at: Option<String>,
    context_code: Option<String>,
    html_url: Option<String>,
    workflow_state: Option<String>,
}

pub struct CanvasClient {
    origin: Url,
    client: Client,
    token: Zeroizing<String>,
}

impl CanvasClient {
    pub fn connect(base_url: &str, token: Zeroizing<String>) -> Result<Self, CanvasError> {
        validate_token(&token)?;
        let origin = normalize_base_url(base_url)?;
        let host = origin
            .host_str()
            .ok_or_else(|| CanvasError::InvalidUrl("host is required".into()))?;
        let addresses = resolve_public_addresses(host)?;
        let client = Client::builder()
            .redirect(Policy::none())
            .no_proxy()
            .timeout(REQUEST_TIMEOUT)
            .connect_timeout(Duration::from_secs(10))
            .user_agent(concat!(
                "StudentCenter/",
                env!("CARGO_PKG_VERSION"),
                " CanvasReadOnly"
            ))
            .resolve_to_addrs(host, &addresses)
            .build()?;
        Ok(Self {
            origin,
            client,
            token,
        })
    }

    pub fn base_url(&self) -> String {
        self.origin.as_str().trim_end_matches('/').to_string()
    }

    pub fn pull(&self) -> Result<CanvasPull, CanvasError> {
        let profile: ProfilePayload =
            self.fetch_one(self.endpoint("api/v1/users/self/profile")?)?;
        let courses: Vec<CoursePayload> = self.fetch_all(self.endpoint_with_query(
            "api/v1/courses",
            &[
                ("enrollment_state", "active"),
                ("enrollment_type", "student"),
                ("per_page", "100"),
            ],
        )?)?;
        let profile = CanvasProfile {
            id: profile.id.text(),
            name: profile.name,
        };
        let mut candidates = Vec::new();
        let mut course_names = HashMap::new();
        for course in courses.iter().filter(|course| {
            course.workflow_state.as_deref() != Some("deleted")
                && course.workflow_state.as_deref() != Some("unpublished")
        }) {
            let course_id = course.id.text();
            course_names.insert(format!("course_{course_id}"), course.name.clone());
            let course_url = self.endpoint(&format!("courses/{course_id}"))?.to_string();
            candidates.push(CanvasCandidate {
                source_type: "canvas_course".into(),
                source_uid: format!("canvas:course:{course_id}"),
                source_url: course_url,
                kind: "course".into(),
                title: course.name.clone(),
                course: course.course_code.clone().unwrap_or_default(),
                due_at: None,
                starts_at: None,
                ends_at: None,
                duration_minutes: None,
                evidence: format!("Canvas active course: {}", course.name),
                source_locator: "Canvas · active courses".into(),
                confidence: 1.0,
                warnings: vec![],
                snapshot: json!({
                    "id": course_id,
                    "name": course.name,
                    "courseCode": course.course_code,
                    "workflowState": course.workflow_state,
                }),
            });
            let assignment_url = self.endpoint_with_query(
                &format!("api/v1/courses/{course_id}/assignments"),
                &[("per_page", "100"), ("order_by", "due_at")],
            )?;
            let assignments: Vec<AssignmentPayload> = self.fetch_all(assignment_url)?;
            for assignment in assignments.into_iter().filter(|assignment| {
                assignment.published != Some(false)
                    && assignment.workflow_state.as_deref() != Some("deleted")
            }) {
                let assignment_id = assignment.id.text();
                let source_url = self.same_origin_or(
                    assignment.html_url.as_deref(),
                    &format!("courses/{course_id}/assignments/{assignment_id}"),
                )?;
                let mut warnings = Vec::new();
                if assignment.due_at.is_none() {
                    warnings
                        .push("Canvas did not provide a due date; confirm before planning".into());
                }
                candidates.push(CanvasCandidate {
                    source_type: "canvas_assignment".into(),
                    source_uid: format!("canvas:course:{course_id}:assignment:{assignment_id}"),
                    source_url,
                    kind: "task".into(),
                    title: assignment.name.clone(),
                    course: course.name.clone(),
                    due_at: assignment.due_at.clone(),
                    starts_at: None,
                    ends_at: None,
                    duration_minutes: Some(45),
                    evidence: match assignment.due_at.as_deref() {
                        Some(due) => format!("Canvas lists this assignment due at {due}"),
                        None => "Canvas lists this assignment without a due date".into(),
                    },
                    source_locator: format!("Canvas · {} · assignment", course.name),
                    confidence: if assignment.due_at.is_some() {
                        1.0
                    } else {
                        0.85
                    },
                    warnings,
                    snapshot: json!({
                        "id": assignment_id,
                        "courseId": course_id,
                        "name": assignment.name,
                        "dueAt": assignment.due_at,
                        "published": assignment.published,
                    }),
                });
            }
        }
        if !course_names.is_empty() {
            let start = (Utc::now() - ChronoDuration::days(30))
                .date_naive()
                .to_string();
            let end = (Utc::now() + ChronoDuration::days(365))
                .date_naive()
                .to_string();
            let mut event_url = self.endpoint("api/v1/calendar_events")?;
            {
                let mut query = event_url.query_pairs_mut();
                query
                    .append_pair("type", "event")
                    .append_pair("start_date", &start)
                    .append_pair("end_date", &end)
                    .append_pair("per_page", "100");
                for context in course_names.keys() {
                    query.append_pair("context_codes[]", context);
                }
            }
            let events: Vec<CalendarPayload> = self.fetch_all(event_url)?;
            for event in events.into_iter().filter(|event| {
                event.workflow_state.as_deref() != Some("deleted")
                    && event.start_at.is_some()
                    && event.end_at.is_some()
            }) {
                let event_id = event.id.text();
                let context = event.context_code.clone().unwrap_or_default();
                let course = course_names.get(&context).cloned().unwrap_or_default();
                let source_url = self.same_origin_or(
                    event.html_url.as_deref(),
                    &format!("calendar?event_id={event_id}"),
                )?;
                candidates.push(CanvasCandidate {
                    source_type: "canvas_calendar_event".into(),
                    source_uid: format!("canvas:calendar_event:{event_id}"),
                    source_url,
                    kind: "commitment".into(),
                    title: event.title.clone(),
                    course: course.clone(),
                    due_at: None,
                    starts_at: event.start_at.clone(),
                    ends_at: event.end_at.clone(),
                    duration_minutes: None,
                    evidence: format!(
                        "Canvas calendar schedules this from {} to {}",
                        event.start_at.as_deref().unwrap_or("unknown"),
                        event.end_at.as_deref().unwrap_or("unknown")
                    ),
                    source_locator: if course.is_empty() {
                        "Canvas · calendar event".into()
                    } else {
                        format!("Canvas · {course} · calendar event")
                    },
                    confidence: 1.0,
                    warnings: vec![],
                    snapshot: json!({
                        "id": event_id,
                        "title": event.title,
                        "startAt": event.start_at,
                        "endAt": event.end_at,
                        "contextCode": event.context_code,
                    }),
                });
            }
        }
        let next_cursor = Utc::now().to_rfc3339();
        Ok(CanvasPull {
            profile,
            candidates,
            next_cursor,
        })
    }

    fn endpoint(&self, path: &str) -> Result<Url, CanvasError> {
        self.origin
            .join(path)
            .map_err(|error| CanvasError::InvalidUrl(error.to_string()))
    }

    fn endpoint_with_query(&self, path: &str, query: &[(&str, &str)]) -> Result<Url, CanvasError> {
        let mut url = self.endpoint(path)?;
        url.query_pairs_mut().extend_pairs(query.iter().copied());
        Ok(url)
    }

    fn same_origin_or(
        &self,
        candidate: Option<&str>,
        fallback: &str,
    ) -> Result<String, CanvasError> {
        if let Some(candidate) = candidate {
            if let Ok(url) = Url::parse(candidate) {
                if self.same_origin(&url) {
                    return Ok(url.to_string());
                }
            }
        }
        Ok(self.endpoint(fallback)?.to_string())
    }

    fn same_origin(&self, url: &Url) -> bool {
        url.scheme() == "https"
            && url.host_str() == self.origin.host_str()
            && url.port().is_none()
            && url.username().is_empty()
            && url.password().is_none()
    }

    fn fetch_one<T: DeserializeOwned>(&self, url: Url) -> Result<T, CanvasError> {
        let (_, body) = self.fetch(url)?;
        serde_json::from_slice(&body)
            .map_err(|error| CanvasError::InvalidResponse(error.to_string()))
    }

    fn fetch_all<T: DeserializeOwned>(&self, first: Url) -> Result<Vec<T>, CanvasError> {
        let mut output = Vec::new();
        let mut next = Some(first);
        for _ in 0..MAX_PAGES {
            let Some(url) = next.take() else {
                return Ok(output);
            };
            if !self.same_origin(&url) {
                return Err(CanvasError::InvalidResponse(
                    "pagination attempted to leave the validated Canvas origin".into(),
                ));
            }
            let (headers, body) = self.fetch(url)?;
            let mut page: Vec<T> = serde_json::from_slice(&body)
                .map_err(|error| CanvasError::InvalidResponse(error.to_string()))?;
            if output.len() + page.len() > MAX_OBJECTS {
                return Err(CanvasError::InvalidResponse(
                    "pagination exceeded the object safety limit".into(),
                ));
            }
            output.append(&mut page);
            next = next_link(&headers)?;
        }
        if next.is_some() {
            return Err(CanvasError::InvalidResponse(
                "pagination exceeded the page safety limit".into(),
            ));
        }
        Ok(output)
    }

    fn fetch(&self, url: Url) -> Result<(HeaderMap, Vec<u8>), CanvasError> {
        for attempt in 0..=2 {
            let response = self
                .client
                .get(url.clone())
                .bearer_auth(self.token.as_str())
                .send()?;
            if response.status() == StatusCode::UNAUTHORIZED
                || response.status() == StatusCode::FORBIDDEN
            {
                return Err(CanvasError::Unauthorized);
            }
            if (response.status() == StatusCode::TOO_MANY_REQUESTS
                || response.status() == StatusCode::SERVICE_UNAVAILABLE)
                && attempt < 2
            {
                let delay = retry_delay(&response);
                drop(response);
                thread::sleep(delay);
                continue;
            }
            if !response.status().is_success() {
                return Err(CanvasError::Status(response.status().as_u16()));
            }
            return bounded_body(response);
        }
        Err(CanvasError::InvalidResponse("retry limit reached".into()))
    }
}

pub fn normalize_base_url(input: &str) -> Result<Url, CanvasError> {
    let parsed =
        Url::parse(input.trim()).map_err(|error| CanvasError::InvalidUrl(error.to_string()))?;
    if parsed.scheme() != "https" {
        return Err(CanvasError::InvalidUrl("HTTPS is required".into()));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(CanvasError::InvalidUrl(
            "embedded credentials are not allowed".into(),
        ));
    }
    if parsed.port().is_some() {
        return Err(CanvasError::InvalidUrl(
            "custom ports are not allowed".into(),
        ));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(CanvasError::InvalidUrl(
            "query strings and fragments are not allowed".into(),
        ));
    }
    if parsed.path() != "/" && !parsed.path().is_empty() {
        return Err(CanvasError::InvalidUrl(
            "enter the Canvas origin without an extra path".into(),
        ));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| CanvasError::InvalidUrl("host is required".into()))?;
    if host.trim_matches(['[', ']']).parse::<IpAddr>().is_ok()
        || host.eq_ignore_ascii_case("localhost")
    {
        return Err(CanvasError::InvalidUrl(
            "Canvas must use a public DNS host".into(),
        ));
    }
    let mut origin = Url::parse(&format!("https://{host}/"))
        .map_err(|error| CanvasError::InvalidUrl(error.to_string()))?;
    origin.set_fragment(None);
    Ok(origin)
}

fn validate_token(token: &str) -> Result<(), CanvasError> {
    if token.len() < 16 || token.len() > 4096 || token.trim() != token {
        return Err(CanvasError::InvalidUrl(
            "token must be 16–4096 characters without surrounding whitespace".into(),
        ));
    }
    if token.chars().any(char::is_control) {
        return Err(CanvasError::InvalidUrl(
            "token contains invalid control characters".into(),
        ));
    }
    Ok(())
}

/// Shared with `school_calendar`, which fetches a different kind of public page
/// under the same rules. One implementation, so the two cannot drift apart.
pub(crate) fn resolve_public_addresses(host: &str) -> Result<Vec<SocketAddr>, CanvasError> {
    let mut addresses = (host, 443)
        .to_socket_addrs()
        .map_err(|error| CanvasError::Dns(error.to_string()))?
        .collect::<Vec<_>>();
    addresses.sort_unstable();
    addresses.dedup();
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(CanvasError::Dns(
            "host resolves to a local, private, reserved, or unspecified address".into(),
        ));
    }
    Ok(addresses)
}

pub(crate) fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, _, _] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_unspecified()
                || ip.is_multicast()
                || a == 0
                || a >= 224
                || (a == 100 && (64..=127).contains(&b)))
        }
        IpAddr::V6(ip) => {
            let segments = ip.segments();
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] == 0x2001 && segments[1] == 0x0db8))
        }
    }
}

fn retry_delay(response: &Response) -> Duration {
    response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .map(|seconds| Duration::from_secs(seconds.min(5)))
        .unwrap_or(Duration::from_millis(500))
}

fn bounded_body(response: Response) -> Result<(HeaderMap, Vec<u8>), CanvasError> {
    if response.content_length().unwrap_or(0) > MAX_RESPONSE_BYTES {
        return Err(CanvasError::InvalidResponse(
            "response exceeded the size safety limit".into(),
        ));
    }
    let headers = response.headers().clone();
    let mut body = Vec::new();
    response
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|error| CanvasError::InvalidResponse(error.to_string()))?;
    if body.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(CanvasError::InvalidResponse(
            "response exceeded the size safety limit".into(),
        ));
    }
    Ok((headers, body))
}

fn next_link(headers: &HeaderMap) -> Result<Option<Url>, CanvasError> {
    let Some(header) = headers.get(LINK) else {
        return Ok(None);
    };
    let value = header
        .to_str()
        .map_err(|_| CanvasError::InvalidResponse("pagination header is not text".into()))?;
    for part in value.split(',') {
        let mut pieces = part.trim().split(';');
        let target = pieces.next().unwrap_or_default().trim();
        let is_next = pieces.any(|piece| piece.trim().eq_ignore_ascii_case("rel=\"next\""));
        if is_next {
            let raw = target
                .strip_prefix('<')
                .and_then(|value| value.strip_suffix('>'))
                .ok_or_else(|| {
                    CanvasError::InvalidResponse("pagination link is malformed".into())
                })?;
            return Url::parse(raw)
                .map(Some)
                .map_err(|error| CanvasError::InvalidResponse(error.to_string()));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;

    #[test]
    fn canvas_origin_rejects_ssrf_inputs() {
        for invalid in [
            "http://canvas.example.edu",
            "https://127.0.0.1",
            "https://[::1]",
            "https://user:pass@canvas.example.edu",
            "https://canvas.example.edu:8443",
            "https://canvas.example.edu/api/v1",
            "https://canvas.example.edu?next=https://localhost",
        ] {
            assert!(normalize_base_url(invalid).is_err(), "accepted {invalid}");
        }
        assert_eq!(
            normalize_base_url("https://canvas.example.edu/")
                .unwrap()
                .as_str(),
            "https://canvas.example.edu/"
        );
    }

    #[test]
    fn private_and_reserved_addresses_are_rejected() {
        for ip in [
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "192.168.1.1",
            "224.0.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
        ] {
            assert!(!is_public_ip(ip.parse().unwrap()), "accepted {ip}");
        }
        assert!(is_public_ip("1.1.1.1".parse().unwrap()));
        assert!(is_public_ip("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn pagination_next_link_is_parsed_as_an_opaque_url() {
        let mut headers = HeaderMap::new();
        headers.insert(
            LINK,
            HeaderValue::from_static(
                "<https://canvas.example.edu/api/v1/courses?page=1>; rel=\"current\", <https://canvas.example.edu/api/v1/courses?opaque=two>; rel=\"next\"",
            ),
        );
        assert_eq!(
            next_link(&headers).unwrap().unwrap().as_str(),
            "https://canvas.example.edu/api/v1/courses?opaque=two"
        );
    }
}
