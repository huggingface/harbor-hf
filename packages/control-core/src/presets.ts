import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentPresetV1,
  AgentConfig,
  BenchmarkPresetV1,
  HarborJobConfigV1,
} from "@harbor-hf/contracts";
import {
  validateAgentPreset,
  validateBenchmarkPreset,
  validateHarborJobConfig,
} from "@harbor-hf/contracts";

import {
  INFERENCE_TOKEN_TEMPLATE,
  LABELED_ENVIRONMENT,
  ROUTER_URL,
} from "./hf-config.js";

import {
  containsCredentialMaterial,
  isReasoningIntent,
} from "@harbor-hf/contracts/credentials";
export { containsCredentialMaterial } from "@harbor-hf/contracts/credentials";
import { InferenceBindingDenied } from "@harbor-hf/contracts";
import type { PresetEndpointConnection } from "./inference-bindings.js";

export interface PresetSubmission {
  benchmark: { name: string; preset: string };
  /** A router route names the Hub provider. A reviewed endpoint connection names the
   *  connection and the native wire API style instead, so one submission never carries
   *  both and a credential never changes where the run goes. */
  model: {
    id: string;
    provider?: string | undefined;
    connection?: string | undefined;
    model_api?: string | undefined;
    reasoning_effort: string;
  };
  harness: { agent: string; version: string };
  n_concurrent_trials?: number | undefined;
  cost_ceiling_usd: number;
  role?: "final" | "diagnostic";
}

export type HarborAgentFragment = Pick<
  AgentConfig,
  | "model_name"
  | "name"
  | "import_path"
  | "kwargs"
  | "override_setup_timeout_sec"
  | "env"
  | "extra_allowed_hosts"
>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function labeledEnvironment(
  environment: BenchmarkPresetV1["job"]["environment"],
  runId: string,
) {
  return {
    import_path: LABELED_ENVIRONMENT,
    kwargs: {
      ...clone(environment.kwargs),
      run_label: runId,
    },
  };
}

async function jsonFiles<T>(
  directory: string,
  validator: (value: unknown) => T,
): Promise<T[]> {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
  files.sort();
  return Promise.all(
    files.map(async (file) =>
      validator(JSON.parse(await readFile(join(directory, file), "utf8")) as unknown),
    ),
  );
}

/** Reviewed implementation identity of a preset, or null when it is not a plugin preset. */
export function presetImportPath(preset: AgentPresetV1): string | null {
  const value = (preset.harbor_agent as { import_path?: unknown }).import_path;
  return typeof value === "string" && value ? value : null;
}

/** Agent record for a native preset run on a reviewed endpoint connection the submission
 *  named. The grant owns the base URL, the admitted hosts and the key destination; the
 *  submission names the native wire API style, and admission requires the two to agree. */
export function presetEndpointAgent(
  base: Record<string, unknown> | undefined,
  preset: AgentPresetV1,
  modelId: string,
  connection: PresetEndpointConnection,
  modelApi: string,
  reasoningEffort: string,
): Record<string, unknown> {
  if (!modelApi) throw new InferenceBindingDenied();
  const fragment = clone(preset.harbor_agent) as HarborAgentFragment;
  const kwargs = { ...(fragment.kwargs ?? {}) };
  // The reviewed subject is the versioned identity admission rechecks at every start.
  if (typeof kwargs.version !== "string" || kwargs.version.length === 0)
    throw new InferenceBindingDenied(
      "The agent preset cannot use a reviewed endpoint connection",
    );
  if (preset.reasoning_option !== null && reasoningEffort !== "default")
    kwargs[preset.reasoning_option] = reasoningEffort;
  kwargs.model_api = modelApi;
  return {
    ...base,
    ...(fragment.name ? { name: fragment.name } : {}),
    ...(fragment.import_path ? { import_path: fragment.import_path } : {}),
    ...(fragment.override_setup_timeout_sec
      ? { override_setup_timeout_sec: fragment.override_setup_timeout_sec }
      : {}),
    model_name: `openai/${modelId}`,
    env: {
      OPENAI_BASE_URL: connection.base_url,
      OPENAI_API_KEY: `\${${connection.ref}}`,
    },
    extra_allowed_hosts: [...connection.allowed_hosts],
    kwargs,
  };
}

