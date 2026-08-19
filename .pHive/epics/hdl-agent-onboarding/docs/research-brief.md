# Research Brief — hdl-agent-onboarding

## Requirement

Operator: "every agent, harness, etc that uses this needs a way to install and
interact with it — it should be top and forward so people can see when
installing and working and what to feed the agent or harness to get
interactivity." Modeled (not copied) on Portunus's real, shipped `agent init`
/ `agent status` pattern. Also explicit: the dashboard needs a prominent,
dismissible "get started" panel, not just docs/README.

## Portunus's real pattern (source of the model, not the copy)

Read directly from Portunus's `dev` branch (PR #101), not assumed:

- `src/portunus/agent_setup.py` (146 lines): `detect_harnesses()` via
  `shutil.which("claude"/"codex")`. `register_mcp(harness)` shells to
  `claude mcp add --scope user portunus -- portunus mcp` /
  `codex mcp add portunus -- portunus mcp`. `mcp_registered()` uses the
  targeted `claude mcp get portunus` for Claude (the real bug fix — `claude
  mcp list` health-checks every registered server, 30+s on a machine with
  many configured) and falls back to `codex mcp list` for Codex (no per-server
  `get` exists there). `install_skills()` copies
  `agent_skills/{name}/SKILL.md` → `~/.claude/skills/{name}/SKILL.md`,
  idempotent via `filecmp.cmp` (only overwrites when content differs). 4 real
  skills, Claude-only (Codex has no skill mechanism).
- `src/portunus/cli.py`: `agent init|status` subcommand, `--harness`
  (repeatable), `--json`.

**Two real gaps in Portunus's own implementation** (not solved problems to
copy blind):
- `scripts/install.sh` claims to be "published to the gh-pages root" but is
  confirmed NOT actually live (`origin/gh-pages` has only `index.html` +
  `assets/`; no workflow publishes it). The README's curl URL is dead.
- PyPI naming is `pantheon-portunus` (installed command stays `portunus`)
  because plain `portunus` is an unrelated, unmaintained PyPI package — but
  Portunus isn't published to PyPI yet either; `install.sh` installs straight
  from GitHub as a stopgap.

## Heimdall's baseline (confirmed, not assumed)

- `package.json`: no `"bin"` field, `"private": true`, name `"heimdall"`,
  `engines.node: ">=22.5.0"`. All scripts run via
  `node --experimental-sqlite --env-file-if-exists=.env --import tsx <file>`.
  No compiled-JS entrypoint is exercised anywhere today (`tsc` exists but its
  output is unused).
- `src/cli/route-command.ts` is the only CLI-shaped file — one route
  subcommand, not a general entrypoint.
- `src/api/mcp-server.ts` starts a stdio MCP server, guarded by an
  `isMainModule` check. Requires a full repo checkout + absolute path today —
  not portable.
- 10 real MCP tools (full schemas below).
- Zero `SKILL.md` files anywhere in the repo.
- `docs/_config.yml` exists (Jekyll, `jekyll-theme-cayman`) and README already
  links `https://mdostal.github.io/heimdall/` as "Read the Documentation
  Site" — **that link is currently dead** (confirmed 404, no Pages enabled,
  no `gh-pages` branch).
- Plain npm name `heimdall` is taken (dormant unrelated 2017 package).
- Dashboard (`src/api/ui/dashboard.ts` + `src/api/http-server.ts`) has an
  established server-side settings-persistence pattern: a `settings`
  key-value table, one `*_SETTING_KEY` constant + `getActive*`/`set*` pair per
  preference (theme, desktop icon). New dismissible-panel state should follow
  this exact pattern rather than `localStorage`, so state is consistent
  whether the dashboard is opened via a browser or the desktop app's webview
  (both talk to the same HTTP server).

## Phase A grounding research (this epic, live-verified on this machine)

1. **`node:sqlite` flag**: `--experimental-sqlite` was removed as a
   requirement in Node **v22.13.0 / v23.4.0** (still experimental, no longer
   flag-gated). Installed Node here is v24.18.1. Confirmed live:
   `node -e "require('node:sqlite')"` and the ESM equivalent both work with no
   flag. → `engines.node` floor can move to `>=22.13.0` and every script can
   drop `--experimental-sqlite`.
