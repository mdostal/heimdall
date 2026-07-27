import { describe, it } from "node:test";
import assert from "node:assert";
import { RouteSelector, RoutingPolicy, TaskDescriptor } from "./route-selector.js";
import { LaneStatus } from "../status-model.js";

describe("RouteSelector", () => {
  const policy: RoutingPolicy = {
    rules: [
      {
        task_types: ["premium", "architecture"],
        lanes: [
          { provider: "claude", cost: 10, weight: 1 },
          { provider: "fable", cost: 10, weight: 2 }, // Same cost, higher weight (more headroom)
          { provider: "codex", cost: 15, weight: 1 },
        ],
      },
      {
        task_types: ["bulk", "grunt"],
        lanes: [
          { provider: "ollama-local", cost: 0, weight: 1 },
          { provider: "gemini-3-pro", cost: 5, weight: 1 },
          // No claude or fable allowed here -> no hard-coded rules, purely policy
        ],
      },
    ],
    default_rule: {
      task_types: ["*"],
      lanes: [
        { provider: "claude", cost: 10, weight: 1 },
        { provider: "gemini-3-pro", cost: 5, weight: 1 },
      ],
    },
  };

  const selector = new RouteSelector(policy);

  const mockStatuses: LaneStatus[] = [
    { lane_id: "lane-1", provider: "claude", status: "up", reset_at: null, reason: null, last_updated: "", signal_source: "passive" },
    { lane_id: "lane-2", provider: "fable", status: "up", reset_at: null, reason: null, last_updated: "", signal_source: "passive" },
    { lane_id: "lane-3", provider: "codex", status: "down", reset_at: null, reason: null, last_updated: "", signal_source: "passive" },
    { lane_id: "lane-4", provider: "ollama-local", status: "up", reset_at: null, reason: null, last_updated: "", signal_source: "passive" },
    { lane_id: "lane-5", provider: "gemini-3-pro", status: "out_of_credit", reset_at: null, reason: null, last_updated: "", signal_source: "passive" },
  ];

  it("routes premium tasks to healthy premium providers sorted by cost and weight", () => {
    const task: TaskDescriptor = { task_type: "premium" };
    const ranked = selector.select(mockStatuses, task);

    assert.strictEqual(ranked.length, 2);
    // Both claude and fable are up and cost 10.
    // Fable has higher weight (2 vs 1), so it should rank first.
    assert.strictEqual(ranked[0].provider, "fable");
    assert.strictEqual(ranked[1].provider, "claude");
  });

  it("excludes down or out_of_credit lanes", () => {
    const task: TaskDescriptor = { task_type: "bulk" };
    const ranked = selector.select(mockStatuses, task);

    // gemini-3-pro is out_of_credit, so it should be excluded
    // ollama-local is up and has cost 0
    assert.strictEqual(ranked.length, 1);
    assert.strictEqual(ranked[0].provider, "ollama-local");
  });

  it("falls back to default rule if task type is unknown", () => {
    const task: TaskDescriptor = { task_type: "unknown" };
    const ranked = selector.select(mockStatuses, task);

    // Default rule allows claude and gemini. gemini is out_of_credit.
    assert.strictEqual(ranked.length, 1);
    assert.strictEqual(ranked[0].provider, "claude");
  });

  it("supports lane_id specific overrides", () => {
    const specificPolicy: RoutingPolicy = {
      rules: [
        {
          task_types: ["test"],
          lanes: [
            { provider: "claude", cost: 10, weight: 1 },
            { lane_id: "lane-1", cost: 2, weight: 1 }, // specific lane override
          ],
        },
      ],
    };
    const specificSelector = new RouteSelector(specificPolicy);
    const task: TaskDescriptor = { task_type: "test" };
    const ranked = specificSelector.select(mockStatuses, task);

    assert.strictEqual(ranked.length, 1);
    assert.strictEqual(ranked[0].cost, 2); // picked up the lane_id override
  });
});
