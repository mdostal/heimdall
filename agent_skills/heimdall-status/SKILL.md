---
name: heimdall-status
description: Quick, read-only orientation on the state of your Heimdall fleet — which lanes are up/down and which routing strategy is active — in two tool calls, no mutation. Use as the first thing to check when the user asks "what's going on with Heimdall" or "give me the current state" before reaching for the more detailed heimdall-lanes/heimdall-routing/heimdall-models skills.
---

# Heimdall Status

A quick-orientation skill, not a full reference — it exists so "what's the state of my fleet"
has a two-call answer instead of making you reach for heimdall-lanes' full read/write surface.
Both tools below are read-only; neither mutates anything.

## Step 1 — `heimdall.lanes.list`

No parameters.

```json
{ "tool": "heimdall.lanes.list", "arguments": {} }
```

Gives you, per declared lane: `lane_id`, `provider`, `model`, `status`
(`up`/`down`/`out_of_credit`/`degraded`), and whether it's been manually overridden
(`manual_override`, `override_reason`). This alone answers "is anything down right now."

## Step 2 — `heimdall.routingStrategy.get`

No parameters.

```json
{ "tool": "heimdall.routingStrategy.get", "arguments": {} }
```

```json
{ "active": "priority", "available": ["priority", "round-robin", "scored", "off"] }
```

Tells you which single global strategy is currently routing tasks across lanes — useful context
for interpreting why a particular lane was or wasn't picked.

## What this skill deliberately doesn't cover

- Changing anything (overriding a lane, setting a reset timer, adding a lane, switching
  strategy, enabling/disabling a model) — use the **heimdall-lanes**, **heimdall-routing**, or
  **heimdall-models** skills for those, which document the full read/write tool surface with
  parameters and examples.
- Getting a routing recommendation for a specific task, or reporting an outcome back — that's
  `route_selection` / `heimdall.route.reportOutcome`, covered in **heimdall-routing**.

If the two calls above raise a follow-up question ("why is this lane down," "how do I bring it
back," "what models does it have"), hand off to the relevant deeper skill rather than trying to
answer it from `heimdall.lanes.list` alone.
