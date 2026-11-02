//! Direct Sign in with ChatGPT. Tokens and PKCE never cross the native boundary.
use crate::managed_ai::ManagedAiError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
use rand::{rngs::OsRng, RngCore};
use reqwest::{
    blocking::{Client, Response},
    redirect::Policy,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use url::Url;
use zeroize::{Zeroize, Zeroizing};

type Result<T> = std::result::Result<T, ManagedAiError>;
const ISSUER: &str = "https://auth.openai.com";
const RESOURCE: &str = "https://api.openai.com/v1";
const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const MAX_JSON: u64 = 512 * 1024;
const MAX_STREAM: u64 = 4 * 1024 * 1024;
static VAULT_LOCK: Mutex<()> = Mutex::new(());
static LOGIN: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

fn error(message: &str) -> ManagedAiError {
    ManagedAiError::Chatgpt(message.into())
}
fn now() -> i64 {
    chrono::Utc::now().timestamp()
}
fn random() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn client() -> Result<Client> {
    Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(60))
        .user_agent(concat!("CoquiStudentCenter/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| ManagedAiError::Network)
}
fn network(e: reqwest::Error) -> ManagedAiError {
    if e.is_timeout() {
        ManagedAiError::Timeout
    } else {
        ManagedAiError::Network
    }
}
fn read_json(response: Response) -> Result<Value> {
    if !response.status().is_success() {
        return Err(http_error(response.status().as_u16()));
    }
    let mut body = Zeroizing::new(Vec::new());
    response
        .take(MAX_JSON + 1)
        .read_to_end(&mut body)
        .map_err(|_| ManagedAiError::Network)?;
    if body.len() as u64 > MAX_JSON {
        return Err(ManagedAiError::InvalidResponse);
    }
    serde_json::from_slice(&body).map_err(|_| ManagedAiError::InvalidResponse)
}
fn http_error(status: u16) -> ManagedAiError {
    match status {
    401 => error("ChatGPT sign-in expired or was revoked. Reconnect ChatGPT in Settings."),
    403 => error("ChatGPT plan access was denied for this account or workspace. Check its permissions in ChatGPT Settings."),
    429 => error("ChatGPT usage limit reached. Review ChatGPT Settings → Usage, then try again when usage is available."),
    503 => error("ChatGPT subscription access is temporarily unavailable. Try again later."),
    _ => ManagedAiError::Rejected(status),
}
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub name: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub label: String,
}
#[derive(Default, Serialize, Deserialize)]
struct Store {
    host_id: String,
    active: Option<String>,
    accounts: Vec<Registration>,
}
#[derive(Serialize, Deserialize)]
struct Registration {
    client_id: String,
    subject: String,
    email: Option<String>,
    access_token: String,
    refresh_token: String,
    id_token: String,
    expires_at: i64,
    scopes: Vec<String>,
    models: Vec<Model>,
}
impl Drop for Registration {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.refresh_token.zeroize();
        self.id_token.zeroize();
    }
}
impl Registration {
    fn enabled(&self) -> bool {
        !self.access_token.is_empty()
            && self.scopes.iter().any(|s| s == "chatgpt.tokens.use.direct")
    }
    fn clear_tokens(&mut self) {
        self.access_token.zeroize();
        self.refresh_token.zeroize();
        self.id_token.zeroize();
        self.expires_at = 0;
        self.models.clear();
    }
}
fn entry() -> Result<keyring::Entry> {
    keyring::Entry::new("Coqui Student Center ChatGPT", "registrations")
        .map_err(|_| ManagedAiError::Credential)
}
// Windows Credential Manager limits a credential blob to 2560 bytes. Publish
// a generation only after every small vault entry has passed readback.
#[derive(Serialize, Deserialize)]
struct VaultGeneration {
    id: String,
    parts: usize,
}
fn part_entry(generation: &VaultGeneration, index: usize) -> Result<keyring::Entry> {
    keyring::Entry::new(
        "Coqui Student Center ChatGPT",
        &format!("registrations-{}-{index}", generation.id),
    )
    .map_err(|_| ManagedAiError::Credential)
}
fn generation() -> Result<Option<VaultGeneration>> {
    match entry()?.get_password() {
        Ok(raw) => {
            let generation: VaultGeneration =
                serde_json::from_str(&raw).map_err(|_| ManagedAiError::Credential)?;
            if uuid::Uuid::parse_str(&generation.id).is_err()
                || !(1..=300).contains(&generation.parts)
            {
                return Err(ManagedAiError::Credential);
            }
            Ok(Some(generation))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(ManagedAiError::Credential),
    }
}
fn read_store() -> Result<Store> {
    let Some(generation) = generation()? else {
        return Ok(Store::default());
    };
    let mut raw = Zeroizing::new(Vec::new());
    for index in 0..generation.parts {
        let part = Zeroizing::new(
            part_entry(&generation, index)?
                .get_secret()
                .map_err(|_| ManagedAiError::Credential)?,
        );
        if part.len() > 1800 {
            return Err(ManagedAiError::Credential);
        }
        raw.extend_from_slice(&part);
    }
    serde_json::from_slice(&raw).map_err(|_| ManagedAiError::Credential)
}
fn write_store(store: &Store) -> Result<()> {
    let raw = Zeroizing::new(serde_json::to_vec(store).map_err(|_| ManagedAiError::Credential)?);
    let next = VaultGeneration {
        id: uuid::Uuid::new_v4().to_string(),
        parts: raw.len().div_ceil(1800),
    };
    if next.parts > 300 {
        return Err(error(
            "Too many saved ChatGPT accounts. Disconnect unused accounts before adding another.",
        ));
    }
    let previous = generation()?;
    let prepared = (|| {
        for (index, part) in raw.chunks(1800).enumerate() {
            part_entry(&next, index)?
                .set_secret(part)
                .map_err(|_| ManagedAiError::Credential)?;
            let saved = Zeroizing::new(
                part_entry(&next, index)?
                    .get_secret()
                    .map_err(|_| ManagedAiError::Credential)?,
            );
            if saved.as_slice() != part {
                return Err(ManagedAiError::Credential);
            }
        }
        Ok(())
    })();
    if let Err(e) = prepared {
        for index in 0..next.parts {
            if let Ok(entry) = part_entry(&next, index) {
                let _ = entry.delete_credential();
            }
        }
        return Err(e);
    }
    entry()?
        .set_password(&serde_json::to_string(&next).map_err(|_| ManagedAiError::Credential)?)
        .map_err(|_| ManagedAiError::Credential)?;
    if generation()?.is_none_or(|saved| saved.id != next.id || saved.parts != next.parts) {
        return Err(ManagedAiError::Credential);
    }
    if let Some(previous) = previous {
        for index in 0..previous.parts {
            if let Ok(entry) = part_entry(&previous, index) {
                let _ = entry.delete_credential();
            }
        }
    }
    Ok(())
}
pub fn accounts() -> Result<(Vec<Account>, Option<String>, Vec<Model>, Option<String>)> {
    let _guard = VAULT_LOCK.lock().unwrap();
    let store = read_store()?;
    let active = store
        .accounts
        .iter()
        .find(|a| Some(&a.client_id) == store.active.as_ref());
    let label = |a: &Registration| {
        format!(
            "{} · {}",
            a.email.as_deref().unwrap_or("ChatGPT account"),
            a.client_id
                .chars()
                .rev()
                .take(6)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        )
    };
    Ok((
        store
            .accounts
            .iter()
            .map(|a| Account {
                id: a.client_id.clone(),
                label: label(a),
            })
            .collect(),
        store.active.clone(),
        active.map(|a| a.models.clone()).unwrap_or_default(),
        active.map(label),
    ))
}
/// A registration reference, never a bearer token, is passed through AI routing.
pub fn credential() -> Result<Option<Zeroizing<String>>> {
    let _guard = VAULT_LOCK.lock().unwrap();
    let store = read_store()?;
    Ok(store
        .accounts
        .iter()
        .find(|a| Some(&a.client_id) == store.active.as_ref() && a.enabled())
        .map(|a| Zeroizing::new(a.client_id.clone())))
}

#[derive(Deserialize)]
struct Discovery {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
    revocation_endpoint: String,
}
fn discovery(client: &Client) -> Result<Discovery> {
    let d: Discovery = serde_json::from_value(read_json(
        client
            .get(format!("{ISSUER}/.well-known/openid-configuration"))
            .send()
            .map_err(network)?,
    )?)
    .map_err(|_| ManagedAiError::InvalidResponse)?;
    if d.issuer != ISSUER
        || [
            &d.authorization_endpoint,
            &d.token_endpoint,
            &d.jwks_uri,
            &d.revocation_endpoint,
        ]
        .iter()
        .any(|s| {
            Url::parse(s)
                .map(|u| {
                    u.scheme() != "https"
                        || u.host_str() != Some("auth.openai.com")
                        || u.port().is_some()
                        || !u.username().is_empty()
                        || u.password().is_some()
                })
                .unwrap_or(true)
        })
    {
        return Err(error(
            "ChatGPT sign-in configuration could not be verified. Try again later.",
        ));
    }
    Ok(d)
}
struct Attempt {
    state: String,
    nonce: String,
    verifier: Zeroizing<String>,
    redirect: String,
    client_id: Option<String>,
}
impl Attempt {
    fn new(redirect: String, client_id: Option<String>) -> Self {
        Self {
            state: random(),
            nonce: random(),
            verifier: Zeroizing::new(random()),
            redirect,
            client_id,
        }
    }
    fn authorize(
        &self,
        endpoint: &str,
        host_id: &str,
        previous: Option<&Registration>,
    ) -> Result<Url> {
        let mut url = Url::parse(endpoint).map_err(|_| ManagedAiError::InvalidResponse)?;
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(self.verifier.as_bytes()));
        {
            let mut q = url.query_pairs_mut();
            q.extend_pairs([
                (
                    "client_id",
                    self.client_id.as_deref().unwrap_or("dynamic_agent_client"),
                ),
                ("ext_agent_host_id", host_id),
                ("response_type", "code"),
                ("redirect_uri", &self.redirect),
                ("scope", SCOPES),
                ("resource", RESOURCE),
                ("state", &self.state),
                ("nonce", &self.nonce),
                ("code_challenge_method", "S256"),
                ("code_challenge", &challenge),
            ]);
            if self.client_id.is_none() {
                q.append_pair("agent_name_hint", "Coqui Student Center");
            }
            if let Some(a) = previous {
                if !a.id_token.is_empty() {
                    q.append_pair("id_token_hint", &a.id_token);
                }
                if let Some(email) = &a.email {
                    q.append_pair("login_hint", email);
                }
                if !a.scopes.iter().any(|s| s == "chatgpt.tokens.use.direct")
                    && !a.scopes.is_empty()
                {
                    q.append_pair("prompt", "consent");
                }
            }
        }
        Ok(url)
    }
    fn callback(&self, target: &str) -> Result<(Zeroizing<String>, String)> {
        let url = Url::parse(&format!("http://127.0.0.1{target}"))
            .map_err(|_| error("ChatGPT callback is invalid. Start sign-in again."))?;
        let pairs: Vec<_> = url.query_pairs().collect();
        let one = |name: &str| -> Result<Option<String>> {
            let values: Vec<_> = pairs.iter().filter(|(k, _)| k == name).collect();
            if values.len() > 1 {
                return Err(error("ChatGPT callback is invalid. Start sign-in again."));
            }
            Ok(values.first().map(|(_, v)| v.to_string()))
        };
        if url.path() != "/auth/callback" || one("state")?.as_deref() != Some(&self.state) {
            return Err(error(
                "ChatGPT sign-in could not be verified. Start sign-in again.",
            ));
        }
        if one("error")?.is_some() {
            return Err(error(
                "ChatGPT sign-in was declined. Continue with ChatGPT again to grant access.",
            ));
        }
        let client_id = match (&self.client_id, one("client_id")?) {
            (Some(expected), Some(actual)) if *expected != actual => {
                return Err(error(
                    "ChatGPT returned a different account registration. Start sign-in again.",
                ))
            }
            (Some(expected), _) => expected.clone(),
            (None, Some(actual)) if actual.starts_with("oaiapp_") && actual.len() <= 200 => actual,
            _ => {
                return Err(error(
                    "ChatGPT registration is incomplete. Start sign-in again.",
                ))
            }
        };
        let code = one("code")?
            .filter(|s| !s.is_empty() && s.len() <= 8192)
            .ok_or_else(|| error("ChatGPT sign-in did not return a code. Start sign-in again."))?;
        Ok((Zeroizing::new(code), client_id))
    }
}

#[derive(Deserialize)]
struct Identity {
    sub: String,
    email: Option<String>,
    nonce: Option<String>,
}
fn verify_identity(token: &str, client_id: &str, nonce: &str, jwks: &JwkSet) -> Result<Identity> {
    let invalid = || error("ChatGPT identity could not be verified. Start sign-in again.");
    let header = decode_header(token).map_err(|_| invalid())?;
    if !matches!(header.alg, Algorithm::RS256 | Algorithm::ES256) {
        return Err(invalid());
    }
    let jwk = header
        .kid
        .as_ref()
        .and_then(|id| jwks.find(id))
        .ok_or_else(invalid)?;
    let key = DecodingKey::from_jwk(jwk).map_err(|_| invalid())?;
    let mut validation = Validation::new(header.alg);
    validation.set_issuer(&[ISSUER]);
    validation.set_audience(&[client_id]);
    validation.set_required_spec_claims(&["exp", "iat", "iss", "aud", "sub"]);
    validation.leeway = 5;
    let identity = decode::<Identity>(token, &key, &validation)
        .map_err(|_| invalid())?
        .claims;
    if identity.sub.is_empty() || identity.nonce.as_deref() != Some(nonce) {
        return Err(invalid());
    }
    Ok(identity)
}
#[derive(Deserialize)]
struct Tokens {
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    token_type: String,
    expires_in: i64,
    scope: Option<String>,
}
impl Drop for Tokens {
    fn drop(&mut self) {
        self.access_token.zeroize();
        if let Some(v) = &mut self.refresh_token {
            v.zeroize();
        }
        if let Some(v) = &mut self.id_token {
            v.zeroize();
        }
    }
}
fn tokens(response: Response) -> Result<Tokens> {
    let value: Tokens = serde_json::from_value(read_json(response)?)
        .map_err(|_| ManagedAiError::InvalidResponse)?;
    if !value.token_type.eq_ignore_ascii_case("bearer")
        || !(20..=16384).contains(&value.access_token.len())
        || value.expires_in <= 0
        || value.expires_in > 31_536_000
    {
        return Err(ManagedAiError::InvalidResponse);
    }
    Ok(value)
}
fn fetch_models(client: &Client, token: &str) -> Result<Vec<Model>> {
    let value = read_json(
        client
            .get(format!("{RESOURCE}/models"))
            .bearer_auth(token)
            .send()
            .map_err(network)?,
    )?;
    let models = value
        .get("models")
        .and_then(Value::as_array)
        .ok_or(ManagedAiError::InvalidResponse)?;
    Ok(models
        .iter()
        .filter(|m| m["visibility"] == "list")
        .filter_map(|m| {
            Some(Model {
                id: m["slug"].as_str()?.into(),
                name: m["display_name"].as_str()?.into(),
            })
        })
        .filter(|m| !m.id.is_empty() && m.id.len() <= 200)
        .take(200)
        .collect())
}

struct LoginGuard(Arc<AtomicBool>);
impl Drop for LoginGuard {
    fn drop(&mut self) {
        let mut pending = LOGIN.lock().unwrap();
        if pending.as_ref().is_some_and(|p| Arc::ptr_eq(p, &self.0)) {
            *pending = None;
        }
    }
}
pub fn cancel_login() {
    if let Some(cancel) = LOGIN.lock().unwrap().as_ref() {
        cancel.store(true, Ordering::Release);
    }
}
/// Profile deletion also removes credentials for inactive saved accounts.
pub fn forget_all() -> Result<()> {
    cancel_login();
    let _guard = VAULT_LOCK.lock().unwrap();
    if let Some(saved) = generation()? {
        for index in 0..saved.parts {
            part_entry(&saved, index)?.delete_credential().map_err(|_| ManagedAiError::Credential)?;
        }
        entry()?.delete_credential().map_err(|_| ManagedAiError::Credential)?;
    }
    Ok(())
}
pub fn connect(
    account_id: Option<String>,
    open: impl FnOnce(&str) -> Result<()>,
    unlocked: impl Fn() -> bool,
) -> Result<Option<String>> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut pending = LOGIN.lock().unwrap();
        if pending.is_some() {
            return Err(error(
                "ChatGPT sign-in is already open. Finish or cancel it first.",
            ));
        }
        *pending = Some(cancel.clone());
    }
    let _login = LoginGuard(cancel.clone());
    let store = {
        let _guard = VAULT_LOCK.lock().unwrap();
        let mut store = read_store()?;
        if store.host_id.is_empty() {
            store.host_id = format!("urn:uuid:{}", uuid::Uuid::new_v4());
            write_store(&store)?;
        }
        store
    };
    let previous = account_id
        .as_ref()
        .map(|id| {
            store
                .accounts
                .iter()
                .find(|a| &a.client_id == id)
                .ok_or_else(|| error("Choose a saved ChatGPT account or add a new one."))
        })
        .transpose()?;
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|_| error("Coqui could not open the ChatGPT sign-in callback. Try again."))?;
    listener
        .set_nonblocking(true)
        .map_err(|_| ManagedAiError::Network)?;
    let redirect = format!(
        "http://127.0.0.1:{}/auth/callback",
        listener
            .local_addr()
            .map_err(|_| ManagedAiError::Network)?
            .port()
    );
    let attempt = Attempt::new(redirect, previous.map(|a| a.client_id.clone()));
    let client = client()?;
    let d = discovery(&client)?;
    open(
        attempt
            .authorize(&d.authorization_endpoint, &store.host_id, previous)?
            .as_str(),
    )?;
    let started = Instant::now();
    let (code, client_id) = loop {
        if cancel.load(Ordering::Acquire) || !unlocked() {
            return Err(error(
                "ChatGPT sign-in was cancelled. No connection was changed.",
            ));
        }
        if started.elapsed() > Duration::from_secs(180) {
            return Err(error(
                "ChatGPT sign-in timed out. Continue with ChatGPT to try again.",
            ));
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .map_err(|_| ManagedAiError::Network)?;
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .map_err(|_| ManagedAiError::Network)?;
                let mut line = Zeroizing::new(String::new());
                if BufReader::new((&stream).take(16385))
                    .read_line(&mut line)
                    .is_err()
                    || line.len() > 16384
                {
                    continue;
                }
                let mut parts = line.split_whitespace();
                if parts.next() != Some("GET") {
                    continue;
                }
                let target = parts.next().unwrap_or("");
                if !target.starts_with("/auth/callback?") {
                    let _ = stream.write_all(
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                    continue;
                }
                let result = attempt.callback(target);
                let body = if result.is_ok() {
                    "Sign-in received. Return to Coqui to check the connection."
                } else {
                    "Sign-in could not be verified. Return to Coqui and try again."
                };
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                break result?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100))
            }
            Err(_) => return Err(ManagedAiError::Network),
        }
    };
    let token = tokens(
        client
            .post(&d.token_endpoint)
            .form(&[
                ("grant_type", "authorization_code"),
                ("client_id", &client_id),
                ("code", code.as_str()),
                ("code_verifier", attempt.verifier.as_str()),
                ("redirect_uri", &attempt.redirect),
                ("resource", RESOURCE),
            ])
            .send()
            .map_err(network)?,
    )?;
    let jwks: JwkSet =
        serde_json::from_value(read_json(client.get(&d.jwks_uri).send().map_err(network)?)?)
            .map_err(|_| ManagedAiError::InvalidResponse)?;
    let identity = verify_identity(
        token
            .id_token
            .as_deref()
            .ok_or(ManagedAiError::InvalidResponse)?,
        &client_id,
        &attempt.nonce,
        &jwks,
    )?;
    if previous.is_some_and(|p| p.subject != identity.sub) {
        return Err(error(
            "ChatGPT returned a different identity. Choose Add another account to connect it.",
        ));
    }
    let scopes = token
        .scope
        .as_deref()
        .unwrap_or("")
        .split_whitespace()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let enabled = scopes.iter().any(|s| s == "chatgpt.tokens.use.direct");
    let models = if enabled {
        fetch_models(&client, &token.access_token)?
    } else {
        Vec::new()
    };
    let model = models.first().map(|m| m.id.clone());
    let registration = Registration {
        client_id: client_id.clone(),
        subject: identity.sub,
        email: identity.email,
        access_token: token.access_token.clone(),
        refresh_token: token
            .refresh_token
            .clone()
            .ok_or(ManagedAiError::InvalidResponse)?,
        id_token: token.id_token.clone().unwrap_or_default(),
        expires_at: now() + token.expires_in,
        scopes,
        models,
    };
    let _guard = VAULT_LOCK.lock().unwrap();
    if cancel.load(Ordering::Acquire) || !unlocked() {
        return Err(error(
            "ChatGPT sign-in was cancelled. No connection was changed.",
        ));
    }
    let mut current = read_store()?;
    if let Some(slot) = current
        .accounts
        .iter_mut()
        .find(|a| a.client_id == client_id)
    {
        *slot = registration;
    } else {
        current.accounts.push(registration);
    }
    current.active = Some(client_id);
    write_store(&current)?;
    Ok(model)
}

