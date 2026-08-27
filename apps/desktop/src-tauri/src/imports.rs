use calamine::{open_workbook_auto, Data, DataType, Reader};
use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use ical::{parser::ical::component::IcalEvent, property::Property, IcalParser};
use quick_xml::{events::Event, Reader as XmlReader};
use regex::Regex;
use rrule::RRuleSet;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    env, fs,
    io::{BufReader, Cursor, Read},
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    sync::{Arc, RwLock},
    thread,
    time::Duration as StdDuration,
};
use tempfile::tempdir;
use wait_timeout::ChildExt;
use zip::ZipArchive;

const MAX_ARCHIVE_ENTRIES: usize = 10_000;
const MAX_ARCHIVE_UNCOMPRESSED: u64 = 100 * 1024 * 1024;
const MAX_RECURRENCES: u16 = 512;
const MAX_OCR_PAGES: usize = 100;
const MAX_TOOL_OUTPUT: usize = 4 * 1024 * 1024;
/// Per-segment cap on retained word boxes.
///
/// A dense screenshot is a few thousand words and the geometry is cheap; a
/// hundred OCR'd PDF pages at the same rate is not, and only the first page of a
/// scan is ever a schedule. The text is unaffected either way — this bounds only
/// what the layout reader can see.
const MAX_OCR_TOKENS: usize = 20_000;
const PDF_RENDER_TIMEOUT: StdDuration = StdDuration::from_secs(60);
const OCR_PAGE_TIMEOUT: StdDuration = StdDuration::from_secs(45);
const RUNTIME_PROBE_TIMEOUT: StdDuration = StdDuration::from_secs(5);

#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("unsupported file type: {0}")]
    Unsupported(String),
    #[error("file contents do not match the .{extension} extension ({detected})")]
    TypeMismatch { extension: String, detected: String },
    #[error("malformed or corrupt document: {0}")]
    Malformed(String),
    #[error("encrypted documents require an unencrypted copy for local extraction")]
    Encrypted,
    #[error("local OCR is unavailable: {0}")]
    OcrUnavailable(String),
    #[error("document contains no extractable academic text")]
    Empty,
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocumentKind {
    Pdf,
    Image(&'static str),
    Docx,
    Xlsx,
    Csv,
    Pptx,
    Ics,
    Text,
}

impl DocumentKind {
    pub fn mime(&self) -> &'static str {
        match self {
            Self::Pdf => "application/pdf",
            Self::Image(mime) => mime,
            Self::Docx => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            Self::Xlsx => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            Self::Csv => "text/csv",
            Self::Pptx => {
                "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            }
            Self::Ics => "text/calendar",
            Self::Text => "text/plain",
        }
    }

    fn extension(&self) -> &'static str {
        match self {
            Self::Pdf => "pdf",
            Self::Image("image/jpeg") => "jpg",
            Self::Image("image/png") => "png",
            Self::Image("image/tiff") => "tiff",
            Self::Image(_) => "image",
            Self::Docx => "docx",
            Self::Xlsx => "xlsx",
            Self::Csv => "csv",
            Self::Pptx => "pptx",
            Self::Ics => "ics",
            Self::Text => "txt",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OcrPhase {
    Checking,
    Ready,
    Unavailable,
}

#[derive(Debug, Clone, Copy)]
struct OcrProbe {
    phase: OcrPhase,
    renderer_available: bool,
    engine_available: bool,
    english_data_available: bool,
}

#[derive(Debug, Clone)]
pub struct OcrRuntime {
    renderer_command: PathBuf,
    renderer_library: PathBuf,
    tesseract: PathBuf,
    tessdata: Option<PathBuf>,
    renderer_source: &'static str,
    engine_source: &'static str,
    renderer_installed: bool,
    engine_installed: bool,
    // Shared so every clone of AppState — including the ones handed to
    // spawn_blocking closures and the background workers — sees the upgrade
    // once the deferred probe finishes.
    probe: Arc<RwLock<OcrProbe>>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrStatus {
    pub ready: bool,
    pub phase: OcrPhase,
    pub renderer_available: bool,
    pub engine_available: bool,
    pub english_data_available: bool,
    pub renderer_source: String,
    pub engine_source: String,
    pub message: String,
}

impl OcrRuntime {
    pub fn discover(resource_root: Option<&Path>) -> Self {
        let platform = if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
            "windows-x64"
        } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            "macos-arm64"
        } else {
            "unsupported"
        };
        let bundled = resource_root.map(|root| root.join("ocr").join(platform));
        let bundled_renderer_library = bundled.as_ref().map(|root| {
            root.join("lib").join(if cfg!(windows) {
                "pdfium.dll"
            } else {
                "libpdfium.dylib"
            })
        });
        let bundled_tesseract = bundled.as_ref().map(|root| {
            root.join("bin").join(if cfg!(windows) {
                "tesseract.exe"
            } else {
                "tesseract"
            })
        });
        let bundled_tessdata = bundled.as_ref().map(|root| root.join("tessdata"));

        let (renderer_library, renderer_source) = select_library(
            "STUDENT_CENTER_PDFIUM",
            bundled_renderer_library.as_deref(),
            if cfg!(windows) {
                "pdfium.dll"
            } else {
                "libpdfium.dylib"
            },
        );
        let renderer_command = env::current_exe().unwrap_or_else(|_| {
            PathBuf::from(if cfg!(windows) {
                "student-center.exe"
            } else {
                "student-center"
            })
        });
        let (tesseract, engine_source) = select_tool(
            "STUDENT_CENTER_TESSERACT",
            bundled_tesseract.as_deref(),
            if cfg!(windows) {
                "tesseract.exe"
            } else {
                "tesseract"
            },
        );
        let tessdata = env::var_os("STUDENT_CENTER_TESSDATA")
            .map(PathBuf::from)
            .filter(|path| path.join("eng.traineddata").is_file())
            .or_else(|| bundled_tessdata.filter(|path| path.join("eng.traineddata").is_file()));
        let renderer_exists = renderer_library.is_file() && command_available(&renderer_command);
        let engine_exists = command_available(&tesseract);
        // Discovery is filesystem-only so it can run during app setup. The two
        // subprocess probes cost up to ten seconds and used to run here, before
        // the window was ever shown; `probe_now` performs them off the hot path.
        let tessdata_exists = tessdata.is_some();
        Self {
            renderer_command,
            renderer_library,
            tesseract,
            tessdata,
            renderer_source,
            engine_source,
            renderer_installed: renderer_exists,
            engine_installed: engine_exists,
            probe: Arc::new(RwLock::new(OcrProbe {
                phase: OcrPhase::Checking,
                renderer_available: renderer_exists,
                engine_available: engine_exists,
                english_data_available: tessdata_exists,
            })),
        }
    }

    /// Runs the bounded readiness subprocesses and publishes the result to every
    /// clone of this runtime. Blocks for up to `2 * RUNTIME_PROBE_TIMEOUT`, so
    /// never call it from the main thread.
    pub fn probe_now(&self) -> OcrStatus {
        // A Rust test harness is also an executable. Launching `current_exe()`
        // from inside a probe recursively starts the entire test suite instead
        // of the desktop renderer subcommand. Runtime probes remain mandatory in
        // production; tests exercise the bounded process runner separately.
        #[cfg(test)]
        let (renderer_available, engine_available, english_data_available) = (false, false, false);
        #[cfg(not(test))]
        let (renderer_available, engine_available, english_data_available) = {
            let renderer_available = self.renderer_installed
                && probe_renderer(&self.renderer_command, &self.renderer_library);
            let (engine_available, english_data_available) = if self.engine_installed {
                probe_tesseract(&self.tesseract, self.tessdata.as_deref())
            } else {
                (false, false)
            };
            (renderer_available, engine_available, english_data_available)
        };
        let ready = renderer_available && engine_available && english_data_available;
        if let Ok(mut probe) = self.probe.write() {
            *probe = OcrProbe {
                phase: if ready {
                    OcrPhase::Ready
                } else {
                    OcrPhase::Unavailable
                },
                renderer_available,
                engine_available,
                english_data_available,
            };
        }
        self.status()
    }

    pub fn status(&self) -> OcrStatus {
        let probe = self.probe.read().map(|probe| *probe).unwrap_or(OcrProbe {
            phase: OcrPhase::Unavailable,
            renderer_available: false,
            engine_available: false,
            english_data_available: false,
        });
        let ready = probe.phase == OcrPhase::Ready;
        let message: String = if probe.phase == OcrPhase::Checking {
            "Checking the local OCR runtime…".into()
        } else if ready {
            "Local image and scanned-PDF OCR is ready".into()
        } else if !self.engine_installed {
            "Tesseract is not installed in this build; scanned imports remain encrypted and are marked for attention".into()
        } else if !probe.engine_available {
            "Tesseract did not pass its startup check; scanned imports remain encrypted and are marked for attention".into()
        } else if !probe.english_data_available {
            "The English OCR model is unavailable; scanned imports are marked for attention".into()
        } else if !self.renderer_installed {
            "The PDF renderer is not installed; image OCR works, but scanned PDFs are marked for attention".into()
        } else {
            "The PDF renderer did not pass its startup check; image OCR works, but scanned PDFs are marked for attention".into()
        };
        OcrStatus {
            ready,
            phase: probe.phase,
            renderer_available: probe.renderer_available,
            engine_available: probe.engine_available,
            english_data_available: probe.english_data_available,
            renderer_source: self.renderer_source.into(),
            engine_source: self.engine_source.into(),
            message,
        }
    }
}

fn select_library(
    environment_variable: &str,
    bundled: Option<&Path>,
    system_name: &str,
) -> (PathBuf, &'static str) {
    if let Some(path) = env::var_os(environment_variable).map(PathBuf::from) {
        return (path, "environment");
    }
    if let Some(path) = bundled.filter(|path| path.is_file()) {
        return (path.to_path_buf(), "bundled");
    }
    (PathBuf::from(system_name), "system")
}

fn select_tool(
    environment_variable: &str,
    bundled: Option<&Path>,
    system_name: &str,
) -> (PathBuf, &'static str) {
    if let Some(path) = env::var_os(environment_variable).map(PathBuf::from) {
        return (path, "environment");
    }
    if let Some(path) = bundled.filter(|path| path.is_file()) {
        return (path.to_path_buf(), "bundled");
    }
    (PathBuf::from(system_name), "system")
}

fn command_available(command: &Path) -> bool {
    if command.is_absolute() || command.components().count() > 1 {
        return executable_file(command);
    }
    let Some(path) = env::var_os("PATH") else {
        return false;
    };
    let extensions = if cfg!(windows) {
        env::var_os("PATHEXT")
            .and_then(|value| value.into_string().ok())
            .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .map(|value| value.to_ascii_lowercase())
            .collect::<Vec<_>>()
    } else {
        vec![String::new()]
    };
    env::split_paths(&path).any(|directory| {
        if command.extension().is_some() {
            executable_file(&directory.join(command))
        } else {
            extensions.iter().any(|extension| {
                executable_file(&directory.join(format!("{}{}", command.display(), extension)))
            })
        }
    })
}

fn executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return path
            .metadata()
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false);
    }
    #[cfg(not(unix))]
    true
}

