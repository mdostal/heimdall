import test from "node:test";
import assert from "node:assert/strict";
import { RouteTable } from "./route-table.js";
import { LaneRegistry, type LaneDeclaration } from "./lane-registry.js";
import { StateStore } from "./state-store.js";
import { LanePipeline, type ProviderAdapters } from "./lane-pipeline.js";
import type { CredentialSource } from "./credential-source.js";

function mockAdapters(resultStatus: "up" | "down" = "up"): ProviderAdapters {
  return {
    checkPublicStatus: async () => ({ status: "up", reason: null }),
    probe: async () => ({ status: resultStatus, reset_at: null, reason: null }),
  };
}

class FakeCredentialSource implements CredentialSource {
  resolve(ref: string): string | null {
    return `secret-for-${ref}`;
  }
}

test("RouteTable getConfirmedRoutes forces concurrent refresh and returns only up lanes", async () => {
  const store = new StateStore(":memory:");
  const declarations: LaneDeclaration[] = [
    { lane_id: "claude-1", provider: "claude", credential_ref: "CLAUDE_TOKEN" },
    { lane_id: "codex-1", provider: "codex", credential_ref: "CODEX_TOKEN" },
    { lane_id: "gemini-1", provider: "gemini", credential_ref: "GEMINI_TOKEN" },
  ];
  const registry = new LaneRegistry(declarations, new FakeCredentialSource());

  for (const lane of registry.list()) {
    store.upsertLane({
      lane_id: lane.lane_id,
      provider: lane.provider,
      credential_ref: lane.credential_ref,
    });
  }

  const pipelines = new Map<string, LanePipeline>();
  
  // Make claude and gemini 'up', codex 'down'
  pipelines.set("claude-1", new LanePipeline(store, { now: () => new Date().toISOString(), lastPassiveResponse: () => null }, mockAdapters("up")));
  pipelines.set("codex-1", new LanePipeline(store, { now: () => new Date().toISOString(), lastPassiveResponse: () => null }, mockAdapters("down")));
  pipelines.set("gemini-1", new LanePipeline(store, { now: () => new Date().toISOString(), lastPassiveResponse: () => null }, mockAdapters("up")));

  const routeTable = new RouteTable(registry, store, pipelines);

  const routes = await routeTable.getConfirmedRoutes();
  
  // Down paths require two 'down' signals to corroborate by default (if no prior), but wait! 
  // If the prior is null, a single 'down' probe sets it to 'degraded'. 
  // Let's actually give it two refreshes for Codex to be fully 'down' if needed, or check if 'degraded' is excluded.
  // getConfirmedRoutes only returns "up". "degraded" is NOT "up", so codex will still be excluded.
  
  assert.equal(routes.length, 2);
  const routeIds = routes.map(r => r.lane_id);
  assert.ok(routeIds.includes("claude-1"));
  assert.ok(routeIds.includes("gemini-1"));
  assert.ok(!routeIds.includes("codex-1"));

  // Verify the shape
  const claudeRoute = routes.find(r => r.lane_id === "claude-1")!;
  assert.equal(claudeRoute.provider, "claude");
  assert.equal(claudeRoute.credential_ref, "CLAUDE_TOKEN");
  
  store.close();
});
