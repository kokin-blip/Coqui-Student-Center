# Student Center cloud API

This optional service brokers authenticated ciphertext synchronization. The desktop planner, local vault, and BYOK AI providers do not depend on it.

Required runtime configuration:

- `SUPABASE_URL`: the HTTPS project origin, with no path or query.
- `SUPABASE_PUBLISHABLE_KEY`: the project's public/publishable API key.
- `PORT`: optional; defaults to `8788` on loopback.

Apply `supabase/migrations/202608120001_e2ee_sync.sql` before starting the service. Every account route requires `Authorization: Bearer <Supabase access token>`. The server verifies the token against the project JWKS and sends that same user token to PostgREST; it does not use a service-role key or bypass RLS.

The durable repository stores only encrypted mutation envelopes and key/device metadata. The injected memory repository is for tests and is never selected by `src/server.ts`.

## Public Funding catalog (optional)

`GET /v1/funding/catalog` serves signed, normalized public opportunity batches. It does not require an account. Requests accept only `cursor`, `since`, `region`, and `institutionId`; student profiles and academic records are never sent to this endpoint. The desktop app matches downloaded opportunities locally and retains its encrypted cache when a refresh fails.

To enable it, set `FUNDING_CATALOG_JSON` to a JSON array of validated public opportunities and `FUNDING_CATALOG_SIGNING_KEY` to the Ed25519 private key in PKCS#8 PEM format. Deploy the desktop app with the service's HTTPS origin in `STUDENT_CENTER_CLOUD_API_URL` and the corresponding raw 32-byte Ed25519 public key, base64url-encoded without padding, in `STUDENT_CENTER_FUNDING_CATALOG_PUBLIC_KEY`. Both desktop variables are build-time configuration; changing the trust key requires a new app build. Keep the private key out of the repository and distribute only the public key with the app.

Each opportunity must include HTTPS `canonicalUrl`, `sourceUrl`, and `applicationUrl`, plus `provider`, `title`, `opportunityType`, `summary`, RFC 3339 `updatedAt`, and `parserVersion`. Optional eligibility and award fields are validated by the endpoint. Populate this catalog from approved public sources before shipping the feature; an empty catalog is not treated by the desktop as a successful refresh, so cached opportunities cannot be accidentally cleared. The client rechecks signatures and source links before persisting a batch.

Set `FUNDING_CATALOG_GRANTS_GOV=1` on the service to also search [Grants.gov's public applicant API](https://www.grants.gov/api/api-guide) automatically. The adapter checks the published “Individuals” eligibility code (`21`) in each detail response and requires student-related text; it does not send any student data upstream. Results are cached in service memory for 24 hours. It checks up to four current hits each for student, undergraduate, graduate, and fellowship queries, deduplicating before detail requests. Its signed catalog batches remain explicitly partial, so the desktop does not infer that an absent opportunity was withdrawn. A source failure is reported in the Funding source status when curated opportunities can still be served; when no verified opportunities remain, the endpoint fails and the desktop keeps its encrypted cache. This is deliberately limited coverage, not a comprehensive grants search.
