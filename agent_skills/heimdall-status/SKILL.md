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

Each lane also has `limits`: the account's separate limits Heimdall has observed (`five_hour`,
`weekly_all_models`, `weekly_model:<model id>`, `credits`, `spend_cap`), each with `state`
(`exhausted`/`available`/`unknown`), `used_percent` and `resets_at`. Report them: a lane can be
`up` with one model's limit exhausted (e.g. `weekly_model:claude-fable-5-2` exhausted while Opus
still works). `used_percent` or `resets_at` of `null` means the provider did not say. Report it
as unknown and never estimate it.

## Limits, models, mode and swaps in one call — `heimdall.status`

When the question is about limits or models ("is Fable out", "why did it swap to Opus", "when
does it reset"), call `heimdall.status` instead of piecing it together:

```json
{ "tool": "heimdall.status", "arguments": { "swaps": 10 } }
```

Per account lane it returns `limits` (type, `state`, `used_percent`, `resets_at`), `models`
(`enabled`, `available`, `level`), `mode` (max usage on/off with `until`) and `current_swap`, plus
`last_swaps` and `alerts.open`. Values of `"unknown"` mean the provider did not report them: say
so, never estimate. Each open alert lists its `choices` (swap now, wait until the reset, human
reset, credits); relay them to the operator as they are, and don't act on one yourself.

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
