import type {
  BenchmarkProfileSpec,
  HFJobDeploymentProfileSpec,
  HarnessProfileSpec,
  ModelProfileSpec,
  PreparedTrial,
  ResolvedExecutionContract,
  ResolvedProfile,
  TaskLock,
} from "@harbor-hf/contracts";
import { canonicalJson } from "@harbor-hf/contracts";
import { describe, expect, it } from "vitest";
import { composeExecutionContract } from "../src/execution-contract.js";
import {
  preparedTrialJobLaunch,
  ProfileResolutionError,
  validatePreparedRunProfiles,
} from "../src/profiles.js";

const digest = `sha256:${"a".repeat(64)}`;
const tasks: TaskLock[] = [
  {
    task_id: "task-a-trial-1",
    source_task_id: "task-a",
    trial_index: 1,
    input_digest: digest,
  },
  {
    task_id: "task-b-trial-1",
    source_task_id: "task-b",
    trial_index: 1,
    input_digest: digest,
  },
];

const benchmark: BenchmarkProfileSpec = {
  benchmark: "example",
  revision: "abcdef0",
  task_ids: tasks.map((task) => task.task_id),
  task_digests: tasks.map((task) => task.input_digest),
  source_task_ids: tasks.map((task) => task.source_task_id as string),
  trial_indices: tasks.map((task) => task.trial_index as number),
  harbor_job: { datasets: [{ name: "example/tasks", version: "1" }] },
};
const model: ModelProfileSpec = {
  contract_version: "v1",
  model_id: "example/model",
  revision: "abcdef0",
  harbor_model_name: "openai/example/model:provider",
  compatibility: {
    reasoning: false,
    inference_apis: ["chat-completions"],
  },
};
const harness: HarnessProfileSpec = {
  contract_version: "v1",
  agent: "example-agent",
  revision: "1.0.0",
  required_evidence: ["workspace"],
  capabilities: { inference_apis: ["chat-completions"] },
  harbor_agent: {
    import_path: "example.agent:Agent",
    kwargs: { version: "1.0.0" },
  },
};

function deployment(): HFJobDeploymentProfileSpec {
  return {
    contract_version: "v1",
    route: "hf_job",
    models: ["model", "other-model"],
    harnesses: ["harness"],
    job_image: `example.invalid/worker@${digest}`,
    job_command: ["run-worker"],
    preparation_job_command: ["prepare-worker"],
    hardware: "cpu-upgrade",
    active_hourly_cost_microusd: 30_000,
    timeout_seconds: 86_400,
    preparation_timeout_seconds: 3_600,
    trusted_worker: true,
    inference_token: "forbidden",
    preparation: "required",
    trial_job_template: {
      flavors: [
        {
          hardware: "cpu-basic",
          cpus: 2,
          memory_mb: 16_384,
          storage_mb: 20_480,
          gpus: 0,
          active_hourly_cost_microusd: 10_000,
        },
        {
          hardware: "cpu-upgrade",
          cpus: 8,
          memory_mb: 32_768,
          storage_mb: 40_960,
          gpus: 0,
          active_hourly_cost_microusd: 30_000,
        },
      ],
      inference_token: "required",
      inference_upstream: "https://router.huggingface.co",
      inference_api: "chat-completions",
      inference_max_requests: 256,
      inference_max_concurrency: 1,
      inference_timeout_seconds: 1_800,
      inference_max_output_tokens: 32_768,
      root_bootstrap_command: ["/opt/worker/start-root-services"],
      max_jobs: 2,
      default_cpus: 1,
      default_memory_mb: 2_048,
      default_storage_mb: 10_240,
      default_gpus: 0,
      max_timeout_seconds: 7_200,
      lifetime_overhead_seconds: 540,
      max_image_bytes: 20 * 1024 * 1024 * 1024,
      max_image_entries: 500_000,
    },
    inference_provider: "provider",
    input_price_microusd_per_million_tokens: 100_000,
    output_price_microusd_per_million_tokens: 200_000,
    cache_read_price_microusd_per_million_tokens: 50_000,
    cache_write_price_microusd_per_million_tokens: 75_000,
    harbor_version: "0.21.0",
    worker_revision: "abcdef0",
    context_window: 131_072,
  };
}

function resolved(
  selectedModel: ModelProfileSpec = model,
  modelName = "model",
  selectedDeployment: HFJobDeploymentProfileSpec = deployment(),
): ResolvedProfile[] {
  return [
    {
      kind: "model",
      name: modelName,
      profile_id: `sha256:${"b".repeat(64)}`,
      spec: selectedModel,
    },
    {
      kind: "harness",
      name: "harness",
      profile_id: `sha256:${"c".repeat(64)}`,
      spec: harness,
    },
    {
      kind: "deployment",
      name: "deployment",
      profile_id: `sha256:${"d".repeat(64)}`,
      spec: selectedDeployment,
    },
  ];
}

function execution(): ResolvedExecutionContract {
  return composeExecutionContract(resolved());
}

