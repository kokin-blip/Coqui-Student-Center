//! Reading a school's published academic calendar.
//!
//! Three things live here: a hardened fetch, a descriptor-driven parse, and a
//! diff. What is deliberately absent is a write. This module never mutates a
//! record; it produces a list of differences for a student to approve, because a
//! term date is a critical academic date and a page that changed under us is not
//! authority to move someone's finals.
//!
//! The fetch reuses `canvas.rs`'s SSRF guard rather than restating it: resolve
//! once, reject the host outright if *any* address is private, pin those
//! addresses onto the client, refuse redirects and proxies, and cap both the
//! advertised and the streamed body.
//!
//! Parsing rules come from `SchoolProvider::calendar_source`, never from code.
//! There is no branch here that knows what ASU is.

use crate::canvas::{is_public_ip, resolve_public_addresses};
use crate::school_provider::{
    CalendarSource, CalendarSourceKind, NoClassDate, SchoolProvider, TermDescriptor,
};
use chrono::NaiveDate;
use ical::IcalParser;
use regex::Regex;
use reqwest::{blocking::Client, redirect::Policy, Url};
use std::{io::Read, net::IpAddr, time::Duration};

/// A registrar calendar is a page of text. Eight megabytes is far more than one
/// needs and still bounds a hostile or misconfigured response.
const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// A calendar page with more rows than this is not a calendar.
const MAX_ENTRIES: usize = 2_000;

#[derive(thiserror::Error, Debug)]
pub enum CalendarError {
    #[error("this school has no published calendar to refresh")]
    NoSource,
    #[error("the calendar address is invalid: {0}")]
    InvalidUrl(String),
    #[error("the calendar host could not be validated: {0}")]
    Dns(String),
    #[error("the calendar could not be reached; nothing was changed")]
    Network,
    #[error("the calendar request timed out; nothing was changed")]
    Timeout,
    #[error("the calendar page answered {0}; nothing was changed")]
    Status(u16),
    #[error("the calendar could not be read: {0}")]
    Unreadable(String),
}

pub type Result<T> = std::result::Result<T, CalendarError>;

/// One dated row read off a school's calendar.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEntry {
    pub label: String,
    pub starts_on: String,
    /// Empty for a single-day entry.
    pub ends_on: String,
    /// The session letter, when the row named one. Two sessions of one term have
    /// different dates, so a row that does not say which it belongs to cannot be
    /// matched against a term with confidence.
    pub session_code: String,
}

/// What a refresh found, stated as differences rather than as new truth.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarDiff {
    pub institution_id: String,
    pub source_label: String,
    pub source_url: String,
    pub fetched_at: String,
    /// Rows that match a bundled term but disagree with it. These are the ones
    /// that must surface as explicit conflicts.
    pub changed_terms: Vec<TermChange>,
    /// Holidays and breaks the bundle does not have.
    pub added_no_class_dates: Vec<NoClassDate>,
    /// Everything read that could not be matched to a bundled term. Reported
    /// rather than discarded, so a school whose sessions are named differently
    /// is visibly unmatched instead of silently empty.
    pub unmatched: Vec<CalendarEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TermChange {
    pub term_id: String,
    pub term_name: String,
    pub field: String,
    pub current: String,
    pub proposed: String,
    pub evidence: String,
}

impl CalendarDiff {
    /// True when a refresh found nothing to review. The UI needs this to say
    /// "already up to date" rather than showing an empty review screen.
    pub fn is_empty(&self) -> bool {
        self.changed_terms.is_empty() && self.added_no_class_dates.is_empty()
    }
}

/// Validate a calendar URL.
///
/// Looser than `canvas::normalize_base_url` in exactly one way — a path is
/// allowed, because a calendar lives at one — and identical everywhere else. A
/// query string is allowed too: some registrars key the term that way.
pub fn normalize_calendar_url(input: &str) -> Result<Url> {
    let parsed = Url::parse(input.trim()).map_err(|e| CalendarError::InvalidUrl(e.to_string()))?;
    if parsed.scheme() != "https" {
        return Err(CalendarError::InvalidUrl("HTTPS is required".into()));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(CalendarError::InvalidUrl(
            "embedded credentials are not allowed".into(),
        ));
    }
    if parsed.port().is_some() {
        return Err(CalendarError::InvalidUrl(
            "custom ports are not allowed".into(),
        ));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| CalendarError::InvalidUrl("host is required".into()))?;
    if host.trim_matches(['[', ']']).parse::<IpAddr>().is_ok()
        || host.eq_ignore_ascii_case("localhost")
    {
        return Err(CalendarError::InvalidUrl(
            "the calendar must use a public DNS host".into(),
        ));
    }
    Ok(parsed)
}

