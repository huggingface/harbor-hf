import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  compileAgentWorkbenchRecipe,
  fastAgentWorkbenchStarter,
} from "../src/workbench.js";

const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function runRecipe(model: string, withInferenceKey = true) {
  const root = await mkdtemp(join(tmpdir(), "fast-agent-recipe-"));
  roots.push(root);
  await mkdir(join(root, "venv", "bin"), { recursive: true });
  // No agent or inference runs: this executable only checks credential isolation
  // and echoes argv. All credential markers are synthetic test values.
  await writeFile(
    join(root, "venv", "bin", "fast-agent"),
    [
      "#!/bin/sh",
      '[ "$HF_TOKEN" = "$OPENAI_API_KEY" ] || exit 9',
      '[ "$HF_TOKEN" != "fixture-control" ] || exit 10',
      'printf "%s\\n" "$@"',
    ].join("\n"),
    { mode: 0o700 },
  );
  const preview = compileAgentWorkbenchRecipe(fastAgentWorkbenchStarter);
  expect(preview.harbor_agent.kwargs.config).toMatchObject({
    run: { script: fastAgentWorkbenchStarter.run_command },
    setup: { bindings: { AGENT_MODEL: "model_name" } },
  });
  return execute(
    "/bin/bash",
    [
      "-c",
      [
        fastAgentWorkbenchStarter.run_command,
        // The inference credential assignment must not replace the parent shell's key.
        '[ "$HF_TOKEN" = "fixture-control" ]',
      ].join("\n"),
    ],
    {
      env: {
        AGENT_HOME: root,
        AGENT_MODEL: model,
        ...(withInferenceKey ? { OPENAI_API_KEY: "fixture-inference" } : {}),
        HF_TOKEN: "fixture-control",
        MODEL_BASE_URL: "https://router.huggingface.co/v1",
        TASK_INSTRUCTION_PATH: "/fixture/instruction.txt",
        TASK_WORKSPACE: "/fixture/workspace",
        AGENT_RESULTS_PATH: "/fixture/results.json",
        AGENT_TRAJECTORY_PATH: "/fixture/trajectory.json",
      },
      timeout: 5000,
    },
  );
}

describe("fast-agent native HF recipe", () => {
  it.each([
    ["example-org/model-one", "together"],
    ["example-org/model-two", "deepinfra"],
  ])("passes %s through %s to the native HF adapter", async (model, provider) => {
    const result = await runRecipe(`openai/${model}:${provider}`);
    const args = result.stdout.trim().split("\n");
    expect(args[args.indexOf("--model") + 1]).toBe(`hf.${model}:${provider}`);
    expect(args[args.indexOf("--base-url") + 1]).toBe(
      "https://router.huggingface.co/v1",
    );
    expect(args).toContain("--results");
    expect(args).toContain("--trajectory-output");
    expect(result.stdout).not.toContain("fixture-inference");
    expect(result.stdout).not.toContain("fixture-control");
    expect(result.stderr).toBe("");
  });

  it.each(["hf.example-org/model:together", "hf.other-org/other-model:deepinfra"])(
    "preserves the explicit native model string %s",
    async (model) => {
      const result = await runRecipe(model);
      const args = result.stdout.trim().split("\n");
      expect(args[args.indexOf("--model") + 1]).toBe(model);
    },
  );

  it.each(["glimmer", "openai/glimmer:hf", "openai/example-org/model"])(
    "rejects an unexpected route instead of silently rewriting %s",
    async (model) => {
      await expect(runRecipe(model)).rejects.toMatchObject({
        code: 2,
        stdout: "",
        stderr: "Expected a full Hub model ID and HF provider from Workbench\n",
      });
    },
  );

  it("fails closed without the injected inference key instead of using a parent token", async () => {
    await expect(
      runRecipe("openai/example-org/model:together", false),
    ).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining("OPENAI_API_KEY: unbound variable"),
    });
  });

  it("does not add an inference credential to setup or durable recipe values", () => {
    const preview = compileAgentWorkbenchRecipe(fastAgentWorkbenchStarter);
    const config = preview.harbor_agent.kwargs.config;
    expect(config).toMatchObject({
      run: { bindings: { OPENAI_API_KEY: "model_api_key" } },
    });
    expect(config.setup).not.toHaveProperty("bindings.OPENAI_API_KEY");
    expect(
      fastAgentWorkbenchStarter.environment.map((binding) => binding.name),
    ).not.toContain("HF_TOKEN");
    expect(JSON.stringify(preview)).not.toContain("fixture-inference");
    expect(fastAgentWorkbenchStarter.setup_command).not.toContain("HF_TOKEN");
  });
});
