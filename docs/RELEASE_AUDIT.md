# Comprehensive product-plan release audit

Audit date: 2026-09-01

Implementation branch: `codex/comprehensive-product-plan`

Audited baseline: `v0.10.1` / `cc98558db1f962d1910716e3873a14d1cd7525d5`

This document separates implemented behavior from release approval. A workflow can be complete in source and automated tests while an installer still requires credentialed, hands-on verification on each supported desktop operating system.

## Desktop-first scope decision

The current product and release target is the installed Tauri desktop application on macOS Apple Silicon and Windows x64. Engineering, design, testing, and release resources should be spent on making that application complete and dependable before beginning a separate mobile companion.

The narrow-width work already delivered is retained because desktop windows can be resized, zoomed, tiled, or used with accessibility magnification. The 320px bottom navigation and generated small icons do **not** represent an iOS or Android product commitment. No mobile runtime, store package, mobile synchronization model, widget, or mobile-specific workflow is part of the current release.

Mobile companion and widget work is deferred until the desktop application has passed its installed-app matrix. Near-term resources instead go to:

- a live Canvas smoke test with a regenerated feed credential;
- macOS and Windows installed-app UX and accessibility certification;
- production OCR runtime assembly and verification;
- signing, notarization, updater publication, and artifact verification;
- live Supabase/RLS and low-value AI-provider certification;
- remaining desktop-shell and overlay maintainability work where it reduces release risk.

## Scope disposition

| Plan area | Status | Evidence / remaining gate |
| --- | --- | --- |
| Additive repository foundation | Implemented | Schema 25 migrations preserve existing encrypted records and add Scholarship Center records, drafts, versions, source runs/diffs, stories, and requirement documents. |
| Desktop architecture | Implemented | Feature-owned Today, Calendar, Work, Courses, Study, Scholarships, and Settings routes replaced the old mode-switched workspace. Administrative subsystems use nested Settings detail pages; only transient capture, review, search, planning, assistant, and confirmation workflows remain overlays. |
| Canvas calendar link | Repaired; live smoke pending | Partial-event parsing, duplicate `VALUE=DATE`, explicit date precision, equal-time deadline review, recurrence identity, `LOCATION`, deduplication, partial-success diagnostics, secret redaction, and credential deletion on disconnect are covered by native tests. A regenerated private feed is required for installed-app certification. |
| Canvas full-token connection | Implemented | Existing read-only courses, assignments, events, dedupe, review, and disconnect flows remain available. |
| Schedule and document imports | Implemented | Onboarding and Calendar entry points, explicit capture/paste/upload/drop, local OCR first, editable review, source-retention decisions, multi-photo import, crop/rotation/perspective correction, unusual-layout fixtures, and rotating schedules are implemented. |
| OpenAI/Anthropic/Gemini BYOK | Implemented; live certification pending | Native adapters, credential-vault storage, capability routing, explicit fallback consent, structured/domain validation, local usage summaries, and provider/model/scope disclosure are implemented. Paid calls remain outside CI. |
| Core student workspace | Implemented | Today, Calendar, Work, Courses, and Study include deterministic planning, inspectors, grounded study artifacts, confidence revision, grades, forecasts, and keyboard-accessible scheduling. |
| Scholarship Center | Implemented | Discover, Saved, Applications, and Writing are reachable. Public ASU adapters, manual/authenticated-source paths, explainable matching, encrypted requirement-file review, task planning, drafts, versions, stories, and guarded AI feedback persist locally. Public ASU adapters passed live certification on 2026-08-31. |
| Desktop UI rebuild | Implemented; installed certification pending | Frog-face identity, System/Light/Dark themes, Comfortable/Power density, semantic tokens, responsive desktop navigation, intentional states, and selective Ionic/React Bits adapters are present. Browser reflow was checked at 320, 768, 1024, and 1440 pixels; native visual/accessibility checks remain open. |
| Course/catalog hardening | Implemented with coverage limitation | Duplicate cleanup, legacy commitment collapse, term-staleness warnings, catalog/calendar verification, and manual/import fallback are implemented. ASU catalog coverage remains intentionally limited because live class search is authenticated. |
| Backup/security/optional sync | Implemented; deployment certification pending | Encryption, credential clearing on restore, provenance, backups, and optional sync exist. Live Supabase/RLS validation remains environment-dependent. |
| Packaging/updater | Unsigned v0.12.0 lane implemented; CI certification pending | The release workflow builds and smoke-tests both packages before publishing an unsigned GitHub prerelease. A separate signed-updater mode retains configuration, manifest, and signature verification for future use. Developer ID, notarization, Authenticode, and automatic updates are intentionally outside this prerelease. |
| Mobile companion/widgets | Deferred | No current implementation resources are allocated. Narrow desktop reflow remains supported but is not a mobile application. |
| Other ecosystem expansion | Roadmap | Google/Apple/Outlook calendars, Brightspace, Moodle, Google Classroom, richer Canvas API sync, collaboration, and institution-managed deployment remain later work. |