/// Fetch the calendar body.
///
/// Every guard here exists because this is a URL the app was handed rather than
/// one it chose: pin the resolved addresses so DNS cannot be re-pointed between
/// the check and the connection, refuse redirects so the pin cannot be escaped,
/// refuse proxies for the same reason, and cap the body twice.
pub fn fetch_calendar(source: &CalendarSource) -> Result<String> {
    let url = normalize_calendar_url(&source.url)?;
    let host = url
        .host_str()
        .ok_or_else(|| CalendarError::InvalidUrl("host is required".into()))?
        .to_string();
    let addresses = resolve_public_addresses(&host).map_err(|e| CalendarError::Dns(e.to_string()))?;
    debug_assert!(addresses.iter().all(|address| is_public_ip(address.ip())));

    let client = Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(Duration::from_secs(10))
        .user_agent(concat!(
            "StudentCenter/",
            env!("CARGO_PKG_VERSION"),
            " CalendarReadOnly"
        ))
        .resolve_to_addrs(&host, &addresses)
        .build()
        .map_err(|_| CalendarError::Network)?;

    let response = client.get(url).send().map_err(|error| {
        if error.is_timeout() {
            CalendarError::Timeout
        } else {
            CalendarError::Network
        }
    })?;
    let status = response.status();
    if !status.is_success() {
        return Err(CalendarError::Status(status.as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE_BYTES)
    {
        return Err(CalendarError::Unreadable(
            "the calendar page exceeded the size safety limit".into(),
        ));
    }
    let mut body = Vec::new();
    response
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|_| CalendarError::Network)?;
    if body.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(CalendarError::Unreadable(
            "the calendar page exceeded the size safety limit".into(),
        ));
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

/// Read dated rows out of a fetched body, following the descriptor.
pub fn parse_calendar(body: &str, source: &CalendarSource) -> Result<Vec<CalendarEntry>> {
    let entries = match source.kind {
        CalendarSourceKind::Ics => parse_ics(body)?,
        CalendarSourceKind::HtmlSessions => parse_sessions(body, source)?,
        CalendarSourceKind::HtmlTable | CalendarSourceKind::HtmlList => parse_html(body, source)?,
    };
    Ok(entries.into_iter().take(MAX_ENTRIES).collect())
}

fn parse_ics(body: &str) -> Result<Vec<CalendarEntry>> {
    let mut entries = Vec::new();
    for calendar in IcalParser::new(body.as_bytes()) {
        let calendar = calendar.map_err(|e| CalendarError::Unreadable(e.to_string()))?;
        for event in calendar.events {
            let value = |name: &str| {
                event
                    .properties
                    .iter()
                    .find(|property| property.name == name)
                    .and_then(|property| property.value.clone())
            };
            let (Some(label), Some(start)) = (value("SUMMARY"), value("DTSTART")) else {
                continue;
            };
            let Some(starts_on) = ics_date(&start) else {
                continue;
            };
            // An all-day ICS event ends on the morning after it finishes, so the
            // last day a student is actually off is the day before DTEND.
            let ends_on = value("DTEND")
                .and_then(|value| ics_date(&value))
                .and_then(|end| end.pred_opt())
                .filter(|end| *end > starts_on)
                .map(|end| end.to_string())
                .unwrap_or_default();
            entries.push(CalendarEntry {
                label: collapse(&label),
                starts_on: starts_on.to_string(),
                ends_on,
                session_code: String::new(),
            });
        }
    }
    Ok(entries)
}

fn ics_date(value: &str) -> Option<NaiveDate> {
    let trimmed = value.trim();
    let date = trimmed.split('T').next()?;
    NaiveDate::parse_from_str(date, "%Y%m%d").ok()
}

/// Read an HTML page as text, then apply the descriptor's row pattern.
///
/// Deliberately not a CSS selector and not a DOM parse. Registrar calendars are
/// frequently not tables at all — ASU's is a run of headings and bolded labels —
/// and are often not well-formed, so selecting a node buys less than it costs. A
/// named-group regex over de-tagged text states the same rule as data and
/// carries no HTML parser into the binary.
fn parse_html(body: &str, source: &CalendarSource) -> Result<Vec<CalendarEntry>> {
    if source.row_pattern.is_empty() || source.date_format.is_empty() {
        return Err(CalendarError::Unreadable(
            "this school's descriptor does not say how to read its calendar".into(),
        ));
    }
    let pattern = Regex::new(&source.row_pattern)
        .map_err(|e| CalendarError::Unreadable(format!("the row pattern is invalid: {e}")))?;
    let text = strip_tags(body);
    let region = bound_region(&text, &source.section_pattern)?;

    let mut entries = Vec::new();
    for capture in pattern.captures_iter(region) {
        let group = |name: &str| {
            capture
                .name(name)
                .map(|value| collapse(value.as_str()))
                .unwrap_or_default()
        };
        let label = group("label");
        let start = group("start");
        if label.is_empty() || start.is_empty() {
            continue;
        }
        let Some(starts_on) = parse_date(&start, &source.date_format) else {
            continue;
        };
        let ends_on = parse_date(&group("end"), &source.date_format)
            .filter(|end| *end > starts_on)
            .map(|end| end.to_string())
            .unwrap_or_default();
        entries.push(CalendarEntry {
            label,
            starts_on: starts_on.to_string(),
            ends_on,
            session_code: group("session"),
        });
        if entries.len() >= MAX_ENTRIES {
            break;
        }
    }
    Ok(entries)
}

/// Read a page that lists a label, then a date per session.
///
/// This is what a registrar calendar actually looks like, and it is not one row
/// of text per event. The label sits on its own line — sometimes two — and each
/// session's date follows on lines of its own:
///
/// ```text
/// Classes end/
/// last day to process transactions
/// Session A
/// October 9, 2026
/// Session C
/// December 4, 2026
/// ```
///
/// Rows with no session put the date straight under the label. The rule covering
/// both is that a date belongs to the nearest label above it, reached through a
/// session marker when one intervenes, so this is a walk with state rather than
/// a pattern matched per line.
///
/// Anchoring the session and date patterns to whole lines is what keeps prose
/// out: a summary like "Session C: Thursday, August 20–Friday, December 4, 2026"
/// holds a session and two dates and must not be read as an event.
fn parse_sessions(body: &str, source: &CalendarSource) -> Result<Vec<CalendarEntry>> {
    if source.date_pattern.is_empty() || source.date_format.is_empty() {
        return Err(CalendarError::Unreadable(
            "this school's descriptor does not say how to read its calendar".into(),
        ));
    }
    let date_pattern = Regex::new(&source.date_pattern)
        .map_err(|e| CalendarError::Unreadable(format!("the date pattern is invalid: {e}")))?;
    let session_pattern = if source.session_pattern.is_empty() {
        None
    } else {
        Some(
            Regex::new(&source.session_pattern).map_err(|e| {
                CalendarError::Unreadable(format!("the session pattern is invalid: {e}"))
            })?,
        )
    };
    let text = strip_tags(body);
    let region = bound_region(&text, &source.section_pattern)?;

    let mut entries = Vec::new();
    let mut label_parts: Vec<&str> = Vec::new();
    let mut pending_session = String::new();
    let mut label_line: i64 = i64::MIN / 4;

    for (index, line) in region.lines().enumerate() {
        let index = index as i64;
        if let Some(found) = session_pattern.as_ref().and_then(|p| p.captures(line)) {
            pending_session = found
                .name("session")
                .map(|value| value.as_str().to_string())
                .unwrap_or_default();
            continue;
        }
        let Some(found) = date_pattern.captures(line) else {
            // Directly after a session marker, a line is that session's value
            // even when it is prose. ASU writes "Final exams / Session A / Last
            // Day of Classes", meaning finals happen then; read as a label,
            // "Last Day of Classes" adopts the next session's date and
            // overwrites the real one.
            if !pending_session.is_empty() {
                pending_session.clear();
                continue;
            }
            // A run of text lines is one label: "Classes end/" and the clause
            // beneath it are the same event.
            if index - label_line > 1 {
                label_parts.clear();
            }
            label_parts.push(line);
            label_line = index;
            continue;
        };
        let label = label_of(&label_parts);
        // A label too far above is not this date's label. Without this a heading
        // near the top of the page adopts the first date it can reach.
        if label.is_empty() || index - label_line > 8 {
            pending_session.clear();
            continue;
        }
        let group = |name: &str| {
            found
                .name(name)
                .map(|value| value.as_str().to_string())
                .unwrap_or_default()
        };
        let (starts_on, ends_on) = assemble_dates(
            &group("start"),
            &group("end"),
            &group("year"),
            &source.date_format,
        );
        if !starts_on.is_empty() {
            entries.push(CalendarEntry {
                label,
                starts_on,
                ends_on,
                session_code: std::mem::take(&mut pending_session),
            });
            if entries.len() >= MAX_ENTRIES {
                break;
            }
        }
        pending_session.clear();
    }
    Ok(entries)
}

/// At most the last two lines above the date, and never a runaway.
///
/// Unbounded, a page's whole navigation column becomes the label of the first
/// date on it.
fn label_of(parts: &[&str]) -> String {
    let tail = collapse(
        &parts
            .iter()
            .rev()
            .take(2)
            .rev()
            .copied()
            .collect::<Vec<_>>()
            .join(" "),
    );
    if tail.chars().count() <= 140 {
        return tail;
    }
    collapse(parts.last().copied().unwrap_or_default())
        .chars()
        .take(140)
        .collect()
}

/// Build the dates from a matched line.
///
/// A range states what it does not repeat: "October 10–13, 2026" gives the month
/// and year once, and "August 20–October 4, 2026" gives the year once. The end
/// borrows whichever it is missing from the start rather than being parsed alone.
fn assemble_dates(start: &str, end: &str, year: &str, format: &str) -> (String, String) {
    let Some(starts_on) = parse_date(&format!("{start}, {year}"), format) else {
        return (String::new(), String::new());
    };
    let ends_on = if end.is_empty() {
        None
    } else {
        let month = if end.starts_with(|c: char| c.is_ascii_alphabetic()) {
            String::new()
        } else {
            format!("{} ", start.split_whitespace().next().unwrap_or_default())
        };
        parse_date(&format!("{month}{end}, {year}"), format)
    };
    (
        starts_on.to_string(),
        ends_on
            .filter(|end| *end > starts_on)
            .map(|end| end.to_string())
            .unwrap_or_default(),
    )
}

/// Narrow the text to the region the descriptor cares about, if it names one.
fn bound_region<'a>(text: &'a str, section_pattern: &str) -> Result<&'a str> {
    if section_pattern.is_empty() {
        return Ok(text);
    }
    let pattern = Regex::new(section_pattern)
        .map_err(|e| CalendarError::Unreadable(format!("the section pattern is invalid: {e}")))?;
    Ok(pattern
        .find(text)
        .map(|found| &text[found.start()..])
        .unwrap_or(text))
}

