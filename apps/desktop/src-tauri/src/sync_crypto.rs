use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use bip39::{Language, Mnemonic};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use chrono::{Duration, Utc};
use rand::{rngs::OsRng, seq::SliceRandom, RngCore};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair, UnparsedPublicKey, ED25519},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use uuid::Uuid;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::{Zeroize, Zeroizing};

const CREDENTIAL_SERVICE: &str = "app.studentcenter.desktop";
const CREDENTIAL_PREFIX: &str = "sync-secrets";
const PENDING_CREDENTIAL_PREFIX: &str = "sync-pending-device";
const SECRET_VERSION: u8 = 2;
const RECOVERY_WORDS: usize = 24;
const CONFIRMATION_COUNT: usize = 3;

#[derive(thiserror::Error, Debug)]
pub enum SyncCryptoError {
    #[error("invalid sync protection request: {0}")]
    Invalid(String),
    #[error("credential store error: {0}")]
    Credential(#[from] keyring::Error),
    #[error("sync protection data is invalid")]
    Corrupt,
}

pub type Result<T> = std::result::Result<T, SyncCryptoError>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProtectionStatus {
    pub protected: bool,
    pub account_id: String,
    pub device_id: Option<String>,
    pub public_key: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySetup {
    pub words: Vec<String>,
    pub confirmation_positions: Vec<u8>,
    pub device_id: String,
    pub public_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryConfirmation {
    pub position: u8,
    pub word: String,
}

pub(crate) struct SyncKeyMaterial {
    pub account_key: Zeroizing<[u8; 32]>,
    pub device_id: Uuid,
    pub public_key: String,
    pub signing_public_key: String,
    pub(crate) device_private_key: Zeroizing<[u8; 32]>,
    pub(crate) signing_private_key: Zeroizing<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceApprovalEnvelope {
    pub envelope_id: Uuid,
    pub target_device_id: Uuid,
    pub sender_device_id: Uuid,
    pub encrypted_account_key: String,
    pub signature: String,
    pub created_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingDeviceSetup {
    pub device_id: Uuid,
    pub public_key: String,
    pub signing_public_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceivedDeviceApproval {
    #[serde(flatten)]
    pub envelope: DeviceApprovalEnvelope,
    pub sender_public_key: String,
    pub sender_signing_public_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UnsignedDeviceApproval<'a> {
    envelope_id: Uuid,
    target_device_id: Uuid,
    sender_device_id: Uuid,
    encrypted_account_key: &'a str,
    created_at: &'a str,
    expires_at: &'a str,
}

impl SyncKeyMaterial {
    /// Key material with a real Ed25519 identity, for tests that need signing to actually work.
    #[cfg(test)]
    pub(crate) fn for_test(device_id: Uuid, account_key: [u8; 32]) -> Self {
        let signing = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let pair = Ed25519KeyPair::from_pkcs8(signing.as_ref()).unwrap();
        Self {
            account_key: Zeroizing::new(account_key),
            device_id,
            public_key: URL_SAFE_NO_PAD.encode(
                x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from([3_u8; 32]))
                    .as_bytes(),
            ),
            signing_public_key: URL_SAFE_NO_PAD.encode(pair.public_key().as_ref()),
            device_private_key: Zeroizing::new([3_u8; 32]),
            signing_private_key: Zeroizing::new(signing.as_ref().to_vec()),
        }
    }

    pub fn sign(&self, message: &[u8]) -> Result<String> {
        let pair = Ed25519KeyPair::from_pkcs8(self.signing_private_key.as_slice())
            .map_err(|_| SyncCryptoError::Corrupt)?;
        Ok(URL_SAFE_NO_PAD.encode(pair.sign(message).as_ref()))
    }

    pub fn approve_device(
        &self,
        target_device_id: Uuid,
        target_public_key: &str,
    ) -> Result<DeviceApprovalEnvelope> {
        if target_device_id == self.device_id {
            return Err(SyncCryptoError::Invalid(
                "a device cannot approve itself".into(),
            ));
        }
        let target: [u8; 32] = URL_SAFE_NO_PAD
            .decode(target_public_key)
            .map_err(|_| SyncCryptoError::Corrupt)?
            .try_into()
            .map_err(|_| SyncCryptoError::Corrupt)?;
        let private = StaticSecret::from(*self.device_private_key);
        let shared = private.diffie_hellman(&PublicKey::from(target));
        let mut digest = Sha256::new();
        digest.update(b"student-center.device-approval.v1");
        digest.update(shared.as_bytes());
        digest.update(self.device_id.as_bytes());
        digest.update(target_device_id.as_bytes());
        let wrapping_key: [u8; 32] = digest.finalize().into();
        let mut nonce = [0_u8; 24];
        OsRng.fill_bytes(&mut nonce);
        let encrypted = XChaCha20Poly1305::new_from_slice(&wrapping_key)
            .map_err(|_| SyncCryptoError::Corrupt)?
            .encrypt(XNonce::from_slice(&nonce), self.account_key.as_ref())
            .map_err(|_| SyncCryptoError::Corrupt)?;
        let mut wrapped = nonce.to_vec();
        wrapped.extend_from_slice(&encrypted);
        let encrypted_account_key = URL_SAFE_NO_PAD.encode(wrapped);
        let now = Utc::now();
        let created_at = now.to_rfc3339();
        let expires_at = (now + Duration::minutes(15)).to_rfc3339();
        let envelope_id = Uuid::new_v4();
        let unsigned = UnsignedDeviceApproval {
            envelope_id,
            target_device_id,
            sender_device_id: self.device_id,
            encrypted_account_key: &encrypted_account_key,
            created_at: &created_at,
            expires_at: &expires_at,
        };
        let message = serde_json::to_vec(&unsigned).map_err(|_| SyncCryptoError::Corrupt)?;
        Ok(DeviceApprovalEnvelope {
            envelope_id,
            target_device_id,
            sender_device_id: self.device_id,
            encrypted_account_key,
            signature: self.sign(&message)?,
            created_at,
            expires_at,
        })
    }
}

#[derive(Serialize, Deserialize)]
struct PersistedSyncSecrets {
    version: u8,
    account_id: String,
    device_id: String,
    account_key: String,
    device_private_key: String,
    #[serde(default)]
    signing_private_key: String,
}

#[derive(Serialize, Deserialize)]
struct PersistedPendingDevice {
    version: u8,
    account_id: String,
    device_id: String,
    device_private_key: String,
    signing_private_key: String,
}

impl Drop for PersistedPendingDevice {
    fn drop(&mut self) {
        self.device_private_key.zeroize();
        self.signing_private_key.zeroize();
    }
}

impl Drop for PersistedSyncSecrets {
    fn drop(&mut self) {
        self.account_key.zeroize();
        self.device_private_key.zeroize();
        self.signing_private_key.zeroize();
    }
}

struct PendingProtection {
    account_id: String,
    account_key: Zeroizing<[u8; 32]>,
    device_private_key: Zeroizing<[u8; 32]>,
    signing_private_key: Zeroizing<Vec<u8>>,
    device_id: Uuid,
    confirmation_positions: [u8; CONFIRMATION_COUNT],
}

impl PendingProtection {
    fn new(account_id: &str) -> Result<Self> {
        validate_account_id(account_id)?;
        let mut account_key = Zeroizing::new([0_u8; 32]);
        let mut device_private_key = Zeroizing::new([0_u8; 32]);
        OsRng.fill_bytes(account_key.as_mut());
        OsRng.fill_bytes(device_private_key.as_mut());
        let signing_private_key = Zeroizing::new(
            Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
                .map_err(|_| SyncCryptoError::Corrupt)?
                .as_ref()
                .to_vec(),
        );
        let mut positions = (1..=RECOVERY_WORDS as u8).collect::<Vec<_>>();
        positions.shuffle(&mut OsRng);
        let mut confirmation_positions = [positions[0], positions[1], positions[2]];
        confirmation_positions.sort_unstable();
        Ok(Self {
            account_id: account_id.to_string(),
            account_key,
            device_private_key,
            signing_private_key,
            device_id: Uuid::new_v4(),
            confirmation_positions,
        })
    }

    fn mnemonic(&self) -> Result<Mnemonic> {
        Mnemonic::from_entropy(self.account_key.as_ref()).map_err(|_| SyncCryptoError::Corrupt)
    }

    fn setup(&self) -> Result<RecoverySetup> {
        Ok(RecoverySetup {
            words: self.mnemonic()?.words().map(str::to_owned).collect(),
            confirmation_positions: self.confirmation_positions.to_vec(),
            device_id: self.device_id.to_string(),
            public_key: public_key(&self.device_private_key),
        })
    }
}

#[derive(Default)]
pub struct SyncProtectionRuntime {
    pending: Option<PendingProtection>,
}

impl SyncProtectionRuntime {
    pub fn status(&self, account_id: &str) -> Result<SyncProtectionStatus> {
        validate_account_id(account_id)?;
        match load_secrets(account_id)? {
            Some(secrets) => Ok(status_from_secrets(&secrets)),
            None => Ok(SyncProtectionStatus {
                protected: false,
                account_id: account_id.to_string(),
                device_id: None,
                public_key: None,
                message: "Create or enter a 24-word recovery code before encrypted sync can start."
                    .into(),
            }),
        }
    }

    pub fn begin(&mut self, account_id: &str) -> Result<RecoverySetup> {
        if load_secrets(account_id)?.is_some() {
            return Err(SyncCryptoError::Invalid(
                "encrypted sync is already protected on this device".into(),
            ));
        }
        if self
            .pending
            .as_ref()
            .is_none_or(|pending| pending.account_id != account_id)
        {
            self.pending = Some(PendingProtection::new(account_id)?);
        }
        self.pending
            .as_ref()
            .ok_or(SyncCryptoError::Corrupt)?
            .setup()
    }

    pub fn confirm(
        &mut self,
        account_id: &str,
        confirmations: &[RecoveryConfirmation],
    ) -> Result<SyncProtectionStatus> {
        let pending = self.pending.as_ref().ok_or_else(|| {
            SyncCryptoError::Invalid("start recovery-code setup before confirming words".into())
        })?;
        if pending.account_id != account_id {
            return Err(SyncCryptoError::Invalid(
                "the recovery setup belongs to a different account".into(),
            ));
        }
        if !confirmations_match(pending, confirmations)? {
            return Err(SyncCryptoError::Invalid(
                "one or more recovery words did not match".into(),
            ));
        }
        persist_pending(pending)?;
        let status = self.status(account_id)?;
        self.pending = None;
        Ok(status)
    }

    pub fn recover(&mut self, account_id: &str, phrase: &str) -> Result<SyncProtectionStatus> {
        if load_secrets(account_id)?.is_some() {
            return Err(SyncCryptoError::Invalid(
                "encrypted sync is already protected on this device".into(),
            ));
        }
        let account_key = account_key_from_phrase(phrase)?;
        let mut device_private_key = Zeroizing::new([0_u8; 32]);
        OsRng.fill_bytes(device_private_key.as_mut());
        let signing_private_key = Zeroizing::new(
            Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
                .map_err(|_| SyncCryptoError::Corrupt)?
                .as_ref()
                .to_vec(),
        );
        let pending = PendingProtection {
            account_id: account_id.to_string(),
            account_key,
            device_private_key,
            signing_private_key,
            device_id: Uuid::new_v4(),
            confirmation_positions: [1, 2, 3],
        };
        persist_pending(&pending)?;
        self.pending = None;
        self.status(account_id)
    }

    pub fn begin_existing_device_approval(&self, account_id: &str) -> Result<ExistingDeviceSetup> {
        if load_secrets(account_id)?.is_some() {
            return Err(SyncCryptoError::Invalid(
                "encrypted sync is already protected on this device".into(),
            ));
        }
        let pending = match load_pending_device(account_id)? {
            Some(pending) => pending,
            None => {
                let mut device_private_key = Zeroizing::new([0_u8; 32]);
                OsRng.fill_bytes(device_private_key.as_mut());
                let signing_private_key = Zeroizing::new(
                    Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
                        .map_err(|_| SyncCryptoError::Corrupt)?
                        .as_ref()
                        .to_vec(),
                );
                let pending = PersistedPendingDevice {
                    version: SECRET_VERSION,
                    account_id: account_id.into(),
                    device_id: Uuid::new_v4().to_string(),
                    device_private_key: URL_SAFE_NO_PAD.encode(&device_private_key[..]),
                    signing_private_key: URL_SAFE_NO_PAD.encode(&signing_private_key[..]),
                };
                persist_pending_device(&pending)?;
                pending
            }
        };
        pending_device_setup(&pending)
    }

    pub fn accept_existing_device_approval(
        &self,
        account_id: &str,
        received: &ReceivedDeviceApproval,
    ) -> Result<SyncProtectionStatus> {
        if load_secrets(account_id)?.is_some() {
            return self.status(account_id);
        }
        let pending = load_pending_device(account_id)?.ok_or_else(|| {
            SyncCryptoError::Invalid(
                "request approval from this device before checking again".into(),
            )
        })?;
        let target_device_id =
            Uuid::parse_str(&pending.device_id).map_err(|_| SyncCryptoError::Corrupt)?;
        let target_private = Zeroizing::new(decode_key(&pending.device_private_key)?);
        let account_key = unwrap_device_approval(target_device_id, &target_private, received)?;
        let secrets = PersistedSyncSecrets {
            version: SECRET_VERSION,
            account_id: account_id.into(),
            device_id: pending.device_id.clone(),
            account_key: URL_SAFE_NO_PAD.encode(account_key),
            device_private_key: pending.device_private_key.clone(),
            signing_private_key: pending.signing_private_key.clone(),
        };
        persist_secrets(&secrets)?;
        pending_credential_entry(account_id)?
            .delete_credential()
            .or_else(|error| match error {
                keyring::Error::NoEntry => Ok(()),
                other => Err(other),
            })?;
        self.status(account_id)
    }

    pub fn cancel(&mut self) {
        self.pending = None;
    }

    pub(crate) fn key_material(&self, account_id: &str) -> Result<SyncKeyMaterial> {
        let secrets = load_secrets(account_id)?.ok_or_else(|| {
            SyncCryptoError::Invalid("protect encrypted sync with a recovery code first".into())
        })?;
        let account_key = Zeroizing::new(decode_key(&secrets.account_key)?);
        let device_private_key = Zeroizing::new(decode_key(&secrets.device_private_key)?);
        let signing_private_key = Zeroizing::new(
            URL_SAFE_NO_PAD
                .decode(&secrets.signing_private_key)
                .map_err(|_| SyncCryptoError::Corrupt)?,
        );
        let signing_pair = Ed25519KeyPair::from_pkcs8(signing_private_key.as_slice())
            .map_err(|_| SyncCryptoError::Corrupt)?;
        let device_id =
            Uuid::parse_str(&secrets.device_id).map_err(|_| SyncCryptoError::Corrupt)?;
        Ok(SyncKeyMaterial {
            account_key,
            device_id,
            public_key: public_key(&device_private_key),
            signing_public_key: URL_SAFE_NO_PAD.encode(signing_pair.public_key().as_ref()),
            device_private_key,
            signing_private_key,
        })
    }
}

fn unwrap_device_approval(
    target_device_id: Uuid,
    target_private: &[u8; 32],
    received: &ReceivedDeviceApproval,
) -> Result<[u8; 32]> {
    if received.envelope.target_device_id != target_device_id
        || received.envelope.sender_device_id == target_device_id
    {
        return Err(SyncCryptoError::Invalid(
            "the approval envelope targets a different device".into(),
        ));
    }
    let created_at = chrono::DateTime::parse_from_rfc3339(&received.envelope.created_at)
        .map_err(|_| SyncCryptoError::Corrupt)?
        .with_timezone(&Utc);
    let expires_at = chrono::DateTime::parse_from_rfc3339(&received.envelope.expires_at)
        .map_err(|_| SyncCryptoError::Corrupt)?
        .with_timezone(&Utc);
    if expires_at <= Utc::now()
        || created_at > Utc::now() + Duration::minutes(1)
        || expires_at - created_at > Duration::minutes(15)
    {
        return Err(SyncCryptoError::Invalid(
            "the device approval has expired or has an invalid lifetime".into(),
        ));
    }
    let unsigned = UnsignedDeviceApproval {
        envelope_id: received.envelope.envelope_id,
        target_device_id,
        sender_device_id: received.envelope.sender_device_id,
        encrypted_account_key: &received.envelope.encrypted_account_key,
        created_at: &received.envelope.created_at,
        expires_at: &received.envelope.expires_at,
    };
    let message = serde_json::to_vec(&unsigned).map_err(|_| SyncCryptoError::Corrupt)?;
    let signing_public_key = URL_SAFE_NO_PAD
        .decode(&received.sender_signing_public_key)
        .map_err(|_| SyncCryptoError::Corrupt)?;
    UnparsedPublicKey::new(&ED25519, signing_public_key)
        .verify(
            &message,
            &URL_SAFE_NO_PAD
                .decode(&received.envelope.signature)
                .map_err(|_| SyncCryptoError::Corrupt)?,
        )
        .map_err(|_| SyncCryptoError::Invalid("the device approval signature is invalid".into()))?;
    let sender_public: [u8; 32] = URL_SAFE_NO_PAD
        .decode(&received.sender_public_key)
        .map_err(|_| SyncCryptoError::Corrupt)?
        .try_into()
        .map_err(|_| SyncCryptoError::Corrupt)?;
    let shared =
        StaticSecret::from(*target_private).diffie_hellman(&PublicKey::from(sender_public));
    let mut digest = Sha256::new();
    digest.update(b"student-center.device-approval.v1");
    digest.update(shared.as_bytes());
    digest.update(received.envelope.sender_device_id.as_bytes());
    digest.update(target_device_id.as_bytes());
    let wrapping_key: [u8; 32] = digest.finalize().into();
    let wrapped = URL_SAFE_NO_PAD
        .decode(&received.envelope.encrypted_account_key)
        .map_err(|_| SyncCryptoError::Corrupt)?;
    if wrapped.len() < 40 {
        return Err(SyncCryptoError::Corrupt);
    }
    let plaintext = Zeroizing::new(
        XChaCha20Poly1305::new_from_slice(&wrapping_key)
            .map_err(|_| SyncCryptoError::Corrupt)?
            .decrypt(XNonce::from_slice(&wrapped[..24]), &wrapped[24..])
            .map_err(|_| {
                SyncCryptoError::Invalid("the device approval could not be decrypted".into())
            })?,
    );
    plaintext
        .as_slice()
        .try_into()
        .map_err(|_| SyncCryptoError::Corrupt)
}

fn validate_account_id(account_id: &str) -> Result<()> {
    Uuid::parse_str(account_id)
        .map(|_| ())
        .map_err(|_| SyncCryptoError::Invalid("sign in with a valid account first".into()))
}

fn credential_entry(account_id: &str) -> Result<keyring::Entry> {
    validate_account_id(account_id)?;
    Ok(keyring::Entry::new(
        CREDENTIAL_SERVICE,
        &format!("{CREDENTIAL_PREFIX}:{account_id}"),
    )?)
}

fn pending_credential_entry(account_id: &str) -> Result<keyring::Entry> {
    validate_account_id(account_id)?;
    Ok(keyring::Entry::new(
        CREDENTIAL_SERVICE,
        &format!("{PENDING_CREDENTIAL_PREFIX}:{account_id}"),
    )?)
}

fn load_pending_device(account_id: &str) -> Result<Option<PersistedPendingDevice>> {
    let serialized = match pending_credential_entry(account_id)?.get_password() {
        Ok(value) => Zeroizing::new(value),
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let pending: PersistedPendingDevice =
        serde_json::from_str(&serialized).map_err(|_| SyncCryptoError::Corrupt)?;
    if pending.version != SECRET_VERSION
        || pending.account_id != account_id
        || Uuid::parse_str(&pending.device_id).is_err()
        || decode_key(&pending.device_private_key).is_err()
        || URL_SAFE_NO_PAD
            .decode(&pending.signing_private_key)
            .ok()
            .and_then(|value| Ed25519KeyPair::from_pkcs8(&value).ok())
            .is_none()
    {
        return Err(SyncCryptoError::Corrupt);
    }
    Ok(Some(pending))
}

fn persist_pending_device(pending: &PersistedPendingDevice) -> Result<()> {
    let serialized =
        Zeroizing::new(serde_json::to_string(pending).map_err(|_| SyncCryptoError::Corrupt)?);
    pending_credential_entry(&pending.account_id)?.set_password(&serialized)?;
    Ok(())
}

fn pending_device_setup(pending: &PersistedPendingDevice) -> Result<ExistingDeviceSetup> {
    let private = Zeroizing::new(decode_key(&pending.device_private_key)?);
    let signing = URL_SAFE_NO_PAD
        .decode(&pending.signing_private_key)
        .map_err(|_| SyncCryptoError::Corrupt)?;
    let signing = Ed25519KeyPair::from_pkcs8(&signing).map_err(|_| SyncCryptoError::Corrupt)?;
    Ok(ExistingDeviceSetup {
        device_id: Uuid::parse_str(&pending.device_id).map_err(|_| SyncCryptoError::Corrupt)?,
        public_key: public_key(&private),
        signing_public_key: URL_SAFE_NO_PAD.encode(signing.public_key().as_ref()),
    })
}

fn public_key(device_private_key: &[u8; 32]) -> String {
    let private = StaticSecret::from(*device_private_key);
    let public = PublicKey::from(&private);
    URL_SAFE_NO_PAD.encode(public.as_bytes())
}

fn status_from_secrets(secrets: &PersistedSyncSecrets) -> SyncProtectionStatus {
    let private = decode_key(&secrets.device_private_key).ok();
    SyncProtectionStatus {
        protected: private.is_some(),
        account_id: secrets.account_id.clone(),
        device_id: Some(secrets.device_id.clone()),
        public_key: private.as_ref().map(public_key),
        message: if private.is_some() {
            "Recovery is protected on this device. Encrypted sync can be connected next.".into()
        } else {
            "The saved device credentials are invalid. Recovery setup must be repaired.".into()
        },
    }
}

fn decode_key(encoded: &str) -> Result<[u8; 32]> {
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| SyncCryptoError::Corrupt)?;
    decoded.try_into().map_err(|_| SyncCryptoError::Corrupt)
}

fn load_secrets(account_id: &str) -> Result<Option<PersistedSyncSecrets>> {
    let entry = credential_entry(account_id)?;
    let serialized = match entry.get_password() {
        Ok(value) => Zeroizing::new(value),
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if serialized.len() > 4096 {
        return Err(SyncCryptoError::Corrupt);
    }
    let mut secrets: PersistedSyncSecrets =
        serde_json::from_str(&serialized).map_err(|_| SyncCryptoError::Corrupt)?;
    if secrets.version == 1 && secrets.signing_private_key.is_empty() {
        let signing = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .map_err(|_| SyncCryptoError::Corrupt)?;
        secrets.signing_private_key = URL_SAFE_NO_PAD.encode(signing.as_ref());
        secrets.version = SECRET_VERSION;
        let migrated =
            Zeroizing::new(serde_json::to_string(&secrets).map_err(|_| SyncCryptoError::Corrupt)?);
        entry.set_password(&migrated)?;
    }
    if secrets.version != SECRET_VERSION
        || secrets.account_id != account_id
        || Uuid::parse_str(&secrets.device_id).is_err()
        || decode_key(&secrets.account_key).is_err()
        || decode_key(&secrets.device_private_key).is_err()
        || URL_SAFE_NO_PAD
            .decode(&secrets.signing_private_key)
            .ok()
            .and_then(|value| Ed25519KeyPair::from_pkcs8(&value).ok())
            .is_none()
    {
        return Err(SyncCryptoError::Corrupt);
    }
    Ok(Some(secrets))
}

fn persist_pending(pending: &PendingProtection) -> Result<()> {
    let secrets = PersistedSyncSecrets {
        version: SECRET_VERSION,
        account_id: pending.account_id.clone(),
        device_id: pending.device_id.to_string(),
        account_key: URL_SAFE_NO_PAD.encode(&pending.account_key[..]),
        device_private_key: URL_SAFE_NO_PAD.encode(&pending.device_private_key[..]),
        signing_private_key: URL_SAFE_NO_PAD.encode(&pending.signing_private_key[..]),
    };
    persist_secrets(&secrets)
}

fn persist_secrets(secrets: &PersistedSyncSecrets) -> Result<()> {
    let serialized =
        Zeroizing::new(serde_json::to_string(&secrets).map_err(|_| SyncCryptoError::Corrupt)?);
    credential_entry(&secrets.account_id)?.set_password(&serialized)?;
    Ok(())
}

fn confirmations_match(
    pending: &PendingProtection,
    confirmations: &[RecoveryConfirmation],
) -> Result<bool> {
    if confirmations.len() != CONFIRMATION_COUNT {
        return Ok(false);
    }
    let supplied = confirmations
        .iter()
        .map(|confirmation| {
            if !(1..=RECOVERY_WORDS as u8).contains(&confirmation.position)
                || confirmation.word.len() > 16
            {
                return Err(SyncCryptoError::Invalid(
                    "recovery confirmation is invalid".into(),
                ));
            }
            Ok((
                confirmation.position,
                confirmation.word.trim().to_ascii_lowercase(),
            ))
        })
        .collect::<Result<BTreeMap<_, _>>>()?;
    if supplied.len() != CONFIRMATION_COUNT
        || !pending
            .confirmation_positions
            .iter()
            .all(|position| supplied.contains_key(position))
    {
        return Ok(false);
    }
    let words = pending.mnemonic()?.words().collect::<Vec<_>>();
    Ok(pending.confirmation_positions.iter().all(|position| {
        supplied.get(position).map(String::as_str) == Some(words[*position as usize - 1])
    }))
}

fn account_key_from_phrase(phrase: &str) -> Result<Zeroizing<[u8; 32]>> {
    if phrase.len() > 512 || phrase.chars().any(char::is_control) {
        return Err(SyncCryptoError::Invalid(
            "enter a valid 24-word recovery code".into(),
        ));
    }
    let normalized = phrase
        .split_whitespace()
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>()
        .join(" ");
    let mnemonic = Mnemonic::parse_in_normalized(Language::English, &normalized)
        .map_err(|_| SyncCryptoError::Invalid("enter a valid 24-word recovery code".into()))?;
    if mnemonic.word_count() != RECOVERY_WORDS {
        return Err(SyncCryptoError::Invalid(
            "enter all 24 recovery words".into(),
        ));
    }
    let mut entropy = mnemonic.to_entropy();
    let key: [u8; 32] = entropy
        .as_slice()
        .try_into()
        .map_err(|_| SyncCryptoError::Corrupt)?;
    entropy.zeroize();
    Ok(Zeroizing::new(key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{UnparsedPublicKey, ED25519};

    #[test]
    fn recovery_setup_is_24_words_and_round_trips_the_account_key() {
        let pending = PendingProtection::new("11111111-1111-4111-8111-111111111111").unwrap();
        let setup = pending.setup().unwrap();
        assert_eq!(setup.words.len(), 24);
        assert_eq!(setup.confirmation_positions.len(), 3);
        let recovered = account_key_from_phrase(&setup.words.join(" ")).unwrap();
        assert_eq!(&recovered[..], &pending.account_key[..]);
    }

    #[test]
    fn confirmation_positions_are_unique_and_exact_words_are_required() {
        let pending = PendingProtection::new("11111111-1111-4111-8111-111111111111").unwrap();
        let setup = pending.setup().unwrap();
        let mut positions = setup.confirmation_positions.clone();
        positions.sort_unstable();
        positions.dedup();
        assert_eq!(positions.len(), 3);
        let confirmations = setup
            .confirmation_positions
            .iter()
            .map(|position| RecoveryConfirmation {
                position: *position,
                word: setup.words[*position as usize - 1].clone(),
            })
            .collect::<Vec<_>>();
        assert!(confirmations_match(&pending, &confirmations).unwrap());
        let mut wrong = confirmations;
        wrong[0].word = "wrong".into();
        assert!(!confirmations_match(&pending, &wrong).unwrap());
    }

    #[test]
    fn device_approval_envelope_is_expiring_encrypted_and_signed() {
        let signing = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let pair = Ed25519KeyPair::from_pkcs8(signing.as_ref()).unwrap();
        let sender = SyncKeyMaterial {
            account_key: Zeroizing::new([9_u8; 32]),
            device_id: Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap(),
            public_key: public_key(&[3_u8; 32]),
            signing_public_key: URL_SAFE_NO_PAD.encode(pair.public_key().as_ref()),
            device_private_key: Zeroizing::new([3_u8; 32]),
            signing_private_key: Zeroizing::new(signing.as_ref().to_vec()),
        };
        let target_private = [4_u8; 32];
        let target_id = Uuid::parse_str("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").unwrap();
        let envelope = sender
            .approve_device(target_id, &public_key(&target_private))
            .unwrap();
        assert!(!envelope
            .encrypted_account_key
            .contains(&URL_SAFE_NO_PAD.encode([9_u8; 32])));
        let unsigned = UnsignedDeviceApproval {
            envelope_id: envelope.envelope_id,
            target_device_id: envelope.target_device_id,
            sender_device_id: envelope.sender_device_id,
            encrypted_account_key: &envelope.encrypted_account_key,
            created_at: &envelope.created_at,
            expires_at: &envelope.expires_at,
        };
        let message = serde_json::to_vec(&unsigned).unwrap();
        UnparsedPublicKey::new(
            &ED25519,
            URL_SAFE_NO_PAD.decode(&sender.signing_public_key).unwrap(),
        )
        .verify(
            &message,
            &URL_SAFE_NO_PAD.decode(&envelope.signature).unwrap(),
        )
        .unwrap();
        assert!(
            chrono::DateTime::parse_from_rfc3339(&envelope.expires_at).unwrap()
                > chrono::DateTime::parse_from_rfc3339(&envelope.created_at).unwrap()
        );
        let received = ReceivedDeviceApproval {
            envelope: envelope.clone(),
            sender_public_key: sender.public_key.clone(),
            sender_signing_public_key: sender.signing_public_key.clone(),
        };
        assert_eq!(
            unwrap_device_approval(target_id, &target_private, &received).unwrap(),
            [9_u8; 32]
        );
        let mut tampered = received;
        tampered.envelope.signature = URL_SAFE_NO_PAD.encode([0_u8; 64]);
        assert!(unwrap_device_approval(target_id, &target_private, &tampered).is_err());
    }

    #[test]
    fn public_status_never_serializes_secret_material() {
        let pending = PendingProtection::new("11111111-1111-4111-8111-111111111111").unwrap();
        let status = SyncProtectionStatus {
            protected: true,
            account_id: pending.account_id.clone(),
            device_id: Some(pending.device_id.to_string()),
            public_key: Some(public_key(&pending.device_private_key)),
            message: "protected".into(),
        };
        let serialized = serde_json::to_string(&status).unwrap();
        assert!(!serialized.contains("account_key"));
        assert!(!serialized.contains("accountKey"));
        assert!(!serialized.contains("private"));
        assert!(!serialized.contains(&URL_SAFE_NO_PAD.encode(&pending.account_key[..])));
    }
}
