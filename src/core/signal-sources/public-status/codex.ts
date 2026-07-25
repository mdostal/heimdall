// Codex public-status adapter — REQ-02.
// Source: .pHive/epics/lane-health-status/docs/signal-inventory.md (lhs-00
// spike) — confirmed same StatusPage.io JSON shape as Claude's, no auth, no
// per-lane token cost. This mirrors claude.ts's pattern exactly (per
// lhs-03b's reference-implementation note) — proof the ProviderSignalAdapter
// pattern generalizes across providers, per lhs-04's design intent.

export type PublicStatusValue = "up" | "degraded" | "down";

export interface PublicStatusSignal {
  status: PublicStatusValue;
  reason: string | null;
}

const CODEX_STATUS_URL = "https://status.openai.com/api/v2/summary.json";

// Component name fragments relevant to Codex specifically. OpenAI's status
// page groups components similarly to Anthropic's (API, ChatGPT, etc.) — an
// incident on an unrelated component (e.g. a non-API consumer product)
// shouldn't flag this lane.
const RELEVANT_COMPONENT_NAME_FRAGMENTS = ["API", "Codex", "ChatGPT"];

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
      return "degraded";
  }
}

export async function checkCodexPublicStatus(
  fetchImpl: typeof fetch = fetch,
): Promise<PublicStatusSignal> {
  let response: Response;
  try {
    response = await fetchImpl(CODEX_STATUS_URL);
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
