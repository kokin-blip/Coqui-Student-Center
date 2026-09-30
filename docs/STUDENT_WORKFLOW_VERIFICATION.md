# Student workflow verification

## Confirmed defects and fixes

- Both Grades components called `.toFixed()` after checking only `undefined`. Native Rust `Option` values serialize as `null`; browser empty-summary fixtures did not exercise the contract. Both views and their contracts now distinguish null from recorded zero. Native serialization and UI regressions cover this shape, no-course/no-score states, rejected saves, and what-if isolation.
- Plan-block navigation searched the current destination before Today mounted. It now opens Today, restores the current plan day in the preserved editing session, waits for the target, and reports unavailable blocks. The schedule list also supplies target IDs. A shell regression starts in Work, follows a link, browses another day, opens quick notes, follows another link, and checks the list target.
- Study review sessions inherited the default assignment kind. They now use generic task classification, and legacy review tasks are normalized before streak backfill.
- Materials topic entry split and rejoined controlled input on every keystroke, removing a newly typed comma. A regression reproduced the failure; the editor now preserves raw text until Save.
- Added source controls overflowed narrow Materials rows; controls now wrap. The new check-in card also overrides an inherited action-column placement. Notes dates use the saved student timezone.
- Optional AI provider-status failure previously rejected the whole Study load. Local notes and grades remain available with a visible status message.

## Coverage and audit

The existing suite audits Today, Calendar, Work, Courses, Study, Semester, Funding, Settings, all nine Settings details, centralized dialogs, shared task inspectors, and navigation/focus restoration. Native-shaped regression fixtures now exercise every course tab and Study tab with nullable grade summaries. Added tests cover loading/retry and rejected local requests for Courses, Study, Work, and Calendar, scoped render recovery, notes CRUD/search/pinning/deletion, manual templates and retained drafts, fresh consent after request changes, edited preview Save, and actual cross-destination deep links. Existing weighted-grade, missing-work, grading-scale, and what-if tests remain active.

Native tests cover encrypted note persistence/revisions, Materials import without schedule candidates, source scope and unavailable text, provider/model/source changes before network execution, single-use consent, preview/save provenance, profile reset, and full-profile backup rekey/restore. Check-in tests cover opt-in/onboarding, default versus personalized rhythm, quiet hours, DST gaps/folds, overnight/manual timing, pre-replan membership, snooze/dismiss/restart, missed expiry, current task versions, and confirmed responses without automatic deadline changes. Streak tests cover eligibility, equality, late/missing/pending/unknown outcomes, ties, deadline freeze, reopening/reclassification/deletion history, milestone deduplication, restarts, and backup persistence.

Browser visual checks use synthetic data in Comfy and Compact at 390px and 1440px, including local capture, a pasted meeting transcript, saved pinned/source-linked notes, and source controls. Shared modal focus management remains in place; authored note editors focus the title and restore their opener.

## Verification commands

Final verification passed: `npm run check`, `npm test`, `npm run build`, and `git diff --check`. The full test run passed 150 UI tests, 257 native tests, 55 script tests, 20 contract tests, and 46 cloud API tests. One native live ASU public-source certification test remains intentionally ignored by the repository. The full test command ran outside the filesystem sandbox for disposable disk-image fixtures, IPC, and local HTTP fixture servers; it required no live AI credentials.

Packaged-app notification permission/delivery, platform OCR readiness, Windows installed-app smoke, and live provider requests require the corresponding runtime environment and were not certified by these automated checks. AI adapters are tested against local fixtures; no student source material was sent to a live provider during implementation.