## Privacy and safety gates

| Gate | Result |
| --- | --- |
| Provider keys only cross the masked setup field and native command, are zeroized, and live in the OS vault | Pass by implementation and native contract tests |
| Canvas feed URL is never returned to React or stored in SQLite; only sanitized origin and credential reference persist | Pass by implementation, shape audit, and secret scan |
| Provider prompts, source content, keys, and secret URLs are excluded from AI invocation history | Pass by schema/write-path audit |
| Canvas URL restrictions include HTTPS/443, no credentials/fragments, public DNS, disabled proxies, redirect revalidation, redirect/body/time bounds | Pass by implementation and native tests; live redirect behavior remains an installed-app gate |
| Provider fallback never silently changes company | Pass by routing implementation and consent UI |
| Imported and AI-produced records remain pending until review | Pass by native and UI tests |
| Scholarship requirement files remain encrypted and require explicit review before recognized fields are applied | Pass by schema, native command, and UI workflow tests |
| Backup restore preserves approved data but clears AI and Canvas credentials | Pass by native backup tests and restore-path audit |
| Shared Canvas/provider secrets are absent from tracked diffs, databases, logs, IPC fixtures, backups, and safe errors | Pass in the 2026-09-01 secret scan |

## Automated verification completed

| Command/gate | Latest result |
| --- | --- |
| Workspace TypeScript/static checks | Pass |
| Desktop UI component tests | 34 passed, including axe-core, keyboard calendar operations, and responsive-shell assertions |
| Desktop UI contract tests | 16 passed, including the Scholarship requirement-file workflow |
| Shared-contract tests | 17 passed |
| Cloud service tests | 41 passed |
| Rust/native tests | All 194 accounted for: 191 passed in the restricted run, two loopback-only tests passed with local-network permission, and the ignored live ASU adapter certification passed when invoked explicitly |
| Public Scholarship source certification | ASU ONSA and Global Education passed live source certification on 2026-08-31 |
| Production desktop-UI build | Pass, 1,621 modules transformed; startup chunk reduced from 1.17 MB to 375 KB with no chunk-size warning |
| OCR/packaging script tests | All 54 accounted for: 52 passed in the restricted run and the two disk-image cases passed in the 7/7 macOS signature suite with normal `hdiutil` permission |
| Catalog verifier | Pass: 3 catalogs, 144 courses, 381 sections |
| Academic-calendar verifier | Pass: 1 provider, 3 terms, 6 no-class dates, 2 layouts |
| Browser desktop-window reflow | Pass at 320, 768, 1024, and 1440 pixels with no horizontal overflow; Light and Coqui Dark/Power states checked |
| UI anti-pattern detector | Pass with no findings |
| Secret-leak scan | Pass for known Canvas feed tokens, provider keys, and private-key patterns |
| Diff whitespace check | Pass at the audit checkpoint |

The installed-app E2E specification now covers fresh first run, skippable onboarding, every primary destination, nested Settings navigation, appearance persistence, Scholarship persistence/versioning, and deadline-task creation. The updated specification must run on both release platforms with the prepared OCR runtime before the prerelease is published.

The local OCR verifier currently reports that its prepared, pinned runtime lock is absent. CI assembles that runtime from its configured vcpkg root; a production desktop artifact still needs the same runtime assembled and verified before release.

## Required desktop pre-release matrix

These gates cannot be truthfully completed from one local macOS workspace without regenerated/live credentials, production secrets, and Windows hardware. They remain mandatory before declaring an installer release-ready:

- macOS Apple Silicon and Windows x64: fresh install, offline first run, restart, migration, keyboard-only navigation, high zoom, theme/density/reduced-motion, and resized-window behavior.
- A newly generated Canvas feed: connect within two minutes, partial-success review, unchanged refresh no-op, changed-event update, manual/startup toggle, disconnect credential deletion, and backup/restore reconnect.
- Representative screenshot/PDF/photo inputs: explicit capture/paste, multi-page corrections, review/cancel creates no records, apply creates no duplicates, and keep/delete is honored.
- Separate low-value accounts for OpenAI, Anthropic, and Gemini: connect, least-cost authentication check, capability request, visible provider/model/scope, failure without silent fallback, disconnect, and reconnect.
- Scholarship workflows: refresh both public sources, import a manual/authenticated-source record, review a requirement document, persist and restore a draft version, create a planner task, and verify encrypted-backup round trips.
- Live Supabase deployment: migrations and RLS policies, permitted and denied cross-account access, offline/reconnect conflicts, and recovery behavior.
- Release artifacts: Windows NSIS install/launch/restart/uninstall; macOS DMG mount, ad-hoc seal, copy/launch/restart/unmount; checksums for every published artifact. Developer ID, notarization, Authenticode, and signed automatic updates remain later release-operator work.

The desktop WebDriver build has a separate application identifier and test-only bridge. Its profile root must be a dedicated child of the operating-system temporary directory. A green macOS and Windows platform matrix plus the credentialed scenarios above is the release boundary.
