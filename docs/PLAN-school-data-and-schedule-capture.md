# Plan: school data providers + schedule screenshot capture

Target: v0.10.0, starting from v0.9.2.

Two related goals:

1. **Onboarding knows the school's calendar.** A student picks their institution
   and the term dates, campuses and no-class dates are already filled in from
   the school's own public pages, with a visible source and a review step.
2. **A student can paste a screenshot of their schedule** and get their courses
   and weekly class meetings back, sorted, in the existing review queue.

Read this whole file before writing code. `docs/BACKLOG.md` §1 and the
"Decisions already made" section are still binding — this plan extends them, it
does not overturn them.

---

## How to run this

Work phase by phase. Do not start a later phase until the earlier one's
acceptance criteria pass, because Phase 1 changes a contract that Phases 3–5
depend on.

Before and after every phase:

```
npm run check && npm test
```

`npm test` runs `node --test scripts/test/*.test.mjs`, the workspace tests, and
`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`. The 0.9.2
baseline is 104 native Rust tests, 22 UI tests, 28 script tests and 44
cloud-service tests.

---

## Decisions locked before starting

These came from a scoping conversation. They are inputs, not open questions.

**Generic mechanisms, school-specific data.** No school gets its own Rust module,
its own TypeScript branch, or an `if institution_id == "104151"`. Anything ASU
needs beyond the generic path is expressed as a **declarative descriptor file**
that any school could fill in. If a feature cannot be stated as data, it does not
ship. This is the strictest constraint in the plan and the easiest to violate by
accident — the fastest way to make a screenshot parse correctly is to hardcode
the layout of the one screenshot in front of you.

**School data arrives three ways, in this order of trust:** a bundled snapshot
that makes onboarding work with no network at all; an in-app refresh that fetches
the school's public pages and shows a diff for review; and the existing
build-time harvest scripts that regenerate the bundle for release. All three feed
the same schema and the same review gate.

**Screenshot parsing is vision-first with a local fallback.** A vision model
through `services/cloud-api` gives the best result on grid layouts, and the local
Tesseract runtime already in the app handles the offline and opted-out cases.
Neither path writes anything without review. See Phase 3 for the constraint that
makes this safe.

**Clipboard paste uses the DOM `paste` event**, not a Tauri clipboard plugin. The
image comes from `event.clipboardData.files` and its bytes go to a native
command. `capabilities/default.json` gains no new permission.

**Fixtures are synthesized deterministically** from a committed generator rather
than captured from real accounts. Real captures can replace them later without
touching the tests, and nothing needs redacting.

**Screenshots are shredded once every candidate from them is resolved.** The OCR
text is kept so evidence quotes still render. One preference turns it off.

---

## What already exists — do not rebuild it

| Thing | Where |
|---|---|
| 6,243 bundled US institutions, searchable | `apps/desktop/src-tauri/resources/institutions-us.json`, `search_institutions` in `main.rs` |
| Per-institution campuses + term dates, with source labels | `resources/institution-setup-providers.json`, `get_institution_setup_options` in `main.rs` |
| Bundled course catalog w/ sections, weekdays, times, campus | `resources/institution-catalogs.json`, `search_course_suggestions` in `main.rs` |
| Catalog build + verify pipeline | `npm run catalog:prepare` / `catalog:verify`, `scripts/prepare-course-catalog.mjs`, `scripts/verify-course-catalog.mjs` |
| A working column-layout schedule parser | `scripts/catalog/asu-class-search.mjs` — `parseClassSearch`, `parseDays`, `to24Hour`, `parseLocation` |
| Local OCR for images and scanned PDFs | `apps/desktop/src-tauri/src/imports.rs` — `ocr_image`, `ocr_scanned_pdf`, `parse_tesseract_tsv`, bounded via `run_bounded` |
| Import review with evidence + approval before mutation | `imports.rs` `ExtractedCandidate`, candidate kinds incl. `class_meeting` |
| Weekly-rule collapse into one series | `imports.rs` `weekly_pattern`, `candidates_from_event` |
| Managed AI structured extraction | `apps/desktop/src-tauri/src/managed_ai.rs`, `services/cloud-api` |
| DNS-pinned, redirect-blocking, private-network-blocking HTTPS client | `apps/desktop/src-tauri/src/canvas.rs` — copy this pattern for any new fetching |

