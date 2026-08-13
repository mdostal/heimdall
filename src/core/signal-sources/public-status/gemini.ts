// Gemini public-status adapter — REQ-02 (hdl-gs-02).
// Source: .pHive/epics/hdl-gemini-signals/docs/research-brief.md — real web
// research, 2026-08-13. Unlike Claude's/Codex's fixed StatusPage.io
// component snapshot, there is no per-component "Gemini API" status page —
// the closest real, free, unauthenticated signal is Google Cloud's
// Google-Cloud-wide incidents feed. It has no positive "operational" entry
// to read; the correct interpretation is "no open matching incident = up",
// mirrored from how an operator reading the dashboard themselves would
// conclude health. Confirmed real Gemini-specific incidents do appear in
// this feed when they occur (e.g. the 2026-02-27 Vertex AI Gemini API
// global-endpoint incident) — see research-brief.md.

export type PublicStatusValue = "up" | "degraded" | "down";

export interface PublicStatusSignal {
  status: PublicStatusValue;
  reason: string | null;
}

const GEMINI_INCIDENTS_URL = "https://status.cloud.google.com/incidents.json";

// Kept narrow and documented (per claude.ts's/codex.ts's own fragment-list
// tradeoff) — this feed is dominated by unrelated GCP infra incidents
// (VMware Engine, Bare Metal Solution, NetApp Volumes, VPC, ...).
const RELEVANT_PRODUCT_TITLE_FRAGMENTS = ["Gemini", "Vertex AI", "Generative AI"];

interface AffectedProduct {
  title?: string;
}

interface CloudIncident {
  end?: string | null;
  external_desc?: string;
  severity?: string;
  status_impact?: string;
  affected_products?: AffectedProduct[];
}

function isCurrentlyOpen(incident: CloudIncident): boolean {
  return !incident.end;
}

function matchesGemini(incident: CloudIncident): boolean {
  const products = incident.affected_products ?? [];
  return products.some((product) =>
    RELEVANT_PRODUCT_TITLE_FRAGMENTS.some((fragment) => (product.title ?? "").includes(fragment)),
  );
}

function mapIncidentToSignal(incident: CloudIncident): PublicStatusValue {
  const impact = (incident.status_impact ?? "").toUpperCase();
  const severity = (incident.severity ?? "").toLowerCase();
  if (impact.includes("OUTAGE") || severity === "high" || severity === "critical") {
    return "down";
  }
  // Any other open, matching incident (e.g. "SERVICE_DISRUPTION", severity
  // "medium"/"low") is real but short of a confirmed full outage.
  return "degraded";
}

export async function checkGeminiPublicStatus(
  fetchImpl: typeof fetch = fetch,
): Promise<PublicStatusSignal> {
  let response: Response;
  try {
    response = await fetchImpl(GEMINI_INCIDENTS_URL);
  } catch (err) {
    return {
      status: "degraded",
      reason: `status feed unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!response.ok) {
    return { status: "degraded", reason: `status feed returned ${response.status}` };
  }

  let incidents: unknown;
  try {
    incidents = await response.json();
  } catch (err) {
    return {
      status: "degraded",
      reason: `status feed returned malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!Array.isArray(incidents)) {
    // Unrecognized/malformed shape (schema drift) — ambiguity is never up.
    return { status: "degraded", reason: "status feed returned an unrecognized shape" };
  }

  const open = (incidents as CloudIncident[]).filter(isCurrentlyOpen).filter(matchesGemini);

  if (open.length === 0) {
    return { status: "up", reason: null };
  }

  const worst = open.reduce((worstSoFar, incident) =>
    mapIncidentToSignal(incident) === "down" ? incident : worstSoFar,
  );

  return {
    status: mapIncidentToSignal(worst),
    reason: worst.external_desc ?? "open incident affecting Gemini/Vertex AI",
  };
}
