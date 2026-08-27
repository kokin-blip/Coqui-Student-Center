use crate::managed_ai::{self, AiCapability, AiImage, AiResponse, AiUsage, ManagedAiError};
use reqwest::{blocking::{Client, Response}, redirect::Policy, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{io::Read, time::Duration};
use zeroize::Zeroizing;

const CREDENTIAL_SERVICE: &str = "Coqui Student Center AI";
const MAX_RESPONSE_BYTES: u64 = 512 * 1024;
const MAX_GROUNDED_SOURCE_CHARS: usize = 60_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ProviderId { Openai, Anthropic, Gemini }

impl ProviderId {
    pub const ALL: [Self; 3] = [Self::Openai, Self::Anthropic, Self::Gemini];
    pub fn as_str(self) -> &'static str { match self { Self::Openai => "openai", Self::Anthropic => "anthropic", Self::Gemini => "gemini" } }
    pub fn default_model(self) -> &'static str { match self { Self::Openai => "gpt-5.4-mini-2026-03-17", Self::Anthropic => "claude-sonnet-5", Self::Gemini => "gemini-3.7-flash" } }
    pub fn disclosure_url(self) -> &'static str { match self {
        Self::Openai => "https://openai.com/policies/api-data-usage-policies/",
        Self::Anthropic => "https://privacy.claude.com/en/articles/7996868-how-long-do-you-store-my-organization-s-data",
        Self::Gemini => "https://ai.google.dev/gemini-api/terms",
    }}
}

impl std::str::FromStr for ProviderId {
    type Err = ManagedAiError;
    fn from_str(value: &str) -> Result<Self, Self::Err> { match value {
        "openai" => Ok(Self::Openai), "anthropic" => Ok(Self::Anthropic), "gemini" => Ok(Self::Gemini),
        _ => Err(ManagedAiError::InvalidInput("AI provider is invalid".into())),
    }}
}

pub fn credential_entry(provider: ProviderId) -> Result<keyring::Entry, keyring::Error> {
    keyring::Entry::new(CREDENTIAL_SERVICE, provider.as_str())
}

pub fn save_key(provider: ProviderId, key: Zeroizing<String>) -> Result<(), ManagedAiError> {
    validate_key(&key)?;
    credential_entry(provider).map_err(|_| ManagedAiError::Credential)?.set_password(&key).map_err(|_| ManagedAiError::Credential)
}

pub fn load_key(provider: ProviderId) -> Result<Zeroizing<String>, ManagedAiError> {
    credential_entry(provider).map_err(|_| ManagedAiError::Credential)?.get_password().map(Zeroizing::new).map_err(|error| match error {
        keyring::Error::NoEntry => ManagedAiError::NotConfigured,
        _ => ManagedAiError::Credential,
    })
}

pub fn remove_key(provider: ProviderId) -> Result<(), ManagedAiError> {
    match credential_entry(provider).map_err(|_| ManagedAiError::Credential)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(ManagedAiError::Credential),
    }
}

fn validate_key(key: &str) -> Result<(), ManagedAiError> {
    if !(20..=4096).contains(&key.len()) || key.trim() != key || key.chars().any(char::is_whitespace) {
        return Err(ManagedAiError::InvalidInput("API key is invalid".into()));
    }
    Ok(())
}

fn client() -> Result<Client, ManagedAiError> {
    Client::builder().redirect(Policy::none()).no_proxy().connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(45)).user_agent(concat!("CoquiStudentCenter/", env!("CARGO_PKG_VERSION")))
        .build().map_err(|_| ManagedAiError::Network)
}

pub fn test_connection(provider: ProviderId, key: &str) -> Result<(), ManagedAiError> {
    validate_key(key)?;
    let client = client()?;
    let response = match provider {
        ProviderId::Openai => client.get("https://api.openai.com/v1/models").bearer_auth(key).send(),
        ProviderId::Anthropic => client.get("https://api.anthropic.com/v1/models").header("x-api-key", key).header("anthropic-version", "2023-06-01").send(),
        ProviderId::Gemini => client.get("https://generativelanguage.googleapis.com/v1beta/models").header("x-goog-api-key", key).send(),
    }.map_err(map_network)?;
    check_status(response).map(|_| ())
}

