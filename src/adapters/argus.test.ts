import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ArgusStatsClient,
  ArgusUnavailableError,
  normalizeArgusStats,
} from "./argus.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("queryStats fetches unfiltered metrics from the configured Argus stats endpoint", async () => {
  const requested: string[] = [];
  const client = new ArgusStatsClient({
    baseUrl: "http://argus.local",
    fetch: (async (url) => {
      requested.push(String(url));
      return jsonResponse({
        metrics: [
          {
            name: "argus.query_success_rate",
            value: 0.95,
            unit: "percentage",
            timestamp: "2026-08-08T19:00:00Z",
            labels: { window: "first-20-queries" },
          },
        ],
        source: "argus",
      });
    }) as typeof fetch,
  });

  const stats = await client.queryStats();

  assert.equal(requested[0], "http://argus.local/stats");
  assert.deepEqual(stats, {
    metrics: [
      {
        name: "argus.query_success_rate",
        value: 0.95,
        unit: "percentage",
        timestamp: "2026-08-08T19:00:00Z",
        labels: { window: "first-20-queries" },
      },
    ],
    query: undefined,
    source: "argus",
  });
});

test("queryStats sends specific metric filters as the query parameter", async () => {
  const requested: string[] = [];
  const client = new ArgusStatsClient({
    baseUrl: "http://argus.local/api",
    statsPath: "/v1/stats",
    fetch: (async (url) => {
      requested.push(String(url));
      return jsonResponse({
        metrics: [{ name: "heimdall.lane.tick", value: 12 }],
      });
    }) as typeof fetch,
  });

  const stats = await client.queryStats({ query: "heimdall.lane.tick" });

  assert.equal(requested[0], "http://argus.local/v1/stats?query=heimdall.lane.tick");
  assert.equal(stats.query, "heimdall.lane.tick");
  assert.deepEqual(stats.metrics, [{ name: "heimdall.lane.tick", value: 12 }]);
});

test("queryStats raises a typed unavailable error when Argus cannot be reached", async () => {
  const client = new ArgusStatsClient({
    fetch: (async () => {
      throw new Error("connection refused");
    }) as typeof fetch,
  });

  await assert.rejects(
    () => client.queryStats(),
    (err) =>
      err instanceof ArgusUnavailableError &&
      err.message === "Argus stats endpoint is unavailable",
  );
});

test("queryStats raises a typed unavailable error for non-2xx responses", async () => {
  const client = new ArgusStatsClient({
    fetch: (async () => jsonResponse({ error: "down" }, 503)) as typeof fetch,
  });

  await assert.rejects(
    () => client.queryStats(),
    /Argus stats endpoint returned HTTP 503/,
  );
});

test("normalizeArgusStats rejects malformed metrics", () => {
  assert.throws(
    () => normalizeArgusStats({ metrics: [{ name: "bad", value: "1" }] }),
    /numeric value/,
  );
});
