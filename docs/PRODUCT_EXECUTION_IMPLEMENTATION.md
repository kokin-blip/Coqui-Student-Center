# Product execution implementation

This work started from audited tag `v0.10.1`, commit `cc98558db1f962d1910716e3873a14d1cd7525d5`, on `origin/codex/foundational-mvp`. The implementation branch is `codex/comprehensive-product-plan`.

## Delivered foundation

- Schema 17 uses additive, idempotent migrations. Existing encrypted profiles, schedules, documents, plans, sync history, and AI invocation history remain readable.
- Typed native boundaries own AI providers, Canvas calendar feeds, source preview, candidate editing, validation, provenance, and canonical writes.
- Backup restore deliberately drops every Canvas and AI credential, removes any pre-restore credential entries, preserves approved records, and marks restored connections for reauthentication.
- `AppNavigation`, `ScheduleImportReview`, `StudyView`, and `WorkspaceView` are independent UI modules. `CalendarView`, `WorkView`, `CoursesView`, and `AcademicSettingsView` are explicit route-level entry points over their shared local-record workspace, while the app shell owns cross-route state and global dialogs.
- The WebDriver-only desktop build has a separate application identifier and test-only UI bridge. Its profile root must resolve to a dedicated child of the operating-system temporary directory, preventing local smoke teardown from touching a real Coqui profile.

## Delivered imports

- “Bring in my schedule” is available during onboarding, from the application shell, and from Calendar. It supports Canvas calendar links, native capture followed by explicit paste, PNG/JPEG/PDF selection and drag/drop, other academic documents/calendars, or manual entry.
- Canvas feed links are HTTPS/443 only, reject credentials/fragments/private or reserved destinations, disable proxies, pin public DNS results, revalidate every redirect, limit redirects, duration and body size, and never expose the secret URL to React, SQLite, logs, backups, sync, or safe errors.
- Canvas refresh is nonblocking after unlock, defaults on, has a visible per-connection on/off control, is limited to one attempt per 24 hours unless manually refreshed, and treats an unchanged hash as a no-op. Stable Canvas/ICS source identifiers update linked records instead of duplicating them.
- Screenshot and document review shows the encrypted source beside editable course, section, weekday, time, location, modality, term/date and evidence fields. Invalid or conflicted candidates cannot be bulk-applied; cancelling creates no canonical records.
- Local OCR is first. A screenshot can be sent to the resolved BYOK provider only after a provider/model/data-scope confirmation; the image travels with locally extracted text and returned evidence is checked against that text.
- Every completed local schedule-source import requires a per-source encrypted-keep or delete-now decision. Deletion shreds the original while retaining minimal evidence and field provenance.

## Delivered private AI

- Student-owned OpenAI, Anthropic, and Gemini keys are zeroized after native submission and stored only in the operating-system credential vault.
- Capability routing declares text, vision, structured-output, streaming, and minimum-context requirements, filters connected healthy providers, then follows the student's configured order. Usage never affects routing.
- The resolved provider/model and exact source scope are displayed before sensitive study or screenshot data leaves the device. Failure marks that provider unhealthy and requires a fresh, explicit consent before any retry; data is never silently sent to another company.
- Structured output is validated first against the provider schema and again against Coqui domain/evidence rules. The removed cloud `/v1/ai/structure` route and cloud OpenAI dependency are not part of the product.
- Invocation history stores capability, provider/model, status/error category, token counts and latency—never prompts, document content, keys, or secret URLs.
- Recommended models are version-stable where each provider exposes that contract. OpenAI defaults to the dated `gpt-5.4-mini-2026-03-17` snapshot; Anthropic's canonical `claude-sonnet-5` identifier is itself pinned; Gemini uses its production `gemini-3.7-flash` identifier and remains editable under Advanced.

## Delivered experience and study workspace

- Student navigation is Today, Calendar, Work, Courses, and Study. Settings contains Integrations, Account & Sync, Privacy & Security, Backup & Recovery, Appearance, Updates, and Advanced actions.
- Today includes a visual timeline, protected commitments, planned work, overload/capacity status, next-action reasoning, focus actions, due-versus-do dates, and plan disruption explanations.
- Calendar is a real day/week time grid with visually distinct block kinds, unscheduled work, pointer move/resize, lock/undo controls, keyboard move/resize alternatives, an accessible agenda fallback, conflicts, overload, and import/connection access. Locked blocks cannot be moved.
- Work is divided into Inbox, Upcoming, Overdue, Exams, and Completed with advanced scheduling fields progressively disclosed. Courses use Overview, Work, Schedule, Materials, and Grades tabs; the latter two show the selected course's actual encrypted sources and local forecast summary while Study owns detailed editing.
- Study limits every request to explicitly selected courses/materials, verifies literal source citations/locators, labels unsupported answers, and creates editable grounded answers, guides, flashcards, practice questions, and practice tests.
- Confidence reviews create deterministic spaced-revision work. The local gradebook supports weighted categories, missing-work impact, non-mutating what-if scores, student-defined grading bands and GPA points, course credits, and projected GPA.

## Release gates

Automated gates are the root TypeScript check, contracts tests, desktop UI component and axe-core accessibility tests, cloud service tests, Rust native tests, OCR fixtures, a production dependency audit, a production UI build, and isolated native first-run/import smoke. CI repeats the native tests and packaging checks on Windows x64 and Apple Silicon macOS. Paid provider requests are prohibited in CI.

Before publishing each installer, run the hands-on scenarios from the approved plan on both platforms: fresh offline install, Canvas connect/refresh/change/deduplication, screenshot capture and retention, each provider connect/use/disconnect, no cross-provider fallback, and backup/restore reauthentication. A platform is not considered release-approved from another platform's result.

## Explicit later scope

Google/Apple/Outlook calendars, richer Canvas API sync, more LMS providers, mobile/widgets, notification actions, collaboration, and institution-managed deployment remain Phase 5 ecosystem work. Multiple-photo correction, crop/rotation assistance, unusual timetable training, and rotating A/B schedule presets are incremental importer improvements and do not weaken the current review-first importer.