pub fn request(
    provider: ProviderId,
    key: &str,
    model: &str,
    capability: AiCapability,
    excerpt: &str,
    locale: &str,
    image: Option<&AiImage>,
) -> Result<AiResponse, ManagedAiError> {
    validate_key(key)?;
    managed_ai::validate_input(key, excerpt, locale, image)?;
    if model.trim().is_empty() || model.len() > 200 { return Err(ManagedAiError::InvalidInput("model is invalid".into())); }
    let prompt = prompt(capability, excerpt, locale);
    let schema = response_schema();
    let response = match provider {
        ProviderId::Openai => request_openai(key, model, &prompt, image, &schema)?,
        ProviderId::Anthropic => request_anthropic(key, model, &prompt, image, &schema)?,
        ProviderId::Gemini => request_gemini(key, model, &prompt, image, &schema)?,
    };
    managed_ai::validate_response(&response, capability, excerpt)?;
    Ok(response)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroundedSource {
    pub id: String,
    pub locator: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroundedCitation {
    pub source_id: String,
    pub locator: String,
    pub quote: String,
}

#[derive(Debug, Clone)]
pub struct GroundedResult {
    pub content: String,
    pub citations: Vec<GroundedCitation>,
    pub model: String,
    pub usage: AiUsage,
}

#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct GroundedBody { content: String, citations: Vec<GroundedCitation>, unsupported: bool }

pub fn request_grounded(
    provider: ProviderId,
    key: &str,
    model: &str,
    capability: AiCapability,
    question: &str,
    sources: &[GroundedSource],
) -> Result<GroundedResult, ManagedAiError> {
    validate_key(key)?;
    if !matches!(capability, AiCapability::SourceQa | AiCapability::StudyGuide | AiCapability::Flashcards | AiCapability::PracticeQuestions | AiCapability::PracticeTest)
        || question.trim().is_empty() || question.trim() != question || question.chars().count() > 4_000
        || sources.is_empty() || sources.len() > 100 {
        return Err(ManagedAiError::InvalidInput("grounded study request is invalid".into()));
    }
    let mut source_chars = 0usize;
    let mut prompt = format!(
        "Create a source-grounded student study result. Capability: {}. Use only the SOURCES below. If they do not support the request, set unsupported=true and explain the gap. Every citation quote must be an exact substring of its named source and use its exact locator. Never use outside knowledge. REQUEST:\n{}\nSOURCES:\n",
        capability.as_str(), question
    );
    for source in sources {
        if source.id.is_empty() || source.locator.is_empty() || source.text.trim().is_empty() { return Err(ManagedAiError::InvalidInput("study source is invalid".into())); }
        source_chars = source_chars.saturating_add(source.text.chars().count());
        if source_chars > MAX_GROUNDED_SOURCE_CHARS { return Err(ManagedAiError::InvalidInput("selected study sources are too large".into())); }
        prompt.push_str("\nSOURCE_JSON=");
        prompt.push_str(&serde_json::to_string(source).map_err(|_| ManagedAiError::InvalidInput("study source is invalid".into()))?);
        prompt.push('\n');
    }
    let schema = grounded_schema();
    let (value, usage) = match provider {
        ProviderId::Openai => grounded_openai(key, model, &prompt, &schema)?,
        ProviderId::Anthropic => grounded_anthropic(key, model, &prompt, &schema)?,
        ProviderId::Gemini => grounded_gemini(key, model, &prompt, &schema)?,
    };
    let (content,citations)=validate_grounded_value(value,sources)?;
    Ok(GroundedResult { content, citations, model:model.into(), usage })
}

fn validate_grounded_value(value:Value,sources:&[GroundedSource])->Result<(String,Vec<GroundedCitation>),ManagedAiError>{
    let body: GroundedBody = serde_json::from_value(value).map_err(|_| ManagedAiError::InvalidResponse)?;
    if body.content.trim().is_empty() || body.content.chars().count() > 40_000 { return Err(ManagedAiError::InvalidResponse); }
    if !body.unsupported && body.citations.is_empty() { return Err(ManagedAiError::InvalidResponse); }
    for citation in &body.citations {
        let source = sources.iter().find(|source| source.id == citation.source_id && source.locator == citation.locator)
            .ok_or(ManagedAiError::InvalidResponse)?;
        if citation.quote.trim().is_empty() || !source.text.contains(&citation.quote) { return Err(ManagedAiError::InvalidResponse); }
    }
    let content = if body.unsupported { format!("Not grounded in the selected materials. {}", body.content) } else { body.content };
    Ok((content,body.citations))
}

fn grounded_schema() -> Value {
    json!({
        "type":"object","additionalProperties":false,
        "properties":{
            "content":{"type":"string"},
            "unsupported":{"type":"boolean"},
            "citations":{"type":"array","items":{"type":"object","additionalProperties":false,
                "properties":{"sourceId":{"type":"string"},"locator":{"type":"string"},"quote":{"type":"string"}},
                "required":["sourceId","locator","quote"]}}
        },
        "required":["content","unsupported","citations"]
    })
}

fn grounded_openai(key: &str, model: &str, prompt: &str, schema: &Value) -> Result<(Value,AiUsage), ManagedAiError> {
    grounded_openai_at("https://api.openai.com/v1/responses",key,model,prompt,schema)
}

fn grounded_openai_at(endpoint:&str,key: &str, model: &str, prompt: &str, schema: &Value) -> Result<(Value,AiUsage), ManagedAiError> {
    let body=json!({"model":model,"store":false,"input":[{"role":"user","content":[{"type":"input_text","text":prompt}]}],"text":{"format":{"type":"json_schema","name":"coqui_grounded_study","strict":true,"schema":schema}}});
    let value=read_json(client()?.post(endpoint).bearer_auth(key).json(&body).send().map_err(map_network)?)?;
    let (text,usage)=provider_text_and_usage(ProviderId::Openai,&value)?;
    let parsed=serde_json::from_str(text).map_err(|_|ManagedAiError::InvalidResponse)?;
    Ok((parsed,usage))
}

fn grounded_anthropic(key:&str,model:&str,prompt:&str,schema:&Value)->Result<(Value,AiUsage),ManagedAiError>{
    grounded_anthropic_at("https://api.anthropic.com/v1/messages",key,model,prompt,schema)
}

fn grounded_anthropic_at(endpoint:&str,key:&str,model:&str,prompt:&str,schema:&Value)->Result<(Value,AiUsage),ManagedAiError>{
    let body=json!({"model":model,"max_tokens":8192,"thinking":{"type":"disabled"},"messages":[{"role":"user","content":[{"type":"text","text":prompt}]}],"output_config":{"format":{"type":"json_schema","schema":schema}}});
    let value=read_json(client()?.post(endpoint).header("x-api-key",key).header("anthropic-version","2023-06-01").json(&body).send().map_err(map_network)?)?;
    let (text,usage)=provider_text_and_usage(ProviderId::Anthropic,&value)?;
    let parsed=serde_json::from_str(text).map_err(|_|ManagedAiError::InvalidResponse)?;
    Ok((parsed,usage))
}

fn grounded_gemini(key:&str,model:&str,prompt:&str,schema:&Value)->Result<(Value,AiUsage),ManagedAiError>{
    if !model.chars().all(|value|value.is_ascii_alphanumeric()||matches!(value,'-'|'_'|'.')){return Err(ManagedAiError::InvalidInput("Gemini model is invalid".into()));}
    let endpoint=format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent");
    grounded_gemini_at(&endpoint,key,model,prompt,schema)
}

fn grounded_gemini_at(endpoint:&str,key:&str,model:&str,prompt:&str,schema:&Value)->Result<(Value,AiUsage),ManagedAiError>{
    if !model.chars().all(|value|value.is_ascii_alphanumeric()||matches!(value,'-'|'_'|'.')){return Err(ManagedAiError::InvalidInput("Gemini model is invalid".into()));}
    let body=json!({"contents":[{"role":"user","parts":[{"text":prompt}]}],"generationConfig":{"responseMimeType":"application/json","responseSchema":schema}});
    let value=read_json(client()?.post(endpoint).header("x-goog-api-key",key).json(&body).send().map_err(map_network)?)?;
    let (text,usage)=provider_text_and_usage(ProviderId::Gemini,&value)?;
    let parsed=serde_json::from_str(text).map_err(|_|ManagedAiError::InvalidResponse)?;
    Ok((parsed,usage))
}

fn prompt(capability: AiCapability, excerpt: &str, locale: &str) -> String {
    format!("You structure student-owned academic information for review. Capability: {}. Locale: {locale}. Never invent facts. Every evidence value must be an exact, literal substring of SOURCE. For planner explanations return no candidates. SOURCE:\n{excerpt}", capability.as_str())
}

fn response_schema() -> Value {
    let nullable_string = json!({"type":["string","null"]});
    let candidate = json!({
        "type":"object", "additionalProperties":false,
        "properties":{
            "kind":{"type":"string","enum":["task","commitment","assignment","exam","class_meeting","academic_event"]},
            "title":{"type":"string"}, "course":nullable_string, "durationMinutes":{"type":["integer","null"]},
            "dueAt":nullable_string, "startsAt":nullable_string, "endsAt":nullable_string,
            "evidence":{"type":"string"}, "confidence":{"type":"number"},
            "warnings":{"type":"array","items":{"type":"string"}},
            "weekdays":{"type":"array","items":{"type":"integer"}},
            "startsAtLocal":nullable_string, "endsAtLocal":nullable_string, "location":nullable_string,
            "component":nullable_string, "modality":nullable_string, "sectionNumber":nullable_string
        },
        "required":["kind","title","course","durationMinutes","dueAt","startsAt","endsAt","evidence","confidence","warnings","weekdays","startsAtLocal","endsAtLocal","location","component","modality","sectionNumber"]
    });
    json!({
        "type":"object", "additionalProperties":false,
        "properties":{"candidates":{"type":"array","items":candidate},"explanation":{"type":["string","null"]}},
        "required":["candidates","explanation"]
    })
}

fn request_openai(key: &str, model: &str, prompt: &str, image: Option<&AiImage>, schema: &Value) -> Result<AiResponse, ManagedAiError> {
    request_openai_at("https://api.openai.com/v1/responses", key, model, prompt, image, schema)
}

fn request_openai_at(endpoint: &str, key: &str, model: &str, prompt: &str, image: Option<&AiImage>, schema: &Value) -> Result<AiResponse, ManagedAiError> {
    let mut content = vec![json!({"type":"input_text","text":prompt})];
    if let Some(image) = image { content.push(json!({"type":"input_image","image_url":format!("data:{};base64,{}", image.mime_type(), image.data())})); }
    let body = json!({
        "model":model, "store":false, "input":[{"role":"user","content":content}],
        "text":{"format":{"type":"json_schema","name":"coqui_review","strict":true,"schema":schema}}
    });
    let response = client()?.post(endpoint).bearer_auth(key).json(&body).send().map_err(map_network)?;
    let value = read_json(response)?;
    let (text,usage)=provider_text_and_usage(ProviderId::Openai,&value)?;
    normalized_response(text, model, usage.input_tokens, usage.output_tokens)
}

fn request_anthropic(key: &str, model: &str, prompt: &str, image: Option<&AiImage>, schema: &Value) -> Result<AiResponse, ManagedAiError> {
    request_anthropic_at("https://api.anthropic.com/v1/messages", key, model, prompt, image, schema)
}

fn request_anthropic_at(endpoint: &str, key: &str, model: &str, prompt: &str, image: Option<&AiImage>, schema: &Value) -> Result<AiResponse, ManagedAiError> {
    let mut content = Vec::new();
    if let Some(image) = image { content.push(json!({"type":"image","source":{"type":"base64","media_type":image.mime_type(),"data":image.data()}})); }
    content.push(json!({"type":"text","text":prompt}));
    let body = json!({
        "model":model, "max_tokens":4096, "thinking":{"type":"disabled"}, "messages":[{"role":"user","content":content}],
        "output_config":{"format":{"type":"json_schema","schema":schema}}
    });
    let response = client()?.post(endpoint).header("x-api-key", key)
        .header("anthropic-version", "2023-06-01").json(&body).send().map_err(map_network)?;
    let value = read_json(response)?;
    let (text,usage)=provider_text_and_usage(ProviderId::Anthropic,&value)?;
    normalized_response(text, model, usage.input_tokens, usage.output_tokens)
}

fn request_gemini(key: &str, model: &str, prompt: &str, image: Option<&AiImage>, schema: &Value) -> Result<AiResponse, ManagedAiError> {
    if !model.chars().all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | '.')) { return Err(ManagedAiError::InvalidInput("Gemini model is invalid".into())); }
    let endpoint = format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent");
    request_gemini_at(&endpoint, key, model, prompt, image, schema)
}

