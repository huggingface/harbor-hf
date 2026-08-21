import { readFile } from "node:fs/promises";
import type { ProfileObject } from "@harbor-hf/contracts";
import {
  canonicalJson,
  deterministicId,
  sha256,
  validateControlRecord,
} from "@harbor-hf/contracts";
import { describe, expect, it } from "vitest";
import { loadBuiltInProfiles } from "../src/profiles.js";

const WORKER_REVISION = "c5ffef26652129bc3354be5b3bc9c9ba8110629b";
const PREVIOUS_WORKER_REVISION = "eec0829abf75e8d3f271c8114462a2ffc3dfecbf";
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
    inference_max_total_concurrency: _inferenceTotal,
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

    const canaryJob = record(canary.harbor_job);
    const replacementJob = record(replacement.harbor_job);
    const diagnosticJob = record(diagnostic.harbor_job);
    const officialJob = record(official.harbor_job);
    expect(replacementJob.n_attempts).toBe(1);
    expect(replacementJob.n_concurrent_trials).toBe(1);
    expect(canaryJob.agent_timeout_multiplier).toBe(4);
    expect(replacementJob.agent_timeout_multiplier).toBe(4);
    expect(officialJob.agent_timeout_multiplier).toBeUndefined();
    expect(diagnosticJob.agent_timeout_multiplier).toBeUndefined();
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
      expect(sandbox.inference_max_total_concurrency).toBe(maxSandboxes);
      expect(bootstrapCommand).not.toContain("HF_TOKEN=");
    }
  });

  it("keep replacement and single-trial launch policies diagnostic and bounded", async () => {
    const canary = record((await profile("launch-policy", "tb21-canary")).spec);
    const official = record((await profile("launch-policy", "tb21-official-5")).spec);
    const replacementProfile = await profile("launch-policy", "tb21-replacement");
    const diagnosticProfile = await profile("launch-policy", "tb21-diagnostic-1");
    const replacement = record(replacementProfile.spec);
    const diagnostic = record(diagnosticProfile.spec);

    expect(replacementProfile.record_id).toBe("profile-ff9e906d69e089a009d00fe8");
    expect(diagnosticProfile.record_id).toBe("profile-ede7617f34276455bde5e8b5");
    const immutableIds = new Map(
      (await loadBuiltInProfiles("profiles")).map((item) => [
        item.profile.name,
        item.profile_id,
      ]),
    );
    expect(immutableIds.get("tb21-replacement")).toBe(
      "sha256:485dc1ad6c00550478db1b2cba6f0fcacc579e49244fd9cc1cdddf56014abcea",
    );
    expect(immutableIds.get("tb21-diagnostic-1")).toBe(
      "sha256:60fdb06aa333652caf69506586d724e4f2b766c427f70f0f38c718b44d59604a",
    );
    expect(replacement).toEqual({
      ...canary,
      max_campaign_ceiling_microusd: 180_000_000,
    });
    expect(diagnostic).toEqual({
      ...official,
      max_campaign_ceiling_microusd: 300_000_000,
      publication_role: "diagnostic",
    });
    for (const [spec, maximum] of [
      [replacement, 180_000_000],
      [diagnostic, 300_000_000],
    ] as const) {
      expect(spec.max_infrastructure_attempts).toBe(2);
      expect(spec.max_preparation_attempts).toBe(2);
      expect(spec.max_campaign_ceiling_microusd).toBe(maximum);
      expect(spec.success_without_worker_receipt).toBe(false);
      expect(spec.publication_role).toBe("diagnostic");
    }
  });

  it("pins gpt-oss-20b and DeepSeek Harness for provider runs", async () => {
    const model = record((await profile("model", "gpt-oss-20b")).spec);
    const harness = record((await profile("harness", "dsh")).spec);
    const deployment = record(
      (await profile("deployment", "tb21-gpt-oss-20b-dsh-providers")).spec,
    );
    const harborAgent = record(harness.harbor_agent);

    expect(harness.agent).toBe("dsh");
    expect(harness.revision).toBe("0.1.0-rc.7");
    expect(harness.reasoning_effort).toBe("off");
    expect(harborAgent.import_path).toBe("harbor_hf_agents.dsh.agent:DshAgent");
    expect(harborAgent.model_name).toBe(model.harbor_model_name);
    expect(deployment.models).toEqual(["gpt-oss-20b"]);
    expect(deployment.harnesses).toEqual(["dsh"]);
    expect(deployment.inference_provider).toBe("together");
  });

  it("pins DeepSeek V4 Flash to DeepSeek Harness for provider runs", async () => {
    const model = record(
      (await profile("model", "deepseek-v4-flash-0731-together")).spec,
    );
    const harness = record(
      (await profile("harness", "dsh-high-deepseek-v4-flash-0731-together")).spec,
    );
    const deployment = record(
      (await profile("deployment", "tb21-deepseek-v4-flash-dsh-providers")).spec,
    );
    const harborAgent = record(harness.harbor_agent);
    const kwargs = record(harborAgent.kwargs);

    expect(harness.agent).toBe("dsh");
    expect(harness.reasoning_effort).toBe("high");
    expect(harborAgent.import_path).toBe("harbor_hf_agents.dsh.agent:DshAgent");
    expect(harborAgent.model_name).toBe(model.harbor_model_name);
    expect(kwargs.thinking_format).toBe("deepseek");
    expect(deployment.models).toEqual(["deepseek-v4-flash-0731-together"]);
    expect(deployment.harnesses).toEqual(["dsh-high-deepseek-v4-flash-0731-together"]);
  });

  it("pins gpt-oss-20b and OpenCode for provider runs", async () => {
    const model = record((await profile("model", "gpt-oss-20b")).spec);
    const harness = record((await profile("harness", "opencode")).spec);
    const deployment = record(
      (await profile("deployment", "tb21-gpt-oss-20b-opencode-providers")).spec,
    );
    const harborAgent = record(harness.harbor_agent);

    expect(model.model_id).toBe("openai/gpt-oss-20b");
    expect(model.revision).toBe("6cee5e81ee83917806bbde320786a8fb61efebee");
    expect(model.harbor_model_name).toBe("openai/openai/gpt-oss-20b:together");
    expect(harness.agent).toBe("opencode");
    expect(harness.revision).toBe("1.18.20");
    expect(harness.reasoning_effort).toBe("off");
    expect(harborAgent.import_path).toBe(
      "harbor_hf_agents.opencode.agent:OpenCodeAgent",
    );
    expect(harborAgent.model_name).toBe(model.harbor_model_name);
    expect(deployment.models).toEqual(["gpt-oss-20b"]);
    expect(deployment.harnesses).toEqual(["opencode"]);
    expect(deployment.inference_provider).toBe("together");
    expect(deployment.input_price_microusd_per_million_tokens).toBe(50_000);
    expect(deployment.output_price_microusd_per_million_tokens).toBe(200_000);
    expect(record(deployment.sandbox_template).inference_upstream).toBe(
      "https://router.huggingface.co/v1",
    );
  });
});
