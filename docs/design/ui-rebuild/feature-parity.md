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

- Implemented for Today: distinct Comfy/Compact composition, approved by the user
  on September 2, 2026. Task details and remaining screens are milestone C.

## C1 preservation audit

- Added the shared local task-detail editor to Today and existing Work editing.
  Existing task/planning controls remain; Today's inferred status display is
  replaced by explicit local progress with parent completion taking precedence.
- No screen bodies, existing native commands or replicated task fields removed.
- New details, subtask order, attachment links and activity are encrypted by the
  existing profile store and included in backup round trips. File detachment and
  task deletion keep vault content instead of destroying another feature's source.
- Unsaved detail drafts survive Today→Work and mode changes. Existing core Work
  form-draft preservation and shared Calendar selection still need the C rollout.
- The full UI rollout and installed-app certification remain pending; C1 is not
  a claim that every planned screen or integration has been completed.
- Implemented: per-mode native themes and legacy density migration.
- Milestone C: local descriptions, tags, subtasks, progress, attachments, activity.
- Milestone C: new detail records backed up and excluded from sync.
- Implemented in Today/Work: shared selection and Compact filtered destinations.
- Milestone C: Calendar selection, remaining screens and native icon exports.

For each migrated row, record component/command coverage, visual screenshots,
automated checks, native persistence evidence, and any approved deviation.

## C2 preservation audit

Work and Calendar now share root task selection and the local details editor.
Task core fields, event forms, filters and Today/Calendar dates survive route
changes in the unlocked session. Work has a semantic task table with completion
controls and narrow-window row reflow. Calendar creation is on demand, with a
collapsible unscheduled tray and accessible agenda. All previous editor fields
remain in `TaskInspector` / `CalendarInspector`; the removed inline screen code
was extracted, not dropped. Failed writes retain drafts; refresh failures after
a successful write are labeled separately to discourage duplicate creation.

New regression tests cover failed saves, new-task drafts, cross-route selection,
mode switching, Calendar form focus restoration, week navigation and DST/local
time conversion. All 55 UI and 16 static desktop contract checks pass. Full
remaining-screen rollout, native icons and installed certification remain pending.

## C3 preservation audit

The large `StudentCenter` reduction is extraction, not feature removal:

| Previous inline subsystem | Feature-owned destination | Preserved controls |
| --- | --- | --- |
| Canvas connection body/state | `CanvasSettings` | Calendar/full connection, auto-refresh, manual refresh, disconnect, history, pending review |
| AI provider body/state/actions | `AiSettings` | Connect/validate, age/billing consent, configure, test, disconnect, ordering, local usage |
| Account sign-in controller | `AccountSettings` + existing `AccountModal` | Email/code retry, Google/cancel, refresh/sign-out; existing encrypted sync/device recovery UI |
| Backup body/state/actions | `BackupSettings` | Export/verify, file selection, passphrase, preview/fingerprint, explicit replacement, credential-clear disclosure |
| PIN body/state/actions | `SecuritySettings` | Enable/change/disable, confirmation, lock now, failure retention |
| Reminder body/state/actions | `NotificationsSettings` | Delivery, lead/quiet hours/title privacy, start/snooze/complete/dismiss |
| Legacy recovery body/state/actions | `DataRecoverySettings` | Load/retry, restore, exact purge confirmation, empty/failure states |

Updates and Academic & Planning retain their existing components and commands,
now inside the main Settings page boundary. Appearance remains on Settings home;
profile deletion stays in the clearly labeled danger section. Root still owns
startup, app locking, dashboard/account events, route selection and post-restore
clearing of local task drafts and cached provider/account status.

65 UI tests pass, including all nine nested routes with axe/focus checks and
new native-command mocks for reminder errors, recovery errors, Canvas diagnostics,
AI consent/secret clearing, PIN validation, backup preview invalidation and restore
acknowledgment. These mocks do not substitute for installed native certification.
Both modes' nine default Settings states reflow at 320px with no page overflow.
Remaining feature rollout and certification are listed in root `design-qa.md`.
