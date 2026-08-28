import { readdir, readFile } from "node:fs/promises";
import type { ProfileObject } from "@harbor-hf/contracts";
import {
  canonicalJson,
  deterministicId,
  sha256,
  validateControlRecord,
} from "@harbor-hf/contracts";
import { describe, expect, it } from "vitest";
import { composeExecutionContract } from "../src/execution-contract.js";
import { loadBuiltInProfiles, ProfileResolver } from "../src/profiles.js";

const WORKER_REVISION = "a689332f0cc7370b050813130b0d7d505e46ff6e";
const WORKER_IMAGE =
  "ghcr.io/huggingface/harbor-hf-trial-worker@sha256:1bbd594ace63d8a30fcdc728235d405ee47c92b4ee53e11dbb20408b819bc2fa";
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

function hasKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((item) => hasKey(item, key));
  if (!value || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  return key in object || Object.values(object).some((item) => hasKey(item, key));
}

function taskTuples(spec: Record<string, unknown>) {
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
}

describe("Terminal-Bench 2.1 profiles", () => {
  it("locks the official and diagnostic task sets", async () => {
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

    expect(official.task_ids).toHaveLength(445);
    expect(new Set(official.task_ids as string[]).size).toBe(445);
    expect(new Set(official.source_task_ids as string[]).size).toBe(89);
    expect(taskTuples(replacement)).toEqual([taskTuples(canary)[0]]);
    expect(taskTuples(diagnostic)).toEqual(
      taskTuples(official).filter((task) => task.trialIndex === 1),
    );
    expect(taskTuples(diagnostic)).toHaveLength(89);
    expect(record(canary.harbor_job).agent_timeout_multiplier).toBe(4);
    expect(record(diagnostic.harbor_job).n_attempts).toBe(1);
    expect(record(diagnostic.harbor_job).n_concurrent_trials).toBe(8);
  });

  it("keeps one model profile as the only checked-in model-route owner", async () => {
    const expected = {
      "deepseek-v4-flash-0731-deepinfra": [
        "deepseek-ai/DeepSeek-V4-Flash-0731",
        "7872f01b1d1fe23eabc4c98b48bffcef5a386062",
        "openai/deepseek-ai/DeepSeek-V4-Flash-0731:deepinfra",
        true,
      ],
      "deepseek-v4-flash-0731-together": [
        "deepseek-ai/DeepSeek-V4-Flash-0731",
        "7872f01b1d1fe23eabc4c98b48bffcef5a386062",
        "openai/deepseek-ai/DeepSeek-V4-Flash-0731:together",
        true,
      ],
      "glm-5-3-flash-together": [
        "zai-org/GLM-5.3-Flash",
        "3f1971b7b5f7a528c9c4ef6212c8785298a8c24a",
        "openai/zai-org/GLM-5.3-Flash:together",
        false,
      ],
      "gpt-oss-120b-together": [
        "openai/gpt-oss-120b",
        "b5c939de8f754692c1647ca79fbf85e8c1e70f8a",
        "openai/openai/gpt-oss-120b:together",
        false,
      ],
      "gpt-oss-20b-together": [
        "openai/gpt-oss-20b",
        "6cee5e81ee83917806bbde320786a8fb61efebee",
        "openai/openai/gpt-oss-20b:together",
        false,
      ],
      "qwen3-8-27b-deepinfra": [
        "Qwen/Qwen3.8-27B",
        "1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0",
        "openai/Qwen/Qwen3.8-27B:deepinfra",
        false,
      ],
    } as const;

    for (const [name, [modelId, revision, route, reasoning]] of Object.entries(
      expected,
    )) {
      const spec = record((await profile("model", name)).spec);
      expect(spec.contract_version).toBe("v1");
      expect(spec.model_id).toBe(modelId);
      expect(spec.revision).toBe(revision);
      expect(spec.harbor_model_name).toBe(route);
      expect(record(spec.compatibility).reasoning).toBe(reasoning);
    }
  });

  it("keeps exactly the real reusable harness configurations", async () => {
    const expectedNames = [
      "control-smoke",
      "dsh-high",
      "dsh-off",
      "fx",
      "hermes",
      "kimi-code",
      "mini-swe-agent",
      "openclaw",
      "opencode",
      "openhands",
      "pi-high",
      "pi-off",
      "qwen-code",
    ];
    const names = (await readdir("profiles/harness"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""))
      .sort();
    expect(names).toEqual(expectedNames);

    for (const name of names) {
      const spec = record((await profile("harness", name)).spec);
      expect(spec.contract_version).toBe("v1");
      expect(hasKey(spec, "model_name")).toBe(false);
      expect(hasKey(spec, "models_json")).toBe(false);
      expect(hasKey(spec, "inference_model")).toBe(false);
      expect(hasKey(spec, "context_window")).toBe(false);
    }
    const pi = record((await profile("harness", "pi-off")).spec);
    expect(record(pi.capabilities)).toMatchObject({
      inference_apis: ["chat-completions"],
      provider_runtime: true,
      model_registry: "pi",
      provider_max_attempts: 1,
    });
    const dsh = record((await profile("harness", "dsh-high")).spec);
    expect(record(dsh.capabilities)).toMatchObject({
      requires_reasoning: true,
      reasoning_formats: ["deepseek"],
      reasoning_format_runtime: "dsh",
    });
  });

  it("reuses Pi and FX profiles across the two reliability models", async () => {
    const resolver = new ProfileResolver(await loadBuiltInProfiles("profiles"));
    for (const harness of ["pi-off", "fx"]) {
      const qwen = composeExecutionContract(
        resolver.resolve({
          benchmark: "terminal-bench-2-1-canary",
          model: "qwen3-8-27b-deepinfra",
          harness,
          deployment: "tb21-qwen3-8-27b-deepinfra-providers",
          launch_policy: "tb21-canary",
        }),
      );
      const glm = composeExecutionContract(
        resolver.resolve({
          benchmark: "terminal-bench-2-1-canary",
          model: "glm-5-3-flash-together",
          harness,
          deployment: "tb21-glm-5-3-flash-together-providers",
          launch_policy: "tb21-canary",
        }),
      );
      expect(qwen.source_profiles.harness).toEqual(glm.source_profiles.harness);
      expect(qwen.inference?.bridge_model).toBe("Qwen/Qwen3.8-27B:deepinfra");
      expect(glm.inference?.bridge_model).toBe("zai-org/GLM-5.3-Flash:together");
      if (harness === "pi-off") {
        expect(record(qwen.harbor_agent?.kwargs).model_runtime).toMatchObject({
          model_id: "Qwen/Qwen3.8-27B:deepinfra",
          context_window: 262_144,
          input_price: 0.4,
          output_price: 3,
        });
        expect(record(glm.harbor_agent?.kwargs).model_runtime).toMatchObject({
          model_id: "zai-org/GLM-5.3-Flash:together",
          context_window: 1_048_576,
          input_price: 0.15,
          output_price: 0.5,
        });
      }
    }
  });

  it("routes bounded public aliases through the composed contract", async () => {
    const resolver = new ProfileResolver(await loadBuiltInProfiles("profiles"));
    const execution = composeExecutionContract(
      resolver.resolve({
        benchmark: "terminal-bench-2-1-canary",
        model: "gpt-oss-20b",
        harness: "pi",
        deployment: "tb21-gpt-oss-20b-pi-providers",
        launch_policy: "tb21-canary",
      }),
    );
    expect(execution.model.model_id).toBe("openai/gpt-oss-20b");
    expect(execution.harness.agent).toBe("pi");
    expect(execution.inference?.bridge_model).toBe("openai/gpt-oss-20b:together");
  });

  it("derives DSH reasoning format from model compatibility", async () => {
    const resolver = new ProfileResolver(await loadBuiltInProfiles("profiles"));
    const execution = composeExecutionContract(
      resolver.resolve({
        benchmark: "terminal-bench-2-1-canary",
        model: "deepseek-v4-flash-0731-together",
        harness: "dsh-high",
        deployment: "tb21-deepseek-v4-flash-dsh-providers",
        launch_policy: "tb21-canary",
      }),
    );
    expect(record(execution.harbor_agent?.kwargs).thinking_format).toBe("deepseek");
  });

  it("keeps provider and execution policy in deployments without route copies", async () => {
    const matrix = [
      {
        name: "tb21-qwen3-8-27b-deepinfra-providers",
        model: "qwen3-8-27b-deepinfra",
        harnesses: ["pi-off", "mini-swe-agent", "fx", "openhands", "opencode", "pi"],
        provider: "deepinfra",
        input: 400_000,
        output: 3_000_000,
        context: 262_144,
      },
      {
        name: "tb21-glm-5-3-flash-together-providers",
        model: "glm-5-3-flash-together",
        harnesses: ["pi-off", "mini-swe-agent", "fx", "openhands", "opencode", "pi"],
        provider: "together",
        input: 150_000,
        output: 500_000,
        context: 1_048_576,
      },
    ] as const;

    for (const item of matrix) {
      const spec = record((await profile("deployment", item.name)).spec);
      const template = record(spec.trial_job_template);
      expect(spec.contract_version).toBe("v1");
      expect(spec.models).toEqual([item.model]);
      expect(spec.harnesses).toEqual(item.harnesses);
      expect(spec.inference_provider).toBe(item.provider);
      expect(spec.input_price_microusd_per_million_tokens).toBe(item.input);
      expect(spec.output_price_microusd_per_million_tokens).toBe(item.output);
      expect(spec.context_window).toBe(item.context);
      expect(template.inference_api).toBe("chat-completions");
      expect(template.inference_max_output_tokens).toBe(32_768);
      expect(hasKey(spec, "inference_model")).toBe(false);
      expect(spec.job_image).toBe(WORKER_IMAGE);
      expect(spec.worker_revision).toBe(WORKER_REVISION);
      expect(spec.harbor_version).toBe("0.22.0");
    }
  });

  it("keeps all Terminal-Bench workers self-contained and digest-pinned", async () => {
    const deploymentNames = (await readdir("profiles/deployment"))
      .filter((name) => name.startsWith("tb21-") && name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""));
    for (const name of deploymentNames) {
      const spec = record((await profile("deployment", name)).spec);
      const template = record(spec.trial_job_template);
      expect(spec.job_image).toBe(WORKER_IMAGE);
      expect(spec.worker_revision).toBe(WORKER_REVISION);
      expect(spec.preparation_job_command).toEqual(PREPARATION_COMMAND);
      expect(spec.job_command).toEqual(EXECUTION_COMMAND);
      expect(template.root_bootstrap_command).toEqual(ROOT_BRIDGE_COMMAND);
      expect(template.inference_model).toBeUndefined();
      expect(template.max_image_bytes).toBe(20 * 1024 * 1024 * 1024);
      expect(template.max_image_entries).toBe(500_000);
    }
  });

  it("keeps replacement and diagnostic launch policies bounded", async () => {
    const canary = record((await profile("launch-policy", "tb21-canary")).spec);
    const official = record((await profile("launch-policy", "tb21-official-5")).spec);
    const replacement = record(
      (await profile("launch-policy", "tb21-replacement")).spec,
    );
    const diagnostic = record(
      (await profile("launch-policy", "tb21-diagnostic-1")).spec,
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
    expect(diagnostic.required_positive_metrics).toEqual([
      "input_tokens",
      "output_tokens",
    ]);
  });

  it("loads every built-in profile with resolvable catalog references", async () => {
    const loaded = await loadBuiltInProfiles("profiles");
    const resolver = new ProfileResolver(loaded);
    expect(loaded).toHaveLength(52);
    expect(new Set(loaded.map((item) => item.profile_id)).size).toBe(loaded.length);
    for (const item of loaded) {
      if (item.profile.profile_kind !== "deployment") continue;
      for (const model of item.profile.spec.models)
        expect(() => resolver.get("model", model)).not.toThrow();
      for (const harness of item.profile.spec.harnesses)
        expect(() => resolver.get("harness", harness)).not.toThrow();
    }
  });
});
