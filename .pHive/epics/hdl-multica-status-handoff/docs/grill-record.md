# Grill Record — hdl-multica-status-handoff

**Source draft:** .pHive/epics/hdl-multica-status-handoff/docs/design-discussion.md
**CONTEXT.md substrate:** absent (repo has no `.pHive/CONTEXT.md` — reduced fidelity)
**inconsistency_risk_signals:** absent (research-brief.md predates the signal field)
**round_number:** 1
**unresolved_count:** 3
**Generated:** 2026-08-27T00:00:00Z

## Summary

- Vocabulary mismatches: clean
- Hidden assumptions: 1 finding
- Unresolved tensions: 2 findings
- Convention violations: clean
- Posture mismatches: not applicable

## Vocabulary mismatches

No findings. "Retire" vs "patch," "status" vs "actuation," "give back the
status" are used consistently and match the operator's own words.

## Hidden assumptions

- **H1 (high)** — §3/§7 list the actuation module's own three `.test.ts`
  files as the test surface to delete, and describe "a new/updated `main.ts`
  test" only in the abstract. Verified directly: `src/main.test.ts` already
  contains a test at line 376 (`"a lane with a HEIMDALL_LANE_<N>_MULTICA_
  AGENT_IDS mapping gets MulticaControlAdapter when Multica IS configured"`)
  that asserts the *opposite* of this epic's new invariant, plus a test
  around line 416 that constructs a real `MulticaControlAdapter` instance
  through `composeService()` to exercise `reconcile()`. Both will fail to
  compile the moment the deletion lands, not just fail assertions — this is
  a required rewrite, not an optional "new test," and it's in a file the
  draft never names.
  - Draft location: §3 (file list omits `src/main.test.ts`), §7 (describes
    the new test only, not the existing one that must change).
  - Why this matters: a story written against "delete 3 files + their
    tests" would leave the build broken until someone separately notices
    `main.test.ts` no longer compiles — exactly the kind of gap that should
    be closed in planning, not discovered mid-implementation.
  - Resolution for the planner: name `src/main.test.ts` explicitly as a
    file this epic edits (rewrite the line-376 test to assert
    `StubControlAdapter` unconditionally; remove or rewrite the ~line-416
    test that exercises real `MulticaControlAdapter` behavior), in the same
    story as the `main.ts` wiring change, not a separate one — they'll fail
    together or pass together.

## Unresolved tensions

- **U1 (medium)** — §3 specifies the new decision record documents "the
  verified Multica constraints" and "points at pantheon-v2 as where the real
  lever now lives," but doesn't say whether it links the Artifact
  (`https://claude.ai/code/artifact/dbe7d4f4-3f08-4021-b2e2-00c0d1a26778`)
  that already contains the four-option analysis considered and rejected
  this session. §6 Open Question 1 explicitly defers *recommending* an
  option to Pantheon's own future planning — reasonable — but doesn't
  address whether that future planning gets a pointer to the *options
  already surfaced* (distinct from a recommendation). Without it, whoever
  plans the Pantheon-side epic either re-derives the same four options from
  scratch or never learns they were already considered here.
  - Draft location: §3 (decision-record content list), §6 item 1.
  - Tension: "stay neutral, don't prescribe" (reasonable) vs. "don't make
    the next planner redo real research" (also a real value this session
    has followed elsewhere, e.g. research-brief.md §3's own citation
    discipline) — the draft resolves the first and is silent on the second.
  - Question for planner: have the decision-record story explicitly include
    a link to the Artifact URL alongside the constraint findings. Linking
    prior analysis is not the same as prescribing a conclusion from it.

- **U2 (medium)** — Neither §1 nor §3 nor the story-decomposition intent
  says anything about the actual filed `heimdall#83` GitHub issue itself.
  The epic closes the *code path* the issue describes, and the decision
  record explains *why*, but nothing in the draft assigns "close the issue,
  referencing the decision record and the merged PR" to any story or step.
  - Draft location: §1 ("Done" description covers code + decision record,
    not the issue), §3 (no mention of issue lifecycle).
  - Tension: the epic's own stated trigger (§1, "heimdall#83") is a live,
    open GitHub issue with real state (`OPEN`, no comments) — leaving it
    open after the fix ships would make the issue tracker say something the
    codebase no longer believes, the exact kind of drift this session has
    caught and corrected elsewhere (stale docs, stale badges).
  - Question for planner: add an explicit final step — after merge, comment
    on and close `heimdall#83` referencing the decision record and the
    merge commit/PR. Cheap, and closes the loop the epic itself opened.

## Convention violations

No findings. The retirement approach (delete an isolated module, keep the
already-proven Stub fallback as the sole path) matches this repo's own
"don't add a flag/shim when you can just change the code" convention rather
than violating it — no defensive feature-flagging was proposed to begin
with.

## Posture mismatches

Not applicable — ordinary application code, no Hive-internal substrate
involved.

## Notes

A fourth angle was checked and came back clean, worth recording so it isn't
re-litigated: whether routing every lane through `StubControlAdapter` (which
wraps `ActuationStub`, itself designed to loudly warn on unmapped-lane
transitions) would now misfire for lanes that *do* have a
`multica_agent_ids` mapping configured, once nothing internal to Heimdall
acts on that mapping anymore. Read `actuation-stub.ts` directly:
`describeIntendedAction()` already phrases every message as hypothetical
("would disable Multica runtime for this lane...") rather than asserting a
real action was taken, and it already fires only on genuine transitions, not
every tick. That framing is accidentally exactly correct for the
post-retirement world — no finding here, no draft change needed.

## Out of scope (this pass)

Grill does not propose solutions beyond what's noted inline, score quality,
or gate work. H1's fix is mechanical (add the file, rewrite two tests) — the
planner should just say so in the affected story's scope.
