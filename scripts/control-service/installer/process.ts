import { type ChildProcess, spawn } from "node:child_process";
import { sanitizedChildEnvironment } from "./environment.js";

const USE_PROCESS_GROUP = process.platform !== "win32";

function terminate(child: ChildProcess): void {
  if (USE_PROCESS_GROUP && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall back to the direct child when the process group already exited.
    }
  }
  child.kill("SIGKILL");
}

export interface ProcessRequest {
  command: string;
  args: readonly string[];
  cwd?: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

export interface ProcessAdapter {
  runJson(request: ProcessRequest): Promise<unknown>;
  runSecretText(request: ProcessRequest): Promise<string>;
}

export type ProcessFailureReason =
  | "launch"
  | "timeout"
  | "stdout_limit"
  | "stderr_limit"
  | "nonzero"
  | "malformed_json";

export type ProviderFailureCategory =
  | "unauthorized"
  | "forbidden"
  | "conflict"
  | "rate_limited"
  | "client_error"
  | "server_error"
  | "quota_or_limit";

function providerFailureCategory(stderr: string): ProviderFailureCategory | undefined {
  if (/\b401\b/.test(stderr)) return "unauthorized";
  if (/\b403\b/.test(stderr)) return "forbidden";
  if (/\b409\b/.test(stderr)) return "conflict";
  if (/\b429\b/.test(stderr)) return "rate_limited";
  if (/\b(?:400|422)\b/.test(stderr)) return "client_error";
  if (/\b5[0-9]{2}\b/.test(stderr)) return "server_error";
  if (/\b(?:quota|limit|maximum)\b/i.test(stderr)) return "quota_or_limit";
  return undefined;
}

export class ProcessFailure extends Error {
  constructor(
    readonly reason: ProcessFailureReason,
    readonly providerCategory?: ProviderFailureCategory,
  ) {
    super(`process failed: ${reason}`);
    this.name = "ProcessFailure";
  }
}

export class BoundedJsonProcess implements ProcessAdapter {
  async runJson(request: ProcessRequest): Promise<unknown> {
    return await new Promise((resolve, reject) => {
      const child = spawn(request.command, [...request.args], {
        cwd: request.cwd,
        detached: USE_PROCESS_GROUP,
        env: sanitizedChildEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutSize = 0;
      let stderrSize = 0;
      let settled = false;

      const finish = (failure?: ProcessFailure, value?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (failure) reject(failure);
        else resolve(value);
      };
      const abort = (reason: ProcessFailureReason): void => {
        terminate(child);
        finish(new ProcessFailure(reason));
      };
      const timer = setTimeout(() => abort("timeout"), request.timeoutMs);
      child.once("error", () => finish(new ProcessFailure("launch")));
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutSize += chunk.byteLength;
        if (stdoutSize > request.maxStdoutBytes) {
          abort("stdout_limit");
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrSize += chunk.byteLength;
        if (stderrSize > request.maxStderrBytes) {
          abort("stderr_limit");
          return;
        }
        stderr.push(chunk);
      });
      child.once("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          finish(
            new ProcessFailure(
              "nonzero",
              providerFailureCategory(Buffer.concat(stderr).toString("utf8")),
            ),
          );
          return;
        }
        try {
          finish(undefined, JSON.parse(Buffer.concat(stdout).toString("utf8")));
        } catch {
          finish(new ProcessFailure("malformed_json"));
        }
      });
    });
  }

  async runSecretText(request: ProcessRequest): Promise<string> {
    const secret = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(request.command, [...request.args], {
        cwd: request.cwd,
        detached: USE_PROCESS_GROUP,
        env: sanitizedChildEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      let stdoutSize = 0;
      let stderrSize = 0;
      let settled = false;
      const wipe = (): void => {
        for (const chunk of stdout) chunk.fill(0);
      };
      const finish = (failure?: ProcessFailure, value?: Buffer): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (failure) {
          wipe();
          reject(failure);
        } else if (value) {
          resolve(value);
        } else {
          wipe();
          reject(new ProcessFailure("malformed_json"));
        }
      };
      const abort = (reason: ProcessFailureReason): void => {
        terminate(child);
        finish(new ProcessFailure(reason));
      };
      const timer = setTimeout(() => abort("timeout"), request.timeoutMs);
      child.once("error", () => finish(new ProcessFailure("launch")));
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutSize += chunk.byteLength;
        if (stdoutSize > request.maxStdoutBytes) {
          abort("stdout_limit");
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrSize += chunk.byteLength;
        if (stderrSize > request.maxStderrBytes) abort("stderr_limit");
      });
      child.once("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          finish(new ProcessFailure("nonzero"));
          return;
        }
        finish(undefined, Buffer.concat(stdout));
        wipe();
      });
    });
    try {
      const value = secret.toString("utf8").trim();
      if (!value || value.includes("\n") || value.includes("\r")) {
        throw new ProcessFailure("malformed_json");
      }
      return value;
    } finally {
      secret.fill(0);
    }
  }
}
