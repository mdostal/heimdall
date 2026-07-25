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

Requires Node.js >= 20.

## Run the dev server

```bash
npm run dev
```

Starts the HTTP server on `http://localhost:4870` (override with `PORT=<n>`).
Currently serves `GET /lanes` from a hardcoded fixture — see
[`.pHive/epics/lane-health-status/docs/vertical-plan.md`](.pHive/epics/lane-health-status/docs/vertical-plan.md)
Slice 1. Real credential loading and signal detection land in later stories.

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
