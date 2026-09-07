import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  buildSavedExecution,
  FilesystemObjectStore,
  PresetCatalog,
  saveWorkbenchConfiguration,
  setupContext,
  compileAgentWorkbenchRecipe,
  fastAgentWorkbenchStarter,
} from "../src/index.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each(["literal", "reserved-key", "other-plugin"])(
  "does not mistake %s credential material for approved late binding",
  async (variant) => {
    const root = await mkdtemp(join(tmpdir(), "saved-credentials-"));
    roots.push(root);
    const agent = structuredClone(
      compileAgentWorkbenchRecipe(fastAgentWorkbenchStarter).harbor_agent,
    );
    const config = agent.kwargs.config as { run: { bindings: Record<string, string> } };
    if (variant === "literal") config.run.bindings.OPENAI_API_KEY = "private-literal";
    if (variant === "reserved-key") config.run.bindings.HF_TOKEN = "model_api_key";
    if (variant === "other-plugin") agent.import_path = "other.agent:Agent";
    await expect(
      saveWorkbenchConfiguration(new FilesystemObjectStore(root), "owner", {
        name: "unsafe",
        harbor_job_config: { agents: [agent] },
      }),
    ).rejects.toThrow("credential material");
  },
);

it("uses an exact owner-scoped saved version and native install-only mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "saved-execution-"));
  roots.push(root);
  const store = new FilesystemObjectStore(root);
  const presets = await PresetCatalog.load(resolve("presets"));
  const saved = await saveWorkbenchConfiguration(store, "owner", {
    name: "my-pi",
    harbor_job_config: {
      agents: [{ name: "pi", kwargs: { thinking: "off", version: "0.84.4" } }],
    },
  });
  const input = {
    benchmark: { name: "terminal-bench-2-1", preset: "two-task-canary" },
    harness: { agent: "workbench", version: saved.revision },
    model: { id: "example/model", provider: "example", reasoning_effort: "saved" },
    cost_ceiling_usd_per_trial: 1,
  };
  const setup = await buildSavedExecution(
    store,
    presets,
    "owner",
    "setup-run",
    input,
    "setup",
  );
  const run = await buildSavedExecution(
    store,
    presets,
    "owner",
    "bench-run",
    input,
    "benchmark",
  );
  expect(setup).toMatchObject({
    install_only: true,
    n_attempts: 1,
    n_concurrent_trials: 1,
    retry: { max_retries: 0 },
  });
  expect(run).not.toHaveProperty("install_only");
  expect(run.agents?.[0]).toMatchObject({
    name: "pi",
    kwargs: { thinking: "off", version: "0.84.4" },
    model_name: "huggingface/example/model:example",
  });
  expect(setupContext(setup, saved.revision, "image", "cpu-basic")).toBe(
    setupContext(run, saved.revision, "image", "cpu-basic"),
  );
  expect(setupContext(run, saved.revision, "different-image", "cpu-basic")).not.toBe(
    setupContext(run, saved.revision, "image", "cpu-basic"),
  );
  await expect(
    buildSavedExecution(store, presets, "other-owner", "run", input, "benchmark"),
  ).rejects.toThrow("owner");
  const edited = await saveWorkbenchConfiguration(store, "owner", {
    name: saved.name,
    harbor_job_config: { agents: [{ name: "pi", kwargs: { thinking: "high" } }] },
  });
  expect(edited.revision).not.toBe(saved.revision);
  const updated = await buildSavedExecution(
    store,
    presets,
    "owner",
    "run",
    { ...input, harness: { ...input.harness, version: edited.revision } },
    "benchmark",
  );
  expect(setupContext(updated, edited.revision, "image", "cpu-basic")).not.toBe(
    setupContext(run, saved.revision, "image", "cpu-basic"),
  );
});
