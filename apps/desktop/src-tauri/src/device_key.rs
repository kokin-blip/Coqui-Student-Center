use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::{rngs::OsRng, RngCore};
use std::{fs, path::Path};
use zeroize::Zeroizing;

const CREDENTIAL_SERVICE: &str = "app.studentcenter.desktop";
const CREDENTIAL_NAME: &str = "device-master-key";
const PROTECTED_KEY_FILE: &str = "device-master-key.dpapi";

#[derive(Debug, thiserror::Error)]
pub enum DeviceKeyError {
    #[error("file error: {0}")]
    Io(#[from] std::io::Error),
    #[error("credential store error: {0}")]
    Credential(#[from] keyring::Error),
    #[error("operating-system key protection failed: {0}")]
    Platform(String),
    #[error("the protected device key is invalid")]
    Invalid,
    #[error(
        "the existing encrypted profile needs its original Windows credential; sign in to Windows and try again"
    )]
    LegacyCredentialUnavailable,
}

pub type Result<T> = std::result::Result<T, DeviceKeyError>;

fn random_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    key
}

fn decode_key(encoded: &str) -> Option<[u8; 32]> {
    let bytes = Zeroizing::new(B64.decode(encoded).ok()?);
    if bytes.len() != 32 {
        return None;
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Some(key)
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use std::{io::Write, slice};
    use windows::{
        core::w,
        Win32::{
            Foundation::{LocalFree, HLOCAL},
            Security::Cryptography::{
                CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
            },
        },
    };

    fn protect(bytes: &[u8]) -> Result<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: bytes
                .len()
                .try_into()
                .map_err(|_| DeviceKeyError::Invalid)?,
            pbData: bytes.as_ptr().cast_mut(),
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptProtectData(
                &input,
                w!("Student Center device master key"),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
            .map_err(|error| DeviceKeyError::Platform(error.to_string()))?;
            let protected = slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
            let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
            Ok(protected)
        }
    }

    fn unprotect(bytes: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: bytes
                .len()
                .try_into()
                .map_err(|_| DeviceKeyError::Invalid)?,
            pbData: bytes.as_ptr().cast_mut(),
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptUnprotectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
            .map_err(|error| DeviceKeyError::Platform(error.to_string()))?;
            let plain = Zeroizing::new(
                slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec(),
            );
            let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
            Ok(plain)
        }
    }

    fn read_protected(root: &Path) -> Result<Option<[u8; 32]>> {
        let path = root.join(PROTECTED_KEY_FILE);
        if !path.exists() {
            return Ok(None);
        }
        let protected = fs::read(path)?;
        let plain = unprotect(&protected)?;
        if plain.len() != 32 {
            return Err(DeviceKeyError::Invalid);
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&plain);
        Ok(Some(key))
    }

    fn write_protected(root: &Path, key: &[u8; 32]) -> Result<()> {
        let protected = protect(key)?;
        let path = root.join(PROTECTED_KEY_FILE);
        let temporary = root.join(format!(".{PROTECTED_KEY_FILE}.tmp"));
        let mut file = fs::File::create(&temporary)?;
        file.write_all(&protected)?;
        file.sync_all()?;
        fs::rename(&temporary, &path)?;
        Ok(())
    }

    pub fn load_or_create(root: &Path, encrypted_profile_exists: bool) -> Result<[u8; 32]> {
        if let Some(key) = read_protected(root)? {
            return Ok(key);
        }

        let entry = keyring::Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_NAME)?;
        match entry.get_password() {
            Ok(encoded) => {
                let key = decode_key(&encoded).ok_or(DeviceKeyError::Invalid)?;
                write_protected(root, &key)?;
                return Ok(key);
            }
            Err(keyring::Error::NoEntry) => {}
            Err(_) if encrypted_profile_exists => {
                return Err(DeviceKeyError::LegacyCredentialUnavailable);
            }
            Err(_) => {}
        }

        if encrypted_profile_exists {
            return Err(DeviceKeyError::LegacyCredentialUnavailable);
        }

        let key = random_key();
        write_protected(root, &key)?;
        // Credential Manager remains a best-effort compatibility copy. DPAPI is
        // authoritative on Windows because it also works in restricted launch contexts.
        let _ = entry.set_password(&B64.encode(key));
        Ok(key)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn dpapi_key_is_persistent_and_never_stored_as_plaintext() {
            let root = tempfile::tempdir().unwrap();
            let first = load_or_create(root.path(), false).unwrap();
            let protected = fs::read(root.path().join(PROTECTED_KEY_FILE)).unwrap();
            assert!(!protected.windows(first.len()).any(|window| window == first));
            assert_eq!(load_or_create(root.path(), false).unwrap(), first);
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use super::*;

    pub fn load_or_create(_root: &Path, _encrypted_profile_exists: bool) -> Result<[u8; 32]> {
        let entry = keyring::Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_NAME)?;
        if let Ok(encoded) = entry.get_password() {
            if let Some(key) = decode_key(&encoded) {
                return Ok(key);
            }
        }
        let key = random_key();
        entry.set_password(&B64.encode(key))?;
        Ok(key)
    }
}

pub use platform::load_or_create;
