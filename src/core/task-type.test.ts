import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTaskType, TASK_TYPES } from "./task-type.js";
import * as routeSelector from "./route-selector.js";

test("task-type: the task types are exactly planning, build and review", () => {
  assert.deepEqual([...TASK_TYPES], ["planning", "build", "review"]);
});

test("task-type: parseTaskType accepts every declared task type as-is", () => {
  for (const taskType of TASK_TYPES) {
    assert.equal(parseTaskType(taskType), taskType);
  }
});

for (const value of [null, "", "Build", "BUILD", " build", "build ", "deploy", "plan", "reviews"]) {
  test(`task-type: parseTaskType rejects ${JSON.stringify(value)}`, () => {
    assert.equal(parseTaskType(value), null);
  });
}

test("task-type: route-selector re-exports the same values for existing callers", () => {
  assert.equal(routeSelector.TASK_TYPES, TASK_TYPES);
  assert.equal(routeSelector.parseTaskType, parseTaskType);
});
