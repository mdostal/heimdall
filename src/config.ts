import { homedir } from "node:os";
import { join } from "node:path";

export const HEIMDALL_HOME = process.env.HEIMDALL_HOME ?? join(homedir(), ".heimdall");
export const TOKEN_REGISTRY_PATH =
  process.env.HEIMDALL_TOKEN_REGISTRY_PATH ?? join(HEIMDALL_HOME, "token-registry.json");
