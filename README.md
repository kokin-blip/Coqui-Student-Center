# Coqui Student Center Desktop

Coqui Student Center is a downloadable, local-first desktop application for Windows x64 and Apple Silicon macOS. It does not load a hosted product website: the React interface is compiled into the Tauri binary and the core planning loop works without an account or internet connection.

## What works in the desktop vertical slice

- Polished Today, Timetable, Assignments, Courses, and More navigation with Quick Add, source-aware empty states, restrained motion, and system/light/dark themes.
- Four-stage autosaving onboarding for a private local profile, one of 6,243 bundled US institutions or a custom worldwide school, academic term, multiple courses and recurring class meetings, and the student's weekly rhythm.
- Assignments and exams, instructors, recurring class series, academic no-class events, accessible agenda fallbacks, and planner regeneration after relevant changes.
- No production sample seeding. Exact untouched legacy fixtures are quarantined before UI bootstrap and can be restored or purged later without interrupting onboarding.
- Vector Coqui frog-and-book identity with Windows ICO, macOS ICNS, tray/notification mark, and PNG application assets.
- Encrypted SQLCipher database with a random key protected by Windows Credential Manager or macOS Keychain.
- Optional Student Center app PIN with versioned Argon2id derivation, authenticated device-key wrapping, failure throttling, explicit lock-now control, and startup locking before any dashboard data is returned.
- XChaCha20-Poly1305 document vault with unique per-file keys and SHA-256 integrity metadata.
- Native file picker plus content-validated PDF, text, DOCX, PPTX, CSV, XLSX, and deterministic ICS extraction with field evidence and approval before mutation.
- Image and scanned-PDF OCR adapters with confidence-aware evidence, bounded native processes, and an in-app readiness report; imports remain encrypted and visibly marked for attention when the verified local OCR runtime is unavailable.
- Native, read-only Canvas personal-token sync for active courses, assignments, and calendar events, with DNS-pinned HTTPS, redirect/private-network blocking, opaque pagination, idempotent immutable snapshots, sync history, mandatory review, and explicit critical-date conflict resolution that never duplicates canonical tasks.
- Offline tasks, fixed commitments, deterministic non-overlapping planning, next-action reason codes, completion, and disruption replanning.
- Opt-in native reminders with encrypted local preferences/delivery history, student-timezone quiet hours, privacy-safe locked previews, and in-app Start, Complete, Snooze, and Dismiss controls.
- Strict `studentcenter://` plan-block deep links, single-instance focus, and persisted desktop window state.
- Fail-closed private-beta update checks: the HTTPS endpoint and Tauri signing public key must be embedded at build time; development builds have no update channel and the webview cannot download or install updates directly.
- Optional Supabase email-code and Google accounts. Google sign-in opens the system browser with native PKCE, correlates the one-time deep-link callback in Rust, and never exposes authorization codes or verifiers to the webview. Native HTTPS exchange, strict six-digit email verification, serialized refresh-token rotation, and OS-credential-vault persistence keep account and token operations behind locked native commands; the webview receives status only.
- Native encrypted-sync protection setup: a confirmed 24-word BIP-39 recovery code represents a random 256-bit account key, while each computer receives an independent X25519 device key. Unconfirmed secrets remain only in zeroizing Rust memory; confirmed account and private device keys are stored together in the operating-system credential vault and are never returned to the React webview or written to SQLite.
- Native encrypted device registration and mutation transport: a strict compile-time HTTPS cloud origin, no-redirect authenticated requests, profile-to-account binding, XChaCha20-Poly1305 envelopes whose associated data covers every routing field, and a persisted ciphertext-only outbox make upload retries idempotent without exposing mutation content.
- Cryptographically attributable authorship. Every mutation envelope carries an Ed25519 signature from the authoring computer's own device identity, covering the routing metadata, the nonce, and the ciphertext. The account key is shared between a student's computers, so the AEAD alone could never establish which computer wrote a change; the signature can. The service verifies it against the pushing device's registered key before storing anything, and each computer verifies it again on download against a locally pinned copy of its peers' keys, before the cipher runs.
- Appending to the encrypted log requires an approved, unrevoked device, enforced independently at the API route, in a repository decorator shared by every storage adapter, and in the database's row-level insert policy.
- Deterministic local merge on download: last-writer-wins per entity with stable device tie-breaking, an observed-remove set for task dependencies, and critical academic dates that are never silently overwritten but raised as an explicit conflict to review. Changes whose entity type this version does not recognize are kept encrypted on the device and applied automatically after an update, rather than being discarded.
- Append-only local mutation log. Plans, plan blocks, document metadata, reminders, notification preferences, and integration connections are recorded locally as provenance but are deliberately never uploaded: they have no cross-device merge rule, so replicating them would spend storage on records no other computer could apply.
- Portable `.studentcenter` backup and restore: age passphrase encryption wraps a consistent SQLCipher snapshot, encrypted vault objects, and integrity metadata; restore previews and fingerprints the archive before an explicit non-destructive replacement transaction rekeys it to the receiving device.
- Verified-account, ciphertext-only sync/device/release service contracts, Supabase RLS migrations, and optional managed OpenAI structured extraction.
- Browser output only for interface development and automated testing; it is not an end-user product.

## Repository structure

```text
apps/desktop-ui       Bundled React/Vite interface
apps/desktop          Tauri host and Rust domain commands
packages/contracts    Encrypted sync and AI schemas
services/cloud-api    Optional account, ciphertext sync, releases, and managed AI
```

## Develop and test

Requires Node.js 22+, stable Rust, platform Tauri prerequisites, and Perl when compiling the vendored SQLCipher/OpenSSL dependency on Windows.

