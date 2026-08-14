import type { Lane, LaneRegistry } from "./lane-registry.js";
import type { StateStore } from "./state-store.js";
import { parseClaudeCapSignal, type ClaudeCapSignal } from "./error-parser.js";

export interface ActiveClaudeAccount {
  lane_id: string;
  provider: string;
  model: string;
  credential_ref: string;
  token: string;
}

export class NoHealthyAccountsAvailableError extends Error {
  constructor() {
    super("no healthy accounts available");
    this.name = "NoHealthyAccountsAvailableError";
  }
}

// hdl-rr-04: the minimal shape RotationController actually needs — widened
// from the concrete LaneRegistry class so a provider-scoped view (see
// ProviderScopedLaneRegistry below) can be passed in structurally. A real
// LaneRegistry still satisfies this unchanged.
export interface RotationLaneSource {
  list(): Lane[];
  get(laneId: string): Lane | null;
}

// hdl-rr-04: RotationController rotates through whatever registry.list()
// returns — passing the whole multi-provider LaneRegistry would rotate a
// capped Claude account into a Codex lane, which is never a valid
// substitute. This view scopes rotation to one provider's lanes only.
export class ProviderScopedLaneRegistry implements RotationLaneSource {
  private readonly lanes: Lane[];

  constructor(registry: LaneRegistry, provider: string) {
    this.lanes = registry.list().filter((lane) => lane.provider === provider);
  }

  list(): Lane[] {
    return this.lanes;
  }

  get(laneId: string): Lane | null {
    return this.lanes.find((lane) => lane.lane_id === laneId) ?? null;
  }
}

export class RotationController {
  private activeLaneId: string | null;

  constructor(
    private readonly registry: RotationLaneSource,
    private readonly store: StateStore,
    options: { activeLaneId?: string | null; now?: () => Date } = {},
  ) {
    this.activeLaneId = options.activeLaneId ?? null;
    this.now = options.now ?? (() => new Date());
    this.ensureDeclaredLanes();
  }

  private readonly now: () => Date;

  getActiveAccount(): ActiveClaudeAccount {
    const lane = this.activeLane();
    return toActiveAccount(lane);
  }

  setActiveAccount(laneId: string): void {
    const lane = this.registry.get(laneId);
    if (!lane || lane.credential === null || !this.isHealthy(lane)) {
      throw new NoHealthyAccountsAvailableError();
    }
    this.activeLaneId = lane.lane_id;
  }

  markCapped(laneId: string, signal: ClaudeCapSignal): void {
    this.store.recordStatus({
      lane_id: laneId,
      status: "out_of_credit",
      reset_at: signal.reset_at,
      reason: signal.reason,
      signal_source: "passive",
      observed_at: this.now().toISOString(),
    });
  }

  rotateToNextHealthy(fromLaneId: string | null = this.activeLaneId): ActiveClaudeAccount {
    const next = this.nextHealthyLane(fromLaneId);
    if (!next) throw new NoHealthyAccountsAvailableError();
    this.activeLaneId = next.lane_id;
    return toActiveAccount(next);
  }

  async request<T>(send: (account: ActiveClaudeAccount) => Promise<T>): Promise<T> {
    const maxAttempts = Math.max(1, this.registry.list().filter((lane) => lane.credential !== null).length);
    let attempts = 0;

    while (attempts < maxAttempts) {
      const account = this.getActiveAccount();
      const result = await send(account);
      const capSignal = parseClaudeCapSignal(result, this.now());
      if (!capSignal) return result;

      this.markCapped(account.lane_id, capSignal);
      attempts += 1;
      this.rotateToNextHealthy(account.lane_id);
    }

    throw new NoHealthyAccountsAvailableError();
  }

  restoreExpiredCaps(): string[] {
    const restored: string[] = [];
    const nowMs = this.now().getTime();

    for (const status of this.store.getAllCurrentStatuses()) {
      if (status.status !== "out_of_credit" || status.reset_at === null) continue;
      const resetMs = Date.parse(status.reset_at);
      if (Number.isNaN(resetMs) || resetMs > nowMs) continue;

      this.store.recordStatus({
        lane_id: status.lane_id,
        status: "up",
        reset_at: null,
        reason: "cap reset window elapsed",
        signal_source: "passive",
        observed_at: this.now().toISOString(),
      });
      restored.push(status.lane_id);
    }

    return restored;
  }

  private ensureDeclaredLanes(): void {
    for (const lane of this.registry.list()) {
      this.store.upsertLane({
        lane_id: lane.lane_id,
        provider: lane.provider,
        credential_ref: lane.credential_ref,
      });
    }
  }

  private activeLane(): Lane {
    if (this.activeLaneId) {
      const lane = this.registry.get(this.activeLaneId);
      if (lane && lane.credential !== null && this.isHealthy(lane)) return lane;
    }

    const first = this.nextHealthyLane(null);
    if (!first) throw new NoHealthyAccountsAvailableError();
    this.activeLaneId = first.lane_id;
    return first;
  }

  private nextHealthyLane(fromLaneId: string | null): Lane | null {
    const lanes = this.registry.list();
    if (lanes.length === 0) return null;
    const start = fromLaneId ? lanes.findIndex((lane) => lane.lane_id === fromLaneId) : -1;

    for (let offset = 1; offset <= lanes.length; offset++) {
      const lane = lanes[(start + offset + lanes.length) % lanes.length];
      if (lane.credential !== null && this.isHealthy(lane)) return lane;
    }

    return null;
  }

  private isHealthy(lane: Lane): boolean {
    const status = this.store.getCurrentStatus(lane.lane_id);
    return status?.status === "up";
  }
}

function toActiveAccount(lane: Lane): ActiveClaudeAccount {
  if (lane.credential === null) throw new NoHealthyAccountsAvailableError();
  return {
    lane_id: lane.lane_id,
    provider: lane.provider,
    model: lane.model,
    credential_ref: lane.credential_ref,
    token: lane.credential,
  };
}
