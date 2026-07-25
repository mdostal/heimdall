// CommandRunner — injectable shell-command execution, mirroring the
// fetchImpl injection pattern already used throughout this codebase
// (passive.ts, active-probe adapters). MulticaAutopilotScheduler depends on
// this interface, never on node:child_process directly, so tests never
// shell out to a real multica daemon.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: string[]): Promise<CommandResult>;
}

export class NodeCommandRunner implements CommandRunner {
  async run(command: string, args: string[]): Promise<CommandResult> {
    const { stdout, stderr } = await execFileAsync(command, args);
    return { stdout, stderr };
  }
}
