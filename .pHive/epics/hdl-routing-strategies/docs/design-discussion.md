# Design Discussion — hdl-routing-strategies

## Goal

Make Heimdall's route-selection genuinely A/B-testable and reconfigurable (the north_star's `avoid` clause, previously unmet), fix `manual_override` so it actually gates routing (not just Multica actuation), and give the operator a settings UI to pick the active strategy — with each strategy compartmentalized so a new one is easy to add later.

## The operator's decision (verbatim intent, 2026-08-13)

Resolves `routing-heuristics-design-options` (the published artifact) with a broader, more concrete brief than either of its two options alone: build **three** strategies — round robin, "a heuristic" (today's priority list), and an off/pass-through mode ("turn it on and off and let something else help decide") — plus the core requirement underneath all three: "providing what is available and then being able to block the usage and direct it around." That block-and-redirect requirement is the override-gates-routing fix (research-brief.md problem 2) — it's not a fourth strategy, it's a filter every strategy sits behind. Finally: "build UI for them, the UI is simple settings" and "build each to be compartmentalized so we can extend them easily."

## Proposed approach — four stories

**Story 1 (`hdl-rs-01`) — override gates routing candidacy.** The foundational fix, independent of which strategy is active. `getAvailableRoute`'s candidate filter becomes override-aware using the exact precedence already proven in `MulticaControlAdapter`: `disabled` → never a candidate; `enabled` → always a candidate (bypasses the sensed-status check); unset → today's `status === "up"` check, unchanged. Ships alone as real, immediate value — "block the usage and direct it around" — before any strategy-selection work lands.

**Story 2 (`hdl-rs-02`) — compartmentalized `RoutingStrategy` interface + three strategies.** A shared interface:
```ts
interface RoutingStrategy {
  readonly name: string;
  selectRoute(taskType: TaskType, candidates: readonly Lane[]): Lane | null;
}
```
Three implementations, each its own file under `src/core/routing-strategies/`:
- `priority-strategy.ts` — today's `RUNTIME_PRIORITY` ranking, extracted **verbatim** (same task-type table, same tie-break by `lane_id`) — zero behavior change when active.
- `round-robin-strategy.ts` — cycles through candidates in `lane_id` order per task type; rotation state is in-memory (accepted restart-resets-rotation tradeoff, same as `AgentState`/corroboration maps elsewhere in this codebase).
- `off-strategy.ts` — always returns `null`. Not a bug, not a stub — the explicit "let something else help decide" mode: the caller falls back to `GET /lanes` (already returns full status + override + credential visibility) and picks for itself, which is exactly the pattern `test/e2e/route-selection-handshake.test.ts`'s `selectRoutableLane()` already demonstrates as a valid, supported consumer-side pattern.

A `registry.ts` exports the name → implementation map and the default name (`"priority"`) — the one seam a fourth strategy plugs into later without touching `route-selector.ts` again.

**Story 3 (`hdl-rs-03`) — global settings persistence + HTTP surface.** A new generic `settings` key-value table on `StateStore` (`getSetting`/`setSetting`) — the routing strategy is the first consumer, but the table isn't routing-specific, so a second global setting later doesn't need its own bespoke table. `getAvailableRoute` reads the active strategy name from settings (defaulting to `"priority"` when unset — byte-identical to pre-this-epic behavior for every existing caller who never touches the new endpoint). `GET /routing-strategy` (current + the list of valid names) and `POST /routing-strategy` (`{strategy: name}`, 400 on an unknown name) follow the exact discriminated-result-then-translate-to-status-code shape `hdl-mcp-01` established.

**Story 4 (`hdl-rs-04`) — dashboard settings UI.** A new "Routing" panel (same visual/structural pattern as the existing "Add lane" panel) showing the active strategy and a control to change it among the three registered names, calling story 3's endpoint.

## Non-goals (this epic)

- **MCP tools for strategy selection.** The operator's ask this cycle was explicitly UI-focused ("build UI for them"); `heimdall.routing.setStrategy` is a small, natural follow-up once this ships, not bundled in now to keep this epic's scope matched to what was actually asked.
- **Per-task-type strategy selection.** One global active strategy, not one per task type — "simple settings," per the operator's own framing; a per-task-type control is a straightforward future extension of the same settings table if ever wanted.
- **REQ-00 (per-provider signal inventory spike).** Flagged as a separate, still-open item in the prior cycle's check-in; not part of this epic, which is entirely about the decision layer downstream of sensing, not sensing itself.

## Scale assessment

**Medium.** Four stories across three layers (routing logic, state persistence, HTTP, UI) — comparable in shape to `hdl-lane-management`. Every story reuses a pattern already proven in this exact codebase (override-wins-outright precedence, discriminated-result shared functions, settings-panel UI structure) — no new architectural decision beyond the `RoutingStrategy` interface itself, which is fully specified above. Proceeding directly to stories.

## Risks

- **Regressing the existing `/available-route` tests.** Mitigated by extracting `PriorityStrategy` verbatim (same table, same tie-break) and keeping it the default — the acceptance gate for story 2 is that every existing `http-server.test.ts` `/available-route` assertion passes unmodified.
- **Round-robin's in-memory rotation state resets on restart.** Explicitly accepted, matching this codebase's existing precedent for exactly this class of tradeoff (documented, not silently accepted).

## Dependencies

Builds on `manual_override` (`hdl-lane-override`) and the discriminated-result/shared-function pattern (`hdl-mcp-lane-tools`).

## Open questions

None — the operator's message resolved every open question from the prior cycle's artifact, with more specificity than either single option alone.
