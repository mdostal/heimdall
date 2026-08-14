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
  manual_override TEXT CHECK (manual_override IN ('enabled','disabled') OR manual_override IS NULL),
  manual_reset_at TEXT
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
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_catalog (
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  provider_created_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (provider, model_id)
);
CREATE TABLE IF NOT EXISTS telemetry_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  labels TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_type_time ON telemetry_events(event_type, occurred_at DESC);
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

interface ModelCatalogRow {
  provider: string;
  model_id: string;
  enabled: 0 | 1;
  provider_created_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export interface ModelCatalogEntry {
  provider: string;
  model_id: string;
  enabled: boolean;
  provider_created_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

interface TelemetryEventRow {
  event_type: string;
  labels: string;
  occurred_at: string;
}

export interface TelemetryEvent {
  event_type: string;
  labels: Record<string, string>;
  occurred_at: string;
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
    // hdl-lm-03: same defensive migration, second column (mirrors manual_override).
    try {
      this.db.exec(`ALTER TABLE lanes ADD COLUMN manual_reset_at TEXT`);
    } catch {
      // Column already exists — same reasoning as manual_override above.
    }
  }

  get database(): DatabaseSync {
    return this.db;
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

  /**
   * Manual reset_at (hdl-lm-03) — "change the times." An operator-supplied
   * ISO-8601 timestamp that, when set, wins over the sensed reset_at in
   * InProcessScheduler's delay computation (hdl-rar-01). null (the default)
   * means the sensed reset_at alone decides, unchanged from
   * pre-hdl-lm-03 behavior. Mirrors setManualOverride/getManualOverride
   * exactly — same guard, same shape, second application of the pattern.
   */
  setManualResetAt(laneId: string, value: string | null): void {
    this.db
      .prepare(
        `INSERT INTO lanes (lane_id, provider, credential_ref) VALUES (?, '', '')
         ON CONFLICT(lane_id) DO NOTHING`,
      )
      .run(laneId);
    this.db.prepare(`UPDATE lanes SET manual_reset_at = ? WHERE lane_id = ?`).run(value, laneId);
  }

  getManualResetAt(laneId: string): string | null {
    const row = this.db
      .prepare(`SELECT manual_reset_at FROM lanes WHERE lane_id = ?`)
      .get(laneId) as unknown as { manual_reset_at: string | null } | undefined;
    return row?.manual_reset_at ?? null;
  }

  /**
   * Generic global (not per-lane) key-value settings (hdl-rs-03). The
   * active routing strategy is the first consumer, but this table isn't
   * routing-specific — a future global setting doesn't need its own schema
   * migration.
   */
  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  getSetting(key: string): string | null {
    const row = this.db
      .prepare(`SELECT value FROM settings WHERE key = ?`)
      .get(key) as unknown as { value: string } | undefined;
    return row?.value ?? null;
  }

  /**
   * hdl-mc-01 — records a model as seen for a provider. On a genuinely NEW
   * (provider, model_id) pair, `enabled` is set to `defaultEnabled` (the
   * caller's recency-heuristic decision, model-catalog.ts). On an
   * ALREADY-KNOWN pair, `enabled` is deliberately left untouched — only
   * `provider_created_at`/`last_seen_at` refresh. This is the single most
   * important correctness property of the whole model-catalog epic: an
   * operator's explicit setModelEnabled choice must survive every future
   * refresh, never get silently reset by the recency default recomputing.
   */
  upsertModelSeen(entry: {
    provider: string;
    model_id: string;
    default_enabled: boolean;
    provider_created_at: string | null;
    seen_at: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO model_catalog (provider, model_id, enabled, provider_created_at, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, model_id) DO UPDATE SET
           provider_created_at = excluded.provider_created_at,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(
        entry.provider,
        entry.model_id,
        entry.default_enabled ? 1 : 0,
        entry.provider_created_at,
        entry.seen_at,
        entry.seen_at,
      );
  }

  /** Explicit operator override. Returns false (no-op) if the (provider,
   * model_id) pair has never been seen — the caller (model-catalog.ts)
   * uses this to report an "unknown_model" error rather than silently
   * doing nothing. */
  setModelEnabled(provider: string, modelId: string, enabled: boolean): boolean {
    const result = this.db
      .prepare(`UPDATE model_catalog SET enabled = ? WHERE provider = ? AND model_id = ?`)
      .run(enabled ? 1 : 0, provider, modelId);
    return result.changes > 0;
  }

  getModelCatalog(provider?: string): ModelCatalogEntry[] {
    const rows = (
      provider
        ? this.db
            .prepare(`SELECT * FROM model_catalog WHERE provider = ? ORDER BY provider, model_id`)
            .all(provider)
        : this.db.prepare(`SELECT * FROM model_catalog ORDER BY provider, model_id`).all()
    ) as unknown as ModelCatalogRow[];
    return rows.map((row) => ({
      provider: row.provider,
      model_id: row.model_id,
      enabled: row.enabled === 1,
      provider_created_at: row.provider_created_at,
      first_seen_at: row.first_seen_at,
      last_seen_at: row.last_seen_at,
    }));
  }

  // hdl-ot-01: Heimdall's own local record of events that previously only
  // existed as Argus OTEL spans (fire-and-forget, no local trace). Labels
  // are stored as a JSON object — small, finite label sets in practice
  // (provider, success, kind, ...), same simplicity precedent as
  // model_catalog's flat columns.
  recordTelemetryEvent(eventType: string, labels: Record<string, string>, occurredAt?: string): void {
    this.db
      .prepare(`INSERT INTO telemetry_events (event_type, labels, occurred_at) VALUES (?, ?, ?)`)
      .run(eventType, JSON.stringify(labels), occurredAt ?? new Date().toISOString());
  }

  /** Grouped counts for one event type — one row per distinct label combination seen. Used by GET /metrics. */
  getTelemetryEventCounts(eventType: string): Array<{ labels: Record<string, string>; count: number }> {
    const rows = this.db
      .prepare(`SELECT labels, COUNT(*) as count FROM telemetry_events WHERE event_type = ? GROUP BY labels`)
      .all(eventType) as unknown as Array<{ labels: string; count: number }>;
    return rows.map((row) => ({ labels: JSON.parse(row.labels) as Record<string, string>, count: row.count }));
  }

  listRecentTelemetryEvents(limit: number = 50): TelemetryEvent[] {
    const rows = this.db
      .prepare(`SELECT event_type, labels, occurred_at FROM telemetry_events ORDER BY occurred_at DESC LIMIT ?`)
      .all(limit) as unknown as TelemetryEventRow[];
    return rows.map((row) => ({
      event_type: row.event_type,
      labels: JSON.parse(row.labels) as Record<string, string>,
      occurred_at: row.occurred_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}
