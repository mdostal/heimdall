#!/usr/bin/env node
// CLI surface for the LaneRouterContract (REQ-05) — calls the same shared
// getLaneStatuses() core function as http-server.ts and mcp-server.ts; no
// duplicated query logic. `--format table` for a human-readable table,
// JSON (default) for scripting.

import { buildLaneRegistry, getLaneStatuses } from "./http-server.js";
import { StateStore, resolveDefaultDbPath } from "../core/state-store.js";
import type { LaneStatus } from "../core/status-model.js";
import { runRouteCommand, runRouteOutcomeCommand } from "../cli/route-command.js";

export function formatAsTable(lanes: readonly LaneStatus[]): string {
  if (lanes.length === 0) return "No lanes configured.";

  const headers = ["LANE_ID", "PROVIDER", "STATUS", "RESET_AT", "REASON", "LAST_UPDATED", "SOURCE"];
  const rows = lanes.map((lane) => [
    lane.lane_id,
    lane.provider,
    lane.status,
    lane.reset_at ?? "-",
    lane.reason ?? "-",
    lane.last_updated,
    lane.signal_source,
  ]);
  const widths = headers.map((header, col) =>
    Math.max(header.length, ...rows.map((row) => row[col].length)),
  );
  const formatRow = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i])).join("  ");

  return [formatRow(headers), ...rows.map(formatRow)].join("\n");
}

export function formatAsJson(lanes: readonly LaneStatus[]): string {
  return JSON.stringify(lanes, null, 2);
}

export type OutputFormat = "json" | "table";

export function renderLanes(lanes: readonly LaneStatus[], format: OutputFormat): string {
  return format === "table" ? formatAsTable(lanes) : formatAsJson(lanes);
}

export function parseFormatFlag(argv: string[]): OutputFormat {
  const index = argv.indexOf("--format");
  const value = index !== -1 ? argv[index + 1] : undefined;
  return value === "table" ? "table" : "json";
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  const args = process.argv.slice(2);
  const command = args[0] && !args[0].startsWith("--") ? args[0] : "lanes";

  const registry = buildLaneRegistry();
  const store = new StateStore(resolveDefaultDbPath());
  
  try {
    if (command === "route") {
      runRouteCommand(args.slice(1), registry, store);
    } else if (command === "route-outcome") {
      runRouteOutcomeCommand(args.slice(1));
    } else {
      const lanes = getLaneStatuses(registry, store);
      console.log(renderLanes(lanes, parseFormatFlag(args)));
    }
  } finally {
    store.close();
  }
}
