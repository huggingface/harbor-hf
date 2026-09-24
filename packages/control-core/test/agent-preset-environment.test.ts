import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PresetCatalog } from "../src/presets.js";

const roots: string[] = [];

async function catalog(harborAgent: Record<string, unknown>): Promise<PresetCatalog> {
  const root = await mkdtemp(join(tmpdir(), "agent-preset-environment-"));
  roots.push(root);
  await mkdir(join(root, "agents"));
  await mkdir(join(root, "benchmarks"));
  await writeFile(
    join(root, "agents", "declared.json"),
    JSON.stringify({
      schema_version: "v1",
      agent: "declared",
      version: "1.0.0",
      harbor_agent: { import_path: "example.agent:Agent", ...harborAgent },
      reasoning_option: null,
      reasoning_values: ["default"],
    }),
  );
  await writeFile(
    join(root, "benchmarks", "one.json"),
    JSON.stringify({
      schema_version: "v1",
      benchmark: "example-benchmark",
      preset: "one-task",
      leaderboard_eligible: false,
      job: {
        datasets: [{ repo: "https://example.test/tasks.git@revision", path: "tasks" }],
        n_attempts: 1,
        n_concurrent_trials: 1,
        environment: {
          type: "hf-sandbox",
          kwargs: { flavor: "cpu-basic", job_timeout: "none" },
        },
      },
    }),
  );
  return PresetCatalog.load(root);
}

function submission() {
  return {
    benchmark: { name: "example-benchmark", preset: "one-task" },
    model: { id: "example/model", provider: "openai", reasoning_effort: "default" },
    harness: { agent: "declared", version: "1.0.0" },
    cost_ceiling_usd: 1,
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("agent presets that declare their own environment", () => {
  it("keeps the declared endpoint and hosts instead of the default router", async () => {
    const presets = await catalog({
      env: {
        OPENAI_BASE_URL: "https://agent.invalid/v1",
        OPENAI_API_KEY: "${EXAMPLE_ROUTE_KEY}",
      },
      extra_allowed_hosts: ["agent.invalid"],
    });
    const built = presets.buildJobConfig("run-example", submission(), "/data")
      .agents?.[0];
    expect(built?.env).toEqual({
      OPENAI_BASE_URL: "https://agent.invalid/v1",
      OPENAI_API_KEY: "${EXAMPLE_ROUTE_KEY}",
    });
    expect(built?.extra_allowed_hosts).toEqual(["agent.invalid"]);
  });

  it("uses the reviewed router environment when the preset declares none", async () => {
    const presets = await catalog({});
    const built = presets.buildJobConfig("run-example", submission(), "/data")
      .agents?.[0];
    expect(built?.env).toEqual({
      OPENAI_BASE_URL: "https://router.huggingface.co/v1",
      OPENAI_API_KEY: "${HF_INFERENCE_TOKEN}",
    });
    expect(built).not.toHaveProperty("extra_allowed_hosts");
  });
});