```powershell
npm install
npm run check
npm test
npm run desktop:dev
```

Build the current platform installer with `npm run desktop:build`. Windows produces an unsigned x64 NSIS installer. Apple Silicon builds run on an ARM64 macOS runner and produce an ad-hoc/private-beta DMG until signing credentials are configured.

Release updater artifacts are deliberately separate from normal development/CI bundles. A release build must set `STUDENT_CENTER_UPDATER_ENDPOINT` and `STUDENT_CENTER_UPDATER_PUBLIC_KEY` at compile time, keep `TAURI_SIGNING_PRIVATE_KEY` and its password only in the release secret store, and merge `apps/desktop/src-tauri/tauri.release.conf.json` into the Tauri build. Without both embedded trust settings the installed app reports that no update channel is configured and performs no network request.

OCR release builds reconstruct a pinned runtime containing PDFium, a source-built static Tesseract 5.5.2 executable, and official `tessdata_fast` English data. Scanned-PDF rendering runs in an isolated helper invocation of the desktop executable, loads documents from memory for Unicode-safe paths, and emits compressed PNG pages under process, page, and 512 MiB output limits. Preparation collects PDFium and every vcpkg dependency notice, then emits a source-bound SHA-256 lock. `npm run ocr:verify -- --target=windows-x64 --require-ready` (or `macos-arm64`) is mandatory before packaging. Development overrides are `STUDENT_CENTER_PDFIUM`, `STUDENT_CENTER_TESSERACT`, and `STUDENT_CENTER_TESSDATA`.

Managed AI is optional and runs only in `services/cloud-api`. Configure `OPENAI_API_KEY` and optionally `OPENAI_MODEL` (default `gpt-5.6-terra`) on that service. The desktop app never receives the provider key and sends no excerpt without explicit student action.

The cloud API fails closed unless `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` are set. Apply the migrations in `supabase/migrations` before starting it. Account-bound routes verify Supabase JWTs against the project's remote JWKS, derive the account UUID only from the verified `sub` claim, and forward the user's access token to PostgREST so database RLS remains active. The in-memory repository exists only as an injected test adapter; the production server never falls back to it.

Account-enabled desktop builds must embed `STUDENT_CENTER_SUPABASE_URL` and `STUDENT_CENTER_SUPABASE_PUBLISHABLE_KEY` at compile time. Both are public trust configuration, not service credentials; never embed a secret or service-role key. Configure the Supabase magic-link/OTP email template to display `{{ .Token }}` so the student receives the six-digit code expected by the app. Enable the Google provider and add `studentcenter://auth/callback?sb_flow_id=*` to Supabase Auth's additional redirect URLs; the bounded wildcard covers only the per-flow correlation value. Without both build settings, the optional account interface stays visibly unavailable while every local feature continues to work.

Encrypted-sync builds must also embed `STUDENT_CENTER_CLOUD_API_URL` as an HTTPS origin on the standard port with no path, query, credentials, or fragment. Without it, recovery protection remains usable but device registration and network synchronization fail closed.

## Security boundaries

- The webview cannot issue arbitrary SQL.
- When an app PIN is enabled, every data-bearing native command rejects requests while locked. The PIN is a local privacy gate for the signed-in operating-system session; it complements rather than replaces OS account, disk, and credential-store security.
- Canvas tokens are stored only in the Windows Credential Manager or macOS Keychain, never in SQL, logs, dashboard responses, or browser storage. The native OS vault is used instead of a webview-addressable Stronghold store so sync commands never return credentials to JavaScript.
- Canonical records change only through typed native commands.
- Imported academic facts require review.
- Accepted imported fields retain evidence-linked provenance; conflicting Canvas dates require an explicit keep-current or accept-source decision.
- Raw content and credentials are redacted from service logs.
- Backup archives never contain plaintext database pages or document bodies. Canvas and account credentials are deliberately excluded; restored connections require reauthentication.
- Cloud synchronization contracts accept ciphertext, nonces, signatures, hashes, and metadata—not readable student content.
- A change's authorship is cryptographically verifiable. Holding the account key is not enough to forge a change attributed to another computer, because each computer signs with a device key that never leaves it.
- Loss of all authorized devices and the 24-word recovery code will make future encrypted cloud data unrecoverable.

## Known limitations

These are deliberate, current boundaries rather than defects, and they are stated here so the security claims above are not read as broader than they are.

- **Revoking a computer does not rotate the account key.** Revocation stops a computer from reading or writing anything *new* through the service, enforced at the API, in the repository layer, and in the database policy. It cannot un-disclose what that computer already downloaded, which it keeps along with the copy of the account key it already holds. Key rotation is a protocol-sized change: it needs a key epoch bound into every signature, re-wrapped envelopes delivered to every remaining computer, an epoch barrier on download, and re-encryption of the existing log and every stored document. The planned design is sketched in [docs/DESKTOP_ARCHITECTURE.md](docs/DESKTOP_ARCHITECTURE.md).
- **Any authorized computer can read all of the account's synchronized data.** The account key is shared across a student's computers by design; signatures establish who wrote something, not who may read it.
- **The database and API rules have not been exercised against a live Supabase project.** Route and repository behaviour is covered by a conformance suite that runs every case against both the in-memory and PostgREST-backed adapters, but row-level security policies and triggers are enforced by Postgres and are currently only asserted as migration text.

See [docs/DESKTOP_ARCHITECTURE.md](docs/DESKTOP_ARCHITECTURE.md) for boundaries, current milestone status, and the remaining MVP work.
