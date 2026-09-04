# Desktop control-consistency audit

Date: September 3, 2026

Viewport: 1280 × 800 desktop preview

Modes: Comfy/light and Compact/dark

## Outcome

Passed. Text fields, text areas, selects, checkboxes, radios, and icon-and-label
actions now share one consistent baseline across both interface modes. The focused
Scholarship defect is fixed, and the same audit found and corrected the remaining
shared-button, import-photo, Settings-toggle, Calendar-inspector, Work-inspector,
and Compact work-queue inconsistencies.

## Flow and health

1. **Primary destinations — healthy.** Today, Calendar, Work, Courses, Study,
   Scholarships, and Settings were inspected in Comfy and Compact. No visible
   field fell back to a browser inset style, and no icon-and-label action retained
   block alignment.
2. **Scholarship discovery and manual entry — healthy.** Discover, Saved,
   Applications, and Writing were inspected in both modes. The manual opportunity
   fields now have tokenized surfaces, borders, radii, padding, typography, and
   state treatment. The Plus icon and `Save opportunity` label share a centered
   baseline.
3. **Task and calendar editing — healthy.** Work task creation/details and the
   Calendar event inspector were checked. Toggle checkboxes are 16 × 16, centered
   within their label track, and no longer stretch to an auto-width grid column.
4. **Courses and Study — healthy.** Every Course section (Overview, Work,
   Schedule, Materials, Grades) and every Study section (Learn, Materials, Grades)
   passed the control scan.
5. **Nested Settings — healthy.** Canvas, AI providers, Account & sync, Backup &
   recovery, Privacy & security, Advanced data recovery, Academic & planning,
   Updates, and Notifications passed in both modes.
6. **Transient workflows — healthy.** Quick Add, global Search, and Import were
   exercised. Import's `Choose photos` icon and label now align as one control.
   The document-library search input intentionally has no inner border because its
   enclosing search-field label supplies the complete 1px border and focus surface.
7. **Compact work queue — healthy.** Its legacy 14px boxes were normalized to the
   same 16px checkbox geometry used elsewhere.
8. **Import source cards — healthy.** The two primary source cards now keep each
   20px icon and title in one centered row, with 16px edge padding and supporting
   copy aligned beneath the title. `Choose photos` remains on one line with its
   16px icon centered inside the same control. The shared onboarding source cards
   use the same structure.

## Before and after evidence

- Scholarship form before: `12-comfy-scholarships-before.png`
- Comfy Scholarship form after: `20-comfy-scholarship-save-after.png`
- Compact Scholarship form before: `01-compact-scholarships-before.png`
- Compact Scholarship form after: `24-compact-scholarship-save-after.png`
- Comfy Work before: `10-comfy-work-before.png`
- Comfy Work after: `15-comfy-work-after.png`
- Compact Today before: `02-compact-today-before.png`
- Compact Today after: `22-compact-work-queue-after.png`
- Quick Add before/after: `13-comfy-quick-add-before.png`,
  `16-comfy-quick-add-after.png`
- Import before/after: `14-comfy-import-before.png`,
  `17-comfy-import-after.png`
- Import card alignment before/after: `25-import-card-alignment-before.png`,
  `26-import-card-alignment-after.png`
- Compact import card confirmation: `27-compact-import-card-alignment-after.png`

## Implementation notes

- A zero-specificity author baseline protects future unwrapped fields from native
  browser inset styling while allowing feature-owned rules to win.
- Shared primary, ghost, solid, and outline actions now use centered inline-flex
  geometry, an 8px token gap, and normalized 16px icons.
- Feature-specific Scholarship fields retain 40px Comfy and 36px Compact heights.
- Native checkboxes and radios are normalized to 16px without replacing platform
  semantics or keyboard behavior.
- Existing copy, saved behavior, theme tokens, and feature contracts are unchanged.
- Icon-and-copy source cards use a dedicated title row rather than relying on
  stretched implicit grid tracks, preventing zoom-dependent edge crowding.

## Verification

- Automated DOM control scan: no unresolved issues on the inspected screens.
- Desktop UI tests: 78 passed across 17 files.
- TypeScript check: passed.
- Production build: passed.
- `git diff --check`: passed.
- Automated accessibility coverage in the UI suite: passed.
- The design detector reported three pre-existing side-accent warnings in Today.
  They are outside this control-polish change and match the approved reference's
  semantic event/next-step accents; no detector finding concerned a field,
  checkbox, radio, or icon-and-label control.

## Evidence limits

The screenshots support visual alignment, spacing, state, and theme findings but
cannot by themselves prove screen-reader behavior. That behavior is covered here
by the existing accessible names, native input semantics, keyboard interaction
tests, and automated axe checks. Installed Windows/macOS rendering was not rerun
for this CSS-only polish pass.
