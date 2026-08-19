use reqwest::{
    blocking::{Client, Response},
    redirect::Policy,
    StatusCode,
};
use serde::{Deserialize, Serialize};
use std::{io::Read, time::Duration};
use url::Url;

const MAX_RESPONSE_BYTES: u64 = 512 * 1024;
const MAX_EXCERPT_CHARS: usize = 12_000;
/// A schedule screenshot is a few hundred kilobytes; a phone capture at 3x is a
/// couple of megabytes. Eight leaves room without letting an arbitrary file be
/// posted through this endpoint.
const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;

#[derive(thiserror::Error, Debug)]
pub enum ManagedAiError {
    #[error("managed AI is not configured in this build")]
    NotConfigured,
    #[error("managed AI configuration is invalid")]
    InvalidConfiguration,
    #[error("managed AI input is invalid: {0}")]
    InvalidInput(String),
    #[error("managed AI is unavailable; local data was not changed")]
    Network,
    #[error("managed AI quota is temporarily unavailable; local data was not changed")]
    Quota,
    #[error("managed AI timed out; local data was not changed")]
    Timeout,
    #[error("managed AI rejected the request ({0}); local data was not changed")]
    Rejected(u16),
    #[error("managed AI returned an invalid review response; local data was not changed")]
    InvalidResponse,
}

pub type Result<T> = std::result::Result<T, ManagedAiError>;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AiCapability {
    BrainDump,
    DocumentExtraction,
    TaskDecomposition,
    Explanation,
}

/// An image sent alongside the excerpt.
///
/// The image never travels alone. `excerpt` still carries text this machine
/// extracted locally, and `evidence` is still checked to be a substring of it,
/// so the model's job is to structure text we already have rather than to read
/// pixels unsupervised. That is what lets a screenshot flow exist without
/// weakening the grounding check — see `validate_response`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiImage {
    mime_type: &'static str,
    /// Standard base64. Built here rather than accepted from a caller, so the
    /// declared type and the bytes can never disagree.
    data: String,
}

impl AiImage {
    /// Sniff the bytes and encode them, or refuse.
    ///
    /// The magic bytes decide; a caller's claim about the type is not consulted,
    /// the same posture `detect_document` takes in `imports.rs`. Only PNG and
    /// JPEG are accepted — every screenshot path produces one of the two, and a
    /// narrower set is a smaller thing to be wrong about.
    pub fn encode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err(ManagedAiError::InvalidInput(
                "the image must be 8 MB or smaller".into(),
            ));
        }
        let mime_type = sniff_image(bytes).ok_or_else(|| {
            ManagedAiError::InvalidInput("the attachment must be a PNG or JPEG image".into())
        })?;
        Ok(Self {
            mime_type,
            data: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes),
        })
    }
}

