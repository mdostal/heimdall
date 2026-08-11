# Routing Dispatch Handoff - Vertical Plan

## Slice goal

Make Heimdall's existing route selector safe for a real orchestrator call:
request in, dispatch-ready route out, outcome reported back.

## Vertical sequence

1. **Lane metadata and headroom.**
   Replace the hardcoded route health inputs with lane-declared headroom and
   cost metadata, while keeping missing metadata safe and explicit.

2. **Dispatch-ready route contract.**
   Extend the route result returned by HTTP, CLI, and MCP so Auriga/Minerva can
   dispatch without doing another lookup or exposing credentials.

3. **Outcome feedback.**
   Expose RouteLedger outcome reporting over the same supported surfaces, with
   metadata sanitization and unknown-decision handling.

4. **Live handoff smoke.**
   Add a repeatable runbook/harness that declares at least three lanes, asks for
   planning/build/review routes, reports one outcome, and records the expected
   operator verification steps.

## Non-goals

- No new provider health adapters in this slice.
- No automatic mutation of Multica issue assignment from inside Heimdall.
- No raw token/secret exposure in route responses or ledger rows.
- No replacement of the current scoring algorithm unless tests prove the new
  metadata cannot fit the existing policy model.
