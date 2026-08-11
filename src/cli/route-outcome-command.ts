import { RouteLedger } from "../core/routing/route-ledger.js";

export function runRouteOutcomeCommand(args: string[]): void {
  let payloadStr = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--payload=")) {
      payloadStr = arg.split("=").slice(1).join("=");
    } else if (arg === "--payload") {
      payloadStr = args[++i];
    }
  }

  if (!payloadStr) {
    console.error("Usage: heimdall route-outcome --payload='{\"decision_id\": \"...\", \"outcome\": \"...\"}'");
    process.exit(1);
  }

  let payload;
  try {
    payload = JSON.parse(payloadStr);
  } catch (err) {
    console.error("Invalid JSON payload");
    process.exit(1);
  }

  if (!payload.decision_id) {
    console.error("Payload must include decision_id");
    process.exit(1);
  }

  const ledger = new RouteLedger(process.env.HEIMDALL_DB_PATH ?? ":memory:");
  const ok = ledger.reportOutcome({
    decisionId: payload.decision_id,
    outcome: payload.outcome,
    actualCost: payload.actual_cost,
    metadata: payload.metadata,
  });

  if (!ok) {
    console.error(JSON.stringify({ error: "not_found", message: "Decision ID not found" }));
    process.exit(1); // 404 equivalent
  }

  const entry = ledger.getDecision(payload.decision_id);
  console.log(JSON.stringify(entry, null, 2));
}
