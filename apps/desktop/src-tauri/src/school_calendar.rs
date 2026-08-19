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

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
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
    let folded = label.to_lowercase();
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
            // A boundary row sits on the edge of its term, and a start date that
            // moved earlier sits just outside it, so the window is widened by a
            // fortnight at each end rather than being exact.
            (Some(starts), Some(ends)) => {
                date >= starts - chrono::Duration::days(14)
                    && date <= ends + chrono::Duration::days(14)
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
    // the row pattern is wrong, and no amount of correct Rust will help.
    #[test]
    fn the_bundled_row_pattern_reads_the_bundled_fixture() {
        let entries = parse_calendar(FIXTURE, &asu_source()).unwrap();
        assert!(
            entries.len() >= 6,
            "expected several rows, read {}",
            entries.len()
        );
        let begins = entries
            .iter()
            .find(|entry| entry.label.to_lowercase().contains("classes begin"))
            .expect("the page states when classes begin");
        assert_eq!(begins.starts_on, "2026-08-20");
        assert_eq!(begins.session_code, "C");
    }

    // A refresh reports differences. It does not write them, and the type it
    // returns has nowhere to put a mutation even if it wanted to.
    #[test]
    fn a_refresh_reports_differences_rather_than_applying_them() {
        let provider = asu_provider();
        let entries = parse_calendar(FIXTURE, &asu_source()).unwrap();
        let diff = diff_calendar(&provider, &entries, "2026-08-19T00:00:00Z".into());
        // The fixture agrees with the bundle, so there is nothing to review.
        assert!(
            diff.changed_terms.is_empty(),
            "unexpected changes: {:?}",
            diff.changed_terms
        );
        assert_eq!(diff.institution_id, "104151");
    }

    // The case the review gate exists for: a registrar moved a date.
    #[test]
    fn a_moved_term_date_surfaces_as_a_change_naming_both_values() {
        let provider = asu_provider();
        let moved = FIXTURE.replace("August 20, 2026", "August 24, 2026");
        let entries = parse_calendar(&moved, &asu_source()).unwrap();
        let diff = diff_calendar(&provider, &entries, "2026-08-19T00:00:00Z".into());
        let change = diff
            .changed_terms
            .iter()
            .find(|change| change.field == "startsOn")
            .expect("a moved start date must surface");
        assert_eq!(change.current, "2026-08-20");
        assert_eq!(change.proposed, "2026-08-24");
        assert_eq!(change.term_id, "asu-fall-2026-c");
        assert!(!diff.is_empty());
    }

    // Session A and Session C share a term name and have different dates. A row
    // naming one must never be written onto the other.
    #[test]
    fn a_session_row_does_not_overwrite_another_session() {
        let provider = asu_provider();
        let session_a = CalendarEntry {
            label: "Classes begin".into(),
            starts_on: "2026-08-20".into(),
            ends_on: String::new(),
            session_code: "A".into(),
        };
        let diff = diff_calendar(&provider, &[session_a], "2026-08-19T00:00:00Z".into());
        assert!(diff.changed_terms.is_empty());
        assert_eq!(diff.unmatched.len(), 1, "the row is reported, not applied");
    }

    #[test]
    fn holidays_are_collected_as_no_class_dates() {
        let provider = asu_provider();
        let entries = parse_calendar(FIXTURE, &asu_source()).unwrap();
        let diff = diff_calendar(&provider, &entries, "2026-08-19T00:00:00Z".into());
        assert!(
            diff.added_no_class_dates
                .iter()
                .any(|date| date.label.to_lowercase().contains("holiday")),
            "the fixture lists a holiday: {:?}",
            diff.added_no_class_dates
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

    #[test]
    fn script_and_style_bodies_are_not_read_as_calendar_rows() {
        let body = r#"<html><head><style>.a{content:"August 20, 2026"}</style>
            <script>var d="Classes begin August 20, 2026";</script></head>
            <body><p>Classes begin Session C August 20, 2026</p></body></html>"#;
        let entries = parse_calendar(body, &asu_source()).unwrap();
        assert_eq!(
            entries.len(),
            1,
            "script and style text must not become rows: {entries:?}"
        );
    }

    #[test]
    fn tags_separate_words_rather_than_joining_them() {
        let text = strip_tags("<td>Classes begin</td><td>August 20, 2026</td>");
        assert!(collapse(&text).contains("Classes begin August 20, 2026"));
    }

    // The row that motivated keeping block structure through de-tagging: a
    // label, a long explanatory clause, then the session and the date. Flattened
    // to one line this parsed as label "Session C" with no session code, losing a
    // real term boundary. Mirrored by the same case in
    // scripts/test/academic-calendar.test.mjs.
    #[test]
    fn a_row_with_an_explanatory_clause_keeps_its_label_and_session() {
        let entries = parse_calendar(FIXTURE, &asu_source()).unwrap();
        let classes_end = entries
            .iter()
            .find(|entry| entry.starts_on == "2026-12-04")
            .expect("the page states when classes end");
        assert_eq!(classes_end.label, "Classes end");
        assert_eq!(classes_end.session_code, "C");

        let drop = entries
            .iter()
            .find(|entry| entry.starts_on == "2026-08-26")
            .expect("the drop deadline row is read");
        assert_eq!(drop.label, "Drop deadline");
        // Read, but not a boundary anything models, so it is reported rather
        // than written onto a term it does not describe.
        assert!(classify(&drop.label).is_none());
    }

    // A registrar page is one long document; block structure is what separates
    // one row from the next, and source line wrapping is not structure at all.
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
