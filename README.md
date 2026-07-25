# Heimdall

Pantheon's health-aware LLM/lane router. See [`docs/north-star.md`](docs/north-star.md)
for the product vision and [`.pHive/planning/`](.pHive/planning/) for the v1 (P0)
product brief, PRD, and architecture.

v1 scope is **health/status detection only** — Heimdall reports whether a lane
(provider × account × runtime) is up, down, out of credit, or degraded. It does
not choose which lane to route work to; that's explicitly out of scope until a
later epic (see `.pHive/planning/product-brief.md`).

## Setup

```bash
npm install
```

Requires Node.js >= 22.5.0 (uses the built-in `node:sqlite` module, currently
experimental — the `dev`/`test` scripts pass `--experimental-sqlite`).

## Credentials

Heimdall reads lane credentials from local environment variables — a
stopgap ahead of Portunus (see `.pHive/planning/product-brief.md` P2). Copy
`.env.example` to `.env` and fill in real tokens:

```bash
cp .env.example .env
```

Lanes are declared as contiguous `HEIMDALL_LANE_<N>_{ID,PROVIDER,CREDENTIAL_REF}`
triples starting at `1`; `CREDENTIAL_REF` names another env var holding the
actual secret. A lane with a missing or empty credential is still reported by
`GET /lanes` — as `down` with an `unconfigured` reason — rather than crashing
the service or silently disappearing.

**Never commit `.env`** — it's gitignored; only `.env.example` (with empty
secret values) is tracked.

## Run the dev server

```bash
npm run dev
```

Starts the HTTP server on `http://localhost:4870` (override with `PORT=<n>`).
`GET /lanes` now reads real lane declarations + a SQLite state store (override
the DB path with `HEIMDALL_DB_PATH`, default in-memory) — see
[`.pHive/epics/lane-health-status/docs/vertical-plan.md`](.pHive/epics/lane-health-status/docs/vertical-plan.md)
Slice 2. Status values are still placeholders (`down`/`unconfigured` for every
lane) until real signal detection lands (lhs-03f).

## Test

```bash
npm test
```

Runs the Node.js built-in test runner (via `tsx`) against `src/**/*.test.ts`.

## Build

```bash
npm run build
```

Type-checks and compiles `src/` to `dist/` per `tsconfig.json`.