function preparedTrial(): PreparedTrial {
  return {
    schema_version: "v1",
    kind: "prepared.trial",
    record_id: "prepared-task-a",
    created_at: "2026-08-18T00:00:00Z",
    actor: { subject: "harbor-hf-control", role: "service" },
    run_id: "run-example",
    preparation_id: "preparation-example",
    run_lock_digest: digest,
    task_id: "task-a-trial-1",
    source_task_id: "task-a",
    trial_index: 1,
    input_digest: digest,
    trial_lock: { schema_version: "1.0" },
    trial_lock_digest: digest,
    declared_image: `example.invalid/task:tag@${digest}`,
    image: `example.invalid/task@${digest}`,
    cpus: 4,
    memory_mb: 20_000,
    storage_mb: 30_000,
    gpus: 0,
    agent_timeout_seconds: 1_200,
    verifier_timeout_seconds: 600,
    environment_build_timeout_seconds: 300,
    agent_setup_timeout_seconds: 360,
  };
}

describe("resolved execution profiles", () => {
  it("composes one reusable harness with multiple models", () => {
    const first = execution();
    const second = composeExecutionContract(
      resolved(
        {
          ...model,
          model_id: "example/other",
          revision: "abcdef1",
          harbor_model_name: "openai/example/other:provider",
        },
        "other-model",
      ),
    );

    expect(first.source_profiles.harness).toEqual(second.source_profiles.harness);
    expect(first.harbor_agent?.model_name).toBe("openai/example/model:provider");
    expect(second.harbor_agent?.model_name).toBe("openai/example/other:provider");
    expect(first.inference?.bridge_model).toBe("example/model:provider");
    expect(second.inference?.bridge_model).toBe("example/other:provider");
  });

  it("produces a byte-stable immutable execution contract", () => {
    expect(canonicalJson(execution())).toBe(canonicalJson(execution()));
  });

  it("rejects route, provider, API, and compatibility mismatches", () => {
    expect(() =>
      composeExecutionContract(
        resolved({ ...model, harbor_model_name: "openai/example/model:other" }),
      ),
    ).toThrow("provider suffix");
    expect(() =>
      composeExecutionContract(
        resolved({ ...model, compatibility: { reasoning: false } }),
      ),
    ).toThrow("no native inference API declaration");
    expect(() =>
      composeExecutionContract(
        resolved(model, "model", {
          ...deployment(),
          trial_job_template: {
            ...(deployment().trial_job_template as NonNullable<
              HFJobDeploymentProfileSpec["trial_job_template"]
            >),
            inference_api: "responses",
          },
        }),
      ),
    ).toThrow("model provider route does not support");
    expect(() =>
      composeExecutionContract([
        ...resolved().filter((profile) => profile.kind !== "harness"),
        {
          kind: "harness",
          name: "harness",
          profile_id: `sha256:${"b".repeat(64)}`,
          spec: {
            ...harness,
            capabilities: { inference_apis: ["responses"] },
          },
        },
      ]),
    ).toThrow("harness does not support");
    expect(() =>
      composeExecutionContract([
        ...resolved().filter((profile) => profile.kind !== "harness"),
        {
          kind: "harness",
          name: "harness",
          profile_id: `sha256:${"c".repeat(64)}`,
          spec: {
            ...harness,
            capabilities: {
              ...harness.capabilities,
              requires_reasoning: true,
            },
          },
        },
      ]),
    ).toThrow("requires reasoning");
  });

  it("validates prepared task mappings against the composed contract", () => {
    expect(() =>
      validatePreparedRunProfiles(execution(), benchmark, tasks),
    ).not.toThrow();
    expect(() =>
      validatePreparedRunProfiles(
        execution(),
        { ...benchmark, source_task_ids: ["task-a"] },
        tasks,
      ),
    ).toThrow(ProfileResolutionError);
  });

  it("resolves one immutable trial Job launch from locked values", () => {
    expect(preparedTrialJobLaunch(execution(), preparedTrial())).toMatchObject({
      job_image: `example.invalid/worker@${digest}`,
      task_image: `example.invalid/task@${digest}`,
      job_command: [
        "/bin/sh",
        "-c",
        [
          "set -eu",
          "'/opt/worker/start-root-services'",
          "unset HF_INFERENCE_TOKEN HARBOR_HF_INFERENCE_TOKEN",
          "exec 'run-worker'",
        ].join("\n"),
      ],
      hardware: "cpu-upgrade",
      timeout_seconds: 3_000,
      active_hourly_cost_microusd: 30_000,
      max_jobs: 2,
      max_image_bytes: 20 * 1024 * 1024 * 1024,
      max_image_entries: 500_000,
      inference_token: "required",
      inference_model: "example/model:provider",
    });
  });

  it("quotes bootstrap and worker arguments in the locked shell command", () => {
    const value = deployment();
    value.job_command = ["run worker", "it's-locked"];
    if (!value.trial_job_template) throw new Error("trial template is missing");
    value.trial_job_template.root_bootstrap_command = ["/root setup", "first"];
    const composed = composeExecutionContract(resolved(model, "model", value));

    expect(preparedTrialJobLaunch(composed, preparedTrial()).job_command).toEqual([
      "/bin/sh",
      "-c",
      [
        "set -eu",
        "'/root setup' 'first'",
        "unset HF_INFERENCE_TOKEN HARBOR_HF_INFERENCE_TOKEN",
        `exec 'run worker' 'it'"'"'s-locked'`,
      ].join("\n"),
    ]);
  });
});
