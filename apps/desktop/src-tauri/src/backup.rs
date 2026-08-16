use super::{AppError, Result};
use age::{scrypt, secrecy::SecretString, Decryptor, Encryptor};
use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
};
use tar::{Archive, Builder, Header};
use uuid::Uuid;
use zeroize::Zeroize;

const ARCHIVE_FORMAT: &str = "student-center-backup";
const ARCHIVE_SCHEMA: u32 = 1;
const MAX_ARCHIVE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_DATABASE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_VAULT_OBJECTS: usize = 10_000;
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultObject {
    pub document_id: String,
    pub entry: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveCounts {
    pub tasks: i64,
    pub commitments: i64,
    pub courses: i64,
    pub documents: i64,
    pub pending_candidates: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveManifest {
    pub format: String,
    pub schema_version: u32,
    pub app_version: String,
    pub archive_id: String,
    pub created_at: String,
    pub student_name: String,
    pub timezone: String,
    pub database_sha256: String,
    pub database_size: u64,
    pub counts: ArchiveCounts,
    pub vault_objects: Vec<VaultObject>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreview {
    pub fingerprint: String,
    pub archive_id: String,
    pub created_at: String,
    pub app_version: String,
    pub student_name: String,
    pub timezone: String,
    pub counts: ArchiveCounts,
    pub encrypted_bytes: u64,
}

pub struct StagedArchive {
    pub directory: PathBuf,
    pub database_path: PathBuf,
    pub vault_path: PathBuf,
    pub archived_key: [u8; 32],
    pub manifest: ArchiveManifest,
}

impl Drop for StagedArchive {
    fn drop(&mut self) {
        self.archived_key.zeroize();
    }
}

#[derive(Debug)]
struct DocumentSource {
    id: String,
    path: PathBuf,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Invalid(message.into())
}

fn validate_passphrase(passphrase: &str) -> Result<()> {
    if passphrase.chars().count() < 12 {
        return Err(invalid(
            "backup passphrase must contain at least 12 characters",
        ));
    }
    if passphrase.chars().count() > 1024 {
        return Err(invalid("backup passphrase is too long"));
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<(String, u64)> {
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        size = size
            .checked_add(read as u64)
            .ok_or_else(|| invalid("file size overflow"))?;
        hash.update(&buffer[..read]);
    }
    Ok((hex::encode(hash.finalize()), size))
}

fn table_count(conn: &Connection, table: &str, suffix: &str) -> Result<i64> {
    let allowed = [
        "tasks",
        "commitments",
        "courses",
        "documents",
        "import_candidates",
    ];
    if !allowed.contains(&table) {
        return Err(invalid("unsupported backup count"));
    }
    Ok(conn.query_row(
        &format!("SELECT COUNT(*) FROM {table} {suffix}"),
        [],
        |row| row.get(0),
    )?)
}

fn archive_counts(conn: &Connection) -> Result<ArchiveCounts> {
    Ok(ArchiveCounts {
        tasks: table_count(conn, "tasks", "")?,
        commitments: table_count(conn, "commitments", "")?,
        courses: table_count(conn, "courses", "")?,
        documents: table_count(conn, "documents", "")?,
        pending_candidates: table_count(conn, "import_candidates", "WHERE status='pending'")?,
    })
}

fn setting(conn: &Connection, key: &str) -> Result<String> {
    Ok(conn.query_row(
        "SELECT value FROM settings WHERE key=?1",
        params![key],
        |row| row.get(0),
    )?)
}

fn snapshot_database(conn: &Connection, path: &Path, key: &[u8; 32]) -> Result<()> {
    if path.exists() {
        return Err(invalid("backup snapshot destination already exists"));
    }
    conn.execute(
        "VACUUM INTO ?1",
        params![path.to_string_lossy().to_string()],
    )?;
    let snapshot = super::open_keyed_database(path, key)?;
    let integrity: String = snapshot.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(invalid(format!(
            "database snapshot failed integrity check: {integrity}"
        )));
    }
    drop(snapshot);
    Ok(())
}

fn local_documents(conn: &Connection, vault: &Path) -> Result<Vec<DocumentSource>> {
    let expected_vault = vault.canonicalize()?;
    let mut statement =
        conn.prepare("SELECT id,vault_path FROM documents WHERE vault_path!='' ORDER BY id")?;
    let rows = statement
        .query_map([], |row| {
            Ok(DocumentSource {
                id: row.get(0)?,
                path: PathBuf::from(row.get::<_, String>(1)?),
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if rows.len() > MAX_VAULT_OBJECTS {
        return Err(invalid(
            "the document vault contains too many objects to export",
        ));
    }
    for row in &rows {
        if !row.path.is_file() {
            return Err(invalid(format!(
                "encrypted vault object is missing for document {}",
                row.id
            )));
        }
        let parent = row
            .path
            .parent()
            .ok_or_else(|| invalid("invalid vault object path"))?
            .canonicalize()?;
        if parent != expected_vault {
            return Err(invalid("a document points outside the managed vault"));
        }
    }
    Ok(rows)
}

fn tar_header(size: u64) -> Result<Header> {
    let mut header = Header::new_gnu();
    header.set_size(size);
    header.set_mode(0o600);
    header.set_uid(0);
    header.set_gid(0);
    header.set_mtime(0);
    header.set_cksum();
    Ok(header)
}

fn append_bytes<W: Write>(builder: &mut Builder<W>, path: &str, bytes: &[u8]) -> Result<()> {
    builder.append_data(&mut tar_header(bytes.len() as u64)?, path, bytes)?;
    Ok(())
}

fn append_file<W: Write>(builder: &mut Builder<W>, path: &str, source: &Path) -> Result<()> {
    let mut file = File::open(source)?;
    let size = file.metadata()?.len();
    builder.append_data(&mut tar_header(size)?, path, &mut file)?;
    Ok(())
}

pub fn export_archive(
    conn: &Connection,
    root: &Path,
    vault: &Path,
    master_key: &[u8; 32],
    destination: &Path,
    passphrase: &str,
) -> Result<BackupPreview> {
    validate_passphrase(passphrase)?;
    if destination.exists() {
        return Err(invalid("the selected backup file already exists"));
    }
    if destination.extension().and_then(|value| value.to_str()) != Some("studentcenter") {
        return Err(invalid(
            "backup files must use the .studentcenter extension",
        ));
    }
    if let Ok(destination_parent) = destination
        .parent()
        .unwrap_or(Path::new("."))
        .canonicalize()
    {
        if destination_parent.starts_with(root.canonicalize()?) {
            return Err(invalid(
                "choose a backup destination outside Student Center's private data directory",
            ));
        }
    }

    let work = tempfile::Builder::new()
        .prefix("backup-export-")
        .tempdir_in(root)?;
    let snapshot_path = work.path().join("database.sqlite");
    snapshot_database(conn, &snapshot_path, master_key)?;
    let (database_sha256, database_size) = sha256_file(&snapshot_path)?;
    if database_size > MAX_DATABASE_BYTES {
        return Err(invalid("the encrypted database is too large to export"));
    }

    let documents = local_documents(conn, vault)?;
    let mut vault_objects = Vec::with_capacity(documents.len());
    for (index, document) in documents.iter().enumerate() {
        let (sha256, size) = sha256_file(&document.path)?;
        vault_objects.push(VaultObject {
            document_id: document.id.clone(),
            entry: format!("vault/{index:08}.vault"),
            size,
            sha256,
        });
    }
    let manifest = ArchiveManifest {
        format: ARCHIVE_FORMAT.into(),
        schema_version: ARCHIVE_SCHEMA,
        app_version: env!("CARGO_PKG_VERSION").into(),
        archive_id: Uuid::new_v4().to_string(),
        created_at: Utc::now().to_rfc3339(),
        student_name: setting(conn, "student_name")?,
        timezone: setting(conn, "timezone")?,
        database_sha256,
        database_size,
        counts: archive_counts(conn)?,
        vault_objects,
    };
    let manifest_bytes = serde_json::to_vec(&manifest)
        .map_err(|error| invalid(format!("could not encode backup manifest: {error}")))?;

    let partial = destination.with_extension(format!("studentcenter.{}.partial", Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial)?;
        let encryptor = Encryptor::with_user_passphrase(SecretString::from(passphrase.to_owned()));
        let encrypted = encryptor
            .wrap_output(output)
            .map_err(|error| invalid(format!("could not initialize backup encryption: {error}")))?;
        let mut archive = Builder::new(encrypted);
        append_bytes(&mut archive, "manifest.json", &manifest_bytes)?;
        append_bytes(&mut archive, "device-key.bin", master_key)?;
        append_file(&mut archive, "database.sqlite", &snapshot_path)?;
        for (document, object) in documents.iter().zip(&manifest.vault_objects) {
            append_file(&mut archive, &object.entry, &document.path)?;
        }
        let encrypted = archive.into_inner()?;
        let output = encrypted
            .finish()
            .map_err(|error| invalid(format!("could not finish backup encryption: {error}")))?;
        output.sync_all()?;
        let copy_result = (|| -> Result<()> {
            let mut source = File::open(&partial)?;
            let mut destination_file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(destination)?;
            io::copy(&mut source, &mut destination_file)?;
            destination_file.sync_all()?;
            Ok(())
        })();
        if let Err(error) = copy_result {
            let _ = fs::remove_file(destination);
            return Err(error);
        }
        fs::remove_file(&partial)?;
        Ok(())
    })();
    if result.is_err() && partial.is_file() {
        let _ = fs::remove_file(&partial);
    }
    result?;
    preview_archive(destination, passphrase)
}

fn validate_archive_path(path: &Path) -> Result<String> {
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(invalid("backup contains an unsafe entry path"));
    }
    let normalized = path
        .to_str()
        .ok_or_else(|| invalid("backup contains a non-Unicode entry path"))?
        .replace('\\', "/");
    Ok(normalized)
}

fn read_limited<R: Read>(reader: &mut R, size: u64, limit: u64) -> Result<Vec<u8>> {
    if size > limit {
        return Err(invalid("backup entry exceeds its allowed size"));
    }
    let mut bytes = Vec::with_capacity(size as usize);
    reader.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 != size {
        return Err(invalid("backup entry size does not match its header"));
    }
    Ok(bytes)
}

fn validate_manifest(manifest: &ArchiveManifest) -> Result<()> {
    if manifest.format != ARCHIVE_FORMAT || manifest.schema_version != ARCHIVE_SCHEMA {
        return Err(invalid("this is not a supported Student Center backup"));
    }
    if manifest.database_size == 0 || manifest.database_size > MAX_DATABASE_BYTES {
        return Err(invalid("backup database size is invalid"));
    }
    if manifest.vault_objects.len() > MAX_VAULT_OBJECTS {
        return Err(invalid("backup contains too many vault objects"));
    }
    let mut entries = HashSet::new();
    let mut documents = HashSet::new();
    for object in &manifest.vault_objects {
        if !object.entry.starts_with("vault/")
            || !object.entry.ends_with(".vault")
            || !entries.insert(object.entry.clone())
            || !documents.insert(object.document_id.clone())
        {
            return Err(invalid(
                "backup vault manifest contains duplicate or invalid objects",
            ));
        }
    }
    Ok(())
}

fn decrypt_archive(path: &Path, passphrase: &str) -> Result<Archive<impl Read>> {
    validate_passphrase(passphrase)?;
    if !path.is_file() {
        return Err(invalid("selected backup does not exist"));
    }
    let size = path.metadata()?.len();
    if size == 0 || size > MAX_ARCHIVE_BYTES {
        return Err(invalid(
            "backup file is empty or exceeds the 8 GB safety limit",
        ));
    }
    let decryptor = Decryptor::new(File::open(path)?)
        .map_err(|_| invalid("backup is damaged or the passphrase is incorrect"))?;
    let identity = scrypt::Identity::new(SecretString::from(passphrase.to_owned()));
    let reader = decryptor
        .decrypt(std::iter::once(&identity as &dyn age::Identity))
        .map_err(|_| invalid("backup is damaged or the passphrase is incorrect"))?;
    Ok(Archive::new(reader))
}

fn archive_fingerprint(path: &Path) -> Result<String> {
    Ok(sha256_file(path)?.0)
}

fn expected_entries(manifest: &ArchiveManifest) -> HashMap<String, (&str, u64)> {
    manifest
        .vault_objects
        .iter()
        .map(|object| (object.entry.clone(), (object.sha256.as_str(), object.size)))
        .collect()
}

pub fn preview_archive(path: &Path, passphrase: &str) -> Result<BackupPreview> {
    let fingerprint = archive_fingerprint(path)?;
    let encrypted_bytes = path.metadata()?.len();
    let mut archive = decrypt_archive(path, passphrase)?;
    let mut manifest: Option<ArchiveManifest> = None;
    let mut seen = HashSet::new();
    let mut saw_key = false;
    let mut saw_database = false;
    let mut vault_seen = HashSet::new();
    for entry in archive.entries()? {
        let mut entry = entry?;
        if !entry.header().entry_type().is_file() {
            return Err(invalid("backup contains a non-file entry"));
        }
        let name = validate_archive_path(&entry.path()?)?;
        if !seen.insert(name.clone()) {
            return Err(invalid("backup contains a duplicate entry"));
        }
        let size = entry.size();
        match name.as_str() {
            "manifest.json" => {
                if manifest.is_some() || seen.len() != 1 {
                    return Err(invalid("backup manifest is not the first entry"));
                }
                let bytes = read_limited(&mut entry, size, MAX_MANIFEST_BYTES)?;
                let parsed: ArchiveManifest = serde_json::from_slice(&bytes)
                    .map_err(|_| invalid("backup manifest is malformed"))?;
                validate_manifest(&parsed)?;
                manifest = Some(parsed);
            }
            "device-key.bin" => {
                if manifest.is_none() || size != 32 {
                    return Err(invalid("backup device key is invalid"));
                }
                let bytes = read_limited(&mut entry, size, 32)?;
                saw_key = bytes.len() == 32;
            }
            "database.sqlite" => {
                let current = manifest
                    .as_ref()
                    .ok_or_else(|| invalid("backup manifest is missing"))?;
                if size != current.database_size {
                    return Err(invalid("backup database size does not match its manifest"));
                }
                let mut hash = Sha256::new();
                io::copy(&mut entry, &mut HashWriter(&mut hash))?;
                if hex::encode(hash.finalize()) != current.database_sha256 {
                    return Err(invalid("backup database failed its integrity hash"));
                }
                saw_database = true;
            }
            _ => {
                let current = manifest
                    .as_ref()
                    .ok_or_else(|| invalid("backup manifest is missing"))?;
                let expected = expected_entries(current);
                let Some((sha256, expected_size)) = expected.get(&name) else {
                    return Err(invalid("backup contains an unexpected entry"));
                };
                if size != *expected_size {
                    return Err(invalid(
                        "backup vault object size does not match its manifest",
                    ));
                }
                let mut hash = Sha256::new();
                io::copy(&mut entry, &mut HashWriter(&mut hash))?;
                if hex::encode(hash.finalize()) != *sha256 {
                    return Err(invalid("backup vault object failed its integrity hash"));
                }
                vault_seen.insert(name);
            }
        }
    }
    let manifest = manifest.ok_or_else(|| invalid("backup manifest is missing"))?;
    if !saw_key || !saw_database || vault_seen.len() != manifest.vault_objects.len() {
        return Err(invalid("backup is incomplete"));
    }
    Ok(BackupPreview {
        fingerprint,
        archive_id: manifest.archive_id,
        created_at: manifest.created_at,
        app_version: manifest.app_version,
        student_name: manifest.student_name,
        timezone: manifest.timezone,
        counts: manifest.counts,
        encrypted_bytes,
    })
}

struct HashWriter<'a>(&'a mut Sha256);

impl Write for HashWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub fn stage_archive(
    root: &Path,
    source: &Path,
    passphrase: &str,
    expected_fingerprint: &str,
) -> Result<StagedArchive> {
    let fingerprint = archive_fingerprint(source)?;
    if fingerprint != expected_fingerprint {
        return Err(invalid(
            "backup changed after preview; preview it again before restoring",
        ));
    }
    let directory = root.join(format!("restore-stage-{}", Uuid::new_v4()));
    fs::create_dir(&directory)?;
    let vault_path = directory.join("vault");
    fs::create_dir(&vault_path)?;
    let database_path = directory.join("student-center.db");
    let extracted = (|| -> Result<(ArchiveManifest, [u8; 32])> {
        let mut archive = decrypt_archive(source, passphrase)?;
        let mut manifest: Option<ArchiveManifest> = None;
        let mut archived_key: Option<[u8; 32]> = None;
        let mut seen = HashSet::new();
        let mut vault_seen = HashSet::new();
        let mut saw_database = false;
        for entry in archive.entries()? {
            let mut entry = entry?;
            if !entry.header().entry_type().is_file() {
                return Err(invalid("backup contains a non-file entry"));
            }
            let name = validate_archive_path(&entry.path()?)?;
            if !seen.insert(name.clone()) {
                return Err(invalid("backup contains a duplicate entry"));
            }
            let size = entry.size();
            match name.as_str() {
                "manifest.json" => {
                    if manifest.is_some() || seen.len() != 1 {
                        return Err(invalid("backup manifest is not the first entry"));
                    }
                    let bytes = read_limited(&mut entry, size, MAX_MANIFEST_BYTES)?;
                    let parsed: ArchiveManifest = serde_json::from_slice(&bytes)
                        .map_err(|_| invalid("backup manifest is malformed"))?;
                    validate_manifest(&parsed)?;
                    manifest = Some(parsed);
                }
                "device-key.bin" => {
                    let bytes = read_limited(&mut entry, size, 32)?;
                    archived_key = Some(
                        bytes
                            .try_into()
                            .map_err(|_| invalid("backup device key is invalid"))?,
                    );
                }
                "database.sqlite" => {
                    let current = manifest
                        .as_ref()
                        .ok_or_else(|| invalid("backup manifest is missing"))?;
                    if size != current.database_size {
                        return Err(invalid("backup database size does not match its manifest"));
                    }
                    let mut output = OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&database_path)?;
                    let mut hash = Sha256::new();
                    copy_and_hash(&mut entry, &mut output, &mut hash)?;
                    output.sync_all()?;
                    if hex::encode(hash.finalize()) != current.database_sha256 {
                        return Err(invalid("backup database failed its integrity hash"));
                    }
                    saw_database = true;
                }
                _ => {
                    let current = manifest
                        .as_ref()
                        .ok_or_else(|| invalid("backup manifest is missing"))?;
                    let expected = expected_entries(current);
                    let Some((sha256, expected_size)) = expected.get(&name) else {
                        return Err(invalid("backup contains an unexpected entry"));
                    };
                    if size != *expected_size {
                        return Err(invalid(
                            "backup vault object size does not match its manifest",
                        ));
                    }
                    let file_name = Path::new(&name)
                        .file_name()
                        .ok_or_else(|| invalid("backup vault entry is invalid"))?;
                    let destination = vault_path.join(file_name);
                    let mut output = OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(destination)?;
                    let mut hash = Sha256::new();
                    copy_and_hash(&mut entry, &mut output, &mut hash)?;
                    output.sync_all()?;
                    if hex::encode(hash.finalize()) != *sha256 {
                        return Err(invalid("backup vault object failed its integrity hash"));
                    }
                    vault_seen.insert(name);
                }
            }
        }
        let manifest = manifest.ok_or_else(|| invalid("backup manifest is missing"))?;
        if !saw_database || vault_seen.len() != manifest.vault_objects.len() {
            return Err(invalid("backup is incomplete"));
        }
        let key = archived_key.ok_or_else(|| invalid("backup device key is missing"))?;
        Ok((manifest, key))
    })();
    match extracted {
        Ok((manifest, archived_key)) => Ok(StagedArchive {
            directory,
            database_path,
            vault_path,
            archived_key,
            manifest,
        }),
        Err(error) => {
            let _ = fs::remove_dir_all(&directory);
            Err(error)
        }
    }
}

fn copy_and_hash<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    hash: &mut Sha256,
) -> Result<u64> {
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        writer.write_all(&buffer[..read])?;
        hash.update(&buffer[..read]);
        total += read as u64;
    }
    Ok(total)
}