/// PNG and JPEG signatures. Deliberately narrower than `infer`, which also
/// recognises TIFF and everything else it knows: this endpoint accepts two
/// formats, so it should recognise exactly two.
fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else {
        None
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiRequest<'a> {
    capability: AiCapability,
    excerpt: &'a str,
    locale: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    image: Option<&'a AiImage>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiCandidate {
    pub kind: String,
    pub title: String,
    pub course: Option<String>,
    pub duration_minutes: Option<i64>,
    pub due_at: Option<String>,
    pub starts_at: Option<String>,
    pub ends_at: Option<String>,
    pub evidence: String,
    pub confidence: f64,
    pub warnings: Vec<String>,
    /// The fields below describe a weekly class rather than a dated one-off, and
    /// are only legal on a `class_meeting`. They default so that a cloud-api
    /// deployed before this change still parses: the two ship separately, so
    /// each has to tolerate the other being older.
    ///
    /// 0 = Sunday, matching `DAY_INDEX` in `scripts/catalog/asu-class-search.mjs`
    /// and `weekly_pattern` in `imports.rs`.
    #[serde(default)]
    pub weekdays: Vec<u8>,
    /// Local wall clock, `HH:MM`. A class recurs, so it has no single instant.
    #[serde(default)]
    pub starts_at_local: Option<String>,
    #[serde(default)]
    pub ends_at_local: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub component: Option<String>,
    #[serde(default)]
    pub modality: Option<String>,
    #[serde(default)]
    pub section_number: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiResponse {
    pub candidates: Vec<AiCandidate>,
    pub explanation: Option<String>,
    pub review_required: bool,
    pub account_id: String,
    pub model: String,
    pub usage: AiUsage,
}

#[derive(Clone)]
pub struct ManagedAiClient {
    origin: Url,
    client: Client,
}

impl ManagedAiClient {
    pub fn compiled() -> Result<Self> {
        let origin =
            option_env!("STUDENT_CENTER_CLOUD_API_URL").ok_or(ManagedAiError::NotConfigured)?;
        Self::new(origin)
    }

    fn new(origin: &str) -> Result<Self> {
        let origin = Url::parse(origin).map_err(|_| ManagedAiError::InvalidConfiguration)?;
        if origin.scheme() != "https"
            || !origin.username().is_empty()
            || origin.password().is_some()
            || origin.host_str().is_none()
            || origin.port_or_known_default() != Some(443)
            || origin.path() != "/"
            || origin.query().is_some()
            || origin.fragment().is_some()
        {
            return Err(ManagedAiError::InvalidConfiguration);
        }
        let client = Client::builder()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(25))
            .user_agent(concat!("StudentCenter/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| ManagedAiError::Network)?;
        Ok(Self { origin, client })
    }

    pub fn request(
        &self,
        access_token: &str,
        capability: AiCapability,
        excerpt: &str,
        locale: &str,
        image: Option<&AiImage>,
    ) -> Result<AiResponse> {
        validate_input(access_token, excerpt, locale, image)?;
        let endpoint = self
            .origin
            .join("v1/ai/structure")
            .map_err(|_| ManagedAiError::InvalidConfiguration)?;
        if endpoint.origin() != self.origin.origin() {
            return Err(ManagedAiError::InvalidConfiguration);
        }
        let response = self
            .client
            .post(endpoint)
            .bearer_auth(access_token)
            .json(&AiRequest {
                capability,
                excerpt,
                locale,
                image,
            })
            .send()
            .map_err(|error| {
                if error.is_timeout() {
                    ManagedAiError::Timeout
                } else {
                    ManagedAiError::Network
                }
            })?;
        read_response(response, capability, excerpt)
    }
}

fn validate_input(
    access_token: &str,
    excerpt: &str,
    locale: &str,
    image: Option<&AiImage>,
) -> Result<()> {
    let excerpt_chars = excerpt.chars().count();
    if access_token.len() < 32 || access_token.len() > 16_384 {
        return Err(ManagedAiError::InvalidInput(
            "the account session is invalid".into(),
        ));
    }
    if excerpt.trim().is_empty()
        || excerpt.trim() != excerpt
        || excerpt_chars > MAX_EXCERPT_CHARS
        || excerpt.chars().any(|value| value == '\0')
    {
        return Err(ManagedAiError::InvalidInput(
            "the selected excerpt must be 1–12,000 characters".into(),
        ));
    }
    if !(2..=35).contains(&locale.len())
        || !locale
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '-')
    {
        return Err(ManagedAiError::InvalidInput("locale is invalid".into()));
    }
    if let Some(image) = image {
        // `AiImage::encode` already sniffed and capped the bytes. Re-checking the
        // encoded size here is what stops a hand-built value from getting past
        // that, and keeps the cap enforced at the point of send.
        if image.data.is_empty() || image.data.len() > MAX_IMAGE_BYTES * 4 / 3 + 4 {
            return Err(ManagedAiError::InvalidInput(
                "the image must be 8 MB or smaller".into(),
            ));
        }
        if !matches!(image.mime_type, "image/png" | "image/jpeg") {
            return Err(ManagedAiError::InvalidInput(
                "the attachment must be a PNG or JPEG image".into(),
            ));
        }
    }
    Ok(())
}

fn read_response(
    response: Response,
    capability: AiCapability,
    excerpt: &str,
) -> Result<AiResponse> {
    let status = response.status();
    if status == StatusCode::TOO_MANY_REQUESTS {
        return Err(ManagedAiError::Quota);
    }
    if status == StatusCode::GATEWAY_TIMEOUT {
        return Err(ManagedAiError::Timeout);
    }
    if status.is_redirection() || !status.is_success() {
        return Err(ManagedAiError::Rejected(status.as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE_BYTES)
    {
        return Err(ManagedAiError::InvalidResponse);
    }
    let mut body = Vec::new();
    response
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|_| ManagedAiError::Network)?;
    if body.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(ManagedAiError::InvalidResponse);
    }
    let result: AiResponse =
        serde_json::from_slice(&body).map_err(|_| ManagedAiError::InvalidResponse)?;
    validate_response(&result, capability, excerpt)?;
    Ok(result)
}

fn validate_response(result: &AiResponse, capability: AiCapability, excerpt: &str) -> Result<()> {
    if !result.review_required
        || uuid::Uuid::parse_str(&result.account_id).is_err()
        || result.model.trim().is_empty()
        || result.model.len() > 200
        || result.candidates.len() > 100
        || result.usage.input_tokens > 10_000_000
        || result.usage.output_tokens > 10_000_000
    {
        return Err(ManagedAiError::InvalidResponse);
    }
    if capability == AiCapability::Explanation {
        if !result.candidates.is_empty()
            || result
                .explanation
                .as_deref()
                .is_none_or(|value| value.trim().is_empty() || value.chars().count() > 4_000)
        {
            return Err(ManagedAiError::InvalidResponse);
        }
    } else if result.explanation.is_some() {
        return Err(ManagedAiError::InvalidResponse);
    }
    let excerpt_folded = excerpt.to_lowercase();
    for candidate in &result.candidates {
        if !matches!(
            candidate.kind.as_str(),
            "task" | "commitment" | "assignment" | "exam" | "class_meeting" | "academic_event"
        ) || candidate.title.trim().is_empty()
            || candidate.title.chars().count() > 240
            || candidate
                .course
                .as_ref()
                .is_some_and(|value| value.trim().is_empty() || value.chars().count() > 200)
            || candidate.evidence.trim().is_empty()
            || candidate.evidence.chars().count() > 2_000
            || !excerpt_folded.contains(&candidate.evidence.to_lowercase())
            || !(0.0..=1.0).contains(&candidate.confidence)
            || candidate
                .duration_minutes
                .is_some_and(|value| !(5..=480).contains(&value))
            || candidate.warnings.len() > 20
            || candidate
                .warnings
                .iter()
                .any(|value| value.trim().is_empty() || value.chars().count() > 300)
        {
            return Err(ManagedAiError::InvalidResponse);
        }
        if let Some(due_at) = &candidate.due_at {
            chrono::DateTime::parse_from_rfc3339(due_at)
                .map_err(|_| ManagedAiError::InvalidResponse)?;
        }
        for value in [&candidate.starts_at, &candidate.ends_at]
            .into_iter()
            .flatten()
        {
            chrono::DateTime::parse_from_rfc3339(value)
                .map_err(|_| ManagedAiError::InvalidResponse)?;
        }
        if candidate.kind == "commitment"
            && match (&candidate.starts_at, &candidate.ends_at) {
                (Some(starts), Some(ends)) => {
                    chrono::DateTime::parse_from_rfc3339(ends).ok()
                        <= chrono::DateTime::parse_from_rfc3339(starts).ok()
                }
                _ => true,
            }
        {
            return Err(ManagedAiError::InvalidResponse);
        }
        validate_class_fields(candidate)?;
    }
    Ok(())
}

/// The weekly-pattern half of a candidate.
///
/// These fields describe a class that recurs, so they are only meaningful on a
/// `class_meeting`. Rejecting them elsewhere is deliberate: a task carrying
/// weekdays would have them silently dropped on the way into the review queue,
/// and a silent drop is how a student ends up with a schedule that is missing a
/// class nobody can explain.
fn validate_class_fields(candidate: &AiCandidate) -> Result<()> {
    let is_class = candidate.kind == "class_meeting";
    let has_weekly_fields = !candidate.weekdays.is_empty()
        || candidate.starts_at_local.is_some()
        || candidate.ends_at_local.is_some();
    if !is_class && has_weekly_fields {
        return Err(ManagedAiError::InvalidResponse);
    }

    if candidate.weekdays.len() > 7 || candidate.weekdays.iter().any(|day| *day > 6) {
        return Err(ManagedAiError::InvalidResponse);
    }
    let mut seen = candidate.weekdays.clone();
    seen.sort_unstable();
    seen.dedup();
    if seen.len() != candidate.weekdays.len() {
        return Err(ManagedAiError::InvalidResponse);
    }

    for value in [
        &candidate.location,
        &candidate.component,
        &candidate.modality,
        &candidate.section_number,
    ]
    .into_iter()
    .flatten()
    {
        if value.trim().is_empty() || value.chars().count() > 200 {
            return Err(ManagedAiError::InvalidResponse);
        }
    }

    match (&candidate.starts_at_local, &candidate.ends_at_local) {
        (Some(starts), Some(ends)) => {
            let starts = parse_local_clock(starts).ok_or(ManagedAiError::InvalidResponse)?;
            let ends = parse_local_clock(ends).ok_or(ManagedAiError::InvalidResponse)?;
            if starts >= ends {
                return Err(ManagedAiError::InvalidResponse);
            }
        }
        // Half a time range is not a class time. Either both ends are known or
        // the student fills them in.
        (None, None) => {}
        _ => return Err(ManagedAiError::InvalidResponse),
    }

    if is_class {
        // An asynchronous online section legitimately meets on no weekday --
        // `institution-catalogs.json` already ships sections shaped that way --
        // but it has to say so rather than simply omitting the days.
        let online = candidate
            .modality
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case("online"));
        if candidate.weekdays.is_empty() && !online {
            return Err(ManagedAiError::InvalidResponse);
        }
    }
    Ok(())
}

