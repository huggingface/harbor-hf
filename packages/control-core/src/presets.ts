import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentPresetV1,
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

import { containsCredentialMaterial } from "@harbor-hf/contracts/credentials";
export { containsCredentialMaterial } from "@harbor-hf/contracts/credentials";

export interface PresetSubmission {
  benchmark: { name: string; preset: string };
  model: { id: string; provider: string; reasoning_effort: string };
  harness: { agent: string; version: string };
  n_concurrent_trials?: number | undefined;
  cost_ceiling_usd_per_trial: number;
  role?: "final" | "diagnostic";
}

export interface HarborAgentFragment {
  model_name?: string;
  name?: string;
  import_path?: string;
  kwargs?: Record<string, unknown>;
  override_setup_timeout_sec?: number;
}

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
      if (item.reasoning_option === null && item.reasoning_values.join() !== "default")
        throw new Error("agent without a reasoning option must use only default");
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

  buildJobConfig(
    runId: string,
    submission: PresetSubmission,
    mountRoot: string,
  ): HarborJobConfigV1 {
    const benchmark = this.benchmark(
      submission.benchmark.name,
      submission.benchmark.preset,
    );
    const agent = this.agent(submission.harness.agent, submission.harness.version);
    if (!agent.reasoning_values.includes(submission.model.reasoning_effort))
      throw new Error("reasoning effort is not supported by the agent preset");

    const fragment = clone(agent.harbor_agent) as HarborAgentFragment;
    const job = clone(benchmark.job);
    // Override Harbor's native fan-out field without introducing a second concept.
    if (submission.n_concurrent_trials !== undefined)
      job.n_concurrent_trials = submission.n_concurrent_trials;
    const kwargs = { ...(fragment.kwargs ?? {}) };
    if (
      agent.reasoning_option !== null &&
      submission.model.reasoning_effort !== "default"
    )
      kwargs[agent.reasoning_option] = submission.model.reasoning_effort;

    const usesNativeHuggingFace = agent.agent === "pi";
    const harborAgent: Record<string, unknown> = {
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
    };
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
    const benchmark = this.benchmark(
      submission.benchmark.name,
      submission.benchmark.preset,
    );
    if (submission.model.reasoning_effort !== "off")
      throw new Error("Workbench command agents support reasoning effort off only");
    if (fragment.import_path !== "harbor_hf_agents.command_agent.agent:CommandAgent")
      throw new Error("Workbench requires the reviewed command agent plugin");
    if (
      fragment.model_name !== undefined &&
      (!fragment.model_name.trim() ||
        fragment.model_name.length > 320 ||
        [...fragment.model_name].some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        containsCredentialMaterial(fragment.model_name))
    )
      throw new Error("Harness model string must be non-empty and credential-free");
    const job = clone(benchmark.job);
    const harborAgent = {
      import_path: fragment.import_path,
      ...(fragment.override_setup_timeout_sec
        ? { override_setup_timeout_sec: fragment.override_setup_timeout_sec }
        : {}),
      model_name:
        fragment.model_name ??
        `openai/${submission.model.id}:${submission.model.provider}`,
      env: {
        OPENAI_BASE_URL: ROUTER_URL,
        OPENAI_API_KEY: INFERENCE_TOKEN_TEMPLATE,
      },
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
  costCeilingUsdPerTrial: number,
): Omit<PresetSubmission, "model" | "harness"> &
  Partial<Pick<PresetSubmission, "model" | "harness">> {
  const value = config as Record<string, unknown>;
  const agents = value.agents as Record<string, unknown>[];
  if (agents.length !== 1)
    return {
      benchmark: { name: "custom", preset: "custom" },
      cost_ceiling_usd_per_trial: costCeilingUsdPerTrial,
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
    cost_ceiling_usd_per_trial: costCeilingUsdPerTrial,
    role: "diagnostic",
  };
}
