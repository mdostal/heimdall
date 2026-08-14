// The "off" routing strategy (hdl-rs-02) — the explicit "let something else
// help decide" mode. Never picks a lane, regardless of how many candidates
// are available. GET /available-route then always reports
// no_available_route; the caller falls back to GET /lanes (already returns
// full status + manual_override + credential_configured) and decides for
// itself — the same consumer-side selection pattern
// test/e2e/route-selection-handshake.test.ts's selectRoutableLane() already
// demonstrates as a supported path, not a new invention.

import type { RouteSelectionContext, RouteSelectionResult, RoutingStrategy } from "./types.js";

export class OffStrategy implements RoutingStrategy {
  readonly name = "off";

  selectRoute(_ctx: RouteSelectionContext): RouteSelectionResult {
    return { lane: null };
  }
}
