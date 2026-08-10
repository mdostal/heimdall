// e2e: Minerva route-selection handshake vs a live Heimdall :PORT instance.
//
// Simulates the handshake a consumer (Auriga/Minerva) performs against a
// REAL running Heimdall process — not composeService() in-process, an actual
// child process bound to a real TCP port and a real MCP stdio server — with
// >=2 declared lanes (one "up", one "out_of_credit").
//
// Root-caused goblin this guards against (see the story's NOTE): the live
// :4870 instance was observed returning `[]` from GET /lanes because no
// lanes were declared for it. A unit test against composeService() with
// injected lanes wouldn't have caught that — only a real process, started
// the way the real deployment starts it (env-var lane declarations, real
// port, real MCP transport), can.
//
// The lane-selection logic itself belongs to the CONSUMER, not Heimdall
// (see .pHive/planning/prd.md: "Any lane selection logic — P0 only reports
// status, never chooses a lane"). selectRoutableLane() below stands in for
// that consumer-side handshake — it is deliberately NOT exported from src/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StateStore } from "../../src/core/state-store.js";
import { LANES_LIST_TOOL_NAME } from "../../src/api/mcp-server.js";
import type { LaneStatus } from "../../src/core/status-model.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const READY_TIMEOUT_MS = 10_000;
const READY_POLL_INTERVAL_MS = 100;

const UP_LANE = {
  lane_id: "claude@mathew.dostal",
  provider: "claude",
  credential_ref: "E2E_CLAUDE_TOKEN",
};
const OUT_OF_CREDIT_LANE = {
  lane_id: "codex@mathew.dostal",
  provider: "codex",
  credential_ref: "E2E_CODEX_TOKEN",
};

/**
 * Stands in for the consumer-side (Minerva/Auriga) route-selection handshake
 * against Heimdall's LaneRouterContract response — never picks a lane that
 * isn't reporting "up".
 */
function selectRoutableLane(lanes: LaneStatus[]): LaneStatus | null {
  return lanes.find((lane) => lane.status === "up") ?? null;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, () => {
      const address = srv.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not determine a free port"));
        return;
      }
      const { port } = address;
      srv.close(() => resolve(port));
    });
  });
}

function seedTwoLanes(dbPath: string): void {
  const store = new StateStore(dbPath);
  const observedAt = "2026-08-05T12:00:00.000Z";

  store.upsertLane(UP_LANE);
  store.recordStatus({
    lane_id: UP_LANE.lane_id,
    status: "up",
    reset_at: "2026-08-06T00:00:00.000Z",
    reason: "all signals healthy",
    signal_source: "active_probe",
    observed_at: observedAt,
  });

  store.upsertLane(OUT_OF_CREDIT_LANE);
  store.recordStatus({
    lane_id: OUT_OF_CREDIT_LANE.lane_id,
    status: "out_of_credit",
    reset_at: "2026-08-12T00:00:00.000Z",
    reason: "weekly quota exhausted",
    signal_source: "public_status",
    observed_at: observedAt,
  });

  store.close();
}

function childEnv(extra: Record<string, string>): Record<string, string> {
  return {
    // PATH so `node`/`tsx` resolve; nothing else inherited — the real
    // MULTICA_*/ARGUS_* env is deliberately withheld so this run can never
    // hit the real Multica workspace or a real Argus collector.
    PATH: process.env.PATH ?? "",
    HEIMDALL_LANE_1_ID: UP_LANE.lane_id,
    HEIMDALL_LANE_1_PROVIDER: UP_LANE.provider,
    HEIMDALL_LANE_1_CREDENTIAL_REF: UP_LANE.credential_ref,
    [UP_LANE.credential_ref]: "fake-claude-secret",
    HEIMDALL_LANE_2_ID: OUT_OF_CREDIT_LANE.lane_id,
    HEIMDALL_LANE_2_PROVIDER: OUT_OF_CREDIT_LANE.provider,
    HEIMDALL_LANE_2_CREDENTIAL_REF: OUT_OF_CREDIT_LANE.credential_ref,
    [OUT_OF_CREDIT_LANE.credential_ref]: "fake-codex-secret",
    ...extra,
  };
}

async function waitForHealthz(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`heimdall process exited early (code ${child.exitCode}) before becoming ready`);
    }
    try {
      const res = await fetch(`http://localhost:${port}/healthz`);
      if (res.status === 200) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  }
  throw new Error(`heimdall never became ready on port ${port}: ${String(lastErr)}`);
}

