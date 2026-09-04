import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  BenchmarkProfileSpec,
  DeploymentProfileSpec,
  ModelProfileSpec,
} from "@harbor-hf/contracts";
import { deterministicId, sha256 } from "@harbor-hf/contracts";
import type { LoadedProfile } from "@harbor-hf/control-core/profiles";
import { compileAgentWorkbenchRecipe } from "@harbor-hf/control-core/workbench";

const BENCHMARK = "terminal-bench-2-1-canary";
const MODEL = "gpt-oss-20b-together";
const DEPLOYMENT = "tb21-gpt-oss-20b-fast-agent-command-providers";
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const INFERENCE_TOKEN_REFERENCE = ["$", "{HF_INFERENCE_TOKEN}"].join("");
const REDACTED = "[redacted]";

export interface LocalHarborOptions {
  enabled: boolean;
  ready: boolean;
  reason: string | null;
  benchmark: string;
  model: string;
  task_names: string[];
  harbor_version: string | null;
  expected_harbor_version: string | null;
}

export interface LocalHarborRunView {
  local_run_id: string;
  recipe_digest: string;
  status: "queued" | "running" | "cancelling" | "cancelled" | "succeeded" | "failed";
  benchmark: string;
  model: string;
  task_names: string[];
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  exit_code: number | null;
  error: string | null;
  config_path: string;
  result_path: string | null;
  command: string[];
}

interface LocalRunState extends LocalHarborRunView {
  owner: string;
  config: Record<string, unknown>;
  stdout: string;
  stderr: string;
  process: ChildProcess | null;
  cancellation_requested: boolean;
}

function redact(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets)
    if (secret) redacted = redacted.replaceAll(secret, REDACTED);
  return redacted;
}

function appendBounded(
  current: string,
  chunk: Buffer,
  secrets: readonly string[],
): string {
  const next = redact(current + chunk.toString("utf8"), secrets);
  if (Buffer.byteLength(next) <= MAX_LOG_BYTES) return next;
  const bytes = Buffer.from(next);
  return `[earlier output truncated]\n${bytes.subarray(bytes.length - MAX_LOG_BYTES).toString("utf8")}`;
}