fn probe_renderer(renderer_command: &Path, renderer_library: &Path) -> bool {
    let mut command = Command::new(renderer_command);
    command
        .args(["--student-center-pdf-renderer", "probe", "--library"])
        .arg(renderer_library);
    run_bounded(
        command,
        RUNTIME_PROBE_TIMEOUT,
        "PDF renderer readiness check",
    )
    .map(|output| output.status.success())
    .unwrap_or(false)
}

fn probe_tesseract(tesseract: &Path, tessdata: Option<&Path>) -> (bool, bool) {
    let mut command = Command::new(tesseract);
    if let Some(tessdata) = tessdata {
        command.arg("--tessdata-dir").arg(tessdata);
    }
    command.arg("--list-langs");
    let Ok(output) = run_bounded(command, RUNTIME_PROBE_TIMEOUT, "OCR readiness check") else {
        return (false, false);
    };
    if !output.status.success() {
        return (false, false);
    }
    let mut languages = String::from_utf8_lossy(&output.stdout).into_owned();
    languages.push_str(&String::from_utf8_lossy(&output.stderr));
    let english_available = languages.lines().any(|language| language.trim() == "eng");
    (true, english_available)
}

/// One recognised word, with where it sat on the page.
///
/// Tesseract reports this geometry and it used to be read and thrown away. A
/// schedule is a layout: the "9:00" in the left gutter and the "PSY 101" three
/// columns over are one class, and nothing in the flattened text says so. The
/// coordinates are the only thing that does.
#[derive(Debug, Clone, PartialEq)]
pub struct OcrToken {
    pub text: String,
    pub left: i64,
    pub top: i64,
    pub width: i64,
    pub height: i64,
    /// 0.0–1.0. Tesseract reports -1 for tokens it declines to score; those are
    /// dropped rather than counted as certain.
    pub confidence: f64,
    /// Tesseract's own block/paragraph/line/word numbering, kept so reading
    /// order can fall back on it when geometry alone is ambiguous.
    pub block: u32,
    pub paragraph: u32,
    pub line: u32,
    pub word: u32,
}

impl OcrToken {
    pub fn right(&self) -> i64 {
        self.left + self.width
    }

    pub fn bottom(&self) -> i64 {
        self.top + self.height
    }

    /// Vertical midpoint, which is what rows are clustered on: two words in the
    /// same row rarely share a `top` because glyph heights differ.
    pub fn center_y(&self) -> i64 {
        self.top + self.height / 2
    }

    pub fn center_x(&self) -> i64 {
        self.left + self.width / 2
    }
}

#[derive(Debug, Clone)]
pub struct Segment {
    pub text: String,
    pub locator: String,
    pub confidence: f64,
    /// Empty for every source that is already text. Only OCR has geometry to
    /// preserve, and only the schedule reader has any use for it.
    pub tokens: Vec<OcrToken>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ExtractedCandidate {
    pub kind: String,
    pub title: String,
    pub course: String,
    pub due_at: Option<String>,
    pub starts_at: Option<String>,
    pub ends_at: Option<String>,
    pub duration_minutes: Option<i64>,
    pub evidence: String,
    pub source_locator: String,
    pub source_uid: String,
    pub confidence: f64,
    pub warnings: Vec<String>,
    /// Set only on `class_meeting` candidates. A class is a weekly pattern, not
    /// a list of dates, so it carries weekdays and a local clock rather than the
    /// single instant every other candidate kind describes.
    pub weekdays: Vec<i64>,
    pub starts_at_local: String,
    pub ends_at_local: String,
    pub timezone: String,
    pub section_number: String,
    pub location: String,
    pub modality: String,
}

#[derive(Debug)]
pub struct Extraction {
    pub candidates: Vec<ExtractedCandidate>,
    pub warnings: Vec<String>,
    /// Bounded, page/slide/section-addressable text retained for explicit,
    /// source-grounded study requests. Callers decide whether to persist it.
    pub segments: Vec<Segment>,
}

pub fn detect_document(bytes: &[u8], file_name: &str) -> Result<DocumentKind, ImportError> {
    if bytes.is_empty() {
        return Err(ImportError::Empty);
    }
    let ext = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    let detected = if bytes.starts_with(b"%PDF-") {
        DocumentKind::Pdf
    } else if bytes.starts_with(b"PK\x03\x04") || bytes.starts_with(b"PK\x05\x06") {
        detect_ooxml(bytes)?
    } else if let Some(kind) = infer::get(bytes) {
        match kind.mime_type() {
            "image/jpeg" => DocumentKind::Image("image/jpeg"),
            "image/png" => DocumentKind::Image("image/png"),
            "image/tiff" => DocumentKind::Image("image/tiff"),
            other => return Err(ImportError::Unsupported(other.to_string())),
        }
    } else {
        let text = std::str::from_utf8(bytes)
            .map_err(|_| ImportError::Unsupported("unknown binary data".into()))?;
        let trimmed = text.trim_start_matches('\u{feff}').trim_start();
        if trimmed.starts_with("BEGIN:VCALENDAR") {
            DocumentKind::Ics
        } else if ext == "csv" {
            DocumentKind::Csv
        } else if ext == "txt" {
            DocumentKind::Text
        } else {
            return Err(ImportError::Unsupported(format!(".{ext}")));
        }
    };

    if !extension_matches(&ext, &detected) {
        return Err(ImportError::TypeMismatch {
            extension: ext,
            detected: detected.extension().into(),
        });
    }
    Ok(detected)
}

fn extension_matches(ext: &str, kind: &DocumentKind) -> bool {
    match kind {
        DocumentKind::Image("image/jpeg") => matches!(ext, "jpg" | "jpeg"),
        DocumentKind::Image("image/tiff") => matches!(ext, "tif" | "tiff"),
        DocumentKind::Image(_) => ext == kind.extension(),
        _ => ext == kind.extension(),
    }
}

fn detect_ooxml(bytes: &[u8]) -> Result<DocumentKind, ImportError> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| ImportError::Malformed(error.to_string()))?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(ImportError::Malformed(
            "archive contains too many entries".into(),
        ));
    }
    let mut total = 0u64;
    let mut names = HashSet::new();
    for index in 0..archive.len() {
        let item = archive
            .by_index(index)
            .map_err(|error| ImportError::Malformed(error.to_string()))?;
        total = total.saturating_add(item.size());
        if total > MAX_ARCHIVE_UNCOMPRESSED {
            return Err(ImportError::Malformed(
                "archive expands beyond the 100 MB safety limit".into(),
            ));
        }
        names.insert(item.name().replace('\\', "/"));
    }
    if names.contains("word/document.xml") {
        Ok(DocumentKind::Docx)
    } else if names.contains("xl/workbook.xml") {
        Ok(DocumentKind::Xlsx)
    } else if names.contains("ppt/presentation.xml") {
        Ok(DocumentKind::Pptx)
    } else {
        Err(ImportError::Unsupported(
            "ZIP archive that is not DOCX, XLSX, or PPTX".into(),
        ))
    }
}

/// Where a document's bytes came from.
///
/// `is_file()` on a caller-supplied path is not a safe way to answer this. A
/// pasted screenshot has only a basename, so the check resolved against the
/// process working directory: any unrelated file sharing that name would have
/// been read by OCR while entirely different bytes were encrypted and hashed,
/// and the evidence would not have described the stored document.
#[derive(Debug, Clone, Copy)]
pub enum DocumentSource<'a> {
    /// A real file the student chose. Readers that need a path may use it.
    File(&'a Path),
    /// Bytes handed straight to the app, with no file behind them.
    Bytes,
}

impl DocumentSource<'_> {
    fn path(&self) -> Option<&Path> {
        match self {
            Self::File(path) => Some(path),
            Self::Bytes => None,
        }
    }
}

