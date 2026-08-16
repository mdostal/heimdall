#!/usr/bin/env bash
# Stages a self-contained copy of the compiled Heimdall service into
# src-tauri/resources/heimdall/, bundled into the .app via tauri.conf.json's
# bundle.resources -- so the installed app never depends on the git
# checkout's own path still existing.
#
# Unlike Portunus's Next.js `standalone` build, Heimdall's plain `tsc`
# output does NOT self-bundle its own npm dependencies -- they must be
# staged alongside it explicitly. Runtime deps are installed via a clean
# `npm ci --omit=dev` INSIDE the staging directory (not the live checkout's
# own node_modules) so the developer's own devDependencies (tsx, the test
# runner, typescript itself) are never touched and never ship in the app.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."  # repo root (app/src-tauri/../..)
REPO_ROOT="$(pwd)"
STAGE="$REPO_ROOT/app/src-tauri/resources/heimdall"

echo "building heimdall (tsc)..."
npm run build

rm -rf "$STAGE"
mkdir -p "$STAGE"

cp -R "$REPO_ROOT/dist" "$STAGE/dist"
cp "$REPO_ROOT/package.json" "$STAGE/package.json"
cp "$REPO_ROOT/package-lock.json" "$STAGE/package-lock.json"
if [ -d "$REPO_ROOT/docs" ]; then
  cp -R "$REPO_ROOT/docs" "$STAGE/docs"
fi

echo "installing production dependencies into staged copy..."
(cd "$STAGE" && npm ci --omit=dev)
rm -f "$STAGE/package-lock.json"

echo "staged Heimdall build -> $STAGE"
