//! Turning a schedule screenshot into weekly class meetings.
//!
//! The input is the OCR tokens `imports::parse_tesseract_tsv` now keeps, and the
//! output is ordinary `ExtractedCandidate`s that land in the same review queue as
//! everything else. Nothing here writes a record.
//!
//! Two shapes cover almost every schedule a student can screenshot:
//!
//! * a **grid** — days across the top, times down the side, classes as blocks;
//! * a **list** — one row per class, with the days as a single `MWF`-style token.
//!
//! Neither reader knows what school it is looking at. The weekday vocabulary
//! comes from `SchoolProvider::schedule_layouts`, with an English default for
//! schools nobody has described yet — a default that is generic to the language
//! rather than specific to an institution, which is the line invariant 5 draws.

use crate::imports::{ExtractedCandidate, OcrToken, Segment};
use crate::school_provider::{ScheduleLayout, ScheduleShape};

/// Classes outside this range are almost always a misread gutter rather than a
/// real 3am lecture, and a wrong time on a timetable is worse than a gap.
const EARLIEST_MINUTE: u32 = 6 * 60;
const LATEST_MINUTE: u32 = 23 * 60;

/// A schedule with more entries than this is not a schedule.
const MAX_MEETINGS: usize = 60;

/// What the reader read, and how much it trusts itself.
#[derive(Debug, Default)]
pub struct ScheduleReading {
    pub candidates: Vec<ExtractedCandidate>,
    pub warnings: Vec<String>,
    /// True when the result is internally consistent enough to offer without
    /// suggesting a second opinion. See `is_self_consistent`.
    pub confident: bool,
}

pub struct ScheduleContext<'a> {
    pub layouts: &'a [ScheduleLayout],
    pub timezone: String,
    pub source_locator: String,
    /// Course codes the student already has. Used only to judge confidence — a
    /// code nobody recognises is a hint the read went wrong, never a reason to
    /// drop a class the student can see on their own screen. Empty is fine and
    /// simply means the check has nothing to say.
    pub known_courses: Vec<String>,
}

/// One weekday token vocabulary, longest token first.
///
/// Matching longest-first is what generalises the `Th`/`T` problem rather than
/// special-casing it: `th`, `su` and `sa` are simply longer than `t` and `s`, so
/// they win wherever both could apply, and a school that spells Thursday `R` only
/// has to say so in its descriptor.
struct WeekdayVocabulary {
    tokens: Vec<(String, u8)>,
}

impl WeekdayVocabulary {
    fn from_layouts(layouts: &[ScheduleLayout]) -> Self {
        let mut tokens: Vec<(String, u8)> = layouts
            .iter()
            .flat_map(|layout| layout.weekday_tokens.iter())
            .flat_map(|entry| {
                entry
                    .tokens
                    .iter()
                    .map(move |token| (token.to_lowercase(), entry.weekday))
            })
            .collect();
        if tokens.is_empty() {
            tokens = DEFAULT_WEEKDAY_TOKENS
                .iter()
                .map(|(token, weekday)| ((*token).to_string(), *weekday))
                .collect();
        }
        tokens.sort_by(|left, right| {
            right
                .0
                .len()
                .cmp(&left.0.len())
                .then_with(|| left.0.cmp(&right.0))
        });
        tokens.dedup_by(|a, b| a.0 == b.0);
        Self { tokens }
    }

    /// Split a run like `MWF` or `TuTh` into weekday indices.
    ///
    /// A faithful port of `parseDays` in `scripts/catalog/asu-class-search.mjs`,
    /// generalised from that function's fixed digraph list to longest-match over
    /// the vocabulary. Pinned against it by a shared golden vector — see
    /// `weekday_parsing_matches_the_published_golden_vector`.
    fn parse_days(&self, value: &str) -> Vec<u8> {
        self.scan_days(value).0
    }

    /// Days only when the whole run is days.
    ///
    /// This is what tells a days column from a course code. Every subject code
    /// is letters, and most of those letters are also weekday abbreviations —
    /// `MAT` reads as Monday-and-Tuesday under a lenient scan, which silently
    /// files a Tuesday/Thursday class on Monday. Requiring that nothing was
    /// skipped is the difference.
    fn parse_days_strict(&self, value: &str) -> Option<Vec<u8>> {
        let (days, unmatched) = self.scan_days(value);
        (unmatched == 0 && !days.is_empty()).then_some(days)
    }

    /// Longest-match scan, reporting how many characters it could not place.
    fn scan_days(&self, value: &str) -> (Vec<u8>, usize) {
        // Separators are formatting: "M/W/F" and "M W F" are "MWF".
        let compact: String = value
            .chars()
            .filter(|c| !c.is_whitespace() && *c != ',' && *c != '/' && *c != '.')
            .collect::<String>()
            .to_lowercase();
        let mut days = Vec::new();
        let mut unmatched = 0;
        let mut rest = compact.as_str();
        while !rest.is_empty() {
            let matched = self
                .tokens
                .iter()
                .find(|(token, _)| rest.starts_with(token.as_str()));
            match matched {
                Some((token, weekday)) => {
                    if !days.contains(weekday) {
                        days.push(*weekday);
                    }
                    rest = &rest[token.len()..];
                }
                None => {
                    unmatched += 1;
                    let mut chars = rest.chars();
                    chars.next();
                    rest = chars.as_str();
                }
            }
        }
        days.sort_unstable();
        (days, unmatched)
    }

    /// Whether a token is a standalone weekday header, e.g. the `Wed` above a
    /// column. Requires a whole-token match so `Monday`'s column header is not
    /// confused with the `M` inside a course code.
    fn header_weekday(&self, value: &str) -> Option<u8> {
        let folded = value.trim().trim_end_matches('.').to_lowercase();
        self.tokens
            .iter()
            .find(|(token, _)| *token == folded)
            .map(|(_, weekday)| *weekday)
    }
}

