import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProfileObject } from "@harbor-hf/contracts";
import { canonicalJson, sha256 } from "@harbor-hf/contracts";
import {
  ControlService,
  FilesystemObjectStore,
  Projection,
  type LoadedProfile,
} from "@harbor-hf/control-core";

export function profile(
  profile_kind: ProfileObject["profile_kind"],
  name: string,
  spec: ProfileObject["spec"],
): LoadedProfile {
  const value = {
    schema_version: "v1",
    kind: "profile.object",
    record_id: `profile-${name}-${profile_kind.replace("_", "-")}`,
    created_at: "2026-08-16T00:00:00.000Z",
    actor: { subject: "test", role: "service" },
    profile_kind,
    name,
    spec,
  } as unknown as ProfileObject;
  return { profile: value, profile_id: sha256(canonicalJson(value)) };
}

export function smokeProfiles(
  taskCount = 1,
  maxInfrastructureAttempts = 1,
  reservationMicrousd = 0,
  successWithoutWorkerReceipt = true,
  inferenceToken: "forbidden" | "required" = "forbidden",
  maxRunCeilingMicrousd?: number,
  requiredPositiveMetrics: string[] = [],
): LoadedProfile[] {
  if (taskCount < 1) throw new Error("test run needs at least one task");
  const taskIds = Array.from(
    { length: taskCount },
    (_, index) => `task-${String(index + 1).padStart(3, "0")}`,
  );
  return [
    profile("benchmark", "control-smoke", {
      task_ids: [taskIds[0] as string, ...taskIds.slice(1)],
      task_digests: [
        sha256(taskIds[0] as string),
        ...taskIds.slice(1).map((id) => sha256(id)),
      ],
      benchmark: "control-smoke",
      revision: sha256("benchmark"),
    }),
    profile("model", "control-smoke", {
      contract_version: "v1",
      model_id: "control-smoke",
      revision: sha256("model"),
      harbor_model_name:
        inferenceToken === "required"
          ? "openai/example/model:provider"
          : "control-smoke",
      compatibility: {
        reasoning: false,
        inference_apis: inferenceToken === "required" ? ["chat-completions"] : [],
      },
    }),
    profile("harness", "control-smoke", {
      contract_version: "v1",
      agent: "control-smoke",
      revision: sha256("harness"),
      required_evidence: ["job-status"],
      capabilities: {
        inference_apis: inferenceToken === "required" ? ["chat-completions"] : [],
      },
    }),
    profile("deployment", "hf-cpu-smoke", {
      contract_version: "v1",
      route: "hf_job",
      models: ["control-smoke"],
      harnesses: ["control-smoke"],
      job_image:
        "example.invalid/worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      job_command: ["true"],
      hardware: "cpu-basic",
      active_hourly_cost_microusd: 10_000,
      timeout_seconds: 300,
      trusted_worker: true,
      inference_token: inferenceToken,
      ...(inferenceToken === "required"
        ? {
            inference_upstream: "https://router.huggingface.co/v1",
            inference_api: "chat-completions",
            inference_max_requests: 64,
            inference_max_concurrency: 4,
            inference_timeout_seconds: 600,
            inference_max_output_tokens: 32768,
            inference_provider: "provider",
            input_price_microusd_per_million_tokens: 100_000,
            output_price_microusd_per_million_tokens: 200_000,
            cache_read_price_microusd_per_million_tokens: 100_000,
            cache_write_price_microusd_per_million_tokens: 100_000,
            context_window: 131_072,
            harbor_version: "0.21.0",
            worker_revision: "abcdef0",
          }
        : {}),
    }),
    profile("launch_policy", "control-smoke", {
      max_infrastructure_attempts: maxInfrastructureAttempts,
      reservation_microusd: reservationMicrousd,
      ...(maxRunCeilingMicrousd === undefined
        ? {}
        : { max_run_ceiling_microusd: maxRunCeilingMicrousd }),
      success_without_worker_receipt: successWithoutWorkerReceipt,
      publication_role: "diagnostic",
      required_positive_metrics: requiredPositiveMetrics,
    }),
  ];
}

