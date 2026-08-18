#!/usr/bin/env bash
# scripts/install.sh — Heimdall install-and-onboard script.
#
# NOTE: This script is not yet reachable via a live curl URL (e.g.
# `curl -fsSL https://.../install.sh | bash`). Publishing it to GitHub Pages
# so it can be curled is story hdl-ao-06, not this one — for now it's meant
# to be run locally from a checkout (`bash scripts/install.sh`) or fetched
# manually.
#
# Core logic (intentionally just these two steps):
#   1. npm install -g pantheon-heimdall
#   2. heimdall agent init
#
# Everything else below is error handling around that core, not extra scope.

set -euo pipefail

PACKAGE_NAME="pantheon-heimdall"
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

echo "Installing ${PACKAGE_NAME} globally via npm..."
if ! npm install -g "${PACKAGE_NAME}"; then
  err "npm install -g ${PACKAGE_NAME} failed."
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
