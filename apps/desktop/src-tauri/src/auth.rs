use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Duration, Utc};
use rand::{rngs::OsRng, RngCore};
use reqwest::{blocking::Client, redirect::Policy, StatusCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::Duration as StdDuration;
use url::Url;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

const CREDENTIAL_SERVICE: &str = "app.studentcenter.desktop";
const SESSION_CREDENTIAL: &str = "account-session";
const OAUTH_REDIRECT: &str = "studentcenter://auth/callback";
const OAUTH_FLOW_PARAMETER: &str = "sb_flow_id";
const OAUTH_FLOW_LIFETIME_MINUTES: i64 = 5;

#[derive(thiserror::Error, Debug)]
pub enum AuthError {
    #[error("account service configuration is invalid")]
    Configuration,
    #[error("invalid input: {0}")]
    Invalid(String),
    #[error("account service is unavailable: {0}")]
    Network(String),
    #[error("sign-in failed: {0}")]
    Api(String),
    #[error("account service returned an invalid response")]
    Response,
    #[error("credential store error: {0}")]
    Credential(#[from] keyring::Error),
}

pub type Result<T> = std::result::Result<T, AuthError>;

#[derive(Debug, Clone)]
pub struct AuthConfiguration {
    origin: Url,
    publishable_key: String,
}

impl AuthConfiguration {
    pub fn new(origin: &str, publishable_key: &str) -> Result<Self> {
        let origin = Url::parse(origin.trim()).map_err(|_| AuthError::Configuration)?;
        if origin.scheme() != "https"
            || origin.host_str().is_none()
            || !origin.username().is_empty()
            || origin.password().is_some()
            || origin.path() != "/"
            || origin.query().is_some()
            || origin.fragment().is_some()
            || publishable_key.trim().len() < 20
            || publishable_key.len() > 4096
        {
            return Err(AuthError::Configuration);
        }
        Ok(Self {
            origin,
            publishable_key: publishable_key.trim().to_string(),
        })
    }

    pub fn compiled() -> Option<Self> {
        let origin = option_env!("STUDENT_CENTER_SUPABASE_URL")?;
        let key = option_env!("STUDENT_CENTER_SUPABASE_PUBLISHABLE_KEY")?;
        Self::new(origin, key).ok()
    }

    fn endpoint(&self, path: &str) -> Result<Url> {
        self.origin.join(path).map_err(|_| AuthError::Configuration)
    }

    fn google_authorize_url(&self, code_challenge: &str, flow_id: &str) -> Result<Url> {
        let mut redirect = Url::parse(OAUTH_REDIRECT).map_err(|_| AuthError::Configuration)?;
        redirect
            .query_pairs_mut()
            .append_pair(OAUTH_FLOW_PARAMETER, flow_id);
        let mut authorize = self.endpoint("auth/v1/authorize")?;
        authorize
            .query_pairs_mut()
            .append_pair("provider", "google")
            .append_pair("redirect_to", redirect.as_str())
            .append_pair("code_challenge", code_challenge)
            .append_pair("code_challenge_method", "s256");
        Ok(authorize)
    }
}

#[derive(Clone)]
struct AuthClient {
    configuration: AuthConfiguration,
    client: Client,
}

#[derive(Deserialize)]
struct ApiUser {
    id: String,
    email: Option<String>,
}

#[derive(Deserialize)]
struct ApiSession {
    access_token: String,
    refresh_token: String,
    expires_in: i64,
    user: ApiUser,
}

#[derive(Deserialize)]
struct ApiFailure {
    message: Option<String>,
    msg: Option<String>,
    error_description: Option<String>,
    error: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct PersistedSession {
    version: u8,
    account_id: String,
    email: String,
    refresh_token: String,
}

#[derive(Clone)]
struct AccountSession {
    account_id: String,
    email: String,
    access_token: Zeroizing<String>,
    refresh_token: Zeroizing<String>,
    expires_at: Option<DateTime<Utc>>,
}

impl AccountSession {
    fn from_api(response: ApiSession) -> Result<Self> {
        Uuid::parse_str(&response.user.id).map_err(|_| AuthError::Response)?;
        let email = normalize_email(response.user.email.as_deref().ok_or(AuthError::Response)?)?;
        if response.access_token.len() < 32
            || response.access_token.len() > 16_384
            || response.refresh_token.len() < 16
            || response.refresh_token.len() > 4096
            || !(60..=86_400).contains(&response.expires_in)
        {
            return Err(AuthError::Response);
        }
        Ok(Self {
            account_id: response.user.id,
            email,
            access_token: Zeroizing::new(response.access_token),
            refresh_token: Zeroizing::new(response.refresh_token),
            expires_at: Some(Utc::now() + Duration::seconds(response.expires_in)),
        })
    }

    fn from_persisted(mut persisted: PersistedSession) -> Result<Self> {
        if persisted.version != 1
            || persisted.refresh_token.len() < 16
            || persisted.refresh_token.len() > 4096
        {
            persisted.refresh_token.zeroize();
            return Err(AuthError::Response);
        }
        Uuid::parse_str(&persisted.account_id).map_err(|_| AuthError::Response)?;
        let email = normalize_email(&persisted.email)?;
        let refresh_token = Zeroizing::new(std::mem::take(&mut persisted.refresh_token));
        Ok(Self {
            account_id: persisted.account_id,
            email,
            access_token: Zeroizing::new(String::new()),
            refresh_token,
            expires_at: None,
        })
    }

    fn access_ready(&self) -> bool {
        !self.access_token.is_empty()
            && self
                .expires_at
                .is_some_and(|expires_at| expires_at > Utc::now() + Duration::seconds(60))
    }
}

impl AuthClient {
    fn new(configuration: AuthConfiguration) -> Result<Self> {
        let client = Client::builder()
            .redirect(Policy::none())
            .connect_timeout(StdDuration::from_secs(8))
            .timeout(StdDuration::from_secs(20))
            .user_agent(concat!("StudentCenter/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| AuthError::Network(error.to_string()))?;
        Ok(Self {
            configuration,
            client,
        })
    }

    fn post_json<T: Serialize>(
        &self,
        path: &str,
        payload: &T,
    ) -> Result<reqwest::blocking::Response> {
        let response = self
            .client
            .post(self.configuration.endpoint(path)?)
            .header("apikey", &self.configuration.publishable_key)
            .bearer_auth(&self.configuration.publishable_key)
            .json(payload)
            .send()
            .map_err(|error| AuthError::Network(error.to_string()))?;
        if response.status().is_success() {
            return Ok(response);
        }
        Err(api_failure(response))
    }

    fn request_email_code(&self, email: &str) -> Result<()> {
        #[derive(Serialize)]
        struct Request<'a> {
            email: &'a str,
            create_user: bool,
        }
        self.post_json(
            "auth/v1/otp",
            &Request {
                email,
                create_user: true,
            },
        )?;
        Ok(())
    }

    fn verify_email_code(&self, email: &str, code: &str) -> Result<AccountSession> {
        #[derive(Serialize)]
        struct Request<'a> {
            email: &'a str,
            token: &'a str,
            r#type: &'static str,
        }
        let response = self.post_json(
            "auth/v1/verify",
            &Request {
                email,
                token: code,
                r#type: "email",
            },
        )?;
        parse_session(response)
    }

    fn refresh(&self, refresh_token: &str) -> Result<AccountSession> {
        #[derive(Serialize)]
        struct Request<'a> {
            refresh_token: &'a str,
        }
        let response = self.post_json(
            "auth/v1/token?grant_type=refresh_token",
            &Request { refresh_token },
        )?;
        parse_session(response)
    }

    fn exchange_pkce(&self, auth_code: &str, code_verifier: &str) -> Result<AccountSession> {
        #[derive(Serialize)]
        struct Request<'a> {
            auth_code: &'a str,
            code_verifier: &'a str,
        }
        let response = self.post_json(
            "auth/v1/token?grant_type=pkce",
            &Request {
                auth_code,
                code_verifier,
            },
        )?;
        parse_session(response)
    }

    fn revoke_local(&self, access_token: &str) {
        let Ok(endpoint) = self.configuration.endpoint("auth/v1/logout?scope=local") else {
            return;
        };
        let _ = self
            .client
            .post(endpoint)
            .header("apikey", &self.configuration.publishable_key)
            .bearer_auth(access_token)
            .send();
    }
}

fn parse_session(response: reqwest::blocking::Response) -> Result<AccountSession> {
    let text = Zeroizing::new(response.text().map_err(|_| AuthError::Response)?);
    if text.len() > 32_768 {
        return Err(AuthError::Response);
    }
    let parsed: ApiSession = serde_json::from_str(&text).map_err(|_| AuthError::Response)?;
    AccountSession::from_api(parsed)
}

fn api_failure(response: reqwest::blocking::Response) -> AuthError {
    let status = response.status();
    let text = Zeroizing::new(response.text().unwrap_or_default());
    let parsed = serde_json::from_str::<ApiFailure>(&text).ok();
    let message = parsed
        .and_then(|failure| {
            failure
                .message
                .or(failure.msg)
                .or(failure.error_description)
                .or(failure.error)
        })
        .unwrap_or_else(|| match status {
            StatusCode::TOO_MANY_REQUESTS => {
                "Too many attempts. Please wait before trying again.".into()
            }
            StatusCode::BAD_REQUEST | StatusCode::UNAUTHORIZED => {
                "The email or code was not accepted.".into()
            }
            _ => "The account service could not complete the request.".into(),
        });
    let safe = message
        .chars()
        .filter(|character| !character.is_control())
        .take(240)
        .collect::<String>();
    AuthError::Api(safe)
}

fn session_entry() -> Result<keyring::Entry> {
    Ok(keyring::Entry::new(CREDENTIAL_SERVICE, SESSION_CREDENTIAL)?)
}

fn persist_session(session: &AccountSession) -> Result<()> {
    let persisted = PersistedSession {
        version: 1,
        account_id: session.account_id.clone(),
        email: session.email.clone(),
        refresh_token: session.refresh_token.to_string(),
    };
    let serialized =
        Zeroizing::new(serde_json::to_string(&persisted).map_err(|_| AuthError::Response)?);
    session_entry()?.set_password(&serialized)?;
    Ok(())
}

fn load_session() -> Result<Option<AccountSession>> {
    let entry = session_entry()?;
    let serialized = match entry.get_password() {
        Ok(value) => Zeroizing::new(value),
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if serialized.len() > 8192 {
        return Err(AuthError::Response);
    }
    let persisted: PersistedSession =
        serde_json::from_str(&serialized).map_err(|_| AuthError::Response)?;
    AccountSession::from_persisted(persisted).map(Some)
}

fn delete_session() -> Result<()> {
    match session_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub fn normalize_email(value: &str) -> Result<String> {
    let email = value.trim();
    if email.len() < 3
        || email.len() > 254
        || email
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
        || email.matches('@').count() != 1
    {
        return Err(AuthError::Invalid("Enter a valid email address".into()));
    }
    let (local, domain) = email
        .split_once('@')
        .ok_or_else(|| AuthError::Invalid("Enter a valid email address".into()))?;
    if local.is_empty()
        || local.len() > 64
        || !domain.contains('.')
        || domain.starts_with('.')
        || domain.ends_with('.')
        || domain
            .split('.')
            .any(|label| label.is_empty() || label.starts_with('-') || label.ends_with('-'))
    {
        return Err(AuthError::Invalid("Enter a valid email address".into()));
    }
    Ok(format!("{}@{}", local, domain.to_ascii_lowercase()))
}

fn validate_code(value: &str) -> Result<&str> {
    let code = value.trim();
    if code.len() != 6 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(AuthError::Invalid("Enter the 6-digit email code".into()));
    }
    Ok(code)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub configured: bool,
    pub signed_in: bool,
    pub email: Option<String>,
    pub account_id: Option<String>,
    pub access_ready: bool,
    pub credential_available: bool,
    pub google_sign_in_pending: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailCodeStatus {
    pub email: String,
    pub retry_after_seconds: u64,
    pub message: String,
}

#[derive(Debug)]
pub struct GoogleAuthStart {
    pub authorize_url: Url,
    pub status: AccountStatus,
}

struct PendingGoogleFlow {
    verifier: Zeroizing<String>,
    flow_id: String,
    started_at: DateTime<Utc>,
}

enum GoogleCallback {
    Code(String),
    Error(String),
}

pub struct AccountRuntime {
    client: Option<AuthClient>,
    session: Option<AccountSession>,
    pending_email: Option<(String, DateTime<Utc>)>,
    pending_google: Option<PendingGoogleFlow>,
    credential_available: bool,
    last_message: Option<String>,
}

impl AccountRuntime {
    pub fn load() -> Self {
        let client = AuthConfiguration::compiled()
            .and_then(|configuration| AuthClient::new(configuration).ok());
        let (session, credential_available) = match load_session() {
            Ok(session) => (session, true),
            Err(AuthError::Response) => {
                let _ = delete_session();
                (None, true)
            }
            Err(_) => (None, false),
        };
        Self {
            client,
            session,
            pending_email: None,
            pending_google: None,
            credential_available,
            last_message: None,
        }
    }

    #[cfg(test)]
    pub fn test_unconfigured() -> Self {
        Self {
            client: None,
            session: None,
            pending_email: None,
            pending_google: None,
            credential_available: true,
            last_message: None,
        }
    }

    pub fn status(&self) -> AccountStatus {
        let configured = self.client.is_some();
        let signed_in = self.session.is_some();
        AccountStatus {
            configured,
            signed_in,
            email: self.session.as_ref().map(|session| session.email.clone()),
            account_id: self
                .session
                .as_ref()
                .map(|session| session.account_id.clone()),
            access_ready: self
                .session
                .as_ref()
                .is_some_and(AccountSession::access_ready),
            credential_available: self.credential_available,
            google_sign_in_pending: self.google_flow_is_current(),
            message: if let Some(message) = &self.last_message {
                message.clone()
            } else if !self.credential_available {
                "The operating-system credential vault is unavailable; account sessions are disabled.".into()
            } else if !configured {
                "This development build has no optional account service configured.".into()
            } else if signed_in {
                "Optional encrypted backup and sync can be enabled from this account.".into()
            } else {
                "Sign in only if you want encrypted backup or sync. AI uses your own provider connection and does not require a Coqui account.".into()
            },
        }
    }

    pub fn account_id(&self) -> Option<String> {
        self.session
            .as_ref()
            .map(|session| session.account_id.clone())
    }

    pub fn access_token(&mut self) -> Result<Zeroizing<String>> {
        let needs_refresh = self
            .session
            .as_ref()
            .ok_or_else(|| AuthError::Invalid("Sign in before using encrypted sync".into()))?
            .access_ready()
            == false;
        if needs_refresh {
            let refresh_token = self
                .session
                .as_ref()
                .ok_or(AuthError::Response)?
                .refresh_token
                .clone();
            let session = self.client()?.refresh(&refresh_token)?;
            persist_session(&session)?;
            self.session = Some(session);
        }
        self.session
            .as_ref()
            .filter(|session| session.access_ready())
            .map(|session| session.access_token.clone())
            .ok_or(AuthError::Response)
    }

    fn client(&self) -> Result<AuthClient> {
        if !self.credential_available {
            return Err(AuthError::Invalid(
                "The operating-system credential vault is unavailable".into(),
            ));
        }
        self.client.clone().ok_or(AuthError::Invalid(
            "This build has no account service configured".into(),
        ))
    }

    pub fn request_email_code(&mut self, value: &str) -> Result<EmailCodeStatus> {
        let email = normalize_email(value)?;
        if let Some((pending, requested_at)) = &self.pending_email {
            let elapsed = Utc::now()
                .signed_duration_since(*requested_at)
                .num_seconds()
                .max(0) as u64;
            if pending == &email && elapsed < 60 {
                return Err(AuthError::Invalid(format!(
                    "Wait {} seconds before requesting another code",
                    60 - elapsed
                )));
            }
        }
        self.client()?.request_email_code(&email)?;
        self.pending_email = Some((email.clone(), Utc::now()));
        self.pending_google = None;
        self.last_message = None;
        Ok(EmailCodeStatus {
            email,
            retry_after_seconds: 60,
            message: "Enter the 6-digit code from your email. The code is never stored.".into(),
        })
    }

    pub fn verify_email_code(&mut self, value: &str, code: &str) -> Result<AccountStatus> {
        let email = normalize_email(value)?;
        let code = validate_code(code)?;
        let Some((pending_email, requested_at)) = &self.pending_email else {
            return Err(AuthError::Invalid("Request a new email code first".into()));
        };
        if pending_email != &email
            || Utc::now().signed_duration_since(*requested_at) > Duration::hours(24)
        {
            return Err(AuthError::Invalid(
                "Request a new code for this email address".into(),
            ));
        }
        let session = self.client()?.verify_email_code(&email, code)?;
        if session.email != email {
            return Err(AuthError::Response);
        }
        persist_session(&session)?;
        self.session = Some(session);
        self.pending_email = None;
        self.pending_google = None;
        self.last_message = None;
        Ok(self.status())
    }

    pub fn begin_google_sign_in(&mut self) -> Result<GoogleAuthStart> {
        if self.session.is_some() {
            return Err(AuthError::Invalid(
                "Sign out before using a different Google account".into(),
            ));
        }
        let client = self.client()?;
        let verifier = generate_url_safe_secret(32);
        let flow_id = generate_url_safe_secret(16);
        let challenge = pkce_challenge(&verifier);
        let authorize_url = client
            .configuration
            .google_authorize_url(&challenge, &flow_id)?;
        self.pending_google = Some(PendingGoogleFlow {
            verifier: Zeroizing::new(verifier),
            flow_id,
            started_at: Utc::now(),
        });
        self.pending_email = None;
        self.last_message = Some(
            "Finish Google sign-in in the system browser. Student Center will return here automatically."
                .into(),
        );
        Ok(GoogleAuthStart {
            authorize_url,
            status: self.status(),
        })
    }

    pub fn cancel_google_sign_in(&mut self, message: &str) -> AccountStatus {
        self.pending_google = None;
        self.last_message = Some(message.to_string());
        self.status()
    }

    pub fn complete_google_sign_in(&mut self, raw: &str) -> Result<AccountStatus> {
        let Some(pending) = self.pending_google.as_ref() else {
            return Err(AuthError::Invalid(
                "Start Google sign-in from Student Center before opening this callback".into(),
            ));
        };
        if !google_flow_is_current(pending.started_at) {
            self.pending_google = None;
            self.last_message = Some("Google sign-in expired. Please try again.".into());
            return Err(AuthError::Invalid(
                "Google sign-in expired. Please try again".into(),
            ));
        }
        let callback = parse_google_callback(raw, &pending.flow_id)?;
        let pending = self.pending_google.take().ok_or(AuthError::Response)?;
        match callback {
            GoogleCallback::Error(message) => {
                self.last_message = Some(message.clone());
                Err(AuthError::Api(message))
            }
            GoogleCallback::Code(code) => {
                let session = match self.client()?.exchange_pkce(&code, &pending.verifier) {
                    Ok(session) => session,
                    Err(error) => {
                        self.last_message =
                            Some("Google sign-in could not be completed. Please try again.".into());
                        return Err(error);
                    }
                };
                persist_session(&session)?;
                self.session = Some(session);
                self.last_message = None;
                Ok(self.status())
            }
        }
    }

    fn google_flow_is_current(&self) -> bool {
        self.pending_google
            .as_ref()
            .is_some_and(|pending| google_flow_is_current(pending.started_at))
    }

    pub fn refresh(&mut self) -> Result<AccountStatus> {
        let refresh_token = self
            .session
            .as_ref()
            .ok_or_else(|| {
                AuthError::Invalid("Sign in before refreshing the account session".into())
            })?
            .refresh_token
            .clone();
        let session = self.client()?.refresh(&refresh_token)?;
        persist_session(&session)?;
        self.session = Some(session);
        self.last_message = None;
        Ok(self.status())
    }

    pub fn sign_out(&mut self) -> Result<AccountStatus> {
        if let (Some(client), Some(session)) = (&self.client, &self.session) {
            if session.access_ready() {
                client.revoke_local(&session.access_token);
            }
        }
        delete_session()?;
        self.session = None;
        self.pending_email = None;
        self.pending_google = None;
        self.credential_available = true;
        self.last_message = None;
        Ok(self.status())
    }
}

fn generate_url_safe_secret(bytes: usize) -> String {
    let mut random = vec![0_u8; bytes];
    OsRng.fill_bytes(&mut random);
    URL_SAFE_NO_PAD.encode(random)
}

fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn google_flow_is_current(started_at: DateTime<Utc>) -> bool {
    let elapsed = Utc::now().signed_duration_since(started_at);
    elapsed >= Duration::zero() && elapsed <= Duration::minutes(OAUTH_FLOW_LIFETIME_MINUTES)
}

pub fn is_google_callback_url(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw) else {
        return false;
    };
    url.scheme() == "studentcenter"
        && url.host_str() == Some("auth")
        && url.path() == "/callback"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.fragment().is_none()
}

fn parse_google_callback(raw: &str, expected_flow_id: &str) -> Result<GoogleCallback> {
    if !is_google_callback_url(raw) {
        return Err(AuthError::Invalid("Invalid Google sign-in callback".into()));
    }
    let url = Url::parse(raw)
        .map_err(|_| AuthError::Invalid("Invalid Google sign-in callback".into()))?;
    let mut code = None;
    let mut flow_id = None;
    let mut error = None;
    let mut error_code = None;
    let mut error_description = None;
    for (key, value) in url.query_pairs() {
        let slot = match key.as_ref() {
            "code" => &mut code,
            OAUTH_FLOW_PARAMETER => &mut flow_id,
            "error" => &mut error,
            "error_code" => &mut error_code,
            "error_description" => &mut error_description,
            _ => return Err(AuthError::Invalid("Invalid Google sign-in callback".into())),
        };
        if slot.replace(value.into_owned()).is_some() {
            return Err(AuthError::Invalid("Invalid Google sign-in callback".into()));
        }
    }
    if flow_id.as_deref() != Some(expected_flow_id) {
        return Err(AuthError::Invalid(
            "Google sign-in callback did not match this request".into(),
        ));
    }
    if let Some(code) = code {
        if error.is_some()
            || error_code.is_some()
            || error_description.is_some()
            || !(16..=1024).contains(&code.len())
            || !code.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~')
            })
        {
            return Err(AuthError::Invalid("Invalid Google sign-in callback".into()));
        }
        return Ok(GoogleCallback::Code(code));
    }
    let Some(error) = error else {
        return Err(AuthError::Invalid("Invalid Google sign-in callback".into()));
    };
    if error.is_empty()
        || error.len() > 128
        || !error
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        || error_code.as_ref().is_some_and(|value| {
            value.is_empty()
                || value.len() > 128
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        })
    {
        return Err(AuthError::Invalid("Invalid Google sign-in callback".into()));
    }
    let description = error_description
        .map(|value| safe_message(&value))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Google sign-in was canceled or could not be completed.".into());
    Ok(GoogleCallback::Error(description))
}

