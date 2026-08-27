# Comprehensive product-plan release audit

Audit date: 2026-08-27
Implementation branch: `codex/comprehensive-product-plan`
Audited baseline: `v0.10.1` / `cc98558db1f962d1910716e3873a14d1cd7525d5`

This document separates implemented behavior from release approval. A feature can be complete in source and automated tests while an installer still requires hands-on verification on each supported operating system.

## Scope disposition

| Plan area | Status | Evidence |
| --- | --- | --- |
| Additive repository foundation | Implemented | Schema 17 migrations and migration tests; exact baseline recorded above. |
| Route/workflow modularization | Implemented | App navigation, import review, Study, and the local workspace screens are separate components; Calendar, Work, Courses, and academic Settings have explicit route-level exports. |
| Canvas calendar link | Implemented | Native feed client, credential-vault storage, review-first candidates, stable identifiers, deduplication, conflict handling, manual/startup refresh, reconnect-on-restore, and per-connection refresh toggle. |
| Screenshot/document schedule setup | Implemented | The four-source import center is available during onboarding and from Calendar; explicit native capture, paste/upload/drop, local OCR first, editable source-side review, AI consent fallback, and mandatory source retention settlement are implemented. |
| OpenAI/Anthropic/Gemini BYOK | Implemented | Native provider adapters, OS credential storage, capability requirements/order, explicit fallback consent, structured/domain validation, local usage summaries, and cloud managed-route removal. |
| Navigation and daily planning | Implemented | Today, Calendar, Work, Courses, Study; vertical day/week calendar; pointer move/resize, unscheduled tray, keyboard move/resize, lock/undo, progressive task fields, and reorganized Settings. |
| Study and academic intelligence | Implemented | Explicit material selection, literal source citations, unsupported-answer labeling, editable study artifacts, confidence reviews/spaced work, weighted grades, what-if results, and GPA projection. |
| Phase 5 ecosystem expansion | Deferred by plan | Calendar/LMS expansion, mobile/widgets, collaboration, and institution-managed deployment were explicitly later scope and are not release dependencies here. |
| Incremental importer enhancements | Deferred by plan | Assisted crop/rotation, phone-photo correction, unusual-layout training, and rotating A/B presets remain post-initial-import improvements. |

## Privacy and safety gates

| Gate | Result |
| --- | --- |
| Provider keys only cross the masked setup field and native command, are zeroized, and live in the OS vault | Pass by implementation and native contract tests |
| Canvas feed URL is never returned to React or stored in SQLite; only sanitized origin and credential reference persist | Pass by implementation and dashboard shape audit |
| Provider prompts, source content, keys, and secret URLs are excluded from AI invocation history | Pass by schema/write-path audit |
| Canvas URL restrictions: HTTPS, port 443, no credentials/fragments, public DNS, proxy disabled, redirect revalidation, three-redirect limit, bounded time/body | Pass by native implementation and unit tests; live redirect-chain behavior still belongs in installed-app smoke |
| Provider fallback never silently changes company | Pass by routing implementation and consent UI |
| Imported/AI records remain pending until review | Pass by native/UI tests |
| Backup restore preserves approved data but clears AI and Canvas credentials | Pass by native backup tests and restore path audit |

## Automated verification completed locally

| Command/gate | Result on 2026-08-27 |
| --- | --- |
| Workspace type/static checks | Pass |
| Desktop UI component tests | 32 passed, including axe-core checks and keyboard calendar operations |
| Shared-contract tests | 17 passed |
| Cloud service tests | 41 passed |
| Rust/native tests | 181 passed |
| Provider fixture tests | Pass for OpenAI, Anthropic, and Gemini using localhost mock servers; no paid calls |
| Production desktop-UI build | Pass, 1,605 modules transformed |
| OCR/packaging script tests | 48 passed, including the onboarding import contract plus signed and deliberately unsealed DMG fixtures |
| Isolated macOS native E2E | 4 passed: fresh first run, skippable onboarding, review-first screenshot ingestion, and offline/manual setup |
| Production dependency audit | 0 known advisories (`npm audit --omit=dev`); development-only WebdriverIO/Tauri test tooling still reports upstream advisories and is excluded from shipped bundles |
| Diff whitespace check | Pass |

The DMG fixtures require normal operating-system disk-image permissions, so they were rerun outside the restricted workspace sandbox and passed. Publication still requires the macOS CI/release lane to verify the actual signed artifact.

## Required pre-release installed-app matrix

These gates cannot be truthfully completed from one local macOS workspace without live credentials and Windows hardware. They remain mandatory before declaring an installer release-ready:

- macOS Apple Silicon and Windows x64: fresh install, offline first run, restart, migration, keyboard-only and high-zoom pass.
- A real Canvas feed: connect within two minutes, unchanged refresh no-op, changed event creates one reviewable update, manual/startup toggle, disconnect, and backup/restore reconnect.
- Representative screenshot/PDF inputs: capture only on request, explicit paste, review/cancel creates no records, apply creates no duplicates, and keep/delete is honored.
- Separate low-value test accounts for OpenAI, Anthropic, and Gemini: connect, least-cost authentication check, capability request, visible provider/model/scope, failure without silent fallback, disconnect, and reconnect.
- Signed/package output: Windows NSIS install/uninstall and macOS DMG mount, signature/seal, launch, update configuration, and checksums.

The local macOS WebDriver smoke uses a separate app identifier, includes the test bridge only in its E2E bundle, creates a unique temporary profile, and has a native guard that rejects any E2E data root outside the operating-system temporary directory. The existing CI matrix builds, tests, packages, and runs the same native smoke on `windows-latest` and `macos-15`. A green platform matrix plus the credentialed scenarios above is the release boundary.
