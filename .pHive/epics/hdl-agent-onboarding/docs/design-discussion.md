# Design Discussion — hdl-agent-onboarding

## 1. What Are We Doing?

Right now Heimdall has zero install story. No `bin` entrypoint, no packaged
CLI, no way for a coding agent or harness (Claude Code, Codex) to register
Heimdall's MCP server without hand-typing an absolute path into someone's
dev checkout. There are 11 working MCP tools and nobody has a document
telling them what to feed an agent to use them. The dashboard has seven
panels and none of them tell a first-time visitor "here's how you plug your
agent into this."

The operator wants what Portunus already shipped, adapted rather than
copied: a `heimdall agent init` that detects Claude Code / Codex on the
machine, registers the MCP server for each, and installs usage skills into
`~/.claude/skills/`; `heimdall agent status` that reports without touching
anything; a real `curl | bash` installer; and a dashboard panel that's
impossible to miss on first visit and collapses out of the way after that.
"Done" looks like: someone with a fresh machine runs one curl command, gets
a working `heimdall` binary, runs `heimdall agent init`, and their Claude
Code session can immediately call `heimdall.lanes.list` **and get back the
real, live state of their actual fleet** — not an empty database (see §2 —
this turned out to be the one part of "adapt Portunus's pattern" that
needed real scrutiny, not just porting).

**Scope statement (post-grill):** this is a standalone/harness-install
feature. `src/api/ui/dashboard.ts` is already documented at its own file
header as "the standalone-mode UI requirement" — nothing in it renders in
Pantheon-plugin mode today, so the new "get started" panel inherits that
scoping for free, no new gate needed. Per `docs/north-star.md`,
Pantheon-plugin mode gets its own agent/harness wiring through Vesta/
Multica's L2 Plugin Descriptor lifecycle, not through this epic's `agent
init` — that's a different, already-established mechanism and explicitly
out of scope here.

## 2. What I Found

- Heimdall's baseline is materially more primitive than Portunus's was when
  it shipped this feature. Portunus already had `pipx install` working;
  Heimdall has no `bin` field in `package.json` at all, `"private": true`,
  and every script (`src/api/mcp-server.ts` included) runs through
  `tsx` against `src/*.ts` directly — nothing here has ever been packaged.
- Portunus's own `agent_setup.py` pattern is real and directly portable in
  shape: `detect_harnesses()` via `which`, `register_mcp()` shelling to the
  harness's own `mcp add`, an idempotent `install_skills()` copy. The one
  real bug in it (`claude mcp list` health-checks every server, 30+s) is
  already avoided by using the targeted `claude mcp get <name>` lookup —
  confirmed still the right call, current `claude mcp add --help` syntax
  matches what Portunus uses.
- Two things Portunus's own repo has NOT actually gotten right yet, so I
  can't lean on them as proven patterns: `install.sh` claims to live on
  `gh-pages` but the branch only has `index.html`; and Portunus isn't
  published to a real package registry either (`install.sh` pulls from
  GitHub directly). Whatever Heimdall ships here has to be verified live,
  not assumed from Portunus's docs.
- `node:sqlite` no longer needs `--experimental-sqlite` as of Node
  22.13.0/23.4.0 (confirmed live on this machine, Node v24.18.1). This
  matters a lot: it removes the one runtime-flag Heimdall's CLI would
  otherwise need to smuggle through a `bin` shim.
- Dashboard's settings persist through one repeating pattern:
  `*_SETTING_KEY` constant + `getActive*`/`set*` pair over the `settings`
  table (`src/api/http-server.ts:234-280` for theme and desktop-icon). A new
  "get started" dismiss-state should use the same pattern, not
  `localStorage` — the desktop app and a plain browser both hit the same
  HTTP server, and this session has repeatedly needed things to behave
  identically in both modes.
- README already advertises `https://mdostal.github.io/heimdall/` as "Read
  the Documentation Site" — that link is dead today (no Pages, private
  repo). This epic is also the fix for that pre-existing broken promise,
  not just new scope.