/// English weekday tokens, used when a school has no descriptor of its own.
///
/// Generic to the language rather than to any institution: this is the fallback
/// that lets a student at a school nobody has described still import a schedule.
const DEFAULT_WEEKDAY_TOKENS: &[(&str, u8)] = &[
    ("sunday", 0),
    ("monday", 1),
    ("tuesday", 2),
    ("wednesday", 3),
    ("thursday", 4),
    ("friday", 5),
    ("saturday", 6),
    ("sun", 0),
    ("mon", 1),
    ("tue", 2),
    ("tues", 2),
    ("wed", 3),
    ("thu", 4),
    ("thur", 4),
    ("thurs", 4),
    ("fri", 5),
    ("sat", 6),
    ("su", 0),
    ("mo", 1),
    ("tu", 2),
    ("we", 3),
    ("th", 4),
    ("fr", 5),
    ("sa", 6),
    ("m", 1),
    ("t", 2),
    ("w", 3),
    ("r", 4),
    ("f", 5),
    ("s", 6),
];

/// Parse a clock reading into minutes since midnight.
///
/// A faithful port of `to24Hour` in `scripts/catalog/asu-class-search.mjs`,
/// widened to accept a 24-hour reading too, since not every schedule is printed
/// with a meridiem. Pinned by the same golden vector.
pub fn to_minutes(value: &str) -> Option<u32> {
    // Dots are decoration on a meridiem, not part of it. "1:30 p.m." has to read
    // as "1:30pm" or it parses as half past one in the morning and the
    // waking-hours guard then discards the class entirely — so a page written
    // with dotted meridiems yielded no times at all.
    let folded = value
        .trim()
        .to_lowercase()
        .replace([' ', '.'], "");
    let (clock, meridiem) = if let Some(rest) = folded.strip_suffix("am") {
        (rest, Some(false))
    } else if let Some(rest) = folded.strip_suffix("pm") {
        (rest, Some(true))
    } else {
        (folded.as_str(), None)
    };
    let (hours, minutes) = clock.split_once(':')?;
    let hours: u32 = hours.parse().ok()?;
    let minutes: u32 = minutes.parse().ok()?;
    if minutes > 59 {
        return None;
    }
    let hours = match meridiem {
        // 12:30 PM is 12:30, not 24:30; 12:15 AM is 00:15.
        Some(true) => hours % 12 + 12,
        Some(false) => hours % 12,
        None if hours <= 23 => hours,
        None => return None,
    };
    if hours > 23 {
        return None;
    }
    Some(hours * 60 + minutes)
}

pub fn format_clock(minutes: u32) -> String {
    format!("{:02}:{:02}", minutes / 60, minutes % 60)
}

/// True when a token could be a clock reading.
fn clock_token(value: &str) -> bool {
    to_minutes(value).is_some()
}

fn is_meridiem(value: &str) -> bool {
    matches!(
        value.trim().trim_end_matches('.').to_lowercase().as_str(),
        "am" | "pm" | "a.m" | "p.m"
    )
}

/// Rejoin a clock with the meridiem OCR split off it.
///
/// Tesseract emits "1:30" and "PM" as two words, and read separately "1:30" is
/// half past one in the morning — which the waking-hours check then throws away,
/// losing an afternoon class entirely. Stitching them back together before
/// anything else looks at the row is the fix.
fn join_meridiems<'a>(words: &[&'a str]) -> Vec<String> {
    let mut joined: Vec<String> = Vec::with_capacity(words.len());
    let mut index = 0;
    while index < words.len() {
        let word = words[index];
        if index + 1 < words.len() && is_meridiem(words[index + 1]) && word.contains(':') {
            joined.push(format!("{word} {}", words[index + 1]));
            index += 2;
            continue;
        }
        joined.push(word.to_string());
        index += 1;
    }
    joined
}

/// A course code like `PSY 101` or `CSE240`.
///
/// Two to four letters and three digits is the shape essentially every US
/// institution uses. It is a heuristic for *finding* a code in a row, never a
/// filter on which codes are allowed.
fn course_code(tokens: &[&str]) -> Option<String> {
    for window in tokens.windows(2) {
        let [left, right] = window else { continue };
        if is_subject(left) && is_catalog_number(right) {
            return Some(format!("{} {}", left.to_uppercase(), right));
        }
    }
    tokens.iter().find_map(|token| {
        let split = token.find(|c: char| c.is_ascii_digit())?;
        let (subject, number) = token.split_at(split);
        (is_subject(subject) && is_catalog_number(number))
            .then(|| format!("{} {}", subject.to_uppercase(), number))
    })
}

fn is_subject(value: &str) -> bool {
    let len = value.chars().count();
    (2..=4).contains(&len) && value.chars().all(|c| c.is_ascii_alphabetic())
}

fn is_catalog_number(value: &str) -> bool {
    let digits = value.trim_end_matches(|c: char| c.is_ascii_alphabetic());
    digits.len() == 3 && digits.chars().all(|c| c.is_ascii_digit())
}

/// A horizontal band of tokens that read as one line.
#[derive(Debug)]
struct Row {
    tokens: Vec<OcrToken>,
}

