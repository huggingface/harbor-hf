import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  applyRuntimeOverrides,
  buildSavedExecution,
  compileAgentWorkbenchRecipe,
  fastAgentWorkbenchStarter,
  FilesystemObjectStore,
  PresetCatalog,
  saveWorkbenchConfiguration,
  setupContext,
  type HarnessRuntimeOverrides,
  type PresetSubmission,
} from "../src/index.js";
import { validateHarborJobConfig } from "@harbor-hf/contracts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function savedExecutionFixture(
  agent = compileAgentWorkbenchRecipe(fastAgentWorkbenchStarter).harbor_agent,
) {
  const root = await mkdtemp(join(tmpdir(), "runtime-overrides-"));
  roots.push(root);
  const store = new FilesystemObjectStore(root);
  const presets = await PresetCatalog.load(
    fileURLToPath(new URL("../../../presets/", import.meta.url)),
  );
  const saved = await saveWorkbenchConfiguration(store, "owner", {
    name: "runtime-regression",
    harbor_job_config: { agents: [agent] },
  });
  const input: PresetSubmission = {
    benchmark: { name: "terminal-bench-2-1", preset: "two-task-canary" },
    harness: { agent: "workbench", version: saved.revision },
    model: { id: "example/model", provider: "example", reasoning_effort: "saved" },
    cost_ceiling_usd_per_trial: 1,
  };
  return { store, presets, input };
}

function native() {
  return validateHarborJobConfig({
    agents: [
      {
        ...compileAgentWorkbenchRecipe(fastAgentWorkbenchStarter).harbor_agent,
        model_name: "openai/example/model:together",
        env: {
          OPENAI_BASE_URL: "https://router.huggingface.co/v1",
          OPENAI_API_KEY: "$" + "{HF_INFERENCE_TOKEN}",
        },
      },
    ],
    n_attempts: 1,
  });
}

it("preserves exact CLI aliases and applies literals to the actual clean command environments", () => {
  const original = native();
  const result = applyRuntimeOverrides(original, {
    model_name: "codexresponses.my-alias",
    environment: [
      { name: "MY_SETTING", value: "custom" },
      { name: "AGENT_MODEL", value: "hf.other-alias" },
    ],
  });
  expect(result.agents?.[0]?.model_name).toBe("codexresponses.my-alias");
  const command = result.agents?.[0]?.kwargs?.config as {
    setup: { literals: Record<string, string>; bindings: Record<string, string> };
    run: { literals: Record<string, string>; bindings: Record<string, string> };
  };
  for (const phase of [command.setup, command.run]) {
    expect(phase.literals).toMatchObject({
      MY_SETTING: "custom",
      AGENT_MODEL: "hf.other-alias",
    });
    expect(phase.bindings).not.toHaveProperty("AGENT_MODEL");
  }
  expect(original.agents?.[0]?.model_name).toBe("openai/example/model:together");
  expect(setupContext(original, "revision", "image", "hardware")).not.toBe(
    setupContext(result, "revision", "image", "hardware"),
  );
});

it("removes implicit credential bindings for an explicitly anonymous external command route", () => {
  const result = applyRuntimeOverrides(native(), {
    endpoint: "https://models.example.test/v1",
    credentials: "none",
    model_name: "custom.model",
  });
  expect(result.agents?.[0]?.env).toEqual({});
  expect(JSON.stringify(result)).not.toContain("HF_INFERENCE_TOKEN");
  expect(JSON.stringify(result)).not.toContain("model_api_key");
  expect(result.agents?.[0]?.kwargs).toMatchObject({
    config: { run: { literals: { MODEL_BASE_URL: "https://models.example.test/v1" } } },
  });
});

it.each([
  { endpoint: "https://models.example.test/v1" },
  { environment: [{ name: "OPENAI_API_KEY", value: "literal-secret" }] },
  { environment: [{ name: "HF_TOKEN", value: "value" }] },
  { environment: [{ name: "BASH_ENV", value: "/tmp/file" }] },
  {
    environment: [
      { name: "MY_VAR", value: "1" },
      { name: "MY_VAR", value: "2" },
    ],
  },
  { environment: [{ name: "MODEL_BASE_URL", value: "https://models.example.test" }] },
  { environment: [{ name: "AI_GATEWAY_API_KEY", secret_ref: "hf-inference-token" }] },
] satisfies HarnessRuntimeOverrides[])(
  "rejects incompatible credential or reserved-variable overrides: %j",
  (overrides) => {
    expect(() => applyRuntimeOverrides(native(), overrides)).toThrow();
  },
);

