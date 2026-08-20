# Backlog

Open work after 0.10.0, with the reasoning behind each item so it does not have to
be rediscovered. Ordered roughly by value.

Decisions already made are recorded at the bottom. Re-open them deliberately
rather than by accident.

---

## 1. Course catalog coverage

**What 0.10.0 changed.** A thin catalog matters less than it did. A student who
cannot find their course in the bundled 133 can now paste a screenshot of their
own schedule and get their classes back, which works at any school and is always
current — the third option this section used to list as the better product
answer. The catalog is now a convenience for typing a course name, not the only
road in.

**What is still manual.** Everything below. `catalogSource` for ASU is
`kind: "none"` and says why, and the class list is still whatever was exported by
hand.

**What is now automatic.** Only the *academic calendar*, not the catalog. A
school's term dates and no-class dates can be refreshed in-app from its published
registrar page, or regenerated at build time:

```
npm run calendar:prepare -- --institution=104151          # fetches, dry run
npm run calendar:prepare -- --institution=104151 --apply  # writes the descriptor
npm run calendar:verify
```

The refresh returns a diff and never writes; a changed term date surfaces as an
explicit conflict. `calendar:verify` runs in CI and the release lane beside
`catalog:verify`.

**noClassDates are harvested and wired.** `calendar:prepare` has been run
against the live registrar page: six real no-class dates across three terms, and
every term boundary the page states already agreed with the bundle. Since 0.10.1
they reach `academic_calendar_events`, which the planner already honoured, so a
holiday actually blocks scheduling. Re-run the harvest when ASU publishes a new
academic year.

**State.** 133 courses, 381 sections, 45 subject codes, Fall 2026 only. That is
four General Studies categories (HUAD, GCSI, CIVI, AMIT) plus CSE 240 — whatever
happened to be exported. `CSE` contains exactly one course, so a computer science
major is largely uncovered.

**The manual path works today and needs no new tooling.** Save Class Search result
pages as PDF, run `pdftotext -layout` on each, then:

```
npm run catalog:prepare -- --institution=104151 --term=asu-fall-2026-c \
  --source-label="ASU Class Search" \
  --source-url="https://catalog.apps.asu.edu/catalog/classes" \
  page1.txt page2.txt ...
npm run catalog:verify
```

Adding a few subject pages is a ten-minute job. `catalog:verify` runs in CI and in
the release lane, so a malformed regeneration fails the build rather than shipping.

**The Class Search URL is drivable** if this is ever automated:

```
classlist?campusOrOnlineSelection=C&subject=CSE&term=2267&searchType=all
classlist?advanced=true&gen_studies=GS-HUAD&term=2267&searchType=all
```

`term=2267` is Fall 2026. Results paginate at 100.

**If automating, do not use PDF export.** Page breaks splice the running header
into a row, merging it with the start time (`Class Search3:00 PM`) or truncating
the row after the days. That silently corrupted three sections and cost three
parser bugs. Reading the rendered results table gives structured rows and removes
that entire class of problem.

**Unresolved question, still open for the catalog** (the screenshot path sidesteps
it, but automating a harvest would not): does a harvest stay local to one machine,
or ship inside the app to other students? Bundling
data pulled from one student's authenticated session and distributing it is a
different posture from that student fetching their own. A third option is shipping
the *tooling* rather than the data, so each student harvests their own courses —
better product answer, works for any school, always current, but it needs a path
that does not depend on a browser extension students will not have.

**Term staleness.** `asu-fall-2026-c` is baked in. When the term turns over the
catalog needs regenerating from new exports. The section picker states which term
it is showing, so a student is warned, but the data does not update itself.

---

## 2. Auto-updater via GitHub Releases

Would end hand-distributing DMGs. **Does not require Supabase** —
`validate_updater_configuration` in `apps/desktop/src-tauri/src/main.rs` only
requires HTTPS, a host, and no embedded credentials. A static `latest.json`
attached to a release satisfies it. The `/v1/releases/:platform/:arch/latest`
route in `services/cloud-api` is one possible endpoint, not a requirement.

Four steps:

1. `tauri signer generate` — an updater keypair, separate from macOS code signing.
2. Build with the `tauri.release.conf.json` overlay, which sets
   `createUpdaterArtifacts` and produces the `.tar.gz` + `.sig` the updater needs.
   It is excluded from `release.yml` today precisely because it fails the build
   without `TAURI_SIGNING_PRIVATE_KEY`.
3. Embed `STUDENT_CENTER_UPDATER_ENDPOINT` and `STUDENT_CENTER_UPDATER_PUBLIC_KEY`
   at compile time. `option_env!` means without them the app reports no update
   channel and makes no network request — the existing fail-closed behaviour.
