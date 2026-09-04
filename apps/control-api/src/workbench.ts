import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { AgentWorkbenchRecipeV1 } from "@harbor-hf/contracts";
import { deterministicId, sha256 } from "@harbor-hf/contracts";
import {
  type AgentWorkbenchPreview,
  compileAgentWorkbenchRecipe,
  workbenchRuntimeValues,
} from "@harbor-hf/control-core";
import type {
  WorkbenchJobClient,
  WorkbenchJobEvent,
  WorkbenchJobSnapshot,
} from "@harbor-hf/hf-adapters";

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 1_000;
const MAX_PREVIEW_BYTES = 64 * 1024;
const MAX_TOTAL_PREVIEW_BYTES = 1024 * 1024;
const MAX_REMOTE_EVENTS = 4_096;
const SETUP_ATTESTATION_TTL_MS = 60 * 60 * 1_000;

export interface WorkbenchFile {
  file_id: string;
  path: string;
  root: "workspace" | "logs";
  size: number;
  text: boolean;
}

export interface WorkbenchSetupView {
  setup_test_id: string;
  recipe_digest: string;
  revision_id: string;
  status:
    | "queued"
    | "running"
    | "cancelling"
    | "cancelled"
    | "passed"
    | "failed"
    | "timed-out";
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  exit_code: number | null;
  error: string | null;
  files: WorkbenchFile[];
}

export interface WorkbenchSetupAttestation {
  setup_test_id: string;
  recipe_digest: string;
  revision_id: string;
  completed_at: string;
  expires_at: string;
}

interface SetupState extends WorkbenchSetupView {
  owner: string;
  attestable: boolean;
  stdout: string;
  stderr: string;
  directory: string | null;
  process: ChildProcess | null;
  timeout: NodeJS.Timeout | null;
  cancellation_requested: boolean;
  container_name: string | null;
  filePaths: Map<string, string>;
  filePreviews: Map<string, { content: string; truncated: boolean }>;
  remote_job_id: string | null;
  remote_abort: AbortController | null;
  remote_stream: Promise<void> | null;
  remote_stream_complete: boolean;
  remote_result_received: boolean;
  remote_sequences: Set<number>;
  remote_preview_bytes: number;
}

function appendBounded(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next) <= MAX_LOG_BYTES) return next;
  const bytes = Buffer.from(next);
  return `[earlier output truncated]\n${bytes.subarray(bytes.length - MAX_LOG_BYTES).toString("utf8")}`;
}

function setupEnvironment(recipe: AgentWorkbenchRecipeV1): Record<string, string> {
  const values: Record<string, string> = {
    workspace_path: "/workspace",
    logs_path: "/logs",
    agent_home: "/agent-home",
    model_name: workbenchRuntimeValues.model_name,
  };
  const environment: Record<string, string> = {};
  for (const binding of recipe.environment) {
    if (
      ["instruction_path", "model_base_url", "model_api_key"].includes(binding.source)
    )
      continue;
    const value =
      binding.source === "literal" ? (binding.value ?? "") : values[binding.source];
    if (value === undefined)
      throw new Error(`workbench binding ${binding.source} is unavailable`);
    environment[binding.name] = value;
  }
  return environment;
}

async function scanRoot(
  state: SetupState,
  rootName: "workspace" | "logs",
  root: string,
): Promise<void> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (state.files.length >= MAX_FILES) break;
    const parent = entry.parentPath;
    const absolute = join(parent, entry.name);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
    const path = relative(root, absolute).replaceAll("\\", "/");
    if (!path || path.startsWith("../") || path.includes("/../")) continue;
    const prefix = rootName === "workspace" ? "workspace" : "logs";
    const fileId = deterministicId("workbench-file", state.setup_test_id, prefix, path);
    let text = false;
    if (metadata.size <= MAX_PREVIEW_BYTES) {
      const bytes = await readFile(absolute);
      text = !bytes.includes(0);
    }
    state.filePaths.set(fileId, absolute);
    state.files.push({
      file_id: fileId,
      path,
      root: rootName,
      size: metadata.size,
      text,
    });
  }
  state.files.sort(
    (left, right) =>
      left.root.localeCompare(right.root) || left.path.localeCompare(right.path),
  );
}