function profile<T>(
  profiles: readonly LoadedProfile[],
  kind: LoadedProfile["profile"]["profile_kind"],
  name: string,
): T {
  const match = profiles.find(
    (item) => item.profile.profile_kind === kind && item.profile.name === name,
  );
  if (!match) throw new Error(`local Harbor profile is missing: ${kind}/${name}`);
  return match.profile.spec as T;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class LocalHarborRuntime {
  private readonly runs = new Map<string, LocalRunState>();
  private readonly benchmark: BenchmarkProfileSpec;
  private readonly model: ModelProfileSpec;
  private readonly deployment: DeploymentProfileSpec;
  private readonly sourceRoot: string;
  private readonly runsRoot: string;
  private version: { harborVersion: string | null; error: string | null } | undefined;

  constructor(
    private readonly enabled: boolean,
    private readonly inferenceToken: string | null,
    profilesRoot: string,
    profiles: readonly LoadedProfile[],
    private readonly harborBin = "harbor",
  ) {
    this.benchmark = profile<BenchmarkProfileSpec>(profiles, "benchmark", BENCHMARK);
    this.model = profile<ModelProfileSpec>(profiles, "model", MODEL);
    this.deployment = profile<DeploymentProfileSpec>(
      profiles,
      "deployment",
      DEPLOYMENT,
    );
    this.sourceRoot = dirname(profilesRoot);
    this.runsRoot = resolve(this.sourceRoot, ".harbor-hf", "local-runs");
  }

  options(): LocalHarborOptions {
    const expectedHarborVersion =
      this.deployment.route === "hf_job"
        ? (this.deployment.harbor_version ?? null)
        : null;
    let reason: string | null = null;
    if (!this.enabled)
      return {
        enabled: false,
        ready: false,
        reason: "Local Harbor execution is development-only.",
        benchmark: BENCHMARK,
        model: MODEL,
        task_names: this.taskNames(),
        harbor_version: null,
        expected_harbor_version: expectedHarborVersion,
      };
    this.version ??= this.probeVersion();
    const harborVersion = this.version.harborVersion;
    if (this.version.error) reason = this.version.error;
    else if (!this.inferenceToken)
      reason = "Set HF_INFERENCE_TOKEN before starting the local control API.";
    else if (expectedHarborVersion && harborVersion !== expectedHarborVersion)
      reason = `Harbor ${expectedHarborVersion} is required; found ${harborVersion ?? "an unknown version"}.`;
    return {
      enabled: true,
      ready: reason === null,
      reason,
      benchmark: BENCHMARK,
      model: MODEL,
      task_names: this.taskNames(),
      harbor_version: harborVersion,
      expected_harbor_version: expectedHarborVersion,
    };
  }

  private probeVersion(): {
    harborVersion: string | null;
    error: string | null;
  } {
    const versionResult = spawnSync(this.harborBin, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      },
    });
    const output = `${versionResult.stdout ?? ""}${versionResult.stderr ?? ""}`.trim();
    if (versionResult.error || versionResult.status !== 0 || !output)
      return {
        harborVersion: null,
        error: "The harbor executable was not found on the control API PATH.",
      };
    const match = output.match(/\d+\.\d+\.\d+/);
    if (!match)
      return {
        harborVersion: null,
        error: "The installed Harbor version could not be determined.",
      };
    return { harborVersion: match[0], error: null };
  }

  private taskNames(): string[] {
    const sourceTaskIds = this.benchmark.source_task_ids;
    if (!sourceTaskIds?.length)
      throw new Error("local canary benchmark has no source task IDs");
    return [...sourceTaskIds];
  }

  private selectedTasks(value: unknown): string[] {
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      !value.every((item) => typeof item === "string")
    )
      throw new Error("select at least one canary task");
    const allowed = new Set(this.taskNames());
    const selected = [...new Set(value)];
    const invalid = selected.find((item) => !allowed.has(item));
    if (invalid) throw new Error(`unknown local canary task: ${invalid}`);
    return selected;
  }

  config(
    recipeValue: unknown,
    taskNamesValue: unknown,
    localRunId = "local-preview",
  ): Record<string, unknown> {
    const preview = compileAgentWorkbenchRecipe(recipeValue);
    const taskNames = this.selectedTasks(taskNamesValue);
    const rawJob = this.benchmark.harbor_job;
    if (!rawJob || typeof rawJob !== "object")
      throw new Error("local canary benchmark has no Harbor job");
    if (preview.recipe.route_api !== "chat-completions")
      throw new Error("the local MVP uses the deployment's direct inference API");
    if (
      !preview.recipe.environment.some((binding) => binding.source === "model_base_url")
    )
      throw new Error(
        "the local MVP requires a direct model base URL binding; this recipe is setup-only",
      );
    if (this.deployment.route !== "hf_job")
      throw new Error("local deployment is not Harbor Job compatible");
    const template = this.deployment.trial_job_template ?? this.deployment;
    if (!template.inference_upstream)
      throw new Error("local deployment has no direct inference upstream");
    const harborAgent = preview.harness_profile.harbor_agent;
    if (!harborAgent) throw new Error("compiled harness has no Harbor agent");
    const rawDatasets = (rawJob as Record<string, unknown>).datasets;
    if (!Array.isArray(rawDatasets))
      throw new Error("local canary benchmark has no Harbor dataset");
    const datasets = clone(rawDatasets).map((dataset) => ({
      ...(dataset as Record<string, unknown>),
      task_names: taskNames,
    }));
    if (datasets.length !== 1)
      throw new Error("local MVP expects one Terminal-Bench dataset");
    return {
      ...clone(rawJob),
      job_name: localRunId,
      jobs_dir: join(this.runsRoot, localRunId, "jobs"),
      n_attempts: 1,
      n_concurrent_trials: taskNames.length,
      retry: { max_retries: 0 },
      datasets,
      agents: [
        {
          import_path: harborAgent.import_path,
          model_name: this.model.harbor_model_name,
          env: {
            ...clone(harborAgent.env ?? {}),
            OPENAI_API_KEY: INFERENCE_TOKEN_REFERENCE,
            OPENAI_BASE_URL: template.inference_upstream,
            HARBOR_HF_MAX_OUTPUT_TOKENS: String(
              template.inference_max_output_tokens ?? 32768,
            ),
            HARBOR_HF_PROVIDER_TIMEOUT_SECONDS: String(
              template.inference_timeout_seconds ?? 1800,
            ),
          },
          extra_allowed_hosts: [
            ...new Set([
              ...(harborAgent.extra_allowed_hosts ?? []),
              new URL(template.inference_upstream).hostname,
            ]),
          ],
          ...(Object.keys(harborAgent.kwargs).length > 0
            ? { kwargs: clone(harborAgent.kwargs) }
            : {}),
          ...(harborAgent.override_setup_timeout_sec
            ? {
                override_setup_timeout_sec: harborAgent.override_setup_timeout_sec,
              }
            : {}),
        },
      ],
    };
  }

  async start(
    recipeValue: unknown,
    taskNamesValue: unknown,
    owner: string,
    idempotencyKey: string,
  ): Promise<LocalHarborRunView> {
    const options = this.options();
    if (!options.ready)
      throw new Error(options.reason ?? "local Harbor is unavailable");
    const preview = compileAgentWorkbenchRecipe(recipeValue);
    const recipe = preview.recipe;
    const taskNames = this.selectedTasks(taskNamesValue);
    const localRunId = deterministicId("local-run", owner, sha256(idempotencyKey));
    const existing = this.runs.get(localRunId);
    if (existing) {
      const sameRequest =
        existing.recipe_digest === preview.recipe_digest &&
        JSON.stringify(existing.task_names) === JSON.stringify(taskNames);
      if (!sameRequest)
        throw new Error("idempotency key was already used for another local run");
      return this.view(existing);
    }
    if (
      [...this.runs.values()].some(
        (state) =>
          state.process && ["queued", "running", "cancelling"].includes(state.status),
      )
    )
      throw new Error("another local Harbor run is already active");
    const config = this.config(recipe, taskNames, localRunId);
    const directory = join(this.runsRoot, localRunId);
    const configPath = join(directory, "config.json");
    const command = [this.harborBin, "run", "--config", configPath, "--yes"];
    const state: LocalRunState = {
      local_run_id: localRunId,
      recipe_digest: preview.recipe_digest,
      status: "queued",
      benchmark: BENCHMARK,
      model: MODEL,
      task_names: taskNames,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      exit_code: null,
      error: null,
      config_path: configPath,
      result_path: null,
      command,
      owner,
      config,
      stdout: "",
      stderr: "",
      process: null,
      cancellation_requested: false,
    };
    this.runs.set(localRunId, state);
    let child: ChildProcess;
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
        mode: 0o600,
      });
      const pluginSource = join(this.sourceRoot, "packages", "harbor-hf-agents", "src");
      child = spawn(command[0] as string, command.slice(1), {
        cwd: this.sourceRoot,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: this.childEnvironment(pluginSource),
      });
    } catch (error) {
      this.runs.delete(localRunId);
      throw error;
    }
    state.process = child;
    state.status = "running";
    state.started_at = new Date().toISOString();
    child.stdout?.on("data", (chunk: Buffer) => {
      state.stdout = appendBounded(state.stdout, chunk, [
        this.inferenceToken as string,
      ]);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      state.stderr = appendBounded(state.stderr, chunk, [
        this.inferenceToken as string,
      ]);
    });
    child.once("error", (error) => {
      state.status = "failed";
      state.error = error.message;
      state.completed_at = new Date().toISOString();
      state.process = null;
    });
    child.once("close", (code) => {
      state.exit_code = code;
      const resultPath = join(
        this.runsRoot,
        localRunId,
        "jobs",
        localRunId,
        "result.json",
      );
      state.result_path = existsSync(resultPath) ? resultPath : null;
      state.status = state.cancellation_requested
        ? "cancelled"
        : code === 0
          ? "succeeded"
          : "failed";
      state.completed_at = new Date().toISOString();
      state.process = null;
    });
    return this.view(state);
  }

  private childEnvironment(pluginSource: string): NodeJS.ProcessEnv {
    const inherited = [
      "DOCKER_HOST",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "REQUESTS_CA_BUNDLE",
      "SSL_CERT_DIR",
      "SSL_CERT_FILE",
      "TMPDIR",
      "XDG_RUNTIME_DIR",
    ] as const;
    const environment: NodeJS.ProcessEnv = {
      HOME: process.env.HOME ?? "/tmp",
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HF_INFERENCE_TOKEN: this.inferenceToken as string,
      PYTHONPATH: [pluginSource, process.env.PYTHONPATH]
        .filter((value): value is string => Boolean(value))
        .join(":"),
    };
    for (const name of inherited) {
      const value = process.env[name];
      if (value) environment[name] = value;
    }
    return environment;
  }

  list(owner: string): LocalHarborRunView[] {
    return [...this.runs.values()]
      .filter((state) => state.owner === owner)
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .map((state) => this.view(state));
  }

  get(localRunId: string, owner: string): LocalHarborRunView | null {
    const state = this.runs.get(localRunId);
    return state?.owner === owner ? this.view(state) : null;
  }

  logs(localRunId: string, owner: string): { stdout: string; stderr: string } | null {
    const state = this.runs.get(localRunId);
    if (!state || state.owner !== owner) return null;
    return { stdout: state.stdout, stderr: state.stderr };
  }

  cancel(localRunId: string, owner: string): LocalHarborRunView | null {
    const state = this.runs.get(localRunId);
    if (!state || state.owner !== owner) return null;
    if (!state.process || !["queued", "running"].includes(state.status))
      return this.view(state);
    state.cancellation_requested = true;
    state.status = "cancelling";
    if (state.process.pid) {
      try {
        process.kill(-state.process.pid, "SIGTERM");
      } catch {
        state.process.kill("SIGTERM");
      }
    }
    return this.view(state);
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.runs.values()].map(async (state) => {
        const child = state.process;
        if (!child?.pid) return;
        state.cancellation_requested = true;
        await new Promise<void>((resolvePromise) => {
          const force = setTimeout(() => {
            this.signalProcess(child, "SIGKILL");
          }, 5_000);
          child.once("close", () => {
            clearTimeout(force);
            resolvePromise();
          });
          this.signalProcess(child, "SIGTERM");
        });
      }),
    );
  }

  private signalProcess(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  }

  private view(state: LocalRunState): LocalHarborRunView {
    return {
      local_run_id: state.local_run_id,
      recipe_digest: state.recipe_digest,
      status: state.status,
      benchmark: state.benchmark,
      model: state.model,
      task_names: [...state.task_names],
      created_at: state.created_at,
      started_at: state.started_at,
      completed_at: state.completed_at,
      exit_code: state.exit_code,
      error: state.error,
      config_path: state.config_path,
      result_path: state.result_path,
      command: [...state.command],
    };
  }
}
