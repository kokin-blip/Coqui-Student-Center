# Selected identity — background removal

The user explicitly selected the earlier generated logo over the original
screenshot logo. This supersedes the previous rejection of its design.
Only the background was requested to change; preserve this frog and wordmark
as the brand reference for both Comfy and Compact.

- Input: `logo-selected-source.png` (user's new attachment).
- Output: `logo-background-removed.png`.
- Method: built-in image-editing tool, not CLI/API fallback.
- Format: PNG, 1906×825, alpha channel confirmed with native image inspection.
- The source and output are both retained; no production asset overwritten.
- Browser proof visually checked on white and dark surfaces at small and enlarged
  sizes: background and letter openings reveal the actual surface, with no
  checkerboard. Capture: `identity-proof-capture.png`.
- Desktop icon source: `apps/desktop-ui/public/brand/coqui-face.png`, a direct
  square crop of the approved transparent master (520×520, alpha). No pixels were
  redrawn or generated. Tauri produced the Windows PNG/ICO tile family and macOS
  ICNS/PNG family from this exact crop. Dormant Android/iOS assets were restored
  unchanged because mobile packaging remains deferred.

## Exact prompt

Edit the attached image, which is the approved Coqui logo. Remove ONLY the white/light-gray checkerboard background, replacing all background pixels with actual transparent alpha including inside the o and q. Preserve this EXACT frog and wordmark: lime/chartreuse face, two round raised eyes, dark pupils, two green cheeks, two dark nostrils, broad dark curved smile, green rounded lowercase "coqui" letters. Do not redraw, redesign, retype, recolor, reposition, add shadows or change geometry. Keep the original dimensions and relative size/position of all artwork. Return a PNG cutout with genuine alpha transparency, NOT a painted checkerboard, NOT white or black background. The logo itself is approved; only remove its background.
