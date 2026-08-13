// .env append utility (hdl-lm-01) — the write side of add-lane. Appends a
// new HEIMDALL_LANE_<N>_* block (+ its secret line) to a local, gitignored
// .env file, matching .env.example's exact format. Never touches existing
// lines; never automatically restarts the process (see
// .pHive/epics/hdl-lane-management/docs/design-discussion.md — that's a
// deliberate non-goal, not an oversight).
//
// Local-secrets-only, by explicit operator direction (2026-08-13): this is
// the REQ-07 stopgap, same as every other credential in this codebase.
// Portunus is the future fix for secret storage, not this utility.

import { readFileSync, existsSync, appendFileSync, writeFileSync } from "node:fs";

const LANE_INDEX_RE_ALL = /^HEIMDALL_LANE_(\d+)_ID=/gm;

export interface NewLane {
  lane_id: string;
  provider: string;
  model: string;
  credential_ref: string;
  token: string;
}

/**
 * Deterministic credential_ref derivation: uppercase, non-alphanumeric runs
 * collapsed to a single underscore, leading/trailing underscores trimmed,
 * "_TOKEN" suffix. "gemini@ops" -> "GEMINI_OPS_TOKEN", matching the style of
 * the existing CLAUDE_MATHEW_DOSTAL_TOKEN / CODEX_TOKEN examples closely
 * enough to stay readable, and guaranteeing no naming collision with an
 * operator-chosen scheme.
 */
export function deriveCredentialRef(laneId: string): string {
  const sanitized = laneId
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${sanitized}_TOKEN`;
}

/** Highest existing HEIMDALL_LANE_<N>_ID index in the file, or 0 if none / file doesn't exist yet. */
export function highestLaneIndex(envFilePath: string): number {
  if (!existsSync(envFilePath)) return 0;
  const content = readFileSync(envFilePath, "utf8");
  let max = 0;
  for (const match of content.matchAll(LANE_INDEX_RE_ALL)) {
    const n = Number(match[1]);
    if (n > max) max = n;
  }
  return max;
}

/**
 * Appends a new lane's declaration block to the .env file at envFilePath.
 * Idempotent-safe against missing trailing newlines and pre-existing
 * comments — reads the current content, ensures it ends with exactly one
 * newline before appending, never rewrites existing lines. Creates the file
 * if it doesn't exist yet.
 */
export function appendLane(envFilePath: string, lane: NewLane): { index: number } {
  const nextIndex = highestLaneIndex(envFilePath) + 1;
  const block = [
    `HEIMDALL_LANE_${nextIndex}_ID=${lane.lane_id}`,
    `HEIMDALL_LANE_${nextIndex}_PROVIDER=${lane.provider}`,
    `HEIMDALL_LANE_${nextIndex}_MODEL=${lane.model}`,
    `HEIMDALL_LANE_${nextIndex}_CREDENTIAL_REF=${lane.credential_ref}`,
    `${lane.credential_ref}=${lane.token}`,
    "",
  ].join("\n");

  if (!existsSync(envFilePath)) {
    writeFileSync(envFilePath, block, "utf8");
    return { index: nextIndex };
  }

  const existing = readFileSync(envFilePath, "utf8");
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(envFilePath, separator + block, "utf8");
  return { index: nextIndex };
}

/** True if lane_id is already declared anywhere in the file. */
export function laneIdAlreadyDeclared(envFilePath: string, laneId: string): boolean {
  if (!existsSync(envFilePath)) return false;
  const content = readFileSync(envFilePath, "utf8");
  const idLineRe = new RegExp(`^HEIMDALL_LANE_\\d+_ID=${escapeRegExp(laneId)}$`, "m");
  return idLineRe.test(content);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
