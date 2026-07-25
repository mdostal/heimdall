import { test } from "node:test";
import assert from "node:assert/strict";
import { MulticaControlAdapter } from "./multica-control-adapter.js";
import { MulticaRestClient, type MulticaCallResult, type MulticaAgent } from "./multica-rest-client.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import type { LaneAgentResolver } from "./lane-agent-resolver.js";
import type { Lane } from "../lane-registry.js";
import type { ArgusEmitter } from "../telemetry/argus-client.js";

const LANE: Lane = {
  lane_id: "claude@mathew.dostal",
  provider: "claude",
  credential_ref: "CLAUDE_TOKEN",
  credential: "fake",
};

function fakeResolver(mapping: Record<string, string[]>): LaneAgentResolver {
  return { resolve: (laneId) => mapping[laneId] ?? [] };
}

function fakeArgus(): ArgusEmitter & { results: unknown[] } {
  const results: unknown[] = [];
  return {
    results,
    emitTick: () => {},
    emitStatusFlip: () => {},
    emitActuationResult: (params) => results.push(params),
  };
}

/** A minimal fake standing in for MulticaRestClient — same public method shape. */
function fakeRestClient(overrides: {
  listAgents?: () => Promise<MulticaCallResult<MulticaAgent[]>>;
  updateAgent?: (id: string, patch: unknown) => Promise<MulticaCallResult<MulticaAgent>>;
}): MulticaRestClient {
  return {
    listAgents: overrides.listAgents ?? (async () => ({ status: "ok", data: [] })),
    updateAgent:
      overrides.updateAgent ??
      (async (id: string) => ({ status: "ok", data: { id, workspace_id: "w", max_concurrent_tasks: 1, status: "idle", visibility: "private" } })),
  } as unknown as MulticaRestClient;
}

test("disabling captures the agent's prior max_concurrent_tasks before setting it to 0", async () => {
  const updateCalls: unknown[] = [];
  const restClient = fakeRestClient({
    listAgents: async () => ({
      status: "ok",
      data: [{ id: "agent-a", workspace_id: "w", max_concurrent_tasks: 5, status: "idle", visibility: "private" }],
    }),
    updateAgent: async (id, patch) => {
      updateCalls.push({ id, patch });
      return { status: "ok", data: { id, workspace_id: "w", max_concurrent_tasks: 0, status: "idle", visibility: "private" } };
    },
  });
  const adapter = new MulticaControlAdapter({
    restClient,
    circuitBreaker: new CircuitBreaker(),
    resolver: fakeResolver({ [LANE.lane_id]: ["agent-a"] }),
    argus: fakeArgus(),
  });

  await adapter.reconcile(LANE, "down");

  assert.deepEqual(updateCalls, [{ id: "agent-a", patch: { max_concurrent_tasks: 0 } }]);
});

test("recovery restores the EXACT remembered prior max_concurrent_tasks value", async () => {
  const updateCalls: Array<{ id: string; patch: unknown }> = [];
  const restClient = fakeRestClient({
    listAgents: async () => ({
      status: "ok",
      data: [{ id: "agent-a", workspace_id: "w", max_concurrent_tasks: 5, status: "idle", visibility: "private" }],
    }),
    updateAgent: async (id, patch) => {
      updateCalls.push({ id, patch });
      return { status: "ok", data: { id, workspace_id: "w", max_concurrent_tasks: 0, status: "idle", visibility: "private" } };
    },
  });
  const adapter = new MulticaControlAdapter({
    restClient,
    circuitBreaker: new CircuitBreaker(),
    resolver: fakeResolver({ [LANE.lane_id]: ["agent-a"] }),
    argus: fakeArgus(),
  });

  await adapter.reconcile(LANE, "down"); // disables, captures prior=5
  await adapter.reconcile(LANE, "up"); // should restore to 5, not a default

  assert.deepEqual(updateCalls[1], { id: "agent-a", patch: { max_concurrent_tasks: 5 } });
});

test("a failed disable attempt is retried on the next reconcile() call with no new transition", async () => {
  let attempt = 0;
  const restClient = fakeRestClient({
    listAgents: async () => ({
      status: "ok",
      data: [{ id: "agent-a", workspace_id: "w", max_concurrent_tasks: 5, status: "idle", visibility: "private" }],
    }),
    updateAgent: async (id) => {
      attempt += 1;
      if (attempt === 1) return { status: "unreachable", message: "timeout" };
      return { status: "ok", data: { id, workspace_id: "w", max_concurrent_tasks: 0, status: "idle", visibility: "private" } };
    },
  });
  const adapter = new MulticaControlAdapter({
    restClient,
    circuitBreaker: new CircuitBreaker(),
    resolver: fakeResolver({ [LANE.lane_id]: ["agent-a"] }),
    argus: fakeArgus(),
  });

  await adapter.reconcile(LANE, "down"); // fails
  await adapter.reconcile(LANE, "down"); // SAME status, no new transition — must retry anyway

  assert.equal(attempt, 2, "the second reconcile() call (same status) must retry the failed attempt");
});

