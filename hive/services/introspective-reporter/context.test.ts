import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { IntrospectionContext, type IntrospectionLogger } from "./context.js";
import { assertValidFinding, validateFinding, type FailureDetector } from "./detector/types.js";

const tempRoots: string[] = [];

after(async () => {
  await Promise.all(tempRoots.map((tempRoot) => fs.rm(tempRoot, { recursive: true, force: true })));
});

async function makeTempRoot(): Promise<string> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "heimdall-introspection-"));
  tempRoots.push(tempRoot);
  return tempRoot;
}

test("IntrospectionContext snapshots queue, cycle-state, router log, and agent logs", async () => {
  const rootDir = await makeTempRoot();
  const homeDir = path.join(rootDir, "home");
  await fs.mkdir(path.join(rootDir, ".pHive", "cycle-state"), { recursive: true });
  await fs.mkdir(path.join(homeDir, ".claude", "hive", "logs", "agents"), { recursive: true });
  await fs.writeFile(path.join(rootDir, ".pHive", "queue.yaml"), "items:\n  - id: task-1\n");
  await fs.writeFile(path.join(rootDir, ".pHive", "cycle-state", "introspection-loop.yaml"), "phase: build\n");
  await fs.writeFile(path.join(homeDir, ".claude", "hive", "logs", "router.log"), "router ready\n");
  await fs.writeFile(path.join(homeDir, ".claude", "hive", "logs", "agents", "developer.log"), "agent ready\n");

  const context = await IntrospectionContext.create({
    rootDir,
    homeDir,
    now: () => new Date("2026-07-28T02:30:00.000Z"),
  });

  assert.equal(context.getQueueYaml().content, "items:\n  - id: task-1\n");
  assert.equal(context.getCycleState("introspection-loop")?.content, "phase: build\n");
  assert.equal(context.getRouterLog().content, "router ready\n");
  assert.equal(context.getAgentLog("developer")?.content, "agent ready\n");
  assert.equal(context.snapshot().created_at.toISOString(), "2026-07-28T02:30:00.000Z");
});

test("IntrospectionContext degrades gracefully when sources are missing", async () => {
  const rootDir = await makeTempRoot();
  const events: Array<{ level: "info" | "warn"; message: string; fields: Record<string, unknown> }> = [];
  const logger: IntrospectionLogger = {
    info: (message, fields) => events.push({ level: "info", message, fields }),
    warn: (message, fields) => events.push({ level: "warn", message, fields }),
  };

  const context = await IntrospectionContext.create({ rootDir, homeDir: path.join(rootDir, "home"), logger });

  assert.equal(context.getQueueYaml().available, false);
  assert.equal(context.getQueueYaml().content, null);
  assert.match(context.getQueueYaml().error ?? "", /ENOENT/);
  assert.deepEqual(context.listCycleStates(), []);
  assert.equal(context.getRouterLog().available, false);
  assert.deepEqual(context.listAgentLogs(), []);
  assert.ok(events.some((event) => event.level === "warn" && event.fields.kind === "queue"));
});

test("FailureDetector implementations return Finding arrays through the standard contract", async () => {
  const context = await IntrospectionContext.create({
    rootDir: await makeTempRoot(),
    now: () => new Date("2026-07-28T02:40:00.000Z"),
  });
  const detector: FailureDetector = {
    name: "missing-queue",
    async detect(detectorContext) {
      if (detectorContext.getQueueYaml().available) return [];
      return [
        {
          id: "missing-queue",
          category: "infra",
          severity: "low",
          title: "Queue YAML unavailable",
          description: "The Hive queue source could not be read.",
          evidence: detectorContext.getQueueYaml(),
          auto_recoverable: false,
          timestamp: new Date("2026-07-28T02:40:00.000Z"),
        },
      ];
    },
  };

  const findings = await detector.detect(context);

  assert.equal(findings.length, 1);
  assertValidFinding(findings[0]);
});

test("validateFinding reports missing required fields", () => {
  const result = validateFinding({
    id: "",
    category: "unknown",
    severity: "low",
    title: "Incomplete",
    description: "Missing evidence, auto_recoverable, and timestamp.",
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /id is required/);
  assert.match(result.errors.join("\n"), /category must be one of/);
  assert.match(result.errors.join("\n"), /evidence is required/);
  assert.match(result.errors.join("\n"), /auto_recoverable must be boolean/);
  assert.match(result.errors.join("\n"), /timestamp must be a valid Date/);
});
