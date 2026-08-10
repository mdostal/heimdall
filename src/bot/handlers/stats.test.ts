import { test } from "node:test";
import assert from "node:assert/strict";
import { ArgusUnavailableError, type ArgusStats } from "../../adapters/argus.js";
import { formatStats, handleStatsCommand, parseStatsQuery } from "./stats.js";

test("parseStatsQuery accepts empty /stats commands as unfiltered stats", () => {
  assert.equal(parseStatsQuery(undefined), undefined);
  assert.equal(parseStatsQuery("   "), undefined);
});

test("parseStatsQuery accepts specific metric filters", () => {
  assert.equal(parseStatsQuery("argus.query_success_rate"), "argus.query_success_rate");
  assert.equal(parseStatsQuery("metric heimdall.lane.tick"), "heimdall.lane.tick");
});

test("handleStatsCommand returns fetched Argus metrics for /stats", async () => {
  const calls: Array<{ query?: string }> = [];
  const response = await handleStatsCommand(
    { text: "" },
    {
      argus: {
        queryStats: async (options = {}) => {
          calls.push(options);
          return {
            metrics: [
              {
                name: "argus.query_success_rate",
                value: 0.9,
                unit: "percentage",
                labels: { window: "first-20-queries" },
              },
            ],
          };
        },
      },
    },
  );

  assert.deepEqual(calls, [{}]);
  assert.deepEqual(response, {
    response_type: "in_channel",
    text: [
      "Argus stats",
      "- argus.query_success_rate: 0.9 percentage [window=first-20-queries]",
    ].join("\n"),
  });
});

test("handleStatsCommand sends metric filters to Argus", async () => {
  const calls: Array<{ query?: string }> = [];
  const response = await handleStatsCommand(
    { text: "argus.query_success_rate" },
    {
      argus: {
        queryStats: async (options = {}) => {
          calls.push(options);
          return {
            metrics: [{ name: "argus.query_success_rate", value: 1 }],
            query: options.query,
          };
        },
      },
    },
  );

  assert.deepEqual(calls, [{ query: "argus.query_success_rate" }]);
  assert.equal(
    response.text,
    ["Argus stats for `argus.query_success_rate`", "- argus.query_success_rate: 1"].join(
      "\n",
    ),
  );
});

test("handleStatsCommand shows a graceful Slack error when Argus is unavailable", async () => {
  const response = await handleStatsCommand(
    { text: "heimdall.lane.tick" },
    {
      argus: {
        queryStats: async () => {
          throw new ArgusUnavailableError("Argus stats endpoint is unavailable");
        },
      },
    },
  );

  assert.deepEqual(response, {
    response_type: "ephemeral",
    text: "Argus stats are unavailable right now. Try again after observability recovers.",
  });
});

test("formatStats handles empty filtered responses", () => {
  const stats: ArgusStats = { metrics: [], query: "missing.metric" };
  assert.equal(formatStats(stats), "Argus did not return any matching stats.");
});
