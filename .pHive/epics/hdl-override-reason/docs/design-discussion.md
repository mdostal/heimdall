# Design Discussion — hdl-override-reason

## 0. How this came up

Operator, reviewing the three independent UI-redesign mockups (`hdl-desktop-app`
UI/icon pass): *"we need the override toggle with an optional description
to get added for why."* Both the Mission Control and Terminal mockups
independently rendered an override+reason pattern from the same sample data
this session supplied in the design brief ("kimi... disabled by operator...
'cost review in progress'") — that sample data wasn't itself a real feature
until this request made it one.

## 1. Shape

Mirrors the existing `manual_override`/`manual_reset_at` column pair on
`lanes` exactly — same nullable-column, same paired get/set accessor
pattern, same "guard row existence" insert-then-update shape. No new
concepts introduced.

One deliberate defensive rule: `setManualOverride(laneId, value, reason)`
forces `reason` to `null` whenever `value` is `null` (clearing back to
"auto"), regardless of what the caller passed. A reason with no active
override is meaningless leftover text — without this, re-overriding a lane
later could resurrect a stale reason from a previous, unrelated override
the operator never meant to reuse.

## 2. Real bug found during live verification

The dashboard's new reason display used `class="reason"` — already used by
two unrelated existing elements: the lane table's status-reason `<td>`
(line 364) and the routing-policy panel's experiment-status caption (both
from `hdl-routing-policy-dashboard`). Not a visual bug (all three want the
same muted-grey caption style, so sharing the base class is intentional),
but it made `document.querySelector('.reason')` return the wrong element
during Playwright verification — confirmed by testing scoped to the lanes
`#root` container specifically rather than trusting the first unscoped
match. Fixed by adding a second, more specific class
(`override-reason-note`) alongside the shared one, rather than renaming the
shared class (which several other elements still legitimately want).
