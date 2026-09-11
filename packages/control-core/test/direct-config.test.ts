import { describe, expect, it } from "vitest";
import { directSubmission, prepareDirectJobConfig } from "../src/presets.js";

const id = "run-0123456789abcdef01234567";
const agent = {
  name: "openclaw",
  model_name: "openai/example/model:provider",
  kwargs: { version: "2026.7.1-2" },
};
const config = {
  datasets: [{ name: "example/dataset", ref: `sha256:${"a".repeat(64)}` }],
  agents: [agent],
  environment: {
    type: "hf-sandbox",
    kwargs: { flavor: "cpu-upgrade", job_timeout: "none" },
    env: { LANG: "C.UTF-8" },
  },
  n_attempts: 2,
  n_concurrent_trials: 4,
  retry: { max_retries: 0 },
  verifier: { disable: false },
  extra_instructions: ["Use the provided tools."],
};
const prepare = (value: unknown) => prepareDirectJobConfig(id, value, "/data");

describe("direct native configuration", () => {
  it("preserves GPU hardware without a local hardware allowlist", () => {
    expect(
      prepare({
        ...config,
        environment: { ...config.environment, kwargs: { flavor: "a100-large" } },
      }).environment,
    ).toMatchObject({
      kwargs: { flavor: "a100-large", job_timeout: "none" },
    });
  });
  it("preserves a private Hugging Face Dataset repo and its native path", () => {
    const repo = `https://huggingface.co/datasets/example-org/example-dataset.git@${"b".repeat(40)}`;
    const datasets = [{ repo, path: "reviewed/tasks" }];

    const output = prepare({ ...config, datasets });

    expect(output.datasets).toEqual(datasets);
    expect(output).not.toHaveProperty("dataset_source");
  });
  it("disables the Sandbox idle timeout until the upstream fix is deployed", () => {
    expect(
      prepare({
        ...config,
        environment: { type: "hf-sandbox", kwargs: { flavor: "cpu-basic" } },
      }).environment,
    ).toMatchObject({
      kwargs: { flavor: "cpu-basic", job_timeout: "none" },
    });
    expect(() =>
      prepare({
        ...config,
        environment: {
          type: "hf-sandbox",
          kwargs: { flavor: "cpu-basic", job_timeout: "30m" },
        },
      }),
    ).toThrow("https://github.com/huggingface/sandbox-server/pull/21");
  });
  it("preserves hardware, native options, sources, agents, retries, and false values", () => {
    const input = {
      ...config,
      agents: [
        agent,
        { ...agent, kwargs: { version: "2026.7.2" }, override_timeout_sec: 123 },
      ],
      tasks: [{ name: "example/task", ref: `sha256:${"b".repeat(64)}` }],
    };
    const before = structuredClone(input);
    const output = prepare(input);
    expect(input).toEqual(before);
    expect(output).toMatchObject({
      ...config,
      agents: input.agents,
      tasks: input.tasks,
      environment: {
        kwargs: { flavor: "cpu-upgrade", job_timeout: "none", run_label: id },
        env: { LANG: "C.UTF-8" },
      },
    });
    expect(output.environment).not.toHaveProperty("type");
    expect(output.agents).toHaveLength(2);
    expect(directSubmission(output, 0.25)).not.toHaveProperty("model");
    expect(directSubmission(output, 0.25)).not.toHaveProperty("harness");
  });
  it("preserves values above the former per-field launch caps", () => {
    const input = {
      ...config,
      datasets: Array.from({ length: 9 }, () => ({ ...config.datasets[0] })),
      agents: Array.from({ length: 9 }, () => structuredClone(agent)),
      n_attempts: 11,
      n_concurrent_trials: 65,
      retry: { max_retries: 4 },
    };
    const output = prepare(input);
    expect(output.agents).toHaveLength(9);
    expect(output.datasets).toEqual(input.datasets);
    expect(output).toMatchObject({
      n_attempts: 11,
      n_concurrent_trials: 65,
      retry: { max_retries: 4 },
    });
  });
  it("still rejects a diagnostic job without agents", () => {
    expect(() => prepare({ ...config, agents: [] })).toThrow("at least one agent");
  });
  it("does not silently rewrite Pi routes or discard model_api", () => {
    expect(
      prepare({ ...config, agents: [{ ...agent, name: "pi" }] }).agents,
    ).toMatchObject([{ model_name: agent.model_name }]);
    // The native inspector, not a second TypeScript implementation registry,
    // checks whether the selected implementation admits this explicit route.
    expect(() =>
      prepare({ ...config, agents: [{ ...agent, kwargs: { model_api: "other" } }] }),
    ).toThrow("model_api");
  });
  it.each(["skills", "load_trajectory", "mcp_servers", "extra_allowed_hosts"])(
    "rejects agent extension point %s",
    (field) => {
      expect(() =>
        prepare({
          ...config,
          agents: [{ ...agent, [field]: field === "load_trajectory" ? "path" : [] }],
        }),
      ).toThrow();
    },
  );
  it.each(["forward_hf_token", "run_label", "namespace", "mounts"])(
    "rejects managed environment kwarg %s",
    (field) => {
      expect(() =>
        prepare({
          ...config,
          environment: { type: "hf-sandbox", kwargs: { [field]: "value" } },
        }),
      ).toThrow(/not admitted|credential material/);
    },
  );
  it.each(["force_build", "override_memory_mb", "extra_allowed_hosts", "import_path"])(
    "rejects unsupported environment field %s",
    (field) => {
      expect(() =>
        prepare({
          ...config,
          environment: {
            type: "hf-sandbox",
            [field]:
              field === "force_build"
                ? true
                : field === "override_memory_mb"
                  ? 1000
                  : field === "extra_allowed_hosts"
                    ? []
                    : "unknown:Env",
          },
        }),
      ).toThrow();
    },
  );
  it("rejects arbitrary agent environment and credential material", () => {
    expect(() =>
      prepare({
        ...config,
        agents: [{ ...agent, env: { PYTHONPATH: "/tmp/override" } }],
      }),
    ).toThrow("not admitted");
    expect(() =>
      prepare({
        ...config,
        agents: [{ ...agent, env: { LANG: `hf_${"a".repeat(24)}` } }],
      }),
    ).toThrow("credential material");
    expect(() =>
      prepare({
        ...config,
        environment: { ...config.environment, kwargs: { flavor: 4 } },
      }),
    ).toThrow("flavor");
  });
});