The ASU term dates for Fall 2026 through Fall 2027 are **already in
`institution-setup-providers.json`**, hand-entered from
`registrar.asu.edu/academic-calendar`. Phase 2 is about making that data
self-refreshing and reachable for schools nobody typed in by hand — not about
getting ASU's dates in for the first time.

---

## Two blockers in the current code

Both are in `managed_ai.rs` and both will fail closed the moment a screenshot
flow is wired up. Fix them in Phase 1, before anything depends on them.

**1. `AiCandidate.kind` cannot express a class.** `validate_response` accepts
only `"task" | "commitment" | "assignment" | "exam"`. A schedule screenshot
produces `class_meeting` candidates — the kind `imports.rs` already emits and
`class_meeting_series` maps to in the mutation log. Until this list grows, every
schedule extraction is rejected as an invalid response.

**2. Evidence must be a literal substring of a text excerpt.**

```rust
|| !excerpt_folded.contains(&candidate.evidence.to_lowercase())
```

This is a good invariant — it is what stops the model inventing a due date — and
the plan keeps it rather than weakening it. An image has no text excerpt, so the
naive vision request cannot satisfy it.

**Resolution.** Do not send the image alone. Run the local OCR pass first, and
send *both* the OCR text as `excerpt` and the image as an attachment. The model's
job becomes structuring text that was extracted locally, not reading pixels
unsupervised. `evidence` stays a substring of the OCR text and `validate_response`
needs no weakening on that axis. Accuracy still improves, because the failure on
grid layouts is almost never character recognition — it is knowing that the
"9:00" in the left gutter and the "PSY 101" in the third column belong to the
same class.

*Alternative, if the OCR text turns out too garbled to ground against:* add an
`ImageEvidence { page, bbox, ocr_text }` variant and validate that the box lies
inside the image bounds and its `ocr_text` matches the local OCR tokens inside
that box. More code, more surface, and it still needs the local OCR pass. Try the
recommended path first and only fall back to this if Phase 4's fixtures prove it
necessary.

