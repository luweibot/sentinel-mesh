# Setup Guide

## Prerequisites

- **Node.js >= 20** (checked via `engines` in `package.json`)
- **pnpm >= 9** (`corepack enable` or `npm install -g pnpm`)
- **Docker** (optional; only needed for the Postgres/Redis-backed compose stack)

## Install and verify

```bash
pnpm install
pnpm build        # build all packages in dependency order (turbo)
pnpm typecheck    # strict tsc --noEmit across every package
pnpm lint         # eslint 9 flat config (types/shared at the repo root)
pnpm test         # vitest suites; 15 test files, all runnable offline
```

All four commands must pass before committing. They have been verified against
Node 20 in a clean sandbox (see docs/LIMITATIONS.md for what was NOT executed:
Docker).

## Environment configuration

Copy the placeholder file and adjust as needed:

```bash
cp .env.example .env
```

`apps/api` loads `.env` via dotenv at startup. **No environment variables are
required for development**: with an empty `.env` the API runs with the
in-memory event bus and no database.

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | |
| `LOG_LEVEL` | `info` | `fatal/error/warn/info/debug/trace` |
| `API_PORT` | `3001` | Fastify listen port |
| `WEB_PORT` | `3000` | compose port mapping for web |
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:3001` | used by the dashboard links |
| `DATABASE_URL` | unset | unset = no persistence, readiness reports `skipped` |
| `REDIS_URL` | unset | unset = in-memory event bus |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | sentinel / sentinel / sentinel_mesh | compose Postgres container |
| `CHAIN_ADAPTER_MODE` | `mock` | phase 0: only `mock` accepted; `readonly` reserved for a later phase |
| `POLICY_MODE` | `dry-run` | phase 0: only `dry-run` accepted |
| `EXECUTION_MODE` | `simulation` | phase 0: only `simulation` accepted; `live` fails startup |
| `MOCK_SIGNER_ADDRESS` | `0x000...000` | fixture address for the mock signer |
| `POLICY_MAX_NOTIONAL_USD_CENTS` | `50000` | per-signal notional cap ($500.00) |

The config schema is strict: unknown or invalid values fail startup with a
per-variable error message (see `packages/config`).

**Never** put private keys, seed phrases, API secrets, or any real credential
in `.env`. Phase 0 has no code path that accepts a private key, and it must
stay that way until the signing ADR is approved.

## Running in development

```bash
pnpm --filter @sentinel-mesh/api dev    # Fastify on http://localhost:3001
pnpm --filter @sentinel-mesh/web dev    # Next.js on http://localhost:3000
```

Endpoints:

```bash
curl -s localhost:3001/health
curl -s localhost:3001/health/ready
curl -s localhost:3001/api/v1/agents
curl -s -X POST localhost:3001/api/v1/tasks \
  -H 'content-type: application/json' \
  -d '{"agentId":"trend-scout","taskType":"scan-trending","input":{"chain":"base"}}'
curl -s -X POST localhost:3001/api/v1/signals \
  -H 'content-type: application/json' \
  -d '{"chain":"base","tokenIn":"0x1111111111111111111111111111111111111111","tokenOut":"0x2222222222222222222222222222222222222222","notionalUsdCents":1000}'
```

The signals endpoint returns the signal, the policy decision, and an explicit
`execution.status: "not-executed"` notice. Signals above 50% of the notional
cap come back with verdict `requires-review`; above the cap, `reject`.

## Migrations

Migrations are plain SQL files in `packages/database/migrations/NNN_name.sql`,
applied in filename order, each inside its own transaction, tracked in the
`schema_migrations` table.

```bash
# Requires DATABASE_URL (set in .env or the environment)
pnpm db:migrate          # -> pnpm --filter @sentinel-mesh/api run db:migrate
```

Without a `DATABASE_URL` the command exits 1 with a clear fatal log (in
development there is simply nothing to migrate).

## Docker Compose stack (optional)

```bash
cp .env.example .env   # if not done yet
docker compose up --build
```

This starts: Postgres 16 (healthchecked), Redis 7 (healthchecked), the API
(container applies migrations at startup, then serves on :3001), and the web
dashboard on :3000. Stop with `docker compose down` (add `-v` to drop the
Postgres volume).

**Note:** the Dockerfiles and compose file follow standard pnpm/Turborepo
patterns but were NOT executed during the phase 0 authoring (no Docker daemon
was available). Validate on first use; see docs/LIMITATIONS.md.

## Troubleshooting

- **`Invalid environment configuration` at startup** - the error lists each
  bad variable and why. Fix the `.env` value; the schema in
  `packages/config/src/index.ts` is the reference.
- **Ready check returns 503** - `DATABASE_URL` is set and the API cannot reach
  Postgres. Either start the compose stack or unset `DATABASE_URL` for
  dependency-free development.
- **Port already in use** - change `API_PORT` / `WEB_PORT`.
