# Reference-faithful desktop rebuild

## Checkpoint A — selected identity, transparent cleanup

**User selection update:** the user prefers the generated frog with rounded
`coqui` lettering over the original screenshot logo. `logo-selected-source.png`
is now the identity source of truth. The original two screenshots still own their
respective Comfy/Compact layouts, but no longer own the brand artwork.

`logo-background-removed.png` is the built-in image-editing cleanup of the selected
artwork. Native PNG inspection confirms a real alpha channel (1906×825 RGBA).
The clean asset and the selected source are displayed together in the proof.
This is raster artwork, not an original vector or an identified typeface.

Baseline: `c9c809f`, v0.12.0, branch `codex/comprehensive-product-plan`.
The worktree was clean before checkpoint A. The user subsequently approved the
transparent identity and typography proof. Checkpoint B now integrates them in
the application and implements native-backed preferences and distinct Today
compositions. Schema remains 25; published release artifacts are unchanged.

The reference PNGs are the user's original attachments, copied without edits:

| Reference | Owns | SHA-256 |
| --- | --- | --- |
| `reference-comfy.png` | Comfy composition, whitespace, timeline and support panels | `1bb53aa56822ffea00f2e194dbb22e22281e0a2b2d8875e0ad1d1e0186fd5bcb` |
| `reference-compact.png` | Compact composition; original identity superseded by user selection | `a9ac9a964c171809aa0a36c373eb4f2162feeb02cedfec8ef35653a7e3a96f62` |

## Approval gates

1. Identity: compare original frog/wordmark with the proposed source-derived
   asset on light and dark surfaces, at actual size and enlarged. Approve before
   replacing `AppLogo`, favicon, tray, or installer icons.
2. Both Today experiences: compare actual rendered Comfy/light and Compact/dark
   against the references at normalized viewport/state. Obtain visual approval
   before migrating other screens.
3. Full application: require feature parity, visual QA, automated checks, and
   isolated Windows/macOS installed-app verification before calling it complete.

Approving the execution plan does not implicitly approve newly produced artwork.

## Identity investigation

The selected lockup occupies approximately x=90–168, y=17–39 in the 1586×992
Compact screenshot. It is only about 78×22 source pixels. The proof page displays
those original pixels by clipping the untouched screenshot, not redrawing it.
Enlargement cannot recover original vector paths or prove the original font name.

The existing app draws another frog in SVG and renders its wordmark in Manrope.
Several headings specify Manrope without a bundled font or generic fallback;
the baseline browser capture shows serif fallback. Neither matches the references.

`logo-candidate-unapproved.png` retains its historical filename. It was initially
rejected for not matching the screenshot and having an opaque checkerboard, but
the user subsequently selected that artwork. The checkerboard version must not
ship; use the transparent cleanup instead. Prompts and provenance are recorded
in `identity-attempt.md` and `identity-cleanup.md`.

Official Inter Variable was downloaded from
<https://rsms.me/inter/font-files/InterVariable.woff2> with its upstream SIL OFL
license from <https://github.com/rsms/inter/blob/master/LICENSE.txt>. The font is
bundled under `apps/desktop-ui/public/fonts/` and now loaded by the application
following identity approval. Font SHA-256:
`693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3`.

## Reference measurements and intended deviations

| Region | Comfy | Compact |
| --- | --- | --- |
| Sidebar at reference width | ~314px | ~260px |
| Top app-owned command header | No added command strip over Today | ~56px |
| Main composition | Day timeline + next action/deadlines/capacity, ~53:47 | Week above queue/risk/due + ~330px inspector |
| Page heading | Large sans, deep green, approximately 56px | Compact sans, approximately 18–22px |
| Body / dense rows | Start at 16px, generous line height | Start at 13px, compact line height |
| Panel corners | Approximately 6px | Approximately 4–6px |

These are starting measurements, not proof of fidelity. Match actual captures.
Exclude native OS chrome from comparisons. Do not recreate window controls.
Weather is deferred; no fabricated weather, location, avatar, sync status, activity,
or real-student data may be added to make a screenshot look populated.

## Implementation order

- A: references, baseline, parity inventory, source identity and typography proof.
- B: native-backed mode preferences, shared shell/view models, distinct Today
  compositions, and comparison gate. Keep existing features intact.
- C: schema 26 local task details, attachments and history; then every remaining
  screen, settings section, and overlay. No replication of the new detail tables.
- D: visual, accessibility, migration, backup, sync-boundary, automated and
  installed-app certification. No publication or replacement of v0.12.0.

See `feature-parity.md` for the live preservation checklist. A line-count reduction
is not an acceptance criterion. Removed code must map to a tested replacement.

## Preview

`comparison.html` runs the actual application components in a 1586×952 iframe
beside the source. Its width/region controls expose full composition, 1:1 details,
and desktop reflow probes. `?demo&reference=comfy` and `?demo&reference=compact`
are development-only synthetic fixtures with frozen clocks; production builds
remove their fixture import and ignore these parameters. This is not a second
application or a claim that native persistence is exercised by a browser preview.

Approved logo artwork is consumed directly as a raster master through CSS
clipping, without redrawing or retyping. Installer/tray/favicon export replacement
remains outstanding; the published v0.12.0 identity is not modified by this work.

The user approved both Today experiences on September 2, 2026. The visual gate
is satisfied; schema 26 and the remaining desktop screen rollout can proceed.
Full rebuild certification remains outstanding.

Milestone C1 adds schema-26 encrypted local task details and the shared editor in
Today and Work. File uploads are native-only; the browser proof intentionally uses
session-only synthetic edits. See `design-qa.md` for test evidence and remaining
Calendar/remaining-screen/certification work. Published v0.12.0 is unchanged.

With the repository's normal Vite development server running, open this file
through Vite's workspace `/@fs/` URL. All proof images and fonts are local; the
proof has no analytics, external font requests, native commands, or mutations.
Reference images and proof HTML live outside `public/` so they are not shipped
inside production installers.