- `mdostal/heimdall` is private, and GitHub Pages flatly cannot be enabled
  on a private repo on the free plan (confirmed live: `422` from the real
  Pages API). I asked the operator directly rather than guessing; the
  decision is **make the repo public** to unblock Pages. This is also
  consistent with `docs/north-star.md`'s explicit "every plugin is
  open-source" statement — not just a Pages workaround.
- **The real gap grill caught**: `src/api/mcp-server.ts:356`,
  `src/api/http-server.ts:882`, `src/main.ts:130`, **and (found in the
  collaborative-review pass) `src/api/cli.ts:57`** all default to
  `new StateStore(process.env.HEIMDALL_DB_PATH ?? ":memory:")` — four sites,
  not three. Today this is fine because dev processes share one `.env`. For
  a globally npm-installed `heimdall mcp`, spawned by an agent harness with
  no shared `.env`, this defaults to an **empty, ephemeral, in-memory**
  database, completely disconnected from any real running Heimdall service.
  A registered agent would get back a functioning-looking but entirely fake
  empty fleet. This is the central design gap this draft has to close.
- **Collaborative-review correction: a CLI dispatcher already exists.**
  `src/api/cli.ts` (wired to `npm run cli`) already argv-dispatches `route`
  / `route-outcome` / default `lanes` subcommands (`route-command.ts`'s
  `runRouteCommand`/`runRouteOutcomeCommand`). The first draft of this
  document wrongly assumed no dispatcher existed and planned to invent a
  new one — corrected below: `agent init`/`status` extends this existing
  router instead of duplicating it.
- **Collaborative-review correction: compiled output path.** `tsconfig.json`
  has `rootDir: "."`, `outDir: "dist"` — `tsc` output preserves the `src/`
  prefix (`src/api/cli.ts` → `dist/src/api/cli.js`), there is no bare
  `dist/cli.js` and no `src/cli.ts` exists. The bin shim has to point at the
  real compiled path.