pub fn extract_document(
    source: DocumentSource<'_>,
    bytes: &[u8],
    file_name: &str,
    timezone: &str,
    ocr: &OcrRuntime,
    layouts: &[crate::school_provider::ScheduleLayout],
    known_courses: &[String],
) -> Result<Extraction, ImportError> {
    let kind = detect_document(bytes, file_name)?;
    let tz: Tz = timezone.parse().unwrap_or(chrono_tz::UTC);
    let mut warnings = Vec::new();
    let mut study_segments = Vec::new();
    let candidates = match &kind {
        DocumentKind::Ics => extract_ics(bytes, tz)?,
        DocumentKind::Csv => extract_csv(bytes, file_name, tz)?,
        DocumentKind::Xlsx => {
            // Calamine reads from a path. A pasted spreadsheet has none, and
            // inventing one is how the wrong file gets read.
            let path = source.path().ok_or_else(|| {
                ImportError::Unsupported("a spreadsheet must be imported as a file".into())
            })?;
            extract_xlsx(path, tz)?
        }
        DocumentKind::Pdf => {
            let pages = pdf_extract::extract_text_from_mem_by_pages(bytes).map_err(|error| {
                let message = error.to_string();
                if message.to_ascii_lowercase().contains("encrypt") {
                    ImportError::Encrypted
                } else {
                    ImportError::Malformed(message)
                }
            })?;
            let mut segments: Vec<Segment> = pages
                .into_iter()
                .enumerate()
                .filter_map(|(index, text)| {
                    (!text.trim().is_empty()).then(|| Segment {
                        text,
                        locator: format!("page {}", index + 1),
                        confidence: 1.0,
                        // Text extracted from the PDF itself, so there is no
                        // recognised geometry to keep.
                        tokens: Vec::new(),
                    })
                })
                .collect();
            if segments.is_empty() {
                // A scanned PDF is rendered page by page by a subprocess that
                // takes a path. Pasted bytes have none.
                let Some(pdf_path) = source.path() else {
                    warnings.push("A scanned PDF must be imported as a file.".into());
                    return Ok(Extraction {
                        candidates: Vec::new(),
                        warnings,
                        segments: Vec::new(),
                    });
                };
                match ocr_scanned_pdf(pdf_path, ocr) {
                    Ok(ocr_segments) => segments = ocr_segments,
                    Err(error) => {
                        warnings.push(error.to_string());
                        return Ok(Extraction {
                            candidates: Vec::new(),
                            warnings,
                            segments: Vec::new(),
                        });
                    }
                }
            }
            study_segments = segments.clone();
            candidates_from_segments(file_name, &segments, tz)
        }
        DocumentKind::Image(_) => {
            // A pasted image has no file behind it, only bytes and a name, so
            // one is materialised for the OCR process to read. It lives in the
            // system temp dir and is dropped at the end of this call; the
            // durable copy is the encrypted one already in the vault.
            let scratch;
            let image_path = if let Some(path) = source.path() {
                path
            } else {
                let mut file = tempfile::Builder::new()
                    .prefix("student-center-paste-")
                    .suffix(&format!(".{}", kind.extension()))
                    .tempfile()
                    .map_err(ImportError::Io)?;
                std::io::Write::write_all(&mut file, bytes).map_err(ImportError::Io)?;
                scratch = file;
                scratch.path()
            };
            let mut segment = ocr_image(image_path, "image", ocr)?;

            // Tesseract expects dark text on a light page. A dark-mode capture is
            // the exact inverse and comes back as a handful of pipes and stray
            // letters, so a dark image is inverted and read again. Measured, not
            // assumed: the dark fixture read five words before this existed.
            if let Some(inverted) = invert_if_dark(bytes) {
                if let Ok(mut file) = tempfile::Builder::new()
                    .prefix("student-center-invert-")
                    .suffix(".png")
                    .tempfile()
                {
                    if std::io::Write::write_all(&mut file, &inverted).is_ok() {
                        if let Ok(lighter) = ocr_image(file.path(), "image", ocr) {
                            // Whichever reading recognised more, wins. Inverting a
                            // page that only looked dark must not make things worse.
                            if lighter.tokens.len() > segment.tokens.len() {
                                segment = lighter;
                            }
                        }
                    }
                }
            }

            // A screenshot of a schedule is the common case, so the layout
            // reader runs first. It declines rather than guesses, and when it
            // does the ordinary date-scanning path still gets its turn.
            let reading = crate::schedule_reader::read_schedule(
                &segment,
                &crate::schedule_reader::ScheduleContext {
                    layouts,
                    timezone: timezone.into(),
                    source_locator: format!("{file_name} · schedule"),
                    known_courses: known_courses.to_vec(),
                },
            );
            study_segments.push(segment.clone());
            if reading.candidates.is_empty() {
                warnings.extend(reading.warnings);
                candidates_from_segments(file_name, &[segment], tz)
            } else {
                if !reading.confident {
                    // Surfaced rather than hidden: the student is the one who
                    // can see whether the times are right.
                    warnings.push(
                        "Some class times could not be read cleanly. Check each one before approving.".into(),
                    );
                }
                reading.candidates
            }
        }
        DocumentKind::Docx => {
            let segments = extract_office_xml(bytes, "word/", "paragraph")?;
            study_segments = segments.clone();
            candidates_from_segments(file_name, &segments, tz)
        }
        DocumentKind::Pptx => {
            let segments = extract_office_xml(bytes, "ppt/slides/slide", "slide")?;
            study_segments = segments.clone();
            candidates_from_segments(file_name, &segments, tz)
        }
        DocumentKind::Text => {
            let text = std::str::from_utf8(bytes)
                .map_err(|error| ImportError::Malformed(error.to_string()))?;
            study_segments.push(Segment {
                text: text.into(),
                locator: "text body".into(),
                confidence: 1.0,
                tokens: Vec::new(),
            });
            candidates_from_segments(
                file_name,
                &[Segment {
                    text: text.into(),
                    locator: "text body".into(),
                    confidence: 1.0,
                    tokens: Vec::new(),
                }],
                tz,
            )
        }
    };

    Ok(Extraction {
        candidates,
        warnings,
        segments: study_segments,
    })
}

fn extract_office_xml(
    bytes: &[u8],
    prefix: &str,
    locator_name: &str,
) -> Result<Vec<Segment>, ImportError> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| ImportError::Malformed(error.to_string()))?;
    let mut entries = Vec::new();
    for index in 0..archive.len() {
        let item = archive
            .by_index(index)
            .map_err(|error| ImportError::Malformed(error.to_string()))?;
        let name = item.name().replace('\\', "/");
        if name.starts_with(prefix) && name.ends_with(".xml") {
            entries.push(name);
        }
    }
    entries.sort_by_key(|name| numeric_suffix(name));
    let mut segments = Vec::new();
    for (position, entry_name) in entries.iter().enumerate() {
        let mut item = archive
            .by_name(entry_name)
            .map_err(|error| ImportError::Malformed(error.to_string()))?;
        let mut xml = String::new();
        item.read_to_string(&mut xml)?;
        let text = xml_text(&xml)?;
        if !text.trim().is_empty() {
            segments.push(Segment {
                text,
                locator: format!("{locator_name} {}", position + 1),
                confidence: 1.0,
                tokens: Vec::new(),
            });
        }
    }
    if segments.is_empty() {
        return Err(ImportError::Empty);
    }
    Ok(segments)
}

fn numeric_suffix(name: &str) -> u32 {
    Regex::new(r"(\d+)\.xml$")
        .unwrap()
        .captures(name)
        .and_then(|capture| capture.get(1))
        .and_then(|value| value.as_str().parse().ok())
        .unwrap_or(u32::MAX)
}

fn xml_text(xml: &str) -> Result<String, ImportError> {
    let mut reader = XmlReader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut output = String::new();
    loop {
        match reader.read_event() {
            Ok(Event::Text(text)) => {
                let decoded = text
                    .decode()
                    .map_err(|error| ImportError::Malformed(error.to_string()))?;
                if !output.is_empty() {
                    output.push(' ');
                }
                output.push_str(&decoded);
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(ImportError::Malformed(error.to_string())),
            _ => {}
        }
    }
    Ok(output)
}

fn extract_csv(
    bytes: &[u8],
    file_name: &str,
    tz: Tz,
) -> Result<Vec<ExtractedCandidate>, ImportError> {
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(bytes);
    let headers = reader
        .headers()
        .map_err(|error| ImportError::Malformed(error.to_string()))?
        .iter()
        .map(normalize_header)
        .collect::<Vec<_>>();
    let mut candidates = Vec::new();
    for (index, row) in reader.records().enumerate() {
        let row = row.map_err(|error| ImportError::Malformed(error.to_string()))?;
        if row.iter().all(|value| value.trim().is_empty()) {
            continue;
        }
        let values = headers
            .iter()
            .zip(row.iter())
            .map(|(header, value)| (header.as_str(), value.trim()))
            .collect::<HashMap<_, _>>();
        if let Some(candidate) =
            candidate_from_row(&values, file_name, &format!("row {}", index + 2), tz)
        {
            candidates.push(candidate);
        }
    }
    if candidates.is_empty() {
        return Err(ImportError::Malformed(
            "CSV needs a title/assignment column and a due-date column".into(),
        ));
    }
    Ok(candidates)
}

fn extract_xlsx(path: &Path, tz: Tz) -> Result<Vec<ExtractedCandidate>, ImportError> {
    let mut workbook = open_workbook_auto(path).map_err(|error| {
        let message = error.to_string();
        if message.to_ascii_lowercase().contains("password")
            || message.to_ascii_lowercase().contains("encrypt")
        {
            ImportError::Encrypted
        } else {
            ImportError::Malformed(message)
        }
    })?;
    let mut candidates = Vec::new();
    for sheet_name in workbook.sheet_names().to_owned() {
        let range = workbook
            .worksheet_range(&sheet_name)
            .map_err(|error| ImportError::Malformed(error.to_string()))?;
        let mut rows = range.rows();
        let Some(header_row) = rows.next() else {
            continue;
        };
        let headers = header_row
            .iter()
            .map(|cell| normalize_header(&cell.to_string()))
            .collect::<Vec<_>>();
        for (index, row) in rows.enumerate() {
            let rendered = row.iter().map(render_cell).collect::<Vec<_>>();
            if rendered.iter().all(|value| value.is_empty()) {
                continue;
            }
            let values = headers
                .iter()
                .zip(rendered.iter())
                .map(|(header, value)| (header.as_str(), value.as_str()))
                .collect::<HashMap<_, _>>();
            if let Some(candidate) = candidate_from_row(
                &values,
                &sheet_name,
                &format!("sheet {sheet_name} · row {}", index + 2),
                tz,
            ) {
                candidates.push(candidate);
            }
        }
    }
    if candidates.is_empty() {
        return Err(ImportError::Malformed(
            "workbook needs a title/assignment column and a due-date column".into(),
        ));
    }
    Ok(candidates)
}

fn render_cell(cell: &Data) -> String {
    cell.as_datetime()
        .map(|value| value.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|| cell.to_string().trim().to_string())
}

fn normalize_header(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .replace([' ', '-', '/'], "_")
}

fn first_value<'a>(values: &HashMap<&str, &'a str>, names: &[&str]) -> Option<&'a str> {
    names
        .iter()
        .find_map(|name| values.get(name).copied())
        .filter(|value| !value.is_empty())
}

