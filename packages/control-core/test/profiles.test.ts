import type {
  BenchmarkProfileSpec,
  DeploymentProfileSpec,
  HarnessProfileSpec,
  ModelProfileSpec,
  PreparedTrial,
  TaskLock,
} from "@harbor-hf/contracts";
import { describe, expect, it } from "vitest";
import {
  preparedSandboxPolicy,
  ProfileResolutionError,
  validatePreparedCampaignProfiles,
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
  model_id: "example/model",
  revision: "abcdef0",
  harbor_model_name: "openai/example/model:provider",
};
const harness: HarnessProfileSpec = {
  agent: "example-agent",
  revision: "1.0.0",
  required_evidence: ["workspace"],
  harbor_agent: {
    import_path: "example.agent:Agent",
    model_name: "openai/example/model:provider",
  },
};

function deployment(): DeploymentProfileSpec {
  return {
    route: "hf_job",
    models: ["model"],
    harnesses: ["harness"],
    job_image: `example.invalid/worker@${digest}`,
    job_command: ["run-worker"],
    preparation_job_command: ["prepare-worker"],
    hardware: "cpu-upgrade",
    timeout_seconds: 86_400,
    preparation_timeout_seconds: 3_600,
    trusted_worker: true,
    inference_token: "forbidden",
    preparation: "required",
    sandbox_template: {
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
      inference_model: "example/model:provider",
      inference_api: "chat-completions",
      inference_max_requests: 256,
      inference_max_concurrency: 1,
      inference_timeout_seconds: 1_800,
      inference_max_output_tokens: 32_768,
      root_bootstrap_command: ["/opt/worker/start-root-services"],
      max_sandboxes: 2,
      max_commands: 128,
      max_command_seconds: 1_800,
      max_transfer_bytes: 67_108_864,
      allowed_roots: ["/app", "/logs", "/tmp"],
      default_cpus: 1,
      default_memory_mb: 2_048,
      default_storage_mb: 10_240,
      default_gpus: 0,
      max_timeout_seconds: 7_200,
      lifetime_overhead_seconds: 540,
      idle_timeout_overhead_seconds: 300,
    },
    inference_provider: "provider",
    input_price_microusd_per_million_tokens: 100_000,
    output_price_microusd_per_million_tokens: 200_000,
    harbor_version: "0.21.0",
    worker_revision: "abcdef0",
    worker_concurrency: 2,
    worker_max_tasks_per_job: 2,
    context_window: 131_072,
  };
}

function preparedTrial(): PreparedTrial {
  return {
    schema_version: "v1",
    kind: "prepared.trial",
    record_id: "prepared-task-a",
    created_at: "2026-08-18T00:00:00Z",
    actor: { subject: "harbor-hf-control", role: "service" },
    campaign_id: "campaign-example",
    preparation_id: "preparation-example",
    campaign_lock_digest: digest,
    task_id: "task-a-trial-1",
    source_task_id: "task-a",
    trial_index: 1,
    input_digest: digest,
    trial_lock: { schema_version: 2, task: { digest } },
    trial_lock_digest: digest,
    declared_image: "example.invalid/task:release",
    image: `example.invalid/task@${digest}`,
    cpus: 4,
    memory_mb: 8_192,
    storage_mb: 10_240,
    gpus: 0,
    agent_timeout_seconds: 900,
    verifier_timeout_seconds: 600,
    environment_build_timeout_seconds: 600,
    agent_setup_timeout_seconds: 360,
  };
}

describe("prepared campaign profiles", () => {
  it("resolve one immutable Sandbox policy from prepared resources", () => {
    const value = deployment();
    expect(() =>
      validatePreparedCampaignProfiles(value, benchmark, model, harness, tasks),
    ).not.toThrow();
    expect(preparedSandboxPolicy(value, preparedTrial())).toMatchObject({
      image: `example.invalid/task@${digest}`,
      hardware: "cpu-upgrade",
      timeout_seconds: 3_000,
      idle_timeout_seconds: 1_200,
      reservation_microusd: 25_000,
      inference_model: "example/model:provider",
    });
  });

  it("rejects inference credentials in prepared outer Jobs", () => {
    const value = {
      ...deployment(),
      inference_token: "required" as const,
      inference_max_requests: 64,
      inference_max_concurrency: 1,
      inference_timeout_seconds: 600,
      inference_max_output_tokens: 32_768,
    };
    expect(() =>
      validatePreparedCampaignProfiles(value, benchmark, model, harness, tasks),
    ).toThrow("must not receive an inference credential");
  });

  it("rejects incomplete benchmark source mappings", () => {
    expect(() =>
      validatePreparedCampaignProfiles(
        deployment(),
        { ...benchmark, source_task_ids: ["task-a"] },
        model,
        harness,
        tasks,
      ),
    ).toThrow(ProfileResolutionError);
  });

  it("rejects duplicate source trial identities", () => {
    const duplicate = [tasks[0] as TaskLock, { ...tasks[1], source_task_id: "task-a" }];
    expect(() =>
      validatePreparedCampaignProfiles(
        deployment(),
        {
          ...benchmark,
          source_task_ids: duplicate.map((task) => task.source_task_id as string),
        },
        model,
        harness,
        duplicate,
      ),
    ).toThrow("duplicate benchmark source trial");
  });
});