fn access_token(account_id: &str) -> Result<Zeroizing<String>> {
    let _guard = VAULT_LOCK.lock().unwrap();
    let mut store = read_store()?;
    if store.active.as_deref() != Some(account_id) {
        return Err(error(
            "The ChatGPT account changed. Review the provider and request again.",
        ));
    }
    let account = store
        .accounts
        .iter_mut()
        .find(|a| a.client_id == account_id && a.enabled())
        .ok_or(ManagedAiError::NotConfigured)?;
    if account.expires_at <= now() + 60 {
        let response = client()?
            .post(format!("{ISSUER}/api/accounts/oauth/token"))
            .form(&[
                ("grant_type", "refresh_token"),
                ("client_id", &account.client_id),
                ("refresh_token", &account.refresh_token),
                ("resource", RESOURCE),
            ])
            .send()
            .map_err(network)?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            // Only a confirmed terminal refresh failure clears renewable credentials.
            let mut bytes = Zeroizing::new(Vec::new());
            response
                .take(MAX_JSON + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| ManagedAiError::Network)?;
            let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            let code = value["error"]
                .as_str()
                .or_else(|| value.pointer("/error/code").and_then(Value::as_str));
            if matches!(
                code,
                Some(
                    "invalid_grant"
                        | "invalid_refresh_token"
                        | "token_expired"
                        | "refresh_token_expired"
                        | "refresh_token_invalidated"
                        | "refresh_token_reused"
                )
            ) {
                account.clear_tokens();
                write_store(&store)?;
                return Err(http_error(401));
            }
            return Err(http_error(status));
        }
        let token = tokens(response)?;
        account.access_token = token.access_token.clone();
        if let Some(refresh) = &token.refresh_token {
            account.refresh_token = refresh.clone();
        }
        if let Some(scope) = &token.scope {
            account.scopes = scope.split_whitespace().map(str::to_owned).collect();
        }
        account.expires_at = now() + token.expires_in;
        write_store(&store)?;
    }
    let account = store
        .accounts
        .iter()
        .find(|a| a.client_id == account_id && a.enabled())
        .ok_or_else(|| error("Enable ChatGPT plan usage by reconnecting ChatGPT in Settings."))?;
    Ok(Zeroizing::new(account.access_token.clone()))
}
pub fn test_connection(account_id: &str) -> Result<()> {
    let token = access_token(account_id)?;
    let models = fetch_models(&client()?, &token)?;
    if models.is_empty() {
        return Err(error(
            "No models are available for this ChatGPT account. Check account or workspace access.",
        ));
    }
    let _guard = VAULT_LOCK.lock().unwrap();
    let mut store = read_store()?;
    if store.active.as_deref() != Some(account_id) {
        return Err(error(
            "The ChatGPT account changed. Test the connection again.",
        ));
    }
    if let Some(account) = store
        .accounts
        .iter_mut()
        .find(|a| a.client_id == account_id)
    {
        account.models = models;
    }
    write_store(&store)
}
/// Always clears local tokens. A failed remote revocation is reported to the UI.
pub fn disconnect() -> Result<()> {
    cancel_login();
    let _guard = VAULT_LOCK.lock().unwrap();
    let mut store = read_store()?;
    let mut revoked = true;
    if let Some(account) = store
        .accounts
        .iter_mut()
        .find(|a| Some(&a.client_id) == store.active.as_ref())
    {
        if !account.refresh_token.is_empty() {
            revoked = (|| {
                let c = client()?;
                let d = discovery(&c)?;
                c.post(d.revocation_endpoint)
                    .form(&[
                        ("token", &account.refresh_token),
                        ("token_type_hint", &"refresh_token".into()),
                        ("client_id", &account.client_id),
                    ])
                    .send()
                    .map(|r| r.status().as_u16() == 200)
                    .map_err(network)
            })()
            .unwrap_or(false);
        }
        account.clear_tokens();
    }
    write_store(&store)?;
    if !revoked {
        return Err(error("ChatGPT was disconnected on this computer. Remote revocation was not confirmed; disconnect Coqui in ChatGPT Settings → Usage."));
    }
    Ok(())
}

