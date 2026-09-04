# Desktop rebuild completion audit

Audited September 3, 2026 against the approved Comfy/Compact rebuild plan.
This is a read-only status audit of the live demo, source structure, tests,
certification notes, and hosted installer results.

## Verdict

The feature rebuild is substantially implemented and the representative screens
are polished, but the full plan is not yet complete. The remaining work is mostly
certification, documentation reconciliation, and architectural cleanup rather
than a missing primary product area.

## Health score

| Dimension | Score | Finding |
| --- | ---: | --- |
| Accessibility | 3/4 | Strong semantics/focus tests, but contrast is disabled in axe and real screen-reader/high-zoom checks are not recorded. |
| Performance | 3/4 | Routes are lazy-loaded and the build has no chunk warning; the root and global CSS cascade remain oversized. |
| Responsive design | 3/4 | Current 320px Settings capture has no page overflow; actual high-zoom certification is absent. |
| Theming | 3/4 | Semantic tokens and six themes ship; the complete two-mode/all-theme visual matrix is not recorded. |
| Anti-patterns | 3/4 | The product generally feels intentional; one opacity-from-zero reveal and some nested card/eyebrow styling remain. |
| **Total** | **15/20** | **Good, but not decision-complete against the written acceptance criteria.** |

Issues: P0 0, P1 2, P2 3, P3 1.

## Captured flow

1. `01-comfy-today.png` — Healthy. The spacious timeline, next action,
   deadlines, capacity, approved identity, and primary navigation are present.
   The floating Quick add control overlaps the lower capacity region at this
   viewport, a minor polish issue.
2. `02-compact-today.png` — Healthy. This is a distinct weekly calendar,
   work-queue, risk, and deadline composition rather than a spacing preset.
3. `03-compact-task-inspector.png` — Healthy. Selection updates the persistent
   inspector and exposes status, description, tags, subtasks, attachments,
   activity, and planning actions. Browser-demo copy correctly distinguishes
   session-only preview data from encrypted desktop persistence.
4. `04-compact-scholarships.png` — Mostly healthy. Discover, Saved,
   Applications, and Writing are top-level sections and the public-source safety
   model is clear. The first capture caught the content almost unreadable during
   entry; source CSS confirms a reveal beginning at `opacity: 0`.
5. `05-compact-settings.png` — Healthy. Administrative systems are routed
   Settings destinations rather than full application subsystems in modals.
6. `06-narrow-settings-320.png` — Healthy. The layout becomes bottom navigation,
   retains readable actions, and measured document/body width equals 320px.

## Findings

### P1 — Required accessibility and visual certification is incomplete

The axe tests explicitly disable color contrast because they run in jsdom.
Current live Settings text produced no simple computed-color failures, but that
does not replace contrast checks across all states. The design record also admits
that actual high zoom was not exercised, and there is no recorded real
screen-reader pass or complete Comfy/Compact theme-state visual matrix.

The installed-package smoke proves launch, restart, persistence, OCR, checksums,
and signing structure. It does not visually prove offline Inter/logo rendering in
the packaged Windows and macOS applications.

### P1 — Live Canvas installed-app certification is still outstanding

The synthetic parser and partial-success coverage passes, but the plan required a
newly generated private Canvas feed to be exercised in an installed application,
including unchanged refresh, changed-event review, disconnect vault deletion,
and restore/reconnect. The existing private URL was intentionally not retained.

### P2 — The architecture extraction is not fully finished

`StudentCenter.tsx` is still 1,596 lines, `CalendarView.tsx` is 955 lines, and the
UI loads 6,598 lines of CSS across the base, override, token, and feature sheets.
The root no longer contains complete overlay bodies, but the requested clean
orchestration boundary and progressive removal of accumulated override styling
are not fully achieved.

### P2 — The feature-parity record is stale and contradictory

`docs/design/ui-rebuild/feature-parity.md` still marks most primary surfaces
Pending and says installed certification is pending. Earlier sections of the root
`design-qa.md` also retain outdated milestone warnings, including a historical
`final result: blocked`, without a resolved-status index. The implementation may
be present, but the required completion matrix is not trustworthy as written.

### P2 — A route reveal can start fully invisible

`.coqui-animated-content` uses an animation whose initial keyframe is
`opacity: 0`. The audit captured Scholarships in a nearly unreadable intermediate
state. Content should remain visible by default and use a non-gating transition,
especially for background tabs and constrained renderers.

### P3 — Minor visual cleanup remains

The Comfy floating Quick add button overlaps the lower-right capacity card at the
reference viewport. Scholarships also uses a small uppercase eyebrow and a large
panel containing repeated inner cards; these are consistent enough to use, but
they are less refined than the strongest Today and Settings surfaces.

## Confirmed strengths

- Comfy and Compact are genuinely different compositions sharing the same data.
- The approved logo artwork and locally bundled Inter are present.
- Schema 26, local task details, encrypted backup round trips, and sync exclusion
  have native tests.
- All six student destinations and nine Settings sections are reachable.
- The hosted Windows x64 and macOS Apple Silicon build passed native, OCR,
  first-run IPC, package, checksum, restart, persistence, and uninstall/seal gates.
- Mobile runtime work and release publication remain correctly out of scope.

## Completion recommendation

Before calling the rebuild fully complete:

1. Run the real accessibility/visual matrix, including contrast, high zoom,
   screen reader, packaged offline identity, all themes, and key error states.
2. Perform the private live Canvas installed-app scenario with a regenerated URL.
3. Reconcile the feature-parity and design-QA records into one current matrix.
4. Remove the opacity-gated reveal and finish the root/global-style extraction.
5. Re-run the complete hosted certification after those changes.
