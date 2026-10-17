// In-process lane event bus (PANT-827) — replaces main.ts's old service-wide
// status-watcher setInterval ("nothing polls"). StateStore emits
// lane.status_changed only when something a consumer acts on actually
// changes: a lane's resolved status, or an operator's manual override /
// manual reset_at. main.ts subscribes ControlAdapter.reconcile() to it;
// http-server.ts streams it to the dashboard over GET /events (SSE).
//
// Deliberately a tiny listener set rather than node:events' EventEmitter:
// emit() runs inside StateStore's write methods, so one throwing listener
// must never fail the write (or starve the other listeners) — each call is
// isolated here instead of relying on every subscriber to be careful.
//
// In-process only: a status/override written by a separate process against
// the same DB file (heimdall CLI, `heimdall mcp`) does not emit here.

import type { ErrorCode, LaneStatusValue } from "./status-model.js";

export const LANE_STATUS_CHANGED = "lane.status_changed";

/** What changed: the sensed status itself, or an operator's manual lever. */
export type LaneStatusChangeCause = "status" | "manual_override" | "manual_reset_at";

export interface LaneStatusChangedEvent {
  lane_id: string;
  /** null when this is the lane's first recorded status (it was on the "no status yet" fallback). */
  from: LaneStatusValue | null;
  to: LaneStatusValue;
  error_code: ErrorCode | null;
  reset_at: string | null;
  observed_at: string;
  cause: LaneStatusChangeCause;
}

export type LaneStatusChangedListener = (event: LaneStatusChangedEvent) => void;

export class LaneEvents {
  private readonly listeners = new Set<LaneStatusChangedListener>();

  /** Subscribe; returns the matching unsubscribe function. */
  onStatusChanged(listener: LaneStatusChangedListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emitStatusChanged(event: LaneStatusChangedEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        console.error(`[lane-events] ${LANE_STATUS_CHANGED} listener failed for lane ${event.lane_id}:`, err);
      }
    }
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}
