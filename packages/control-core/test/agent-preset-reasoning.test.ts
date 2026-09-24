import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PresetCatalog } from "../src/presets.js";

const roots: string[] = [];

async function catalog(reasoningValues: string[]): Promise<PresetCatalog> {
  const root = await mkdtemp(join(tmpdir(), "agent-preset-reasoning-"));
  roots.push(root);
  await mkdir(join(root, "agents"));
  await mkdir(join(root, "benchmarks"));
  await writeFile(
    join(root, "agents", "pinned.json"),
    JSON.stringify({
      schema_version: "v1",
      agent: "pinned",
      version: "1.0.0",
      harbor_agent: {
        import_path: "example.agent:Agent",
        kwargs: { version: "1.0.0" },
      },
      reasoning_option: null,
      reasoning_values: reasoningValues,
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

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("agent presets without a reasoning option", () => {
  it("accepts the single value the reviewed harness pins, and nothing else", async () => {
    const presets = await catalog(["xhigh"]);
    const submission = {
      benchmark: { name: "example-benchmark", preset: "one-task" },
      model: { id: "example/model", provider: "example", reasoning_effort: "xhigh" },
      harness: { agent: "pinned", version: "1.0.0" },
      cost_ceiling_usd: 1,
    };
    expect(
      presets.buildJobConfig("run-example", submission, "/data").agents?.[0],
    ).not.toHaveProperty("kwargs.reasoning");
    expect(() =>
      presets.buildJobConfig(
        "run-example",
        { ...submission, model: { ...submission.model, reasoning_effort: "default" } },
        "/data",
      ),
    ).toThrow("reasoning effort is not supported");
  });

  it("refuses a preset that offers a choice it cannot forward", async () => {
    await expect(catalog(["high", "xhigh"])).rejects.toThrow("must not offer a choice");
  });
});