export class WorkbenchRuntime {
  private readonly setupTests = new Map<string, SetupState>();
  private root: string | null = null;

  constructor(
    private readonly mode: "disabled" | "docker" | "hf-jobs",
    private readonly image: string,
    private readonly remoteJobs: WorkbenchJobClient | null = null,
    private readonly remoteLogSliceMs = 5_000,
    private readonly remoteRetryMs = 1_000,
  ) {}

  preview(value: unknown): AgentWorkbenchPreview {
    return compileAgentWorkbenchRecipe(value);
  }

  private async workbenchRoot(): Promise<string> {
    this.root ??= await mkdtemp(join(tmpdir(), "harbor-hf-workbench-"));
    return this.root;
  }

  async startSetup(
    value: unknown,
    owner: string,
    idempotencyKey: string,
  ): Promise<WorkbenchSetupView> {
    if (this.mode === "disabled") throw new Error("setup testing is not enabled");
    const preview = this.preview(value);
    const setupTestId = deterministicId(
      "setup-test",
      owner,
      preview.recipe_digest,
      sha256(idempotencyKey),
    );
    const existing = this.setupTests.get(setupTestId);
    if (existing) return this.view(existing);
    if (this.mode === "hf-jobs")
      return await this.startRemoteSetup(preview, setupTestId, owner);
    const root = await this.workbenchRoot();
    const directory = resolve(root, setupTestId);
    const workspace = join(directory, "workspace");
    const logs = join(directory, "logs");
    const agentHome = join(directory, "agent-home");
    const recipeDirectory = join(directory, "recipe");
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(logs, { recursive: true }),
      mkdir(agentHome, { recursive: true }),
      mkdir(recipeDirectory, { recursive: true }),
    ]);
    await Promise.all([
      chmod(workspace, 0o777),
      chmod(logs, 0o777),
      chmod(agentHome, 0o777),
    ]);
    const setupScript = join(recipeDirectory, "setup.sh");
    await writeFile(
      setupScript,
      `#!/bin/sh\nset -eu\n${preview.recipe.setup_command}\n`,
      { mode: 0o700 },
    );
    const createdAt = new Date().toISOString();
    const containerName = `hhf-${setupTestId.slice(-20)}`;
    const state: SetupState = {
      setup_test_id: setupTestId,
      recipe_digest: preview.recipe_digest,
      revision_id: preview.revision_id,
      status: "queued",
      created_at: createdAt,
      started_at: null,
      completed_at: null,
      exit_code: null,
      error: null,
      files: [],
      owner,
      attestable: true,
      stdout: "",
      stderr: "",
      directory,
      process: null,
      timeout: null,
      cancellation_requested: false,
      container_name: containerName,
      filePaths: new Map(),
      filePreviews: new Map(),
      remote_job_id: null,
      remote_abort: null,
      remote_stream: null,
      remote_stream_complete: false,
      remote_result_received: false,
      remote_sequences: new Set(),
      remote_preview_bytes: 0,
    };
    this.setupTests.set(setupTestId, state);
    const args = [
      "run",
      "--rm",
      "--name",
      containerName,
      "--network",
      "bridge",
      "--cpus",
      "2",
      "--memory",
      "4g",
      "--pids-limit",
      "1024",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      "1000:1000",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=512m",
      "--volume",
      `${workspace}:/workspace:rw`,
      "--volume",
      `${logs}:/logs:rw`,
      "--volume",
      `${agentHome}:/agent-home:rw`,
      "--volume",
      `${setupScript}:/recipe/setup.sh:ro`,
      "--workdir",
      "/workspace",
      "--env",
      "HOME=/agent-home",
      "--env",
      "PATH=/agent-home/venv/bin:/usr/local/bin:/usr/bin:/bin",
    ];
    for (const [name, value] of Object.entries(setupEnvironment(preview.recipe)))
      args.push("--env", `${name}=${value}`);
    args.push(this.image, "/bin/sh", "/recipe/setup.sh");
    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        HOME: process.env.HOME ?? "/tmp",
        PATH: process.env.PATH ?? "/usr/bin:/bin",
      },
    });
    state.process = child;
    state.status = "running";
    state.started_at = new Date().toISOString();
    child.stdout.on("data", (chunk: Buffer) => {
      state.stdout = appendBounded(state.stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      state.stderr = appendBounded(state.stderr, chunk);
    });
    let timedOut = false;
    state.timeout = setTimeout(() => {
      timedOut = true;
      spawnSync("docker", ["kill", containerName], { stdio: "ignore" });
    }, preview.recipe.setup_timeout_seconds * 1000);
    child.once("error", (error) => {
      if (state.timeout) clearTimeout(state.timeout);
      state.timeout = null;
      state.status = "failed";
      state.error = error.message;
      state.completed_at = new Date().toISOString();
      state.process = null;
    });
    child.once("close", (code) => {
      if (state.timeout) clearTimeout(state.timeout);
      state.timeout = null;
      state.exit_code = code;
      state.process = null;
      void Promise.all([
        scanRoot(state, "workspace", workspace),
        scanRoot(state, "logs", logs),
      ])
        .then(() => {
          state.status = state.cancellation_requested
            ? "cancelled"
            : timedOut
              ? "timed-out"
              : code === 0
                ? "passed"
                : "failed";
          state.completed_at = new Date().toISOString();
        })
        .catch((error: unknown) => {
          state.error =
            error instanceof Error ? error.message : "could not inventory setup files";
          state.status = "failed";
          state.completed_at = new Date().toISOString();
        });
    });
    return this.view(state);
  }

  private async startRemoteSetup(
    preview: AgentWorkbenchPreview,
    setupTestId: string,
    owner: string,
  ): Promise<WorkbenchSetupView> {
    if (!this.remoteJobs) throw new Error("Hugging Face setup Jobs are not enabled");
    const state: SetupState = {
      setup_test_id: setupTestId,
      recipe_digest: preview.recipe_digest,
      revision_id: preview.revision_id,
      status: "queued",
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      exit_code: null,
      error: null,
      files: [],
      owner,
      attestable: true,
      stdout: "",
      stderr: "",
      directory: null,
      process: null,
      timeout: null,
      cancellation_requested: false,
      container_name: null,
      filePaths: new Map(),
      filePreviews: new Map(),
      remote_job_id: null,
      remote_abort: null,
      remote_stream: null,
      remote_stream_complete: false,
      remote_result_received: false,
      remote_sequences: new Set(),
      remote_preview_bytes: 0,
    };
    this.setupTests.set(setupTestId, state);
    try {
      const job = await this.remoteJobs.start({
        setup_id: setupTestId,
        owner_digest: sha256(owner).replace(/^sha256:/, ""),
        recipe_digest: preview.recipe_digest,
        revision_id: preview.revision_id,
        setup_command: preview.recipe.setup_command,
        timeout_seconds: preview.recipe.setup_timeout_seconds,
        environment: setupEnvironment(preview.recipe),
      });
      state.remote_job_id = job.job_id;
      this.applyRemoteSnapshot(state, job);
      const abort = new AbortController();
      state.remote_abort = abort;
      state.remote_stream = this.consumeRemoteEvents(state, abort.signal);
      return this.view(state);
    } catch (error) {
      this.setupTests.delete(setupTestId);
      throw new Error("Hugging Face setup Job could not be started", {
        cause: error,
      });
    }
  }

  async listSetups(owner: string): Promise<WorkbenchSetupView[]> {
    if (this.mode !== "hf-jobs" || !this.remoteJobs)
      return [...this.setupTests.values()]
        .filter((state) => state.owner === owner)
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
        .map((state) => this.view(state));
    const recoveries = await this.remoteJobs.list(
      sha256(owner).replace(/^sha256:/, ""),
    );
    for (const recovery of recoveries) {
      if (this.setupTests.has(recovery.setup_id)) continue;
      const abort = new AbortController();
      const state: SetupState = {
        setup_test_id: recovery.setup_id,
        recipe_digest: recovery.recipe_digest,
        revision_id: recovery.revision_id,
        status: "queued",
        created_at: recovery.snapshot.created_at,
        started_at: recovery.snapshot.started_at,
        completed_at: recovery.snapshot.completed_at,
        exit_code: null,
        error: null,
        files: [],
        owner,
        attestable: false,
        stdout: "",
        stderr: "",
        directory: null,
        process: null,
        timeout: null,
        cancellation_requested: false,
        container_name: null,
        filePaths: new Map(),
        filePreviews: new Map(),
        remote_job_id: recovery.snapshot.job_id,
        remote_abort: abort,
        remote_stream: null,
        remote_stream_complete: false,
        remote_result_received: false,
        remote_sequences: new Set(),
        remote_preview_bytes: 0,
      };
      this.setupTests.set(recovery.setup_id, state);
      this.applyRemoteSnapshot(state, recovery.snapshot);
      state.remote_stream = this.consumeRemoteEvents(state, abort.signal);
    }
    return recoveries
      .map((recovery) => this.setupTests.get(recovery.setup_id))
      .filter((state): state is SetupState => state !== undefined)
      .map((state) => this.view(state));
  }

  private applyRemoteEvent(state: SetupState, event: WorkbenchJobEvent): void {
    if (state.remote_sequences.has(event.sequence)) return;
    if (state.remote_sequences.size >= MAX_REMOTE_EVENTS) return;
    state.remote_sequences.add(event.sequence);
    if (event.kind === "stdout" || event.kind === "stderr") {
      state[event.kind] = appendBounded(
        state[event.kind],
        Buffer.from(event.content, "utf8"),
      );
      return;
    }
    if (event.kind === "file") {
      if (state.files.length >= MAX_FILES) return;
      const fileId = deterministicId(
        "workbench-file",
        state.setup_test_id,
        event.root,
        event.path,
      );
      if (state.files.some((file) => file.file_id === fileId)) return;
      state.files.push({
        file_id: fileId,
        path: event.path,
        root: event.root,
        size: event.size,
        text: event.text,
      });
      const previewBytes =
        event.text && event.content !== null ? Buffer.byteLength(event.content) : 0;
      const retainPreview =
        previewBytes <= MAX_PREVIEW_BYTES &&
        state.remote_preview_bytes + previewBytes <= MAX_TOTAL_PREVIEW_BYTES;
      if (retainPreview && event.text && event.content !== null) {
        state.filePreviews.set(fileId, {
          content: event.content,
          truncated: false,
        });
        state.remote_preview_bytes += previewBytes;
      }
      state.files.sort(
        (left, right) =>
          left.root.localeCompare(right.root) || left.path.localeCompare(right.path),
      );
      return;
    }
    if (event.kind !== "result") return;
    state.remote_result_received = true;
    state.exit_code = event.exit_code;
    state.status = state.cancellation_requested
      ? "cancelled"
      : event.timed_out
        ? "timed-out"
        : event.exit_code === 0
          ? "passed"
          : "failed";
    state.completed_at = new Date().toISOString();
  }

  private async consumeRemoteEvents(
    state: SetupState,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.remoteJobs || !state.remote_job_id) return;
    let terminalObserved = false;
    try {
      while (!signal.aborted && !state.remote_result_received) {
        try {
          const attemptSignal = AbortSignal.any([
            signal,
            AbortSignal.timeout(this.remoteLogSliceMs),
          ]);
          for await (const event of this.remoteJobs.events(
            state.remote_job_id,
            attemptSignal,
          )) {
            this.applyRemoteEvent(state, event);
            if (state.remote_result_received) break;
          }
        } catch {
          if (signal.aborted) return;
        }
        if (signal.aborted || state.remote_result_received) return;
        let snapshot: WorkbenchJobSnapshot | null = null;
        try {
          snapshot = await this.remoteJobs.observe(state.remote_job_id);
          this.applyRemoteSnapshot(state, snapshot);
        } catch {
          snapshot = null;
        }
        const terminal =
          snapshot !== null && this.remoteStageIsTerminal(snapshot.stage);
        if (terminal && terminalObserved) return;
        terminalObserved = terminal;
        await this.waitForRemoteRetry(signal);
      }
    } finally {
      state.remote_stream_complete = true;
      if (!signal.aborted) await this.refreshRemote(state);
    }
  }

  private remoteStageIsTerminal(stage: string): boolean {
    return ["STOPPED", "COMPLETED", "CANCELLED", "CANCELED", "ERROR"].includes(
      stage.toUpperCase(),
    );
  }

  private async waitForRemoteRetry(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(finish, this.remoteRetryMs);
      signal.addEventListener("abort", finish, { once: true });
      function finish() {
        clearTimeout(timeout);
        signal.removeEventListener("abort", finish);
        resolve();
      }
    });
  }

  private applyRemoteSnapshot(state: SetupState, snapshot: WorkbenchJobSnapshot): void {
    state.created_at = snapshot.created_at;
    state.started_at = snapshot.started_at;
    if (state.remote_result_received) {
      state.completed_at ??= snapshot.completed_at;
      return;
    }
    const stage = snapshot.stage.toUpperCase();
    const terminal = this.remoteStageIsTerminal(stage);
    if (!terminal) {
      state.status = state.cancellation_requested
        ? "cancelling"
        : stage === "RUNNING"
          ? "running"
          : "queued";
      return;
    }
    if (!state.remote_stream_complete) return;
    state.completed_at = snapshot.completed_at ?? new Date().toISOString();
    if (state.cancellation_requested || stage === "CANCELLED" || stage === "CANCELED") {
      state.status = "cancelled";
      return;
    }
    if (
      stage === "ERROR" &&
      snapshot.message &&
      /tim(?:e|ed)[ -]?out/i.test(snapshot.message)
    ) {
      state.status = "timed-out";
      return;
    }
    state.status = "failed";
    state.error ??= "setup Job completed without a final result";
  }

  private async refreshRemote(state: SetupState): Promise<void> {
    if (!this.remoteJobs || !state.remote_job_id) return;
    try {
      this.applyRemoteSnapshot(
        state,
        await this.remoteJobs.observe(state.remote_job_id),
      );
    } catch {
      return;
    }
  }

  async cancelSetup(
    setupTestId: string,
    owner: string,
  ): Promise<WorkbenchSetupView | null> {
    const state = this.setupTests.get(setupTestId);
    if (!state || state.owner !== owner) return null;
    if (["cancelled", "passed", "failed", "timed-out"].includes(state.status))
      return this.view(state);
    state.cancellation_requested = true;
    state.status = "cancelling";
    if (state.timeout) clearTimeout(state.timeout);
    state.timeout = null;
    if (state.process && state.container_name) {
      const killed = spawnSync("docker", ["kill", state.container_name], {
        stdio: "ignore",
      });
      if (killed.status !== 0) state.process.kill("SIGTERM");
    }
    if (state.remote_job_id && this.remoteJobs) {
      try {
        this.applyRemoteSnapshot(
          state,
          await this.remoteJobs.cancel(state.remote_job_id),
        );
      } catch (error) {
        await this.refreshRemote(state);
        if (!["cancelled", "passed", "failed", "timed-out"].includes(state.status))
          throw new Error("Hugging Face setup Job could not be cancelled", {
            cause: error,
          });
      }
    }
    return this.view(state);
  }

  async getSetup(
    setupTestId: string,
    owner: string,
  ): Promise<WorkbenchSetupView | null> {
    const state = this.setupTests.get(setupTestId);
    if (!state || state.owner !== owner) return null;
    if (state.remote_job_id) await this.refreshRemote(state);
    return this.view(state);
  }

  async attestPassedSetup(
    setupTestId: string,
    owner: string,
    recipe: unknown,
  ): Promise<WorkbenchSetupAttestation> {
    const preview = this.preview(recipe);
    let state = this.setupTests.get(setupTestId);
    if ((!state || state.owner !== owner) && this.mode === "hf-jobs")
      await this.listSetups(owner);
    state = this.setupTests.get(setupTestId);
    if (!state || state.owner !== owner)
      throw new Error("setup test is unavailable for this actor");
    if (!state.attestable)
      throw new Error("setup test must be rerun after service restart");
    if (state.remote_job_id) await this.refreshRemote(state);
    if (
      state.recipe_digest !== preview.recipe_digest ||
      state.revision_id !== preview.revision_id
    )
      throw new Error("setup test does not match this exact recipe");
    if (
      state.status !== "passed" ||
      state.exit_code !== 0 ||
      state.completed_at === null
    )
      throw new Error("setup test has not passed");
    const completedAt = Date.parse(state.completed_at);
    if (
      !Number.isFinite(completedAt) ||
      completedAt + SETUP_ATTESTATION_TTL_MS <= Date.now()
    )
      throw new Error("setup test has expired");
    return {
      setup_test_id: state.setup_test_id,
      recipe_digest: state.recipe_digest,
      revision_id: state.revision_id,
      completed_at: state.completed_at,
      expires_at: new Date(completedAt + SETUP_ATTESTATION_TTL_MS).toISOString(),
    };
  }

  async logs(
    setupTestId: string,
    owner: string,
  ): Promise<{ stdout: string; stderr: string } | null> {
    const state = this.setupTests.get(setupTestId);
    if (!state || state.owner !== owner) return null;
    return { stdout: state.stdout, stderr: state.stderr };
  }

  async file(
    setupTestId: string,
    fileId: string,
    owner: string,
  ): Promise<{ content: string; truncated: boolean } | null> {
    const state = this.setupTests.get(setupTestId);
    const path = state?.filePaths.get(fileId);
    if (!state || state.owner !== owner) return null;
    const preview = state.filePreviews.get(fileId);
    if (preview) return preview;
    if (!path) return null;
    const handle = await open(path, "r");
    try {
      const bytes = Buffer.alloc(MAX_PREVIEW_BYTES + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const selected = bytes.subarray(0, Math.min(bytesRead, MAX_PREVIEW_BYTES));
      return {
        content: selected.toString("utf8"),
        truncated: bytesRead > selected.length,
      };
    } finally {
      await handle.close();
    }
  }

  private view(state: SetupState): WorkbenchSetupView {
    return {
      setup_test_id: state.setup_test_id,
      recipe_digest: state.recipe_digest,
      revision_id: state.revision_id,
      status: state.status,
      created_at: state.created_at,
      started_at: state.started_at,
      completed_at: state.completed_at,
      exit_code: state.exit_code,
      error: state.error,
      files: [...state.files],
    };
  }

  async close(): Promise<void> {
    const remoteStreams: Promise<void>[] = [];
    const remoteCancellations: Promise<unknown>[] = [];
    for (const state of this.setupTests.values()) {
      if (state.process) {
        if (state.timeout) clearTimeout(state.timeout);
        state.timeout = null;
        if (state.container_name)
          spawnSync("docker", ["kill", state.container_name], { stdio: "ignore" });
        state.process.kill();
      }
      if (
        this.remoteJobs &&
        state.remote_job_id &&
        !["cancelled", "passed", "failed", "timed-out"].includes(state.status)
      )
        remoteCancellations.push(
          this.remoteJobs.cancel(state.remote_job_id).catch(() => undefined),
        );
      state.remote_abort?.abort();
      if (state.remote_stream) remoteStreams.push(state.remote_stream);
    }
    await Promise.allSettled(remoteCancellations);
    await Promise.allSettled(remoteStreams);
    if (this.root) await rm(this.root, { recursive: true, force: true });
    this.root = null;
  }
}