fn request_gemini_at(endpoint: &str, key: &str, model: &str, prompt: &str, image: Option<&AiImage>, schema: &Value) -> Result<AiResponse, ManagedAiError> {
    if !model.chars().all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | '.')) { return Err(ManagedAiError::InvalidInput("Gemini model is invalid".into())); }
    let mut parts = vec![json!({"text":prompt})];
    if let Some(image) = image { parts.push(json!({"inline_data":{"mime_type":image.mime_type(),"data":image.data()}})); }
    let body = json!({
        "contents":[{"role":"user","parts":parts}],
        "generationConfig":{"responseMimeType":"application/json","responseSchema":schema}
    });
    let response = client()?.post(endpoint).header("x-goog-api-key", key).json(&body).send().map_err(map_network)?;
    let value = read_json(response)?;
    let (text,usage)=provider_text_and_usage(ProviderId::Gemini,&value)?;
    normalized_response(text, model, usage.input_tokens, usage.output_tokens)
}

fn provider_text_and_usage(provider: ProviderId, value: &Value) -> Result<(&str, AiUsage), ManagedAiError> {
    let (text,input_tokens,output_tokens)=match provider {
        ProviderId::Openai => (
            value.get("output").and_then(Value::as_array).into_iter().flatten()
                .flat_map(|item|item.get("content").and_then(Value::as_array).into_iter().flatten())
                .find_map(|item|item.get("text").and_then(Value::as_str)),
            value.pointer("/usage/input_tokens").and_then(Value::as_u64).unwrap_or(0),
            value.pointer("/usage/output_tokens").and_then(Value::as_u64).unwrap_or(0),
        ),
        ProviderId::Anthropic => (
            value.get("content").and_then(Value::as_array).into_iter().flatten()
                .find_map(|item|(item.get("type").and_then(Value::as_str)==Some("text")).then(||item.get("text").and_then(Value::as_str)).flatten()),
            value.pointer("/usage/input_tokens").and_then(Value::as_u64).unwrap_or(0),
            value.pointer("/usage/output_tokens").and_then(Value::as_u64).unwrap_or(0),
        ),
        ProviderId::Gemini => (
            value.pointer("/candidates/0/content/parts/0/text").and_then(Value::as_str),
            value.pointer("/usageMetadata/promptTokenCount").and_then(Value::as_u64).unwrap_or(0),
            value.pointer("/usageMetadata/candidatesTokenCount").and_then(Value::as_u64).unwrap_or(0),
        ),
    };
    Ok((text.ok_or(ManagedAiError::InvalidResponse)?,AiUsage{input_tokens,output_tokens}))
}