pub fn request(account_id: &str, body: Value) -> Result<Value> {
    let token = access_token(account_id)?;
    request_at(&client()?, &format!("{RESOURCE}/responses"), &token, body)
}
fn request_at(client: &Client, endpoint: &str, token: &str, mut body: Value) -> Result<Value> {
    body["store"] = false.into();
    body["stream"] = true.into();
    let response = client
        .post(endpoint)
        .bearer_auth(token)
        .json(&body)
        .send()
        .map_err(network)?;
    if !response.status().is_success() {
        return Err(http_error(response.status().as_u16()));
    }
    read_stream(response)
}
fn event_result(data: &str) -> Result<Option<Value>> {
    let event: Value = serde_json::from_str(data).map_err(|_| ManagedAiError::InvalidResponse)?;
    match event["type"].as_str() {
        Some("response.completed")
            if event.pointer("/response/status").and_then(Value::as_str) == Some("completed") =>
        {
            Ok(Some(event["response"].clone()))
        }
        Some("response.failed" | "error") => {
            let code = event
                .pointer("/response/error/code")
                .or_else(|| event.pointer("/error/code"))
                .or_else(|| event.get("code"))
                .and_then(Value::as_str);
            Err(match code {
                Some("subscription_sharing_usage_limit_exceeded") => http_error(429),
                Some(
                    "subscription_sharing_usage_unavailable"
                    | "subscription_sharing_user_unavailable",
                ) => http_error(503),
                Some(
                    "subscription_sharing_user_not_eligible"
                    | "chatpass_v2_scope_not_authorized"
                    | "chatpass_v2_invalid_authorization_context",
                ) => http_error(403),
                Some("subscription_sharing_invalid_user") => http_error(401),
                _ => ManagedAiError::InvalidResponse,
            })
        }
        Some("response.incomplete" | "response.completed") => Err(ManagedAiError::InvalidResponse),
        _ => Ok(None),
    }
}
fn read_stream(reader: impl Read) -> Result<Value> {
    let mut reader = BufReader::new(reader.take(MAX_STREAM + 1));
    let mut total = 0u64;
    let mut data = String::new();
    loop {
        let mut line = String::new();
        let n = reader
            .read_line(&mut line)
            .map_err(|_| ManagedAiError::Network)?;
        total += n as u64;
        if total > MAX_STREAM {
            return Err(ManagedAiError::InvalidResponse);
        }
        if n == 0 {
            return Err(ManagedAiError::InvalidResponse);
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            if !data.is_empty() {
                if let Some(result) = event_result(&data)? {
                    if data.len() as u64 > MAX_JSON {
                        return Err(ManagedAiError::InvalidResponse);
                    }
                    return Ok(result);
                }
                data.clear();
            }
        } else if let Some(value) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(value.strip_prefix(' ').unwrap_or(value));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authorization_is_pkce_bound_and_uses_the_issued_client_on_return() {
        let a = Attempt::new("http://127.0.0.1:4567/auth/callback".into(), None);
        let u = a
            .authorize(
                "https://auth.openai.com/api/accounts/authorize",
                "host",
                None,
            )
            .unwrap();
        let q: std::collections::HashMap<_, _> = u.query_pairs().collect();
        assert_eq!(q["client_id"], "dynamic_agent_client");
        assert_eq!(q["resource"], RESOURCE);
        assert_eq!(
            q["code_challenge"],
            URL_SAFE_NO_PAD.encode(Sha256::digest(a.verifier.as_bytes()))
        );
        assert!(!u.as_str().contains(a.verifier.as_str()));
        assert!(a
            .callback("/auth/callback?state=wrong&code=secret&client_id=oaiapp_test")
            .is_err());
        assert!(a
            .callback(&format!("/auth/callback?state={}&code=secret", a.state))
            .is_err());
        assert!(a
            .callback(&format!(
                "/auth/callback?state={}&state={}&code=secret&client_id=oaiapp_test",
                a.state, a.state
            ))
            .is_err());
        assert!(a
            .callback(&format!(
                "/auth/callback?state={}&error=access_denied",
                a.state
            ))
            .is_err());
        let (_, id) = a
            .callback(&format!(
                "/auth/callback?state={}&code=secret&client_id=oaiapp_test",
                a.state
            ))
            .unwrap();
        assert_eq!(id, "oaiapp_test");
        let a = Attempt::new(a.redirect.clone(), Some(id));
        assert!(a
            .callback(&format!(
                "/auth/callback?state={}&code=secret&client_id=oaiapp_other",
                a.state
            ))
            .is_err());
        assert_eq!(
            a.callback(&format!("/auth/callback?state={}&code=secret", a.state))
                .unwrap()
                .1,
            "oaiapp_test"
        );
    }
    #[test]
    fn streams_require_a_completed_response_and_reject_late_quota_errors() {
        let partial = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"private\"}\n\n";
        assert!(read_stream(partial.as_bytes()).is_err());
        let failed = format!("{partial}data: {{\"type\":\"response.failed\",\"response\":{{\"error\":{{\"code\":\"subscription_sharing_usage_limit_exceeded\",\"message\":\"PRIVATE\"}}}}}}\n\n");
        let e = read_stream(failed.as_bytes()).unwrap_err().to_string();
        assert!(e.contains("usage limit"));
        assert!(!e.contains("PRIVATE"));
        assert!(read_stream(b"data: {\"type\":\"response.incomplete\"}\n\n".as_slice()).is_err());
        let complete = format!("{partial}data: {{\"type\":\"response.completed\",\"response\":{{\"status\":\"completed\",\"output\":[],\"usage\":{{\"input_tokens\":21}}}}}}\r\n\r\n");
        assert_eq!(
            read_stream(complete.as_bytes()).unwrap()["usage"]["input_tokens"],
            21
        );
    }
    #[test]
    fn identity_verification_rejects_untrusted_signatures() {
        let token = jsonwebtoken::encode(&jsonwebtoken::Header::default(), &serde_json::json!({"sub":"user","nonce":"nonce","iss":ISSUER,"aud":"oaiapp_test","iat":now(),"exp":now()+60}), &jsonwebtoken::EncodingKey::from_secret(b"untrusted")).unwrap();
        assert!(verify_identity(&token, "oaiapp_test", "nonce", &JwkSet { keys: vec![] }).is_err());
    }
    #[test]
    fn identity_requires_a_valid_signature_issuer_audience_expiry_and_nonce() {
        use ring::signature::KeyPair;
        let rng = ring::rand::SystemRandom::new();
        let private = ring::signature::EcdsaKeyPair::generate_pkcs8(
            &ring::signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            &rng,
        )
        .unwrap();
        let pair = ring::signature::EcdsaKeyPair::from_pkcs8(
            &ring::signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            private.as_ref(),
            &rng,
        )
        .unwrap();
        let public = pair.public_key().as_ref();
        let jwks: JwkSet = serde_json::from_value(serde_json::json!({"keys":[{"kty":"EC","crv":"P-256","kid":"fixture","x":URL_SAFE_NO_PAD.encode(&public[1..33]),"y":URL_SAFE_NO_PAD.encode(&public[33..65])}]})).unwrap();
        let key = jsonwebtoken::EncodingKey::from_ec_der(private.as_ref());
        let mut header = jsonwebtoken::Header::new(Algorithm::ES256);
        header.kid = Some("fixture".into());
        let claims = serde_json::json!({"sub":"student","nonce":"attempt","iss":ISSUER,"aud":["oaiapp_fixture"],"iat":now(),"exp":now()+120});
        let token = jsonwebtoken::encode(&header, &claims, &key).unwrap();
        assert_eq!(
            verify_identity(&token, "oaiapp_fixture", "attempt", &jwks)
                .unwrap()
                .sub,
            "student"
        );
        for (field, value) in [
            ("iss", Value::from("https://untrusted.invalid")),
            ("aud", Value::from("oaiapp_other")),
            ("exp", Value::from(now() - 60)),
            ("nonce", Value::from("other")),
            ("sub", Value::from("")),
        ] {
            let mut wrong = claims.clone();
            wrong[field] = value;
            let token = jsonwebtoken::encode(&header, &wrong, &key).unwrap();
            assert!(
                verify_identity(&token, "oaiapp_fixture", "attempt", &jwks).is_err(),
                "accepted invalid {field}"
            );
        }
        let mut parts: Vec<_> = token.split('.').map(str::to_owned).collect();
        let mut signature = URL_SAFE_NO_PAD.decode(&parts[2]).unwrap();
        signature[0] ^= 1;
        parts[2] = URL_SAFE_NO_PAD.encode(signature);
        assert!(verify_identity(&parts.join("."), "oaiapp_fixture", "attempt", &jwks).is_err());
    }
    #[test]
    fn subscription_requests_use_public_responses_streaming_and_preserve_usage() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let endpoint = format!("http://{}/v1/responses", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            let mut headers = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                headers.push_str(&line);
            }
            let size: usize = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|n| n.trim().parse().unwrap())
                })
                .unwrap();
            let mut body = vec![0; size];
            reader.read_exact(&mut body).unwrap();
            let body: Value = serde_json::from_slice(&body).unwrap();
            assert!(headers.starts_with("POST /v1/responses "));
            assert!(headers
                .to_ascii_lowercase()
                .contains("authorization: bearer synthetic-token"));
            assert_eq!(body["store"], false);
            assert_eq!(body["stream"], true);
            assert_eq!(
                body.pointer("/text/format/strict"),
                Some(&Value::Bool(true))
            );
            let output = "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[],\"usage\":{\"input_tokens\":42,\"output_tokens\":7}}}\n\n";
            write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",output.len(),output).unwrap();
        });
        let value = request_at(&client().unwrap(),&endpoint,"synthetic-token",serde_json::json!({"model":"account-model","input":[{"role":"user","content":"reviewed facts"}],"store":true,"stream":false,"text":{"format":{"strict":true}}})).unwrap();
        server.join().unwrap();
        assert_eq!(value["usage"]["input_tokens"], 42);
        assert_eq!(value["usage"]["output_tokens"], 7);
    }
}
