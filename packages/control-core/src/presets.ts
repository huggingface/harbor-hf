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

const ROUTER_URL = "https://router.huggingface.co/v1";
const INFERENCE_TOKEN_TEMPLATE = "$" + "{HF_INFERENCE_TOKEN}";
const LABELED_ENVIRONMENT = "harbor_hf_agents.hf_sandbox:LabeledHFSandboxEnvironment";

export interface PresetSubmission {
  benchmark: { name: string; preset: string };
  model: { id: string; provider: string; reasoning_effort: string };
  harness: { agent: string; version: string };
  cost_ceiling_usd_per_trial: number;
  role?: "final" | "diagnostic";
}

interface HarborAgentFragment {
  name?: string;
  import_path?: string;
  kwargs?: Record<string, unknown>;
  override_setup_timeout_sec?: number;
}

function clone<T>(value: T): T {
  return structuredClone(value);
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
    const kwargs = { ...(fragment.kwargs ?? {}) };
    if (agent.reasoning_option !== null)
      kwargs[agent.reasoning_option] = submission.model.reasoning_effort;

    const harborAgent: Record<string, unknown> = {
      ...(fragment.name ? { name: fragment.name } : {}),
      ...(fragment.import_path ? { import_path: fragment.import_path } : {}),
      ...(fragment.override_setup_timeout_sec
        ? { override_setup_timeout_sec: fragment.override_setup_timeout_sec }
        : {}),
      model_name: `openai/${submission.model.id}:${submission.model.provider}`,
      env: {
        OPENAI_BASE_URL: ROUTER_URL,
        OPENAI_API_KEY: INFERENCE_TOKEN_TEMPLATE,
      },
      kwargs,
    };
    const config = {
      ...clone(benchmark.job),
      job_name: "job",
      jobs_dir: `${mountRoot}/runs/${runId}`,
      agents: [harborAgent],
      environment: {
        import_path: LABELED_ENVIRONMENT,
        kwargs: {
          flavor: "cpu-basic",
          job_timeout: "30m",
          run_label: runId,
        },
      },
    };
    return validateHarborJobConfig(config);
  }
}

const FORBIDDEN_DIRECT_FIELDS = new Set([
  "jobs_dir",
  "job_name",
  "source_jobs",
  "tasks",
  "user_agent",
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function containsCredentialLiteral(value: unknown, key = ""): boolean {
  if (typeof value === "string")
    return (
      /(?:token|secret|password|api[_-]?key)/i.test(key) &&
      !/^\$\{[A-Z][A-Z0-9_]*\}$/.test(value)
    );
  if (Array.isArray(value))
    return value.some((item) => containsCredentialLiteral(item, key));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([childKey, child]) =>
    containsCredentialLiteral(child, childKey),
  );
}

export function prepareDirectJobConfig(
  runId: string,
  value: unknown,
  mountRoot: string,
): HarborJobConfigV1 {
  const input = record(value, "Harbor JobConfig");
  for (const field of FORBIDDEN_DIRECT_FIELDS) {
    if (field in input) throw new Error(`direct Harbor JobConfig cannot set ${field}`);
  }
  if (containsCredentialLiteral(input))
    throw new Error("direct Harbor JobConfig contains a credential literal");
  const agents = input.agents;
  if (!Array.isArray(agents) || agents.length !== 1)
    throw new Error("direct Harbor JobConfig must contain exactly one agent");
  const agent = record(agents[0], "agent");
  const environment = input.environment;
  if (environment !== undefined) {
    const environmentRecord = record(environment, "environment");
    if (environmentRecord.type !== "hf-sandbox")
      throw new Error("direct Harbor JobConfig must use hf-sandbox");
  }
  const config = {
    ...clone(input),
    job_name: "job",
    jobs_dir: `${mountRoot}/runs/${runId}`,
    agents: [
      {
        ...clone(agent),
        env: {
          ...record(agent.env ?? {}, "agent env"),
          OPENAI_BASE_URL: ROUTER_URL,
          OPENAI_API_KEY: INFERENCE_TOKEN_TEMPLATE,
        },
      },
    ],
    environment: {
      import_path: LABELED_ENVIRONMENT,
      kwargs: {
        flavor: "cpu-basic",
        job_timeout: "30m",
        run_label: runId,
      },
    },
  };
  return validateHarborJobConfig(config);
}

export function directSubmission(
  config: HarborJobConfigV1,
  costCeilingUsdPerTrial: number,
): PresetSubmission {
  const value = config as Record<string, unknown>;
  const agents = value.agents as Record<string, unknown>[];
  const agent = agents[0] ?? {};
  const modelName = typeof agent.model_name === "string" ? agent.model_name : "unknown";
  const suffix = modelName.lastIndexOf(":");
  const provider = suffix > 0 ? modelName.slice(suffix + 1) : "custom";
  const rawModel = suffix > 0 ? modelName.slice(0, suffix) : modelName;
  const modelId = rawModel.startsWith("openai/") ? rawModel.slice(7) : rawModel;
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
