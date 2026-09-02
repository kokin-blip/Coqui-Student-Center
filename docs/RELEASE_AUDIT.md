# Comprehensive product-plan release audit

Audit date: 2026-09-02

Implementation branch: `codex/comprehensive-product-plan`

Published desktop source: `v0.12.0` / `a220dc9041902c45dc430d4fe54b44bb96b3fc6c`

This document separates implemented behavior from release approval. A workflow can be complete in source and automated tests while an installer still requires credentialed, hands-on verification on each supported desktop operating system.

## v0.12.0 publication evidence

[The unsigned desktop prerelease is published](https://github.com/kokin-blip/Coqui-Student-Center/releases/tag/v0.12.0).

- [Desktop CI](https://github.com/kokin-blip/Coqui-Student-Center/actions/runs/33601271767) passed shared checks and both native platform jobs, including the six E2E cases. This tested application commit `fb3b929`; the release tag adds only installer smoke-workflow hardening.
- [Release certification](https://github.com/kokin-blip/Coqui-Student-Center/actions/runs/33665073980) checked out the exact release tag, passed both platform builds, OCR runtime verification, native tests, checksums, and packaged installer smoke tests, then published both platforms together.
- Windows smoke installed the NSIS package into a temporary directory, launched twice, verified the persisted database, and uninstalled. macOS smoke mounted the DMG, verified the copied app's ad-hoc seal, launched twice, verified the database, and unmounted. Both used fresh disposable GitHub-hosted OS accounts and refused to run over an existing Coqui profile, isolating the profile and credential vault.
- Both published installers were downloaded again and their SHA-256 digests verified. GitHub changed spaces to dots in asset names; the two checksum files were corrected to reference the actual download names. Installer bytes and the release tag were unchanged. Release tooling now normalizes names before checksum generation, with a repeatability regression test.
- Release notes are included in the release body and as `0.12.0.md`. No signed updater archives or `latest.json` were published.

| Published installer | Verified SHA-256 |
| --- | --- |
| `Coqui.Student.Center_0.12.0_aarch64.dmg` | `901590d44bdce28ba7f5288c24b997cfa1780642bacdbf109250501934f1384d` |
| `Coqui.Student.Center_0.12.0_x64-setup.exe` | `edfd60f41d04fd38c4470bcc2c9b0a6e381cf46336011db0f8546b60276c4f07` |

This is prerelease certification, not a claim that all hands-on or credentialed scenarios below have been performed. Those remaining checks are disclosed rather than silently marked complete.

## Desktop-first scope decision

The current product and release target is the installed Tauri desktop application on macOS Apple Silicon and Windows x64. Engineering, design, testing, and release resources should be spent on making that application complete and dependable before beginning a separate mobile companion.

The narrow-width work already delivered is retained because desktop windows can be resized, zoomed, tiled, or used with accessibility magnification. The 320px bottom navigation and generated small icons do **not** represent an iOS or Android product commitment. No mobile runtime, store package, mobile synchronization model, widget, or mobile-specific workflow is part of the current release.

Mobile companion and widget work is deferred until the desktop application has passed its installed-app matrix. Near-term resources instead go to:

- a live Canvas smoke test with a regenerated feed credential;
- macOS and Windows installed-app UX and accessibility certification;
- continued production OCR and downloaded-artifact verification;
- live Supabase/RLS and low-value AI-provider certification;
- remaining desktop-shell and overlay maintainability work where it reduces release risk.

Developer ID signing, notarization, Windows Authenticode, and signed automatic updates are deferred, as explicitly accepted for this unsigned prerelease.

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
| Packaging/updater | Unsigned v0.12.0 published and package-certified | Both NSIS and DMG passed the release workflow and downloaded checksum verification. A separate signed-updater mode retains configuration, manifest, and signature verification for future use. Developer ID, notarization, Authenticode, and automatic updates are intentionally outside this prerelease. |
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
| OCR/packaging script tests | 55 passed in the final run with normal `hdiutil` permission, including both disk-image cases and the new GitHub checksum-name regression |
| Catalog verifier | Pass: 3 catalogs, 144 courses, 381 sections |
| Academic-calendar verifier | Pass: 1 provider, 3 terms, 6 no-class dates, 2 layouts |
| Browser desktop-window reflow | Pass at 320, 768, 1024, and 1440 pixels with no horizontal overflow; Light and Coqui Dark/Power states checked |
| UI anti-pattern detector | Pass with no findings |
| Secret-leak scan | Pass for known Canvas feed tokens, provider keys, and private-key patterns |
| Diff whitespace check | Pass at the audit checkpoint |

The six native E2E cases passed on both platforms. They cover fresh first run, skippable onboarding, every primary destination, Canvas Settings navigation, native appearance/Scholarship/draft-version persistence, deadline-task creation, and schedule-import/setup flows. This does not replace the full hands-on journey matrix below.

The local OCR verifier's prepared runtime lock is absent, but both published installers were built with pinned runtimes assembled and verified in CI.

## Remaining hands-on and credentialed certification

The following broader journeys are not all covered by the automated checks above. Complete them before declaring general-release readiness. Missing Canvas/provider/Supabase credentials do not block the explicitly authorized unsigned prerelease, but must remain disclosed:

- macOS Apple Silicon and Windows x64: fresh install, offline first run, restart, migration, keyboard-only navigation, high zoom, theme/density/reduced-motion, and resized-window behavior.
- A newly generated Canvas feed: connect within two minutes, partial-success review, unchanged refresh no-op, changed-event update, manual/startup toggle, disconnect credential deletion, and backup/restore reconnect.
- Representative screenshot/PDF/photo inputs: explicit capture/paste, multi-page corrections, review/cancel creates no records, apply creates no duplicates, and keep/delete is honored.
- Separate low-value accounts for OpenAI, Anthropic, and Gemini: connect, least-cost authentication check, capability request, visible provider/model/scope, failure without silent fallback, disconnect, and reconnect.
- Scholarship workflows: refresh both public sources, import a manual/authenticated-source record, review a requirement document, persist and restore a draft version, create a planner task, and verify encrypted-backup round trips.
- Live Supabase deployment: migrations and RLS policies, permitted and denied cross-account access, offline/reconnect conflicts, and recovery behavior.
- Developer ID, notarization, Authenticode, and signed automatic updates remain deferred release-operator work; unsigned installer smoke and checksum checks are complete above.

The desktop WebDriver build has a separate application identifier and test-only bridge. Its profile root must be a dedicated child of the operating-system temporary directory. The unsigned prerelease uses the green automated platform/package matrix with explicit outstanding-certification disclosures; it does not claim the broader matrix is complete.
