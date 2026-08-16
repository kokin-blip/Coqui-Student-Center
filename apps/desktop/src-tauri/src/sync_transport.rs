use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use rand::{rngs::OsRng, RngCore};
use reqwest::{blocking::Client, redirect::Policy};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{io::Read, time::Duration};
use url::Url;
use uuid::Uuid;
use zeroize::Zeroizing;

const MUTATION_SCHEMA_VERSION: u16 = 2;
const MAX_RESPONSE_BYTES: u64 = 1_048_576;

#[derive(thiserror::Error, Debug)]
pub enum SyncTransportError {
    #[error("encrypted sync is not configured in this build")]
    NotConfigured,
    #[error("invalid encrypted sync configuration")]
    InvalidConfiguration,
    #[error("encrypted sync request failed: {0}")]
    Network(String),
    #[error("encrypted sync was rejected ({0})")]
    Rejected(u16),
    #[error("encrypted sync returned an invalid response")]
    InvalidResponse,
    #[error("mutation data is invalid: {0}")]
    InvalidMutation(String),
    #[error("mutation encryption failed")]
    Crypto,
}

pub type Result<T> = std::result::Result<T, SyncTransportError>;

#[derive(Debug, Clone)]
pub struct LocalMutation {
    pub mutation_id: Uuid,
    pub entity_type: String,
    pub entity_id: Uuid,
    pub operation: String,
    pub logical_timestamp: String,
    pub tombstone: bool,
    pub payload: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedMutation {
    pub mutation_id: Uuid,
    pub account_id: Uuid,
    pub device_id: Uuid,
    pub logical_timestamp: String,
    pub entity_id: Uuid,
    pub entity_type: String,
    pub nonce: String,
    pub ciphertext: String,
    pub schema_version: u16,
    pub tombstone: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecryptedMutation {
    pub operation: String,
    pub payload: String,
}

#[derive(Deserialize)]
struct OwnedMutationPlaintext {
    operation: String,
    payload: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MutationPlaintext<'a> {
    operation: &'a str,
    payload: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MutationAad<'a> {
    protocol: &'static str,
    mutation_id: Uuid,
    account_id: Uuid,
    device_id: Uuid,
    logical_timestamp: &'a str,
    entity_id: Uuid,
    entity_type: &'a str,
    schema_version: u16,
    tombstone: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRegistration<'a> {
    pub device_id: Uuid,
    pub public_key: &'a str,
    pub signing_public_key: &'a str,
    pub display_name: &'a str,
    pub platform: &'static str,
    pub request_approval: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationResponse {
    pub registered: bool,
    pub authorized: bool,
    #[serde(rename = "created")]
    pub _created: bool,
    pub account_id: Uuid,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingDevice {
    pub device_id: Uuid,
    pub public_key: String,
    pub signing_public_key: String,
    pub display_name: String,
    pub platform: String,
}

#[derive(Deserialize)]
struct PendingDevicesResponse {
    devices: Vec<PendingDevice>,
}

#[derive(Deserialize)]
struct DeviceEnvelopesResponse {
    envelopes: Vec<crate::sync_crypto::ReceivedDeviceApproval>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushResponse {
    pub accepted: usize,
    pub cursor: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullResponse {
    pub cursor: String,
    pub mutations: Vec<EncryptedMutation>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedObjectManifest {
    pub document_id: Uuid,
    pub encrypted_metadata: String,
    pub chunk_hashes: Vec<String>,
    pub wrapped_object_key: String,
    pub version: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedObjectChunk {
    pub document_id: Uuid,
    pub index: usize,
    pub ciphertext: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedObjectDownload {
    pub manifest: EncryptedObjectManifest,
    pub chunks: Vec<EncryptedObjectChunk>,
}

pub struct PreparedEncryptedObject {
    pub manifest: EncryptedObjectManifest,
    pub chunks: Vec<EncryptedObjectChunk>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObjectInitiationResponse {
    initiated: bool,
    document_id: Uuid,
    chunk_count: usize,
    missing_chunks: Vec<usize>,
}

#[derive(Serialize)]
struct PushRequest<'a> {
    mutations: &'a [EncryptedMutation],
}

#[derive(Clone)]
pub struct CloudSyncClient {
    origin: Url,
    client: Client,
}

impl CloudSyncClient {
    pub fn compiled() -> Result<Self> {
        let origin =
            option_env!("STUDENT_CENTER_CLOUD_API_URL").ok_or(SyncTransportError::NotConfigured)?;
        Self::new(origin)
    }

    fn new(origin: &str) -> Result<Self> {
        let origin = Url::parse(origin).map_err(|_| SyncTransportError::InvalidConfiguration)?;
        if origin.scheme() != "https"
            || origin.username() != ""
            || origin.password().is_some()
            || origin.host_str().is_none()
            || origin.port_or_known_default() != Some(443)
            || origin.path() != "/"
            || origin.query().is_some()
            || origin.fragment().is_some()
        {
            return Err(SyncTransportError::InvalidConfiguration);
        }
        let client = Client::builder()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(20))
            .user_agent(concat!("StudentCenter/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| SyncTransportError::Network(error.to_string()))?;
        Ok(Self { origin, client })
    }

    pub fn register_device(
        &self,
        access_token: &str,
        registration: &DeviceRegistration<'_>,
    ) -> Result<RegistrationResponse> {
        self.post_json("v1/devices/register", access_token, registration)
    }

    pub fn pending_devices(
        &self,
        access_token: &str,
        device_id: Uuid,
    ) -> Result<Vec<PendingDevice>> {
        let endpoint = self.endpoint("v1/devices/pending")?;
        let response = self
            .client
            .get(endpoint)
            .bearer_auth(access_token)
            .header("x-student-center-device-id", device_id.to_string())
            .send()
            .map_err(|error| SyncTransportError::Network(error.to_string()))?;
        Ok(read_json::<PendingDevicesResponse>(response)?.devices)
    }

    pub fn authorized_devices(
        &self,
        access_token: &str,
        device_id: Uuid,
    ) -> Result<Vec<PendingDevice>> {
        let endpoint = self.endpoint("v1/devices")?;
        let response = self
            .client
            .get(endpoint)
            .bearer_auth(access_token)
            .header("x-student-center-device-id", device_id.to_string())
            .send()
            .map_err(|error| SyncTransportError::Network(error.to_string()))?;
        Ok(read_json::<PendingDevicesResponse>(response)?.devices)
    }

    pub fn approve_device(
        &self,
        access_token: &str,
        envelope: &crate::sync_crypto::DeviceApprovalEnvelope,
    ) -> Result<serde_json::Value> {
        self.post_json(
            &format!("v1/devices/{}/approve", envelope.target_device_id),
            access_token,
            envelope,
        )
    }

    pub fn device_envelopes(
        &self,
        access_token: &str,
        device_id: Uuid,
    ) -> Result<Vec<crate::sync_crypto::ReceivedDeviceApproval>> {
        let endpoint = self.endpoint("v1/devices/envelopes")?;
        let response = self
            .client
            .get(endpoint)
            .bearer_auth(access_token)
            .header("x-student-center-device-id", device_id.to_string())
            .send()
            .map_err(|error| SyncTransportError::Network(error.to_string()))?;
        Ok(read_json::<DeviceEnvelopesResponse>(response)?.envelopes)
    }

    pub fn revoke_device(
        &self,
        access_token: &str,
        current_device_id: Uuid,
        target_device_id: Uuid,
    ) -> Result<serde_json::Value> {
        let endpoint = self.endpoint(&format!("v1/devices/{target_device_id}"))?;
        let response = self
            .client
            .delete(endpoint)
            .bearer_auth(access_token)
            .header("x-student-center-device-id", current_device_id.to_string())
            .send()
            .map_err(|error| SyncTransportError::Network(error.to_string()))?;
        read_json(response)
    }

    pub fn upload_object(
        &self,
        access_token: &str,
        device_id: Uuid,
        object: &PreparedEncryptedObject,
    ) -> Result<()> {
        let initiated = self.device_json(
            reqwest::Method::POST,
            "v1/objects/initiate",
            access_token,
            device_id,
            &object.manifest,
        )?;
        let initiated: ObjectInitiationResponse =
            serde_json::from_value(initiated).map_err(|_| SyncTransportError::InvalidResponse)?;
        if !initiated.initiated
            || initiated.document_id != object.manifest.document_id
            || initiated.chunk_count != object.chunks.len()
            || initiated.missing_chunks.len() > object.chunks.len()
            || initiated
                .missing_chunks
                .iter()
                .any(|index| *index >= object.chunks.len())
        {
            return Err(SyncTransportError::InvalidResponse);
        }
        let missing = initiated
            .missing_chunks
            .into_iter()
            .collect::<std::collections::HashSet<_>>();
        for chunk in object
            .chunks
            .iter()
            .filter(|chunk| missing.contains(&chunk.index))
        {
            self.device_json(
                reqwest::Method::PUT,
                &format!(
                    "v1/objects/{}/chunks/{}",
                    object.manifest.document_id, chunk.index
                ),
                access_token,
                device_id,
                chunk,
            )?;
        }
        self.device_json(
            reqwest::Method::POST,
            "v1/objects/complete",
            access_token,
            device_id,
            &serde_json::json!({"documentId": object.manifest.document_id}),
        )?;
        Ok(())
    }

    pub fn download_object(
        &self,
        access_token: &str,
        device_id: Uuid,
        document_id: Uuid,
    ) -> Result<EncryptedObjectDownload> {
        let endpoint = self.endpoint(&format!("v1/objects/{document_id}/download"))?;
        let response = self
            .client
            .get(endpoint)
            .bearer_auth(access_token)
            .header("x-student-center-device-id", device_id.to_string())
            .send()
            .map_err(|error| SyncTransportError::Network(error.to_string()))?;
        let download: EncryptedObjectDownload = read_json_bounded(response, 42 * 1024 * 1024)?;
        verify_download(&download, document_id)?;
        Ok(download)
    }

    fn device_json<T: Serialize>(
        &self,
        method: reqwest::Method,
        path: &str,
        access_token: &str,
        device_id: Uuid,
        body: &T,
    ) -> Result<serde_json::Value> {
        let endpoint = self.endpoint(path)?;
        let response = self
            .client
            .request(method, endpoint)
            .bearer_auth(access_token)
            .header("x-student-center-device-id", device_id.to_string())
            .json(body)
            .send()
            .map_err(|error| SyncTransportError::Network(error.to_string()))?;
        read_json(response)
    }

    pub fn push_mutations(
        &self,
        access_token: &str,
        mutations: &[EncryptedMutation],
    ) -> Result<PushResponse> {
        if mutations.is_empty() || mutations.len() > 1000 {
            return Err(SyncTransportError::InvalidMutation(
                "a push must contain between 1 and 1000 mutations".into(),
            ));
        }
        self.post_json("v1/sync/push", access_token, &PushRequest { mutations })
    }

    pub fn pull_mutations(
        &self,
        access_token: &str,
        device_id: Uuid,
        cursor: &str,
        limit: usize,
    ) -> Result<PullResponse> {
        if access_token.len() < 32
            || access_token.len() > 16_384
            || cursor.is_empty()
            || cursor.len() > 20
            || !cursor.chars().all(|value| value.is_ascii_digit())
            || !(1..=1000).contains(&limit)
        {
            return Err(SyncTransportError::InvalidResponse);
        }
        let path = format!("v1/sync/pull?cursor={cursor}&limit={limit}");
        let endpoint = self.endpoint(&path)?;
        let response = self
            .client
            .get(endpoint)
            .bearer_auth(access_token)
            .header("x-student-center-device-id", device_id.to_string())
            .send()
            .map_err(|error| SyncTransportError::Network(error.to_string()))?;
        read_json(response)
    }

    fn post_json<T: Serialize, R: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        access_token: &str,
        body: &T,
    ) -> Result<R> {
        if access_token.len() < 32 || access_token.len() > 16_384 {
            return Err(SyncTransportError::InvalidResponse);
        }
        let endpoint = self.endpoint(path)?;
        let response = self
            .client
            .post(endpoint)
            .bearer_auth(access_token)
            .json(body)
            .send()
            .map_err(|error| SyncTransportError::Network(error.to_string()))?;
        read_json(response)
    }

    fn endpoint(&self, path: &str) -> Result<Url> {
        let endpoint = self
            .origin
            .join(path)
            .map_err(|_| SyncTransportError::InvalidConfiguration)?;
        if endpoint.origin() != self.origin.origin() {
            return Err(SyncTransportError::InvalidConfiguration);
        }
        Ok(endpoint)
    }
}

fn encrypt_object_part(account_key: &[u8; 32], bytes: &[u8]) -> Result<String> {
    let mut nonce = [0_u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let encrypted = XChaCha20Poly1305::new_from_slice(account_key)
        .map_err(|_| SyncTransportError::Crypto)?
        .encrypt(XNonce::from_slice(&nonce), bytes)
        .map_err(|_| SyncTransportError::Crypto)?;
    let mut result = nonce.to_vec();
    result.extend_from_slice(&encrypted);
    Ok(URL_SAFE_NO_PAD.encode(result))
}

fn decrypt_object_part(account_key: &[u8; 32], encoded: &str) -> Result<Zeroizing<Vec<u8>>> {
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| SyncTransportError::InvalidResponse)?;
    if bytes.len() < 24 + 16 {
        return Err(SyncTransportError::InvalidResponse);
    }
    let (nonce, ciphertext) = bytes.split_at(24);
    let cipher =
        XChaCha20Poly1305::new_from_slice(account_key).map_err(|_| SyncTransportError::Crypto)?;
    Ok(Zeroizing::new(
        cipher
            .decrypt(XNonce::from_slice(nonce), ciphertext)
            .map_err(|_| SyncTransportError::Crypto)?,
    ))
}

pub fn prepare_encrypted_object(
    account_key: &Zeroizing<[u8; 32]>,
    document_id: Uuid,
    metadata: &[u8],
    document_key: &[u8; 32],
    encrypted_file: &[u8],
) -> Result<PreparedEncryptedObject> {
    if metadata.is_empty() || metadata.len() > 64 * 1024 || encrypted_file.len() > 30 * 1024 * 1024
    {
        return Err(SyncTransportError::InvalidMutation(
            "the encrypted object is outside transfer limits".into(),
        ));
    }
    let chunks = encrypted_file
        .chunks(1024 * 1024)
        .enumerate()
        .map(|(index, bytes)| EncryptedObjectChunk {
            document_id,
            index,
            ciphertext: URL_SAFE_NO_PAD.encode(bytes),
            sha256: hex::encode(Sha256::digest(bytes)),
        })
        .collect::<Vec<_>>();
    let manifest = EncryptedObjectManifest {
        document_id,
        encrypted_metadata: encrypt_object_part(&*account_key, metadata)?,
        chunk_hashes: chunks.iter().map(|chunk| chunk.sha256.clone()).collect(),
        wrapped_object_key: encrypt_object_part(&*account_key, document_key)?,
        version: 1,
    };
    Ok(PreparedEncryptedObject { manifest, chunks })
}

pub fn open_encrypted_object(
    account_key: &Zeroizing<[u8; 32]>,
    download: &EncryptedObjectDownload,
) -> Result<(Zeroizing<Vec<u8>>, Zeroizing<[u8; 32]>, Vec<u8>)> {
    verify_download(download, download.manifest.document_id)?;
    let metadata = decrypt_object_part(&*account_key, &download.manifest.encrypted_metadata)?;
    let key = decrypt_object_part(&*account_key, &download.manifest.wrapped_object_key)?;
    let key: [u8; 32] = key
        .as_slice()
        .try_into()
        .map_err(|_| SyncTransportError::InvalidResponse)?;
    let mut encrypted_file = Vec::new();
    for chunk in &download.chunks {
        encrypted_file.extend_from_slice(
            &URL_SAFE_NO_PAD
                .decode(&chunk.ciphertext)
                .map_err(|_| SyncTransportError::InvalidResponse)?,
        );
    }
    Ok((metadata, Zeroizing::new(key), encrypted_file))
}

fn verify_download(download: &EncryptedObjectDownload, document_id: Uuid) -> Result<()> {
    if download.manifest.document_id != document_id
        || download.chunks.len() != download.manifest.chunk_hashes.len()
        || download.chunks.iter().enumerate().any(|(index, chunk)| {
            chunk.document_id != document_id
                || chunk.index != index
                || URL_SAFE_NO_PAD
                    .decode(&chunk.ciphertext)
                    .ok()
                    .is_none_or(|bytes| hex::encode(Sha256::digest(bytes)) != chunk.sha256)
                || download.manifest.chunk_hashes[index] != chunk.sha256
        })
    {
        return Err(SyncTransportError::InvalidResponse);
    }
    Ok(())
}

fn read_json<R: for<'de> Deserialize<'de>>(response: reqwest::blocking::Response) -> Result<R> {
    read_json_bounded(response, MAX_RESPONSE_BYTES)
}

fn read_json_bounded<R: for<'de> Deserialize<'de>>(
    response: reqwest::blocking::Response,
    max_bytes: u64,
) -> Result<R> {
    if response.status().is_redirection() {
        return Err(SyncTransportError::Rejected(response.status().as_u16()));
    }
    if !response.status().is_success() {
        return Err(SyncTransportError::Rejected(response.status().as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|size| size > max_bytes)
    {
        return Err(SyncTransportError::InvalidResponse);
    }
    let mut body = Vec::new();
    response
        .take(max_bytes + 1)
        .read_to_end(&mut body)
        .map_err(|error| SyncTransportError::Network(error.to_string()))?;
    if body.len() as u64 > max_bytes {
        return Err(SyncTransportError::InvalidResponse);
    }
    serde_json::from_slice(&body).map_err(|_| SyncTransportError::InvalidResponse)
}

pub fn platform() -> Result<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Ok("windows-x64"),
        ("macos", "aarch64") => Ok("macos-arm64"),
        _ => Err(SyncTransportError::InvalidConfiguration),
    }
}

pub fn encrypt_mutation(
    account_key: &Zeroizing<[u8; 32]>,
    account_id: Uuid,
    device_id: Uuid,
    mutation: &LocalMutation,
) -> Result<EncryptedMutation> {
    validate_mutation(mutation)?;
    validate_hlc(&mutation.logical_timestamp, device_id)?;
    let aad = mutation_aad(account_id, device_id, mutation)?;
    let plaintext = Zeroizing::new(
        serde_json::to_vec(&MutationPlaintext {
            operation: &mutation.operation,
            payload: &mutation.payload,
        })
        .map_err(|_| SyncTransportError::InvalidMutation("payload cannot be encoded".into()))?,
    );
    let mut nonce = [0_u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let cipher = XChaCha20Poly1305::new_from_slice(account_key.as_ref())
        .map_err(|_| SyncTransportError::Crypto)?;
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext.as_slice(),
                aad: &aad,
            },
        )
        .map_err(|_| SyncTransportError::Crypto)?;
    Ok(EncryptedMutation {
        mutation_id: mutation.mutation_id,
        account_id,
        device_id,
        logical_timestamp: mutation.logical_timestamp.clone(),
        entity_id: mutation.entity_id,
        entity_type: mutation.entity_type.clone(),
        nonce: URL_SAFE_NO_PAD.encode(nonce),
        ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
        schema_version: MUTATION_SCHEMA_VERSION,
        tombstone: mutation.tombstone,
    })
}

pub fn decrypt_mutation(
    account_key: &Zeroizing<[u8; 32]>,
    expected_account_id: Uuid,
    mutation: &EncryptedMutation,
) -> Result<DecryptedMutation> {
    if mutation.account_id != expected_account_id
        || mutation.schema_version != MUTATION_SCHEMA_VERSION
        || mutation.ciphertext.len() > 1_400_000
    {
        return Err(SyncTransportError::InvalidMutation(
            "the encrypted envelope does not match this account or protocol".into(),
        ));
    }
    validate_hlc(&mutation.logical_timestamp, mutation.device_id)?;
    let metadata = LocalMutation {
        mutation_id: mutation.mutation_id,
        entity_type: mutation.entity_type.clone(),
        entity_id: mutation.entity_id,
        operation: "encrypted".into(),
        logical_timestamp: mutation.logical_timestamp.clone(),
        tombstone: mutation.tombstone,
        payload: String::new(),
    };
    validate_mutation(&metadata)?;
    let nonce = URL_SAFE_NO_PAD
        .decode(&mutation.nonce)
        .map_err(|_| SyncTransportError::InvalidMutation("the nonce is invalid".into()))?;
    let nonce: [u8; 24] = nonce
        .try_into()
        .map_err(|_| SyncTransportError::InvalidMutation("the nonce is invalid".into()))?;
    let ciphertext = URL_SAFE_NO_PAD
        .decode(&mutation.ciphertext)
        .map_err(|_| SyncTransportError::InvalidMutation("the ciphertext is invalid".into()))?;
    let aad = mutation_aad(expected_account_id, mutation.device_id, &metadata)?;
    let cipher = XChaCha20Poly1305::new_from_slice(account_key.as_ref())
        .map_err(|_| SyncTransportError::Crypto)?;
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| SyncTransportError::Crypto)?,
    );
    let plaintext: OwnedMutationPlaintext = serde_json::from_slice(&plaintext).map_err(|_| {
        SyncTransportError::InvalidMutation("the plaintext schema is invalid".into())
    })?;
    if plaintext.operation.is_empty()
        || plaintext.operation.len() > 64
        || plaintext.payload.len() > 1_000_000
        || serde_json::from_str::<serde_json::Value>(&plaintext.payload).is_err()
    {
        return Err(SyncTransportError::InvalidMutation(
            "the plaintext mutation is invalid".into(),
        ));
    }
    let decoded = LocalMutation {
        mutation_id: mutation.mutation_id,
        entity_type: mutation.entity_type.clone(),
        entity_id: mutation.entity_id,
        operation: plaintext.operation.clone(),
        logical_timestamp: mutation.logical_timestamp.clone(),
        tombstone: mutation.tombstone,
        payload: plaintext.payload.clone(),
    };
    validate_mutation(&decoded)?;
    Ok(DecryptedMutation {
        operation: plaintext.operation,
        payload: plaintext.payload,
    })
}

fn validate_mutation(mutation: &LocalMutation) -> Result<()> {
    if mutation.entity_type.is_empty()
        || mutation.entity_type.len() > 64
        || !mutation
            .entity_type
            .chars()
            .enumerate()
            .all(|(index, value)| {
                if index == 0 {
                    value.is_ascii_lowercase()
                } else {
                    value.is_ascii_lowercase()
                        || value.is_ascii_digit()
                        || matches!(value, '_' | '.' | '-')
                }
            })
        || mutation.logical_timestamp.is_empty()
        || mutation.logical_timestamp.len() > 128
        || mutation.operation.is_empty()
        || mutation.operation.len() > 64
        || mutation.payload.len() > 1_000_000
    {
        return Err(SyncTransportError::InvalidMutation(
            "metadata or payload is outside protocol limits".into(),
        ));
    }
    if !mutation.payload.is_empty() {
        let payload: serde_json::Value = serde_json::from_str(&mutation.payload).map_err(|_| {
            SyncTransportError::InvalidMutation("the canonical payload is invalid".into())
        })?;
        if payload
            .get("schemaVersion")
            .and_then(|value| value.as_u64())
            != Some(2)
            || payload.get("entityType").and_then(|value| value.as_str())
                != Some(mutation.entity_type.as_str())
            || payload.get("entityId").and_then(|value| value.as_str())
                != Some(mutation.entity_id.to_string().as_str())
            || payload.get("operation").and_then(|value| value.as_str())
                != Some(mutation.operation.as_str())
            || payload.get("snapshot").is_none()
            || (mutation.tombstone && !payload["snapshot"].is_null())
            || (!mutation.tombstone && !payload["snapshot"].is_object())
        {
            return Err(SyncTransportError::InvalidMutation(
                "the canonical payload does not match authenticated metadata".into(),
            ));
        }
    }
    Ok(())
}

fn validate_hlc(value: &str, device_id: Uuid) -> Result<()> {
    let mut parts = value.splitn(3, '-');
    let physical = parts.next().unwrap_or_default();
    let counter = parts.next().unwrap_or_default();
    let device = parts.next().unwrap_or_default();
    if physical.len() != 13
        || counter.len() != 10
        || !physical.chars().all(|value| value.is_ascii_digit())
        || !counter.chars().all(|value| value.is_ascii_digit())
        || device != device_id.to_string()
    {
        return Err(SyncTransportError::InvalidMutation(
            "the hybrid logical timestamp is invalid".into(),
        ));
    }
    Ok(())
}

fn mutation_aad(account_id: Uuid, device_id: Uuid, mutation: &LocalMutation) -> Result<Vec<u8>> {
    serde_json::to_vec(&MutationAad {
        protocol: "student-center.encrypted-mutation.v2",
        mutation_id: mutation.mutation_id,
        account_id,
        device_id,
        logical_timestamp: &mutation.logical_timestamp,
        entity_id: mutation.entity_id,
        entity_type: &mutation.entity_type,
        schema_version: MUTATION_SCHEMA_VERSION,
        tombstone: mutation.tombstone,
    })
    .map_err(|_| SyncTransportError::InvalidMutation("metadata cannot be encoded".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> LocalMutation {
        LocalMutation {
            mutation_id: Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap(),
            entity_type: "task".into(),
            entity_id: Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap(),
            operation: "completion_changed".into(),
            logical_timestamp:
                "1786700000000-0000000000-44444444-4444-4444-8444-444444444444".into(),
            tombstone: false,
            payload: r#"{"schemaVersion":2,"entityType":"task","entityId":"22222222-2222-4222-8222-222222222222","operation":"completion_changed","snapshot":{"completed":1,"title":"Private homework"}}"#.into(),
        }
    }

    #[test]
    fn cloud_origin_is_strict_https() {
        assert!(CloudSyncClient::new("https://sync.example.com/").is_ok());
        for invalid in [
            "http://sync.example.com/",
            "https://sync.example.com:8443/",
            "https://user:pass@sync.example.com/",
            "https://sync.example.com/api",
            "https://sync.example.com/?next=bad",
        ] {
            assert!(CloudSyncClient::new(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn encrypted_mutation_contains_no_plaintext_and_binds_metadata() {
        let key = Zeroizing::new([7_u8; 32]);
        let account_id = Uuid::parse_str("33333333-3333-4333-8333-333333333333").unwrap();
        let device_id = Uuid::parse_str("44444444-4444-4444-8444-444444444444").unwrap();
        let mutation = fixture();
        let encrypted = encrypt_mutation(&key, account_id, device_id, &mutation).unwrap();
        let serialized = serde_json::to_string(&encrypted).unwrap();
        assert!(!serialized.contains("completion_changed"));
        assert!(!serialized.contains("completed"));
        assert_eq!(
            decrypt_mutation(&key, account_id, &encrypted).unwrap(),
            DecryptedMutation {
                operation: "completion_changed".into(),
                payload: mutation.payload.clone(),
            }
        );

        let nonce = URL_SAFE_NO_PAD.decode(&encrypted.nonce).unwrap();
        let ciphertext = URL_SAFE_NO_PAD.decode(&encrypted.ciphertext).unwrap();
        let cipher = XChaCha20Poly1305::new_from_slice(key.as_ref()).unwrap();
        let aad = mutation_aad(account_id, device_id, &mutation).unwrap();
        let plaintext = cipher
            .decrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: &aad,
                },
            )
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&plaintext).unwrap()["operation"],
            "completion_changed"
        );

        let mut substituted = mutation.clone();
        substituted.entity_type = "exam".into();
        let wrong_aad = mutation_aad(account_id, device_id, &substituted).unwrap();
        assert!(cipher
            .decrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: &wrong_aad,
                },
            )
            .is_err());
        let mut substituted_envelope = encrypted;
        substituted_envelope.entity_type = "exam".into();
        assert!(decrypt_mutation(&key, account_id, &substituted_envelope).is_err());
    }

    #[test]
    fn invalid_mutation_metadata_is_rejected_before_encryption() {
        let mut mutation = fixture();
        mutation.entity_type = "Task".into();
        assert!(encrypt_mutation(
            &Zeroizing::new([7_u8; 32]),
            Uuid::new_v4(),
            Uuid::new_v4(),
            &mutation
        )
        .is_err());
    }

    #[test]
    fn encrypted_objects_are_chunked_hashed_and_tamper_evident() {
        let document_id = Uuid::new_v4();
        let object = prepare_encrypted_object(
            &Zeroizing::new([7_u8; 32]),
            document_id,
            br#"{"fileName":"private syllabus.pdf"}"#,
            &[8_u8; 32],
            &vec![9_u8; 1_200_000],
        )
        .unwrap();
        assert_eq!(object.chunks.len(), 2);
        let serialized = serde_json::to_string(&object.manifest).unwrap();
        assert!(!serialized.contains("private syllabus"));
        let mut download = EncryptedObjectDownload {
            manifest: object.manifest,
            chunks: object.chunks,
        };
        verify_download(&download, document_id).unwrap();
        download.chunks[0].ciphertext = URL_SAFE_NO_PAD.encode(b"substituted");
        assert!(verify_download(&download, document_id).is_err());
    }
}
