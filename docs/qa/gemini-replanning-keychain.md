# Gemini replanning and Keychain diagnosis

## Request format

Both Gemini adapters sent strict JSON Schema through `generationConfig.responseSchema`, which expects Gemini's typed OpenAPI Schema. The automatic-planning schema uses `additionalProperties`; extraction also uses nullable type arrays. Send these schemas unchanged through `responseJsonSchema` with `responseMimeType: application/json` instead. Local response validation remains in place.

Reference: https://ai.google.dev/api/generate-content#v1beta.GenerationConfig

A localhost fixture checks the actual adapter request rather than returning success for any payload. Restoring the old field reproduces `Rejected(400)`; the corrected field passes for planning and extraction. Gemini 400, 401, 429, and 504 responses remain categorized and provider response bodies are not exposed. No live planning facts or saved provider key were sent during diagnosis, so live account/model success remains unverified.

## Credential persistence

The configured Gemini item exists under service `Coqui Student Center AI`, account `gemini`. The existence check requested metadata only, not its password. A separate test saved a uniquely named synthetic credential, read it through a fresh native entry and a separate OS process, then deleted it. This passed on macOS. It demonstrates vault persistence, not access to the user's credential by the installed release.

Saving now verifies an exact readback through a fresh entry before reporting success. Empty or invalid saved keys are treated as credential errors. Provider status queries distinguish missing credentials from vault failures instead of silently rendering access errors as disconnected. Model length is validated before a credential is replaced. Secrets remain in the OS vault and zeroizing native buffers; neither keys nor provider response content are included in diagnostics.

## Validation

- 15 provider unit/fixture tests passed; the synthetic macOS integration test passed separately.
- 23 planning and settings UI tests passed, including renewed consent after failure and review before apply.
- 16 desktop UI contract checks passed.
- The existing rc.6 installers are unchanged; these fixes require an updated native build.
