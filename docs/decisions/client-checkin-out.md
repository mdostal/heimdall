# Decision: Client Check-ins - Out of Hive

**Path:** client-checkin
**Verdict:** OUT OF HIVE
**Date:** 2026-07-27
**Consus ID:** Pending `consus-integration`

## Context

Client weekly check-ins are recurring, real-time conversations for relationship
management, status review, expectation setting, and surfacing follow-up work.
They often include live clarification, interpersonal context, shifting agenda
items, and decisions that are better captured after the meeting than planned as
an SDLC story up front.

Hive is the structured SDLC surface: kickoff, plan, execute, review, test, and
ship. A client check-in is not itself a durable implementation artifact and does
not benefit from forcing the meeting through that pipeline.

## Verdict

Route client check-ins **OUT OF HIVE**.

Use interactive chat, meeting notes, or the operator's live meeting workflow for
the check-in itself. After the check-in, route any concrete implementation work
that emerges through Hive as normal core development.

## Rationale

Client check-ins are real-time and conversational. They require live listening,
agenda adjustment, and human judgment while the conversation is happening. Hive's
strength is decomposing durable work into planned, reviewable artifacts; it is
not a meeting copilot or relationship-management surface.

Forcing a check-in through Hive would add ceremony before the work is known. The
right boundary is to keep the meeting outside Hive, then promote only the
post-meeting outputs that have become concrete deliverables.

## Alternative Surface

Use interactive chat as the default support surface for client check-ins:

- Prepare agenda notes or a brief pre-read.
- Capture live notes, questions, risks, and decisions during the meeting.
- Convert follow-up implementation items into discrete Hive-ready issues after
  the meeting.

## Guardrails

- If the request is "join or run a weekly client check-in," it stays out of Hive.
- If the request is "summarize notes from the check-in," it stays out of Hive
  unless the summary is product documentation that must be shipped and reviewed.
- If the request is "implement the feature the client approved during the
  check-in," that follow-up is core development and should enter Hive.
- If the check-in uncovers a bug, feature, refactor, or test gap, create a
  focused Hive story for that deliverable rather than routing the meeting itself.

## Examples

1. A client weekly sync needs agenda prep, live note-taking, and a follow-up
   summary. Verdict: OUT OF HIVE. Use interactive chat or meeting workflow; turn
   any action items into separate issues afterward.
2. During a check-in, the client approves adding invoice export to the product.
   Verdict: the meeting remains OUT OF HIVE; the invoice-export feature becomes a
   new core-development item that routes IN HIVE.

## References

- Synthesis doc: [SDLC Boundary](../sdlc-boundary.md)
- Parent issue: PAN-6446, Hive-vs-non-hive boundary deep-dive
- Story: PAN-6457, checkin-decision
- Consus record: pending `consus-integration`

## Tags

`sdlc-boundary`, `routing`, `client-checkin`, `meeting`, `meta`
