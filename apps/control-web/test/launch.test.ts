import { describe, expect, it } from "vitest";
import {
  approvedAlias,
  compatibleBenchmarks,
  deploymentRequiresPreparation,
  doubleReservationMicrousd,
  firstCompatibleLaunchSelection,
  labeledHarness,
  profileLabel,
  selectCompatibleBenchmarkAlias,
  selectDeploymentAlias,
  selectHarnessAlias,
} from "../src/launch";

describe("launch helpers", () => {
  it("rejects ambiguous deployment matches instead of silently choosing the first", () => {
    const spec = {
      models: ["model"],
      harnesses: ["agent"],
      inference_provider: "provider",
    };
    expect(() =>
      selectDeploymentAlias(
        [
          { alias: "one", spec },
          { alias: "two", spec },
        ],
        "providers",
        "model",
        "agent",
      ),
    ).toThrow(/Multiple approved.*one, two/);
  });
  it("keeps a selected alias when it is approved", () => {
    expect(
      approvedAlias("gpt-oss-20b", ["control-smoke", "gpt-oss-20b"], "model"),
    ).toBe("gpt-oss-20b");
    expect(() => approvedAlias("missing", ["control-smoke"], "launch policy")).toThrow(
      "approved launch policy missing is missing",
    );
  });

  it("selects the exact approved harness alias without a silent substitute", () => {
    expect(
      selectHarnessAlias(
        [
          {
            alias: "pi-high",
            spec: { agent: "pi", reasoning_effort: "high" },
          },
          {
            alias: "opencode",
            spec: { agent: "opencode", reasoning_effort: "off" },
          },
        ],
        "opencode",
      ),
    ).toBe("opencode");
    expect(() =>
      selectHarnessAlias(
        [{ alias: "pi-high", spec: { agent: "pi", reasoning_effort: "high" } }],
        "opencode",
      ),
    ).toThrow(/approved harness opencode is missing/);
  });

  it("doubles the estimated reservation for the default ceiling", () => {
    expect(doubleReservationMicrousd(5_200_000)).toBe(10_400_000);
  });

  it("derives defaults from the first compatible promoted deployment", () => {
    expect(
      firstCompatibleLaunchSelection(
        [
          { alias: "unrelated-model", spec: {} },
          { alias: "compatible-model", spec: {} },
        ],
        [
          {
            alias: "compatible-harness",
            spec: { agent: "general-agent", reasoning_effort: "medium" },
          },
        ],
        [
          {
            alias: "unsupported-runtime",
            spec: {
              models: ["unrelated-model"],
              harnesses: ["compatible-harness"],
            },
          },
          {
            alias: "compatible-runtime",
            spec: {
              models: ["compatible-model"],
              harnesses: ["compatible-harness"],
              inference_provider: "provider",
            },
          },
        ],
      ),
    ).toEqual({
      model: "compatible-model",
      harness: "compatible-harness",
      deploymentKind: "providers",
    });
  });

  it("keeps the exact compatible alias when command recipes share an agent name", () => {
    expect(
      firstCompatibleLaunchSelection(
        [{ alias: "model", spec: {} }],
        [
          { alias: "first-harness", spec: { agent: "agent" } },
          { alias: "second-harness", spec: { agent: "agent" } },
          { alias: "distinct-harness", spec: { agent: "other-agent" } },
        ],
        [
          {
            alias: "second-runtime",
            spec: {
              models: ["model"],
              harnesses: ["second-harness"],
              inference_provider: "provider",
            },
          },
        ],
        "second-harness",
      ),
    ).toEqual({
      model: "model",
      harness: "second-harness",
      deploymentKind: "providers",
    });
  });

  it("offers only Harbor-backed benchmarks to deployments that require preparation", () => {
    const benchmarks = [
      {
        alias: "internal-smoke",
        spec: { task_ids: ["smoke"] },
      },
      {
        alias: "prepared-canary",
        spec: {
          task_ids: ["alpha-trial-1", "beta-trial-1"],
          source_task_ids: ["alpha", "beta"],
          trial_indices: [1, 1],
          harbor_job: { datasets: [{ path: "tasks" }] },
        },
      },
    ];
    const preparedDeployment = {
      route: "hf_job",
      preparation: "required",
    };

    expect(deploymentRequiresPreparation(preparedDeployment)).toBe(true);
    expect(
      compatibleBenchmarks(benchmarks, preparedDeployment).map(
        (benchmark) => benchmark.alias,
      ),
    ).toEqual(["prepared-canary"]);
    expect(
      selectCompatibleBenchmarkAlias(benchmarks, preparedDeployment, "internal-smoke"),
    ).toBe("prepared-canary");
    expect(
      compatibleBenchmarks(benchmarks, {
        route: "hf_job",
        preparation: "not_required",
      }).map((benchmark) => benchmark.alias),
    ).toEqual(["internal-smoke", "prepared-canary"]);
  });

  it("rejects incomplete or duplicate prepared benchmark mappings", () => {
    expect(
      compatibleBenchmarks(
        [
          {
            alias: "incomplete",
            spec: {
              task_ids: ["alpha", "beta"],
              source_task_ids: ["alpha"],
              trial_indices: [1],
              harbor_job: { datasets: [] },
            },
          },
          {
            alias: "duplicate",
            spec: {
              task_ids: ["alpha-one", "alpha-two"],
              source_task_ids: ["alpha", "alpha"],
              trial_indices: [1, 1],
              harbor_job: { datasets: [] },
            },
          },
        ],
        { route: "hf_job", preparation: "required" },
      ),
    ).toEqual([]);
  });

  it("distinguishes Pi harness reasoning while leaving unknown reasoning unlabeled", () => {
    expect(
      profileLabel("harness", "pi-high", {
        agent: "pi",
        reasoning_effort: "high",
      }),
    ).toBe("Pi · High reasoning");
    expect(
      profileLabel("harness", "pi-off", {
        agent: "pi",
        reasoning_effort: "off",
      }),
    ).toBe("Pi · No reasoning");
    expect(profileLabel("harness", "pi", { agent: "pi" })).toBe("Pi");
  });

  it("labels DeepSeek Harness instead of the dsh alias", () => {
    expect(profileLabel("harness", "dsh", { agent: "dsh" })).toBe("DeepSeek Harness");
    expect(
      profileLabel("harness", "dsh-high-deepseek-v4-flash-0731-together", {
        agent: "dsh",
      }),
    ).toBe("DeepSeek Harness");
    expect(labeledHarness("dsh")).toBe("DeepSeek Harness");
    expect(labeledHarness(null)).toBe("—");
  });

  it("labels Terminal-Bench 2.1 by source tasks and trials, not logical attempts", () => {
    expect(
      profileLabel("benchmark", "terminal-bench-2-1-official-5", {
        benchmark: "terminal-bench-2-1",
        task_ids: Array.from({ length: 10 }, (_, index) => `task-${index}`),
        source_task_ids: ["alpha", "beta"],
        trial_indices: [1, 2, 3, 4, 5],
      }),
    ).toBe("Terminal-Bench 2.1 · 2 tasks with 5 trials each");
    expect(
      profileLabel("benchmark", "terminal-bench-2-1-diagnostic-1", {
        benchmark: "terminal-bench-2-1",
        task_ids: ["a", "b"],
        source_task_ids: ["a", "b"],
        trial_indices: [1, 1],
      }),
    ).toBe("Terminal-Bench 2.1 · 2 tasks");
    expect(
      profileLabel("benchmark", "control-smoke", {
        task_ids: ["control-smoke-task"],
      }),
    ).toBe("Control Smoke · 1 task");
  });

  it("treats a providers deployment as providers after the API redacts the router URL", () => {
    expect(
      selectDeploymentAlias(
        [
          {
            alias: "tb21-gpt-oss-20b-opencode-providers",
            spec: {
              models: ["gpt-oss-20b"],
              harnesses: ["opencode"],
              inference_provider: "together",
              trial_job_template: { inference_upstream: "<redacted>" },
            },
          },
        ],
        "providers",
        "gpt-oss-20b",
        "opencode",
      ),
    ).toBe("tb21-gpt-oss-20b-opencode-providers");
  });

  it("selects a providers deployment for the locked model and harness", () => {
    expect(
      selectDeploymentAlias(
        [
          {
            alias: "hf-cpu-smoke",
            spec: { models: ["control-smoke"], harnesses: ["control-smoke"] },
          },
          {
            alias: "tb21-providers",
            spec: {
              models: ["gpt-oss-20b"],
              harnesses: ["opencode"],
              trial_job_template: {
                inference_upstream: "https://router.huggingface.co/v1",
              },
            },
          },
        ],
        "providers",
        "gpt-oss-20b",
        "opencode",
      ),
    ).toBe("tb21-providers");
  });
});