export class PresetCatalog {
  private constructor(
    readonly benchmarks: readonly BenchmarkPresetV1[],
    readonly agents: readonly AgentPresetV1[],
  ) {}

  static async load(root: string): Promise<PresetCatalog> {
    const benchmarks = await jsonFiles(
      join(root, "benchmarks"),
      validateBenchmarkPreset,
    );
    const agents = await jsonFiles(join(root, "agents"), validateAgentPreset);
    const benchmarkKeys = new Set<string>();
    for (const item of benchmarks) {
      const key = `${item.benchmark}\u0000${item.preset}`;
      if (benchmarkKeys.has(key)) throw new Error("duplicate benchmark preset");
      benchmarkKeys.add(key);
    }
    const agentKeys = new Set<string>();
    for (const item of agents) {
      const key = `${item.agent}\u0000${item.version}`;
      if (agentKeys.has(key)) throw new Error("duplicate agent preset");
      agentKeys.add(key);
      // A null option means the preset forwards no reasoning choice. Declaring one
      // value is still meaningful: the reviewed harness artifact pins that value
      // itself, and a submission must name it.
      if (item.reasoning_option === null && item.reasoning_values.length > 1)
        throw new Error("agent without a reasoning option must not offer a choice");
    }
    return new PresetCatalog(benchmarks, agents);
  }

  benchmark(name: string, preset: string): BenchmarkPresetV1 {
    const found = this.benchmarks.find(
      (item) => item.benchmark === name && item.preset === preset,
    );
    if (!found) throw new Error("benchmark preset was not found");
    return clone(found);
  }

  agent(name: string, version: string): AgentPresetV1 {
    const found = this.agents.find(
      (item) => item.agent === name && item.version === version,
    );
    if (!found) throw new Error("agent preset was not found");
    return clone(found);
  }

  leaderboardEligible(name: string, preset: string): boolean {
    return this.benchmark(name, preset).leaderboard_eligible;
  }

  private benchmarkJob(submission: PresetSubmission): BenchmarkPresetV1["job"] {
    const job = clone(
      this.benchmark(submission.benchmark.name, submission.benchmark.preset).job,
    );
    // Both forms override Harbor's native field; no separate fan-out state.
    if (submission.n_concurrent_trials !== undefined)
      job.n_concurrent_trials = submission.n_concurrent_trials;
    return job;
  }

  buildJobConfig(
    runId: string,
    submission: PresetSubmission,
    mountRoot: string,
    endpoint: PresetEndpointConnection | null = null,
  ): HarborJobConfigV1 {
    const job = this.benchmarkJob(submission);
    const agent = this.agent(submission.harness.agent, submission.harness.version);
    if (!agent.reasoning_values.includes(submission.model.reasoning_effort))
      throw new Error("reasoning effort is not supported by the agent preset");

    const fragment = clone(agent.harbor_agent) as HarborAgentFragment;
    const kwargs = { ...(fragment.kwargs ?? {}) };
    if (
      agent.reasoning_option !== null &&
      submission.model.reasoning_effort !== "default"
    )
      kwargs[agent.reasoning_option] = submission.model.reasoning_effort;

    const usesNativeHuggingFace = agent.agent === "pi";
    if (endpoint === null && !submission.model.provider)
      throw new InferenceBindingDenied(
        "The agent preset cannot use a reviewed endpoint connection",
      );
    const harborAgent: Record<string, unknown> =
      endpoint === null
        ? {
            ...job.agents?.[0],
            ...(fragment.name ? { name: fragment.name } : {}),
            ...(fragment.import_path ? { import_path: fragment.import_path } : {}),
            ...(fragment.override_setup_timeout_sec
              ? { override_setup_timeout_sec: fragment.override_setup_timeout_sec }
              : {}),
            model_name: `${usesNativeHuggingFace ? "huggingface" : "openai"}/${submission.model.id}:${submission.model.provider}`,
            env: usesNativeHuggingFace
              ? { HF_TOKEN: INFERENCE_TOKEN_TEMPLATE }
              : {
                  OPENAI_BASE_URL: ROUTER_URL,
                  OPENAI_API_KEY: INFERENCE_TOKEN_TEMPLATE,
                },
            kwargs,
          }
        : presetEndpointAgent(
            job.agents?.[0],
            agent,
            submission.model.id,
            endpoint,
            submission.model.model_api ?? "",
            submission.model.reasoning_effort,
          );
    const config = {
      ...job,
      job_name: "job",
      jobs_dir: `${mountRoot}/runs/${runId}`,
      agents: [harborAgent],
      environment: labeledEnvironment(job.environment, runId),
    };
    return validateHarborJobConfig(config);
  }

