import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { sanitizedChildEnvironment } from "./environment.js";
import { assertRevision } from "./model.js";

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

interface TextRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  maxBytes: number;
}

async function runText(request: TextRequest): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      detached: USE_PROCESS_GROUP,
      env: sanitizedChildEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderrSize = 0;
    let failed = false;
    const timer = setTimeout(() => {
      failed = true;
      terminate(child);
      reject(new Error("local source command timed out"));
    }, request.timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      if (!failed) reject(new Error("local source command failed"));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > request.maxBytes && !failed) {
        failed = true;
        terminate(child);
        clearTimeout(timer);
        reject(new Error("local source command output exceeded limit"));
      } else {
        chunks.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrSize += chunk.byteLength;
      if (stderrSize > request.maxBytes && !failed) {
        failed = true;
        terminate(child);
        clearTimeout(timer);
        reject(new Error("local source command output exceeded limit"));
      }
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0) {
        reject(new Error("local source command failed"));
        return;
      }
      resolvePromise(Buffer.concat(chunks).toString("utf8").trim());
    });
  });
}

export interface SourceAdapter {
  inspect(): Promise<{ repositoryRoot: string; revision: string }>;
  bundle(directory: string): Promise<void>;
}

export async function locateGitRepositoryRoot(
  initialCwd: string = process.cwd(),
): Promise<string> {
  return resolve(
    await runText({
      command: "git",
      args: ["rev-parse", "--show-toplevel"],
      cwd: initialCwd,
      timeoutMs: 10_000,
      maxBytes: 16 * 1024,
    }),
  );
}

export class GitSourceAdapter implements SourceAdapter {
  constructor(private readonly initialCwd: string = process.cwd()) {}

  async inspect(): Promise<{ repositoryRoot: string; revision: string }> {
    const repositoryRoot = await locateGitRepositoryRoot(this.initialCwd);
    const status = await runText({
      command: "git",
      args: ["status", "--porcelain=v1", "--untracked-files=all"],
      cwd: repositoryRoot,
      timeoutMs: 10_000,
      maxBytes: 1024 * 1024,
    });
    if (status) throw new Error("source must be a clean committed exact HEAD");
    const revision = await runText({
      command: "git",
      args: ["rev-parse", "HEAD"],
      cwd: repositoryRoot,
      timeoutMs: 10_000,
      maxBytes: 16 * 1024,
    });
    assertRevision(revision);
    const committed = await runText({
      command: "git",
      args: ["rev-parse", "--verify", `${revision}^{commit}`],
      cwd: repositoryRoot,
      timeoutMs: 10_000,
      maxBytes: 16 * 1024,
    });
    if (committed !== revision) throw new Error("source HEAD is not committed");
    return { repositoryRoot, revision };
  }

  async bundle(directory: string): Promise<void> {
    const source = await this.inspect();
    await runText({
      command: "npm",
      args: ["run", "bundle:space", "--", resolve(directory)],
      cwd: source.repositoryRoot,
      timeoutMs: 10 * 60_000,
      maxBytes: 1024 * 1024,
    });
    const trackedStatus = await runText({
      command: "git",
      args: ["status", "--porcelain=v1", "--untracked-files=no"],
      cwd: source.repositoryRoot,
      timeoutMs: 10_000,
      maxBytes: 1024 * 1024,
    });
    const revision = await runText({
      command: "git",
      args: ["rev-parse", "HEAD"],
      cwd: source.repositoryRoot,
      timeoutMs: 10_000,
      maxBytes: 16 * 1024,
    });
    if (trackedStatus || revision !== source.revision) {
      throw new Error("source changed while bundling");
    }
  }
}