export function preparedProfiles(taskCount = 1): LoadedProfile[] {
  if (taskCount < 1) throw new Error("prepared profiles require at least one task");
  const sourceTaskIds = Array.from(
    { length: taskCount },
    (_, index) => `task-${String(index + 1).padStart(3, "0")}`,
  );
  const taskIds = sourceTaskIds.map((taskId) => `${taskId}-trial-1`);
  return [
    profile("benchmark", "prepared-benchmark", {
      task_ids: taskIds as [string, ...string[]],
      task_digests: sourceTaskIds.map((taskId) => sha256(taskId)) as [
        string,
        ...string[],
      ],
      source_task_ids: sourceTaskIds as [string, ...string[]],
      trial_indices: sourceTaskIds.map(() => 1) as [number, ...number[]],
      benchmark: "prepared-benchmark",
      revision: sha256("prepared-benchmark"),
      harbor_job: {
        n_attempts: 1,
        datasets: [
          {
            repo: `https://github.com/example/tasks.git@${"a".repeat(40)}`,
            path: "tasks",
          },
        ],
      },
    }),
    profile("model", "prepared-model", {
      contract_version: "v1",
      model_id: "example/model",
      revision: sha256("prepared-model"),
      harbor_model_name: "openai/example/model:provider",
      compatibility: {
        reasoning: false,
        inference_apis: ["chat-completions"],
      },
    }),
    profile("harness", "prepared-harness", {
      contract_version: "v1",
      agent: "example-agent",
      revision: "1.0.0",
      required_evidence: ["workspace"],
      capabilities: { inference_apis: ["chat-completions"] },
      harbor_agent: {
        import_path: "example.agent:Agent",
        kwargs: {},
      },
    }),
    profile("deployment", "prepared-deployment", {
      contract_version: "v1",
      route: "hf_job",
      models: ["prepared-model"],
      harnesses: ["prepared-harness"],
      job_image:
        "example.invalid/worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      job_command: ["run-worker"],
      preparation_job_command: ["prepare-worker"],
      hardware: "cpu-basic",
      active_hourly_cost_microusd: 10_000,
      timeout_seconds: 3600,
      preparation_timeout_seconds: 600,
      trusted_worker: true,
      inference_token: "forbidden",
      preparation: "required",
      trial_job_template: {
        flavors: [
          {
            hardware: "cpu-basic",
            cpus: 2,
            memory_mb: 16384,
            storage_mb: 20480,
            gpus: 0,
            active_hourly_cost_microusd: 10000,
          },
        ],
        inference_token: "required",
        inference_upstream: "https://router.huggingface.co/v1",
        inference_api: "chat-completions",
        inference_max_requests: 64,
        inference_max_concurrency: 1,
        inference_timeout_seconds: 600,
        inference_max_output_tokens: 32_768,
        root_bootstrap_command: ["/opt/worker/start-root-services"],
        max_jobs: 2,
        default_cpus: 1,
        default_memory_mb: 2048,
        default_storage_mb: 10240,
        default_gpus: 0,
        max_timeout_seconds: 7200,
        lifetime_overhead_seconds: 300,
        max_image_bytes: 20 * 1024 * 1024 * 1024,
        max_image_entries: 500_000,
      },
      inference_provider: "provider",
      input_price_microusd_per_million_tokens: 100000,
      output_price_microusd_per_million_tokens: 200000,
      cache_read_price_microusd_per_million_tokens: 100000,
      cache_write_price_microusd_per_million_tokens: 100000,
      harbor_version: "0.21.0",
      worker_revision: "abcdef0",
      context_window: 131072,
    }),
    profile("launch_policy", "prepared-policy", {
      max_infrastructure_attempts: 2,
      reservation_microusd: 100000,
      preparation_reservation_microusd: 10000,
      max_preparation_attempts: 2,
      success_without_worker_receipt: false,
      publication_role: "diagnostic",
    }),
  ];
}

export interface TestControl {
  root: string;
  bucket: string;
  store: FilesystemObjectStore;
  projection: Projection;
  service: ControlService;
  profiles: LoadedProfile[];
  close(): Promise<void>;
}

export async function createTestControl(
  taskCount = 1,
  maxInfrastructureAttempts = 1,
  reservationMicrousd = 0,
  successWithoutWorkerReceipt = true,
  inferenceToken: "forbidden" | "required" = "forbidden",
  maxRunCeilingMicrousd?: number,
  requiredPositiveMetrics: string[] = [],
): Promise<TestControl> {
  const root = await mkdtemp(join(tmpdir(), "harbor-hf-control-test-"));
  const bucket = join(root, "bucket");
  await mkdir(bucket, { recursive: true });
  const store = new FilesystemObjectStore(bucket);
  const projection = await Projection.open(join(root, "projection.sqlite"));
  const profiles = smokeProfiles(
    taskCount,
    maxInfrastructureAttempts,
    reservationMicrousd,
    successWithoutWorkerReceipt,
    inferenceToken,
    maxRunCeilingMicrousd,
    requiredPositiveMetrics,
  );
  const service = new ControlService("test", store, projection, profiles);
  await projection.rebuild(store);
  await service.initialize(profiles);
  return {
    root,
    bucket,
    store,
    projection,
    service,
    profiles,
    async close() {
      await projection.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
