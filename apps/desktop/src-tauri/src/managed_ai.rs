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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiRequest<'a> {
    capability: AiCapability,
    excerpt: &'a str,
    locale: &'a str,
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
    ) -> Result<AiResponse> {
        validate_input(access_token, excerpt, locale)?;
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

fn validate_input(access_token: &str, excerpt: &str, locale: &str) -> Result<()> {
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
            "task" | "commitment" | "assignment" | "exam"
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
    }
    Ok(())
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
        assert!(validate_input(&"t".repeat(32), "finish paper", "en-US").is_ok());
        assert!(validate_input(&"t".repeat(32), " finish paper", "en-US").is_err());
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
