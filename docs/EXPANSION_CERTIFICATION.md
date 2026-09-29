# Feature expansion certification status

Checked 2026-09-23 against the current uncommitted workspace on macOS ARM64. This is a partial verification record, not release approval.

## Verified locally

- The test-only native Tauri binary builds with the isolated WebDriver profile. Nine macOS native smoke cases pass: fresh first run, minimal onboarding, primary navigation, quiz priority and deadline separation, local funding records, encrypted backup export/preview/restore, profile persistence after a native session restart, screenshot import remaining pending review, and manual setup fallback.
- Workspace TypeScript and Rust checks pass. The full workspace UI/contract/cloud tests pass; native Rust tests pass (221 passed, one intentionally ignored). The release-script suite passed on this host before the final professor-adapter change. The professor-adapter unit test confirms that no rating is returned without an authorized provider.
- Native smoke data and backup archives use dedicated operating-system temporary directories. The real Coqui profile was not used.

## Not yet certified

- This run used a test-only native binary, not a packaged DMG or Windows installer. Installed-package launch, accessibility at high zoom/reduced motion, OCR with the prepared production runtime, and the full hands-on macOS/Windows journey matrix remain open. The local OCR release gate reports `runtime-lock.json is missing`. No Windows host or runner was available for these uncommitted changes.
- No fresh Canvas feed or low-value OpenAI, Anthropic, or Gemini credentials were configured here. Live connection, failure/fallback, disconnect, and credential-clearing checks remain open.
- No Supabase project credentials, RLS test-user tokens, funding-catalog signing key, populated catalog, or deployment target were configured here. The public catalog and optional sync passed local automated tests but were not deployed or verified against a live service.
- Professor names from official class listings are available, and the rating-provider boundary defaults to disabled. Automatic matching to verified faculty-directory profiles remains open; name-only guesses must not be presented as verified profiles. RMP automation remains disabled pending authorized access.

Before release, use dedicated test accounts and disposable profiles on both operating systems; do not enter production student data into smoke runs. Record installer hashes, platform versions, credentials used (by reference only), and pass/fail evidence for each remaining gate.
