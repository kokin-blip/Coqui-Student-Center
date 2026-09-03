# Desktop rebuild QA — checkpoint history

The checkpoint A observations below are historical. See the checkpoint B update
at the end for the current implementation, evidence and approval gate.

## User selection update

The user selected the generated frog/rounded wordmark instead of the original
screenshot logo. `docs/design/ui-rebuild/logo-selected-source.png` supersedes
the screenshots for identity only. `logo-background-removed.png` is the cleanup;
PNG inspection confirms actual alpha transparency. The proof now displays this
asset on light/dark. Earlier findings below are historical baseline findings,
not a rejection of the user's newly selected artwork.

- Source visual truth: `docs/design/ui-rebuild/reference-comfy.png` and
  `docs/design/ui-rebuild/reference-compact.png` (original user attachments).
- Identity/type proof: `docs/design/ui-rebuild/identity-proof.html`.
- Baseline implementation screenshot: `docs/design/ui-rebuild/baseline-today.png`
  (1280×720 browser viewport, light theme, synthetic `?demo` records).
- Proof capture: `docs/design/ui-rebuild/identity-proof-capture.png`.
- No comparison of rebuilt Today screens has occurred: neither is implemented.
- The proof presents original source pixels at 1× and 4× CSS scale; it does not
  imply a recovered vector master or a known original logo font.

## Findings

- [P1] Existing Today composition is not either approved reference composition.
  Keep this finding open until both implementations receive same-viewport/state
  full-view and focused-region comparisons plus user visual approval.
- [P1] Existing logo is a separate drawing. First generative extraction altered
  details; reject it rather than replace the product identity.
- [P1] Generated cleanup has an opaque checkerboard, not transparency. Native
  image inspection confirms RGB without alpha. No production asset consumes it.
- [P1] Existing headings specify unbundled Manrope and display serif fallback.
  Official Inter is now local and successfully loaded in the isolated proof;
  production styling has deliberately not changed before approval.

## Verification so far

- Original references copied without edits; SHA-256 recorded in the checkpoint README.
- Browser proof loads all images and locally bundled Inter; no horizontal overflow
  at its current 1280px viewport. This is not a full reflow/accessibility certification.
- No native commands, real profile data, network images, or remote fonts in the proof.
- Production logo, native schema, application behavior, and published release unchanged.

## Next gate

The original-pixel extraction question is superseded by the user's explicit
selection of the generated artwork. Complete transparent-asset inspection and
integrate the chosen identity, then build both Today experiences for their visual
approval gate. The overall rebuild remains blocked on unimplemented layouts and
their comparison/functional checks, not on the old identity preference.

## Checkpoint B — Today approval preview

The user approved the cleaned logo and Inter proof. The logo and typography are
now integrated; both Today compositions are implemented. Their separate visual
approval gate was satisfied by the user's explicit approval on September 2, 2026.
This is not completion of the full app rebuild.

### Evidence and normalization

All paths below are under `docs/design/ui-rebuild/`:

- Sources: `reference-comfy.png` and `reference-compact.png`, each 1586×992.
- Live comparison: `comparison.html`, actual app at 1586×952 CSS pixels beside
  its source at the same scale. Comfy excludes 40px of native chrome. Compact
  retains its integrated command header; no OS window controls are recreated.
- Full evidence: `comfy-comparison-03.png`, `compact-comparison-03.png`, captured
  on a 1159×806 comparison canvas. Prior 01/02 captures preserve iteration history.
- Focused, 1:1 CSS-clipped source/render comparisons: `comfy-calendar-detail.png`,
  `compact-calendar-detail.png`, `compact-inspector-detail.png`.
- Narrow evidence: `comfy-reflow-320.png`, `compact-reflow-320.png`.

Each comparison contains both source and implementation, not separate views.
Development-only synthetic records reproduce reference dates and freeze time.
Content is not identical in every field: next action is linked to a real fixture
block, capacity is calculated, and unsupported task metadata is omitted. No
weather, real student data, invented avatars or fake activity was added. The
production build removes fixture loading; normal demo mode tests switching
layouts on the same records.

### Iterations and remaining findings

1. [P1, fixed] Wrong logo and missing font: approved transparent raster master
   now replaces the inline frog; locally bundled Inter replaces Manrope fallback.
2. [P2, fixed] Short-event labels clipped: non-shrinking text, condensed short
   blocks, full accessible names and an accessible list alternative added.
3. [P2, fixed] Comfy header and Compact calendar displaced core content: header
   repositioned and weekly density adjusted. Latest comparisons show Comfy's
   314px sidebar and approximately 615/545px columns with 32px gap; Compact uses
   260px navigation, 56px header and 330px inspector.
