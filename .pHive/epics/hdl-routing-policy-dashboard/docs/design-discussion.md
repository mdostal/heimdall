# Design Discussion — hdl-routing-policy-dashboard

## 0. Prelude

No operator decision needed here — `docs/vision.md` already named this
explicitly under both "Goals" (*"the dashboard has no view into it"*) and
"Good first contributions" (*"A `config/routing-policy.yaml` dashboard panel
(read-only view first)"*), with the read-only-first scope already decided.
Picked up as part of the same autonomous loop pass that shipped
`hdl-desktop-app`, after a backlog scan found no open GitHub issues and only
two items that genuinely need operator input (headroom/cost-tier
auto-inference, further probe-cadence backoff) — this one had neither open
question.

## 1. Shape

`PolicyLoader.load()` already exists, is already fully validated (task-type
weights, headroom floor, cost preference, experiment arms — all schema-
checked with real error messages), and is already the scored strategy's own
source of truth. No new validation or parsing logic needed — `GET
/routing-policy` just calls it and returns the JSON, loaded fresh on every
request (never cached) so a hand-edit to the YAML file is reflected
immediately without a restart, matching how the scored strategy itself
re-reads it. A `PolicyValidationError` (malformed YAML, missing field) maps
to `503 { error: "policy_unavailable", message }` rather than crashing the
server — the dashboard is a read-only viewer, not the thing that should
determine whether routing itself can still function.

The dashboard panel follows the exact same pattern as the existing
Telemetry and Model catalog panels: a summary surface loaded once on page
load (not part of the 5s poll loop, since the policy file changes by hand-
edit, not automatically), rendered client-side with no new dependency.

## 2. Verification

Live-verified against a real running dev server, not just the test suite:
`curl /routing-policy` against the real `config/routing-policy.yaml`
returns the correct shape, and a real Playwright browser check confirms
`#routing-policy-root` renders the actual weights table, headroom floor,
cost preference, and experiment status correctly in the DOM (full-page
screenshot capture timed out in this sandboxed browser environment for
unrelated reasons — font-loading wait — so verification used
`page.evaluate()` to read the rendered `innerHTML` directly instead).
