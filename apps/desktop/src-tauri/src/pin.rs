use crate::{decrypt, encrypt, AppError, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;
use zeroize::Zeroizing;

const CONFIG_VERSION: u32 = 1;
const MEMORY_KIB: u32 = 65_536;
const ITERATIONS: u32 = 3;
const PARALLELISM: u32 = 1;
const KEY_BYTES: usize = 32;
const SALT_BYTES: usize = 16;
const PIN_FILE: &str = "pin.json";
const PREVIOUS_PIN_FILE: &str = "pin.json.previous";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PinEnvelope {
    pub version: u32,
    pub algorithm: String,
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
    pub salt: String,
    pub nonce: String,
    pub wrapped_master_key: String,
}

fn config_path(root: &Path) -> PathBuf {
    root.join(PIN_FILE)
}

fn previous_path(root: &Path) -> PathBuf {
    root.join(PREVIOUS_PIN_FILE)
}

pub fn validate_pin(pin: &str) -> Result<()> {
    if !(6..=128).contains(&pin.chars().count()) {
        return Err(AppError::Invalid(
            "Student Center PIN must be between 6 and 128 characters".into(),
        ));
    }
    Ok(())
}

fn derive_key(pin: &str, envelope: &PinEnvelope) -> Result<Zeroizing<[u8; KEY_BYTES]>> {
    if envelope.version != CONFIG_VERSION || envelope.algorithm != "argon2id-v1.3" {
        return Err(AppError::Invalid(
            "unsupported Student Center PIN format".into(),
        ));
    }
    if envelope.memory_kib < 19_456
        || envelope.memory_kib > 1_048_576
        || envelope.iterations == 0
        || envelope.iterations > 20
        || envelope.parallelism == 0
        || envelope.parallelism > 16
    {
        return Err(AppError::Invalid(
            "unsafe Student Center PIN parameters".into(),
        ));
    }
    let salt = B64
        .decode(&envelope.salt)
        .map_err(|_| AppError::Invalid("invalid Student Center PIN salt".into()))?;
    if salt.len() != SALT_BYTES {
        return Err(AppError::Invalid("invalid Student Center PIN salt".into()));
    }
    let params = Params::new(
        envelope.memory_kib,
        envelope.iterations,
        envelope.parallelism,
        Some(KEY_BYTES),
    )
    .map_err(|error| AppError::Invalid(format!("invalid PIN parameters: {error}")))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0_u8; KEY_BYTES]);
    argon2
        .hash_password_into(pin.as_bytes(), &salt, key.as_mut())
        .map_err(|error| AppError::Invalid(format!("could not derive PIN key: {error}")))?;
    Ok(key)
}

pub fn create(pin: &str, master_key: &[u8; KEY_BYTES]) -> Result<PinEnvelope> {
    validate_pin(pin)?;
    let mut salt = [0_u8; SALT_BYTES];
    OsRng.fill_bytes(&mut salt);
    let mut envelope = PinEnvelope {
        version: CONFIG_VERSION,
        algorithm: "argon2id-v1.3".into(),
        memory_kib: MEMORY_KIB,
        iterations: ITERATIONS,
        parallelism: PARALLELISM,
        salt: B64.encode(salt),
        nonce: String::new(),
        wrapped_master_key: String::new(),
    };
    let derived = derive_key(pin, &envelope)?;
    let (wrapped, nonce) = encrypt(&derived, master_key)?;
    envelope.nonce = B64.encode(nonce);
    envelope.wrapped_master_key = B64.encode(wrapped);
    Ok(envelope)
}

pub fn verify(envelope: &PinEnvelope, pin: &str, master_key: &[u8; KEY_BYTES]) -> Result<bool> {
    let derived = derive_key(pin, envelope)?;
    let nonce = B64
        .decode(&envelope.nonce)
        .map_err(|_| AppError::Invalid("invalid Student Center PIN nonce".into()))?;
    let nonce: [u8; 24] = nonce
        .try_into()
        .map_err(|_| AppError::Invalid("invalid Student Center PIN nonce".into()))?;
    let wrapped = B64
        .decode(&envelope.wrapped_master_key)
        .map_err(|_| AppError::Invalid("invalid wrapped Student Center key".into()))?;
    match decrypt(&derived, &nonce, &wrapped) {
        Ok(candidate) => Ok(candidate.as_slice() == master_key),
        Err(AppError::Crypto) => Ok(false),
        Err(error) => Err(error),
    }
}

pub fn is_enabled(root: &Path) -> bool {
    config_path(root).is_file()
}

pub fn read(root: &Path) -> Result<PinEnvelope> {
    let bytes = fs::read(config_path(root))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| AppError::Invalid(format!("invalid Student Center PIN file: {error}")))
}

pub fn write_atomic(root: &Path, envelope: &PinEnvelope) -> Result<()> {
    fs::create_dir_all(root)?;
    let destination = config_path(root);
    let previous = previous_path(root);
    let temporary = root.join(format!("pin-{}.tmp", Uuid::new_v4()));
    let serialized = serde_json::to_vec_pretty(envelope)
        .map_err(|error| AppError::Invalid(format!("could not encode PIN settings: {error}")))?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    file.write_all(&serialized)?;
    file.sync_all()?;
    drop(file);

    if previous.exists() {
        fs::remove_file(&previous)?;
    }
    if destination.exists() {
        fs::rename(&destination, &previous)?;
    }
    if let Err(error) = fs::rename(&temporary, &destination) {
        if previous.exists() {
            let _ = fs::rename(&previous, &destination);
        }
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    if previous.exists() {
        fs::remove_file(previous)?;
    }
    Ok(())
}

pub fn remove(root: &Path) -> Result<()> {
    let destination = config_path(root);
    if destination.exists() {
        fs::remove_file(destination)?;
    }
    let previous = previous_path(root);
    if previous.exists() {
        fs::remove_file(previous)?;
    }
    Ok(())
}

pub fn recover_interrupted_update(root: &Path) -> Result<()> {
    let destination = config_path(root);
    let previous = previous_path(root);
    if !destination.exists() && previous.exists() {
        fs::rename(previous, destination)?;
    } else if destination.exists() && previous.exists() {
        fs::remove_file(previous)?;
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("pin-") && name.ends_with(".tmp") && entry.file_type()?.is_file() {
            fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pin_envelope_round_trips_and_rejects_wrong_pin() {
        let key = [42_u8; 32];
        let envelope = create("correct horse", &key).unwrap();
        assert!(verify(&envelope, "correct horse", &key).unwrap());
        assert!(!verify(&envelope, "wrong battery", &key).unwrap());
        let encoded = serde_json::to_string(&envelope).unwrap();
        assert!(!encoded.contains("correct horse"));
        assert!(!encoded.contains(&B64.encode(key)));
    }

    #[test]
    fn atomic_pin_update_recovers_previous_file() {
        let root = tempfile::tempdir().unwrap();
        let old = create("first pin", &[1_u8; 32]).unwrap();
        write_atomic(root.path(), &old).unwrap();
        fs::rename(config_path(root.path()), previous_path(root.path())).unwrap();
        recover_interrupted_update(root.path()).unwrap();
        assert!(verify(&read(root.path()).unwrap(), "first pin", &[1_u8; 32]).unwrap());
    }

    #[test]
    fn pin_policy_rejects_short_values() {
        assert!(validate_pin("12345").is_err());
        assert!(validate_pin("123456").is_ok());
    }
}
