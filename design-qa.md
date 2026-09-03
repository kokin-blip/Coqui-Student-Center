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
approval gate remains open. This is not completion of the full app rebuild.

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
6. [Approval gate] Both Today compositions still require user visual approval
   before any remaining screen rollout.

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

Next: user approval of both Today layouts, then milestone C and certification.

final result: blocked