fn parse_date(value: &str, format: &str) -> Option<NaiveDate> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    NaiveDate::parse_from_str(trimmed, format).ok()
}

/// Tags that end a line rather than merely separating two words.
///
/// This distinction is the difference between reading a calendar and reading a
/// paragraph. Flattened to one line, a row like "Classes end—last day to process
/// transactions. Session C December 4, 2026" cannot be told from its neighbours,
/// and the row pattern latches onto the wrong span; the label is lost and a real
/// term boundary goes unread. The block structure is the only structure a
/// registrar page reliably has, so it survives de-tagging.
const BLOCK_TAGS: &[&str] = &[
    "p", "div", "li", "ul", "ol", "tr", "td", "th", "table", "br", "h1", "h2", "h3", "h4", "h5",
    "h6", "section", "article", "header", "footer", "main", "dt", "dd", "dl", "blockquote",
];

fn is_block_tag(tag: &str) -> bool {
    let name = tag
        .trim_start_matches(['<', '/'])
        .split(|c: char| c.is_whitespace() || c == '>' || c == '/')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    BLOCK_TAGS.contains(&name.as_str())
}

/// Reduce HTML to readable text, one calendar row per line.
///
/// Script and style bodies are dropped rather than de-tagged, because their
/// contents are full of date-shaped strings that would otherwise be read as
/// calendar rows.
fn strip_tags(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut chars = body.char_indices().peekable();
    while let Some((index, ch)) = chars.next() {
        if ch != '<' {
            // Source newlines are formatting, not structure: a single <p> is
            // routinely wrapped across several lines in the file. Flattening
            // them here leaves tag-derived breaks as the only real ones.
            out.push(if ch.is_whitespace() { ' ' } else { ch });
            continue;
        }
        let rest = &body[index..];
        let lowered_start = rest
            .get(..8)
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        // Comments are skipped whole. Consuming only to the first `>` leaks the
        // body of any comment containing one — a conditional comment, or a
        // commented-out block of markup — straight into the parsed text as
        // calendar rows. The JS mirror strips them; this did not.
        if rest.starts_with("<!--") {
            let end = rest.find("-->").map(|at| index + at + 3);
            while let Some((next, _)) = chars.peek() {
                if end.is_some_and(|end| *next < end) {
                    chars.next();
                } else {
                    break;
                }
            }
            out.push(' ');
            continue;
        }
        let skip_to = if lowered_start.starts_with("<script") {
            Some("</script")
        } else if lowered_start.starts_with("<style") {
            Some("</style")
        } else {
            None
        };
        if let Some(closing) = skip_to {
            let after = rest.to_ascii_lowercase().find(closing).map(|at| index + at);
            while let Some((next, _)) = chars.peek() {
                if after.is_some_and(|end| *next < end) {
                    chars.next();
                } else {
                    break;
                }
            }
        }
        // A tag boundary is at least a word boundary, so "<td>Aug 20</td><td>Classes"
        // does not run together into one token. A block tag is a line boundary.
        let mut tag = String::from("<");
        for (_, inner) in chars.by_ref() {
            if inner == '>' {
                break;
            }
            tag.push(inner);
        }
        out.push(if is_block_tag(&tag) { '\n' } else { ' ' });
    }
    normalize_lines(&decode_entities(&out))
}

