# Design Discussion — hdl-routing-reconciliation

## 0. Prelude

Reconciles `origin/main` (this session's 13-epic sequence, mistakenly branched off
main instead of dev) with `origin/dev` (a separately-shipped advisory routing layer —
scorer, ledger, A/B experiment arms, account rotation — built via PAN-ticket PRs,
never merged forward). This epic runs **on `dev`**, not main, per the project's actual
branch convention (feature → dev → main-for-release), corrected by the operator
2026-08-13.

The routing-philosophy decision (main's pluggable strategies vs. dev's scorer as
canonical) was already made by the operator via a Claude Artifact — Option B: main's
`routing-strategies/` interface stays canonical, refactored to be genuinely pluggable,
with dev's scorer ported in as a new strategy ("scored") implementing that interface.
This document covers the interface shape itself, which the operator left to
implementation judgment.

## 1. Goal

One coherent `dev` branch carrying: every capability from both branches (nothing
silently dropped), a `routing-strategies/` interface a future strategy can implement
without another structural refactor, and the scored strategy + rotation-controller
wired in as real, working capabilities rather than ported-but-inert files.

## 2. The interface

**Problem:** dev's `RouteSelector.select()` needs `StateStore` access (to write the
ledger) and returns a rich result (rationale, decision id, experiment arm, ranked
candidates) that priority/round-robin/off have no use for and shouldn't be forced to
produce. The interface needs to carry that without every existing strategy's signature
changing meaning.

**Shape:**

```ts
interface RouteSelectionContext {
  taskType: TaskType;
  candidates: readonly Lane[];   // already override/status-gated by route-selector.ts, unchanged
  store: StateStore;             // available to every strategy; only scored uses it today
}

interface RouteSelectionResult {
  lane: Lane | null;
  detail?: {                     // absent for priority/round-robin/off; present for scored
    rationale?: string;
    decisionId?: string;
    experimentArm?: string;
    rankedCandidates?: Array<{ laneId: string; score: number }>;
    policyVersion?: string;
  };
}

interface RoutingStrategy {
  readonly name: string;
  selectRoute(ctx: RouteSelectionContext): RouteSelectionResult;
}
```

`priority-strategy.ts`/`round-robin-strategy.ts`/`off-strategy.ts` change signature
only — same logic, same output lane, `detail` always omitted. Zero behavior change,
proven by the existing test suite passing unmodified (this repo's established
zero-test-change gate).

`getAvailableRoute()` (main's version, already the correct base per research) changes
its return shape additively: `AvailableRoute` gains optional `rationale`/`decision_id`/
`experiment_arm`/`ranked_candidates` fields, populated only when the active strategy's
`detail` is present. The one existing exact-shape `deepEqual` test in
`http-server.test.ts` (already updated once before, for `model_substituted`) gets the
same kind of additive update — new optional fields, not a breaking change.

**Why not thread `Policy`/`RouteLedger` through the context instead of bare `store`:**
keeps the interface generic — a future strategy that needs different persistence
doesn't force another context-shape change. `store: StateStore` is already the
one shared persistence handle every part of this codebase uses; the scored strategy
constructs its own `PolicyLoader`/`RouteLedger` internally (same pattern dev already
used 3× at each call site — this time built once, inside the strategy, not
re-duplicated per HTTP/CLI/MCP surface).

## 3. Backward compatibility: `POST /route`, CLI `route`, MCP `route_selection`

Dev's `dev-assessment.md` names Auriga/Minerva as real consumers of `POST /route`'s
existing `RouteResult` shape. These stay as thin wrappers that force `strategy=scored`
for that one call (regardless of the globally active strategy — a caller hitting
`POST /route` is explicitly asking for the scored contract) and reshape
`RouteSelectionResult.detail` into dev's existing `RouteResult` response body. CLI
`route` and MCP `route_selection` become the "two thin transport wrappers around one
shared function" this repo's every prior epic already established, replacing the
copy-pasted 3× construction dev had.

## 4. Rotation-controller scope

`rotation-controller.ts` + `error-parser.ts` port forward unchanged (zero schema
needs, confirmed). Scope for *this* epic: instantiate `RotationController` in
`composeService()` for any provider with ≥2 credentialed lanes (mirrors
`hdl-actuation`'s "every lane always gets a ControlAdapter" precedent — never a silent
no-op), wire `startCapResetRecoveryJob`, and expose read/action surface
(`GET /rotation/:provider`, `POST /rotation/:provider/rotate`) mirroring existing
override-endpoint shape. **Explicitly out of scope**: wrapping the live Claude
completion call itself through `.request()` — that's a deeper change to the Claude
active-probe/signal-source call path and deserves its own epic once this reconciliation
ships. Documented as a known gap, not silently dropped, matching this repo's existing
practice (e.g. the Claude subscription-lane probe-frequency gap).

`token-registry.ts` is **not** ported — confirmed orphaned (unwired on dev, nothing
imports it outside its own test), and conceptually superseded by the credential_ref/
lane-registry model already shipped. Explicitly recorded as a deliberate drop, not an
oversight.

## 5. Merge mechanics

`git merge origin/main` into this epic's branch (already based on `dev`) brings every
additive dev-only and main-only file across for free — only the 12 conflicted files
need hand resolution:
- `package.json`/`package-lock.json`: keep main's `0.19.0` version line, union deps
  (add dev's `yaml`), union test globs (keep `hive/**/*.test.ts`), regenerate the lock
  via `npm install`.
- `.gitignore`: union both epic-allowlist blocks.
- `README.md`: authored merge — dev's OSS/gateway framing + main's current-state
  capability list.
- `src/core/lane-registry.ts`, `src/core/state-store.ts`, `src/api/http-server.ts`,
  `src/api/mcp-server.ts`, `src/main.ts`, `src/core/route-selector.ts`: take main's
  version as the merge-commit resolution (each confirmed a superset or the correct
  base per §2 above); dev's additive routing/rotation capability layers on top in
  follow-up stories, not as part of conflict resolution.
- `test/sla-harness/report.md`: generated artifact — take main's, regenerate if stale.

## 6. Scale assessment

**Large.** 12 conflicted files, a genuine interface redesign, two independently-tested
subsystems being merged, plus new integration work for rotation-controller. Proceeding
to story decomposition directly (this repo's planning ceremony for prior large-ish
epics — e.g. `hdl-openrouter-signals`, `hdl-model-catalog` — used research brief +
design discussion + direct story decomposition without a separate H/V/structured-outline
pass; same weight applied here, scaled to the actual team size of one).
