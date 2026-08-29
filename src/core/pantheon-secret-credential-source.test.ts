import { test } from "node:test";
import assert from "node:assert/strict";
import { PantheonSecretCredentialSource } from "./pantheon-secret-credential-source.js";

const BASE_URL = "http://fake-core-api:3012";
const SHARED_DIR = "/fake-shared";

interface Call {
  cmd: string;
  args: string[];
}

function parseCurlArgs(args: string[]) {
  const xIdx = args.indexOf("-X");
  const method = args[xIdx + 1];
  const url = args[xIdx + 2];
  const dIdx = args.indexOf("-d");
  const body = dIdx === -1 ? undefined : JSON.parse(args[dIdx + 1]);
  return { method, url, body };
}

test("resolve() calls Pantheon's /api/secrets/inject with target=file, format=env, never Portunus directly", () => {
  const calls: Call[] = [];
  const files = new Map<string, string>();
  const deleted: string[] = [];

  const source = new PantheonSecretCredentialSource({
    pantheonApiUrl: BASE_URL,
    sharedSecretsDir: SHARED_DIR,
    generateId: () => "fixed-id",
    exec: (cmd, args) => {
      calls.push({ cmd, args });
      const { url, body } = parseCurlArgs(args);
      assert.equal(cmd, "curl");
      assert.equal(url, `${BASE_URL}/api/secrets/inject`);
      assert.equal(body.tags, "CLAUDE_LONG_LIVED_TOKEN");
      assert.equal(body.target, "file");
      assert.equal(body.format, "env");
      assert.equal(body.key, "VALUE");
      files.set(body.path, "VALUE=sk-ant-real-token-value\n");
      return "\n200";
    },
    readFile: (p) => files.get(p) ?? "",
    deleteFile: (p) => deleted.push(p),
  });

  const value = source.resolve("CLAUDE_LONG_LIVED_TOKEN");

  assert.equal(value, "sk-ant-real-token-value");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.every((a) => !String(a).includes(":7802")), "never calls Portunus's own port directly");
  assert.equal(deleted.length, 1, "the shared secret file is always deleted after use");
});

test("resolve() returns null (never throws) when Pantheon's facade returns a non-2xx status", () => {
  const source = new PantheonSecretCredentialSource({
    pantheonApiUrl: BASE_URL,
    sharedSecretsDir: SHARED_DIR,
    exec: () => "\n404",
    readFile: () => {
      throw new Error("should never be read after a failed inject");
    },
    deleteFile: () => {},
  });

  assert.equal(source.resolve("DOES_NOT_EXIST"), null);
});

test("resolve() returns null (never throws) when the curl call itself fails (transport error)", () => {
  const source = new PantheonSecretCredentialSource({
    pantheonApiUrl: BASE_URL,
    sharedSecretsDir: SHARED_DIR,
    exec: () => {
      throw new Error("ECONNREFUSED");
    },
    readFile: () => "",
    deleteFile: () => {},
  });

  assert.equal(source.resolve("ANYTHING"), null);
});

test("resolve() returns null when the shared file is empty after a nominal-success response", () => {
  const source = new PantheonSecretCredentialSource({
    pantheonApiUrl: BASE_URL,
    sharedSecretsDir: SHARED_DIR,
    exec: () => "\n200",
    readFile: () => "",
    deleteFile: () => {},
  });

  assert.equal(source.resolve("EMPTY"), null);
});

test("resolve() always attempts cleanup, even when the read fails", () => {
  const deleted: string[] = [];
  const source = new PantheonSecretCredentialSource({
    pantheonApiUrl: BASE_URL,
    sharedSecretsDir: SHARED_DIR,
    exec: () => "\n200",
    readFile: () => {
      throw new Error("disk read failure");
    },
    deleteFile: (p) => deleted.push(p),
  });

  assert.equal(source.resolve("X"), null);
  assert.equal(deleted.length, 1);
});

test("resolve() defaults pantheonApiUrl from PANTHEON_API_URL env var, matching every other cross-god caller in this program", () => {
  const originalEnv = process.env.PANTHEON_API_URL;
  process.env.PANTHEON_API_URL = "http://env-configured-core-api:3012";
  try {
    let calledUrl = "";
    const source = new PantheonSecretCredentialSource({
      sharedSecretsDir: SHARED_DIR,
      exec: (_cmd, args) => {
        calledUrl = parseCurlArgs(args).url;
        return "\n200";
      },
      readFile: () => "VALUE=x\n",
      deleteFile: () => {},
    });
    source.resolve("X");
    assert.equal(calledUrl, "http://env-configured-core-api:3012/api/secrets/inject");
  } finally {
    if (originalEnv === undefined) delete process.env.PANTHEON_API_URL;
    else process.env.PANTHEON_API_URL = originalEnv;
  }
});