function assertLaneShape(lane: LaneStatus): void {
  assert.equal(typeof lane.lane_id, "string");
  assert.ok(lane.lane_id.length > 0, "lane_id must be non-empty");
  assert.equal(typeof lane.status, "string");
  assert.ok(lane.status.length > 0, "status must be non-empty");
  assert.equal(typeof lane.reset_at, "string");
  assert.ok(lane.reset_at && lane.reset_at.length > 0, "reset_at must be non-empty");
  assert.equal(typeof lane.reason, "string");
  assert.ok(lane.reason && lane.reason.length > 0, "reason must be non-empty");
}

test("Minerva route-selection handshake vs live :PORT with >=2 declared lanes", async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), "heimdall-e2e-"));
  const dbPath = join(workDir, "heimdall.sqlite");
  seedTwoLanes(dbPath);

  const port = await getFreePort();
  const env = childEnv({ PORT: String(port), HEIMDALL_DB_PATH: dbPath });

  const httpChild = spawn(
    process.execPath,
    ["--experimental-sqlite", "--import", "tsx", "src/main.ts"],
    // stderr inherited so a startup failure's stack trace shows up directly
    // in the test runner's output instead of being swallowed.
    { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "inherit"] },
  );

  t.after(() => {
    httpChild.kill();
    rmSync(workDir, { recursive: true, force: true });
  });

  await waitForHealthz(port, httpChild);

  // AC1 (HTTP): GET /lanes returns ALL declared lanes, real port, non-empty fields.
  const res = await fetch(`http://localhost:${port}/lanes`);
  assert.equal(res.status, 200);
  const lanes = (await res.json()) as LaneStatus[];
  assert.equal(lanes.length, 2, `expected 2 declared lanes, got ${lanes.length}: ${JSON.stringify(lanes)}`);
  for (const lane of lanes) assertLaneShape(lane);

  const httpUpLane = lanes.find((l) => l.lane_id === UP_LANE.lane_id);
  const httpOutOfCreditLane = lanes.find((l) => l.lane_id === OUT_OF_CREDIT_LANE.lane_id);
  assert.ok(httpUpLane, `${UP_LANE.lane_id} missing from GET /lanes response`);
  assert.ok(httpOutOfCreditLane, `${OUT_OF_CREDIT_LANE.lane_id} missing from GET /lanes response`);
  assert.equal(httpUpLane!.status, "up");
  assert.equal(httpOutOfCreditLane!.status, "out_of_credit");

  // AC1 (MCP): heimdall.lanes.list returns the identical set over stdio, real process.
  const mcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-sqlite", "--import", "tsx", "src/api/mcp-server.ts"],
    cwd: REPO_ROOT,
    env,
  });
  const mcpClient = new Client({ name: "heimdall-e2e-test", version: "0.0.0" });
  t.after(async () => {
    await mcpClient.close().catch(() => {});
  });
  await mcpClient.connect(mcpTransport);

  const toolsList = await mcpClient.listTools();
  assert.ok(
    toolsList.tools.some((tool) => tool.name === LANES_LIST_TOOL_NAME),
    `${LANES_LIST_TOOL_NAME} not advertised by the live MCP server`,
  );

  const toolResult = await mcpClient.callTool({ name: LANES_LIST_TOOL_NAME, arguments: {} });
  const content = toolResult.content as Array<{ type: string; text: string }>;
  const mcpLanes = JSON.parse(content[0].text) as LaneStatus[];
  assert.equal(mcpLanes.length, 2, `MCP tool returned ${mcpLanes.length} lanes, expected 2`);
  for (const lane of mcpLanes) assertLaneShape(lane);
  assert.deepEqual(
    [...mcpLanes].sort((a, b) => a.lane_id.localeCompare(b.lane_id)),
    [...lanes].sort((a, b) => a.lane_id.localeCompare(b.lane_id)),
    "MCP heimdall.lanes.list must return the same lane data as GET /lanes",
  );

  // AC2: the consumer-side selection helper picks the up lane and never an
  // out_of_credit/down lane — checked against both transports' responses.
  const selectedFromHttp = selectRoutableLane(lanes);
  assert.ok(selectedFromHttp);
  assert.equal(selectedFromHttp!.lane_id, UP_LANE.lane_id);
  assert.notEqual(selectedFromHttp!.status, "out_of_credit");
  assert.notEqual(selectedFromHttp!.status, "down");

  const selectedFromMcp = selectRoutableLane(mcpLanes);
  assert.ok(selectedFromMcp);
  assert.equal(selectedFromMcp!.lane_id, UP_LANE.lane_id);

  // Never a false positive: with no "up" lane present, the helper must return
  // null rather than falling back to a down/out_of_credit lane.
  const noUpLanes = lanes.filter((l) => l.status !== "up");
  assert.ok(noUpLanes.length > 0, "sanity: fixture must include at least one non-up lane");
  assert.equal(selectRoutableLane(noUpLanes), null);
});
