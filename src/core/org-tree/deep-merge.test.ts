import { test } from "node:test";
import assert from "node:assert/strict";
import { deepMergeContext } from "./deep-merge.js";

test("child scalar values override parent scalar values", () => {
  const merged = deepMergeContext(
    { brand: "shared", retries: 1 },
    { brand: "lane-specific" },
  );

  assert.deepEqual(merged, { brand: "lane-specific", retries: 1 });
});

test("arrays are concatenated in parent then child order", () => {
  const merged = deepMergeContext(
    { tools: ["status", "scheduler"] },
    { tools: ["actuation"] },
  );

  assert.deepEqual(merged, { tools: ["status", "scheduler", "actuation"] });
});

test("objects are deep-merged without replacing the whole parent object", () => {
  const merged = deepMergeContext(
    {
      tone: {
        style: "minimal",
        accessibility: { contrast: "high", motion: "reduced" },
      },
    },
    {
      tone: {
        accessibility: { motion: "normal" },
        density: "compact",
      },
    },
  );

  assert.deepEqual(merged, {
    tone: {
      style: "minimal",
      accessibility: { contrast: "high", motion: "normal" },
      density: "compact",
    },
  });
});

test("nested arrays inside merged objects are concatenated", () => {
  const merged = deepMergeContext(
    { prompts: { guardrails: ["cite sources"] } },
    { prompts: { guardrails: ["stay concise"] } },
  );

  assert.deepEqual(merged, {
    prompts: { guardrails: ["cite sources", "stay concise"] },
  });
});

test("incompatible value types resolve to the child value", () => {
  const merged = deepMergeContext(
    { limits: { max_parallel: 4 }, mode: ["sense"] },
    { limits: "unbounded", mode: "actuate" },
  );

  assert.deepEqual(merged, { limits: "unbounded", mode: "actuate" });
});

test("merge result does not mutate or retain references to input objects", () => {
  const parent = { nested: { tags: ["shared"] } };
  const child = { nested: { tags: ["specific"] } };

  const merged = deepMergeContext(parent, child);
  (merged.nested as { tags: string[] }).tags.push("local edit");

  assert.deepEqual(parent, { nested: { tags: ["shared"] } });
  assert.deepEqual(child, { nested: { tags: ["specific"] } });
});

test("circular context objects fail explicitly instead of recursing forever", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  assert.throws(
    () => deepMergeContext({}, { circular }),
    /circular org-tree context objects/,
  );
});
