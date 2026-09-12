# Backend workspace (G1 Auth foundation)

This workspace currently contains the Auth service and API Gateway auth boundary. Other services in the design have not been scaffolded yet. Do not treat G0 as complete: Redis, Kafka, remaining app skeletons, shared runtime configuration, and CI are still pending.

## Local setup

Use Node.js 24 LTS (`.nvmrc`). Copy `.env.example` to `.env`, replace the gateway service token with a long random value in both variables, then run `npm run dev:keys`. The generated private key is outside the workspace under `.secrets/` and must not be committed. During JWT key rotation, keep prior public keys in `AUTH_JWKS_PREVIOUS_PUBLIC_KEYS_JSON` until all access tokens signed by them have expired.

Install workspace dependencies, start PostgreSQL with `docker compose up -d auth-postgres`, run `npm run migration:run`, then start `npm run dev:auth` and `npm run dev:gateway` in separate terminals. The Auth service requires the RSA key paths and the database URL at startup. In development, migration commands load `Backend/.env`.

Set all three `SEED_ADMIN_*` values only for local development if a content manager account is needed. The seed is disabled in production and fails startup if any seed variable is set there.

## Auth boundary

The Gateway proxies only explicit Auth routes. Public authentication routes have method/path-specific rate limits; all other requests require RS256 verification and a successful Auth session check. Requests to `/internal/*` are not routed by the Gateway. Auth accepts internal validation only from callers with configured service credentials.

For protected application routes added in later phases, apply the Gateway access guard and role guard. The in-memory rate limiter is per Gateway process and uses the peer IP (safe default behind a proxy). Before deployment behind an ingress, configure trusted proxy addresses and a shared rate-limit store or edge limits. Production also needs TLS and secret management.

## Verification

`npm run typecheck` and `npm test` are local checks. With the services and migrated database running, use `npm run smoke:auth` for the HTTP workflow. PostgreSQL migration, database race tests and Gateway/Auth end-to-end checks require the Compose database and are not implied by a successful TypeScript build.

The current Express adapter transitively installs Multer 2.2.0, which `npm audit --omit=dev` reports as high severity. G1 has no file-upload/multipart routes; resolve this dependency before adding multipart handling or deploying the service.
