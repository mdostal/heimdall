import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OrgTreeResolutionError,
  resolveOrgTreeContext,
  resolveOrgTreePath,
  type OrgTreeNode,
} from "./resolver.js";

const ORG_TREE: OrgTreeNode[] = [
  {
    id: "/company",
    context: {
      brand: "Modern, minimal, accessible",
      tools: ["shared"],
      prompts: {
        tone: "direct",
        guardrails: ["cite source documents"],
      },
    },
  },
  {
    id: "/company/heimdall",
    parent: "/company",
    context: {
      mission: "health-aware lane gateway",
      tools: ["lane-status"],
      prompts: {
        guardrails: ["preserve LaneRouterContract"],
      },
    },
  },
  {
    id: "/company/heimdall/codex",
    parent: "/company/heimdall",
    context: {
      brand: "Heimdall implementation lane",
      prompts: {
        tone: "pragmatic",
      },
    },
  },
];

test("resolveOrgTreePath walks from the assigned node up to root", () => {
  const path = resolveOrgTreePath(ORG_TREE, "/company/heimdall/codex");

  assert.deepEqual(
    path.map((node) => node.id),
    ["/company", "/company/heimdall", "/company/heimdall/codex"],
  );
});

test("resolveOrgTreeContext merges root-to-child context", () => {
  const context = resolveOrgTreeContext(ORG_TREE, "/company/heimdall/codex");

  assert.deepEqual(context, {
    brand: "Heimdall implementation lane",
    mission: "health-aware lane gateway",
    tools: ["shared", "lane-status"],
    prompts: {
      tone: "pragmatic",
      guardrails: ["cite source documents", "preserve LaneRouterContract"],
    },
  });
});

test("child context overrides parent context on conflicts", () => {
  const context = resolveOrgTreeContext(ORG_TREE, "/company/heimdall/codex");

  assert.equal(context.brand, "Heimdall implementation lane");
  assert.deepEqual((context.prompts as { tone: string }).tone, "pragmatic");
});

test("empty child context inherits the complete parent context", () => {
  const context = resolveOrgTreeContext(
    [
      { id: "/root", context: { brand: "shared", tools: ["root"] } },
      { id: "/root/child", parent: "/root" },
    ],
    "/root/child",
  );

  assert.deepEqual(context, { brand: "shared", tools: ["root"] });
});

test("unknown assigned node ids fail clearly", () => {
  assert.throws(
    () => resolveOrgTreeContext(ORG_TREE, "/missing"),
    (error: unknown) =>
      error instanceof OrgTreeResolutionError &&
      /Unknown org-tree node id: \/missing/.test(error.message),
  );
});

test("missing parent ids fail clearly", () => {
  assert.throws(
    () => resolveOrgTreeContext([{ id: "/child", parent: "/missing" }], "/child"),
    /references missing parent \/missing/,
  );
});

test("duplicate node ids fail clearly", () => {
  assert.throws(
    () => resolveOrgTreeContext([{ id: "/root" }, { id: "/root" }], "/root"),
    /Duplicate org-tree node id: \/root/,
  );
});

test("parent cycles fail clearly", () => {
  assert.throws(
    () =>
      resolveOrgTreeContext(
        [
          { id: "/a", parent: "/b" },
          { id: "/b", parent: "/a" },
        ],
        "/a",
      ),
    /Cycle detected in org-tree parent chain at \/a/,
  );
});
