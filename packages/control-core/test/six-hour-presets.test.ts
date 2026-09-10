import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PresetCatalog } from "../src/presets.js";

const catalog = await PresetCatalog.load(
  fileURLToPath(new URL("../../../presets", import.meta.url)),
);
const benchmark = "terminal-bench-2-1";
const variants = [
  ["all-tasks-1-trial-qemu-fixed", "all-tasks-1-trial-with-6h-qemu-fixed", 1, 89],
  ["all-tasks-5-trials-qemu-fixed", "all-tasks-5-trials-with-6h-qemu-fixed", 5, 445],
  ["held-50-1-trial-qemu-fixed", "held-50-3-trials-qemu-fixed", 3, 150],
] as const;
const timing = { override_timeout_sec: 21600, max_timeout_sec: null };

describe("six-hour fixed diagnostic suite", () => {
  it("preserves the catalog-first default used by both fresh forms", () => {
    expect(catalog.benchmarks[0]?.preset).toBe("all-tasks-1-trial-qemu-fixed");
    expect(catalog.benchmarks[0]?.job.agent_timeout_multiplier).toBe(4);
    expect(catalog.benchmarks[0]?.job.agents).toBeUndefined();
  });

  it.each(variants)(
    "changes only native timing and attempts from %s",
    (old, name, attempts, trials) => {
      const original = catalog.benchmark(benchmark, old);
      const preset = catalog.benchmark(benchmark, name);
      expect(preset).toEqual({
        ...original,
        preset: name,
        job: {
          ...original.job,
          agents: [timing],
          agent_timeout_multiplier: 1,
          n_attempts: attempts,
          retry: { max_retries: 0 },
        },
      });
      expect(preset.leaderboard_eligible).toBe(false);
      const tasks = preset.job.datasets[0]?.task_names;
      if (tasks) {
        expect(tasks).toEqual(
          catalog.benchmark(benchmark, "held-50-1-trial-qemu-fixed").job.datasets[0]
            ?.task_names,
        );
        expect(new Set(tasks).size).toBe(50);
        expect(tasks).toEqual(
          expect.arrayContaining(["qemu-startup", "qemu-alpine-ssh"]),
        );
      }
      // Full source size is independently verified with pinned Harbor metadata.
      expect((tasks?.length ?? 89) * preset.job.n_attempts).toBe(trials);
    },
  );

  it.each(
    catalog.agents.flatMap((agent) =>
      ["example/model-one", "another/model-two"].flatMap((model) =>
        variants.map(([old, name, attempts]) => ({
          agent,
          model,
          old,
          name,
          attempts,
        })),
      ),
    ),
  )(
    "preserves selected agent/model and native timing through both compilers: $name $agent.agent $model",
    ({ agent, model, old, name, attempts }) => {
      const submission = {
        benchmark: { name: benchmark, preset: name },
        model: {
          id: model,
          provider: "example",
          reasoning_effort: agent.reasoning_values[0] ?? "default",
        },
        harness: { agent: agent.agent, version: agent.version },
        cost_ceiling_usd: 1,
      };
      const fragment = {
        import_path: "harbor_hf_agents.command_agent.agent:CommandAgent",
        model_name: `openai/${model}`,
        override_setup_timeout_sec: 600,
        kwargs: { recipe: "unchanged", model },
      };
      for (const workbench of [false, true]) {
        const compile = (preset: string) => {
          const input = { ...submission, benchmark: { name: benchmark, preset } };
          return workbench
            ? catalog.buildWorkbenchJobConfig("run-example", input, "/data", fragment)
            : catalog.buildJobConfig("run-example", input, "/data");
        };
        const original = compile(old);
        const config = compile(name);
        expect(config).toEqual({
          ...original,
          agents: [{ ...original.agents?.[0], ...timing }],
          agent_timeout_multiplier: 1,
          n_attempts: attempts,
          retry: { max_retries: 0 },
        });
        expect(config.n_concurrent_trials).toBe(8);
        expect(config.environment?.kwargs?.job_timeout).toBe("none");
        expect(config.agent_setup_timeout_multiplier).toBe(2);
        expect(config.agents?.[0]?.model_name).toContain(model);
        expect(config.agents?.[0]?.kwargs).toEqual(original.agents?.[0]?.kwargs);
      }
    },
  );
});
