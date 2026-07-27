# Decision: Cost-Benefit Analysis - Out of Hive

**Path:** cost-benefit-analysis
**Verdict:** OUT OF HIVE
**Date:** 2026-07-27
**Consus ID:** pending (`sdlc-boundary-cba-001`)

## Context

Pantheon operators need a repeatable rule for cost-benefit analysis (CBA)
requests. CBAs compare options, costs, risks, trade-offs, opportunity cost, or
business value. They may inform later development work, but the CBA itself does
not produce code, tests, deployment artifacts, or a shippable technical change.

Without a written boundary, CBA requests can be over-routed into the Hive SDLC,
where the ceremony is optimized for durable software delivery rather than
business analysis.

## Verdict

Cost-benefit analysis work routes **OUT OF HIVE**.

Use the business-run tool or equivalent business-analysis workflow instead of
opening a Hive execution story.

## Rationale

CBAs are decision-support work, not software-delivery work. They usually produce
a recommendation, option comparison, budget judgment, priority trade-off, or
go/no-go conclusion. That output is valuable, but it does not need the full Hive
cycle of kickoff, plan, execute, review, test, and ship.

Routing CBAs through Hive creates unnecessary process weight and blurs the
boundary between product/business judgment and implementation. Hive should
consume CBA outcomes when they become requirements, constraints, or approved
work, but it should not be the default system for producing the analysis itself.

## Alternative Surface

Use a business-run tool for:

- Option comparison and recommendation memos
- Budget, ROI, cost, or opportunity-cost analysis
- Vendor/tool/platform evaluation before a build decision
- Prioritization trade-offs across multiple possible initiatives
- Go/no-go analysis for a project that has not yet become implementation work

If the CBA concludes with an approved software change, create a separate Hive
work item for that concrete deliverable.

## Guardrails

- **Route into Hive only after the analysis becomes implementation.** Example:
  "Build the chosen billing-alert feature" belongs in Hive; "compare three
  billing-alert approaches by ROI" does not.
- **Do not hide implementation inside a CBA.** If the request asks for code,
  tests, migrations, deployment, or production docs, split that deliverable into
  a core-development story.
- **Keep decision authority outside Hive.** Hive can record accepted
  requirements, but it should not pretend that review/test gates validate a
  business ROI judgment.
- **Use CBA output as source context.** When later implementation is approved,
  link the CBA result from the Hive story or epic so the rationale survives.

## Examples

1. **"Compare whether we should build an internal content pipeline or buy a
   SaaS content tool."** This is a CBA because the output is a business
   recommendation with cost, speed, risk, and operational trade-offs. Verdict:
   OUT OF HIVE. Alternative: business-run tool. If the decision is "build," the
   resulting implementation epic can enter Hive separately.
2. **"Estimate the cost and benefit of adding a second Codex lane versus
   improving lane-health routing first."** This is business analysis over
   investment priority. Verdict: OUT OF HIVE. Alternative: business-run tool.
   If the chosen action is "implement the routing improvement," that concrete
   software work belongs in Hive.
3. **"Create a table comparing expected subscription cost, maintenance burden,
   and operational risk for three observability vendors."** This produces a
   vendor-selection recommendation, not a shippable artifact. Verdict: OUT OF
   HIVE. Alternative: business-run tool. A later integration story for the
   selected vendor may enter Hive.

## References

- Synthesis doc: [SDLC Boundary](../sdlc-boundary.md) (created by the
  `synthesis-doc` story)
- Consus record: pending `sdlc-boundary-cba-001`
- Planned story: `sdlc-boundary-definition/cba-decision`

## Tags

`sdlc-boundary`, `routing`, `cba`, `business-analysis`, `meta`
