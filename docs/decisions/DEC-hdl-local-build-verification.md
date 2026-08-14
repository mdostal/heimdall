# DEC-hdl-local-build-verification

**Status:** Accepted (2026-08-12)

## Decision

GitHub Actions is no longer the merge gate for this repo. The build box is
**the hive** (`dostal@100.75.161.82` / `thes-mac-studio.lan`) — a dedicated,
build-only checkout at `/Users/dostal/hive-ci/heimdall`, verified via
[`scripts/hive-verify.sh`](../../scripts/hive-verify.sh) (`git reset --hard`
to the target ref → `npm ci` → `npm run build` → `npm test`). A `PASS` from
that script is what gates a merge to `main` now, not a GitHub Actions check.

## Why

PR #42 (epic `hdl-reason-aware-recovery`) hit `.github/workflows/ci.yml`
failing to even start: *"recent account payments have failed or your
spending limit needs to be increased"* — a GitHub Actions billing block on
the account, unrelated to the code. Operator directive (2026-08-12, verbatim
intent): stop depending on GitHub Actions for this; the hive becomes the
real build box, testing and verification happen there, locally — durable,
not a one-off workaround.

## What changed

1. **`scripts/hive-verify.sh`** (new) — the verification script, meant to be
   run from the hive box (or over SSH from anywhere). Always hard-resets its
   dedicated build checkout to the target ref first — this directory is
   build-only, never a dev checkout, and the script never pushes or commits.
2. **`.github/workflows/ci.yml`** — the `pull_request:` trigger is removed;
   `workflow_dispatch:` (manual-only) is kept so the workflow isn't deleted
   outright — it's a shared template across every Pantheon god repo (see the
   file's own header comment), so this repo diverging by deleting it
   entirely would break that convention. Disabling its automatic trigger
   here stops it posting failing checks on every future PR (it can't run at
   all right now — the block is account-level, not per-repo) without
   touching the shared file's content or requiring the same change to
   propagate to sibling repos.

## What this does NOT change

- Nothing about the actual build/test commands — `npm run build` / `npm
  test` are unchanged; `hive-verify.sh` just runs them somewhere that isn't
  GitHub-Actions-hosted and isn't gated by that billing state.
- This is scoped to Heimdall's repo only. Other Pantheon god repos still
  have `ci.yml`'s `pull_request:` trigger active unless they make the same
  call independently — this doc does not decide that for them.

## Consequences

- Before merging a PR to `main`, run `ssh dostal@100.75.161.82
  /Users/dostal/hive-ci/verify-heimdall.sh <ref>` (or the equivalent local
  script at `scripts/hive-verify.sh` if run directly on the hive box) and
  confirm `PASS` before merging — this replaces "wait for the green check."
- If GitHub Actions billing gets resolved later, re-enabling `ci.yml`'s
  `pull_request:` trigger is a one-line revert of this doc's change — the
  workflow file itself is untouched otherwise.
- The hive-box build checkout (`/Users/dostal/hive-ci/heimdall`) needs the
  same Node version Heimdall requires (`>=22.5.0`) — confirmed present via
  `nvm` (`v24.18.1` at time of writing) — `hive-verify.sh` sources `nvm.sh`
  itself so it works whether invoked interactively or over a bare `ssh
  host command` (non-login shell, no profile sourced by default).
