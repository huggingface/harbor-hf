import { describe, expect, it } from "vitest";
import {
  approvedAlias,
  doubleReservationMicrousd,
  firstCompatibleLaunchSelection,
  profileLabel,
  selectDeploymentAlias,
  selectHarnessAlias,
} from "../src/launch";

describe("launch helpers", () => {
  it("keeps a selected alias when it is approved", () => {
    expect(
      approvedAlias("gpt-oss-20b", ["control-smoke", "gpt-oss-20b"], "model"),
    ).toBe("gpt-oss-20b");
    expect(() => approvedAlias("missing", ["control-smoke"], "launch policy")).toThrow(
      "approved launch policy missing is missing",
    );
  });

  it("selects OpenCode by agent and reasoning without a silent substitute", () => {
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
        "off",
      ),
    ).toBe("opencode");
    expect(() =>
      selectHarnessAlias(
        [{ alias: "pi-high", spec: { agent: "pi", reasoning_effort: "high" } }],
        "opencode",
        "off",
      ),
    ).toThrow(/no approved opencode harness/);
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
      harnessAgent: "general-agent",
      reasoning: "medium",
      deploymentKind: "providers",
    });
  });

  it("skips an ambiguous harness alias unsupported by the deployment", () => {
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
            alias: "ambiguous-runtime",
            spec: {
              models: ["model"],
              harnesses: ["second-harness"],
              inference_provider: "provider",
            },
          },
          {
            alias: "compatible-runtime",
            spec: {
              models: ["model"],
              harnesses: ["distinct-harness"],
              inference_provider: "provider",
            },
          },
        ],
      ),
    ).toEqual({
      model: "model",
      harnessAgent: "other-agent",
      reasoning: "off",
      deploymentKind: "providers",
    });
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
              sandbox_template: { inference_upstream: "<redacted>" },
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
              sandbox_template: {
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