/// Collapse spaces within each line and drop empty ones, keeping the line breaks
/// that carry the page's row structure.
fn normalize_lines(value: &str) -> String {
    value
        .lines()
        .map(collapse)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn decode_entities(value: &str) -> String {
    value
        .replace("&nbsp;", " ")
        .replace("&#160;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&rsquo;", "'")
        .replace("&mdash;", "—")
        .replace("&ndash;", "–")
        .replace("&#8212;", "—")
        .replace("&#8211;", "–")
}

/// Collapse runs of whitespace, so a value split across tags reads as one line.
fn collapse(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Compare what was read against what is bundled.
///
/// Matching is by session code and by the label naming a boundary the descriptor
/// already models. A row that matches nothing is reported as unmatched rather
/// than guessed at: an unrecognised calendar is a thing to show a student, not a
/// thing to resolve on their behalf.
pub fn diff_calendar(
    provider: &SchoolProvider,
    entries: &[CalendarEntry],
    fetched_at: String,
) -> CalendarDiff {
    let mut diff = CalendarDiff {
        institution_id: provider.institution_id.clone(),
        source_label: provider.source_label.clone(),
        source_url: provider
            .calendar_source
            .as_ref()
            .map(|source| source.url.clone())
            .unwrap_or_default(),
        fetched_at,
        ..CalendarDiff::default()
    };

    for entry in entries {
        let Some(term) = matching_term(provider, entry) else {
            diff.unmatched.push(entry.clone());
            continue;
        };
        match classify(&entry.label) {
            Some(Boundary::ClassesBegin) => {
                push_change(&mut diff, term, "startsOn", &term.starts_on, entry);
            }
            Some(Boundary::ClassesEnd) => {
                push_change(&mut diff, term, "classEndsOn", &term.class_ends_on, entry);
            }
            Some(Boundary::ExamsBegin) => {
                push_change(&mut diff, term, "examStartsOn", &term.exam_starts_on, entry);
            }
            Some(Boundary::TermEnd) => {
                push_change(&mut diff, term, "endsOn", &term.ends_on, entry);
            }
            Some(Boundary::NoClass) => {
                let candidate = NoClassDate {
                    starts_on: entry.starts_on.clone(),
                    ends_on: entry.ends_on.clone(),
                    label: entry.label.clone(),
                };
                if !term.no_class_dates.iter().any(|known| {
                    known.starts_on == candidate.starts_on && known.ends_on == candidate.ends_on
                }) && !diff.added_no_class_dates.contains(&candidate)
                {
                    diff.added_no_class_dates.push(candidate);
                }
            }
            None => diff.unmatched.push(entry.clone()),
        }
    }
    diff
}

fn push_change(
    diff: &mut CalendarDiff,
    term: &TermDescriptor,
    field: &str,
    current: &str,
    entry: &CalendarEntry,
) {
    if current == entry.starts_on {
        return;
    }
    diff.changed_terms.push(TermChange {
        term_id: term.id.clone(),
        term_name: term.name.clone(),
        field: field.into(),
        current: current.to_string(),
        proposed: entry.starts_on.clone(),
        evidence: entry.label.clone(),
    });
}

/// Which term boundary a row describes, if any.
///
/// The vocabulary is English registrar phrasing rather than any one school's.
/// A school that words things differently produces unmatched rows, which is a
/// visible outcome a descriptor edit can fix — not a wrong date.
enum Boundary {
    ClassesBegin,
    ClassesEnd,
    ExamsBegin,
    TermEnd,
    NoClass,
}

fn classify(label: &str) -> Option<Boundary> {
    // Only the front of the label. A registrar names the row first and explains
    // it afterwards, so a sentence that happens to contain the vocabulary is
    // prose, not a row announcing when term starts.
    let folded: String = label.to_lowercase().chars().take(60).collect();
    let has = |needle: &str| folded.contains(needle);
    if has("holiday") || has("no classes") || has("break") || has("recess") {
        return Some(Boundary::NoClass);
    }
    if has("final") && (has("begin") || has("start")) {
        return Some(Boundary::ExamsBegin);
    }
    // "first day of classes" and "last day of classes" are as common as "classes
    // begin". The "of" matters: "last day to drop a class" is a deadline, not the
    // end of instruction, and must not be read as one.
    if has("first day of class") {
        return Some(Boundary::ClassesBegin);
    }
    if has("last day of class") {
        return Some(Boundary::ClassesEnd);
    }
    if has("class") && (has("begin") || has("start")) {
        return Some(Boundary::ClassesBegin);
    }
    if has("class") && has("end") {
        return Some(Boundary::ClassesEnd);
    }
    if (has("semester") || has("term") || has("session")) && has("end") {
        return Some(Boundary::TermEnd);
    }
    None
}

/// The bundled term a row belongs to.
///
/// A row that names a session matches only a term declaring that session, which
/// is what stops Session A's dates being written over Session C's. A row with no
/// session matches the term whose span already contains its date.
fn matching_term<'a>(
    provider: &'a SchoolProvider,
    entry: &CalendarEntry,
) -> Option<&'a TermDescriptor> {
    let date = NaiveDate::parse_from_str(&entry.starts_on, "%Y-%m-%d").ok()?;
    let within = |term: &TermDescriptor| {
        let starts = NaiveDate::parse_from_str(&term.starts_on, "%Y-%m-%d").ok();
        let ends = NaiveDate::parse_from_str(&term.ends_on, "%Y-%m-%d").ok();
        match (starts, ends) {
            // Three days of slack, not a fortnight. Terms of the same session
            // sit close together: with a two-week window Summer's "Classes
            // begin" falls inside Spring's and rewrites a date it should have
            // left alone.
            (Some(starts), Some(ends)) => {
                date >= starts - chrono::Duration::days(3)
                    && date <= ends + chrono::Duration::days(3)
            }
            _ => false,
        }
    };
    if !entry.session_code.is_empty() {
        return provider
            .terms
            .iter()
            .find(|term| term.session_code == entry.session_code && within(term));
    }
    provider.terms.iter().find(|term| within(term))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::school_provider::CalendarSourceKind;

    fn asu_source() -> CalendarSource {
        let providers: Vec<SchoolProvider> = serde_json::from_str(include_str!(
            "../resources/institution-setup-providers.json"
        ))
        .unwrap();
        providers[0].calendar_source.clone().unwrap()
    }

    fn asu_provider() -> SchoolProvider {
        let providers: Vec<SchoolProvider> = serde_json::from_str(include_str!(
            "../resources/institution-setup-providers.json"
        ))
        .unwrap();
        providers.into_iter().next().unwrap()
    }

    const FIXTURE: &str = include_str!("../test-fixtures/calendar/asu-academic-calendar.html");

    // The descriptor has to be able to read the page it points at. If this fails
    // The descriptor has to read the page it points at. This fixture is a saved
    // copy of the live registrar page, not a reconstruction of it — the previous
    // one was written from a description, and the pattern fitted to it read the
    // real page as 152 rows that matched nothing at all.
    #[test]
    fn the_bundled_descriptor_reads_the_real_registrar_page() {
        let entries = parse_calendar(FIXTURE, &asu_source()).unwrap();
        assert!(
            entries.len() >= 100,
            "expected a full calendar, read {}",
            entries.len()
        );
        let session_c = |needle: &str, year: &str| {
            entries
                .iter()
                .find(|entry| {
                    entry.session_code == "C"
                        && entry.starts_on.starts_with(year)
                        && entry.label.to_lowercase().contains(needle)
                })
                .unwrap_or_else(|| panic!("no Session C {needle} in {year}"))
        };
        assert_eq!(session_c("classes begin", "2026").starts_on, "2026-08-20");
        assert_eq!(session_c("classes end", "2026").starts_on, "2026-12-04");
        assert_eq!(session_c("classes begin", "2027").starts_on, "2027-01-11");
    }

    // A date belongs to the label above it, not to the whole page above it.
    #[test]
    fn a_label_is_the_text_immediately_above_its_date() {
        let entries = parse_calendar(FIXTURE, &asu_source()).unwrap();
        for entry in &entries {
            assert!(
                entry.label.chars().count() <= 140,
                "runaway label: {:?}",
                entry.label
            );
        }
        // Two lines are one label when the registrar wraps it.
        assert!(entries
            .iter()
            .any(|entry| entry.label.starts_with("Classes end/")));
    }

    // The page writes "Final exams / Session A / Last Day of Classes", meaning
    // finals happen then. Read as a label, "Last Day of Classes" adopts the next
    // session's date and overwrites the real end-of-classes date with the day
    // finals start.
    #[test]
    fn a_value_standing_in_for_a_date_does_not_become_a_label() {
        let entries = parse_calendar(FIXTURE, &asu_source()).unwrap();
        assert!(
            !entries
                .iter()
                .any(|entry| entry.label.eq_ignore_ascii_case("Last Day of Classes")),
            "a session's stand-in value was read as a label"
        );
        let finals = entries
            .iter()
            .find(|entry| entry.label.to_lowercase().starts_with("final exams")
                && entry.session_code == "C"
                && entry.starts_on.starts_with("2026"))
            .expect("Session C finals are on the page");
        assert_eq!(finals.starts_on, "2026-12-07");
    }

    // The page is one long document with prose in it. A sentence that happens to
    // contain the vocabulary is not a row announcing when term starts.
    #[test]
    fn prose_containing_the_vocabulary_is_not_a_term_boundary() {
        let long_prose = "As part of a complete session withdrawal a student must \
             withdraw from all classes in a session. Beginning the first day of classes, \
             undergraduate students may withdraw from a session";
        assert!(classify(long_prose).is_none());
        // The same words at the front of a short label are exactly what it means.
        assert!(matches!(
            classify("First day of classes"),
            Some(Boundary::ClassesBegin)
        ));
    }

    // Real holidays, read off the real page.
    #[test]
    fn holidays_are_collected_as_no_class_dates() {
        let mut provider = asu_provider();
        // Against a bundle that has not harvested them yet.
        for term in &mut provider.terms {
            term.no_class_dates.clear();
        }
        let entries = parse_calendar(FIXTURE, &asu_source()).unwrap();
        let diff = diff_calendar(&provider, &entries, "2026-08-19T00:00:00Z".into());

        let found = |needle: &str| {
            diff.added_no_class_dates
                .iter()
                .find(|date| date.label.to_lowercase().contains(needle))
                .unwrap_or_else(|| panic!("no {needle} in {:?}", diff.added_no_class_dates))
        };
        let fall_break = found("fall break");
        assert_eq!(fall_break.starts_on, "2026-10-10");
        assert_eq!(fall_break.ends_on, "2026-10-13", "a break is a range");
        assert_eq!(found("thanksgiving").starts_on, "2026-11-26");
        assert_eq!(found("spring break").starts_on, "2027-03-07");
    }

    // Summer's first day sits nine days after Spring's last. A generous matching
    // window lets it rewrite a date it has nothing to do with.
    #[test]
    fn a_neighbouring_terms_row_does_not_rewrite_this_one() {
        let provider = asu_provider();
        let entries = parse_calendar(FIXTURE, &asu_source()).unwrap();
        let diff = diff_calendar(&provider, &entries, "2026-08-19T00:00:00Z".into());
        assert!(
            diff.changed_terms.is_empty(),
            "the bundle agrees with the page; proposed changes are wrong: {:?}",
            diff.changed_terms
        );
    }



    #[test]
    fn an_ics_calendar_is_read_without_a_row_pattern() {
        let body = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:1\r\nSUMMARY:Fall Break\r\nDTSTART;VALUE=DATE:20261012\r\nDTEND;VALUE=DATE:20261014\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let source = CalendarSource {
            url: "https://example.edu/calendar.ics".into(),
            kind: CalendarSourceKind::Ics,
            ..CalendarSource::default()
        };
        let entries = parse_calendar(body, &source).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].label, "Fall Break");
        assert_eq!(entries[0].starts_on, "2026-10-12");
        // DTEND is exclusive, so the last day off is the 13th, not the 14th.
        assert_eq!(entries[0].ends_on, "2026-10-13");
    }

    // A parser that reads script and style text invents holidays out of the
    // date-shaped strings every analytics tag is full of.
    #[test]
    fn script_and_style_bodies_are_not_read_as_calendar_rows() {
        let body = r#"<html><head><style>.a{content:"August 31, 2026"}</style>
            <script>var d = "September 1, 2026";</script></head>
            <body><p>Classes begin</p><p>August 20, 2026</p></body></html>"#;
        let entries = parse_calendar(body, &asu_source()).unwrap();
        assert_eq!(entries.len(), 1, "read more than the one real row: {entries:?}");
        assert_eq!(entries[0].starts_on, "2026-08-20");
        assert_eq!(entries[0].label, "Classes begin");
    }

    // A comment containing `>` used to leak its body into the parsed text, so a
    // commented-out block of markup became calendar rows. The JS mirror already
    // stripped comments; these two are claimed to agree.
    #[test]
    fn html_comments_are_dropped_whole() {
        let body = "<p>Classes begin</p><!-- <p>Classes begin</p><p>January 5, 2026</p> -->\
                    <p>August 20, 2026</p>";
        let text = strip_tags(body);
        assert!(!text.contains("January"), "comment body leaked: {text:?}");
        let entries = parse_calendar(body, &asu_source()).unwrap();
        assert_eq!(entries.len(), 1, "{entries:?}");
        assert_eq!(entries[0].starts_on, "2026-08-20");
    }

    #[test]
    fn tags_separate_words_rather_than_joining_them() {
        let text = strip_tags("<td>Classes begin</td><td>August 20, 2026</td>");
        assert!(collapse(&text).contains("Classes begin August 20, 2026"));
    }

    // The label a registrar wraps across two lines is one label, and the session
    // it belongs to has to survive with it. Flattening the page to a single line
    // lost both.
    #[test]
    fn a_wrapped_label_keeps_its_text_and_its_session() {
        let entries = parse_calendar(FIXTURE, &asu_source()).unwrap();
        let classes_end = entries
            .iter()
            .find(|entry| {
                entry.starts_on == "2026-12-04"
                    && entry.session_code == "C"
                    && entry.label.to_lowercase().starts_with("classes end")
            })
            .expect("the page states when Session C classes end");
        assert!(
            classes_end.label.to_lowercase().contains("last day"),
            "the wrapped second line belongs to the label: {:?}",
            classes_end.label
        );
        assert!(matches!(
            classify(&classes_end.label),
            Some(Boundary::ClassesEnd)
        ));
    }

    #[test]
    fn block_tags_end_a_row_and_source_wrapping_does_not() {
        let text = strip_tags("<p>Classes begin\n  August 20, 2026</p><p>Classes end</p>");
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines, vec!["Classes begin August 20, 2026", "Classes end"]);
    }

    // Every guard on the fetch URL, none of which depend on reaching the network.
    #[test]
    fn calendar_urls_are_restricted_to_public_https_hosts() {
        for invalid in [
            "http://registrar.example.edu/calendar",
            "https://user:pass@registrar.example.edu/calendar",
            "https://registrar.example.edu:8443/calendar",
            "https://127.0.0.1/calendar",
            "https://localhost/calendar",
            "https://[::1]/calendar",
        ] {
            assert!(
                normalize_calendar_url(invalid).is_err(),
                "accepted {invalid}"
            );
        }
        // Unlike a Canvas origin, a calendar legitimately has a path and may key
        // its term through a query string.
        assert!(normalize_calendar_url("https://registrar.example.edu/academic-calendar").is_ok());
        assert!(normalize_calendar_url("https://registrar.example.edu/cal?term=2267").is_ok());
    }

    #[test]
    fn a_descriptor_without_parsing_rules_fails_rather_than_guessing() {
        let source = CalendarSource {
            url: "https://registrar.example.edu/calendar".into(),
            kind: CalendarSourceKind::HtmlList,
            ..CalendarSource::default()
        };
        assert!(parse_calendar("<p>Classes begin August 20, 2026</p>", &source).is_err());
    }

    #[test]
    fn a_school_with_no_published_calendar_is_a_plain_refusal() {
        let provider = SchoolProvider::default();
        assert!(provider.calendar_source.is_none());
        let error = provider
            .calendar_source
            .as_ref()
            .ok_or(CalendarError::NoSource)
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "this school has no published calendar to refresh"
        );
    }
}