4. [P2, fixed] Narrow inspector stacked below the workspace: now a contained
   drawer below 1440px, with Escape/opener restoration tested.
5. [P1, planned milestone C] Full inspector content is not implemented: tags,
   descriptions, files, subtasks, local progress and activity require schema 26.
   Only existing real fields/actions appear. Do not claim full inspector parity.
6. [Approval gate, satisfied] The user approved both Today compositions on
   September 2, 2026. Milestone C can now proceed.

### Required fidelity surfaces

- Typography: bundled Inter, explicit fallbacks/weights, larger Comfy event and
  deadline titles, compact 12px table text checked at full size. Wordmark remains
  approved artwork, not a claimed font identification or vector recovery.
- Spacing/layout: same-width comparisons recorded; wide reference proportions
  reproduced. Real data can wrap/extend vertically. Calendar/table scrolling is
  confined to labeled regions with a schedule-list alternative.
- Colors/tokens: fine borders, neutral surfaces, green accents and cream work
  events; legacy accents retained. Status meaning is also expressed in text.
- Image quality: approved 1906×825 transparent raster, clipped without redrawing
  or retyping. Native installer/tray/favicon exports remain outstanding.
- Copy/content: capacity means remaining free availability, not scheduled time.
  Diagnostics/reasons remain reachable through secondary disclosures. Data-based
  differences from the screenshots are explicit rather than simulated features.

### Verification

- Workspace checks and production build pass; lazy chunks remain below Vite's
  default JS warning threshold. 44 UI tests pass, including Compact drawer axe,
  focus return, theme switching, date-only/DST geometry and capacity unioning.
- Shared/cloud suites: 58 pass. Native: 193 passed in sandbox; the two local-server
  tests passed when rerun outside sandbox. One live ASU test remains ignored.
- New preference tests, guarded-command coverage and explicit independent-theme
  preservation in the encrypted-backup round trip pass.
- Script/OCR/packaging suites: 53 sandbox passes; both disk-image checks pass
  outside sandbox (7/7 signature-suite tests). The aggregate sandbox command
  cannot use local IPC/fixture servers or disk images; affected suites were
  rerun with supported alternatives, not silently skipped.
- Catalog/calendar verification and `git diff --check` pass. A focused scan found
  no API-key/private-Canvas-feed patterns in new code and design documents.
- Both modes measured at 320/768/1024/1280/1586/1920: body/document width equals
  viewport width and local Inter is loaded. These are not installed-app checks.
- Pending: all-theme visual matrix, high zoom, complete keyboard/reduced-motion/
  screen-reader certification, native icon/font/restart checks and remaining
  milestone C/D work. v0.12.0 and schema 25 remain unchanged.

Unrelated `.gitignore` edits and untracked `RELEASENOTES.md` are preserved and
excluded from rebuild checkpoints. Deletions are mapped in `feature-parity.md`.

Next: milestone C task details and remaining screens, then certification.

final result: blocked

## Checkpoint C1 — task details, September 2, 2026

Both Today layouts are approved. This checkpoint implements the device-local
task-detail foundation; it does not certify the remaining screen rollout.

- Schema 26 adds task details, ordered subtasks, attachment links, private-document
  markers and paginated activity. Existing task columns and replicated entity types
  are unchanged. Existing tasks start without fabricated activity.
- Today and Work expose the same detail editor: description, tags, To do/In progress,
  checkable/reorderable subtasks, file attachment/preview/export/detach and activity.
  Parent completion remains authoritative. Unsaved detail drafts survive view and
  layout changes in the unlocked session; restore/lock removes that session.
- Native writes check revisions and commit metadata/activity together. Conflicts
  retain the student's draft and offer explicit latest-version review/reload.
- Files use the encrypted vault, bounded format detection and the existing 25 MB
  limit without invoking OCR. Task-private files cannot be uploaded by document
  sync, even after detachment or task deletion. Detachment never shreds shared files.
  Safe image/text previews are inline; PDF/Office/TIFF files use explicit export.
  Export creates a new unencrypted file and refuses existing paths/private app data.
- Compact's long inspector now scrolls independently, keeping the weekly schedule
  in view. Browser preview data is explicitly session-only, never localStorage.

Evidence under `docs/design/ui-rebuild/`: `task-inspector-compact-wide.png`,
`task-inspector-compact-320.png`, `task-inspector-comfy-wide.png`, and
`task-inspector-comfy-320.png`. These are interactive synthetic-data smoke captures,
not a replacement for the approved full-composition comparisons or installed tests.

