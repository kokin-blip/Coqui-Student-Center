# Backlog

Open work after 0.9.2, with the reasoning behind each item so it does not have to
be rediscovered. Ordered roughly by value.

Decisions already made are recorded at the bottom. Re-open them deliberately
rather than by accident.

---

## 1. Course catalog coverage

**State.** 133 courses, 381 sections, 45 subject codes, Fall 2026 only. That is
four General Studies categories (HUAD, GCSI, CIVI, AMIT) plus CSE 240 — whatever
happened to be exported. `CSE` contains exactly one course, so a computer science
major is largely uncovered.

**The manual path works today and needs no new tooling.** Save Class Search result
pages as PDF, run `pdftotext -layout` on each, then:

```
npm run catalog:prepare -- --institution=104151 --term=asu-fall-2026-c \
  --source-label="ASU Class Search" \
  --source-url="https://catalog.apps.asu.edu/catalog/classes" \
  page1.txt page2.txt ...
npm run catalog:verify
```

Adding a few subject pages is a ten-minute job. `catalog:verify` runs in CI and in
the release lane, so a malformed regeneration fails the build rather than shipping.

**The Class Search URL is drivable** if this is ever automated:

```
classlist?campusOrOnlineSelection=C&subject=CSE&term=2267&searchType=all
classlist?advanced=true&gen_studies=GS-HUAD&term=2267&searchType=all
```

`term=2267` is Fall 2026. Results paginate at 100.

**If automating, do not use PDF export.** Page breaks splice the running header
into a row, merging it with the start time (`Class Search3:00 PM`) or truncating
the row after the days. That silently corrupted three sections and cost three
parser bugs. Reading the rendered results table gives structured rows and removes
that entire class of problem.

**Unresolved question, decide before building anything automated:** does a harvest
stay local to one machine, or ship inside the app to other students? Bundling
data pulled from one student's authenticated session and distributing it is a
different posture from that student fetching their own. A third option is shipping
the *tooling* rather than the data, so each student harvests their own courses —
better product answer, works for any school, always current, but it needs a path
that does not depend on a browser extension students will not have.

**Term staleness.** `asu-fall-2026-c` is baked in. When the term turns over the
catalog needs regenerating from new exports. The section picker states which term
it is showing, so a student is warned, but the data does not update itself.

---

## 2. Auto-updater via GitHub Releases

Would end hand-distributing DMGs. **Does not require Supabase** —
`validate_updater_configuration` in `apps/desktop/src-tauri/src/main.rs` only
requires HTTPS, a host, and no embedded credentials. A static `latest.json`
attached to a release satisfies it. The `/v1/releases/:platform/:arch/latest`
route in `services/cloud-api` is one possible endpoint, not a requirement.

Four steps:

1. `tauri signer generate` — an updater keypair, separate from macOS code signing.
2. Build with the `tauri.release.conf.json` overlay, which sets
   `createUpdaterArtifacts` and produces the `.tar.gz` + `.sig` the updater needs.
   It is excluded from `release.yml` today precisely because it fails the build
   without `TAURI_SIGNING_PRIVATE_KEY`.
3. Embed `STUDENT_CENTER_UPDATER_ENDPOINT` and `STUDENT_CENTER_UPDATER_PUBLIC_KEY`
   at compile time. `option_env!` means without them the app reports no update
   channel and makes no network request — the existing fail-closed behaviour.
4. Publish `latest.json` as a release asset.

Two cautions. The updater private key becomes a genuinely high-stakes secret:
anyone holding it can push an update every installed copy will trust and install.
And the updater replaces the `.app` in place — since builds are only ad-hoc
signed, confirm the replaced bundle still launches rather than tripping Gatekeeper
again. That is the same failure class as the 0.9.0 "damaged" bug.

---

## 3. Collapse commitments already imported from a recurring event

