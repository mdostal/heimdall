// Kimi K3 (Moonshot AI) public-status adapter — REQ-02 (hdl-ks-02).
// Source: .pHive/epics/hdl-kimi-signals/docs/research-brief.md — confirmed
// 2026-08-13 that status.moonshot.cn is Atlassian-Statuspage-hosted with a
// working api/v2/summary.json endpoint — the exact same shape
// public-status/claude.ts already consumes. No "K3"-specific component
// exists yet on the confirmed roster, so the fragment list is kept broad
// ("API", "Model") to match the current *Model/API component family
// without needing a per-model-version update later.

export type PublicStatusValue = "up" | "degraded" | "down";

export interface PublicStatusSignal {
  status: PublicStatusValue;
  reason: string | null;
}

const KIMI_STATUS_URL = "https://status.moonshot.cn/api/v2/summary.json";

const RELEVANT_COMPONENT_NAME_FRAGMENTS = ["API", "Model"];

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

export async function checkKimiPublicStatus(
  fetchImpl: typeof fetch = fetch,
): Promise<PublicStatusSignal> {
  let response: Response;
  try {
    response = await fetchImpl(KIMI_STATUS_URL);
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