  buildWorkbenchJobConfig(
    runId: string,
    submission: PresetSubmission,
    mountRoot: string,
    fragment: HarborAgentFragment,
  ): HarborJobConfigV1 {
    const job = this.benchmarkJob(submission);
    if (!isReasoningIntent(submission.model.reasoning_effort))
      throw new Error(
        "Reasoning intent must be at most 160 characters, control-free and credential-free",
      );
    if (fragment.import_path !== "harbor_hf_agents.command_agent.agent:CommandAgent")
      throw new Error("Workbench requires the reviewed command agent plugin");
    if (
      fragment.model_name != null &&
      (!fragment.model_name.trim() ||
        fragment.model_name.length > 320 ||
        [...fragment.model_name].some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        containsCredentialMaterial(fragment.model_name))
    )
      throw new Error("Harness model string must be non-empty and credential-free");
    const harborAgent = {
      ...job.agents?.[0],
      import_path: fragment.import_path,
      ...(fragment.override_setup_timeout_sec
        ? { override_setup_timeout_sec: fragment.override_setup_timeout_sec }
        : {}),
      model_name:
        fragment.model_name ??
        `openai/${submission.model.id}:${submission.model.provider}`,
      env: fragment.env
        ? clone(fragment.env)
        : {
            OPENAI_BASE_URL: ROUTER_URL,
            OPENAI_API_KEY: INFERENCE_TOKEN_TEMPLATE,
          },
      ...(fragment.extra_allowed_hosts
        ? { extra_allowed_hosts: clone(fragment.extra_allowed_hosts) }
        : {}),
      kwargs: clone(fragment.kwargs ?? {}),
    };
    return validateHarborJobConfig({
      ...job,
      job_name: "job",
      jobs_dir: `${mountRoot}/runs/${runId}`,
      agents: [harborAgent],
      environment: labeledEnvironment(job.environment, runId),
    });
  }
}

export { prepareDirectJobConfig } from "./direct-config.js";

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function directSubmission(
  config: HarborJobConfigV1,
  costCeilingUsd: number,
): Omit<PresetSubmission, "model" | "harness"> &
  Partial<Pick<PresetSubmission, "model" | "harness">> {
  const value = config as Record<string, unknown>;
  const agents = value.agents as Record<string, unknown>[];
  if (agents.length !== 1)
    return {
      benchmark: { name: "custom", preset: "custom" },
      cost_ceiling_usd: costCeilingUsd,
      role: "diagnostic",
    };
  const agent = agents[0] ?? {};
  const modelName = typeof agent.model_name === "string" ? agent.model_name : "unknown";
  const suffix = modelName.lastIndexOf(":");
  const provider = suffix > 0 ? modelName.slice(suffix + 1) : "custom";
  const rawModel = suffix > 0 ? modelName.slice(0, suffix) : modelName;
  const routeSeparator = rawModel.indexOf("/");
  const route = routeSeparator >= 0 ? rawModel.slice(0, routeSeparator) : "";
  const modelId = ["openai", "huggingface"].includes(route)
    ? rawModel.slice(routeSeparator + 1)
    : rawModel;
  const kwargs = record(agent.kwargs ?? {}, "agent kwargs");
  const version =
    typeof kwargs.version === "string" ? kwargs.version : "harbor-bundled";
  const name =
    typeof agent.name === "string"
      ? agent.name
      : typeof agent.import_path === "string"
        ? (agent.import_path.split(":").at(-1)?.toLowerCase() ?? "custom")
        : "custom";
  return {
    benchmark: { name: "custom", preset: "custom" },
    model: { id: modelId, provider, reasoning_effort: "default" },
    harness: { agent: name.replaceAll("_", "-").replace(/[^a-z0-9-]/g, "-"), version },
    cost_ceiling_usd: costCeilingUsd,
    role: "diagnostic",
  };
}
