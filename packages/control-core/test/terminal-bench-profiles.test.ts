import { readFile } from "node:fs/promises";
import type { ProfileObject } from "@harbor-hf/contracts";
import {
  canonicalJson,
  deterministicId,
  sha256,
  validateControlRecord,
} from "@harbor-hf/contracts";
import { describe, expect, it } from "vitest";

const WORKER_REVISION = "422cf445ce04cfc8f331ddeebfd88f6bc2c5eae9";
const PREVIOUS_WORKER_REVISION = "0b199c7cdec7cfcdbdbd48819ca146dc79e45dc3";
const BRIDGE_DIGESTS = [
  "a67e6442b5a9be11591699aaf8a861c021ac1e49c10bcd09992ab562098ea2eb",
  "ec80056b2eba539040bd411848b8e09f5dfce2066f715f814f40c8d909222da4",
];

async function profile(kind: string, name: string): Promise<ProfileObject> {
  const value = validateControlRecord<ProfileObject>(
    JSON.parse(await readFile(`profiles/${kind}/${name}.json`, "utf8")),
  );
  expect(value.record_id).toBe(
    deterministicId(
      "profile",
      value.profile_kind,
      value.name,
      sha256(canonicalJson(value.spec)),
    ),
  );
  return value;
}

function record(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

function protectedDeployment(spec: Record<string, unknown>): Record<string, unknown> {
  const {
    preparation_job_command: _preparationCommand,
    job_command: _jobCommand,
    worker_revision: _workerRevision,
    worker_concurrency: _workerConcurrency,
    worker_max_tasks_per_job: _workerCapacity,
    sandbox_template: sandboxValue,
    ...protectedSpec
  } = spec;
  const {
    root_bootstrap_command: _bootstrapCommand,
    max_sandboxes: _maxSandboxes,
    ...protectedSandbox
  } = record(sandboxValue);
  return { ...protectedSpec, sandbox_template: protectedSandbox };
}

describe("Terminal-Bench 2.1 profiles", () => {
  it("lock the official five-trial task set", async () => {
    const profileRecord = await profile("benchmark", "terminal-bench-2-1-official-5");
    const spec = profileRecord.spec as {
      task_ids: string[];
      task_digests: string[];
      source_task_ids: string[];
      trial_indices: number[];
      harbor_job: { n_attempts: number };
    };

    expect(spec.task_ids).toHaveLength(445);
    expect(new Set(spec.task_ids).size).toBe(445);
    expect(new Set(spec.source_task_ids).size).toBe(89);
    expect(spec.task_digests).toHaveLength(445);
    expect(spec.trial_indices.filter((value) => value === 1)).toHaveLength(89);
    expect(spec.trial_indices.filter((value) => value === 5)).toHaveLength(89);
    expect(spec.harbor_job.n_attempts).toBe(5);
  });

  it("lock the model and Pi harness revisions", async () => {
    const model = record(
      (await profile("model", "deepseek-v4-flash-0731-together")).spec,
    );
    const harness = record(
      (await profile("harness", "pi-0-84-2-high-deepseek-v4-flash-0731-together")).spec,
    );
    const harborAgent = record(harness.harbor_agent);
    const kwargs = record(harborAgent.kwargs);

    expect(model.model_id).toBe("deepseek-ai/DeepSeek-V4-Flash-0731");
    expect(model.revision).toBe("7872f01b1d1fe23eabc4c98b48bffcef5a386062");
    expect(harness.agent).toBe("pi");
    expect(harness.revision).toBe("0.84.2");
    expect(harness.reasoning_effort).toBe("high");
    expect(kwargs.version).toBe("0.84.2");
    expect(kwargs.thinking).toBe("high");
  });

  it("derive the replacement and diagnostic task sets from locked profiles", async () => {
    const canary = record(
      (await profile("benchmark", "terminal-bench-2-1-canary")).spec,
    );
    const official = record(
      (await profile("benchmark", "terminal-bench-2-1-official-5")).spec,
    );
    const replacement = record(
      (await profile("benchmark", "terminal-bench-2-1-replacement")).spec,
    );
    const diagnostic = record(
      (await profile("benchmark", "terminal-bench-2-1-diagnostic-1")).spec,
    );

    const taskTuples = (spec: Record<string, unknown>) => {
      const taskIds = spec.task_ids as string[];
      const sourceTaskIds = spec.source_task_ids as string[];
      const taskDigests = spec.task_digests as string[];
      const trialIndices = spec.trial_indices as number[];
      return taskIds.map((taskId, index) => ({
        taskId,
        sourceTaskId: sourceTaskIds[index],
        taskDigest: taskDigests[index],
        trialIndex: trialIndices[index],
      }));
    };

    expect(taskTuples(replacement)).toEqual([taskTuples(canary)[0]]);
    expect(taskTuples(replacement)).not.toContainEqual(taskTuples(canary)[1]);
    expect(taskTuples(diagnostic)).toEqual(
      taskTuples(official).filter((task) => task.trialIndex === 1),
    );
    expect(taskTuples(diagnostic)).toHaveLength(89);
    expect(new Set(diagnostic.task_ids as string[]).size).toBe(89);
    expect(new Set(diagnostic.source_task_ids as string[]).size).toBe(89);
    expect(new Set(diagnostic.trial_indices as number[])).toEqual(new Set([1]));

    const replacementJob = record(replacement.harbor_job);
    const diagnosticJob = record(diagnostic.harbor_job);
    expect(replacementJob.n_attempts).toBe(1);
    expect(replacementJob.n_concurrent_trials).toBe(1);
    expect(diagnosticJob.n_attempts).toBe(1);
    expect(diagnosticJob.n_concurrent_trials).toBe(8);
    expect(replacement.revision).toBe(official.revision);
    expect(diagnostic.revision).toBe(official.revision);
  });

  it("pin repaired worker deployments without changing protected settings", async () => {
    const canary = record(
      (await profile("deployment", "tb21-deepseek-v4-flash-canary")).spec,
    );
    const official = record(
      (await profile("deployment", "tb21-deepseek-v4-flash-official-5")).spec,
    );
    const replacement = record(
      (await profile("deployment", "tb21-deepseek-v4-flash-replacement")).spec,
    );
    const diagnostic = record(
      (await profile("deployment", "tb21-deepseek-v4-flash-diagnostic-1")).spec,
    );

    expect(protectedDeployment(replacement)).toEqual(protectedDeployment(canary));
    expect(protectedDeployment(diagnostic)).toEqual(protectedDeployment(official));

    for (const [spec, capacity, concurrency, maxSandboxes] of [
      [replacement, 1, 1, 1],
      [diagnostic, 89, 8, 16],
    ] as const) {
      expect(spec.worker_revision).toBe(WORKER_REVISION);
      expect(spec.worker_max_tasks_per_job).toBe(capacity);
      expect(spec.worker_concurrency).toBe(concurrency);

      const preparationCommand = (spec.preparation_job_command as string[]).join("\n");
      const jobCommand = (spec.job_command as string[]).join("\n");
      const sandbox = record(spec.sandbox_template);
      const bootstrapCommand = (sandbox.root_bootstrap_command as string[]).join("\n");
      for (const command of [preparationCommand, jobCommand, bootstrapCommand]) {
        expect(command).toContain(WORKER_REVISION);
        expect(command).not.toContain(PREVIOUS_WORKER_REVISION);
      }
      for (const digest of BRIDGE_DIGESTS) expect(bootstrapCommand).toContain(digest);

      expect(spec.inference_token).toBe("forbidden");
      expect(sandbox.inference_token).toBe("required");
      expect(sandbox.inference_model).toBe(
        "deepseek-ai/DeepSeek-V4-Flash-0731:together",
      );
      expect(sandbox.max_sandboxes).toBe(maxSandboxes);
      expect(bootstrapCommand).not.toContain("HF_TOKEN=");
    }
  });

  it("keep replacement and single-trial launch policies diagnostic and bounded", async () => {
    const canary = record((await profile("launch-policy", "tb21-canary")).spec);
    const official = record((await profile("launch-policy", "tb21-official-5")).spec);
    const replacement = record(
      (await profile("launch-policy", "tb21-replacement")).spec,
    );
    const diagnostic = record(
      (await profile("launch-policy", "tb21-diagnostic-1")).spec,
    );

    expect(replacement).toEqual(canary);
    expect(diagnostic).toEqual({ ...official, publication_role: "diagnostic" });
    for (const spec of [replacement, diagnostic]) {
      expect(spec.max_infrastructure_attempts).toBe(2);
      expect(spec.max_preparation_attempts).toBe(2);
      expect(spec.success_without_worker_receipt).toBe(false);
      expect(spec.publication_role).toBe("diagnostic");
    }
  });
});
