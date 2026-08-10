import { randomUUID } from "node:crypto";
import { open, readFile, mkdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { TOKEN_REGISTRY_PATH } from "../config.js";

export const TOKEN_REGISTRY_SCHEMA_VERSION = "1.0";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type TokenAccountStatus = "healthy" | "capped" | "degraded" | "unknown";

export interface TokenAccount {
  id: string;
  token: string;
  status: TokenAccountStatus;
  weekly_usage: number;
  cap_limit: number | null;
  reset_at: string | null;
  metadata: Record<string, JsonValue>;
}

export interface TokenRegistryData {
  schema_version: typeof TOKEN_REGISTRY_SCHEMA_VERSION;
  accounts: TokenAccount[];
  active_account_id: string | null;
  last_rotation_at: string | null;
}

export interface TokenAccountInput {
  id: string;
  token: string;
  status?: TokenAccountStatus;
  weekly_usage?: number;
  cap_limit?: number | null;
  reset_at?: string | null;
  metadata?: Record<string, JsonValue>;
}

export interface TokenRegistryOptions {
  path?: string;
  lockTimeoutMs?: number;
  retryIntervalMs?: number;
}

export class TokenRegistry {
  private readonly path: string;
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly retryIntervalMs: number;

  constructor(options: TokenRegistryOptions | string = {}) {
    const normalized = typeof options === "string" ? { path: options } : options;
    this.path = normalized.path ?? TOKEN_REGISTRY_PATH;
    this.lockPath = `${this.path}.lock`;
    this.lockTimeoutMs = normalized.lockTimeoutMs ?? 5_000;
    this.retryIntervalMs = normalized.retryIntervalMs ?? 25;
  }

  async initialize(): Promise<TokenRegistryData> {
    return this.withLock(async () => {
      const registry = await this.readExistingOrDefault();
      await this.writeAtomic(registry);
      return cloneRegistry(registry);
    });
  }

  async read(): Promise<TokenRegistryData> {
    return this.withLock(async () => {
      const registry = await this.readExistingOrDefault();
      await this.writeAtomic(registry);
      return cloneRegistry(registry);
    });
  }

  async listAccounts(): Promise<TokenAccount[]> {
    return (await this.read()).accounts;
  }

  async getAccount(id: string): Promise<TokenAccount | null> {
    const registry = await this.read();
    return registry.accounts.find((account) => account.id === id) ?? null;
  }

  async upsertAccount(account: TokenAccountInput): Promise<TokenAccount> {
    const normalizedAccount = normalizeAccountInput(account);
    await this.update((registry) => {
      const index = registry.accounts.findIndex((existing) => existing.id === normalizedAccount.id);
      if (index === -1) {
        registry.accounts.push(normalizedAccount);
      } else {
        registry.accounts[index] = normalizedAccount;
      }
    });
    return cloneAccount(normalizedAccount);
  }

  async patchAccount(
    id: string,
    patch: Partial<Omit<TokenAccountInput, "id">>,
  ): Promise<TokenAccount | null> {
    let updated: TokenAccount | null = null;
    await this.update((registry) => {
      const account = registry.accounts.find((existing) => existing.id === id);
      if (!account) return;
      updated = normalizeAccountInput({ ...account, ...patch, id });
      const index = registry.accounts.findIndex((existing) => existing.id === id);
      registry.accounts[index] = updated;
    });
    return updated ? cloneAccount(updated) : null;
  }

  async removeAccount(id: string): Promise<boolean> {
    let removed = false;
    await this.update((registry) => {
      const before = registry.accounts.length;
      registry.accounts = registry.accounts.filter((account) => account.id !== id);
      removed = registry.accounts.length !== before;
      if (registry.active_account_id === id) {
        registry.active_account_id = null;
      }
    });
    return removed;
  }

  async setActiveAccount(id: string | null): Promise<void> {
    await this.update((registry) => {
      if (id !== null && !registry.accounts.some((account) => account.id === id)) {
        throw new Error(`cannot activate unknown token account: ${id}`);
      }
      registry.active_account_id = id;
      registry.last_rotation_at = new Date().toISOString();
    });
  }

  async update(
    mutator: (registry: TokenRegistryData) => TokenRegistryData | void | Promise<TokenRegistryData | void>,
  ): Promise<TokenRegistryData> {
    return this.withLock(async () => {
      const current = await this.readExistingOrDefault();
      const draft = cloneRegistry(current);
      const result = await mutator(draft);
      const next = normalizeRegistry(result ?? draft);
      await this.writeAtomic(next);
      return cloneRegistry(next);
    });
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    const lock = await this.acquireLock();
    try {
      return await operation();
    } finally {
      await lock.close();
      await unlink(this.lockPath).catch(() => undefined);
    }
  }

  private async acquireLock() {
    const startedAt = Date.now();

    while (true) {
      try {
        const handle = await open(this.lockPath, "wx", 0o600);
        await handle.writeFile(`${process.pid}\n`, "utf8");
        return handle;
      } catch (err) {
        if (!isNodeError(err) || err.code !== "EEXIST") {
          throw err;
        }

        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new Error(`timed out waiting for token registry lock: ${this.lockPath}`);
        }

        await sleep(this.retryIntervalMs);
      }
    }
  }

  private async readExistingOrDefault(): Promise<TokenRegistryData> {
    try {
      const raw = await readFile(this.path, "utf8");
      return normalizeRegistry(JSON.parse(raw) as unknown);
    } catch (err) {
      if (isNodeError(err) && err.code === "ENOENT") {
        return emptyRegistry();
      }
      throw err;
    }
  }

  private async writeAtomic(registry: TokenRegistryData): Promise<void> {
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true });
    const tempPath = join(dir, `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`);
    let tempOpen = false;

    try {
      const handle = await open(tempPath, "w", 0o600);
      tempOpen = true;
      try {
        await handle.writeFile(`${JSON.stringify(registry, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
        tempOpen = false;
      }
      await rename(tempPath, this.path);
      await fsyncDir(dir);
    } catch (err) {
      if (!tempOpen) {
        await unlink(tempPath).catch(() => undefined);
      }
      throw err;
    }
  }
}

function emptyRegistry(): TokenRegistryData {
  return {
    schema_version: TOKEN_REGISTRY_SCHEMA_VERSION,
    accounts: [],
    active_account_id: null,
    last_rotation_at: null,
  };
}

function normalizeRegistry(raw: unknown): TokenRegistryData {
  if (!isRecord(raw)) {
    throw new Error("token registry must be a JSON object");
  }

  const accounts = raw.accounts;
  if (!Array.isArray(accounts)) {
    throw new Error("token registry accounts must be an array");
  }

  return {
    schema_version: TOKEN_REGISTRY_SCHEMA_VERSION,
    accounts: accounts.map(normalizeAccount),
    active_account_id:
      typeof raw.active_account_id === "string" || raw.active_account_id === null
        ? raw.active_account_id
        : null,
    last_rotation_at:
      typeof raw.last_rotation_at === "string" || raw.last_rotation_at === null
        ? raw.last_rotation_at
        : null,
  };
}

function normalizeAccountInput(input: TokenAccountInput): TokenAccount {
  return normalizeAccount({
    id: input.id,
    token: input.token,
    status: input.status ?? "unknown",
    weekly_usage: input.weekly_usage ?? 0,
    cap_limit: input.cap_limit ?? null,
    reset_at: input.reset_at ?? null,
    metadata: input.metadata ?? {},
  });
}

function normalizeAccount(raw: unknown): TokenAccount {
  if (!isRecord(raw)) {
    throw new Error("token account must be a JSON object");
  }

  if (typeof raw.id !== "string" || raw.id.length === 0) {
    throw new Error("token account id must be a non-empty string");
  }
  if (typeof raw.token !== "string" || raw.token.length === 0) {
    throw new Error(`token account ${raw.id} token must be a non-empty string`);
  }
  if (!isTokenAccountStatus(raw.status)) {
    throw new Error(`token account ${raw.id} has invalid status: ${String(raw.status)}`);
  }
  if (typeof raw.weekly_usage !== "number" || !Number.isFinite(raw.weekly_usage)) {
    throw new Error(`token account ${raw.id} weekly_usage must be a finite number`);
  }
  if (
    raw.cap_limit !== null &&
    (typeof raw.cap_limit !== "number" || !Number.isFinite(raw.cap_limit))
  ) {
    throw new Error(`token account ${raw.id} cap_limit must be a finite number or null`);
  }
  if (raw.reset_at !== null && typeof raw.reset_at !== "string") {
    throw new Error(`token account ${raw.id} reset_at must be a string or null`);
  }
  if (!isJsonRecord(raw.metadata)) {
    throw new Error(`token account ${raw.id} metadata must be a JSON object`);
  }

  return {
    id: raw.id,
    token: raw.token,
    status: raw.status,
    weekly_usage: raw.weekly_usage,
    cap_limit: raw.cap_limit,
    reset_at: raw.reset_at,
    metadata: cloneJsonRecord(raw.metadata),
  };
}

function isTokenAccountStatus(value: unknown): value is TokenAccountStatus {
  return value === "healthy" || value === "capped" || value === "degraded" || value === "unknown";
}

function cloneRegistry(registry: TokenRegistryData): TokenRegistryData {
  return {
    schema_version: TOKEN_REGISTRY_SCHEMA_VERSION,
    accounts: registry.accounts.map(cloneAccount),
    active_account_id: registry.active_account_id,
    last_rotation_at: registry.last_rotation_at,
  };
}

function cloneAccount(account: TokenAccount): TokenAccount {
  return {
    ...account,
    metadata: cloneJsonRecord(account.metadata),
  };
}

function cloneJsonRecord(record: Record<string, JsonValue>): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(record)) as Record<string, JsonValue>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return isJsonRecord(value);
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fsyncDir(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is best-effort across platforms/filesystems.
  }
}