4. Publish `latest.json` as a release asset.

Two cautions. The updater private key becomes a genuinely high-stakes secret:
anyone holding it can push an update every installed copy will trust and install.
And the updater replaces the `.app` in place — since builds are only ad-hoc
signed, confirm the replaced bundle still launches rather than tripping Gatekeeper
again. That is the same failure class as the 0.9.0 "damaged" bug.

---

## 3. Collapse commitments already imported from a recurring event

Import now writes one class meeting series for a weekly rule, but anything
imported before 0.9.2 is still dozens of individual commitments. Agreed
behaviour: **leave them alone by default**, and offer an opt-in collapse.

Detect groups of three or more commitments sharing title, weekday and local time,
offer to fold them into one series, and show the change for review before
anything is written. Nothing automatic, nothing retroactive without consent.

---

## 4. Signing

**macOS notarization** needs an Apple Developer membership ($99/yr). Everything
else is already in place: swap `bundle.macOS.signingIdentity` from `-` to a real
Developer ID and add `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` to the release workflow. The
`macos:verify-signature` gate keeps working unchanged. Until then every Mac user
does one **System Settings → Privacy & Security → Open Anyway** per machine.

**Windows** is still unsigned and shows SmartScreen. Same root cause as the macOS
bug, different fix, needs a code-signing certificate.

---

## 5. Smaller items

- **ICS `LOCATION` is not read.** Imported class meetings default to a `lecture`
  component with an empty location.
- **Course and title duplicate in review** for imported classes, because an ICS
  `SUMMARY` fills both fields.
- **Quick add offers enrolled courses, not the catalog.** Deliberate — an
  assignment for a class you are not taking is not a real case — but easy to
  switch if that turns out to be wrong.

---

## Decisions already made

Re-open these on purpose, not by accident.

**ASU publishes no usable course API.** The class search behind
`catalog.apps.asu.edu` answers 401 to anyone anonymous and authenticates through
`weblogin.asu.edu` with an OAuth2 code grant and a client secret embedded in their
SPA. The legacy public search at `webapp4.asu.edu` redirects into it, and
`catalog.asu.edu` carries policy and archive pages, not courses. Reading it
programmatically means defeating an access control, so nothing in this app does.
The catalog is built offline from pages a student exported themselves.

**Seat counts are deliberately excluded.** They are wrong within hours, and a
stale count in a bundled file is worse than no number.

**Canvas keeps producing individual commitments.** It expands recurrences
server-side, so there is no rule to read. Collapsing would mean inferring a weekly
pattern from repeated titles and times, and that guess is not worth shipping. ICS
is the reliable recurring source.

**The weekly collapse is deliberately narrow.** An interval, a positional selector
like `BYDAY=2MO`, or any non-weekly frequency keeps the old expansion. A rule that
cannot honestly be stated as "every week on these days" must not be flattened into
a schedule that was never in the file.

**Imported classes are filed under the term containing the first meeting**,
falling back to the active term, and approval fails with a plain message if no
term exists. A calendar file has no notion of terms and a recurrence count says
nothing about which term a class sits in.

**A no-class day blocks study, not only classes.** `planner.rs` does not inspect
`FixedConstraint.kind`, so a registrar holiday removes that day's capacity
entirely rather than only its classes. That is what a student means by a holiday
and it matches the existing UI copy ("No classes or schedulable work"), but it
means a week-long spring break erases that week's study capacity. Kept
deliberately in 0.10.1 rather than changed quietly; revisit it as a product
question, not a bug.

**Ship nothing that only a test can reach.** 0.10.0 shipped the calendar refresh
built, registered, unit-tested and never called from the UI, and shipped
harvested holidays that were displayed and then dropped. Both had passing tests
and truthful-looking release notes. A feature is not done when its command
works; it is done when a student can get to it and something changes as a
result. Trace the path from a click to a stored record before writing the notes.

**Vision-model grounding is anchored to locally-extracted OCR text.** The rule
that a candidate's `evidence` must be a literal substring of the excerpt is what
stops the model inventing a due date, and an image has no excerpt. Rather than
weaken it for the screenshot path, the image never travels alone: the app OCRs it
on the student's machine and sends that text as the excerpt with the picture
attached. The model's job becomes grouping text we already hold — which is where
it actually helps, since the failure on a grid is almost never character
recognition but knowing that the 9:00 in the gutter and the PSY 101 three columns
over are one class. The alternative considered was an `ImageEvidence { bbox }`
variant validated against local OCR tokens inside that box; it is more code, more
surface, and still needs the same local OCR pass.

