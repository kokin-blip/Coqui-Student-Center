# Identity extraction attempt 1 — rejected

Historical status superseded: the user subsequently selected this design over
the screenshot logo. Its artwork is now approved; its opaque checkerboard is not.
See `identity-cleanup.md` for the background-removal result.

Method: built-in image editing. Input: `reference-compact.png`.
Output: `logo-candidate-unapproved.png` (1919×820, RGB, no alpha).
No production asset consumes this output.

The output changes source details and paints a checkerboard instead of transparency.
It must not be treated as an exact extraction or approved brand master.

## Exact prompt

Use case: background-extraction.
Input image is the EDIT TARGET. At its top-left, between x=90 and x=169, y=17 and y=40 of the 1586x992 screenshot, is the user's chosen brand lockup: a small chartreuse frog face followed by green lowercase "coqui". Isolate ONLY this existing frog-face and existing wordmark from the screenshot and remove the dark background. Exclude all window buttons, exclude "Student Center", exclude "Power mode", exclude the rest of the UI. Return one horizontal logo lockup on genuinely transparent background with minimal empty padding at high resolution for inspection. Preserve the exact source silhouette, two raised eyes, pupils, cheeks, curved smiling mouth, original green colors, letter shapes, lowercase lettering, wordmark weight, spacing and proportions. Text verbatim "coqui" (c o q u i). This is conservative extraction/cleanup/upscaling of the provided pixels, NOT a new logo design. No square badge, no new outlines, no gradient, no embellishment, no substituted typeface, no redesign. Preserve the small source's rounded wordmark geometry including the q descender.
