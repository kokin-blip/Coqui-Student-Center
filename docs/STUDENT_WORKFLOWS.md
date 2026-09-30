# Student workflow help

## Grades and recovery

Open grades from **Courses → Grades** or **Study → Grades**. Courses without recorded scores show “No grades yet”; a recorded zero is a real score. Category weights, missing-work impact, grading scales, and GPA projections use the existing native grade model. What-if changes are previews until explicitly saved. Grade and category editors keep your draft if a save fails.

A failed view offers retry and a return to Today while navigation stays usable. Plan-block links open Today and wait for its timeline to mount. A deleted or unavailable block produces a message instead of a blank destination.

## Daily check-in

Enable check-in after onboarding from Today or **Settings → Notifications**. It starts at 8 PM in your saved student timezone. With “Follow saved rhythm” enabled and a saved rhythm, Coqui uses 30 minutes after the last planned task, class, or work/commitment block, capped at 30 minutes before sleep. An overnight rhythm belongs to the day you woke up. You can choose a fixed time or turn check-in off.

The daily list contains distinct tasks due on that local calendar date or planned during its waking interval. Membership is captured before replanning and refreshed until the check-in is offered; after that, the offered list stays fixed. Completion always comes from current task records, never from a vanished calendar block or elapsed deadline.

For each task, choose **Complete**, **Still in progress**, **Not completed**, or **Review / reschedule**. Rescheduling opens the shared Work editor; review and save the new deadline there, then confirm the rescheduled response. Completion uses your confirmation time. “Completed earlier” lets you explicitly enter and confirm an actual timestamp with its timezone offset; Coqui records both that assertion and when it was entered.

Check-ins appear as nonmodal Today cards. Notifications has a “Review daily tasks in Today” entry. System notifications additionally require the existing reminder opt-in and OS permission; they use generic text and do not interrupt a focused app. Quiet hours, lock state, onboarding, and active dialogs are respected. Snooze for 30 minutes, dismiss the day, or disable the feature. A missed check-in is available on the next eligible unlocked visit for up to 48 hours; older days expire and never form a backlog. Dismissal and responses persist across restarts. An explicitly snoozed day can return inside that window.

## On-time assignment streak

Today offers a dismissible streak and an assignment-by-assignment explanation. Settings → Notifications can restore or hide it. Eligible work is a deadline-bearing assignment, homework, project, paper, lab, quiz, test, exam, midterm, or final. Reading, generic tasks, undated work, and study review sessions do not count.

Outcomes are ordered by scoring deadline, with task ID breaking ties. Completion at or before the deadline counts. Late completion or an unfinished elapsed deadline resets the current consecutive count. Future unfinished work stays pending. Times are compared as actual instants and displayed in your saved timezone.

Deadline edits before completion or the deadline can change scoring. The scoring deadline freezes at the first completion or elapsed deadline. Later rescheduling changes your plan while preserving that scoring deadline; the explanation shows both. Reopening removes the active completion outcome and keeps its history. Deleting or reclassifying already scored work preserves its outcome. Legacy records use available timestamps and explicitly label unavailable deadline history; completion without a trustworthy timestamp is excluded. Milestone celebrations use existing preferences/cooldowns and a persisted high-water mark, so restarting does not replay them.

## Quick notes

Use **Capture a thought** on Today, **Quick notes** in the workspace bar, or course/task context. Capture up to 4,000 characters of plain text, optionally link a course or task, and pin, search, edit, or delete after confirmation. Ctrl/⌘ Enter saves from the editor. Unassigned notes are supported. The separate AI assistant action remains available.

Quick notes live only in the encrypted profile database and full-profile backups. They are separate from imported course sources and longer organized notes. Contents do not enter notification previews, logs, or canonical sync.

## Materials notes workspace

**Study → Materials** extends the existing source list and study artifacts. Write longer course notes locally, choose a notes/summary/outline/slide-draft template, link existing sources, add tags, pin, and search titles/content/tags. Group by date updated, course, or first topic/tag. Saved artifacts retain their source references and revision workflow. Sources that were removed show an unavailable state.

Choose a course and import PDF, DOCX, PPTX, TXT, PNG, JPEG, or TIFF directly into Materials, or paste text/meeting transcripts. This path stores an encrypted source without creating schedule candidates. Text extraction is local; images and scanned PDFs depend on the available OCR runtime, and extraction failures remain visible for review. There is no audio transcription or slide export in this release. Slide drafts are editable slide-by-slide text with speaker notes.

To use AI, select source material in Learn or use **Draft from source**. Prepare the request locally first. Review the disclosed provider, model, prompt, source text sections, IDs/locators, and included metadata; check the fresh, initially unchecked consent box for that request. Native execution binds that approval to the provider, model, and source revision and rejects changed requests before sending. Providers never switch automatically. A returned result is an editable preview: only **Save reviewed draft** adds it to Materials. Discarding a preview does not create a note. Manual editing and templates work without AI.

## Storage and recovery

Schema 31 adds device-local tables for notes, check-in delivery/responses, assignment scoring/history, and prepared/preview study requests. All use the existing SQLCipher database, encrypted document vault, lock guards, profile reset, and encrypted full-profile backup/rekey flow. Expected revisions reject concurrent edits. Prepared requests are single-use; unsaved preparations/previews expire after one day. Final saved notes are retained until explicitly deleted.
