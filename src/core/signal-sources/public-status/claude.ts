// Claude public-status adapter — REQ-02.
// Source: .pHive/epics/lane-health-status/docs/signal-inventory.md (lhs-00
// spike) — confirmed structured StatusPage.io JSON API, no auth, no
// per-lane token cost. Component-level granularity lets us check the
// Claude Code / API components specifically rather than the whole page.

export type PublicStatusValue = "up" | "degraded" | "down";

export interface PublicStatusSignal {
  status: PublicStatusValue;
  reason: string | null;
}

const CLAUDE_STATUS_URL = "https://status.claude.com/api/v2/summary.json";

// Per the spike: match components whose name references Claude Code or the
// API specifically — a claude.ai-only incident shouldn't flag this lane.
const RELEVANT_COMPONENT_NAME_FRAGMENTS = ["Claude Code", "API", "api.anthropic.com"];

const INDICATOR_RANK: Record<string, number> = {
  operational: 0,
  degraded_performance: 1,
  partial_outage: 2,
  major_outage: 3,
};

interface StatusPageComponent {
  name: string;
  status: string;
}

interface StatusPageSummary {
  components: StatusPageComponent[];
}

function mapIndicatorToSignal(indicator: string): PublicStatusValue {
  switch (indicator) {
    case "operational":
      return "up";
    case "degraded_performance":
    case "partial_outage":
      return "degraded";
    case "major_outage":
      return "down";
    default:
      // Unknown indicator value (schema drift on Anthropic's side) — don't
      // silently claim "up" for something we don't recognize.
      return "degraded";
  }
}

export async function checkClaudePublicStatus(
  fetchImpl: typeof fetch = fetch,
): Promise<PublicStatusSignal> {
  let response: Response;
  try {
    response = await fetchImpl(CLAUDE_STATUS_URL);
  } catch (err) {
    return {
      status: "degraded",
      reason: `status page unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!response.ok) {
    return { status: "degraded", reason: `status page returned ${response.status}` };
  }

  const summary = (await response.json()) as StatusPageSummary;
  const relevant = summary.components.filter((component) =>
    RELEVANT_COMPONENT_NAME_FRAGMENTS.some((fragment) => component.name.includes(fragment)),
  );

  if (relevant.length === 0) {
    return { status: "degraded", reason: "no matching status-page component found" };
  }

  const worst = relevant.reduce((worstSoFar, component) => {
    const rank = INDICATOR_RANK[component.status] ?? INDICATOR_RANK.degraded_performance;
    const worstRank = INDICATOR_RANK[worstSoFar.status] ?? INDICATOR_RANK.degraded_performance;
    return rank > worstRank ? component : worstSoFar;
  }, relevant[0]);

  return {
    status: mapIndicatorToSignal(worst.status),
    reason: worst.status === "operational" ? null : `${worst.name}: ${worst.status}`,
  };
}
