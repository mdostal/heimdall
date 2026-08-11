# Heimdall Dev Assessment - 2026-08-11

## Delivered on dev

- P0 sensing is present: lane declarations, credential loading, SQLite state,
  Claude/Codex public status and active probe adapters, passive observation,
  status resolution, and the 10-second SLA harness are all implemented.
- Scheduler and actuation layers are present: per-lane scheduler interfaces,
  Multica autopilot registration, suspect-lane in-process polling,
  MulticaRestClient, CircuitBreaker, LaneAgentResolver, StubControlAdapter,
  MulticaControlAdapter, and Argus actuation/tick/status telemetry.
- Routing primitives are present: policy loading from `config/routing-policy.yaml`,
  weighted candidate scoring, deterministic experiment assignment, rationale
  generation, RouteLedger decision/outcome tables, `RouteSelector.select()`,
  `POST /route`, CLI `route`, and MCP `route_selection`.
- Verification baseline on dev passed locally after `npm ci`:
  `npm test` passed 262 tests and `npm run build` completed.

## Recovered slice-1 vision

Slice 1 moved Heimdall from "health gateway only" into advisory routing. The
route-selection path can already pick a healthy lane for `planning`, `build`, or
`review`, record the decision, and expose it over HTTP, CLI, and MCP.

The remaining gap is handoff quality. Today `getLaneHealths()` still supplies
stubbed headroom and cost (`10000` and `medium`), and the route result names a
lane but does not yet return the complete dispatch handle an orchestrator can
use safely. Route outcomes are modeled in the ledger, but no public surface lets
callers report success, failure, latency, or actual cost back to Heimdall.

## Slice-2 boundary

This slice should not redo sensing, actuation, scoring, or transport plumbing.
It should make the existing router operationally useful:

- derive route inputs from declared lane metadata and recent state;
- return a stable dispatch contract with credential references, not secrets;
- accept outcome feedback into the ledger;
- prove the full handoff with a local smoke that mirrors Auriga/Minerva usage.
