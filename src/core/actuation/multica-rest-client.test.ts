import { test } from "node:test";
import assert from "node:assert/strict";
import { MulticaRestClient } from "./multica-rest-client.js";
import { EnvCredentialSource } from "../credential-source.js";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    MULTICA_BASE_URL: "http://100.75.161.82:8090",
    MULTICA_WORKSPACE_ID: "d70dc5cf",
    MULTICA_PAT_TOKEN: "fake-pat-token",
  };
}

function okFetch(body: unknown = {}): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    }) as unknown as Response) as typeof fetch;
}

test("throws clearly when MULTICA_BASE_URL is missing", () => {
  const env = baseEnv();
  delete env.MULTICA_BASE_URL;
  assert.throws(() => new MulticaRestClient({ env }), /MULTICA_BASE_URL/);
});

test("throws clearly when MULTICA_WORKSPACE_ID is missing", () => {
  const env = baseEnv();
  delete env.MULTICA_WORKSPACE_ID;
  assert.throws(() => new MulticaRestClient({ env }), /MULTICA_WORKSPACE_ID/);
});

test("throws clearly when the Multica PAT cannot be resolved", () => {
  const env = baseEnv();
  delete env.MULTICA_PAT_TOKEN;
  assert.throws(() => new MulticaRestClient({ env }), /Multica PAT/);
});

test("every request includes workspace_id query param and a Bearer auth header", async () => {
  let capturedUrl: string | undefined;
  let capturedHeaders: Record<string, string> | undefined;
  const fetchImpl: typeof fetch = (async (url: unknown, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedHeaders = init?.headers as Record<string, string>;
    return { ok: true, status: 200, text: async () => "[]" } as unknown as Response;
  }) as typeof fetch;

  const client = new MulticaRestClient({ env: baseEnv(), fetchImpl });
  await client.listAgents();

  const url = new URL(capturedUrl!);
  assert.equal(url.origin, "http://100.75.161.82:8090");
  assert.equal(url.pathname, "/api/agents");
  assert.equal(url.searchParams.get("workspace_id"), "d70dc5cf");
  assert.equal(capturedHeaders?.authorization, "Bearer fake-pat-token");
});

test("updateAgent sends a PUT with the patch body to /api/agents/:id", async () => {
  let capturedMethod: string | undefined;
  let capturedUrl: string | undefined;
  let capturedBody: string | undefined;
  const fetchImpl: typeof fetch = (async (url: unknown, init?: RequestInit) => {
    capturedMethod = init?.method;
    capturedUrl = String(url);
    capturedBody = init?.body as string;
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: "agent-1" }) } as unknown as Response;
  }) as typeof fetch;

  const client = new MulticaRestClient({ env: baseEnv(), fetchImpl });
  const result = await client.updateAgent("agent-1", { max_concurrent_tasks: 0 });

  assert.equal(capturedMethod, "PUT");
  assert.match(capturedUrl!, /\/api\/agents\/agent-1/);
  assert.deepEqual(JSON.parse(capturedBody!), { max_concurrent_tasks: 0 });
  assert.equal(result.status, "ok");
});

test("archiveAgent and restoreAgent hit the exact documented routes", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push(`${init?.method} ${new URL(String(url)).pathname}`);
    return { ok: true, status: 200, text: async () => "" } as unknown as Response;
  }) as typeof fetch;

  const client = new MulticaRestClient({ env: baseEnv(), fetchImpl });
  await client.archiveAgent("agent-1");
  await client.restoreAgent("agent-1");

  assert.deepEqual(calls, [
    "POST /api/agents/agent-1/archive",
    "POST /api/agents/agent-1/restore",
  ]);
});

test("an empty response body resolves ok with undefined data (archive/restore have no body)", async () => {
  const client = new MulticaRestClient({
    env: baseEnv(),
    fetchImpl: (async () => ({ ok: true, status: 200, text: async () => "" }) as unknown as Response) as typeof fetch,
  });
  const result = await client.archiveAgent("agent-1");
  assert.equal(result.status, "ok");
});

test("a timeout resolves to {status: 'timeout'}, never throws", async () => {
  const fetchImpl: typeof fetch = (async (_url: unknown, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    }) as Promise<Response>;
  }) as typeof fetch;

  const client = new MulticaRestClient({ env: baseEnv(), fetchImpl, timeoutMs: 10 });
  const result = await client.listAgents();
  assert.equal(result.status, "timeout");
});

test("a network failure resolves to {status: 'unreachable'}, never throws", async () => {
  const fetchImpl: typeof fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;

  const client = new MulticaRestClient({ env: baseEnv(), fetchImpl });
  const result = await client.listAgents();
  assert.equal(result.status, "unreachable");
  assert.match((result as { message: string }).message, /ECONNREFUSED/);
});

test("a 400 with Multica's documented workspace-scoping error resolves to http_error, never throws", async () => {
  const fetchImpl: typeof fetch = (async () =>
    ({
      ok: false,
      status: 400,
      json: async () => ({ error: "workspace_id or workspace_slug is required" }),
    }) as unknown as Response) as typeof fetch;

  const client = new MulticaRestClient({ env: baseEnv(), fetchImpl });
  const result = await client.listAgents();
  assert.equal(result.status, "http_error");
  assert.equal((result as { httpStatus: number }).httpStatus, 400);
  assert.match((result as { message: string }).message, /workspace_id/);
});

test("a malformed (non-JSON) error body still resolves http_error gracefully", async () => {
  const fetchImpl: typeof fetch = (async () =>
    ({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    }) as unknown as Response) as typeof fetch;

  const client = new MulticaRestClient({ env: baseEnv(), fetchImpl });
  const result = await client.listAgents();
  assert.equal(result.status, "http_error");
  assert.equal((result as { httpStatus: number }).httpStatus, 500);
});

test("reuses the real CredentialSource interface, not a bespoke token loader", async () => {
  const credentialSource = new EnvCredentialSource({ CUSTOM_TOKEN_REF: "custom-token-value" });
  const fetchImpl: typeof fetch = (async (_url: unknown, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer custom-token-value");
    return { ok: true, status: 200, text: async () => "[]" } as unknown as Response;
  }) as typeof fetch;

  const client = new MulticaRestClient({
    env: { MULTICA_BASE_URL: "http://100.75.161.82:8090", MULTICA_WORKSPACE_ID: "d70dc5cf" },
    credentialSource,
    tokenRef: "CUSTOM_TOKEN_REF",
    fetchImpl,
  });
  await client.listAgents();
});
