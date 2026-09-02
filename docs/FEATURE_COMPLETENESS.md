# Feature completeness matrix

## Current platform priority

Coqui is desktop-first for the current release. The supported product target is the installed Tauri application on macOS Apple Silicon and Windows x64. Existing narrow-width behavior supports resized, tiled, zoomed, and accessibility-magnified desktop windows; it is not an iOS or Android implementation. Mobile companion and widget work is explicitly deferred so current resources can finish desktop certification, packaging, signing, updater, Canvas, OCR, provider, and sync gates.

| Area | Status | Release evidence / remaining gate |
|---|---|---|
| Canvas calendar connection | Repaired; external smoke pending | Partial-event parsing, duplicate `VALUE=DATE` compatibility, date precision, equal-time deadline review, recurrence identity, `LOCATION`, partial-success diagnostics, dedupe, and redaction are covered by native tests. Installed-app certification requires a regenerated private feed URL. |
| Canvas full-token connection | Implemented | Existing read-only courses, assignments, events, dedupe, review, and disconnect flows. |
| Today / deterministic planning | Implemented | Next action, capacity, timeline, replan, reason codes, completion persistence. |
| Calendar / Work / Courses / Study | Implemented | Feature-owned routes, calendar inspector, task inspector, course master/detail tabs, grounded study artifacts, grades, and revision workflows are reachable and covered by component/accessibility tests. Administrative subsystems are nested Settings pages; transient workflows share centralized focus-managed overlays. |
| Scholarship Center | Implemented | Discover, Saved, Applications, Writing, allowlisted ASU ONSA/Global Education adapters, manual URL entry, authenticated-source launch-outs, deterministic explanations, encrypted opportunity-specific requirement-file import and review, requirements/checklists, task planning, autosave, version restore, story library, and guarded AI suggestions persist locally. Both public ASU adapters passed live source certification on 2026-08-31. CareerOneStop remains credential-gated by design. |
| Appearance | Implemented; installed-app certification pending | System/Light/Dark, legacy migration, accent continuity, Comfortable/Power density, reduced motion, responsive navigation, and the frog-face identity are implemented. Browser-mode reflow was verified at 320px, 768px, 1024px, and 1440px in Light and Coqui Dark/Power states on 2026-09-01; installed-app visual snapshots across both operating systems remain a release gate. |
| Schedule imports | Implemented | Documents, ICS, screenshots, OCR, review, provenance, multi-photo import, per-photo rotation/crop/perspective correction, dark-mode/left-gutter decline fixtures, and rotating class schedules are implemented. |
| Course catalog | Implemented with coverage limitation | Provider descriptors and term-staleness warnings are implemented. ASU's bundled catalog remains intentionally limited because its live class search is authenticated; students can always enter or import courses manually. |
| Backup / security / optional sync | Implemented | Encryption and recovery flows exist; live Supabase/RLS certification remains environment-dependent. |
| Packaging / updater | Unsigned v0.12.0 lane implemented; CI run pending | Both platform packages must build and pass installer smoke before the GitHub prerelease is created. Signed updater artifacts remain an explicit future mode; signing and notarization are not required for this prerelease. |
| Mobile companion / widgets | Deferred | No mobile runtime, store package, sync model, widget, or mobile-only workflow is in the current release. Revisit only after desktop installed-app certification. |
| Future integrations | Roadmap | Google/Apple/Outlook calendars, Brightspace, Moodle, Google Classroom, richer Canvas API, collaboration, and managed deployment. |
