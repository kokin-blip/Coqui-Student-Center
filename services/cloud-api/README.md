# Student Center cloud API

This optional service brokers authenticated ciphertext synchronization and managed AI. The desktop planner and local vault do not depend on it.

Required runtime configuration:

- `SUPABASE_URL`: the HTTPS project origin, with no path or query.
- `SUPABASE_PUBLISHABLE_KEY`: the project's public/publishable API key.
- `OPENAI_API_KEY`: optional; required only for managed AI.
- `OPENAI_MODEL`: optional model override; defaults to `gpt-5.6-terra`.
- `PORT`: optional; defaults to `8788` on loopback.

Apply `supabase/migrations/202608120001_e2ee_sync.sql` before starting the service. Every account route requires `Authorization: Bearer <Supabase access token>`. The server verifies the token against the project JWKS and sends that same user token to PostgREST; it does not use a service-role key or bypass RLS.

The durable repository stores only encrypted mutation envelopes and key/device metadata. The injected memory repository is for tests and is never selected by `src/server.ts`.