Import now writes one class meeting series for a weekly rule, but anything
imported before 0.9.2 is still dozens of individual commitments. Agreed
behaviour: **leave them alone by default**, and offer an opt-in collapse.

Detect groups of three or more commitments sharing title, weekday and local time,
offer to fold them into one series, and show the change for review before
anything is written. Nothing automatic, nothing retroactive without consent.

---

## 4. Signing

**macOS notarization** needs an Apple Developer membership ($99/yr). Everything
else is already in place: swap `bundle.macOS.signingIdentity` from `-` to a real
Developer ID and add `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` to the release workflow. The
`macos:verify-signature` gate keeps working unchanged. Until then every Mac user
does one **System Settings → Privacy & Security → Open Anyway** per machine.

**Windows** is still unsigned and shows SmartScreen. Same root cause as the macOS
bug, different fix, needs a code-signing certificate.

---

## 5. Smaller items

- **ICS `LOCATION` is not read.** Imported class meetings default to a `lecture`
  component with an empty location.
- **Course and title duplicate in review** for imported classes, because an ICS
  `SUMMARY` fills both fields.
- **Quick add offers enrolled courses, not the catalog.** Deliberate — an
  assignment for a class you are not taking is not a real case — but easy to
  switch if that turns out to be wrong.

---

## Decisions already made

Re-open these on purpose, not by accident.

**ASU publishes no usable course API.** The class search behind
`catalog.apps.asu.edu` answers 401 to anyone anonymous and authenticates through
`weblogin.asu.edu` with an OAuth2 code grant and a client secret embedded in their
SPA. The legacy public search at `webapp4.asu.edu` redirects into it, and
`catalog.asu.edu` carries policy and archive pages, not courses. Reading it
programmatically means defeating an access control, so nothing in this app does.
The catalog is built offline from pages a student exported themselves.

**Seat counts are deliberately excluded.** They are wrong within hours, and a
stale count in a bundled file is worse than no number.

**Canvas keeps producing individual commitments.** It expands recurrences
server-side, so there is no rule to read. Collapsing would mean inferring a weekly
pattern from repeated titles and times, and that guess is not worth shipping. ICS
is the reliable recurring source.

**The weekly collapse is deliberately narrow.** An interval, a positional selector
like `BYDAY=2MO`, or any non-weekly frequency keeps the old expansion. A rule that
cannot honestly be stated as "every week on these days" must not be flattened into
a schedule that was never in the file.

**Imported classes are filed under the term containing the first meeting**,
falling back to the active term, and approval fails with a plain message if no
term exists. A calendar file has no notion of terms and a recurrence count says
nothing about which term a class sits in.

**Sync still requires Supabase**, for auth (`createSupabaseAccessTokenVerifier`)
and for the row-level policies that use `auth.uid()`. The `SyncRepository`
interface itself is cleanly swappable; auth and RLS are the coupled parts. Not
needed at all unless a student uses more than one computer.

---

## Gotchas worth remembering

Each of these cost real time and produced output that looked correct.

- **`pdftotext -layout` indents rows**, so the leading run of spaces becomes a
  column delimiter and shifts every field by one. Symptom: zero matches.
- **Closing a wrapped title at the instructor name also aborts the scan for the
  course code**, which sits below it. Symptom: a hundred-class file yields one
  record, looking like a working parser with thin data.
- **Candidate `kind` is switched on in about six places.** Adding a kind and
  missing one fails at approval on an entity type it was never taught. The
  candidate kind is `class_meeting`; the replicated entity is
  `class_meeting_series`, and the mutation log needs that mapping.
- **Re-approving one candidate is not the same as re-importing a file.** The app
  never revisits an approved candidate; a second import creates a new candidate
  sharing the `source_uid`. Testing the wrong one hits a provenance uniqueness
  constraint that cannot happen in practice.
- **Verify published artifacts by downloading them**, not by trusting the build
  that produced them. 0.9.0 shipped a DMG macOS refused to open while every CI
  step reported success.
