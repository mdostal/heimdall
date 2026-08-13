# Design Discussion — hdl-mcp-routing-strategy

## 0. Prelude

Small, well-precedented follow-up explicitly deferred when `hdl-routing-strategies`
shipped (CHANGELOG: MCP tooling for routing-strategy selection was scoped out as a
"small, natural follow-up"). No research needed — this mirrors `hdl-mcp-lane-tools`'s
established pattern exactly, applied to the one HTTP surface (`GET`/`POST
/routing-strategy`) that never got MCP tools when it shipped.

## 1. Goal

Add two MCP tools — `heimdall.routingStrategy.get` and `heimdall.routingStrategy.set`
— wrapping the exact shared functions `GET`/`POST /routing-strategy` already call
(`getActiveRoutingStrategyName`, `getRoutingStrategyNames`, `setRoutingStrategy`), so
an agent can read and change the active routing strategy the same way it can already
manage lane overrides, reset-at, and add lanes.

## 2. Proposed approach

Mirror `mcp-server.ts`'s exact existing shape:
- `listLaneToolsDescriptor()` (or a renamed/extended version) gains two more tool
  descriptors, following the same `inputSchema` conventions as
  `heimdall.lanes.override`'s enum-constrained `state` field.
- `callRoutingStrategyGetTool`/`callRoutingStrategySetTool`, calling the existing
  shared functions — zero new business logic, this is purely a new interface onto
  code that already exists and is already tested via `http-server.test.ts`.
- `buildToolDispatch` gains the two new entries.
- Same never-throws-on-validation-failure / throws-only-on-unknown-tool-name
  contract every existing tool already follows.

## 3. Scale assessment

**Small.** One file (`mcp-server.ts`) plus its test file. Proceeding directly to a
single story.