test("desired state already matching last-applied state makes NO API call (true idempotent no-op)", async () => {
  let updateCallCount = 0;
  const restClient = fakeRestClient({
    listAgents: async () => ({
      status: "ok",
      data: [{ id: "agent-a", workspace_id: "w", max_concurrent_tasks: 5, status: "idle", visibility: "private" }],
    }),
    updateAgent: async (id) => {
      updateCallCount += 1;
      return { status: "ok", data: { id, workspace_id: "w", max_concurrent_tasks: 0, status: "idle", visibility: "private" } };
    },
  });
  const adapter = new MulticaControlAdapter({
    restClient,
    circuitBreaker: new CircuitBreaker(),
    resolver: fakeResolver({ [LANE.lane_id]: ["agent-a"] }),
    argus: fakeArgus(),
  });

  await adapter.reconcile(LANE, "down"); // disables (1 call)
  await adapter.reconcile(LANE, "down"); // still down — no new call
  await adapter.reconcile(LANE, "degraded"); // still suspect — desiredEnabled unchanged — no new call

  assert.equal(updateCallCount, 1, "only the first genuinely-mismatched reconcile should call updateAgent");
});

test("1:N lane->agent mapping: 2 of 3 agents succeed, 1 fails — logged, not rolled back", async () => {
  const restClient = fakeRestClient({
    listAgents: async () => ({
      status: "ok",
      data: [
        { id: "agent-a", workspace_id: "w", max_concurrent_tasks: 5, status: "idle", visibility: "private" },
        { id: "agent-b", workspace_id: "w", max_concurrent_tasks: 5, status: "idle", visibility: "private" },
        { id: "agent-c", workspace_id: "w", max_concurrent_tasks: 5, status: "idle", visibility: "private" },
      ],
    }),
    updateAgent: async (id) => {
      if (id === "agent-b") return { status: "http_error", httpStatus: 500, message: "server error" };
      return { status: "ok", data: { id, workspace_id: "w", max_concurrent_tasks: 0, status: "idle", visibility: "private" } };
    },
  });
  const argus = fakeArgus();
  const adapter = new MulticaControlAdapter({
    restClient,
    circuitBreaker: new CircuitBreaker(),
    resolver: fakeResolver({ [LANE.lane_id]: ["agent-a", "agent-b", "agent-c"] }),
    argus,
  });

  await assert.doesNotReject(() => adapter.reconcile(LANE, "down"));

  const disableResults = argus.results.filter(
    (r) => (r as { action: string }).action === "disable",
  ) as Array<{ agentId: string; success: boolean }>;
  assert.equal(disableResults.find((r) => r.agentId === "agent-a")?.success, true);
  assert.equal(disableResults.find((r) => r.agentId === "agent-b")?.success, false);
  assert.equal(disableResults.find((r) => r.agentId === "agent-c")?.success, true);
});

test("every reconcile attempt (success or failure) emits an Argus actuation result", async () => {
  const argus = fakeArgus();
  const restClient = fakeRestClient({
    listAgents: async () => ({
      status: "ok",
      data: [{ id: "agent-a", workspace_id: "w", max_concurrent_tasks: 5, status: "idle", visibility: "private" }],
    }),
  });
  const adapter = new MulticaControlAdapter({
    restClient,
    circuitBreaker: new CircuitBreaker(),
    resolver: fakeResolver({ [LANE.lane_id]: ["agent-a"] }),
    argus,
  });

  await adapter.reconcile(LANE, "down");
  assert.ok(argus.results.length >= 1);
});

test("an unmapped lane (empty resolver result) reconciles as a no-op — no API calls, no crash", async () => {
  let called = false;
  const restClient = fakeRestClient({
    listAgents: async () => {
      called = true;
      return { status: "ok", data: [] };
    },
  });
  const adapter = new MulticaControlAdapter({
    restClient,
    circuitBreaker: new CircuitBreaker(),
    resolver: fakeResolver({}), // no mapping at all
    argus: fakeArgus(),
  });

  await assert.doesNotReject(() => adapter.reconcile(LANE, "down"));
  assert.equal(called, false);
});
