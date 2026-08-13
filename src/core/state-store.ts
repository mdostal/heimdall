// SQLite state storage — see .pHive/planning/architecture.md "Data Model".
// Uses Node's built-in node:sqlite (experimental as of Node 22.9 — requires
// the --experimental-sqlite flag, wired into package.json's dev/test scripts).
//
// "Current status = latest row per lane_id in lane_status_history" —
// getCurrentStatus's "no row yet" fallback (down/unconfigured) is what a
// lane reports until its first real status is recorded by the signal
// pipeline (lane-pipeline.ts, lhs-03f).

import { DatabaseSync } from "node:sqlite";
import type { LaneStatus, LaneStatusValue, SignalSource } from "./status-model.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lanes (
  lane_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  manual_override TEXT CHECK (manual_override IN ('enabled','disabled') OR manual_override IS NULL)
);
CREATE TABLE IF NOT EXISTS lane_status_history (
  lane_id TEXT NOT NULL REFERENCES lanes(lane_id),
  status TEXT NOT NULL CHECK (status IN ('up','down','out_of_credit','degraded')),
  reset_at TEXT,
  reason TEXT,
  signal_source TEXT NOT NULL CHECK (signal_source IN ('passive','public_status','active_probe')),
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lane_status_latest ON lane_status_history(lane_id, observed_at DESC);
`;

export type ManualOverride = "enabled" | "disabled" | null;

interface LaneRow {
  lane_id: string;
  provider: string;
  credential_ref: string;
}

interface StatusRow {
  status: LaneStatusValue;
  reset_at: string | null;
  reason: string | null;
  signal_source: SignalSource;
  observed_at: string;
}

export class StateStore {
  private readonly db: DatabaseSync;

  constructor(path: string = ":memory:") {
    // node:sqlite's default for foreign-key enforcement varies by Node
    // version (observed OFF on Node 22.9, ON on the hive's Node build) —
    // pinned explicitly so behavior is deterministic across environments.
    this.db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    this.db.exec(SCHEMA);
    // Defensive migration (hdl-lo-01): CREATE TABLE IF NOT EXISTS only
    // affects fresh databases — a pre-existing persisted DB file created
    // before this column existed needs it added explicitly. No formal
    // migration system in this repo; ignore "duplicate column" on DBs
    // that already have it (fresh DBs get it via SCHEMA above already).
    try {
      this.db.exec(
        `ALTER TABLE lanes ADD COLUMN manual_override TEXT CHECK (manual_override IN ('enabled','disabled') OR manual_override IS NULL)`,
      );
    } catch {
      // Column already exists — expected on every fresh DB (added via
      // SCHEMA) and on any DB this migration already ran against.
    }
  }

  upsertLane(lane: LaneRow): void {
    this.db
      .prepare(
        `INSERT INTO lanes (lane_id, provider, credential_ref) VALUES (?, ?, ?)
         ON CONFLICT(lane_id) DO UPDATE SET
           provider = excluded.provider,
           credential_ref = excluded.credential_ref`,
      )
      .run(lane.lane_id, lane.provider, lane.credential_ref);
  }

  recordStatus(entry: {
    lane_id: string;
    status: LaneStatusValue;
    reset_at: string | null;
    reason: string | null;
    signal_source: SignalSource;
    observed_at: string;
  }): void {
    // Guard the FK to lanes(lane_id) regardless of call order — a no-op via
    // ON CONFLICT DO NOTHING when the caller already upserted the lane (the
    // normal path), but never a foreign-key violation if it didn't.
    this.db
      .prepare(
        `INSERT INTO lanes (lane_id, provider, credential_ref) VALUES (?, '', '')
         ON CONFLICT(lane_id) DO NOTHING`,
      )
      .run(entry.lane_id);

    this.db
      .prepare(
        `INSERT INTO lane_status_history
           (lane_id, status, reset_at, reason, signal_source, observed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.lane_id,
        entry.status,
        entry.reset_at,
        entry.reason,
        entry.signal_source,
        entry.observed_at,
      );
  }

  listLanes(): LaneRow[] {
    return this.db
      .prepare(`SELECT lane_id, provider, credential_ref FROM lanes`)
      .all() as unknown as LaneRow[];
  }

  getCurrentStatus(laneId: string): LaneStatus | null {
    const lane = this.db
      .prepare(`SELECT lane_id, provider, credential_ref FROM lanes WHERE lane_id = ?`)
      .get(laneId) as unknown as LaneRow | undefined;
    if (!lane) return null;

    const row = this.db
      .prepare(
        `SELECT status, reset_at, reason, signal_source, observed_at
         FROM lane_status_history
         WHERE lane_id = ?
         ORDER BY observed_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(laneId) as unknown as StatusRow | undefined;

    if (!row) {
      // Declared lane, no status recorded yet (lhs-02 scope — real signal
      // detection lands in lhs-03f). REQ-07: report down/unconfigured, never
      // omit the lane or crash.
      return {
        lane_id: lane.lane_id,
        provider: lane.provider,
        status: "down",
        reset_at: null,
        reason: "unconfigured — no status recorded yet",
        last_updated: new Date(0).toISOString(),
        signal_source: "passive",
      };
    }

    return {
      lane_id: lane.lane_id,
      provider: lane.provider,
      status: row.status,
      reset_at: row.reset_at,
      reason: row.reason,
      last_updated: row.observed_at,
      signal_source: row.signal_source,
    };
  }

  /** Timestamp of the most recent status entry recorded from a specific
   * signal source for this lane, or null if none exists yet. Used by
   * escalation.ts (via lane-pipeline.ts) to decide staleness per source. */
  getLastObservedAt(laneId: string, source: SignalSource): string | null {
    const row = this.db
      .prepare(
        `SELECT observed_at FROM lane_status_history
         WHERE lane_id = ? AND signal_source = ?
         ORDER BY observed_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(laneId, source) as unknown as { observed_at: string } | undefined;
    return row?.observed_at ?? null;
  }

  getAllCurrentStatuses(): LaneStatus[] {
    return this.listLanes()
      .map((lane) => this.getCurrentStatus(lane.lane_id))
      .filter((status): status is LaneStatus => status !== null);
  }

  /**
   * Manual override (hdl-lo-01) — a top-level operator directive that, when
   * set, wins outright over the sensed status in ControlAdapter.reconcile's
   * desiredEnabled decision. null (the default) means "automatic" — status
   * alone decides, unchanged from pre-hdl-lo-01 behavior.
   */
  setManualOverride(laneId: string, value: ManualOverride): void {
    // Guard the row's existence regardless of call order (same pattern as
    // recordStatus) — a no-op via ON CONFLICT DO NOTHING when the lane was
    // already upserted, but never silently affects 0 rows if it wasn't.
    this.db
      .prepare(
        `INSERT INTO lanes (lane_id, provider, credential_ref) VALUES (?, '', '')
         ON CONFLICT(lane_id) DO NOTHING`,
      )
      .run(laneId);
    this.db.prepare(`UPDATE lanes SET manual_override = ? WHERE lane_id = ?`).run(value, laneId);
  }

  getManualOverride(laneId: string): ManualOverride {
    const row = this.db
      .prepare(`SELECT manual_override FROM lanes WHERE lane_id = ?`)
      .get(laneId) as unknown as { manual_override: ManualOverride } | undefined;
    return row?.manual_override ?? null;
  }

  close(): void {
    this.db.close();
  }
}