fn normalized_response(text: &str, model: &str, input_tokens: u64, output_tokens: u64) -> Result<AiResponse, ManagedAiError> {
    #[derive(Deserialize)] #[serde(rename_all="camelCase", deny_unknown_fields)]
    struct Body { candidates: Vec<managed_ai::AiCandidate>, explanation: Option<String> }
    let body: Body = serde_json::from_str(text).map_err(|_| ManagedAiError::InvalidResponse)?;
    Ok(AiResponse { candidates:body.candidates, explanation:body.explanation, review_required:true,
        account_id:"00000000-0000-4000-8000-000000000000".into(), model:model.into(), usage:AiUsage{input_tokens,output_tokens} })
}

fn map_network(error: reqwest::Error) -> ManagedAiError { if error.is_timeout() { ManagedAiError::Timeout } else { ManagedAiError::Network } }

fn check_status(response: Response) -> Result<Response, ManagedAiError> {
    let status = response.status();
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN { return Err(ManagedAiError::Unauthorized); }
    if status == StatusCode::TOO_MANY_REQUESTS { return Err(ManagedAiError::Quota); }
    if status == StatusCode::REQUEST_TIMEOUT || status == StatusCode::GATEWAY_TIMEOUT { return Err(ManagedAiError::Timeout); }
    if status.is_redirection() || !status.is_success() { return Err(ManagedAiError::Rejected(status.as_u16())); }
    Ok(response)
}