Whichever path: `review_required` must stay forced true, `MAX_EXCERPT_CHARS`
still applies to the text half, and the image needs its own byte cap enforced in
`validate_input` (8 MiB, and reject anything that is not PNG/JPEG by content
sniff, reusing `detect_document`'s approach in `imports.rs`).

---

## Pre-work

**Fix a live bug that blocks Phase 3.** `get_document_evidence` in `main.rs`
`SELECT`s 15 columns but its row closure reads indices 15–18 for `weekdays`,
`starts_at_local`, `ends_at_local` and `timezone`. Every call errors for any
document that has candidates. Add the four columns to the `SELECT`, matching the
`dashboard` query, and add a regression test that imports a document and reads
its evidence back.

**Reconcile the e2e schema assertion.** `e2e/specs/first-run.spec.mjs` asserts
`schemaVersion === 11`; `docs/releases/0.9.2.md` says the schema moved to 12.
Establish which is right and correct whichever is wrong.

---

## Phase 0 — Provider descriptor schema

The foundation for "generic mechanisms, school-specific data". Everything later
reads this.

**Add** `packages/contracts/src/school-provider.ts` and its Rust mirror
`apps/desktop/src-tauri/src/school_provider.rs` defining a `SchoolProvider`
descriptor:

- `institutionId`, `schemaVersion`, `generatedAt`, `sourceLabel`, `sourceUrl`
- `campuses[]` — as `institution-setup-providers.json` already has
- `terms[]` — as it already has, plus `sessionCode` and `noClassDates[]`
- `calendarSource` — `{ url, kind: "ics" | "html-table" | "html-list", selector?, dateFormat?, rowPattern? }`
  — declarative enough that a new school is a JSON edit
- `catalogSource` — `{ kind: "none" | "ics" | "html-table" | "student-export", url?, ... }`
- `scheduleLayouts[]` — named layout hints for Phase 4: column order, weekday
  header tokens, time format, whether the grid is time-major or day-major

Migrate `institution-setup-providers.json` to this schema with a
`schemaVersion: 1` field and keep the existing ASU entry passing unchanged.

There is **no codegen** in this repo. Every Rust/TypeScript pair is hand-written
with `#[serde(rename_all = "camelCase")]`, and drift is caught by duplicated
bound checks plus golden vectors — see `sync_transport.rs` and
`packages/contracts/test/contracts.test.ts`. Follow that convention; do not
introduce `ts-rs` or `schemars`.

The resource is a top-level array compiled in via `include_str!`. Keep it an
array, add `schemaVersion` per entry, and make every new field
`#[serde(default)]` so the existing entry parses unchanged.

**Acceptance:** `get_institution_setup_options` returns identical output to
v0.9.2 for institution `104151`. A round-trip test parses the descriptor file,
re-serializes, and asserts equality. `catalog:verify` still passes.

---

## Phase 1 — Widen the managed-AI contract

Fixes both blockers above. The contract lives in **three** hand-maintained
places and all three change:

1. `packages/contracts/src/index.ts` — Zod `AiStructureRequest`, `AiCandidate`,
   `AiStructureResult`.
2. `services/cloud-api/src/app.ts` — `academicCandidateSchema`, the JSON Schema
   handed to the model with `strict: true`.
3. `apps/desktop/src-tauri/src/managed_ai.rs` — Rust structs and
   `validate_response`.

- Add `"class_meeting"` and `"academic_event"` to the accepted `kind` list, and
  add the fields a class needs to `AiCandidate`: `weekdays: Vec<u8>` (0=Sunday,
  matching `DAY_INDEX` in `scripts/catalog/asu-class-search.mjs` and the
  `weekdays` field in `institution-catalogs.json`), `startsAtLocal`,
  `endsAtLocal`, `location`, `component`, `modality`, `sectionNumber`. All new
  fields are optional/defaulted — `AiCandidate`, `AiUsage` and `AiResponse` carry
  `deny_unknown_fields` and desktop and cloud-api deploy independently, so both
  directions must tolerate the other being older.
- Validate them: weekdays unique, each 0–6, times `HH:MM` 24-hour with start
  before end, and a `class_meeting` candidate must carry at least one weekday
  **or** be explicitly marked `modality: "online"` (`institution-catalogs.json`
  already has async online sections with empty weekdays — that shape is legal).
- Add an optional `image` half to `AiRequest` with its own size cap and content
  sniff, per the resolution above. Mirror the validation in
  `services/cloud-api` so it fails closed on both sides.
- Do **not** relax the `excerpt_folded.contains(evidence)` check.

**Also fix the ingestion side, or this phase is inert.** `request_managed_ai` in
`main.rs` collapses every kind to `task`/`commitment` and its `INSERT` never
writes `weekdays`, `starts_at_local`, `ends_at_local` or `timezone` — the columns
already exist. Pass `class_meeting` through and populate them. `apply_candidate`
already maps `class_meeting` to `class_meeting_series`; decide and document what
`academic_event` maps to, or reject it at approval with a plain message.
`docs/BACKLOG.md` "Gotchas" warns that candidate `kind` is switched on in about
six places — find all of them.

**Acceptance:** new unit tests in `managed_ai.rs` covering: a valid
`class_meeting` response; rejection when weekdays contains `7`; rejection on
duplicate weekdays; rejection when `startsAtLocal >= endsAtLocal`; rejection when
evidence is not a substring of the excerpt; rejection of an oversized or
non-image attachment. Matching Zod tests and cloud-api route tests. The
repository conformance suite runs against both adapters as it does today.

---

## Phase 2 — Term dates and academic calendar from a school's public pages

Three surfaces, one schema.

**2a. Refresh command.** A `refresh_school_calendar(institution_id)` Tauri
command that fetches `calendarSource.url` and parses per the descriptor's
declared `kind`. Build the HTTP client by copying `canvas.rs`: DNS pinning,
no redirects, no proxy, private-network blocking, byte cap on both the declared
`Content-Length` and the streamed body, timeout, and a same-origin re-check on
every hop. It returns a **diff** against the bundled snapshot — added terms,
changed dates, new no-class dates — never a mutation. The existing
review-and-approve gate applies; a changed term date is a critical academic date
and must surface as an explicit conflict, the same as the Canvas path already
does.

Note the command **cannot** write back to `institution-setup-providers.json`:
that file is `include_str!`-compiled into the binary. The diff surfaces in the
review queue, and approving it writes to the student's own term records.

**2b. Bundled snapshot stays authoritative offline.** If the fetch fails, is
blocked, or the student declines, onboarding proceeds on the bundle exactly as
today. This must be true with the network cable pulled — test it that way.

**2c. Harvest script.** `npm run calendar:prepare -- --institution=<id>` reads
the same descriptor, fetches, parses, and rewrites the provider file, with
`npm run calendar:verify` wired into CI alongside `catalog:verify`. Same shape as
the existing catalog scripts, including the exported pure `verifyCalendars({...})`
returning `{ ready, problems }` and the `isMain` guard so tests can import it.
Add both to `package.json` scripts.

**Honest scoping note.** Registrar academic calendars are freely readable and
this will work for a large share of schools. Course catalogs mostly are not —
`docs/BACKLOG.md` records that ASU's class search answers 401 to anonymous
requests and authenticates through `weblogin.asu.edu`. **`catalogSource` must
support `kind: "none"` and the UI must degrade to the screenshot path from
Phase 4 without looking broken.** Do not add credential handling, session
replay, or anything that defeats an access control to make a catalog fetch work.
That decision stands.

**Acceptance:** a fixture-driven test parses a saved copy of a registrar HTML
calendar into terms with correct dates; the refresh command returns a diff and
mutates nothing; onboarding completes with networking disabled; `calendar:verify`
fails the build on a malformed regeneration.

---

## Phase 3 — Screenshot ingestion: capture and local read

The entry point and the offline path. No AI yet.

- **Clipboard paste and drag-drop.** An "Import a screenshot of your schedule"
  affordance in onboarding and in the import surface. `Ctrl/Cmd+V` with an image
  on the clipboard should just work — that is the interaction the whole feature
  is for. Handle the DOM `paste` event, read the image from
  `clipboardData.files`, and send the bytes to a new `import_document_bytes`
  command that shares everything after the read with `import_document`: the
  25 MiB cap, `detect_document` sniffing, the sha256 duplicate check, and the
  two-level XChaCha20-Poly1305 envelope encryption. Drag-drop already works via
  `listenForFileDrops` and the dialog filter already lists `png/jpg/jpeg`; widen
  the subscription past the import modal and add the drag-over state it lacks.
- **Local OCR with geometry.** `parse_tesseract_tsv` in `imports.rs` already
  reads the TSV, and `ocr_image` already asks Tesseract for `tsv` output, so
  `left/top/width/height` are on the wire and then discarded. Preserve the
  per-token geometry rather than flattening to a string — Phase 4 needs it and
  Phase 1's grounding needs the text. Add `tokens: Vec<OcrToken>` to `Segment`;
  it is additive, since every non-OCR producer sets an empty vector and
  `candidates_from_segments` keeps reading only `.text`. Read `word_num` too so
  within-line order is positional rather than emission-ordered, and cap tokens
  per segment — a dense screenshot is cheap, a hundred OCR'd PDF pages is not.
  This is the one change here with real downstream weight.
- The screenshot itself is a document like any other: encrypted into the vault,
  metadata recorded, evidence links back to it. Once every candidate from an
  image is approved or rejected, shred the encrypted blob and keep the OCR text.

**Acceptance:** pasting a PNG produces a stored, encrypted document and a token
list with coordinates; an unreadable image yields the existing
"marked for attention" state rather than an error dialog; OCR runs stay inside
the existing process and memory bounds in `run_bounded`.

---

## Phase 4 — Turn a screenshot into class meetings

Where the feature actually lands. Two parsers behind one interface, chosen at
runtime.

**Interface.** `ScheduleReader → Vec<ExtractedCandidate>` with candidates of kind
`class_meeting`, each carrying weekdays, local start/end, course code, title,
location, section, and an evidence string that is a literal substring of the OCR
text. `ExtractedCandidate` already has every one of those fields.

**4a. Geometric reader (local, always available).** Cluster OCR tokens by
x-position into columns and y-position into rows; find weekday header tokens
(`M`, `T`, `W`, `Th`, `F` and full names — from the descriptor's
`scheduleLayouts`, not hardcoded); read a time gutter; assign blocks to
day-columns by horizontal overlap.

Handle both common shapes: the **grid** (days across, times down) and the
**list** (one row per class, days as a `MWF` token in a column). The list shape
is closer to what `parseClassSearch` already does.

`parseDays` and `to24Hour` in `scripts/catalog/asu-class-search.mjs` already
handle the token-level work, including the `Th`/`T` ambiguity. They are
JavaScript and the reader is Rust, so they cannot literally be shared. Port them
faithfully — including the two-character digraph rule that stops `Th` parsing as
`T` + `h` — and pin the behaviour with a **cross-language golden vector**, the
convention this repo already uses for the signing message: one committed table of
input→output asserted identically by a Rust test and a `scripts/test/*.test.mjs`
test, so a fix on one side that is not mirrored fails loudly.

**4b. AI reader (opt-in).** Sends OCR text + image per Phase 1. Gated on an
explicit, per-import student action with a clear statement that the image leaves
the machine — this is the app's first flow that sends a *picture of the student's
own screen* anywhere, and it should read that way. It must be skippable and the
app must stay fully usable having skipped it.

**Selection.** Run the geometric reader first. If it returns nothing, or returns
candidates whose confidence or internal consistency is poor (overlapping meetings
in one day-column, times outside 06:00–23:00, a course code that matches no
enrolled or catalog course), offer the AI reader as a suggestion — never invoke
it silently.

**Merge.** Existing rules apply: file classes under the term containing the first
meeting, fall back to the active term, fail with a plain message if no term
exists. Emit one `class_meeting_series` per weekly pattern, not one commitment
per occurrence.

**Fixtures.** This is the difference between a demo and a feature. Six
screenshots covering: an ASU My Classes list, a Canvas calendar week, a Google
Calendar week, a phone screenshot at 3x scale, a dark-mode capture, and a
deliberately bad one (cropped, rotated a few degrees, low contrast). They are
synthesized deterministically by a committed generator so they are reproducible
and carry no real names; real captures can replace them later without touching
the tests. Commit them under
`apps/desktop/src-tauri/test-fixtures/schedule/` with expected-output JSON beside
each. The bad one's expected output is "no candidates, marked for attention" —
assert that too, because a parser that hallucinates structure from noise is worse
than one that declines.

**Acceptance:** every fixture parses to its expected JSON; the bad fixture
produces zero candidates rather than wrong ones; no fixture's expected output was
achieved by adding a school-specific branch.

---

## Phase 5 — Onboarding flow

Tie it together in `apps/desktop-ui/src/components/OnboardingExperience.tsx`.

Target shape: pick school → term dates are pre-filled and labelled with their
source and date → "Paste a screenshot of your schedule" → review a list of
detected classes with per-field evidence → confirm → done. Every pre-filled field
stays editable and shows where it came from; the existing four-stage autosave and
source-aware empty states are the pattern to extend, not replace.

Terms currently write only `termName`, `termStartsOn` and `termEndsOn`;
`classEndsOn`, `examStartsOn` and the new `noClassDates` exist on the preset and
are dropped. Surface them.

Typing everything by hand must remain a first-class path, working with no
network, no clipboard image, and no account.

**Acceptance:** an end-to-end run in `e2e/specs` from a fresh profile to a
populated timetable via screenshot; the same run with networking disabled falls
back to manual entry without a dead end; every auto-filled field displays its
source. Follow `first-run.spec.mjs`, including the `delete_local_profile`
teardown that keeps the suite re-runnable.

---

## Phase 6 — Documentation and release

- Update `README.md`'s feature list.
- Rewrite `docs/BACKLOG.md` §1 to reflect what shipped and what is still manual.
- Record in "Decisions already made": vision-model grounding is anchored to
  locally-extracted OCR text, and why; that an AI-read screenshot counts as the
  student fetching their own data, and why; and the screenshot retention default.
- `docs/releases/0.10.0.md` plus the Windows smoke checklist, following the
  existing files' shape. The smoke-record practice lapsed after 0.8.0 —
  reinstate it.
- Bump the version to 0.10.0. Do not tag or publish without asking.

---

## Invariants that must survive every phase

Check these at the end of each phase, not at the end of the project.

1. Nothing mutates canonical records without student review. Screenshots and
   fetched calendars are sources, not authorities.
2. Nothing defeats an access control to obtain data. No credential replay, no
   scraping behind a login, no bundling another student's authenticated harvest.
3. The app works fully offline. Every new network call is optional and fails
   closed with a plain message.
4. No secrets reach the webview. The screenshot path adds an image to the AI
   request; it does not add a provider key to the client.
5. No school-specific code. If a phase seems to need it, it needs a descriptor
   field instead — stop and add one.
6. Screenshots are encrypted at rest like every other imported document, and
   are not written to logs.

---

## Questions settled during scoping

- **Does an AI-read screenshot count as "the student fetching their own data"?**
  Yes. The image is the student's own screen, and they trigger each send
  explicitly with a statement that the image leaves the machine. This is
  materially different from harvesting another party's data through an access
  control, which invariant 2 forbids. Record the reasoning in
  `docs/BACKLOG.md`'s decisions log rather than leaving it implied.
- **Where do screenshots live after import?** Delete the image once every
  candidate from it is approved or dismissed, keeping the OCR text so evidence
  quotes still resolve. Default on, one preference to disable.
