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

async function runRecipe(
  model: string,
  options: {
    inferenceKey?: string | null;
    certificate?: "missing" | "lookup-failed";
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "fast-agent-recipe-"));
  roots.push(root);
  await mkdir(join(root, "venv", "bin"), { recursive: true });
  if (!options.certificate)
    await writeFile(join(root, "ca bundle.pem"), "fixture CA bundle");
  await writeFile(
    join(root, "venv", "bin", "python"),
    [
      "#!/bin/sh",
      '[ "$1" = "-c" ] || exit 7',
      '[ "$2" = "import certifi; print(certifi.where())" ] || exit 8',
      options.certificate === "lookup-failed"
        ? "exit 6"
        : 'printf "%s\\n" "$AGENT_HOME/ca bundle.pem"',
    ].join("\n"),
    { mode: 0o700 },
  );
  // No agent or inference runs: this executable only checks credential isolation
  // and echoes argv. All credential markers are synthetic test values.
  await writeFile(
    join(root, "venv", "bin", "fast-agent"),
    [
      "#!/bin/sh",
      '[ "$HF_TOKEN" = "$OPENAI_API_KEY" ] || exit 9',
      '[ "$HF_TOKEN" != "fixture-control" ] || exit 10',
      '[ "$SSL_CERT_FILE" = "$AGENT_HOME/ca bundle.pem" ] || exit 11',
      '[ -r "$SSL_CERT_FILE" ] || exit 12',
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
        '[ "$SSL_CERT_FILE" = "/fixture/parent-ca.pem" ]',
      ].join("\n"),
    ],
    {
      env: {
        AGENT_HOME: root,
        AGENT_MODEL: model,
        ...(options.inferenceKey === null
          ? {}
          : { OPENAI_API_KEY: options.inferenceKey ?? "fixture-inference" }),
        HF_TOKEN: "fixture-control",
        SSL_CERT_FILE: "/fixture/parent-ca.pem",
        // No MODEL_BASE_URL: the native provider must choose its own URL.
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
    expect(args).not.toContain("--base-url");
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

  it.each([null, ""])(
    "fails closed with a missing or empty inference key (%s)",
    async (inferenceKey) => {
      await expect(
        runRecipe("openai/example-org/model:together", { inferenceKey }),
      ).rejects.toMatchObject({
        code: 1,
        stdout: "",
        stderr: expect.stringContaining("Injected inference key is missing or empty"),
      });
    },
  );

  it.each(["missing", "lookup-failed"] as const)(
    "fails closed when the certifi bundle is %s",
    async (certificate) => {
      await expect(
        runRecipe("hf.example-org/model:together", { certificate }),
      ).rejects.toMatchObject({
        code: certificate === "lookup-failed" ? 6 : 1,
        stdout: "",
      });
    },
  );

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