- **Collaborative-review correction: GitHub Actions is account-wide billing
  -blocked right now**, per `docs/decisions/DEC-hdl-local-build-verification.md`
  (2026-08-12, same week as this epic) — Actions runs fail to even start
  ("recent account payments have failed"), which already forced `ci.yml`'s
  `pull_request` trigger off entirely in favor of hive-box (`dostal@
  100.75.161.82`) local verification. An `actions/deploy-pages`-based Pages
  workflow (this draft's original plan) **cannot run at all** under this
  block — it's not a code risk, it's a hard environmental blocker. Pages
  needs to go out branch-based (`build_type: legacy`, a `gh-pages` branch
  pushed to directly, no Actions run involved — GitHub's Pages service
  serves branch content without building anything for a plain static site).

## 3. My Proposed Approach

0. **Fix the shared-state gap first — this gates everything else.** Add
   `resolveDefaultDbPath(env, homedir)` (same shape as the existing
   `resolveDefaultPolicyPath`): honors `HEIMDALL_DB_PATH` when set, else
   falls back to a fixed per-machine path (`~/.local/share/heimdall/
   heimdall.db`, XDG-style — Node has no built-in XDG resolver, write a
   small one). Wire this as the new default in `main.ts`, `http-server.ts`,
   `mcp-server.ts`, and `cli.ts` (four sites, not three — `cli.ts:57` found
   in collaborative review) in place of `:memory:`, so *every* Heimdall
   process started on a machine without an explicit `.env` — the headless
   dev server, the desktop app's sidecar, and a globally-installed `heimdall
   mcp` — shares one real, persistent database by default. Do the same for
   config/policy resolution (extend `resolveDefaultPolicyPath`'s fallback
   chain with the equivalent global-install-safe default, not just
   `HEIMDALL_REPO_ROOT`/`cwd()`, neither of which exists for a global npm
   install). This needs SQLite WAL mode verified for safe concurrent access
   from multiple processes (dashboard server + MCP tool calls) — check, not
   assume, during implementation.
1. **Give Heimdall its first real packaged CLI.** Bump `engines.node` to
   `>=22.13.0` and drop `--experimental-sqlite` from every script. Add a
   `bin/heimdall.js` shim that `spawnSync`s `process.execPath` against the
   **real compiled path, `dist/src/api/cli.js`** (not a bare `dist/cli.js`
   — `tsconfig.json`'s `rootDir: "."` preserves the `src/` prefix in
   `outDir: "dist"`, corrected after collaborative review caught the first
   draft's wrong path) — cross-platform-identical, no shebang-flag Windows
   breakage. Wire `package.json`'s `"bin": {"heimdall": "bin/heimdall.js"}`,
   publish as `pantheon-heimdall` on npm (confirmed available), keep the
   installed command plain `heimdall` — same shape as Portunus's
   `pantheon-portunus`/`portunus` split.
2. **Extend the existing dispatcher, don't invent a new one.**
   `src/api/cli.ts` (wired to `npm run cli`) already argv-dispatches
   `route`/`route-outcome`/default `lanes` — the first draft of this
   document wrongly assumed no CLI router existed; corrected after
   collaborative review. Add `agent` as a new top-level command inside
   `cli.ts`'s existing dispatch (`else if (command === "agent") { ... }`),
   backed by new `src/cli/agent-command.ts` for the actual logic:
   `heimdall agent init [--harness claude|codex]` and `heimdall agent status
   [--harness ...] [--json]`, mirroring `agent_setup.py`'s shape in
   TypeScript: `detectHarnesses()` (`which claude`/`which codex` via
   `child_process`), `registerMcp(harness)` shelling to `claude mcp add
   --scope user heimdall -- heimdall mcp` / `codex mcp add heimdall --
   heimdall mcp`, `mcpRegistered(harness)` using `claude mcp get heimdall`
   (targeted, fast — the exact bug Portunus already found and fixed) and
   `codex mcp list` fallback for Codex. Idempotent skill install into
   `~/.claude/skills/heimdall-*/SKILL.md`, content-diffed before overwrite.
3. **Skills.** 4 skills mapped to the real 10 tools by function, not 1:1 per
   tool: `heimdall-lanes` (list/override/setResetAt/add), `heimdall-routing`
   (routingStrategy get/set + route_selection + reportOutcome), `heimdall-
   models` (list/refresh/setEnabled), `heimdall-status` (a read-only "what's
   the state of my fleet" overview skill, since none of the other three are
   a good home for "just tell me what's going on"). **Decision on the
   `route_selection` naming inconsistency** (it's the one tool not
   namespaced `heimdall.route.*` like its siblings, `src/api/
   mcp-server.ts:59,175`): document it under its real registered name with
   one explicit inline note in `heimdall-routing`'s SKILL.md ("this tool is
   named `route_selection`, not `heimdall.route.selection`, despite the
   pattern its siblings use"). Do NOT rename the tool in this epic — that's
   a breaking change for any existing caller (Auriga is named elsewhere in
   this repo's own docs as a consumer) and is out of scope for an onboarding
   epic; renaming, if ever done, is its own small future epic.
4. **`scripts/install.sh`** — `npm install -g pantheon-heimdall` then
   `heimdall agent init`, real content this time (Portunus's own is a
   template shape, not something to trust blindly).
5. **GitHub Pages — branch-based, NOT Actions-based.** GitHub Actions is
   account-wide billing-blocked right now (`docs/decisions/
   DEC-hdl-local-build-verification.md`) — an Actions-workflow Pages deploy
   cannot run at all, corrected from the first draft after collaborative
   review caught this. Operator has approved making the repo public. Push a
   `gh-pages` branch directly (from a local machine or the hive box, plain
   `git push`, no Actions involved) containing both the Jekyll docs site
   (fixes the already-dead README link) and `install.sh`, then enable Pages
   via `gh api repos/mdostal/heimdall/pages -X POST -f
   source[branch]=gh-pages -f source[path]=/` (`build_type: legacy` —
   GitHub's Pages service serves the branch directly, no build step, no
   Actions run needed). Live-curl `https://mdostal.github.io/heimdall/
   install.sh` after enabling, not just assumed to work — first deploys can
   take a few minutes to propagate. If the Actions billing block is ever
   resolved, migrating to the Actions-based workflow later is a natural
   follow-up, not required now.
6. **Dashboard "get started" panel.** New first panel above Fleet Scope
   (`src/api/ui/dashboard.ts`), server-rendered, containing the curl
   one-liner + `heimdall agent init` + a link to the skill docs. New
   `AGENT_ONBOARDING_DISMISSED_KEY` setting, same `getActive*`/`set*`
   pattern as theme/icon, `GET`/`POST /agent-onboarding-dismissed` mirroring
   the existing routes exactly. Collapsed state persists server-side so it's
   consistent across browser + desktop app.
7. **README** — curl one-liner becomes the new top line, under the existing
   badges, ahead of "What & why."

## 4. What Could Go Wrong

- **Making the repo public is irreversible in spirit** (history becomes
  visible even if flipped back private later) — **high**, but operator
  explicitly approved it after being shown the alternative (skip Pages
  entirely). Not re-litigating; flagging because it's the single riskiest
  action in this epic and belongs in its own commit/step, reviewable on its
  own.
- **`bin` shim + compiled `dist/` is new surface with zero packaging
  history** — **medium**. Nothing in this repo has ever been through `npm
  pack`/`npm publish` before; real risk of missing files in the published
  tarball (`.npmignore`/`files` field never exercised). Must actually `npm
  pack --dry-run` and inspect the tarball contents before trusting it.
- **`codex mcp list` fallback for `mcpRegistered()` has no per-server
  targeted lookup** — **medium**. If Codex's registered-server count grows
  large this could hit the same slowness Portunus fixed for Claude and never
  fixed for Codex itself. Not blocking now (Codex configs are typically
  small), but worth a one-line note in the skill/status output rather than
  silently inheriting Portunus's own unfixed gap.
- **Skill content quality** — **medium**. Four skills need to be genuinely
  useful references (real parameter names, real example calls), not stub
  files that just say "call heimdall.lanes.list". Low effort here defeats
  the entire point of the epic.
- **GitHub Pages first-deploy propagation delay** — **low**. Can look "not
  live" for a few minutes after enabling Pages/pushing to `gh-pages`;
  verification step needs a retry/wait, not a single curl-and-declare-broken.
- **Near-miss, now avoided**: the first draft planned an Actions-based Pages
  workflow, which would have silently never run given the account-wide
  Actions billing block already in effect for this repo — **would have
  been high** if shipped as originally drafted. Caught by collaborative
  review before any code was written; resolved by going branch-based
  instead (§3 item 5), which needs no Actions run at all.
- **Multi-process SQLite access once the DB path is shared** (§3 item 0) —
  **medium**. Once a globally-installed `heimdall mcp` and a running
  `heimdall serve`/desktop-app sidecar point at the same on-disk file
  instead of each getting its own `:memory:`, concurrent access from
  separate processes becomes real for the first time. WAL mode should make
  concurrent readers + a single writer safe, but this repo has zero prior
  multi-process-SQLite experience to lean on — needs a real concurrent-
  access test (spawn both, hit both, check for `SQLITE_BUSY`), not an
  assumption that WAL mode alone is sufficient.

## 5. Dependencies and Constraints

- Depends on the operator's already-given approval to make `mdostal/heimdall`
  public — this has to happen before the Pages workflow can be verified
  live, but the CLI/agent-command/skills work does not depend on it and can
  land independently.
- No CI workflow currently runs `npm pack`/publish — this epic adds the
  first one. Publishing to the real npm registry (vs. just building the
  tarball) is a separate, explicit, operator-gated action — this epic
  prepares the package but does not assume permission to actually run `npm
  publish` unattended.
- Node floor bump to `>=22.13.0` is a real (if minor) compatibility
  constraint for anyone currently on Node 22.5–22.12 — worth a changelog
  line, not a silent bump. (Correction from the first draft: §8's "no
  migration required" refers to Heimdall's *own* checked-in scripts/CI,
  which move to the new floor cleanly with no data/code migration involved
  — it does not mean the change is invisible to every downstream consumer.
  Both things are true at once; the earlier draft stated them as if in
  tension.)

## 6. Open Questions

1. Should `npm publish` actually happen as part of this epic's execution, or
   does the epic stop at "tarball builds correctly, `npm pack --dry-run`
   verified" and leave the real publish as a separate operator-gated step?
   Leaning toward: prepare everything, dry-run verify, but treat the actual
   `npm publish` (a public, hard-to-fully-reverse action) as something to
   flag back to the operator rather than run autonomously — same posture as
   this epic already took with the repo-visibility question.
2. Exact wording/design of the dashboard panel's copy — I'll draft real copy
   in implementation, not stub text, but if the operator wants a specific
   tone (terse ops-console vs. friendlier onboarding) that's worth a quick
   look before it ships.
3. Does `heimdall agent status --json` need a stable schema contract now (for
   scripting), or is human-readable-first sufficient for v1? Leaning
   human-readable-first with `--json` as a real but not yet API-versioned
   escape hatch, matching Portunus's own posture.

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: node --test (existing unit test runner), the hive-box verification
         script (scripts/hive-verify.sh — this repo's real merge gate now,
         not a GitHub Actions check, per DEC-hdl-local-build-verification),
         real `npm pack --dry-run` tarball inspection, live `curl` against
         the real deployed GitHub Pages URL after enabling Pages on the
         pushed `gh-pages` branch, real `claude mcp add`/`codex mcp add`/
         `claude mcp get` runs against this machine's actual installed
         harnesses (already proven reachable in Phase A research), real
         dashboard load via Playwright to confirm the panel renders and the
         dismiss state persists across reload.
  Platforms: macOS (this machine) for CLI + agent-init live verification;
         Pages is branch-based (no Actions run, no runner dependency at
         all) specifically because GitHub Actions is account-wide
         billing-blocked for this repo right now.
  Automated: bin shim's flag-stripping/dist-path resolution, agent-command's
         detectHarnesses/registerMcp/mcpRegistered logic (mockable child
         process calls), the two new dashboard routes, skill-file idempotent
         install (content-diff skip logic).
  Manual/live: actual `heimdall agent init` run against this machine's real
         claude/codex binaries (registering Heimdall live, the way the
         Portunus verification did), actual GitHub Pages URL curl after
         deploy, actual npm tarball content inspection, real concurrent
         access test — start a real `heimdall serve` and a real `heimdall
         mcp` pointed at the same default DB path simultaneously, hit both,
         confirm no SQLITE_BUSY under normal (non-adversarial) load, and
         confirm the MCP-side tool call sees data written by the serve-side
         process.
  Not verifying: cross-platform (Windows/Linux) CLI behavior — no such
         machine available in this session; the bin-shim design avoids the
         known Windows shebang breakage by construction, but real Windows
         verification is out of scope here and should be flagged, not
         quietly skipped, in the shipped docs.
```

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~16-20 (package.json, new bin/heimdall.js, src/api/cli.ts
    extended (not replaced) with an "agent" command, new
    src/cli/agent-command.ts, new shared default-db-path/config-dir resolver
    (extends policy-loader.ts's existing pattern), main.ts + http-server.ts +
    mcp-server.ts + cli.ts default-store wiring (4 sites), 4 new SKILL.md
    files, new scripts/install.sh, new gh-pages branch content (no new
    Actions workflow file), dashboard.ts + http-server.ts changes,
    README.md, docs/_config.yml touch-up)
  Subsystems: packaging/build, CLI (extending the existing cli.ts
    dispatcher), MCP registration, state/config resolution (new — the
    grill-caught shared-DB-path gap, 4 sites not 3), agent-facing docs
    (skills), hosting (branch-based GitHub Pages — no Actions, per the
    account-wide billing block), dashboard UI, top-level docs
  Migration required: no (additive; existing scripts keep working once the
    --experimental-sqlite flag is dropped, which is backward-compatible on
    Node >=22.13)
  Cross-team coordination: no (single repo, single operator)
  Unknowns: 3 (open questions above) — none are architecture-blocking,
    all are refinement-level

  RECOMMENDATION: Needs H/V planning (Medium scope) before story
    decomposition — not structured outline (not Large: single repo, no
    migration, bounded and well-understood after this research pass).
  RATIONALE: Cross-stack (build tooling + CLI + CI/CD + frontend UI) and
    multi-file across genuinely independent layers that need explicit
    sequencing (you cannot register an MCP server for a CLI that doesn't
    exist yet; you cannot verify Pages before the repo goes public) — a
    plain design discussion isn't enough to slice this safely, but it's
    also not large/novel enough to need full structured-outline elicitation.
```