Verification: 199 native tests passed (one live ASU test remains opt-in); the new
tests exercise schema 25→26/repeated migration, stale/no-op edits, parent completion,
pagination, deletion cleanup, attachment deduplication, OCR independence, private
file upload denial, encrypted DB/vault reopen, canonical snapshot exclusion and
encrypted backup restoration of all local detail records. Shared/cloud suites pass
60 tests. All 48 UI tests and 16 desktop contracts pass; the production build passes.
Coverage includes save/reopen, Today→Work draft handoff, session clearing and axe
checks. Both modes' open inspectors measured 320px document/body widths at
a 320px desktop viewport; Compact was also checked at 1586px with independent scroll.

Remaining: full Calendar selection integration, task-inspector visual refinement
and state matrix, remaining screen/overlay extraction and redesign, installed-app
file-picker/export/restart tests on both platforms, all-width/theme comparisons and
release certification. Native icon exports remain outstanding. No release published.

Current result: in progress; C1 implemented, full rebuild not certified.

## Checkpoint C2 — Work and Calendar

- Work uses a real task table, shared completion, selected record, course,
  priority and deadline columns. Comfy has readable rows; Compact has denser
  rows and a 330px inspector, becoming an explicit drawer below 1440px.
- Calendar now opens event creation on demand, collapses unscheduled work,
  supplies an accessible agenda alternative and opens the same local task
  details from task blocks or unscheduled tasks. Existing move/resize/lock/undo,
  fixed commitments, academic events and import/Canvas actions remain.
- Both use feature-owned inspectors. Root selection and unlocked-session
  drafts retain Work fields, local details and Calendar forms across routes;
  Today and Calendar retain the selected date. Failed saves no longer clear
  task/event forms. Explicit reload preserves separate detail drafts.
- Calendar shares overlap placement with Today, shows hours and the academic
  timezone, and validates nonexistent DST times. Local datetime inputs now
  round-trip the computer's wall clock rather than displaying a UTC prefix.
- Dialog titles are unique; focus traversal excludes closed/hidden controls.
  Existing native contracts, schema 26, review-before-write and sync are unchanged.

Verification: 55 UI tests, 16 desktop static contracts, 60 shared/cloud tests,
workspace checks and production build pass. Compact Work measured no page-level
overflow at 320/768/1024/1280/1586/1920px. Browser captures cover Work and Calendar
wide layouts, narrow rows and drawers. This is synthetic browser evidence, not
installed-app certification or full theme/state-matrix approval.

Remaining: Settings and other screen/overlay extraction and visual rollout,
Scholarship module split, native icon exports, comprehensive visual/state and
installed macOS/Windows certification. No new release has been published.

## Checkpoint C3 — Nested desktop Settings (September 3, 2026)

Settings now occupies the main workspace instead of a fixed layer over it.
The sidebar, command entry and layout switch remain available. Comfy uses
readable grouped rows and a green heading; Compact uses denser rows and the
shared command shell. Both preserve the approved logo and bundled Inter.

Canvas, AI providers, Account, Backup & Recovery, App Lock, Notifications and
Data Recovery now own their forms/actions in separate lazy-loaded feature
components. Existing account/sync and update surfaces remain reused. Academic
& Planning is a nested Settings section with the same term, profile, availability
and cleanup controls. Root orchestration keeps app unlock, account status events,
dashboard refresh, task selection, appearance and post-restore session clearing.

Back restores focus to the remounted Settings action. Escape in a transient
dialog does not also exit the underlying Settings page. Pending reminder saves
retain inputs on failure; recovery errors retain records; backup previews are
invalidated when their file or passphrase changes. Canvas still clears submitted
secrets, retains review-before-write and surfaces partial-success notices. AI
consent and secret clearing are preserved. Unsigned update copy no longer implies
that this build has an active signed-update channel.

Evidence: `settings-comfy-wide.jpg`, `settings-compact-wide.jpg`,
`settings-canvas-comfy-320.jpg` and `settings-notifications-compact-320.jpg`
under `docs/design/ui-rebuild/`. All nine nested pages measured a 320px document
at a 320px viewport in both modes after their headings finished rendering.
These captures use synthetic browser records; no private feeds or keys were used.

Verification: all 65 UI tests (including nine-page navigation/focus/axe checks),
16 desktop contracts, 60 shared/cloud tests, workspace checks and production
build pass. The main production JS chunk decreased from about 400.5kB to 379.1kB;
there is no chunk-size warning. Existing Rust check warnings and an intermittent
Study test `act` warning remain. Native code/schema/sync were not changed in C3.

Still pending: remaining Courses/Study/Scholarships and transient-workflow rollout,
Scholarship module split, full populated/error/theme/high-zoom/reduced-motion
visual matrix, native icon exports, and installed Windows/macOS certification.
Not all authenticated account states or real reminder/backup actions have been
certified in an installed build. No release was published or replaced.

## Checkpoint C4 — Courses and Study (September 3, 2026)

