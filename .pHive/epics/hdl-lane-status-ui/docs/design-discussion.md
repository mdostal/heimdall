# Design Discussion — hdl-lane-status-ui

## Goal

Ship the first vertical slice of Heimdall's standalone-mode UI requirement (`has_ui: true`): a **read-only live lane-status view**, reachable at `GET /` on the existing HTTP server. This is the thinnest real proof of concept — it proves the UI surface exists and works, before layering on write operations (manual disable/enable, add-lane) and the MCP agent-tooling surface in follow-up epics.

## Why this slice first

Per the operator's original framing (2026-08-12): standalone mode needs "settings, interact, see the liveliness, add new lanes." Liveliness/visibility is the lowest-risk, highest-immediate-value slice — it requires no new write paths through `ControlAdapter`, no new validation logic for lane declarations, and directly reuses the existing `GET /lanes` data model unchanged. Write operations (disable/enable/add-lane) touch state mutation and deserve their own design pass (e.g., should "add a lane" persist to `.env` or a new config store? `.env`-editing from a running process is a real design question, not a given) — scoping them into this same epic would blur a clean, fast, low-risk slice with a genuinely open design question.

## Non-goals (this epic)

- **Manual lane disable/enable** — deferred. Per `DEC-hdl-reason-aware-recovery.md` item 3, this must flow through the existing `ControlAdapter` path, not a new code path — that wiring is real design/implementation work for a follow-up epic.
- **Add new lanes via the UI** — deferred. Lanes are currently declared via `.env` (`HEIMDALL_LANE_<N>_*`), loaded once at process start by `loadLaneDeclarations`. Adding a lane at runtime raises a real question (persist where? hot-reload how?) that deserves its own design discussion, not a decision made inside this slice.
- **MCP agent-tooling surface** — deferred. `src/api/mcp-server.ts` currently exposes one tool (`heimdall.lanes.list`); extending it with disable/enable/add-lane tools is natural future work once the underlying write operations exist (can't expose an MCP tool for an operation that doesn't have a real implementation yet).
- **Visual polish / branding** — out of scope for a single-operator internal tool. Plain, functional, legible. No design-system work.

## Proposed approach

Add `GET /` to the existing `node:http` router in `src/api/http-server.ts`, returning a single self-contained HTML document (inline `<style>` + `<script>`, no external requests except to Heimdall's own `/lanes` endpoint, no build step, no new npm dependency). The page's JS does `fetch('/lanes')` on load and on a short interval (e.g. every 5s, matching `InProcessScheduler`'s suspect-lane cadence — no need to poll faster than the backend itself refreshes), and renders one row per lane: `lane_id`, `provider`, a color-coded `status` badge, `reason`, a human-formatted `reset_at` (or blank), `last_updated`, `signal_source`. This is a pure read/render layer — zero new backend logic, since `GET /lanes` already returns exactly this data (verified in the 2026-08-12 standalone smoke test).

Keep the HTML/CSS/JS in a separate small module (`src/api/ui/dashboard.ts`, exporting a `DASHBOARD_HTML` constant or a `renderDashboardHtml()` function) rather than inlining a large string literal into `http-server.ts` — keeps the router file scannable, matches the existing one-concern-per-file layout (`route-selector.ts`, `status-model.ts`, etc. are each single-purpose).

## Scale assessment

**Small.** One new route in an existing router file, one new small module (a static HTML/CSS/JS string, no logic beyond string templating), one new test file section. No new dependencies, no build step, no architectural decision beyond "where does the HTML string live" (settled above). Proceeding directly to stories.

## Risks

- **Polling `GET /lanes` every 5s from a browser tab is trivially cheap** (local SQLite read, no external calls) — not a real risk, noting only because "polling" can sound expensive; it isn't at this scale (1 operator, 1 browser tab, a handful of lanes).
- **A malformed/missing `reset_at`** (null is the common case for `up`/unconfigured lanes) must render as blank, not `Invalid Date` or similar — explicit acceptance criterion below.

## Dependencies

None outside this repo. Builds on `GET /lanes` (lane-health-status epic, already shipped) and the `reason`/`reset_at` fields (already correct end-to-end per `hdl-reason-aware-recovery`, just merged).

## Open questions

None blocking for this slice — the deferred items above are the explicitly out-of-scope follow-ups, not gaps in this epic's own scope.
