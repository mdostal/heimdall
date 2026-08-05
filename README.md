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
triples starting at `1`, with optional `HEIMDALL_LANE_<N>_MODEL` for advisory
routing; `CREDENTIAL_REF` names another env var holding the actual secret. A lane
with a missing or empty credential is still reported by `GET /lanes` — as `down`
with an `unconfigured` reason — rather than crashing the service or silently
disappearing.

**Never commit `.env`** — it's gitignored; only `.env.example` (with empty
secret values) is tracked.

## Run the real service

```bash
npm run dev
```

Runs `src/main.ts` — the full composed service: lane registry + SQLite state
store + Argus OTEL telemetry + a per-lane `MulticaAutopilotScheduler` (coarse
cron, default) and `InProcessScheduler` (fine ~5s, suspect-lane only) + the
HTTP server on `http://localhost:4870` (override with `PORT=<n>`). See
[`docs/decisions/DEC-hdl-scheduler-backend.md`](docs/decisions/DEC-hdl-scheduler-backend.md)
for the scheduler design and the `multica-native-no-box-runners` HARD LAW it
satisfies. Requires `MULTICA_AUTOPILOT_AGENT` to be set (see `.env.example`)
for the Multica backend to register cron triggers; missing it fails that
lane's coarse scheduling clearly without crashing the rest of the service.

`GET /lanes` reads the SQLite state store (override the DB path with
`HEIMDALL_DB_PATH`, default in-memory), reflecting whatever the Claude/Codex
signal pipeline (`src/core/lane-pipeline.ts`) last persisted. `POST
/lanes/:laneId/refresh` triggers a real refresh on demand — this is the
endpoint Multica's dispatched agent calls when a lane's autopilot fires. To
run just the HTTP server without any scheduling (e.g. for isolated debugging),
use `npm run dev:http-only` instead — see
[`.pHive/epics/lane-health-status/docs/vertical-plan.md`](.pHive/epics/lane-health-status/docs/vertical-plan.md).

`GET /available-route?task-type=planning|build|review` returns one usable
advisory route backed by the same lane state. It only chooses lanes with an `up`
status and a resolved credential, and returns the credential reference handle
(`token-ref`) rather than the secret.

## Query lane status — CLI

```bash
npm run cli                    # JSON output (default)
npm run cli -- --format table  # human-readable table
```

Reads the same lane declarations + state store as the HTTP server and calls
the identical `getLaneStatuses()` core function — no separate query logic.

## Query lane status — MCP

```bash
npm run mcp
```

Runs an MCP server over stdio exposing one tool, `heimdall.lanes.list`, that
returns the same data as `GET /lanes` and the CLI. Register it with any
MCP-capable client (e.g. Claude Code) by pointing at `npm run mcp` (or the
compiled `dist/api/mcp-server.js` after `npm run build`) as the server
command. All three surfaces — HTTP, CLI, MCP — are synchronous
request/response per the `LaneRouterContract` (see
`.pHive/planning/architecture.md`): a query always returns the answer
directly, never "subscribe and wait."

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