fn safe_message(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(240)
        .collect::<String>()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configuration_is_compile_time_and_https_only() {
        assert!(AuthConfiguration::new("http://project.supabase.co/", &"k".repeat(32)).is_err());
        assert!(
            AuthConfiguration::new("https://project.supabase.co/auth/v1", &"k".repeat(32)).is_err()
        );
        assert!(
            AuthConfiguration::new("https://user:pass@project.supabase.co/", &"k".repeat(32))
                .is_err()
        );
        assert!(AuthConfiguration::new("https://project.supabase.co/", &"k".repeat(32)).is_ok());
    }

    #[test]
    fn email_and_code_validation_are_strict() {
        assert_eq!(
            normalize_email(" Student@College.EDU ").unwrap(),
            "Student@college.edu"
        );
        for invalid in [
            "student",
            "@college.edu",
            "student@localhost",
            "student @college.edu",
        ] {
            assert!(normalize_email(invalid).is_err());
        }
        assert_eq!(validate_code(" 123456 ").unwrap(), "123456");
        assert!(validate_code("12345a").is_err());
    }

    #[test]
    fn account_status_never_serializes_tokens() {
        let status = AccountRuntime::test_unconfigured().status();
        let serialized = serde_json::to_string(&status).unwrap();
        assert!(!serialized.contains("access_token"));
        assert!(!serialized.contains("refresh_token"));
        assert!(!serialized.contains("accessToken"));
        assert!(!serialized.contains("refreshToken"));
        assert!(!serialized.contains("verifier"));
        assert!(!serialized.contains("authorize_url"));
    }

    #[test]
    fn pkce_challenge_matches_the_rfc_7636_vector() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn google_authorize_url_uses_supabase_pkce_contract() {
        let configuration =
            AuthConfiguration::new("https://project.supabase.co/", &"k".repeat(32)).unwrap();
        let url = configuration
            .google_authorize_url("challenge", "flow_12345678")
            .unwrap();
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("project.supabase.co"));
        assert_eq!(url.path(), "/auth/v1/authorize");
        let query = url
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(
            query.get("provider").map(|value| value.as_ref()),
            Some("google")
        );
        assert_eq!(
            query.get("redirect_to").map(|value| value.as_ref()),
            Some("studentcenter://auth/callback?sb_flow_id=flow_12345678")
        );
        assert_eq!(
            query.get("code_challenge").map(|value| value.as_ref()),
            Some("challenge")
        );
        assert_eq!(
            query
                .get("code_challenge_method")
                .map(|value| value.as_ref()),
            Some("s256")
        );
    }

    #[test]
    fn google_callback_is_exactly_allowlisted_and_correlated() {
        let accepted = parse_google_callback(
            "studentcenter://auth/callback?code=12345678-1234-1234-1234-123456789012&sb_flow_id=flow_12345678",
            "flow_12345678",
        );
        assert!(matches!(accepted, Ok(GoogleCallback::Code(_))));

        for rejected in [
            "https://auth/callback?code=12345678-1234-1234-1234-123456789012&sb_flow_id=flow_12345678",
            "studentcenter://other/callback?code=12345678-1234-1234-1234-123456789012&sb_flow_id=flow_12345678",
            "studentcenter://auth/callback/extra?code=12345678-1234-1234-1234-123456789012&sb_flow_id=flow_12345678",
            "studentcenter://auth/callback?code=12345678-1234-1234-1234-123456789012&sb_flow_id=wrong_12345678",
            "studentcenter://auth/callback?code=12345678-1234-1234-1234-123456789012&sb_flow_id=flow_12345678#token=secret",
            "studentcenter://auth/callback?code=12345678-1234-1234-1234-123456789012&code=duplicate-code&sb_flow_id=flow_12345678",
            "studentcenter://auth/callback?code=12345678-1234-1234-1234-123456789012%2Finjected&sb_flow_id=flow_12345678",
            "studentcenter://auth/callback?code=12345678-1234-1234-1234-123456789012&sb_flow_id=flow_12345678&redirect=https%3A%2F%2Fevil.example",
        ] {
            assert!(
                parse_google_callback(rejected, "flow_12345678").is_err(),
                "{rejected}"
            );
        }
    }

    #[test]
    fn google_callback_errors_are_safe_and_flow_expiry_is_bounded() {
        let callback = parse_google_callback(
            "studentcenter://auth/callback?error=access_denied&error_description=The+student+canceled&sb_flow_id=flow_12345678",
            "flow_12345678",
        );
        assert!(
            matches!(callback, Ok(GoogleCallback::Error(message)) if message == "The student canceled")
        );
        assert!(google_flow_is_current(Utc::now() - Duration::minutes(4)));
        assert!(!google_flow_is_current(Utc::now() - Duration::minutes(6)));
    }
}