/// `HH:MM` on a 24-hour clock, returned as minutes since midnight.
///
/// Deliberately strict: no `9:05`, no `24:00`, no seconds. The local clock is
/// compared against itself and written straight into `class_meeting_series`, so
/// a loose parse here becomes a wrong time on a student's timetable.
fn parse_local_clock(value: &str) -> Option<u32> {
    let (hours, minutes) = value.split_once(':')?;
    if hours.len() != 2 || minutes.len() != 2 {
        return None;
    }
    let hours: u32 = hours.parse().ok()?;
    let minutes: u32 = minutes.parse().ok()?;
    if hours > 23 || minutes > 59 {
        return None;
    }
    Some(hours * 60 + minutes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_response() -> AiResponse {
        AiResponse {
            candidates: vec![AiCandidate {
                kind: "task".into(),
                title: "Draft introduction".into(),
                course: None,
                duration_minutes: Some(30),
                due_at: None,
                starts_at: None,
                ends_at: None,
                evidence: "draft the introduction".into(),
                confidence: 0.9,
                warnings: Vec::new(),
                weekdays: Vec::new(),
                starts_at_local: None,
                ends_at_local: None,
                location: None,
                component: None,
                modality: None,
                section_number: None,
            }],
            explanation: None,
            review_required: true,
            account_id: "11111111-1111-4111-8111-111111111111".into(),
            model: "test-model".into(),
            usage: AiUsage {
                input_tokens: 10,
                output_tokens: 20,
            },
        }
    }

    #[test]
    fn strict_origin_and_input_validation_fail_closed() {
        for invalid in [
            "http://api.example.com/",
            "https://user@api.example.com/",
            "https://api.example.com:8443/",
            "https://api.example.com/path",
        ] {
            assert!(ManagedAiClient::new(invalid).is_err(), "accepted {invalid}");
        }
        assert!(ManagedAiClient::new("https://api.example.com/").is_ok());
        assert!(validate_input(&"t".repeat(32), "finish paper", "en-US", None).is_ok());
        assert!(validate_input(&"t".repeat(32), " finish paper", "en-US", None).is_err());
    }

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01];
    const JPEG: &[u8] = &[0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];

    fn class_candidate() -> AiCandidate {
        AiCandidate {
            kind: "class_meeting".into(),
            title: "Statistics 201".into(),
            course: Some("STA 201".into()),
            duration_minutes: None,
            due_at: None,
            starts_at: None,
            ends_at: None,
            evidence: "STA 201 MWF 9:00".into(),
            confidence: 0.8,
            warnings: Vec::new(),
            weekdays: vec![1, 3, 5],
            starts_at_local: Some("09:00".into()),
            ends_at_local: Some("09:50".into()),
            location: Some("COOR 174".into()),
            component: Some("lecture".into()),
            modality: Some("in-person".into()),
            section_number: Some("87991".into()),
        }
    }

    fn with_class(candidate: AiCandidate) -> AiResponse {
        AiResponse {
            candidates: vec![candidate],
            ..valid_response()
        }
    }

    const SCHEDULE_EXCERPT: &str = "Fall 2026 STA 201 MWF 9:00 COOR 174";

    fn check(candidate: AiCandidate) -> Result<()> {
        validate_response(
            &with_class(candidate),
            AiCapability::DocumentExtraction,
            SCHEDULE_EXCERPT,
        )
    }

    // A schedule screenshot produces class_meeting candidates. Until the kind
    // list grew, every schedule extraction came back as an invalid response.
    #[test]
    fn a_weekly_class_is_a_valid_candidate() {
        assert!(check(class_candidate()).is_ok());
    }

    #[test]
    fn weekdays_must_be_a_unique_set_of_real_days() {
        for weekdays in [vec![7], vec![1, 1, 3], vec![0, 1, 2, 3, 4, 5, 6, 6]] {
            let candidate = AiCandidate {
                weekdays,
                ..class_candidate()
            };
            assert!(check(candidate).is_err());
        }
        // Sunday and Saturday are both legal; the encoding is 0..=6.
        assert!(check(AiCandidate {
            weekdays: vec![0, 6],
            ..class_candidate()
        })
        .is_ok());
    }

    #[test]
    fn a_class_must_start_before_it_ends() {
        for (starts, ends) in [
            ("09:50", "09:00"),
            ("09:00", "09:00"),
            ("9:00", "09:50"),
            ("24:00", "24:30"),
            ("09:60", "10:00"),
        ] {
            let candidate = AiCandidate {
                starts_at_local: Some(starts.into()),
                ends_at_local: Some(ends.into()),
                ..class_candidate()
            };
            assert!(check(candidate).is_err(), "accepted {starts}-{ends}");
        }
        // Half a range is not a class time.
        assert!(check(AiCandidate {
            ends_at_local: None,
            ..class_candidate()
        })
        .is_err());
    }

    // institution-catalogs.json already ships asynchronous online sections with
    // no weekdays. That shape is legal, but it has to say it is online rather
    // than simply omitting the days.
    #[test]
    fn a_class_needs_weekdays_unless_it_says_it_is_online() {
        assert!(check(AiCandidate {
            weekdays: Vec::new(),
            starts_at_local: None,
            ends_at_local: None,
            ..class_candidate()
        })
        .is_err());
        assert!(check(AiCandidate {
            weekdays: Vec::new(),
            starts_at_local: None,
            ends_at_local: None,
            modality: Some("online".into()),
            ..class_candidate()
        })
        .is_ok());
    }

    // A task carrying weekdays would have them dropped on the way into the
    // review queue, and a silent drop is a missing class nobody can explain.
    #[test]
    fn weekly_fields_are_rejected_on_kinds_that_cannot_carry_them() {
        let candidate = AiCandidate {
            kind: "task".into(),
            evidence: "STA 201".into(),
            ..class_candidate()
        };
        assert!(check(candidate).is_err());
    }

    // The invariant that stops the model inventing a due date. An image has no
    // excerpt of its own, which is exactly why the OCR text is sent with it.
    #[test]
    fn evidence_must_still_be_a_substring_of_the_excerpt() {
        let candidate = AiCandidate {
            evidence: "PSY 101 TTh 11:00".into(),
            ..class_candidate()
        };
        assert!(check(candidate).is_err());
    }

    #[test]
    fn only_png_and_jpeg_attachments_are_accepted() {
        assert!(AiImage::encode(PNG).is_ok());
        assert!(AiImage::encode(JPEG).is_ok());
        // A PDF, a bare text file, and an empty body are all refused, and the
        // extension a caller might claim is never consulted.
        assert!(AiImage::encode(b"%PDF-1.7\n").is_err());
        assert!(AiImage::encode(b"GIF89a").is_err());
        assert!(AiImage::encode(b"").is_err());
    }

    #[test]
    fn an_oversized_image_is_refused_before_it_is_sent() {
        let mut oversized = PNG.to_vec();
        oversized.resize(MAX_IMAGE_BYTES + 1, 0);
        assert!(AiImage::encode(&oversized).is_err());

        let mut largest = PNG.to_vec();
        largest.resize(MAX_IMAGE_BYTES, 0);
        let encoded = AiImage::encode(&largest).expect("the cap is inclusive");
        assert!(validate_input(&"t".repeat(32), "schedule", "en-US", Some(&encoded)).is_ok());
    }

    #[test]
    fn an_image_rides_along_with_the_excerpt_rather_than_replacing_it() {
        let image = AiImage::encode(PNG).unwrap();
        // The excerpt is still required, still trimmed, still bounded. Sending a
        // picture does not buy an exemption from the text half of the contract.
        assert!(validate_input(&"t".repeat(32), "", "en-US", Some(&image)).is_err());
        assert!(validate_input(&"t".repeat(32), " schedule", "en-US", Some(&image)).is_err());
        assert!(validate_input(&"t".repeat(32), "schedule", "en-US", Some(&image)).is_ok());

        let request = AiRequest {
            capability: AiCapability::DocumentExtraction,
            excerpt: "schedule",
            locale: "en-US",
            image: Some(&image),
        };
        let json = serde_json::to_value(&request).unwrap();
        assert_eq!(json["image"]["mimeType"], "image/png");
        assert!(json["excerpt"].is_string());

        // A request without an image omits the field rather than sending null,
        // so a server that has not been updated still parses it.
        let plain = AiRequest {
            capability: AiCapability::DocumentExtraction,
            excerpt: "schedule",
            locale: "en-US",
            image: None,
        };
        assert!(serde_json::to_value(&plain).unwrap().get("image").is_none());
    }

    // The desktop app and the cloud service deploy separately, so a response
    // from a build that predates the weekly fields must still parse.
    #[test]
    fn a_response_without_the_new_fields_still_parses() {
        let older = r#"{
            "candidates":[{"kind":"task","title":"Draft","course":null,"durationMinutes":null,
                           "dueAt":null,"startsAt":null,"endsAt":null,
                           "evidence":"draft","confidence":0.5,"warnings":[]}],
            "explanation":null,"reviewRequired":true,
            "accountId":"11111111-1111-4111-8111-111111111111",
            "model":"m","usage":{"inputTokens":1,"outputTokens":2}
        }"#;
        let parsed: AiResponse = serde_json::from_str(older).unwrap();
        assert!(parsed.candidates[0].weekdays.is_empty());
        assert!(validate_response(&parsed, AiCapability::BrainDump, "draft").is_ok());
    }

    #[test]
    fn response_must_be_source_grounded_and_capability_safe() {
        let result = valid_response();
        assert!(validate_response(
            &result,
            AiCapability::BrainDump,
            "I need to draft the introduction"
        )
        .is_ok());
        assert!(validate_response(&result, AiCapability::BrainDump, "finish paper").is_err());
        assert!(validate_response(&result, AiCapability::Explanation, "finish paper").is_err());
    }
}
