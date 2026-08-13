# Design Discussion — hdl-lane-management

## Goal

A lanes-management surface: add a new lane, see its current config (including whether its token resolved, never the token itself), turn it on/off (already shipped), see and manually adjust its expected recovery time, all alongside the existing live-status dashboard. Closes out the has_ui: true standalone requirement's remaining scope beyond MCP agent-tooling.

## The operator's decision (verbatim intent, 2026-08-13)

Resolves the open question from `add-lane-design-options` (published as a Claude Artifact, three options presented): a mix, but the persistence direction is clear — **local, not-committed `.env`, for now**; Portunus (the future secrets service) is explicitly the thing that "fixes that" later, not this epic. That settles Option 1 vs. Option 2 from the artifact: `.env`-based (Option 1's direction), not a second runtime secret store (Option 2). The scope is broader than the artifact's narrow "add a lane" framing, though — explicitly requested: setup/define/add lanes, on/off (shipped), see reset time, **change** reset time, and visibility into "current environments, tokens etc."

## Proposed approach — four stories

**Story 1 (`hdl-lm-01`) — `.env` auto-load fix + add-lane backend.**
Fixes the standing gap (`.env` never auto-loaded — Node's `--env-file` flag, zero new dependency, confirmed working against this repo's Node version) so add-lane's "write then restart" flow actually works end-to-end. `src/core/env-file.ts` parses `.env` for the next available `HEIMDALL_LANE_<N>_*` index and appends a new lane's block (id/provider/model/credential_ref + the secret line) safely — never duplicates an index, never touches existing lines. `POST /lanes` validates the input (lane_id not already declared, provider/model non-empty, token non-empty), derives `credential_ref` from `lane_id` (uppercase, non-alphanumerics → `_`, collapsed, `_TOKEN` suffix — e.g. `gemini@ops` → `GEMINI_OPS_TOKEN`), writes the file, and responds with `{lane_id, credential_ref, restart_required: true, restart_command: "npm run dev"}` — no automatic process restart (that would need a process supervisor this standalone setup doesn't have; per the design-options artifact, automating it is exactly what turns "add a lane" into "the service went down").

**Story 2 (`hdl-lm-02`) — token/config visibility, never the secret.**
`GET /lanes` gains `credential_configured: boolean` per lane (derived from whether `Lane.credential` resolved — the existing `LaneRegistry`/`EnvCredentialSource` machinery already knows this; nothing new to compute, just to expose). The raw secret is never serialized anywhere — same invariant this codebase has held since REQ-07.

**Story 3 (`hdl-lm-03`) — manual `reset_at` ("change the times").**
Follows `hdl-lane-override`'s exact shape: a `manual_reset_at` column on `StateStore`'s `lanes` table (same defensive-migration pattern), `POST /lanes/:laneId/reset-at` (body `{reset_at: "<ISO-8601>" | null}`, `null` clears it), surfaced on `GET /lanes`. `InProcessScheduler`'s already-shipped (`hdl-reason-aware-recovery`) reset_at-aware delay computation prefers `manual_reset_at` over the sensed `reset_at` when set — an operator who knows a lane resets at a specific time (a weekly plan-reset the automatic probes can't see, say) can tell Heimdall directly, and the scheduler backs off accordingly. Deliberately scoped to scheduling only — does not touch `ReconcileContext`/`ControlAdapter`/Argus, keeping this story's blast radius separate from the override work.

**Story 4 (`hdl-lm-04`) — dashboard: the lanes-management UI.**
Depends on 1–3. Extends the dashboard with: an "Add lane" form (calls `POST /lanes`, shows a restart-required banner with the exact command on success); a token-configured indicator per row (a small chip, distinct from the status badge and the override badge); an editable reset-at control (native `<input type="datetime-local">` + save, calls `POST /lanes/:laneId/reset-at`) alongside the existing read-only reset_at display.

## Non-goals (this epic)

- **Automatic process restart.** Explicitly rejected in the design-options artifact's Option 1 tradeoffs, and the operator's response didn't ask for it — a supervised auto-restart is real future work if wanted, not assumed here.
- **Portunus integration.** Explicitly deferred by the operator — "Portunus' job is to fix that soon." This epic's `.env` handling stays exactly consistent with the existing REQ-07 stopgap pattern, not a preview of what Portunus will replace it with.
- **Remove-lane / edit-existing-lane's provider or model.** Not requested; add + on/off + reset_at editing is the full ask this cycle.
- **MCP agent-tooling for any of this.** Tracked separately, next in the loop's queue, and doesn't depend on this epic's UI stories (it wraps the same HTTP endpoints either way).

## Scale assessment

**Medium.** Four files touched across three layers (a new small utility module, state storage, scheduler, HTTP routes) plus a UI story — more surface than the prior three (Small-scope) epics, but each story is well-isolated and follows a pattern already proven in this exact codebase (the override work). Proceeding directly to stories rather than a full H/V planning pass — the operator has already resolved the one genuinely open design question, and every remaining decision below is a direct application of an existing pattern, not a new one.

## Risks

- **Concurrent `.env` writes** (two add-lane requests racing, or a human hand-editing `.env` at the same moment) — out of scope for a local single-operator tool to fully solve; the file-append implementation should at least not corrupt the file on a single writer, which is the realistic case here.
- **A malformed manual `reset_at`** (invalid ISO-8601, or a value in the past) should be rejected at the API boundary (400), not silently accepted and left to confuse the scheduler.

## Dependencies

Builds on `hdl-lane-override` (the override pattern this epic's `reset_at` story mirrors) and `hdl-reason-aware-recovery` (the scheduler's reset_at-aware delay computation, which this epic feeds a manual value into without modifying its own logic).

## Open questions

None blocking — the operator's message resolved the one open question from the design-options artifact.