**An AI-read screenshot counts as the student fetching their own data.** The image
is a picture of their own screen, they attach it deliberately, and each send is a
separate explicit action with a sentence saying the image leaves the computer.
That is a different posture from harvesting a third party's data through an access
control, which is what the catalog decision above forbids. The distinction worth
holding is consent and ownership, not whether bytes travel.

**Screenshots are deleted once their candidates are settled.** When every class an
image proposed has been approved or dismissed, the encrypted blob is shredded and
the row is kept so the evidence quotes still read. Keeping the image would grow
the vault forever to preserve something nobody opens; deleting the extracted text
with it would break the review queue's evidence. Syllabus PDFs are untouched — a
student reopens those, and settling their candidates says nothing about that. One
preference turns it off.

**Schedule fixtures are real OCR output, and the images sit beside them.** The
first generation was a synthesized token stream, and it passed every test while
the reader could not read a single genuine week grid — the same failure the
calendar fixture had, for the same reason. Regenerate with
`scripts/fixtures/render-schedule-images.py` and `tesseract <png> <name> --psm 6
tsv`. The committed TSVs keep the suite deterministic and independent of a local
Tesseract; the PNGs keep it honest and reproducible.

**A class must print its own time or it is not read.** A block's height is a
drawn rectangle and OCR only ever sees the words inside it, so a calendar with
its hours only in a left gutter cannot say how long a class runs. Deriving the
start from the ruler and fitting the drawing inset works and is still wrong: it
produces confident times quietly fifteen minutes out. Declining, and naming which
kind of unreadable it hit, is the answer — that message is what tells a student
the AI reader is worth trying.

**Registrar calendars are read with patterns, not a CSS selector.** Registrar
pages are frequently not tables and frequently not well-formed, so selecting a
node buys less than an HTML parser in the binary costs. The rules live in the
descriptor instead.

ASU's page turned out to be a *label followed by one date per session*, each on
its own line, which is why `html-sessions` exists as a kind of its own. Three
things about that shape are not obvious and each caused a wrong answer before it
was handled:

- A line sitting where a date should be is that session's **value**, not a new
  label. The page writes "Final exams / Session A / Last Day of Classes"; read as
  a label, "Last Day of Classes" adopts the next session's date and overwrites
  the real end-of-classes date with the day finals start.
- A label is the text **immediately** above its date. Unbounded, the whole
  navigation column becomes the label of the first date on the page.
- Boundary vocabulary is matched only at the **front** of a label. A registrar
  names a row first and explains it afterwards, so a sentence containing "the
  first day of classes" is prose, not an announcement of when term starts.

**Fixtures for network sources are saved copies, never reconstructions.** The
first calendar fixture was written from a description of ASU's page rather than
from the page. Everything passed, and the pattern fitted to it read the real
thing as 152 rows matching nothing at all — while reporting "no differences",
which is exactly what a working refresh also reports. A parser for a page you
have not saved is a parser for a page that does not exist.

**Reading rows and matching none of them is an error, not a quiet success.**
Both states otherwise print the same reassuring output. `calendar:prepare` now
exits non-zero when it reads dated rows and matches none to a term boundary.

**Sync still requires Supabase**, for auth (`createSupabaseAccessTokenVerifier`)
and for the row-level policies that use `auth.uid()`. The `SyncRepository`
interface itself is cleanly swappable; auth and RLS are the coupled parts. Not
needed at all unless a student uses more than one computer.

---

## Gotchas worth remembering

Each of these cost real time and produced output that looked correct.

- **`pdftotext -layout` indents rows**, so the leading run of spaces becomes a
  column delimiter and shifts every field by one. Symptom: zero matches.
- **Closing a wrapped title at the instructor name also aborts the scan for the
  course code**, which sits below it. Symptom: a hundred-class file yields one
  record, looking like a working parser with thin data.
- **Candidate `kind` is switched on in about six places.** Adding a kind and
  missing one fails at approval on an entity type it was never taught. The
  candidate kind is `class_meeting`; the replicated entity is
  `class_meeting_series`, and the mutation log needs that mapping.
- **Re-approving one candidate is not the same as re-importing a file.** The app
  never revisits an approved candidate; a second import creates a new candidate
  sharing the `source_uid`. Testing the wrong one hits a provenance uniqueness
  constraint that cannot happen in practice.
- **Verify published artifacts by downloading them**, not by trusting the build
  that produced them. 0.9.0 shipped a DMG macOS refused to open while every CI
  step reported success.