fn candidate_from_row(
    values: &HashMap<&str, &str>,
    source: &str,
    locator: &str,
    tz: Tz,
) -> Option<ExtractedCandidate> {
    let title = first_value(values, &["title", "assignment", "task", "name"])?;
    let due_text = first_value(values, &["due", "due_date", "deadline", "date"]);
    let due_at = due_text.and_then(|value| parse_due(value, tz));
    let duration_minutes = first_value(
        values,
        &["duration", "duration_minutes", "minutes", "estimate"],
    )
    .and_then(|value| value.parse::<i64>().ok())
    .filter(|value| (5..=480).contains(value));
    let course = first_value(values, &["course", "class", "subject"]).unwrap_or("Imported course");
    let evidence = values
        .iter()
        .filter(|(_, value)| !value.is_empty())
        .map(|(key, value)| format!("{key}: {value}"))
        .collect::<Vec<_>>()
        .join(" · ");
    let mut warnings = Vec::new();
    if due_text.is_some() && due_at.is_none() {
        warnings.push("Due date could not be interpreted and must be entered manually".into());
    }
    Some(ExtractedCandidate {
        kind: "task".into(),
        title: title.into(),
        course: course.into(),
        due_at,
        starts_at: None,
        ends_at: None,
        duration_minutes,
        evidence,
        source_locator: locator.into(),
        source_uid: format!("row:{}:{}", source, locator),
        confidence: if warnings.is_empty() { 0.98 } else { 0.65 },
        warnings,
        ..Default::default()
    })
}

fn extract_ics(bytes: &[u8], fallback_tz: Tz) -> Result<Vec<ExtractedCandidate>, ImportError> {
    extract_ics_at(bytes, fallback_tz, Utc::now())
}

pub fn extract_calendar_bytes(bytes: &[u8], fallback_tz: Tz) -> Result<Vec<ExtractedCandidate>, ImportError> {
    extract_ics(bytes, fallback_tz)
}

fn extract_ics_at(
    bytes: &[u8],
    fallback_tz: Tz,
    observed_at: DateTime<Utc>,
) -> Result<Vec<ExtractedCandidate>, ImportError> {
    let reader = BufReader::new(Cursor::new(bytes));
    let mut candidates = Vec::new();
    let mut calendars = 0usize;
    for calendar in IcalParser::new(reader) {
        calendars += 1;
        let calendar = calendar.map_err(|error| ImportError::Malformed(error.to_string()))?;
        for event in calendar.events {
            candidates.extend(candidates_from_event(&event, fallback_tz, observed_at)?);
        }
    }
    if calendars == 0 || candidates.is_empty() {
        return Err(ImportError::Malformed(
            "calendar contains no importable events".into(),
        ));
    }
    Ok(candidates)
}

/// Weekdays for a plain weekly rule, or None when the rule is anything else.
///
/// Deliberately narrow. A class is `FREQ=WEEKLY` every week on fixed days;
/// anything with an interval, a positional selector, or a non-weekly frequency
/// is not a weekly pattern this can honestly represent, and modelling it as one
/// would silently invent a schedule. Those keep expanding into commitments.
fn weekly_pattern(
    rule: &str,
    starts_at: DateTime<Utc>,
    tzid: Option<&str>,
    fallback_tz: Tz,
) -> Option<Vec<i64>> {
    let mut frequency_is_weekly = false;
    let mut byday: Option<Vec<i64>> = None;
    for part in rule.split(';') {
        let (name, value) = part.split_once('=')?;
        match name.trim().to_ascii_uppercase().as_str() {
            "FREQ" => frequency_is_weekly = value.trim().eq_ignore_ascii_case("WEEKLY"),
            // INTERVAL=1 is the default and harmless; anything else is not weekly.
            "INTERVAL" if value.trim() != "1" => return None,
            "BYSETPOS" | "BYMONTHDAY" | "BYYEARDAY" | "BYWEEKNO" | "BYMONTH" => return None,
            "BYDAY" => {
                let mut days = Vec::new();
                for token in value.split(',') {
                    let token = token.trim().to_ascii_uppercase();
                    // A prefixed ordinal ("2MO") selects one week of the month.
                    if token.len() != 2 {
                        return None;
                    }
                    days.push(match token.as_str() {
                        "SU" => 0,
                        "MO" => 1,
                        "TU" => 2,
                        "WE" => 3,
                        "TH" => 4,
                        "FR" => 5,
                        "SA" => 6,
                        _ => return None,
                    });
                }
                days.sort_unstable();
                days.dedup();
                byday = Some(days);
            }
            _ => {}
        }
    }
    if !frequency_is_weekly {
        return None;
    }
    // Without BYDAY a weekly rule repeats on the start date's own weekday, read
    // in the event's timezone rather than UTC so a late-evening class does not
    // land on the following day.
    Some(byday.unwrap_or_else(|| {
        let tz = tzid
            .and_then(|value| value.parse::<Tz>().ok())
            .unwrap_or(fallback_tz);
        vec![starts_at.with_timezone(&tz).weekday().num_days_from_sunday() as i64]
    }))
}

fn candidates_from_event(
    event: &IcalEvent,
    fallback_tz: Tz,
    observed_at: DateTime<Utc>,
) -> Result<Vec<ExtractedCandidate>, ImportError> {
    let summary = property_value(&event.properties, "SUMMARY").unwrap_or("Untitled calendar event");
    let uid = property_value(&event.properties, "UID").unwrap_or(summary);
    let start_property = property(&event.properties, "DTSTART").ok_or_else(|| {
        ImportError::Malformed(format!("calendar event {summary:?} has no DTSTART"))
    })?;
    let start_raw = start_property.value.as_deref().unwrap_or_default();
    let tzid = property_parameter(start_property, "TZID");
    let starts_at = parse_ical_datetime(start_raw, tzid, fallback_tz)?;
    // A modified occurrence keeps its RECURRENCE-ID even when DTSTART moves.
    // Using DTSTART as the external identity would turn every Canvas edit into
    // a second record instead of a reviewable update to the linked occurrence.
    let recurrence_identity = property(&event.properties, "RECURRENCE-ID")
        .map(|value| {
            parse_ical_datetime(
                value.value.as_deref().unwrap_or_default(),
                property_parameter(value, "TZID").or(tzid),
                fallback_tz,
            )
        })
        .transpose()?;
    let end = if let Some(end_property) = property(&event.properties, "DTEND") {
        parse_ical_datetime(
            end_property.value.as_deref().unwrap_or_default(),
            property_parameter(end_property, "TZID").or(tzid),
            fallback_tz,
        )?
    } else {
        starts_at + Duration::hours(1)
    };
    if end <= starts_at {
        return Err(ImportError::Malformed(format!(
            "calendar event {summary:?} ends before it starts"
        )));
    }
    let duration = end - starts_at;
    let rrule = property_value(&event.properties, "RRULE");
    let exdates = event
        .properties
        .iter()
        .filter(|value| value.name.eq_ignore_ascii_case("EXDATE"))
        .filter_map(|value| value.value.as_deref())
        .flat_map(|value| value.split(','))
        .filter_map(|value| parse_ical_datetime(value, tzid, fallback_tz).ok())
        .collect::<HashSet<_>>();

    // A weekly rule describes a class, and the app already has the right record
    // for that: one class_meeting_series with weekdays and a local clock.
    // Expanding it into one commitment per occurrence produced dozens of
    // disconnected rows, so moving a class meant editing every one of them, and
    // the pattern stopped at the recurrence horizon.
    if let Some(rule) = rrule {
        if let Some(weekdays) = weekly_pattern(rule, starts_at, tzid, fallback_tz) {
            let tz = tzid
                .and_then(|value| value.parse::<Tz>().ok())
                .unwrap_or(fallback_tz);
            let local_start = starts_at.with_timezone(&tz);
            let local_end = end.with_timezone(&tz);
            return Ok(vec![ExtractedCandidate {
                kind: "class_meeting".into(),
                title: summary.into(),
                course: summary.into(),
                due_at: None,
                // The first occurrence is kept so a reviewer can see when the
                // pattern starts; the pattern itself is what gets stored.
                starts_at: Some(starts_at.to_rfc3339()),
                ends_at: Some(end.to_rfc3339()),
                duration_minutes: Some(duration.num_minutes()),
                evidence: format!("SUMMARY:{summary} · DTSTART:{start_raw} · RRULE:{rule}"),
                source_locator: format!("calendar event {uid} · weekly pattern"),
                source_uid: format!("ics:{uid}:weekly"),
                confidence: 1.0,
                warnings: Vec::new(),
                weekdays,
                starts_at_local: local_start.format("%H:%M").to_string(),
                ends_at_local: local_end.format("%H:%M").to_string(),
                timezone: tz.name().to_string(),
                section_number: String::new(),
                location: String::new(),
                modality: String::new(),
            }]);
        }
    }

    let occurrences = if let Some(rule) = rrule {
        let start_line = if let Some(tzid) = tzid {
            format!("DTSTART;TZID={tzid}:{start_raw}")
        } else {
            format!("DTSTART:{start_raw}")
        };
        let set: RRuleSet = format!("{start_line}\nRRULE:{rule}")
            .parse()
            .map_err(|error| {
                ImportError::Malformed(format!("invalid recurrence for {summary:?}: {error}"))
            })?;
        set.all(MAX_RECURRENCES)
            .dates
            .into_iter()
            .map(|date| date.with_timezone(&Utc))
            .filter(|date| !exdates.contains(date))
            .collect::<Vec<_>>()
    } else {
        vec![starts_at]
    };

    let horizon_start = observed_at - Duration::days(1);
    let horizon_end = observed_at + Duration::days(180);
    let evidence = format!(
        "SUMMARY:{summary} · DTSTART:{start_raw}{}{}",
        recurrence_identity
            .map(|value| format!(" · RECURRENCE-ID:{}", value.to_rfc3339()))
            .unwrap_or_default(),
        rrule
            .map(|value| format!(" · RRULE:{value}"))
            .unwrap_or_default()
    );
    Ok(occurrences
        .into_iter()
        .filter(|start| *start >= horizon_start && *start <= horizon_end)
        .enumerate()
        .map(|(index, start)| ExtractedCandidate {
            kind: "commitment".into(),
            title: summary.into(),
            course: "Calendar".into(),
            due_at: None,
            starts_at: Some(start.to_rfc3339()),
            ends_at: Some((start + duration).to_rfc3339()),
            duration_minutes: None,
            evidence: evidence.clone(),
            source_locator: format!("calendar event {uid} · occurrence {}", index + 1),
            source_uid: format!(
                "ics:{uid}:{}",
                recurrence_identity.unwrap_or(start).timestamp()
            ),
            confidence: 1.0,
            warnings: Vec::new(),
            ..Default::default()
        })
        .collect())
}

