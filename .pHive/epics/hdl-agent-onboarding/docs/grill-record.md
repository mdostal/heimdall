# Grill Record — hdl-agent-onboarding

**Source draft:** .pHive/epics/hdl-agent-onboarding/docs/design-discussion.md
**CONTEXT.md substrate:** present (Terminology/Key paths/Conventions sections unpopulated — reduced fidelity for vocabulary checks; Canonical references pointed at docs/north-star.md, which was read and is load-bearing for this pass)
**inconsistency_risk_signals:** absent (research-brief.md predates the signal field; heuristic pass against draft + CONTEXT.md + north-star.md + project memory)
**round_number:** 1
**unresolved_count:** 6
**Generated:** 2026-08-18T00:00:00Z

## Summary

- Vocabulary mismatches: clean
- Hidden assumptions: 3 findings
- Unresolved tensions: 2 findings
- Convention violations: 1 finding
- Posture mismatches: clean (not applicable — this epic doesn't touch Hive-internal atomic-skill/substrate posture)

## Vocabulary mismatches

No findings. CONTEXT.md's own Terminology/Conventions sections are unpopulated, so there's nothing in it for the draft to contradict. Draft's own terminology (harness, lane, MCP registration) is used consistently throughout.

## Hidden assumptions

- **H1 (high)** — Draft assumes a globally-installed, agent-registered `heimdall mcp` gives an agent access to the real, live lane/routing state, without citing evidence. Reading `src/api/mcp-server.ts:356` directly: `const store = new StateStore(process.env.HEIMDALL_DB_PATH ?? ":memory:")`. Unless `HEIMDALL_DB_PATH` is explicitly set, the MCP server opens an **in-memory, ephemeral, empty** SQLite store — completely disconnected from whatever real Heimdall service (`http-server.ts`) is actually running and tracking lane health. A `claude mcp add --scope user heimdall -- heimdall mcp` registration, as currently drafted, wires an agent up to a blank database, not the real fleet state.
  - Draft location: §3 item 2 (registerMcp command), §1 "done looks like ... their Claude Code session can immediately call heimdall.lanes.list"
  - Why this matters: this isn't a refinement detail, it's whether the epic's headline promise ("plug your agent into this") actually works at all as currently scoped. Every other design decision in the draft (skill content, dashboard copy, install.sh) is downstream of this being solved.
  - Question for planner: does `heimdall agent init` need to also discover/configure `HEIMDALL_DB_PATH` (pointing at the same DB file a locally-running Heimdall service uses), does the registered `heimdall mcp` invocation need to proxy over HTTP to a running service instead of opening SQLite directly, or is there a third mechanism? This needs an explicit architectural answer before stories are cut, not left to story-time discovery.

- **H2 (medium)** — Draft assumes a globally npm-installed `heimdall` CLI can resolve its config/policy the same way the desktop app's Rust sidecar does, without checking. The existing pattern (`resolveDefaultPolicyPath`, `HEIMDALL_REPO_ROOT` env var) resolves against either a bundled Tauri resource dir or a dev-checkout fallback via `CARGO_MANIFEST_DIR` — neither exists for a plain `npm install -g pantheon-heimdall`. There is no "repo" and no bundled-resource dir in that install shape.
  - Draft location: §3 items 1-2 (bin shim + agent-command), §5 "the CLI/agent-command/skills work does not depend on [Pages] and can land independently"
  - Why this matters: same class of problem as H1 — a globally-installed CLI needs a real, well-defined answer for "where does my config/policy/db live" that isn't "wherever the dev checkout happened to be."
  - Question for planner: does global-install mode need its own config resolution order (e.g. `~/.config/heimdall/` or `$XDG_CONFIG_HOME`, mirroring how most global CLIs behave), separate from the existing dev/desktop-app resolution chain? This is closely related to H1 and may share one fix.

- **H3 (medium)** — Draft notes the `route_selection` tool's naming inconsistency (§2, §3 item 3: "flag that inconsistency rather than quietly working around it") but doesn't actually decide what the skill-writing step should DO with it. "Flag, don't fix" is a stance on the *code*, not an answer for the *documentation* — the skill still has to reference the tool by some name.
  - Draft location: §2 last bullet, §3 item 3
  - Why this matters: whoever writes `heimdall-routing`'s SKILL.md needs an unambiguous instruction, not a flagged-but-undecided inconsistency.
  - Question for planner: does the skill document the tool under its real registered name (`route_selection`, with an explicit inline note about the naming inconsistency so readers aren't confused), or does this epic take the opportunity to rename it to `heimdall.route.selection` for consistency (a breaking change for any existing caller — Auriga is named elsewhere in this repo's docs as a consumer)? Pick one; "flag it" isn't a complete answer.

## Unresolved tensions

- **U1 (medium)** — Draft's own Scale Assessment (§8) states `Migration required: no` and describes the Node floor bump as "backward-compatible on Node >=22.13", while §5 Dependencies and Constraints states in the very same document: "anyone still on an older Node in this range breaks." Both can't be true — bumping `engines.node`'s floor is, by definition, a breaking change for installs below the new floor, even if it's a small/expected one.
  - Draft location: §5 last bullet vs. §8 "Migration required: no ... additive"
  - Tension: "no migration required, purely additive" vs. "this will break some installs"
  - Question for planner: reconcile by scoping the "no migration" claim correctly — it's true for Heimdall's *own* checked-in scripts (which will use the new floor going forward) but not universally true for downstream consumers pinned to older Node. Say so explicitly rather than asserting both.

- **U2 (high)** — `docs/north-star.md` (the repo's own canonical reference, cited in CONTEXT.md) states: *"every plugin is open-source and ships a standalone version that works with any harness ... AS WELL AS plugging into the greater Pantheon for the full vision. So Heimdall builds for two modes: standalone (carries its own light config UI) + Pantheon-plugin (config via Vesta/Multica; the two work together)."* The draft's entire design — `agent init`, MCP registration, the dashboard "get started" panel — is scoped exclusively to standalone/harness-install mode and never once addresses Pantheon-plugin mode. It isn't wrong to scope this way, but the draft doesn't say it's scoping this way, and a reader can't tell whether plugin-mode was considered and excluded, or just never considered.
  - Draft location: entire document, most concentrated in §1 ("what does 'done' look like") and §3 item 6 (dashboard panel)
  - Tension: north-star's explicit two-mode requirement vs. a design that silently assumes only one of the two modes exists.
  - Question for planner: state explicitly whether `agent init`/MCP-registration/the dashboard panel are standalone-mode-only by design (Pantheon-plugin mode presumably gets its agent/harness wiring through Vesta/Multica's own mechanism instead, per how config already works in that mode) — and if so, say that in §1 or §3 as a scoping statement, not leave it implicit.

## Convention violations

- **C1 (medium)** — Project memory `project_pantheon_god_ui_model.md` (this session's own established convention): *"standalone mode needs own app UI; plugin mode piggybacks on Pantheon's L2 Plugin Descriptor/lifecycle instead."* The draft's new dashboard "get started" panel (§3 item 6) is added directly into `src/api/ui/dashboard.ts` with no mention of whether/how it's gated for standalone vs. plugin mode — exactly the kind of "own app UI" element that convention says shouldn't unconditionally ship in a context where Pantheon-plugin mode is active (since plugin mode is supposed to piggyback on Pantheon's own descriptor/lifecycle UI, not carry Heimdall-specific onboarding chrome).
  - Draft location: §3 item 6
  - Convention: `project_pantheon_god_ui_model.md` (session memory), reinforced by U2 above (north-star.md's two-mode split)
  - Question for planner: is dashboard mode-detection already handled upstream of `renderDashboardHtml` (i.e. the panel is safe because plugin mode never renders this dashboard at all), or does the new panel need an explicit standalone-mode gate? If the former, say so in the design so it's a verified fact, not an assumption stacked on top of H1/H2's unverified assumptions.

## Posture mismatches

No findings. This epic doesn't touch Hive's own atomic-skill/composable-substrate machinery — it's ordinary product code in a consumer repo, so Hive posture doesn't directly apply here.

## Notes

The three hidden-assumption findings (H1, H2, H3) share a common root: the draft is confident about the *shape* of the install/registration flow (closely modeled on Portunus, which is sound) but has not verified the one thing that's actually novel to Heimdall — where a globally-installed, harness-spawned `heimdall mcp` process gets its *data*. Portunus's own `agent_setup.py` doesn't have this problem the same way because Portunus's tools operate against its own local vault/state directly per-invocation, not against a separately-running long-lived service's live in-memory/DB state. This is the one place "adapt, don't copy" from Portunus needed the most scrutiny and got the least — worth the planner's primary attention on revision.

## Addendum — collaborative review (post-H/V)

The H/V planning collaborative-review pass (run against horizontal-plan.md
and vertical-plan.md, per `hive.config.yaml`'s `planning.collaborative_review:
true`) surfaced three further real corrections, folded back into
design-discussion.md/horizontal-plan.md/vertical-plan.md:

- A 4th `:memory:`-default StateStore site (`src/api/cli.ts:57`), missed by
  this grill pass's H1 finding.
- A false claim that no CLI dispatcher existed (`src/api/cli.ts` already
  dispatches `route`/`route-outcome`/`lanes`) — the plan wrongly proposed
  inventing a new router.
- The compiled-output path claim (`dist/cli.js`) didn't match
  `tsconfig.json`'s real `rootDir`/`outDir` behavior (`dist/src/api/cli.js`).
- A genuinely severe environmental blocker this grill pass didn't check for:
  GitHub Actions is account-wide billing-blocked for this repo
  (`docs/decisions/DEC-hdl-local-build-verification.md`), which would have
  silently broken the originally-planned Actions-based GitHub Pages
  deployment. Resolved by switching to branch-based Pages.

Noted here for the record — this grill pass's own scope (design-discussion
only) didn't reach the H/V documents or the decisions/ directory, so it
couldn't have caught these; the collaborative-review gate is what caught
them, working as intended.

## Out of scope (this pass)

Grill does not propose solutions, score quality, gate work, or prioritize findings beyond the severity noted inline. The planner's job is to revise the design-discussion draft to resolve each finding, or explicitly document an accepted deviation with rationale.
