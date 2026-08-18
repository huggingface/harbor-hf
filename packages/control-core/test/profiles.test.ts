import type {
  DeploymentProfileSpec,
  SandboxPolicy,
  TaskLock,
} from "@harbor-hf/contracts";
import { describe, expect, it } from "vitest";
import {
  ProfileResolutionError,
  taskSandboxPolicy,
  taskSandboxSpec,
  validateTaskSandboxCoverage,
} from "../src/profiles.js";

const digest = `sha256:${"a".repeat(64)}`;
const base: SandboxPolicy = {
  image: `example.invalid/base@${digest}`,
  hardware: "cpu-basic",
  timeout_seconds: 7_200,
  idle_timeout_seconds: 3_600,
  inference_token: "required",
  inference_upstream: "https://router.huggingface.co",
  inference_model: "example/model:provider",
  inference_api: "chat-completions",
  inference_max_requests: 256,
  inference_max_concurrency: 1,
  inference_timeout_seconds: 1_800,
  inference_max_output_tokens: 32_768,
  root_bootstrap_command: ["/opt/worker/start-root-services"],
  reservation_microusd: 20_000,
  active_hourly_cost_microusd: 10_000,
  max_sandboxes: 2,
  max_commands: 128,
  max_command_seconds: 3_600,
  max_transfer_bytes: 67_108_864,
  allowed_roots: ["/app", "/logs", "/tmp"],
};
const tasks: TaskLock[] = [
  { task_id: "task-a-trial-1", input_digest: digest },
  { task_id: "task-b-trial-1", input_digest: digest },
];

function deployment(taskIds = tasks.map((task) => task.task_id)) {
  return {
    route: "hf_job",
    models: ["model"],
    harnesses: ["harness"],
    job_image: `example.invalid/worker@${digest}`,
    job_command: ["true"],
    hardware: "cpu-upgrade",
    timeout_seconds: 86_400,
    trusted_worker: true,
    inference_token: "forbidden",
    sandbox: base,
    task_sandboxes: taskIds.map((taskId, index) => ({
      task_id: taskId,
      source_task_id: index === 0 ? "task-a" : "task-b",
      trial_index: 1,
      image: `example.invalid/task-${index}@${digest}`,
      hardware: index === 0 ? "cpu-basic" : "cpu-upgrade",
      timeout_seconds: 7_200 + index,
      idle_timeout_seconds: 3_600,
      reservation_microusd: 20_000 + index,
      active_hourly_cost_microusd: 10_000 + index,
      max_command_seconds: 3_600,
    })),
    inference_provider: "provider",
    input_price_microusd_per_million_tokens: 100_000,
    output_price_microusd_per_million_tokens: 200_000,
    harbor_version: "0.21.0",
    worker_revision: "abcdef0",
    worker_concurrency: 2,
    context_window: 131_072,
  } as DeploymentProfileSpec;
}

describe("task Sandbox profiles", () => {
  it("resolve an exact immutable policy for each logical task", () => {
    const value = deployment();
    expect(() => validateTaskSandboxCoverage(value, tasks)).not.toThrow();
    expect(taskSandboxPolicy(value, "task-b-trial-1")).toMatchObject({
      image: `example.invalid/task-1@${digest}`,
      hardware: "cpu-upgrade",
      timeout_seconds: 7_201,
      inference_model: "example/model:provider",
    });
    expect(taskSandboxSpec(value, "task-a-trial-1")).toMatchObject({
      source_task_id: "task-a",
      trial_index: 1,
    });
  });

  it("rejects incomplete task coverage before campaign admission", () => {
    expect(() =>
      validateTaskSandboxCoverage(deployment(["task-a-trial-1"]), tasks),
    ).toThrow(ProfileResolutionError);
  });

  it("rejects duplicate source trial identities", () => {
    const value = deployment() as DeploymentProfileSpec & {
      task_sandboxes: Array<Record<string, unknown>>;
    };
    value.task_sandboxes[1] = {
      ...value.task_sandboxes[1],
      source_task_id: "task-a",
    };
    expect(() => validateTaskSandboxCoverage(value, tasks)).toThrow(
      "duplicate source task trial",
    );
  });
});
