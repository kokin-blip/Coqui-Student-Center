# Desktop UI rebuild preservation checklist

Baseline inventory from the current React components, native contracts, and
`docs/FEATURE_COMPLETENESS.md`. This is a preservation checklist, not a fresh
certification claim. All replacement/verification columns start pending.

| Surface | Existing behavior to retain | Replacement / verification |
| --- | --- | --- |
| Startup / lock | Empty first run, retry/recovery, PIN lock, credential gating | Pending |
| Onboarding | Skip/finish, student/timezone, institution/campus/term, courses, availability, protected time, import entry, appearance | Pending |
| Today | Next action with reasons/alternatives, focus start, task completion, replan, conflicts, review entry, dismissible setup | Pending |
| Calendar | Week/agenda, navigation, task/commitment/class blocks, create/edit, move/lock/undo, overload warnings, date/timezone handling | Pending |
| Work | Inbox/upcoming/overdue/exams/completed, create/edit/delete, course, estimate, due date, priority, academic risk, energy, location, splitting, dependencies, version checks | Pending |
| Courses | Create/edit/delete, course color, term, Overview/Work/Schedule/Materials/Grades, instructors, office hours, recurring/rotating meetings | Pending |
| Study | Material-course permissions, grounded Q&A/guides/flashcards/practice, provider consent, editable artifacts/citations, spaced review | Pending |
| Grades | Categories, weights, scores, grading scales, credits, forecast/what-if | Pending |
| Scholarships / Discover | Public adapters, source status/freshness, manual URL, refresh opt-in, independent failures, reviewable source changes | Pending |
| Scholarships / Saved | Save/update, explainable matching/profile, eligibility unknowns, requirements and source evidence | Pending |
| Scholarships / Applications | Status, checklist, notes, planner tasks, review requirement documents | Pending |
| Scholarships / Writing | Prompt/draft, autosave, outline, word count, versions/restore, story library, policy/consent, Apply/Dismiss suggestions | Pending |
| Import / review | File/photo/ICS, multiple photos, crop/rotate/perspective, confidence/evidence, candidate edits, approve/reject, dedupe, retention | Pending |
| Canvas settings | Calendar/full connection, partial diagnostics, refresh, review/conflicts, disconnect, restore/reconnect | Pending |
| AI settings | Provider/key/model, health/usage, disclosure and consent; no secret echo | Pending |
| Account / sync | Sign-in/out, recovery phrase, device registration/approval/revocation, status, push/pull, date conflicts | Pending |
| Backup / recovery | Encrypted export, authenticated preview, confirmed restore, interrupted recovery, credential clearing | Pending |
| Privacy / security | PIN settings, lock, notification privacy, confirmed profile deletion and backup path | Pending |
| Academic / planning | Profile/institution/term, availability, sleep/breaks/travel, catalog/calendar refresh, staleness, safe cleanup | Pending |
| Appearance | Legacy themes/accents, system changes, density preference migration, reduced motion | Pending |
| Notifications / updates | Reminder preferences, actionable reminders, truthful unsigned updater state | Pending |
| Advanced recovery | Legacy quarantine review and safe recovery | Pending |
| Shared interactions | Search/deep links, quick capture, assistant, toast/error feedback, keyboard focus/Escape, destructive confirmation | Pending |

## Checkpoint B — implementation and deletion audit

The table above remains the full-rollout checklist; untouched rows are not being
claimed as redesigned. Existing UI, Scholarship, settings and import tests pass.

- Today now uses `TodaySchedule`, `TodayTaskInspector` and `todayModel`. Both
  compositions share records and commands. Next action/focus, completion,
  reasons/alternatives, replan, conflict/import review, Canvas entry, persisted
  setup dismissal, OCR status and timing reflection remain reachable.
- Old greeting/card composition and the inline frog drawing were intentionally
  replaced. Obsolete logo CSS was removed; original image sources are retained.
- Work adds real All/High Priority filters and selected-task navigation; its
  existing editor and filters remain, not yet restyled.
- Profile deletion moved to Settings danger controls; confirmation is unchanged.
- The narrow inspector reuses modal focus trapping/restoration. A duplicate
  setup-workspace fetch effect was removed; the shared refresh now covers it.
- Local interface preferences are additive settings, schema 25 unchanged.
  Independent themes and encrypted-backup preference restoration are tested.
- Both modes have no measured page overflow at 320/768/1024/1280/1586/1920.
  These are browser checks, not installed-app certification.

## New behavior and remaining work

- Implemented for Today: distinct Comfy/Compact composition, awaiting approval.
- Implemented: per-mode native themes and legacy density migration.
- Milestone C: local descriptions, tags, subtasks, progress, attachments, activity.
- Milestone C: new detail records backed up and excluded from sync.
- Implemented in Today/Work: shared selection and Compact filtered destinations.
- Milestone C: Calendar selection, remaining screens and native icon exports.

For each migrated row, record component/command coverage, visual screenshots,
automated checks, native persistence evidence, and any approved deviation.