fn read_json(response: Response) -> Result<Value, ManagedAiError> {
    let response = check_status(response)?;
    if response.content_length().is_some_and(|size| size > MAX_RESPONSE_BYTES) { return Err(ManagedAiError::InvalidResponse); }
    let mut body = Vec::new();
    response.take(MAX_RESPONSE_BYTES + 1).read_to_end(&mut body).map_err(|_| ManagedAiError::Network)?;
    if body.len() as u64 > MAX_RESPONSE_BYTES { return Err(ManagedAiError::InvalidResponse); }
    serde_json::from_slice(&body).map_err(|_| ManagedAiError::InvalidResponse)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc,
        thread,
    };

    fn fixture_server(response_body: Value) -> (String, mpsc::Receiver<String>, thread::JoinHandle<()>) {
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();
        let address=listener.local_addr().unwrap();
        let (sender,receiver)=mpsc::channel();
        let handle=thread::spawn(move || {
            let (mut stream,_)=listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut request=Vec::new();
            let mut buffer=[0_u8;4096];
            loop {
                match stream.read(&mut buffer) {
                    Ok(0)=>break,
                    Ok(count)=>{
                        request.extend_from_slice(&buffer[..count]);
                        let header_end=request.windows(4).position(|window|window==b"\r\n\r\n").map(|index|index+4);
                        if let Some(header_end)=header_end {
                            let headers=String::from_utf8_lossy(&request[..header_end]);
                            let content_length=headers.lines().find_map(|line|{
                                let (name,value)=line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length").then(||value.trim().parse::<usize>().ok()).flatten()
                            }).unwrap_or(0);
                            if request.len()>=header_end+content_length { break; }
                        }
                    }
                    Err(error) if matches!(error.kind(),std::io::ErrorKind::WouldBlock|std::io::ErrorKind::TimedOut)=>break,
                    Err(error)=>panic!("fixture request failed: {error}"),
                }
            }
            sender.send(String::from_utf8_lossy(&request).into_owned()).unwrap();
            let response=response_body.to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
        });
        (format!("http://{address}/fixture"),receiver,handle)
    }

    fn empty_result_text() -> &'static str { "{\"candidates\":[],\"explanation\":null}" }
    fn grounded_result_text() -> &'static str { "{\"content\":\"Supported\",\"unsupported\":false,\"citations\":[{\"sourceId\":\"s1\",\"locator\":\"page 1\",\"quote\":\"literal\"}]}" }

    #[test] fn provider_ids_and_defaults_are_stable() { for provider in ProviderId::ALL { assert_eq!(provider.as_str().parse::<ProviderId>().unwrap(), provider); assert!(!provider.default_model().is_empty()); } }
    #[test] fn keys_are_bounded_and_never_trimmed() { assert!(validate_key(&"x".repeat(20)).is_ok()); assert!(validate_key(" short key ").is_err()); assert!(validate_key(&"x".repeat(4097)).is_err()); }
    #[test] fn response_schema_is_strict() { let schema=response_schema(); assert_eq!(schema["additionalProperties"], false); assert_eq!(schema["properties"]["candidates"]["items"]["additionalProperties"], false); }
    #[test] fn recorded_provider_fixtures_normalize_text_and_usage() {
        let fixtures=[
            (ProviderId::Openai,json!({"output":[{"content":[{"type":"output_text","text":"{\"candidates\":[],\"explanation\":null}"}]}],"usage":{"input_tokens":12,"output_tokens":3}})),
            (ProviderId::Anthropic,json!({"content":[{"type":"text","text":"{\"candidates\":[],\"explanation\":null}"}],"usage":{"input_tokens":13,"output_tokens":4}})),
            (ProviderId::Gemini,json!({"candidates":[{"content":{"parts":[{"text":"{\"candidates\":[],\"explanation\":null}"}]}}],"usageMetadata":{"promptTokenCount":14,"candidatesTokenCount":5}})),
        ];
        for (provider,value) in fixtures {
            let (text,usage)=provider_text_and_usage(provider,&value).unwrap();
            assert!(text.contains("candidates"));
            assert!(usage.input_tokens>=12 && usage.output_tokens>=3);
            assert!(normalized_response(text,provider.default_model(),usage.input_tokens,usage.output_tokens).is_ok());
        }
    }
    #[test] fn provider_adapters_send_strict_requests_to_local_fixture_servers() {
        let schema=response_schema();
        let key="fixture-key-with-safe-length";

        let (endpoint,request,server)=fixture_server(json!({"output":[{"content":[{"type":"output_text","text":empty_result_text()}]}],"usage":{"input_tokens":12,"output_tokens":3}}));
        let result=request_openai_at(&endpoint,key,"gpt-fixture","SOURCE",None,&schema).unwrap();
        assert!(result.candidates.is_empty());
        let request=request.recv_timeout(Duration::from_secs(2)).unwrap();
        server.join().unwrap();
        assert!(request.to_ascii_lowercase().contains("authorization: bearer fixture-key-with-safe-length"));
        assert!(request.contains("\"store\":false"));
        assert!(request.contains("\"strict\":true"));

        let (endpoint,request,server)=fixture_server(json!({"content":[{"type":"text","text":empty_result_text()}],"usage":{"input_tokens":13,"output_tokens":4}}));
        let result=request_anthropic_at(&endpoint,key,"claude-fixture","SOURCE",None,&schema).unwrap();
        assert!(result.candidates.is_empty());
        let request=request.recv_timeout(Duration::from_secs(2)).unwrap();
        server.join().unwrap();
        assert!(request.to_ascii_lowercase().contains("x-api-key: fixture-key-with-safe-length"));
        assert!(request.contains("\"thinking\":{\"type\":\"disabled\"}"));
        assert!(request.contains("\"output_config\""));

        let (endpoint,request,server)=fixture_server(json!({"candidates":[{"content":{"parts":[{"text":empty_result_text()}]}}],"usageMetadata":{"promptTokenCount":14,"candidatesTokenCount":5}}));
        let result=request_gemini_at(&endpoint,key,"gemini-fixture","SOURCE",None,&schema).unwrap();
        assert!(result.candidates.is_empty());
        let request=request.recv_timeout(Duration::from_secs(2)).unwrap();
        server.join().unwrap();
        assert!(request.to_ascii_lowercase().contains("x-goog-api-key: fixture-key-with-safe-length"));
        assert!(request.contains("\"responseMimeType\":\"application/json\""));
        assert!(request.contains("\"responseSchema\""));
    }
    #[test] fn grounded_study_adapters_use_the_same_mocked_structured_output_gate() {
        let schema=grounded_schema();
        let key="fixture-key-with-safe-length";
        let fixtures=[
            (ProviderId::Openai,json!({"output":[{"content":[{"type":"output_text","text":grounded_result_text()}]}],"usage":{"input_tokens":21,"output_tokens":8}})),
            (ProviderId::Anthropic,json!({"content":[{"type":"text","text":grounded_result_text()}],"usage":{"input_tokens":22,"output_tokens":9}})),
            (ProviderId::Gemini,json!({"candidates":[{"content":{"parts":[{"text":grounded_result_text()}]}}],"usageMetadata":{"promptTokenCount":23,"candidatesTokenCount":10}})),
        ];
        for (provider,response) in fixtures {
            let (endpoint,request,server)=fixture_server(response);
            let (value,usage)=match provider {
                ProviderId::Openai=>grounded_openai_at(&endpoint,key,"gpt-fixture","GROUND THIS",&schema),
                ProviderId::Anthropic=>grounded_anthropic_at(&endpoint,key,"claude-fixture","GROUND THIS",&schema),
                ProviderId::Gemini=>grounded_gemini_at(&endpoint,key,"gemini-fixture","GROUND THIS",&schema),
            }.unwrap();
            assert_eq!(value["content"],"Supported");
            assert!(usage.input_tokens>=21&&usage.output_tokens>=8);
            let request=request.recv_timeout(Duration::from_secs(2)).unwrap();
            server.join().unwrap();
            assert!(request.contains("GROUND THIS"));
            assert!(request.contains("\"citations\""));
            assert!(request.contains("application/json"));
        }
    }
    #[test] fn grounded_results_require_literal_source_citations() {
        let sources=vec![GroundedSource{id:"source-1".into(),locator:"page 2".into(),text:"Classical conditioning pairs two stimuli.".into()}];
        let valid=json!({"content":"A supported answer","unsupported":false,"citations":[{"sourceId":"source-1","locator":"page 2","quote":"pairs two stimuli"}]});
        assert!(validate_grounded_value(valid,&sources).is_ok());
        let invented=json!({"content":"An invented answer","unsupported":false,"citations":[{"sourceId":"source-1","locator":"page 2","quote":"operant behavior"}]});
        assert!(validate_grounded_value(invented,&sources).is_err());
        let honest=json!({"content":"The notes do not cover this.","unsupported":true,"citations":[]});
        assert!(validate_grounded_value(honest,&sources).unwrap().0.starts_with("Not grounded"));
    }
}