impl Row {
    fn text(&self) -> String {
        self.tokens
            .iter()
            .map(|token| token.text.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// Group tokens into rows by vertical position.
///
/// Clustering on the vertical midpoint rather than the top edge is what makes
/// this work: two words on one line rarely share a `top`, because a glyph with a
/// descender is taller than one without.
fn cluster_rows(tokens: &[OcrToken]) -> Vec<Row> {
    let mut sorted: Vec<OcrToken> = tokens.to_vec();
    if sorted.is_empty() {
        return Vec::new();
    }
    sorted.sort_by_key(|token| (token.center_y(), token.left));

    // A tolerance proportional to the text size, so the same code works on a
    // dense laptop screenshot and a phone capture at 3x.
    let mut heights: Vec<i64> = sorted.iter().map(|token| token.height).collect();
    heights.sort_unstable();
    let median = heights[heights.len() / 2].max(1);
    let tolerance = (median * 6) / 10;

    let mut rows: Vec<Row> = Vec::new();
    for token in sorted {
        let center = token.center_y();
        match rows.last_mut() {
            Some(row)
                if (center
                    - row
                        .tokens
                        .iter()
                        .map(|existing| existing.center_y())
                        .sum::<i64>()
                        / row.tokens.len() as i64)
                    .abs()
                    <= tolerance =>
            {
                row.tokens.push(token);
            }
            _ => rows.push(Row {
                tokens: vec![token],
            }),
        }
    }
    for row in &mut rows {
        row.tokens.sort_by_key(|token| token.left);
    }
    rows
}

/// Read a schedule out of OCR tokens.
pub fn read_schedule(segment: &Segment, context: &ScheduleContext) -> ScheduleReading {
    if segment.tokens.is_empty() {
        return ScheduleReading {
            warnings: vec!["This image had no readable text.".into()],
            ..ScheduleReading::default()
        };
    }
    let vocabulary = WeekdayVocabulary::from_layouts(context.layouts);
    let rows = cluster_rows(&segment.tokens);

    // The grid is tried first only when a weekday header row is actually
    // present. Without one there are no columns to assign anything to, and
    // guessing at them is how a reader invents a timetable.
    let prefers_grid = context
        .layouts
        .iter()
        .any(|layout| layout.shape == ScheduleShape::Grid);
    let mut reading = match find_header_row(&rows, &vocabulary) {
        Some(header) if prefers_grid || context.layouts.is_empty() => {
            read_grid(&rows, header, &vocabulary, context)
        }
        _ => ScheduleReading::default(),
    };
    if reading.candidates.is_empty() {
        // The list reader gets its turn, but the grid reader's diagnosis is kept:
        // "the times are only in the left-hand column" is worth far more to a
        // student than the generic message the fallback would leave behind.
        let diagnosis = std::mem::take(&mut reading.warnings);
        reading = read_list(&rows, &vocabulary, context);
        if reading.candidates.is_empty() {
            reading.warnings.extend(diagnosis);
        }
    }

    reading.candidates.truncate(MAX_MEETINGS);
    reading.confident = is_self_consistent(&reading.candidates, context);
    if reading.candidates.is_empty() && reading.warnings.is_empty() {
        reading
            .warnings
            .push("No class times could be read from this image.".into());
    }
    reading
}

/// The row of weekday headers, if the image has one.
///
/// Three is the threshold because two is not a week: a pair of day-shaped tokens
/// turns up in prose often enough that treating them as a header is how noise
/// becomes a schedule.
fn find_header_row(rows: &[Row], vocabulary: &WeekdayVocabulary) -> Option<usize> {
    rows.iter().position(|row| {
        let days: Vec<u8> = row
            .tokens
            .iter()
            .filter_map(|token| vocabulary.header_weekday(&token.text))
            .collect();
        let mut unique = days.clone();
        unique.sort_unstable();
        unique.dedup();
        unique.len() >= 3 && unique.len() == days.len()
    })
}

/// The hours ruler down the left of a week view.
///
/// A real calendar prints its times once, in a gutter, and puts nothing but the
/// course and room inside each block. So the times are not in the blocks and
/// cannot be read from them — they have to come from the ruler and the block's
/// position against it.
struct TimeRuler {
    /// `(centre y, minutes since midnight)`, ascending by y.
    points: Vec<(i64, u32)>,
}

impl TimeRuler {
    fn from_rows(rows: &[Row], right_bound: i64) -> Self {
        let mut points: Vec<(i64, u32)> = rows
            .iter()
            .filter_map(|row| {
                let gutter: Vec<&OcrToken> = row
                    .tokens
                    .iter()
                    .filter(|token| token.center_x() < right_bound)
                    .collect();
                if gutter.is_empty() {
                    return None;
                }
                let words: Vec<&str> = gutter.iter().map(|t| t.text.as_str()).collect();
                let stitched = join_meridiems(&words);
                let minutes = stitched.iter().find_map(|word| to_minutes(word))?;
                let y = gutter.iter().map(|token| token.center_y()).sum::<i64>()
                    / gutter.len() as i64;
                Some((y, minutes))
            })
            .collect();
        points.sort_by_key(|(y, _)| *y);
        points.dedup_by_key(|(_, minutes)| *minutes);
        Self { points }
    }

    /// Minutes per pixel and the intercept, by least squares over the ruler.
    ///
    /// A fit rather than a nearest-neighbour lookup because the labels are
    /// evenly spaced and individually noisy; the line through all of them is
    /// steadier than any two of them.
    fn fit(&self) -> Option<(f64, f64)> {
        if self.points.len() < 3 {
            return None;
        }
        let n = self.points.len() as f64;
        let mean_y = self.points.iter().map(|(y, _)| *y as f64).sum::<f64>() / n;
        let mean_m = self.points.iter().map(|(_, m)| *m as f64).sum::<f64>() / n;
        let mut covariance = 0.0;
        let mut variance = 0.0;
        for (y, minutes) in &self.points {
            let dy = *y as f64 - mean_y;
            covariance += dy * (*minutes as f64 - mean_m);
            variance += dy * dy;
        }
        if variance <= f64::EPSILON {
            return None;
        }
        let slope = covariance / variance;
        // A calendar runs downwards at a sane number of minutes per pixel.
        if slope <= 0.0 || slope > 5.0 {
            return None;
        }
        Some((slope, mean_m - slope * mean_y))
    }
}

/// A run of rows in one day-column that read as a single class.
struct Block {
    rows: Vec<Row>,
    top: i64,
    bottom: i64,
}

fn read_grid(
    rows: &[Row],
    header_index: usize,
    vocabulary: &WeekdayVocabulary,
    context: &ScheduleContext,
) -> ScheduleReading {
    let header = &rows[header_index];
    // Each weekday header anchors a column, and a column's span runs to halfway
    // towards its neighbours, so a block is assigned by where it sits rather
    // than by its left edge alone.
    let mut columns: Vec<(u8, i64)> = header
        .tokens
        .iter()
        .filter_map(|token| {
            vocabulary
                .header_weekday(&token.text)
                .map(|weekday| (weekday, token.center_x()))
        })
        .collect();
    columns.sort_by_key(|(_, center)| *center);
    let centers: Vec<i64> = columns.iter().map(|(_, center)| *center).collect();
    let bounds: Vec<(u8, i64, i64)> = columns
        .iter()
        .enumerate()
        .map(|(index, (weekday, center))| {
            let left = if index == 0 {
                // The first column's left edge is real, not infinite: everything
                // to its left is the ruler.
                center - (centers.get(1).copied().unwrap_or(*center + 200) - center) / 2
            } else {
                (centers[index - 1] + center) / 2
            };
            let right = if index + 1 == centers.len() {
                i64::MAX / 4
            } else {
                (center + centers[index + 1]) / 2
            };
            (*weekday, left, right)
        })
        .collect();
    let gutter_bound = bounds.first().map(|(_, left, _)| *left).unwrap_or(0);

    let body: Vec<&Row> = rows.iter().skip(header_index + 1).collect();
    let owned: Vec<Row> = body
        .iter()
        .map(|row| Row {
            tokens: row.tokens.clone(),
        })
        .collect();
    let ruler = TimeRuler::from_rows(&owned, gutter_bound);

    // Gather each day-column's blocks before reading any of them, because the
    // drawing offset is shared and can only be recovered from all of them.
    let mut pending: Vec<(u8, Block)> = Vec::new();
    for (weekday, left, right) in &bounds {
        let column: Vec<OcrToken> = owned
            .iter()
            .flat_map(|row| row.tokens.iter())
            .filter(|token| token.center_x() >= *left && token.center_x() < *right)
            .cloned()
            .collect();
        for block in blocks_in_column(&column) {
            pending.push((*weekday, block));
        }
    }

    let mut reading = ScheduleReading::default();
    let mut blocks_without_times = 0;

    for (weekday, block) in &pending {
        let text = block
            .rows
            .iter()
            .map(|row| row.text())
            .collect::<Vec<_>>()
            .join(" ");
        let words: Vec<&str> = text.split_whitespace().collect();
        let stitched = join_meridiems(&words);
        let words: Vec<&str> = stitched.iter().map(String::as_str).collect();
        let Some(course) = course_code(&words) else {
            continue;
        };

        // The time has to be printed in the block. A block's height is a drawn
        // rectangle and OCR only ever sees the words inside it, so where the
        // class *ends* is not recoverable from the ruler however carefully the
        // start is fitted — and a class with an invented duration is worse than
        // one this declines to read.
        let Some((starts, ends)) = block_time_range(block) else {
            blocks_without_times += 1;
            continue;
        };
        if starts >= ends || !(EARLIEST_MINUTE..=LATEST_MINUTE).contains(&starts) {
            continue;
        }

        let confidence = block
            .rows
            .iter()
            .flat_map(|row| row.tokens.iter())
            .map(|token| token.confidence)
            .sum::<f64>()
            / block
                .rows
                .iter()
                .map(|row| row.tokens.len())
                .sum::<usize>()
                .max(1) as f64;

        let mut warnings = Vec::new();
        // A misread digit turns PSY 101 into PSY 401, which is a wrong course
        // rather than a missing one, and nothing downstream can tell.
        if confidence < 0.75 {
            warnings.push(format!(
                "\"{course}\" was read with low confidence. Check the course code."
            ));
        }

        reading.candidates.push(ExtractedCandidate {
            kind: "class_meeting".into(),
            title: course.clone(),
            course,
            evidence: text,
            source_locator: context.source_locator.clone(),
            source_uid: String::new(),
            confidence: confidence.clamp(0.0, 1.0),
            weekdays: vec![i64::from(*weekday)],
            starts_at_local: format_clock(starts),
            ends_at_local: format_clock(ends),
            timezone: context.timezone.clone(),
            warnings,
            ..ExtractedCandidate::default()
        });
    }

    // Saying which kind of unreadable this is matters: a student who knows the
    // times are only in the left-hand column knows to try the other reader,
    // where a bare "nothing found" tells them nothing.
    if reading.candidates.is_empty() && blocks_without_times > 0 && ruler.fit().is_some() {
        reading.warnings.push(
            "This looks like a week view whose class times are only in the left-hand column. \
             Coqui can read which days each class meets but not how long it runs, so it has not \
             guessed. Try the AI reader, or type the times in."
                .into(),
        );
    }

    merge_identical_meetings(&mut reading.candidates);
    reading
}

/// Split a day-column into blocks, one per class.
///
/// A block is a run of rows sitting close together; the gap to the next class is
/// several times a line's height.
fn blocks_in_column(tokens: &[OcrToken]) -> Vec<Block> {
    let rows = cluster_rows(tokens);
    if rows.is_empty() {
        return Vec::new();
    }
    let mut heights: Vec<i64> = tokens.iter().map(|token| token.height).collect();
    heights.sort_unstable();
    let median = heights[heights.len() / 2].max(1);
    let split = median * 3;

    let mut blocks: Vec<Block> = Vec::new();
    for row in rows {
        let top = row.tokens.iter().map(|token| token.top).min().unwrap_or(0);
        let bottom = row.tokens.iter().map(|token| token.bottom()).max().unwrap_or(0);
        match blocks.last_mut() {
            Some(block) if top - block.bottom <= split => {
                block.bottom = block.bottom.max(bottom);
                block.rows.push(row);
            }
            _ => blocks.push(Block {
                rows: vec![row],
                top,
                bottom,
            }),
        }
    }
    blocks
}

/// A time range printed inside the block itself, when the calendar prints one.
fn block_time_range(block: &Block) -> Option<(u32, u32)> {
    let text = block
        .rows
        .iter()
        .map(|row| row.text())
        .collect::<Vec<_>>()
        .join(" ");
    let words: Vec<&str> = text.split_whitespace().collect();
    let stitched = join_meridiems(&words);
    let words: Vec<&str> = stitched.iter().map(String::as_str).collect();
    time_range(&words)
}

/// A class read out of one day-column of a grid.
struct Meeting {
    title: String,
    course: String,
    starts: u32,
    ends: u32,
    evidence: String,
    confidence: f64,
}

impl Meeting {
    fn into_candidate(
        self,
        weekdays: Vec<u8>,
        timezone: &str,
        locator: &str,
    ) -> ExtractedCandidate {
        ExtractedCandidate {
            kind: "class_meeting".into(),
            title: self.title,
            course: self.course,
            evidence: self.evidence,
            source_locator: locator.into(),
            // Stable across re-imports of the same schedule, so a second paste
            // updates the class rather than adding a duplicate.
            source_uid: String::new(),
            confidence: self.confidence,
            weekdays: weekdays.into_iter().map(i64::from).collect(),
            starts_at_local: format_clock(self.starts),
            ends_at_local: format_clock(self.ends),
            timezone: timezone.into(),
            warnings: Vec::new(),
            ..ExtractedCandidate::default()
        }
    }
}

/// Split a day-column into individual classes and read each one.
fn meetings_from_column(tokens: &[OcrToken], _context: &ScheduleContext) -> Vec<Meeting> {
    let rows = cluster_rows(tokens);
    let mut meetings = Vec::new();
    let mut current: Vec<&Row> = Vec::new();
    // A row that carries a time range opens a new class; the rows beneath it
    // belong to it until the next one does.
    for row in &rows {
        let raw: Vec<&str> = row.tokens.iter().map(|t| t.text.as_str()).collect();
        let stitched = join_meridiems(&raw);
        let has_time = stitched.iter().any(|word| clock_token(word));
        if has_time && !current.is_empty() {
            if let Some(meeting) = meeting_from_rows(&current) {
                meetings.push(meeting);
            }
            current.clear();
        }
        current.push(row);
    }
    if let Some(meeting) = meeting_from_rows(&current) {
        meetings.push(meeting);
    }
    meetings
}

fn meeting_from_rows(rows: &[&Row]) -> Option<Meeting> {
    if rows.is_empty() {
        return None;
    }
    let text = rows
        .iter()
        .map(|row| row.text())
        .collect::<Vec<_>>()
        .join(" ");
    let raw: Vec<&str> = text.split_whitespace().collect();
    let stitched = join_meridiems(&raw);
    let words: Vec<&str> = stitched.iter().map(String::as_str).collect();
    let (starts, ends) = time_range(&words)?;
    let course = course_code(&words).unwrap_or_default();
    let title = if course.is_empty() {
        words
            .iter()
            .filter(|word| !clock_token(word) && **word != "-" && **word != "–")
            .take(6)
            .cloned()
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        course.clone()
    };
    if title.trim().is_empty() {
        return None;
    }
    let confidence = rows
        .iter()
        .flat_map(|row| row.tokens.iter())
        .map(|token| token.confidence)
        .sum::<f64>()
        / rows.iter().map(|row| row.tokens.len()).sum::<usize>().max(1) as f64;
    Some(Meeting {
        title,
        course,
        starts,
        ends,
        // Evidence has to be a literal span of the OCR text, because that is what
        // the review queue quotes back and what the managed-AI path is checked
        // against. Building it from the tokens keeps that true by construction.
        evidence: text,
        confidence: confidence.clamp(0.0, 1.0),
    })
}

/// The first plausible start/end pair in a row.
fn time_range(words: &[&str]) -> Option<(u32, u32)> {
    let times: Vec<u32> = words.iter().filter_map(|word| to_minutes(word)).collect();
    let (starts, ends) = match times.as_slice() {
        [starts, ends, ..] => (*starts, *ends),
        // A single time is a start with no end. Assuming a duration would be
        // inventing one, so the row is left for the student.
        _ => return None,
    };
    (starts < ends && (EARLIEST_MINUTE..=LATEST_MINUTE).contains(&starts)).then_some((starts, ends))
}

/// Read a one-row-per-class list.
fn read_list(
    rows: &[Row],
    vocabulary: &WeekdayVocabulary,
    context: &ScheduleContext,
) -> ScheduleReading {
    let mut reading = ScheduleReading::default();
    for row in rows {
        let raw: Vec<&str> = row.tokens.iter().map(|t| t.text.as_str()).collect();
        let stitched = join_meridiems(&raw);
        let words: Vec<&str> = stitched.iter().map(String::as_str).collect();
        let Some((starts, ends)) = time_range(&words) else {
            continue;
        };
        let text = row.text();
        let course = course_code(&words).unwrap_or_default();
        // The days token reads *entirely* as weekdays. Anything less strict and
        // the subject code wins: "MAT" scans as Monday-and-Tuesday, which files a
        // Tuesday/Thursday class on Monday without anything looking wrong.
        let subject = course.split_whitespace().next().unwrap_or_default();
        let weekdays = words
            .iter()
            .filter(|word| !clock_token(word) && !word.eq_ignore_ascii_case(subject))
            .find_map(|word| vocabulary.parse_days_strict(word))
            .unwrap_or_default();
        if weekdays.is_empty() {
            continue;
        }
        let title = if course.is_empty() {
            continue;
        } else {
            course.clone()
        };
        let confidence = row.tokens.iter().map(|token| token.confidence).sum::<f64>()
            / row.tokens.len().max(1) as f64;
        reading.candidates.push(
            Meeting {
                title,
                course,
                starts,
                ends,
                evidence: text,
                confidence: confidence.clamp(0.0, 1.0),
            }
            .into_candidate(weekdays, &context.timezone, &context.source_locator),
        );
    }
    merge_identical_meetings(&mut reading.candidates);
    reading
}

/// Collapse a class that appears once per day-column into one weekly series.
///
/// A grid draws Monday, Wednesday and Friday separately; they are one class, and
/// the app's whole position on this is that a weekly rule becomes one editable
/// pattern rather than a pile of occurrences.
fn merge_identical_meetings(candidates: &mut Vec<ExtractedCandidate>) {
    let mut merged: Vec<ExtractedCandidate> = Vec::new();
    for candidate in candidates.drain(..) {
        match merged.iter_mut().find(|existing| {
            existing.title == candidate.title
                && existing.starts_at_local == candidate.starts_at_local
                && existing.ends_at_local == candidate.ends_at_local
        }) {
            Some(existing) => {
                for weekday in candidate.weekdays {
                    if !existing.weekdays.contains(&weekday) {
                        existing.weekdays.push(weekday);
                    }
                }
                existing.weekdays.sort_unstable();
                existing.confidence = existing.confidence.min(candidate.confidence);
            }
            None => merged.push(candidate),
        }
    }
    for candidate in &mut merged {
        candidate.source_uid = format!(
            "schedule:{}:{}:{}",
            candidate.title.to_lowercase().replace(' ', "-"),
            candidate.starts_at_local,
            candidate
                .weekdays
                .iter()
                .map(|day| day.to_string())
                .collect::<Vec<_>>()
                .join("")
        );
    }
    *candidates = merged;
}

/// Whether a reading hangs together well enough to stand on its own.
///
/// This is what decides whether the AI reader is offered, so it is deliberately
/// about internal contradiction rather than about confidence scores: two classes
/// overlapping on the same day, or a time outside waking hours, means the layout
/// was misread, and no amount of OCR certainty changes that.
fn is_self_consistent(candidates: &[ExtractedCandidate], context: &ScheduleContext) -> bool {
    if candidates.is_empty() {
        return false;
    }
    for candidate in candidates {
        let (Some(starts), Some(ends)) = (
            to_minutes(&candidate.starts_at_local),
            to_minutes(&candidate.ends_at_local),
        ) else {
            return false;
        };
        if starts >= ends || starts < EARLIEST_MINUTE || ends > LATEST_MINUTE + 60 {
            return false;
        }
        if candidate.weekdays.is_empty() {
            return false;
        }
    }
    for (index, candidate) in candidates.iter().enumerate() {
        for other in candidates.iter().skip(index + 1) {
            let shares_day = candidate
                .weekdays
                .iter()
                .any(|day| other.weekdays.contains(day));
            if !shares_day {
                continue;
            }
            let (a_start, a_end) = (
                to_minutes(&candidate.starts_at_local).unwrap_or(0),
                to_minutes(&candidate.ends_at_local).unwrap_or(0),
            );
            let (b_start, b_end) = (
                to_minutes(&other.starts_at_local).unwrap_or(0),
                to_minutes(&other.ends_at_local).unwrap_or(0),
            );
            if a_start < b_end && b_start < a_end {
                return false;
            }
        }
    }
    // A code that matches nothing the student has is a hint, not a verdict: it
    // lowers confidence so the AI reader is offered, and never drops a class.
    if !context.known_courses.is_empty() {
        let recognised = candidates
            .iter()
            .filter(|candidate| {
                context
                    .known_courses
                    .iter()
                    .any(|known| known.eq_ignore_ascii_case(&candidate.course))
            })
            .count();
        if recognised * 2 < candidates.len() {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::school_provider::SchoolProvider;

    fn asu_layouts() -> Vec<ScheduleLayout> {
        let providers: Vec<SchoolProvider> = serde_json::from_str(include_str!(
            "../resources/institution-setup-providers.json"
        ))
        .unwrap();
        providers[0].schedule_layouts.clone()
    }

    fn context(layouts: &[ScheduleLayout]) -> ScheduleContext<'_> {
        ScheduleContext {
            layouts,
            timezone: "America/Phoenix".into(),
            source_locator: "screenshot".into(),
            known_courses: Vec::new(),
        }
    }

    fn segment(tsv: &str) -> Segment {
        crate::imports::parse_tesseract_tsv_for_test(tsv, "screenshot").unwrap()
    }

    /// Shared with `scripts/test/schedule-reader.test.mjs`, which runs the same
    /// table through `parseDays` and `to24Hour` in
    /// `scripts/catalog/asu-class-search.mjs`. The two implementations are in
    /// different languages and cannot be shared, so this is what stops one being
    /// fixed without the other.
    ///
    /// Keep in lockstep with GOLDEN_WEEKDAY_VECTOR in that file.
    const GOLDEN_WEEKDAY_VECTOR: &[(&str, &[u8])] = &[
        ("M", &[1]),
        ("MWF", &[1, 3, 5]),
        ("TTh", &[2, 4]),
        ("TuTh", &[2, 4]),
        ("Th", &[4]),
        ("SuSa", &[0, 6]),
        ("MTWThF", &[1, 2, 3, 4, 5]),
        ("F", &[5]),
        ("W", &[3]),
    ];

    const GOLDEN_CLOCK_VECTOR: &[(&str, &str)] = &[
        ("9:00 AM", "09:00"),
        ("12:00 PM", "12:00"),
        ("12:30 AM", "00:30"),
        ("1:15 PM", "13:15"),
        ("11:59 PM", "23:59"),
        // Dotted meridiems. These read as None until 0.10.1, so a schedule
        // printed this way produced no times at all and every row was dropped.
        ("1:30 p.m.", "13:30"),
        ("9:00 a.m.", "09:00"),
        ("11:05 A.M.", "11:05"),
    ];

    #[test]
    fn weekday_parsing_matches_the_published_golden_vector() {
        let vocabulary = WeekdayVocabulary::from_layouts(&asu_layouts());
        for (input, expected) in GOLDEN_WEEKDAY_VECTOR {
            assert_eq!(
                vocabulary.parse_days(input),
                expected.to_vec(),
                "parsing {input}"
            );
        }
        // The digraph rule, which is the whole reason this is not a character
        // loop: Thursday must not read as Tuesday followed by a stray h.
        assert_eq!(vocabulary.parse_days("Th"), vec![4]);
        assert_ne!(vocabulary.parse_days("Th"), vec![2]);
    }

    #[test]
    fn clock_parsing_matches_the_published_golden_vector() {
        for (input, expected) in GOLDEN_CLOCK_VECTOR {
            assert_eq!(
                to_minutes(input).map(format_clock).as_deref(),
                Some(*expected),
                "parsing {input}"
            );
        }
        // A schedule printed on a 24-hour clock reads too.
        assert_eq!(to_minutes("14:05").map(format_clock).as_deref(), Some("14:05"));
        assert_eq!(to_minutes("not a time"), None);
        assert_eq!(to_minutes("25:00"), None);
        assert_eq!(to_minutes("9:70 AM"), None);
    }

    #[test]
    fn a_school_can_redefine_its_weekday_tokens() {
        // Some registrars spell Thursday "R". Nothing in the reader knows that;
        // the descriptor says so, which is the whole point.
        let layouts = vec![ScheduleLayout {
            id: "custom".into(),
            name: "Custom".into(),
            shape: ScheduleShape::List,
            weekday_tokens: vec![
                crate::school_provider::WeekdayTokens {
                    weekday: 1,
                    tokens: vec!["m".into()],
                },
                crate::school_provider::WeekdayTokens {
                    weekday: 4,
                    tokens: vec!["r".into()],
                },
            ],
            ..ScheduleLayout::default()
        }];
        let vocabulary = WeekdayVocabulary::from_layouts(&layouts);
        assert_eq!(vocabulary.parse_days("MR"), vec![1, 4]);
    }

    #[test]
    fn course_codes_are_found_in_either_spelling() {
        assert_eq!(course_code(&["PSY", "101"]), Some("PSY 101".into()));
        assert_eq!(course_code(&["CSE240"]), Some("CSE 240".into()));
        assert_eq!(course_code(&["Intro", "to", "Ethics"]), None);
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ExpectedMeeting {
        title: String,
        weekdays: Vec<i64>,
        starts_at_local: String,
        ends_at_local: String,
    }

    fn read_fixture(name: &str) -> ScheduleReading {
        let tsv = std::fs::read_to_string(format!(
            "{}/test-fixtures/schedule/{name}.tsv",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        let layouts = asu_layouts();
        read_schedule(&segment(&tsv), &context(&layouts))
    }

    fn expected(name: &str) -> Vec<ExpectedMeeting> {
        let json = std::fs::read_to_string(format!(
            "{}/test-fixtures/schedule/{name}.expected.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        serde_json::from_str(&json).unwrap()
    }

    fn assert_matches_fixture(name: &str) {
        let reading = read_fixture(name);
        let mut got: Vec<_> = reading
            .candidates
            .iter()
            .map(|candidate| {
                (
                    candidate.title.clone(),
                    candidate.weekdays.clone(),
                    candidate.starts_at_local.clone(),
                    candidate.ends_at_local.clone(),
                )
            })
            .collect();
        got.sort();
        let mut want: Vec<_> = expected(name)
            .into_iter()
            .map(|meeting| {
                (
                    meeting.title,
                    meeting.weekdays,
                    meeting.starts_at_local,
                    meeting.ends_at_local,
                )
            })
            .collect();
        want.sort();
        assert_eq!(got, want, "fixture {name}");

        for candidate in &reading.candidates {
            assert_eq!(candidate.kind, "class_meeting");
            assert_eq!(candidate.timezone, "America/Phoenix");
            assert!(!candidate.source_uid.is_empty(), "a class needs a stable id");
        }
    }

    // Every fixture is the same three classes in a different layout, so a
    // difference in the answer is a difference in layout handling.
    //
    // These are real Tesseract output over real rendered screenshots, not token
    // streams written to suit the reader. The generator is
    // scripts/fixtures/render-schedule-images.py; the previous synthetic
    // fixtures passed while the reader could not read a single real grid.
    #[test]
    fn every_schedule_fixture_reads_to_its_expected_meetings() {
        for name in ["week-grid", "week-grid-3x", "google-week", "class-list"] {
            assert_matches_fixture(name);
        }
    }

    // A block's height is a drawn rectangle and OCR only ever sees the words
    // inside it, so a calendar that prints its hours only down the side says
    // when a class starts and never how long it runs. Declining is the correct
    // answer, and saying which kind of unreadable it is turns a dead end into a
    // next step.
    #[test]
    fn a_week_view_with_times_only_in_the_gutter_declines_and_explains() {
        let reading = read_fixture("week-grid-gutter-only");
        assert!(reading.candidates.is_empty());
        assert!(!reading.confident);
        let said = reading.warnings.join(" ");
        assert!(
            said.contains("left-hand column"),
            "the reader has to say why: {said:?}"
        );
    }

    // Measured, not assumed. Tesseract wants dark text on a light page, and a
    // dark-mode capture defeats it even after inversion; `invert_if_dark` in
    // imports.rs helps real captures but does not rescue this one. Declining is
    // still the right answer, and this pins that it declines rather than
    // inventing a timetable out of five recognised words.
    #[test]
    fn a_dark_mode_capture_declines_rather_than_guessing() {
        let reading = read_fixture("week-grid-dark");
        assert!(
            reading.candidates.is_empty(),
            "read {:?} out of a capture Tesseract could not resolve",
            reading.candidates
        );
        assert!(!reading.confident);
    }

    // A parser that hallucinates structure from noise is worse than one that
    // declines, because the student has no reason to doubt what it produced.
    #[test]
    fn an_unreadable_capture_produces_nothing_at_all() {
        let reading = read_fixture("unreadable-capture");
        assert!(
            reading.candidates.is_empty(),
            "read {:?} out of noise",
            reading.candidates
        );
        assert!(!reading.confident);
        assert!(!reading.warnings.is_empty(), "it has to say why");
    }

    // The same layout at 3x is the same schedule. Clustering on a tolerance
    // proportional to the text size is what makes that true.
    #[test]
    fn a_higher_density_screen_changes_nothing() {
        let laptop = read_fixture("week-grid");
        let phone = read_fixture("week-grid-3x");
        let summarise = |reading: &ScheduleReading| {
            let mut rows: Vec<_> = reading
                .candidates
                .iter()
                .map(|c| (c.title.clone(), c.weekdays.clone(), c.starts_at_local.clone()))
                .collect();
            rows.sort();
            rows
        };
        assert_eq!(summarise(&laptop), summarise(&phone));
    }

    // A grid draws one class once per day-column. It is one class.
    #[test]
    fn a_class_drawn_in_three_columns_is_one_weekly_pattern() {
        let reading = read_fixture("week-grid");
        let psy = reading
            .candidates
            .iter()
            .find(|candidate| candidate.title == "PSY 101")
            .expect("PSY 101 is in the fixture");
        assert_eq!(psy.weekdays, vec![1, 3, 5]);
        assert_eq!(
            reading
                .candidates
                .iter()
                .filter(|c| c.title == "PSY 101")
                .count(),
            1,
            "one series, not one per column"
        );
    }

    // Evidence is quoted back in the review queue, so it has to be a literal
    // span of what was read rather than a summary of it.
    #[test]
    fn evidence_is_text_that_was_actually_on_the_page() {
        let reading = read_fixture("class-list");
        for candidate in &reading.candidates {
            assert!(!candidate.evidence.trim().is_empty());
            assert!(
                candidate.evidence.contains(&candidate.course),
                "evidence {:?} does not mention {}",
                candidate.evidence,
                candidate.course
            );
        }
    }



    // The signal that decides whether the AI reader is offered. Two classes in
    // one place at one time means the layout was misread, whatever the OCR
    // confidence says.
    #[test]
    fn overlapping_meetings_are_not_treated_as_a_confident_read() {
        let layouts = asu_layouts();
        let overlapping = vec![
            ExtractedCandidate {
                kind: "class_meeting".into(),
                title: "PSY 101".into(),
                weekdays: vec![1],
                starts_at_local: "09:00".into(),
                ends_at_local: "10:00".into(),
                ..ExtractedCandidate::default()
            },
            ExtractedCandidate {
                kind: "class_meeting".into(),
                title: "MAT 142".into(),
                weekdays: vec![1],
                starts_at_local: "09:30".into(),
                ends_at_local: "10:30".into(),
                ..ExtractedCandidate::default()
            },
        ];
        assert!(!is_self_consistent(&overlapping, &context(&layouts)));

        // The same two classes on different days are perfectly ordinary.
        let mut apart = overlapping;
        apart[1].weekdays = vec![2];
        assert!(is_self_consistent(&apart, &context(&layouts)));
    }

    #[test]
    fn a_meeting_outside_waking_hours_is_a_misread_gutter() {
        let layouts = asu_layouts();
        let nocturnal = vec![ExtractedCandidate {
            kind: "class_meeting".into(),
            title: "PSY 101".into(),
            weekdays: vec![1],
            starts_at_local: "03:00".into(),
            ends_at_local: "04:00".into(),
            ..ExtractedCandidate::default()
        }];
        assert!(!is_self_consistent(&nocturnal, &context(&layouts)));
    }

    #[test]
    fn an_image_with_no_text_says_so_rather_than_failing() {
        let layouts = asu_layouts();
        let empty = Segment {
            text: String::new(),
            locator: "screenshot".into(),
            confidence: 0.0,
            tokens: Vec::new(),
        };
        let reading = read_schedule(&empty, &context(&layouts));
        assert!(reading.candidates.is_empty());
        assert!(!reading.warnings.is_empty());
    }
}