fn property<'a>(properties: &'a [Property], name: &str) -> Option<&'a Property> {
    properties
        .iter()
        .find(|property| property.name.eq_ignore_ascii_case(name))
}

fn property_value<'a>(properties: &'a [Property], name: &str) -> Option<&'a str> {
    property(properties, name).and_then(|property| property.value.as_deref())
}

fn property_parameter<'a>(property: &'a Property, name: &str) -> Option<&'a str> {
    property
        .params
        .as_ref()?
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .and_then(|(_, values)| values.first())
        .map(String::as_str)
}

fn parse_ical_datetime(
    value: &str,
    tzid: Option<&str>,
    fallback_tz: Tz,
) -> Result<DateTime<Utc>, ImportError> {
    if value.ends_with('Z') {
        return NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%SZ")
            .map(|date| Utc.from_utc_datetime(&date))
            .map_err(|error| ImportError::Malformed(error.to_string()));
    }
    let tz = tzid
        .and_then(|value| value.parse().ok())
        .unwrap_or(fallback_tz);
    if value.len() == 8 {
        let date = NaiveDate::parse_from_str(value, "%Y%m%d")
            .map_err(|error| ImportError::Malformed(error.to_string()))?;
        return resolve_local(tz, date.and_time(NaiveTime::MIN));
    }
    let naive = NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%S")
        .map_err(|error| ImportError::Malformed(error.to_string()))?;
    resolve_local(tz, naive)
}

fn resolve_local(tz: Tz, naive: NaiveDateTime) -> Result<DateTime<Utc>, ImportError> {
    match tz.from_local_datetime(&naive) {
        LocalResult::Single(value) => Ok(value.with_timezone(&Utc)),
        LocalResult::Ambiguous(first, _) => Ok(first.with_timezone(&Utc)),
        LocalResult::None => Err(ImportError::Malformed(format!(
            "local time {naive} does not exist in {tz}"
        ))),
    }
}

fn candidates_from_segments(
    file_name: &str,
    segments: &[Segment],
    tz: Tz,
) -> Vec<ExtractedCandidate> {
    let mut candidates = Vec::new();
    for segment in segments {
        for (line_index, line) in segment.text.lines().enumerate() {
            let normalized = line.trim();
            if normalized.is_empty()
                || !Regex::new(r"(?i)\b(due|deadline)\b")
                    .unwrap()
                    .is_match(normalized)
            {
                continue;
            }
            let due_at = parse_due(normalized, tz);
            let title = normalized
                .split([':', '–', '—'])
                .next()
                .map(str::trim)
                .filter(|value| value.len() > 3)
                .unwrap_or("Imported assignment");
            let mut warnings = Vec::new();
            if due_at.is_none() {
                warnings.push(
                    "A deadline word was found, but its date needs manual confirmation".into(),
                );
            }
            candidates.push(ExtractedCandidate {
                kind: "task".into(),
                title: title.into(),
                course: "Imported course".into(),
                due_at,
                starts_at: None,
                ends_at: None,
                duration_minutes: None,
                evidence: normalized.chars().take(400).collect(),
                source_locator: format!("{} · line {}", segment.locator, line_index + 1),
                source_uid: format!("text:{file_name}:{}:{}", segment.locator, line_index + 1),
                confidence: if warnings.is_empty() {
                    0.92 * segment.confidence
                } else {
                    0.55 * segment.confidence
                },
                warnings,
                ..Default::default()
            });
        }
    }
    candidates
}

fn parse_due(value: &str, tz: Tz) -> Option<String> {
    if let Ok(date) = DateTime::parse_from_rfc3339(value.trim()) {
        return Some(date.with_timezone(&Utc).to_rfc3339());
    }
    let patterns = [
        (
            r"(?i)(\d{4}-\d{1,2}-\d{1,2})(?:[ T](\d{1,2}:\d{2})(?:\s*(AM|PM))?)?",
            "%Y-%m-%d",
        ),
        (
            r"(?i)(\d{1,2}/\d{1,2}/\d{4})(?:\s+(\d{1,2}:\d{2})(?:\s*(AM|PM))?)?",
            "%m/%d/%Y",
        ),
        (
            r"(?i)(\d{1,2}/\d{1,2}/\d{2})(?:\s+(\d{1,2}:\d{2})(?:\s*(AM|PM))?)?",
            "%m/%d/%y",
        ),
        (
            r"(?i)((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4})(?:\s+(?:at\s+)?(\d{1,2}:\d{2})(?:\s*(AM|PM))?)?",
            "%B %d, %Y",
        ),
    ];
    for (pattern, format) in patterns {
        let Some(captures) = Regex::new(pattern).ok()?.captures(value) else {
            continue;
        };
        let date_text = captures.get(1)?.as_str();
        let date = NaiveDate::parse_from_str(date_text, format)
            .or_else(|_| NaiveDate::parse_from_str(date_text, "%b %d, %Y"))
            .or_else(|_| {
                NaiveDate::parse_from_str(&date_text.replace(',', ""), &format.replace(',', ""))
            })
            .or_else(|_| NaiveDate::parse_from_str(&date_text.replace(',', ""), "%b %d %Y"))
            .ok()?;
        let time = captures
            .get(2)
            .and_then(|capture| {
                let mut rendered = capture.as_str().to_string();
                if let Some(period) = captures.get(3) {
                    rendered.push_str(period.as_str());
                    NaiveTime::parse_from_str(&rendered, "%I:%M%p").ok()
                } else {
                    NaiveTime::parse_from_str(&rendered, "%H:%M").ok()
                }
            })
            .unwrap_or_else(|| NaiveTime::from_hms_opt(23, 59, 0).unwrap());
        return resolve_local(tz, date.and_time(time))
            .ok()
            .map(|date| date.to_rfc3339());
    }
    None
}

fn ocr_scanned_pdf(path: &Path, runtime: &OcrRuntime) -> Result<Vec<Segment>, ImportError> {
    if !command_available(&runtime.renderer_command) || !runtime.renderer_library.is_file() {
        return Err(ImportError::OcrUnavailable(
            "the packaged PDFium renderer was not found".into(),
        ));
    }
    let temp = tempdir()?;
    let page_limit = MAX_OCR_PAGES.to_string();
    let mut command = Command::new(&runtime.renderer_command);
    command
        .args(["--student-center-pdf-renderer", "render", "--library"])
        .arg(&runtime.renderer_library)
        .arg("--input")
        .arg(path)
        .arg("--output-dir")
        .arg(temp.path())
        .args(["--max-pages", &page_limit, "--target-width", "2200"]);
    let output = run_bounded(command, PDF_RENDER_TIMEOUT, "PDF rendering")?;
    if !output.status.success() {
        return Err(ImportError::OcrUnavailable(
            String::from_utf8_lossy(&output.stderr).trim().into(),
        ));
    }
    let mut images = fs::read_dir(temp.path())?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("png"))
        .collect::<Vec<_>>();
    images.sort();
    if images.len() > MAX_OCR_PAGES {
        images.truncate(MAX_OCR_PAGES);
    }
    let mut segments = Vec::new();
    for (index, image) in images.iter().enumerate() {
        let mut segment = ocr_image(image, &format!("page {} OCR", index + 1), runtime)?;
        // Only a screenshot is ever a schedule, and nothing reads a scanned
        // PDF's word boxes. A hundred pages of them is a couple of hundred
        // megabytes retained for no reader at all.
        segment.tokens = Vec::new();
        segments.push(segment);
    }
    if segments.is_empty() {
        return Err(ImportError::OcrUnavailable(
            "PDF renderer produced no pages".into(),
        ));
    }
    Ok(segments)
}

