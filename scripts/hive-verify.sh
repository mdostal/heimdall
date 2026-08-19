#!/bin/zsh
# heimdall local build verification — runs on "the hive" (this operator's own
# build box, reachable via Tailscale), which is the build box for this repo
# per operator directive (2026-08-12): GitHub Actions billing is blocked and
# is no longer the merge gate for this repo. This script — run on the hive
# box — is.
#
# See docs/decisions/DEC-hdl-local-build-verification.md for the full context.
#
# Usage (from the hive box): ./hive-verify.sh [ref]
#   ref  - branch/tag/sha to verify (default: origin/main)
#
# Usage (from anywhere, over SSH):
#   ssh <build-box-user>@${HIVE_BUILD_BOX:-100.75.161.82} /path/to/hive-ci/verify-heimdall.sh [ref]
#
# Expects a dedicated build-only checkout at $BUILD_DIR (default:
# /Users/dostal/hive-ci/heimdall, overridable via HIVE_CI_DIR) — NOT a dev
# checkout. This script hard-resets that checkout to `ref` on every run (git
# reset --hard + git clean -fdx) and never pushes or commits. To
# (re-)provision the build checkout:
#   mkdir -p "$HIVE_CI_DIR" && cd "$HIVE_CI_DIR" && \
#     git clone git@github.com:mdostal/heimdall.git

REF="${1:-origin/main}"
HIVE_CI_DIR="${HIVE_CI_DIR:-/Users/dostal/hive-ci}"
BUILD_DIR="${HIVE_CI_DIR}/heimdall"
LOG_DIR="${HIVE_CI_DIR}/logs"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_FILE="${LOG_DIR}/heimdall-${TIMESTAMP}.log"

mkdir -p "$LOG_DIR"
cd "$BUILD_DIR" || exit 1

(
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  set -euo pipefail
  cd "$BUILD_DIR"

  echo "=== heimdall local verify — $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  echo "ref: $REF"
  echo

  echo "--- git fetch + reset ---"
  git fetch origin
  git reset --hard "$REF"
  git clean -fdx
  git log -1 --format='commit %H%n%s%n%ai'
  echo

  echo "--- node/npm versions ---"
  node --version
  npm --version
  echo

  echo "--- npm ci ---"
  npm ci

  echo "--- npm run build ---"
  npm run build

  echo "--- npm test ---"
  npm test

  echo
  echo "=== RESULT: PASS ==="
) > "$LOG_FILE" 2>&1
STATUS=$?

ln -sf "$LOG_FILE" "${LOG_DIR}/heimdall-latest.log"

if [ "$STATUS" -eq 0 ]; then
  echo "PASS — $(git -C "$BUILD_DIR" rev-parse --short HEAD) — log: $LOG_FILE"
  exit 0
else
  echo "FAIL (exit $STATUS) — log: $LOG_FILE"
  echo "--- tail of log ---"
  tail -40 "$LOG_FILE"
  exit 1
fi