2. **Portable CLI entrypoint with runtime flags**: `#!/usr/bin/env -S node
   --flag` shebangs break on Windows (`npm`'s `cmd-shim` doesn't parse
   shebang flags at all). `NODE_OPTIONS` leaks into child processes. A plain
   JS shim that `spawnSync(process.execPath, [...flags, realFile, ...args])`
   is the only cross-platform-identical option. Since (1) removes the only
   flag Heimdall currently needs, the shim's real job is running **compiled
   JS** (`dist/`, from the existing unused `tsc` build), not `tsx`-interpreted
   TS — so a global install doesn't drag `tsx`/`typescript` in as runtime
   deps for end users.
3. **npm name**: `npm view pantheon-heimdall` → real `E404`, confirmed
   available.
4. **`npx` vs global install**: global install recommended for this use case.
   An agent harness spawns the MCP server repeatedly as a stdio subprocess;
   `npx` adds registry-resolution latency/non-determinism per spawn unless
   pinned, global install resolves to a fixed on-PATH bin with none.
5. **Real current CLI syntax** (run on this machine):
   `claude mcp add --scope user heimdall -- heimdall mcp` (Claude Code
   `claude mcp add --help`: `-s/--scope`, `-e/--env`, `-t/--transport`, `--`
   separator — matches the remembered Portunus shape).
   `codex mcp add heimdall -- heimdall mcp` (Codex CLI 0.143.0
   `codex mcp add --help`: no `--scope` concept, `--env` only).
6. **GitHub Pages**: `mdostal/heimdall` is a **private** repo. Confirmed live:
   `gh api repos/mdostal/heimdall/pages -X POST -f build_type=workflow` →
   `422 Your current plan does not support GitHub Pages for this
   repository`. Free-plan private repos cannot enable Pages at all — this is
   a plan/visibility limit, not a config problem. Operator decision (asked
   directly): **make the repo public** to unblock Pages. Actions-based
   (`build_type: workflow`, `actions/deploy-pages` +
   `actions/upload-pages-artifact`, needs `pages: write` + `id-token: write`)
   is GitHub's current recommended default and needs no `gh-pages` branch at
   all — simpler and more reliable than a branch-based deploy for a
   single-file `install.sh` (and, incidentally, the existing dead docs-site
   link) publish.
7. **MCP tool inventory** (`src/api/mcp-server.ts`, full schemas):
   - `heimdall.lanes.list` — no params.
   - `heimdall.lanes.override` — `{lane_id, state: enabled|disabled|auto,
     reason?}`, required `[lane_id, state]`.
   - `heimdall.lanes.setResetAt` — `{lane_id, reset_at: ISO-8601|null}`,
     required both.
   - `heimdall.lanes.add` — `{lane_id, provider, model, token}`, required
     all four. Writes to local `.env`; no hot-restart.
   - `heimdall.routingStrategy.get` — no params.
   - `heimdall.routingStrategy.set` — `{strategy}`, required.
   - `heimdall.models.list` — `{provider?}`.
   - `heimdall.models.refresh` — no params (async).
   - `heimdall.models.setEnabled` — `{provider, model_id, enabled}`, required
     all three.
   - `route_selection` — **note: not namespaced `heimdall.route.*` like every
     other tool** (constant `ROUTE_SELECTION_TOOL_NAME`,
     `src/api/mcp-server.ts:59,175`) — `{task_id, task_type: planning|build|
     review, estimated_cost?}`, required `[task_id, task_type]`.
   - `heimdall.route.reportOutcome` — `{decision_id, outcome?, actual_cost?}`,
     required `[decision_id]`.

## Open questions this research resolves

All 7 flagged questions from the plan input are answered above with
decisions, not left open — see design-discussion.md for how each becomes a
concrete design choice. The one genuinely operator-level call (GitHub Pages
needs the repo to go public) was asked directly rather than assumed;
operator chose **make repo public + GH Pages**.