/// OCR one image, keeping the per-word geometry the schedule reader needs.
fn ocr_image(path: &Path, locator: &str, runtime: &OcrRuntime) -> Result<Segment, ImportError> {
    if !command_available(&runtime.tesseract) {
        return Err(ImportError::OcrUnavailable(
            "the packaged Tesseract engine was not found".into(),
        ));
    }
    if runtime.engine_source == "bundled" && runtime.tessdata.is_none() {
        return Err(ImportError::OcrUnavailable(
            "the packaged English Tesseract model was not found".into(),
        ));
    }
    let mut command = Command::new(&runtime.tesseract);
    command.arg(path).arg("stdout");
    if let Some(tessdata) = &runtime.tessdata {
        command.arg("--tessdata-dir").arg(tessdata);
    }
    command.args(["-l", "eng", "--psm", "6", "tsv"]);
    let output = run_bounded(command, OCR_PAGE_TIMEOUT, "OCR recognition")?;
    if !output.status.success() {
        return Err(ImportError::OcrUnavailable(
            String::from_utf8_lossy(&output.stderr).trim().into(),
        ));
    }
    parse_tesseract_tsv(&String::from_utf8_lossy(&output.stdout), locator)
}

#[derive(Debug)]
struct ProcessOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn run_bounded(
    mut command: Command,
    timeout: StdDuration,
    operation: &str,
) -> Result<ProcessOutput, ImportError> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        ImportError::OcrUnavailable(format!("{operation} could not start: {error}"))
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ImportError::OcrUnavailable(format!("{operation} has no output stream")))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| ImportError::OcrUnavailable(format!("{operation} has no error stream")))?;
    let stdout_reader = thread::spawn(move || read_capped(stdout));
    let stderr_reader = thread::spawn(move || read_capped(stderr));
    let status = match child
        .wait_timeout(timeout)
        .map_err(|error| ImportError::OcrUnavailable(format!("{operation} wait failed: {error}")))?
    {
        Some(status) => status,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(ImportError::OcrUnavailable(format!(
                "{operation} exceeded its {} second safety limit",
                timeout.as_secs()
            )));
        }
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| ImportError::OcrUnavailable(format!("{operation} output reader failed")))??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| ImportError::OcrUnavailable(format!("{operation} error reader failed")))??;
    Ok(ProcessOutput {
        status,
        stdout,
        stderr,
    })
}

fn read_capped<R: Read>(mut reader: R) -> std::io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let read = reader.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        let remaining = MAX_TOOL_OUTPUT.saturating_sub(output.len());
        output.extend_from_slice(&chunk[..read.min(remaining)]);
    }
    Ok(output)
}

/// Read Tesseract's TSV into text *and* geometry.
///
/// The columns are `level, page, block, par, line, word, left, top, width,
/// height, conf, text`. Only the text and an averaged confidence used to
/// survive; `left`/`top`/`width`/`height` were parsed as part of the row and
/// then dropped, which made a schedule grid unreadable downstream — the numbers
/// in the time gutter and the course code three columns over are one class, and
/// nothing in the flattened string says so.
///
/// `word` is now read as well, so words within a line are ordered by their
/// position rather than by the order Tesseract happened to emit them.
/// Test-only door onto the TSV parser, so the schedule reader's fixtures can be
/// token streams rather than pictures.
#[cfg(test)]
pub fn parse_tesseract_tsv_for_test(tsv: &str, locator: &str) -> Result<Segment, ImportError> {
    parse_tesseract_tsv(tsv, locator)
}

/// Invert a predominantly dark PNG, or return `None` when there is no reason to.
///
/// Only PNG, because that is what a screenshot is on both macOS and Windows and
/// what the clipboard carries; a dark JPEG photograph of a screen is out of
/// scope and reads poorly for other reasons anyway.
fn invert_if_dark(bytes: &[u8]) -> Option<Vec<u8>> {
    let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    let mut reader = decoder.read_info().ok()?;
    let mut buffer = vec![0; reader.output_buffer_size()?];
    let info = reader.next_frame(&mut buffer).ok()?;
    if info.bit_depth != png::BitDepth::Eight {
        return None;
    }
    let channels = match info.color_type {
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        png::ColorType::Grayscale => 1,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Indexed => return None,
    };
    let opaque = matches!(
        info.color_type,
        png::ColorType::Rgb | png::ColorType::Grayscale
    );
    let pixels = &buffer[..info.buffer_size()];

    // Sample rather than sum: a screenshot is millions of pixels and the answer
    // is the same from a thousandth of them.
    let stride = (pixels.len() / channels / 4_000).max(1) * channels;
    let mut total = 0u64;
    let mut counted = 0u64;
    for pixel in pixels.chunks_exact(channels).step_by(stride / channels) {
        let luminance = if channels >= 3 {
            (u64::from(pixel[0]) * 299 + u64::from(pixel[1]) * 587 + u64::from(pixel[2]) * 114)
                / 1000
        } else {
            u64::from(pixel[0])
        };
        total += luminance;
        counted += 1;
    }
    if counted == 0 || total / counted >= 110 {
        return None;
    }

    let mut inverted = pixels.to_vec();
    for pixel in inverted.chunks_exact_mut(channels) {
        let colour = if opaque { channels } else { channels - 1 };
        for value in &mut pixel[..colour] {
            *value = 255 - *value;
        }
    }
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, info.width, info.height);
        encoder.set_color(info.color_type);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(&inverted).ok()?;
    }
    Some(out)
}

