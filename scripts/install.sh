#!/usr/bin/env bash
# scripts/install.sh — Heimdall install-and-onboard script.
#
# Live on GitHub Pages (hdl-ao-06) — fetch and run directly with:
#   curl -fsSL https://mdostal.github.io/heimdall/install.sh | bash
#

# Core logic (intentionally just these two steps):
#   1. npm install -g <source>
#   2. heimdall agent init
#
# Everything else below is error handling around that core, not extra scope.
#
# t-003 (.pHive/triage/queue.yaml): `pantheon-heimdall` is not yet published
# to the real npm registry — installs straight from the GitHub repo, pinned
# to `main` (which only moves on a deliberate, verified release cut — see
# docs/decisions/DEC-hdl-local-build-verification.md), via `npm install -g
# git+https://...`. npm runs this package's own "prepare" script (`npm run
# build`) automatically for a git-sourced install, so `dist/` — normally
# gitignored and npm-registry-only — gets built locally as part of the
# install. Switch INSTALL_SOURCE back to the plain npm package name once
# publishing catches up; nothing else in this script needs to change.

set -euo pipefail

PACKAGE_NAME="pantheon-heimdall"
INSTALL_SOURCE="git+https://github.com/mdostal/heimdall.git#main"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=13

err() {
  echo "error: $*" >&2
}

if ! command -v npm >/dev/null 2>&1; then
  err "npm was not found on PATH."
  err "Install Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0 (which bundles npm) and re-run this script."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  err "node was not found on PATH."
  err "Install Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0 and re-run this script."
  exit 1
fi

node_version="$(node --version)"
node_version="${node_version#v}"
node_major="${node_version%%.*}"
node_rest="${node_version#*.}"
node_minor="${node_rest%%.*}"

if [ "$node_major" -lt "$MIN_NODE_MAJOR" ] || { [ "$node_major" -eq "$MIN_NODE_MAJOR" ] && [ "$node_minor" -lt "$MIN_NODE_MINOR" ]; }; then
  err "Heimdall requires Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0, but found ${node_version}."
  err "Upgrade Node.js and re-run this script."
  exit 1
fi

echo "Installing ${PACKAGE_NAME} globally (from ${INSTALL_SOURCE})..."
if ! npm install -g "${INSTALL_SOURCE}"; then
  err "npm install -g ${INSTALL_SOURCE} failed."
  err "If this is a permissions error, see: https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally"
  exit 1
fi

if ! command -v heimdall >/dev/null 2>&1; then
  err "Installed ${PACKAGE_NAME}, but the 'heimdall' command was not found on PATH."
  err "Check that npm's global bin directory is on your PATH (npm config get prefix)."
  exit 1
fi

echo "Running 'heimdall agent init'..."
if ! heimdall agent init; then
  err "'heimdall agent init' failed. You can re-run it manually with: heimdall agent init"
  exit 1
fi

echo "Heimdall is installed and your agent harness has been onboarded."