it("records a reference rather than a token, and binds setup evidence to declared model metadata too", () => {
  const result = applyRuntimeOverrides(native(), {
    environment: [{ name: "OPENAI_API_KEY", secret_ref: "hf-inference-token" }],
  });
  expect(result.agents?.[0]?.env?.OPENAI_API_KEY).toBe("$" + "{HF_INFERENCE_TOKEN}");
  const identity = {
    id: "A declared model",
    provider: "a provider",
    reasoning_effort: "saved",
  };
  expect(setupContext(result, "revision", "image", "hardware", identity)).not.toBe(
    setupContext(result, "revision", "image", "hardware", {
      ...identity,
      revision: "new",
    }),
  );
});

it.each(
  (["setup", "run"] as const).flatMap((phase) =>
    ["OPENAI_BASE_URL", "MODEL_BASE_URL", "ANTHROPIC_BASE_URL"].map((name) => ({
      phase,
      name,
    })),
  ),
)(
  "rejects merged saved $phase endpoint literal $name even without overrides",
  async ({ phase, name }) => {
    const agent = compileAgentWorkbenchRecipe(fastAgentWorkbenchStarter).harbor_agent;
    const command = agent.kwargs.config as {
      setup: { literals: Record<string, string> };
      run: { literals: Record<string, string> };
    };
    command[phase].literals[name] = "https://models.example.test/v1";
    const { store, presets, input } = await savedExecutionFixture(agent);
    for (const mode of ["setup", "benchmark"] as const) {
      for (const submission of [
        input,
        { ...input, runtime: { model_name: "codexresponses.my-alias" } },
      ]) {
        await expect(
          buildSavedExecution(store, presets, "owner", "run", submission, mode),
        ).rejects.toThrow(
          "Runtime endpoint literals conflict with the HF credential route",
        );
      }
    }
  },
);

it.each([
  "OLDPWD",
  "PWD",
  "PROMPT_COMMAND",
  "PS4",
  "AGENT_HOME",
  "TASK_INSTRUCTION_PATH",
  "TASK_WORKSPACE",
  "AGENT_RESULTS_PATH",
  "AGENT_TRAJECTORY_PATH",
])("rejects reserved infrastructure variable %s", (name) => {
  expect(() =>
    applyRuntimeOverrides(native(), { environment: [{ name, value: "value" }] }),
  ).toThrow("reserved infrastructure variables");
});

it.each([
  "SERVICE_KEY",
  "SERVICE_SECRET",
  "SERVICE_TOKEN",
  "SERVICE_TOKEN_LIMIT",
  "SERVICE_PASSWORD",
  "SERVICE_CREDENTIAL",
  "SERVICE_AUTH",
])("rejects sensitive literal variable %s", (name) => {
  expect(() =>
    applyRuntimeOverrides(native(), { environment: [{ name, value: "value" }] }),
  ).toThrow("non-secret literals");
});

it.each(["MAX_TOKENS", "MAX_OUTPUT_TOKENS", "TOKENS_LIMIT"])(
  "preserves non-secret plural TOKENS compatibility for %s",
  (name) => {
    const result = applyRuntimeOverrides(native(), {
      environment: [{ name, value: "4096" }],
    });
    expect(result.agents?.[0]?.kwargs).toMatchObject({
      config: {
        setup: { literals: { [name]: "4096" } },
        run: { literals: { [name]: "4096" } },
      },
    });
  },
);

it.each(["setup", "benchmark"] as const)(
  "requires an exact runtime alias for explicit overrides and free-form declarations in %s",
  async (mode) => {
    const { store, presets, input } = await savedExecutionFixture();
    const invalid: PresetSubmission[] = [
      { ...input, runtime: {} },
      { ...input, runtime: { environment: [{ name: "MAX_TOKENS", value: "4096" }] } },
      { ...input, runtime: { model_name: "" } },
      { ...input, model: { ...input.model, id: "A declared model" } },
      { ...input, model: { ...input.model, provider: "a provider" } },
      { ...input, model: { ...input.model, provider: "unspecified" } },
    ];
    for (const submission of invalid) {
      await expect(
        buildSavedExecution(store, presets, "owner", "run", submission, mode),
      ).rejects.toThrow("Runtime model string is required");
    }
    const legacy = await buildSavedExecution(
      store,
      presets,
      "owner",
      "run",
      input,
      mode,
    );
    expect(legacy.agents?.[0]?.model_name).toBe("openai/example/model:example");
    const exact = await buildSavedExecution(
      store,
      presets,
      "owner",
      "run",
      {
        ...input,
        model: { ...input.model, id: "A declared model", provider: "unspecified" },
        runtime: { model_name: "codexresponses.my-alias" },
      },
      mode,
    );
    expect(exact.agents?.[0]?.model_name).toBe("codexresponses.my-alias");
  },
);