fn parse_tesseract_tsv(tsv: &str, locator: &str) -> Result<Segment, ImportError> {
    let mut lines: BTreeMap<(u32, u32, u32, u32), Vec<(u32, String)>> = BTreeMap::new();
    let mut confidences = Vec::new();
    let mut tokens = Vec::new();
    for row in tsv.lines().skip(1) {
        let columns = row.splitn(12, '\t').collect::<Vec<_>>();
        if columns.len() != 12 || columns[0] != "5" || columns[11].trim().is_empty() {
            continue;
        }
        let number = |index: usize| columns[index].parse::<u32>().unwrap_or_default();
        let pixels = |index: usize| columns[index].parse::<i64>().unwrap_or_default();
        let key = (number(1), number(2), number(3), number(4));
        let word = number(5);
        let text = columns[11].trim().to_string();
        // Tesseract scores a token it is unsure of as -1. Treating that as
        // certainty is how a garbled page comes back looking confident.
        let confidence = columns[10]
            .parse::<f64>()
            .ok()
            .filter(|value| *value >= 0.0)
            .map(|value| value / 100.0);
        if let Some(confidence) = confidence {
            confidences.push(confidence);
        }
        if tokens.len() < MAX_OCR_TOKENS {
            tokens.push(OcrToken {
                text: text.clone(),
                left: pixels(6),
                top: pixels(7),
                width: pixels(8),
                height: pixels(9),
                confidence: confidence.unwrap_or(0.0),
                block: key.1,
                paragraph: key.2,
                line: key.3,
                word,
            });
        }
        lines.entry(key).or_default().push((word, text));
    }
    let text = lines
        .values_mut()
        .map(|words| {
            words.sort_by_key(|(word, _)| *word);
            words
                .iter()
                .map(|(_, text)| text.as_str())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        return Err(ImportError::Empty);
    }
    let confidence = if confidences.is_empty() {
        0.5
    } else {
        confidences.iter().sum::<f64>() / confidences.len() as f64
    };
    Ok(Segment {
        text,
        locator: locator.into(),
        confidence,
        tokens,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Datelike;
    use std::io::Write;

    fn zip_with(entry: &str) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut archive = zip::ZipWriter::new(cursor);
        archive
            .start_file(entry, zip::write::SimpleFileOptions::default())
            .unwrap();
        archive
            .write_all(b"<root><t>Due 08/17/2026</t></root>")
            .unwrap();
        archive.finish().unwrap().into_inner()
    }

    fn office_fixture(entries: &[(&str, &str)]) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut archive = zip::ZipWriter::new(cursor);
        for (name, body) in entries {
            archive
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            archive.write_all(body.as_bytes()).unwrap();
        }
        archive.finish().unwrap().into_inner()
    }

    fn minimal_xlsx() -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut archive = zip::ZipWriter::new(cursor);
        let options = zip::write::SimpleFileOptions::default();
        let entries = [
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
            ),
            (
                "xl/workbook.xml",
                r#"<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Assignments" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Assignment</t></is></c><c r="B1" t="inlineStr"><is><t>Course</t></is></c><c r="C1" t="inlineStr"><is><t>Due Date</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Research memo</t></is></c><c r="B2" t="inlineStr"><is><t>History</t></is></c><c r="C2" t="inlineStr"><is><t>2030-09-12</t></is></c></row></sheetData></worksheet>"#,
            ),
        ];
        for (name, body) in entries {
            archive.start_file(name, options).unwrap();
            archive.write_all(body.as_bytes()).unwrap();
        }
        archive.finish().unwrap().into_inner()
    }

    #[test]
    fn rejects_extension_spoofing() {
        let error = detect_document(b"%PDF-1.7\n", "malware.jpg").unwrap_err();
        assert!(matches!(error, ImportError::TypeMismatch { .. }));
    }

    #[test]
    fn distinguishes_ooxml_archives() {
        assert_eq!(
            detect_document(&zip_with("word/document.xml"), "course.docx").unwrap(),
            DocumentKind::Docx
        );
        assert_eq!(
            detect_document(&zip_with("xl/workbook.xml"), "course.xlsx").unwrap(),
            DocumentKind::Xlsx
        );
        assert_eq!(
            detect_document(&zip_with("ppt/presentation.xml"), "course.pptx").unwrap(),
            DocumentKind::Pptx
        );
    }

    #[test]
    fn rejects_corrupt_archives_and_pdfs_safely() {
        assert!(matches!(
            detect_document(b"PK\x03\x04not-a-valid-archive", "broken.docx"),
            Err(ImportError::Malformed(_))
        ));
        let pdf = b"%PDF-1.7\nthis is not a valid PDF";
        let temp = tempfile::NamedTempFile::new().unwrap();
        assert!(matches!(
            extract_document(
                DocumentSource::File(temp.path()),
                pdf,
                "broken.pdf",
                "Etc/UTC",
                &OcrRuntime::discover(None),
                &[],
                &[]
            ),
            Err(ImportError::Malformed(_))
        ));
    }

    #[test]
    fn discovers_a_complete_packaged_runtime_layout() {
        let root = tempfile::tempdir().unwrap();
        let platform = if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
            "windows-x64"
        } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            "macos-arm64"
        } else {
            "unsupported"
        };
        let runtime = root.path().join("ocr").join(platform);
        fs::create_dir_all(runtime.join("bin")).unwrap();
        fs::create_dir_all(runtime.join("lib")).unwrap();
        fs::create_dir_all(runtime.join("tessdata")).unwrap();
        fs::write(
            runtime.join("lib").join(if cfg!(windows) {
                "pdfium.dll"
            } else {
                "libpdfium.dylib"
            }),
            b"fixture",
        )
        .unwrap();
        fs::write(
            runtime.join("bin").join(if cfg!(windows) {
                "tesseract.exe"
            } else {
                "tesseract"
            }),
            b"fixture",
        )
        .unwrap();
        fs::write(runtime.join("tessdata/eng.traineddata"), b"fixture").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = runtime.join("bin/tesseract");
            let mut permissions = fs::metadata(&path).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions).unwrap();
        }
        let discovered = OcrRuntime::discover(Some(root.path()));
        // Discovery must stay filesystem-only: it runs during app setup, before
        // the window is shown, so it may not launch a subprocess.
        let initial = discovered.status();
        assert_eq!(
            initial.phase,
            OcrPhase::Checking,
            "discovery must defer the readiness probes"
        );
        assert!(!initial.ready, "an unprobed runtime is never ready");
        // Probing is what decides readiness, and placeholder files must fail it.
        let status = discovered.probe_now();
        assert_eq!(status.phase, OcrPhase::Unavailable);
        assert!(
            !status.ready,
            "placeholder executables must not pass readiness probes"
        );
        assert_eq!(status.renderer_source, "bundled");
        assert_eq!(status.engine_source, "bundled");
    }

    #[test]
    fn native_tool_execution_is_stopped_at_its_deadline() {
        let command = if cfg!(windows) {
            let mut command = Command::new("powershell.exe");
            command.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 2"]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 2"]);
            command
        };
        let error = run_bounded(command, StdDuration::from_millis(50), "fixture OCR").unwrap_err();
        assert!(error.to_string().contains("safety limit"));
    }

    #[test]
    fn golden_ocr_fixture_meets_critical_date_threshold() {
        let tsv = include_str!("../test-fixtures/ocr/syllabus.tsv");
        let segment = parse_tesseract_tsv(tsv, "page 1 OCR").unwrap();
        let candidates = candidates_from_segments(
            "golden-syllabus.pdf",
            &[segment],
            chrono_tz::America::Phoenix,
        );
        let expected = [
            ("Research memo", "2030-09-13T06:30:00+00:00"),
            ("Midterm deadline 10/15/2030 9", "2030-10-15T16:00:00+00:00"),
        ];
        let correct = expected
            .iter()
            .filter(|(title, due)| {
                candidates.iter().any(|candidate| {
                    candidate.title.starts_with(title) && candidate.due_at.as_deref() == Some(*due)
                })
            })
            .count();
        let precision = correct as f64 / candidates.len() as f64;
        let recall = correct as f64 / expected.len() as f64;
        assert!(precision >= 0.95, "critical-date precision was {precision}");
        assert!(recall >= 0.90, "critical-date recall was {recall}");
    }

    // Tesseract wants dark text on a light page; a dark-mode capture is the
    // exact inverse. Inverting is cheap and guarded — the caller keeps the
    // inverted reading only when it recognised more — so a page that merely
    // looked dark cannot be made worse by it.
    // Pasted bytes must never be able to pick up a file from the working
    // directory. Before `DocumentSource`, the image branch called `is_file()` on
    // a caller-supplied basename, so a file of that name in the CWD would have
    // been OCR'd while different bytes were encrypted and hashed — the evidence
    // would not have described the stored document.
    #[test]
    fn pasted_bytes_never_read_a_file_from_the_working_directory() {
        assert!(DocumentSource::Bytes.path().is_none());
        let decoy = Path::new("schedule.png");
        assert_eq!(DocumentSource::File(decoy).path(), Some(decoy));

        // The formats that genuinely need a file say so rather than reaching for
        // one. A spreadsheet has no bytes-only reader.
        let xlsx = include_bytes!("../test-fixtures/ocr/syllabus.tsv");
        let error = extract_document(
            DocumentSource::Bytes,
            xlsx,
            "not-really.xlsx",
            "Etc/UTC",
            &OcrRuntime::discover(None),
            &[],
            &[],
        );
        // Sniffing rejects it long before the path question arises, which is the
        // outer guard; the inner one is asserted above.
        assert!(error.is_err());
    }

    #[test]
    fn a_dark_capture_is_inverted_and_a_light_one_is_left_alone() {
        fn png(shade: u8) -> Vec<u8> {
            let mut out = Vec::new();
            {
                let mut encoder = png::Encoder::new(&mut out, 8, 8);
                encoder.set_color(png::ColorType::Rgb);
                encoder.set_depth(png::BitDepth::Eight);
                let mut writer = encoder.write_header().unwrap();
                writer.write_image_data(&vec![shade; 8 * 8 * 3]).unwrap();
            }
            out
        }

        let dark = png(20);
        let inverted = invert_if_dark(&dark).expect("a dark page is inverted");
        // Decoding the result proves it is a real PNG and that the pixels moved.
        let mut reader = png::Decoder::new(std::io::Cursor::new(&inverted))
            .read_info()
            .unwrap();
        let mut buffer = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buffer).unwrap();
        assert_eq!(buffer[..info.buffer_size()][0], 235);

        assert!(
            invert_if_dark(&png(240)).is_none(),
            "a light page is left alone"
        );
        assert!(
            invert_if_dark(&png(160)).is_none(),
            "a merely mid-toned page is left alone"
        );
        // Anything that is not a plain 8-bit PNG is declined rather than guessed
        // at; a JPEG photograph of a screen reads poorly for other reasons.
        assert!(invert_if_dark(b"not a png").is_none());
    }

    #[test]
    fn parses_ocr_confidence_and_evidence_lines() {
        let tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t0\t0\t1\t1\t90\tPaper\n5\t1\t1\t1\t1\t2\t0\t0\t1\t1\t80\tdue\n";
        let segment = parse_tesseract_tsv(tsv, "page 1 OCR").unwrap();
        assert_eq!(segment.text, "Paper due");
        assert!((segment.confidence - 0.85).abs() < 0.001);
    }

    const TSV_HEADER: &str =
        "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n";

    // The geometry was on the wire all along -- Tesseract is already asked for
    // tsv -- and was parsed and dropped. A schedule is a layout, so a reader that
    // only sees the flattened string cannot tell which column a time belongs to.
    #[test]
    fn ocr_keeps_the_box_around_every_word() {
        let tsv = format!(
            "{TSV_HEADER}\
             5\t1\t1\t1\t1\t1\t40\t120\t60\t18\t96\tPSY\n\
             5\t1\t1\t1\t1\t2\t110\t120\t34\t18\t94\t101\n\
             5\t1\t1\t2\t1\t1\t40\t160\t52\t18\t91\t9:00\n"
        );
        let segment = parse_tesseract_tsv(&tsv, "page 1 OCR").unwrap();
        assert_eq!(segment.text, "PSY 101\n9:00");
        assert_eq!(segment.tokens.len(), 3);

        let psy = &segment.tokens[0];
        assert_eq!(psy.text, "PSY");
        assert_eq!((psy.left, psy.top, psy.width, psy.height), (40, 120, 60, 18));
        assert_eq!(psy.right(), 100);
        assert_eq!(psy.bottom(), 138);
        assert_eq!(psy.center_y(), 129);

        // "PSY" and "101" share a row; "9:00" sits on the next one. That is the
        // whole basis of clustering a grid, so it has to survive.
        assert_eq!(segment.tokens[1].center_y(), psy.center_y());
        assert!(segment.tokens[2].center_y() > psy.center_y());
    }

    // Tesseract emits -1 for a word it declines to score. Averaging that in as
    // if it were a real reading makes a garbled page look confident.
    #[test]
    fn unscored_words_do_not_count_as_certainty() {
        let tsv = format!(
            "{TSV_HEADER}\
             5\t1\t1\t1\t1\t1\t0\t0\t1\t1\t90\tPaper\n\
             5\t1\t1\t1\t1\t2\t0\t0\t1\t1\t-1\tdue\n"
        );
        let segment = parse_tesseract_tsv(&tsv, "page 1 OCR").unwrap();
        assert_eq!(segment.text, "Paper due");
        assert!((segment.confidence - 0.90).abs() < 0.001);
        assert_eq!(segment.tokens.len(), 2);
        assert_eq!(segment.tokens[1].confidence, 0.0);
    }

    // Words within a line are ordered by word_num, not by the order Tesseract
    // happened to emit them, so a reordered TSV still reads as one sentence.
    #[test]
    fn words_within_a_line_are_ordered_by_position() {
        let tsv = format!(
            "{TSV_HEADER}\
             5\t1\t1\t1\t1\t3\t200\t10\t30\t12\t90\tThursday\n\
             5\t1\t1\t1\t1\t1\t10\t10\t40\t12\t90\tPSY\n\
             5\t1\t1\t1\t1\t2\t60\t10\t30\t12\t90\t101\n"
        );
        let segment = parse_tesseract_tsv(&tsv, "page 1 OCR").unwrap();
        assert_eq!(segment.text, "PSY 101 Thursday");
    }

    // A hundred OCR'd pages of geometry is not worth holding; only a screenshot
    // is ever a schedule. The text is unaffected by the cap.
    #[test]
    fn retained_geometry_is_bounded() {
        let mut tsv = String::from(TSV_HEADER);
        for word in 0..(MAX_OCR_TOKENS + 500) {
            tsv.push_str(&format!(
                "5\t1\t1\t1\t{}\t1\t0\t{}\t10\t10\t90\tw{word}\n",
                word, word
            ));
        }
        let segment = parse_tesseract_tsv(&tsv, "page 1 OCR").unwrap();
        assert_eq!(segment.tokens.len(), MAX_OCR_TOKENS);
        assert!(segment.text.contains(&format!("w{}", MAX_OCR_TOKENS + 499)));
    }

    #[test]
    fn parses_csv_rows_with_field_provenance() {
        let csv = b"Assignment,Course,Due Date,Minutes\nProblem Set 4,Statistics,2030-08-17,45\n";
        let rows = extract_csv(csv, "assignments.csv", chrono_tz::America::Phoenix).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, "Problem Set 4");
        assert_eq!(rows[0].duration_minutes, Some(45));
        assert!(rows[0].source_locator.contains("row 2"));
    }

    #[test]
    fn parses_named_month_deadlines_without_guessing_invalid_dates() {
        let due = parse_due(
            "Final paper due Sep 12, 2030 at 11:30 PM",
            chrono_tz::America::Phoenix,
        )
        .unwrap();
        assert_eq!(
            DateTime::parse_from_rfc3339(&due)
                .unwrap()
                .with_timezone(&Utc),
            DateTime::parse_from_rfc3339("2030-09-13T06:30:00Z")
                .unwrap()
                .with_timezone(&Utc)
        );
        assert!(parse_due(
            "Final paper due February 30, 2030",
            chrono_tz::America::Phoenix
        )
        .is_none());
    }

    #[test]
    fn parses_xlsx_rows_with_sheet_provenance() {
        let bytes = minimal_xlsx();
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(&bytes).unwrap();
        let rows = extract_xlsx(file.path(), chrono_tz::America::Phoenix).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, "Research memo");
        assert_eq!(rows[0].course, "History");
        assert!(rows[0].source_locator.contains("Assignments"));
        assert!(rows[0].source_locator.contains("row 2"));
    }

    #[test]
    fn parses_docx_and_pptx_with_paragraph_and_slide_evidence() {
        let docx = office_fixture(&[(
            "word/document.xml",
            "<document><p><t>Research memo due Sep 12, 2030 at 11:30 PM</t></p></document>",
        )]);
        let docx_rows = extract_document(
            DocumentSource::File(Path::new("syllabus.docx")),
            &docx,
            "syllabus.docx",
            "America/Phoenix",
            &OcrRuntime::discover(None),
            &[],
            &[],
        )
        .unwrap()
        .candidates;
        assert_eq!(docx_rows.len(), 1);
        assert!(docx_rows[0].source_locator.starts_with("paragraph 1"));
        assert_eq!(
            docx_rows[0].due_at.as_deref(),
            Some("2030-09-13T06:30:00+00:00")
        );

        let pptx = office_fixture(&[
            ("ppt/presentation.xml", "<presentation/>"),
            (
                "ppt/slides/slide1.xml",
                "<slide><t>Capstone presentation due Oct 15, 2030 at 9:00 AM</t></slide>",
            ),
        ]);
        let pptx_rows = extract_document(
            DocumentSource::File(Path::new("course.pptx")),
            &pptx,
            "course.pptx",
            "America/Phoenix",
            &OcrRuntime::discover(None),
            &[],
            &[],
        )
        .unwrap()
        .candidates;
        assert_eq!(pptx_rows.len(), 1);
        assert!(pptx_rows[0].source_locator.starts_with("slide 1"));
        assert_eq!(
            pptx_rows[0].due_at.as_deref(),
            Some("2030-10-15T16:00:00+00:00")
        );
    }

    #[test]
    fn parses_ics_and_excludes_exception_dates() {
        let year = Utc::now().year();
        let start = (Utc::now() + Duration::days(2)).date_naive();
        let first = start.format("%Y%m%d").to_string();
        let excluded = (start + Duration::days(1)).format("%Y%m%d").to_string();
        let ics = format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:class-{year}\r\nSUMMARY:Statistics 201\r\nDTSTART:{first}T090000Z\r\nDTEND:{first}T095000Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEXDATE:{excluded}T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");
        let rows = extract_ics(ics.as_bytes(), chrono_tz::America::Phoenix).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|row| row.kind == "commitment"));
    }

    #[test]
    fn recurrence_id_keeps_a_moved_occurrence_linked_to_the_same_source() {
        let observed_at = DateTime::parse_from_rfc3339("2026-08-26T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let calendar = |starts: &str, ends: &str| format!(
            "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:canvas-event-42\r\nRECURRENCE-ID:20260901T090000Z\r\nSUMMARY:Statistics review\r\nDTSTART:{starts}\r\nDTEND:{ends}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
        );
        let first = extract_ics_at(
            calendar("20260901T100000Z", "20260901T110000Z").as_bytes(),
            chrono_tz::UTC,
            observed_at,
        ).unwrap();
        let changed = extract_ics_at(
            calendar("20260901T110000Z", "20260901T120000Z").as_bytes(),
            chrono_tz::UTC,
            observed_at,
        ).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(changed.len(), 1);
        assert_eq!(first[0].source_uid, changed[0].source_uid);
        assert_ne!(first[0].starts_at, changed[0].starts_at);
        assert!(first[0].evidence.contains("RECURRENCE-ID"));
    }

    #[test]
    fn preserves_named_timezone_across_dst_recurrence() {
        let ics = b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:dst-course\r\nSUMMARY:Fall seminar\r\nDTSTART;TZID=America/New_York:20261031T090000\r\nDTEND;TZID=America/New_York:20261031T100000\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let observed_at = DateTime::parse_from_rfc3339("2026-08-12T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let rows = extract_ics_at(ics, chrono_tz::America::Phoenix, observed_at).unwrap();
        assert_eq!(rows.len(), 3);
        let starts = rows
            .iter()
            .map(|row| DateTime::parse_from_rfc3339(row.starts_at.as_deref().unwrap()).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(starts[1] - starts[0], Duration::hours(25));
        assert_eq!(starts[2] - starts[1], Duration::hours(24));
    }

    fn weekly_ics(rule: &str) -> Vec<u8> {
        format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:sta201\r\nSUMMARY:Statistics 201\r\nDTSTART;TZID=America/Phoenix:20260824T090000\r\nDTEND;TZID=America/Phoenix:20260824T095000\r\nRRULE:{rule}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
            .into_bytes()
    }

    fn extracted(rule: &str) -> Vec<ExtractedCandidate> {
        let observed_at = DateTime::parse_from_rfc3339("2026-08-12T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        extract_ics_at(&weekly_ics(rule), chrono_tz::America::Phoenix, observed_at).unwrap()
    }

    // A weekly rule is a class. Expanding it into one commitment per occurrence
    // meant moving a class required editing every row, and the pattern simply
    // stopped at the recurrence horizon.
    #[test]
    fn a_weekly_rule_becomes_one_class_meeting_rather_than_many_commitments() {
        let rows = extracted("FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=45");
        assert_eq!(rows.len(), 1, "a weekly class is one pattern, not many dates");
        let class = &rows[0];
        assert_eq!(class.kind, "class_meeting");
        assert_eq!(class.weekdays, vec![1, 3, 5]);
        assert_eq!(class.starts_at_local, "09:00");
        assert_eq!(class.ends_at_local, "09:50");
        assert_eq!(class.timezone, "America/Phoenix");
        assert_eq!(class.title, "Statistics 201");
    }

    #[test]
    fn a_weekly_rule_without_byday_repeats_on_the_start_weekday() {
        // 24 August 2026 is a Monday in Phoenix.
        let rows = extracted("FREQ=WEEKLY;COUNT=10");
        assert_eq!(rows[0].kind, "class_meeting");
        assert_eq!(rows[0].weekdays, vec![1]);
    }

    // Anything this cannot honestly represent as "every week on these days"
    // keeps expanding, rather than being flattened into a schedule that was
    // never in the file.
    #[test]
    fn rules_that_are_not_a_plain_weekly_pattern_still_expand() {
        for rule in [
            "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;COUNT=4",
            "FREQ=WEEKLY;BYDAY=2MO;COUNT=4",
            "FREQ=MONTHLY;BYDAY=MO;COUNT=4",
            "FREQ=DAILY;COUNT=4",
        ] {
            let rows = extracted(rule);
            assert!(
                rows.iter().all(|row| row.kind == "commitment"),
                "{rule} should not be modelled as a weekly class"
            );
            assert!(rows.len() > 1, "{rule} should still expand");
        }
    }

    // The local clock is what a student reads off their schedule. It must not
    // drift when the recurrence crosses a daylight-saving boundary, and the
    // weekday must be read in the event's zone rather than UTC.
    #[test]
    fn the_local_clock_survives_a_daylight_saving_boundary() {
        let ics = b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:late\r\nSUMMARY:Evening lab\r\nDTSTART;TZID=America/New_York:20261026T193000\r\nDTEND;TZID=America/New_York:20261026T204500\r\nRRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=6\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let observed_at = DateTime::parse_from_rfc3339("2026-08-12T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let rows = extract_ics_at(ics, chrono_tz::America::Phoenix, observed_at).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].starts_at_local, "19:30");
        assert_eq!(rows[0].ends_at_local, "20:45");
        assert_eq!(rows[0].timezone, "America/New_York");
        // 19:30 in New York is 23:30 UTC; reading the weekday in UTC would call
        // this a Monday evening class a Tuesday.
        assert_eq!(rows[0].weekdays, vec![1]);
    }
}
