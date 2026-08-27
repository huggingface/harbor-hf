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

const WORKER_REVISION = "a689332f0cc7370b050813130b0d7d505e46ff6e";
const WORKER_IMAGE =
  "ghcr.io/huggingface/harbor-hf-trial-worker@sha256:1bbd594ace63d8a30fcdc728235d405ee47c92b4ee53e11dbb20408b819bc2fa";
const HARBOR_SOURCE =
  "git+https://github.com/harbor-framework/harbor.git@b37833221e27435a18d7acdd41d875cdc2831893";
const PREPARATION_COMMAND = [
  "python",
  "-m",
  "harbor_hf_agents.support.control_prepare_worker",
];
const EXECUTION_COMMAND = [
  "python",
  "-m",
  "harbor_hf_agents.support.control_trial_job_worker",
];
const ROOT_BRIDGE_COMMAND = [
  "python",
  "-m",
  "harbor_hf_agents.support.job_root_bridge",
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
    harbor_version: _harborVersion,
    trial_job_template: trialJobValue,
    ...protectedSpec
  } = spec;
  const {
    root_bootstrap_command: _bootstrapCommand,
    max_jobs: _maxJobs,
    inference_max_total_concurrency: _inferenceTotal,
    ...protectedTrialJob
  } = record(trialJobValue);
  return { ...protectedSpec, trial_job_template: protectedTrialJob };
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

  it("lock the DeepInfra model, Pi harness, and deployment", async () => {
    const model = record(
      (await profile("model", "deepseek-v4-flash-0731-deepinfra")).spec,
    );
    const harness = record(
      (await profile("harness", "pi-0-84-2-high-deepseek-v4-flash-0731-deepinfra"))
        .spec,
    );
    const deployment = record(
      (await profile("deployment", "tb21-deepseek-v4-flash-deepinfra-diagnostic-1"))
        .spec,
    );
    const harborAgent = record(harness.harbor_agent);
    const kwargs = record(harborAgent.kwargs);
    const modelsJson = record(kwargs.models_json);
    const providers = record(modelsJson.providers);
    const openai = record(providers.openai);
    const configuredModel = record((openai.models as unknown[])[0]);
    const cost = record(configuredModel.cost);
    const trialJob = record(deployment.trial_job_template);

    expect(model.model_id).toBe("deepseek-ai/DeepSeek-V4-Flash-0731");
    expect(model.harbor_model_name).toBe(
      "openai/deepseek-ai/DeepSeek-V4-Flash-0731:deepinfra",
    );
    expect(harborAgent.model_name).toBe(model.harbor_model_name);
    expect(configuredModel.id).toBe("deepseek-ai/DeepSeek-V4-Flash-0731:deepinfra");
    expect(cost).toEqual({
      input: 0.08,
      output: 0.18,
      cacheRead: 0.016,
      cacheWrite: 0.08,
    });
    expect(deployment.models).toEqual(["deepseek-v4-flash-0731-deepinfra"]);
    expect(deployment.harnesses).toEqual([
      "pi-0-84-2-high-deepseek-v4-flash-0731-deepinfra",
    ]);
    expect(deployment.inference_provider).toBe("deepinfra");
    expect(deployment.input_price_microusd_per_million_tokens).toBe(80_000);
    expect(deployment.output_price_microusd_per_million_tokens).toBe(180_000);
    expect(trialJob.inference_model).toBe(
      "deepseek-ai/DeepSeek-V4-Flash-0731:deepinfra",
    );
    expect(trialJob.max_jobs).toBe(16);
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

    for (const [spec, maxJobs] of [
      [replacement, 1],
      [diagnostic, 16],
    ] as const) {
      expect(spec.worker_revision).toBe(WORKER_REVISION);
      expect(spec.harbor_version).toBe("0.22.0");
      expect(spec.preparation_job_command).toEqual(PREPARATION_COMMAND);
      expect(spec.job_command).toEqual(EXECUTION_COMMAND);

      const jobCommand = (spec.job_command as string[]).join("\n");
      const trialJob = record(spec.trial_job_template);
      expect(trialJob.root_bootstrap_command).toEqual(ROOT_BRIDGE_COMMAND);
      expect(jobCommand).toContain("control_trial_job_worker");

      expect(spec.inference_token).toBe("forbidden");
      expect(trialJob.inference_token).toBe("required");
      expect(trialJob.inference_model).toBe(
        "deepseek-ai/DeepSeek-V4-Flash-0731:together",
      );
      expect(trialJob.max_jobs).toBe(maxJobs);
      expect(trialJob.max_image_bytes).toBe(20 * 1024 * 1024 * 1024);
      expect(trialJob.max_image_entries).toBe(500_000);
      expect(trialJob.inference_max_total_concurrency).toBe(maxJobs);
    }
  });

  it("keep replacement and single-trial launch policies diagnostic and bounded", async () => {
    const canary = record((await profile("launch-policy", "tb21-canary")).spec);
    const official = record((await profile("launch-policy", "tb21-official-5")).spec);
    const replacementProfile = await profile("launch-policy", "tb21-replacement");
    const diagnosticProfile = await profile("launch-policy", "tb21-diagnostic-1");
    const replacement = record(replacementProfile.spec);
    const diagnostic = record(diagnosticProfile.spec);

    expect(replacementProfile.record_id).toBe("profile-5af4753cfb6424d423a1b094");
    expect(diagnosticProfile.record_id).toBe("profile-6982d9cf30421d14a797f079");
    const immutableIds = new Map(
      (await loadBuiltInProfiles("profiles")).map((item) => [
        item.profile.name,
        item.profile_id,
      ]),
    );
    expect(immutableIds.get("tb21-replacement")).toBe(
      "sha256:15fcab15f5421b879944b48489e4fe865fb8d572b06f3dd18c17c776fd4a928d",
    );
    expect(immutableIds.get("tb21-diagnostic-1")).toBe(
      "sha256:bbcb2400144383cf5fb7f7e0633a4a8888b616d15a49b3eae9af6d9f6436123e",
    );
    expect(replacement).toEqual({
      ...canary,
      max_run_ceiling_microusd: 180_000_000,
    });
    expect(diagnostic).toEqual({
      ...official,
      max_run_ceiling_microusd: 300_000_000,
      publication_role: "diagnostic",
    });
    expect(diagnostic.reservation_microusd).toBe(55_000);
    expect(
      Number(diagnostic.reservation_microusd) * 89 +
        Number(diagnostic.preparation_reservation_microusd) *
          Number(diagnostic.max_preparation_attempts),
    ).toBe(5_095_000);
    for (const [spec, maximum] of [
      [replacement, 180_000_000],
      [diagnostic, 300_000_000],
    ] as const) {
      expect(spec.max_infrastructure_attempts).toBe(2);
      expect(spec.max_preparation_attempts).toBe(2);
      expect(spec.max_run_ceiling_microusd).toBe(maximum);
      expect(spec.success_without_worker_receipt).toBe(false);
      expect(spec.publication_role).toBe("diagnostic");
      expect(spec.required_positive_metrics).toEqual(["input_tokens", "output_tokens"]);
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
    expect(record(deployment.trial_job_template).inference_upstream).toBe(
      "https://router.huggingface.co/v1",
    );
  });

  it("pins gpt-oss-20b Chat Completions harnesses without Harbor name", async () => {
    const model = record((await profile("model", "gpt-oss-20b")).spec);
    const expected = [
      ["qwen-code", "harbor_hf_agents.qwen_code.agent:QwenCodeAgent", "0.21.15"],
      ["fx", "harbor_hf_agents.fx.agent:FxAgent", "0.0.5"],
      ["mini-swe-agent", "harbor_hf_agents.mini_swe.agent:MiniSweAgent", "2.4.6"],
      ["kimi-code", "harbor_hf_agents.kimi_code.agent:KimiCodeAgent", "0.38.0"],
      ["openhands", "harbor_hf_agents.openhands.agent:OpenHandsAgent", "1.6.0"],
      ["pi", "harbor_hf_agents.pi.agent:PiAgent", "0.84.2"],
      [
        "hermes",
        "harbor_hf_agents.hermes.agent:HermesAgent",
        "b6bcb3e791c673e63974029bbab40cc9326803ff",
      ],
      ["openclaw", "harbor_hf_agents.openclaw.agent:OpenClawAgent", "2026.7.1-2"],
    ] as const;
    for (const [name, importPath, revision] of expected) {
      const harness = record((await profile("harness", name)).spec);
      const harborAgent = record(harness.harbor_agent);
      expect(harness.agent).toBe(name);
      expect(harness.revision).toBe(revision);
      expect(harness.reasoning_effort).toBe("off");
      expect(harborAgent.import_path).toBe(importPath);
      expect(harborAgent.model_name).toBe(model.harbor_model_name);
      expect(harborAgent).not.toHaveProperty("name");
      if (name === "hermes") {
        expect(harborAgent.override_setup_timeout_sec).toBe(1800);
      }
      if (name === "openhands") {
        expect(harborAgent.override_setup_timeout_sec).toBe(7200);
      }
      if (name === "openclaw") {
        expect(harborAgent.override_setup_timeout_sec).toBe(1200);
      }
    }
  });

  it("uses the installed Chat Completions worker in provider deployments", async () => {
    const pin = WORKER_REVISION;
    for (const harness of [
      "qwen-code",
      "mini-swe-agent",
      "kimi-code",
      "openhands",
      "pi",
      "hermes",
      "openclaw",
    ]) {
      const deployment = record(
        (await profile("deployment", `tb21-gpt-oss-20b-${harness}-providers`)).spec,
      );
      expect(deployment.models).toEqual(["gpt-oss-20b"]);
      expect(deployment.harnesses).toEqual([harness]);
      expect(deployment.worker_revision).toBe(pin);
      expect(deployment.harbor_version).toBe("0.22.0");
      expect(deployment.inference_provider).toBe("together");
      expect(deployment.job_command).toEqual(EXECUTION_COMMAND);
    }
    const fx = record(
      (await profile("deployment", "tb21-gpt-oss-20b-fx-providers")).spec,
    );
    expect(fx.models).toEqual(["gpt-oss-20b"]);
    expect(fx.harnesses).toEqual(["fx"]);
    expect(fx.worker_revision).toBe(WORKER_REVISION);
    expect(fx.harbor_version).toBe("0.22.0");
    expect(fx.job_command).toEqual(EXECUTION_COMMAND);
  });

  it("pins the two-model reliability matrix to live provider routes", async () => {
    const cases = [
      {
        model: "qwen3-8-27b-deepinfra",
        modelId: "Qwen/Qwen3.8-27B",
        revision: "1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0",
        harborModel: "openai/Qwen/Qwen3.8-27B:deepinfra",
        provider: "deepinfra",
        inputPrice: 400_000,
        outputPrice: 3_000_000,
        contextWindow: 262_144,
      },
      {
        model: "glm-5-3-flash-together",
        modelId: "zai-org/GLM-5.3-Flash",
        revision: "3f1971b7b5f7a528c9c4ef6212c8785298a8c24a",
        harborModel: "openai/zai-org/GLM-5.3-Flash:together",
        provider: "together",
        inputPrice: 150_000,
        outputPrice: 500_000,
        contextWindow: 1_048_576,
      },
    ] as const;
    const harnesses = [
      ["pi", "pi"],
      ["mini-swe-agent", "mini-swe-agent"],
      ["fx", "fx"],
      ["openhands", "openhands"],
      ["opencode", "opencode"],
    ] as const;

    for (const item of cases) {
      const model = record((await profile("model", item.model)).spec);
      const deployment = record(
        (await profile("deployment", `tb21-${item.model}-providers`)).spec,
      );
      const template = record(deployment.trial_job_template);

      expect(model.model_id).toBe(item.modelId);
      expect(model.revision).toBe(item.revision);
      expect(model.harbor_model_name).toBe(item.harborModel);
      expect(deployment.models).toEqual([item.model]);
      expect(deployment.harnesses).toEqual(
        harnesses.map(([name]) => `${name}-${item.model}`),
      );
      expect(deployment.inference_provider).toBe(item.provider);
      expect(deployment.input_price_microusd_per_million_tokens).toBe(item.inputPrice);
      expect(deployment.output_price_microusd_per_million_tokens).toBe(
        item.outputPrice,
      );
      expect(deployment.context_window).toBe(item.contextWindow);
      const harborProviderPrefix = "openai/";
      expect(item.harborModel.startsWith(harborProviderPrefix)).toBe(true);
      expect(template.inference_model).toBe(
        item.harborModel.slice(harborProviderPrefix.length),
      );
      expect(template.inference_api).toBe("chat-completions");
      expect(template.inference_max_output_tokens).toBe(32_768);
      expect(template.max_jobs).toBe(16);

      for (const [name, agent] of harnesses) {
        const harness = record(
          (await profile("harness", `${name}-${item.model}`)).spec,
        );
        const harborAgent = record(harness.harbor_agent);
        expect(harness.agent).toBe(agent);
        expect(harborAgent.model_name).toBe(item.harborModel);
      }
    }
  });

  it("pins the DeepSeek V4 Flash Together substitute matrix", async () => {
    const model = record(
      (await profile("model", "deepseek-v4-flash-0731-together")).spec,
    );
    const deployment = record(
      (await profile("deployment", "tb21-deepseek-v4-flash-0731-together-matrix")).spec,
    );
    const template = record(deployment.trial_job_template);
    const harnesses = [
      ["pi-0-84-2-high-deepseek-v4-flash-0731-together", "pi"],
      ["mini-swe-agent-deepseek-v4-flash-0731-together", "mini-swe-agent"],
      ["hermes-deepseek-v4-flash-0731-together", "hermes"],
      ["kimi-code-deepseek-v4-flash-0731-together", "kimi-code"],
      ["qwen-code-deepseek-v4-flash-0731-together", "qwen-code"],
    ] as const;

    expect(model.model_id).toBe("deepseek-ai/DeepSeek-V4-Flash-0731");
    expect(model.revision).toBe("7872f01b1d1fe23eabc4c98b48bffcef5a386062");
    expect(model.harbor_model_name).toBe(
      "openai/deepseek-ai/DeepSeek-V4-Flash-0731:together",
    );
    expect(deployment.models).toEqual(["deepseek-v4-flash-0731-together"]);
    expect(deployment.harnesses).toEqual(harnesses.map(([name]) => name));
    expect(deployment.inference_provider).toBe("together");
    expect(deployment.input_price_microusd_per_million_tokens).toBe(140_000);
    expect(deployment.output_price_microusd_per_million_tokens).toBe(280_000);
    expect(deployment.context_window).toBe(131_072);
    expect(template.inference_model).toBe(
      "deepseek-ai/DeepSeek-V4-Flash-0731:together",
    );
    expect(template.inference_api).toBe("chat-completions");
    expect(template.inference_max_output_tokens).toBe(32_768);
    expect(template.inference_max_total_concurrency).toBe(16);
    expect(template.max_jobs).toBe(16);

    for (const [name, agent] of harnesses) {
      const harness = record((await profile("harness", name)).spec);
      const harborAgent = record(harness.harbor_agent);
      expect(harness.agent).toBe(agent);
      expect(harborAgent.model_name).toBe(model.harbor_model_name);
    }
  });

  it("pins the GPT-OSS 120B Together substitute matrix", async () => {
    const model = record((await profile("model", "gpt-oss-120b-together")).spec);
    const deployment = record(
      (await profile("deployment", "tb21-gpt-oss-120b-together-matrix")).spec,
    );
    const template = record(deployment.trial_job_template);
    const harnesses = [
      ["pi-gpt-oss-120b-together", "pi"],
      ["mini-swe-agent-gpt-oss-120b-together", "mini-swe-agent"],
      ["hermes-gpt-oss-120b-together", "hermes"],
      ["kimi-code-gpt-oss-120b-together", "kimi-code"],
      ["qwen-code-gpt-oss-120b-together", "qwen-code"],
    ] as const;

    expect(model.model_id).toBe("openai/gpt-oss-120b");
    expect(model.revision).toBe("b5c939de8f754692c1647ca79fbf85e8c1e70f8a");
    expect(model.harbor_model_name).toBe("openai/openai/gpt-oss-120b:together");
    expect(deployment.models).toEqual(["gpt-oss-120b-together"]);
    expect(deployment.harnesses).toEqual(harnesses.map(([name]) => name));
    expect(deployment.inference_provider).toBe("together");
    expect(deployment.input_price_microusd_per_million_tokens).toBe(150_000);
    expect(deployment.output_price_microusd_per_million_tokens).toBe(600_000);
    expect(deployment.context_window).toBe(131_072);
    expect(template.inference_model).toBe("openai/gpt-oss-120b:together");
    expect(template.inference_api).toBe("chat-completions");
    expect(template.inference_max_output_tokens).toBe(32_768);
    expect(template.inference_max_total_concurrency).toBe(16);
    expect(template.max_jobs).toBe(16);

    for (const [name, agent] of harnesses) {
      const harness = record((await profile("harness", name)).spec);
      const harborAgent = record(harness.harbor_agent);
      expect(harness.agent).toBe(agent);
      expect(harborAgent.model_name).toBe(model.harbor_model_name);
    }
  });

  it("uses self-contained workers for every Terminal-Bench deployment", async () => {
    const names = [
      "tb21-deepseek-v4-flash-canary",
      "tb21-deepseek-v4-flash-official-5",
      "tb21-deepseek-v4-flash-replacement",
      "tb21-deepseek-v4-flash-diagnostic-1",
      "tb21-deepseek-v4-flash-diagnostic-2",
      "tb21-deepseek-v4-flash-deepinfra-diagnostic-1",
      "tb21-deepseek-v4-flash-dsh-providers",
      "tb21-deepseek-v4-flash-0731-together-matrix",
      "tb21-gpt-oss-120b-together-matrix",
      "tb21-gpt-oss-20b-dsh-providers",
      "tb21-gpt-oss-20b-opencode-providers",
      "tb21-gpt-oss-20b-qwen-code-providers",
      "tb21-gpt-oss-20b-fx-providers",
      "tb21-gpt-oss-20b-mini-swe-agent-providers",
      "tb21-gpt-oss-20b-pi-providers",
      "tb21-gpt-oss-20b-kimi-code-providers",
      "tb21-gpt-oss-20b-hermes-providers",
      "tb21-gpt-oss-20b-openhands-providers",
      "tb21-gpt-oss-20b-openclaw-providers",
      "tb21-qwen3-8-27b-deepinfra-providers",
      "tb21-glm-5-3-flash-together-providers",
    ];
    for (const name of names) {
      const deployment = record((await profile("deployment", name)).spec);
      expect(deployment.harbor_version).toBe("0.22.0");
      expect(deployment.job_image).toBe(WORKER_IMAGE);
      expect(deployment.worker_revision).toBe(WORKER_REVISION);
      expect(deployment.preparation_job_command).toEqual(PREPARATION_COMMAND);
      expect(deployment.job_command).toEqual(EXECUTION_COMMAND);
      const template = record(deployment.trial_job_template);
      expect(template.root_bootstrap_command).toEqual(ROOT_BRIDGE_COMMAND);
      expect(template.max_image_bytes).toBe(20 * 1024 * 1024 * 1024);
      expect(template.max_image_entries).toBe(500_000);
    }
    const project = await readFile("packages/harbor-hf-agents/pyproject.toml", "utf8");
    expect(project).toContain(HARBOR_SOURCE);
  });
});