Courses now follows the approved desktop language as a searchable master/detail
workspace. Comfy uses the readable sidebar/detail composition; Compact removes
card gaps into a dense bordered workspace. The existing five sections are now
feature-owned without changing their native commands. Per-course instructor and
meeting drafts remain independent, and failed course/instructor writes retain the
student's entered values.

Study is now an orchestration shell over feature-owned Learn, Materials and Grades
workspaces. Comfy uses a generous working pane with supporting inspector. Compact
uses the same records in a denser bordered composition with a persistent inspector
where width permits. The inspector stacks below 900px. Source selection, exact
provider disclosure, one-request consent, cited artifacts, edits, revision scoring,
grade categories/scales and what-if tools remain present. Linked actions from a
course land on the requested Study course and section.

Evidence under `docs/design/ui-rebuild/`: `courses-comfy-1600.png`,
`courses-compact-1600.png`, `study-comfy-1600.png` and
`study-compact-1600.png`. Live checks found no page-level overflow for either
Courses or Study at 320px in Compact mode. Interface text and headings use the
bundled Inter family; the approved identity is unchanged.

Focused regression coverage adds six tests for course-specific drafts, failed
writes, shared task/Study navigation, linked Study state, provider failure consent
reset/no fallback, and unsaved grade previews. TypeScript and those focused tests
pass. The complete desktop UI suite passes 71 tests, including axe coverage for
every primary area. All 16 desktop static contracts and 60 shared/cloud tests pass;
the production build completes without a chunk-size warning. The macOS signature
suite passes all seven checks when allowed to create its temporary disk images.
The aggregate script's two disk-image cases remain unavailable inside the sandbox,
where the other 53 script/OCR/packaging checks pass.

Still pending: Scholarship feature split/visual rollout, onboarding and transient
workflow polish, full visual/state/accessibility matrix, native icon exports and
installed Windows/macOS certification. No release was published or replaced.

## Checkpoint C5 — Scholarship visual rollout (September 3, 2026)

Scholarships now uses the same approved identity, bundled Inter typography, fine
borders and mode-specific workspace language as the rebuilt desktop areas. Comfy
keeps generous source/reading space beside its supporting pane. Compact uses the
dark command shell, full-width section selector and dense edge-to-edge panels;
it is a distinct composition rather than a padding-only preference.

All four existing sections remain reachable and share the same local workspace:
Discover, Saved, Applications and Writing. Source attribution, reviewable changes,
manual opportunities, explainable matching, encrypted requirement documents,
application checklists, deadline tasks, versioned drafts, story examples and
consented Apply/Dismiss writing feedback are preserved. Initial loading now has
an intentional skeleton and a failed load has an explicit retry.

Evidence under `docs/design/ui-rebuild/`: `scholarships-comfy-1600.png`,
`scholarships-compact-1600.png` and `scholarships-writing-compact-1600.png`.
Comfy Discover and Compact Writing both measured no page-level overflow at 320px.
Focused scholarship workflow and full primary-surface axe tests pass.

The four section bodies now live in feature-owned Discover, Saved, Applications
and Writing modules. The route component owns their one shared local view model,
autosave lifecycle, command dispatch and section selection. Static contract
coverage follows those modules so extraction cannot be mistaken for lost controls.
Onboarding/overlay polish, the comprehensive state/theme matrix, native icons and
installed certification remain pending.

### Native identity export

The previous desktop bundle icons used a different mint frog. The desktop PNG,
Windows tile/ICO and macOS ICNS assets now derive from a direct 520×520 crop of
the approved transparent frog face. The application face-only mark uses the same
source file instead of fragile CSS cropping. File inspection confirms alpha on
the source and PNG exports, a six-image ICO, and a valid ICNS container. Mobile
runtime work remains deferred and its Android/iOS icon folders remain unchanged.

## Checkpoint C6 — Onboarding (September 3, 2026)

The first-run experience now follows the approved Comfy language: a focused green
story panel, high-contrast approved identity, bundled Inter typography and a calm
white setup surface. All existing setup capabilities remain reachable, including
finish/skip, timezone and institution selection, terms, courses and meetings,
availability, protected time, Canvas/document/image import and appearance.

The setup draft now applies its own appearance immediately instead of inheriting
a stale dark theme from another profile or preview session. Light/Dark selection
is reflected live and remains part of the existing persisted draft. Direct grid
children explicitly shrink, eliminating measured page-level overflow at 320px;
the progress rail condenses to four accessible step icons.

Evidence: `docs/design/ui-rebuild/onboarding-comfy-light-1280.png`. Browser checks
at 1280px and 320px used an empty synthetic profile and recorded no page-level
horizontal overflow. A focused regression test covers stale-theme replacement,
live theme changes and axe. This remains browser evidence; installed first-run,
live Canvas and catalog certification are still pending.
