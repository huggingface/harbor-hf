import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RunRecordV1, RunStateV1 } from "@harbor-hf/contracts";
import { runRecordPath, runStatePath } from "@harbor-hf/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ControlService,
  compileAgentWorkbenchRecipe,
  costLimitReached,
  createJson,
  FilesystemObjectStore,
  fastAgentWorkbenchStarter,
  type JobObservation,
  type JobsPort,
  leaderboard,
  PresetCatalog,
  Projection,
  putJson,
  statusFor,
  summarizeTrial,
} from "../src/index.js";

class FakeJobs implements JobsPort {
  readonly values: JobObservation[] = [];
  readonly cancelled: string[] = [];
  starts = 0;

  async list(): Promise<readonly JobObservation[]> {
    return structuredClone(this.values);
  }

  async startParent(runId: string): Promise<JobObservation> {
    this.starts += 1;
    const created = new Date(Date.now() - 10_000).toISOString();
    const job: JobObservation = {
      id: `parent-${this.starts}`,
      run_id: runId,
      role: "parent",
      stage: "queued",
      created_at: created,
      started_at: created,
      finished_at: null,
    };
    this.values.push(job);
    return structuredClone(job);
  }

  async cancel(jobId: string): Promise<void> {
    this.cancelled.push(jobId);
    const job = this.values.find((item) => item.id === jobId);
    if (job) job.stage = "stopped";
  }
}

let root: string;
let projection: Projection;
let store: FilesystemObjectStore;
let jobs: FakeJobs;
let presets: PresetCatalog;
let service: ControlService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "harbor-hf-core-"));
  store = new FilesystemObjectStore(join(root, "bucket"));
  projection = await Projection.open(join(root, "projection.sqlite"));
  jobs = new FakeJobs();
  presets = await PresetCatalog.load(resolve("presets"));
  service = new ControlService(store, projection, presets, jobs, {
    harborRevision: "d".repeat(40),
    mountRoot: "/data",
    maxActiveJobs: 1,
    restartDelayMs: 0,
  });
  await service.initialize();
});

afterEach(async () => {
  projection.close();
  await rm(root, { recursive: true, force: true });
});

const input = {
  benchmark: { name: "terminal-bench-2-1", preset: "one-task-1-trial" },
  model: { id: "openai/gpt-oss-20b", provider: "together", reasoning_effort: "off" },
  harness: { agent: "pi", version: "0.84.4" },
  cost_ceiling_usd_per_trial: 0.25,
} as const;

async function submit(key = "test-key") {
  return service.submitPreset(input, key, "test-subject");
}

function trial(
  cost = 0.01,
  reward = 1,
  id = "11111111-1111-4111-8111-111111111111",
): Record<string, unknown> {
  return {
    id,
    trial_name: "task__trial",
    agent_result: { cost_usd: cost },
    verifier_result: { rewards: { reward } },
    exception_info: null,
  };
}

describe("run submission", () => {
  it("resolves a reviewed preset into one Harbor job", async () => {
    expect(
      presets.benchmark("terminal-bench-2-1", "one-task-1-trial").job.environment,
    ).toEqual({
      type: "hf-sandbox",
      kwargs: { flavor: "cpu-upgrade", job_timeout: "none" },
    });
    const result = await submit();
    expect(result.created).toBe(true);
    expect(result.run.harbor_job_config).toMatchObject({
      job_name: "job",
      jobs_dir: `/data/runs/${result.run.run_id}`,
      n_attempts: 1,
      n_concurrent_trials: 1,
      agents: [
        {
          import_path: "harbor_hf_agents.pi.agent:PiAgent",
          model_name: "huggingface/openai/gpt-oss-20b:together",
          env: { HF_TOKEN: "$" + "{HF_INFERENCE_TOKEN}" },
          kwargs: { version: "0.84.4", thinking: "off" },
        },
      ],
      environment: {
        import_path: "harbor_hf_agents.hf_sandbox:LabeledHFSandboxEnvironment",
        kwargs: {
          flavor: "cpu-upgrade",
          job_timeout: "none",
          run_label: result.run.run_id,
        },
      },
    });
    expect(projection.run(result.run.run_id)?.status).toBe("queued");
  });

  it("loads the nine-trial diagnostic preset unchanged through both launch paths", async () => {
    const benchmark = { name: "terminal-bench-2-1", preset: "three-tasks-3-trials" };
    const canary = presets.benchmark(benchmark.name, benchmark.preset);
    const original = presets.benchmark(benchmark.name, "one-task-1-trial");
    const taskNames = [
      "code-from-image",
      "log-summary-date-ranges",
      "openssl-selfsigned-cert",
    ];
    expect(canary).toEqual({
      ...original,
      preset: benchmark.preset,
      leaderboard_eligible: false,
      job: {
        ...original.job,
        datasets: [{ ...original.job.datasets[0], task_names: taskNames }],
        n_attempts: 3,
        n_concurrent_trials: 3,
      },
    });
    expect(presets.leaderboardEligible(benchmark.name, benchmark.preset)).toBe(false);
    const submission = { ...input, benchmark, role: "diagnostic" as const };
    const fragment = compileAgentWorkbenchRecipe(
      fastAgentWorkbenchStarter,
    ).harbor_agent;
    const normal = await service.submitPreset(
      submission,
      "canary-normal",
      "test-subject",
    );
    const workbench = await service.submitWorkbench(
      submission,
      fragment,
      "canary-workbench",
      "test-subject",
    );
    for (const { run } of [normal, workbench]) {
      expect(run.role).toBe("diagnostic");
      expect(run.submission.benchmark).toEqual(benchmark);
      expect(run.harbor_job_config).toMatchObject({
        datasets: canary.job.datasets,
        n_attempts: 3,
        n_concurrent_trials: 3,
        agent_timeout_multiplier: original.job.agent_timeout_multiplier,
        agent_setup_timeout_multiplier: original.job.agent_setup_timeout_multiplier,
        environment: { kwargs: original.job.environment.kwargs },
      });
      expect(run.harbor_job_config.agents).toHaveLength(1);
      expect(projection.run(run.run_id)?.status).toBe("queued");
    }
    expect(leaderboard(projection, presets)).toEqual([]);
  });

  it("uses Harbor's fixed OpenHands reasoning default", async () => {
    expect(presets.agent("openhands", "1.6.0").reasoning_values[0]).toBe("high");
    const result = await service.submitPreset(
      {
        ...input,
        model: { ...input.model, reasoning_effort: "high" },
        harness: { agent: "openhands", version: "1.6.0" },
      },
      "openhands-default-reasoning",
      "test-subject",
    );
    expect(result.run.harbor_job_config).toMatchObject({
      agents: [{ kwargs: { reasoning_effort: "high" } }],
    });
  });

  it("leaves mini-SWE-agent's provider reasoning default unset", async () => {
    const result = await service.submitPreset(
      {
        ...input,
        model: { ...input.model, reasoning_effort: "default" },
        harness: { agent: "mini-swe-agent", version: "2.4.6" },
      },
      "mini-swe-default-reasoning",
      "test-subject",
    );
    expect(result.run.harbor_job_config.agents[0]?.kwargs).not.toHaveProperty(
      "reasoning_effort",
    );
  });

  it("uses the requested Harbor trial concurrency", async () => {
    const result = await service.submitPreset(
      { ...input, n_concurrent_trials: 32 },
      "custom-concurrency",
      "test-subject",
    );
    expect(result.run.harbor_job_config.n_concurrent_trials).toBe(32);
  });

  it.each(["one-task-1-trial", "all-tasks-1-trial", "all-tasks-5-trials"])(
    "shares native defaults and overrides for preset and Workbench submissions: %s",
    async (preset) => {
      const submission = { ...input, benchmark: { ...input.benchmark, preset } };
      const fragment = compileAgentWorkbenchRecipe(
        fastAgentWorkbenchStarter,
      ).harbor_agent;
      const defaultRun = await service.submitWorkbench(
        submission,
        fragment,
        "default-concurrency",
        "test-subject",
      );
      const expected = preset === "one-task-1-trial" ? 1 : 8;
      expect(defaultRun.run.harbor_job_config.n_concurrent_trials).toBe(expected);
      for (const n_concurrent_trials of [8, 10, 12, 16, 64, 128]) {
        const override = { ...submission, n_concurrent_trials };
        const workbench = await service.submitWorkbench(
          override,
          fragment,
          `workbench-${n_concurrent_trials}`,
          "test-subject",
        );
        const normal = await service.submitPreset(
          override,
          `preset-${n_concurrent_trials}`,
          "test-subject",
        );
        expect(workbench.run.harbor_job_config.n_concurrent_trials).toBe(
          n_concurrent_trials,
        );
        expect(normal.run.harbor_job_config.n_concurrent_trials).toBe(
          n_concurrent_trials,
        );
        expect(workbench.run.harbor_job_config.n_attempts).toBe(
          defaultRun.run.harbor_job_config.n_attempts,
        );
        expect(workbench.run.submission).not.toHaveProperty("n_concurrent_trials");
      }
      await expect(
        service.submitWorkbench(
          { ...submission, n_concurrent_trials: 12 },
          fragment,
          "default-concurrency",
          "test-subject",
        ),
      ).rejects.toThrow("different run");
      expect(
        presets.benchmark(submission.benchmark.name, preset).job.n_concurrent_trials,
      ).toBe(expected);
    },
  );

  it("keeps the reviewed full-run CPU flavor in the Harbor job", async () => {
    const result = await service.submitPreset(
      {
        ...input,
        benchmark: { name: "terminal-bench-2-1", preset: "all-tasks-1-trial" },
      },
      "full-run",
      "test-subject",
    );
    expect(result.run.harbor_job_config).toMatchObject({
      n_attempts: 1,
      n_concurrent_trials: 8,
      environment: {
        kwargs: { flavor: "cpu-upgrade", job_timeout: "none" },
      },
    });
  });

  it("submits a Workbench recipe through the same one-Run Harbor contract", async () => {
    const preview = compileAgentWorkbenchRecipe(fastAgentWorkbenchStarter);
    const workbenchInput = {
      ...input,
      harness: { agent: "command-agent", version: preview.revision_id },
      role: "diagnostic" as const,
    };
    const result = await service.submitWorkbench(
      workbenchInput,
      preview.harbor_agent,
      "workbench-key",
      "test-subject",
    );
    expect(result.run.role).toBe("diagnostic");
    expect(result.run.harbor_job_config).toMatchObject({
      job_name: "job",
      jobs_dir: `/data/runs/${result.run.run_id}`,
      n_attempts: 1,
      n_concurrent_trials: 1,
      agents: [
        {
          import_path: "harbor_hf_agents.command_agent.agent:CommandAgent",
          model_name: "openai/openai/gpt-oss-20b:together",
          env: {
            OPENAI_BASE_URL: "https://router.huggingface.co/v1",
            OPENAI_API_KEY: "$" + "{HF_INFERENCE_TOKEN}",
          },
        },
      ],
    });
    const serialized = JSON.stringify(result.run);
    expect(serialized).not.toContain("harness_profile");
    expect(serialized).not.toContain("promotion");
    expect(serialized).not.toContain("preparation");
    expect(projection.run(result.run.run_id)?.status).toBe("queued");
    await expect(
      service.submitWorkbench(
        { ...workbenchInput, model: { ...input.model, reasoning_effort: "high" } },
        preview.harbor_agent,
        "bad-workbench-reasoning",
        "test-subject",
      ),
    ).rejects.toThrow("reasoning effort off only");
    await expect(
      service.submitWorkbench(
        workbenchInput,
        { ...preview.harbor_agent, import_path: "other.module:Agent" },
        "bad-workbench-agent",
        "test-subject",
      ),
    ).rejects.toThrow("reviewed command agent");
  });

  it.each(["hf.example-org/model:together", "another-harness/exact-model"])(
    "keeps recorded identity separate from native model_name %s",
    async (model_name) => {
      const preview = compileAgentWorkbenchRecipe(fastAgentWorkbenchStarter);
      const result = await service.submitWorkbench(
        input,
        { ...preview.harbor_agent, model_name },
        "explicit-model",
        "test-subject",
      );
      expect(result.run.submission.model).toEqual(input.model);
      expect(result.run.harbor_job_config.agents?.[0]?.model_name).toBe(model_name);
      expect(result.run.submission).not.toHaveProperty("harbor_agent");
      await expect(
        service.submitWorkbench(
          input,
          { ...preview.harbor_agent, model_name: "changed-model" },
          "explicit-model",
          "test-subject",
        ),
      ).rejects.toThrow("different run");
    },
  );

  it.each([
    "",
    "  ",
    "a\nb",
    "a\u0000b",
    "a\u007fb",
    "a".repeat(321),
    `hf_${"x".repeat(24)}`,
    "https://user:password@example.test/model",
    "$" + "{HF_TOKEN}",
  ])("rejects invalid or credential-bearing harness strings", async (model_name) => {
    const preview = compileAgentWorkbenchRecipe(fastAgentWorkbenchStarter);
    await expect(
      service.submitWorkbench(
        input,
        { ...preview.harbor_agent, model_name },
        "invalid-model",
        "test-subject",
      ),
    ).rejects.toThrow("Harness model string");
    expect(projection.listRuns()).toEqual([]);
  });

  it("snapshots Workbench display provenance as immutable without changing native config", async () => {
    const preview = compileAgentWorkbenchRecipe(fastAgentWorkbenchStarter);
    const launch = (name?: string) =>
      service.submitWorkbench(
        input,
        preview.harbor_agent,
        "recipe-provenance",
        "test-subject",
        name === undefined ? undefined : { workbench_recipe: { name } },
      );
    const first = await launch("recipe-one");
    expect(first.run.workbench_recipe).toEqual({ name: "recipe-one" });
    expect(await launch("recipe-one")).toEqual({ created: false, run: first.run });
    await expect(launch("recipe-two")).rejects.toThrow("different run");
    await expect(launch()).rejects.toThrow("different run");
    const historical = await service.submitWorkbench(
      input,
      preview.harbor_agent,
      "historical",
      "test-subject",
    );
    expect(historical.run).not.toHaveProperty("workbench_recipe");
    expect(first.run.harbor_job_config.agents).toEqual(
      historical.run.harbor_job_config.agents,
    );
    await service.refresh();
    expect(projection.run(first.run.run_id)?.record.workbench_recipe).toEqual({
      name: "recipe-one",
    });
    expect(jobs.starts).toBe(0);
  });

  it("adopts a repeated request and rejects different input", async () => {
    const first = await submit();
    const second = await submit();
    expect(second).toEqual({ created: false, run: first.run });
    await expect(
      service.submitPreset(
        { ...input, cost_ceiling_usd_per_trial: 0.5 },
        "test-key",
        "test-subject",
      ),
    ).rejects.toThrow("different run");
  });

  it("validates preset and direct submission boundaries", async () => {
    await expect(
      service.submitPreset(
        { ...input, model: { ...input.model, reasoning_effort: "extreme" } },
        "bad-reasoning",
        "test-subject",
      ),
    ).rejects.toThrow("reasoning effort");
    for (const [key, modelId] of [
      ["preset-credential-token", `hf_${"x".repeat(24)}`],
      ["preset-credential-url", "https://user:password@example.test/model"],
      ["preset-credential-query", "https://example.test/model?access_token=opaque"],
      ["preset-credential-fragment", "https://example.test/model#signature=opaque"],
    ] as const) {
      await expect(
        service.submitPreset(
          { ...input, model: { ...input.model, id: modelId } },
          key,
          "test-subject",
        ),
      ).rejects.toThrow("credential material");
    }
    await expect(
      service.submitConfig(
        { jobs_dir: "/tmp", agents: [{ name: "pi" }] },
        1,
        "bad-config",
        "test-subject",
      ),
    ).rejects.toThrow("jobs_dir");
    const directInput = {
      n_attempts: 1,
      n_concurrent_trials: 1,
      datasets: [
        {
          repo: "https://github.com/harbor-framework/terminal-bench-2-1.git@d49e28f1e4ddd13d289e85a5f312a66750951932",
          path: "tasks",
          task_names: ["adaptive-rejection-sampler"],
        },
      ],
      agents: [
        {
          name: "pi",
          model_name: "huggingface/openai/gpt-oss-20b:together",
          kwargs: { version: "0.84.2", max_tokens: 1_000 },
        },
      ],
      environment: { type: "hf-sandbox" },
    };
    await expect(
      service.submitConfig(
        {
          ...directInput,
          agents: [
            {
              ...directInput.agents[0],
              env: { HF_TOKEN: "$" + "{HF_TOKEN}" },
            },
          ],
        },
        0.25,
        "credential-template",
        "test-subject",
      ),
    ).rejects.toThrow("credential material");
    await expect(
      service.submitConfig(
        {
          ...directInput,
          agents: [
            {
              ...directInput.agents[0],
              env: { FOO: `hf_${"x".repeat(24)}` },
            },
          ],
        },
        0.25,
        "credential-literal",
        "test-subject",
      ),
    ).rejects.toThrow("credential material");
    await expect(
      service.submitConfig(
        {
          ...directInput,
          agents: [
            {
              ...directInput.agents[0],
              env: { CUSTOM_AUTH: "opaque-credential" },
            },
          ],
        },
        0.25,
        "opaque-agent-env",
        "test-subject",
      ),
    ).rejects.toThrow("Environment variable CUSTOM_AUTH is not admitted");
    for (const [key, repo] of [
      ["credential-url", "https://user:password@example.test/repository"],
      ["credential-query", "https://example.test/repository?token=opaque"],
    ] as const) {
      await expect(
        service.submitConfig(
          {
            ...directInput,
            datasets: [{ ...directInput.datasets[0], repo }],
          },
          0.25,
          key,
          "test-subject",
        ),
      ).rejects.toThrow("credential material");
    }
    await expect(
      service.submitConfig(
        { ...directInput, ignored_by_harbor: true },
        0.25,
        "unknown-field",
        "test-subject",
      ),
    ).rejects.toThrow("strict Harbor JobConfig");
    await expect(
      service.submitConfig(
        {
          ...directInput,
          agents: [{ ...directInput.agents[0], ignored_by_harbor: true }],
        },
        0.25,
        "unknown-agent-field",
        "test-subject",
      ),
    ).rejects.toThrow("strict Harbor JobConfig");
    await expect(
      service.submitConfig(
        {
          ...directInput,
          datasets: [{ path: "/data/local-tasks" }],
        },
        0.25,
        "local-dataset",
        "test-subject",
      ),
    ).rejects.toThrow("local dataset path");
    await expect(
      service.submitConfig(
        {
          ...directInput,
          datasets: [{ ...directInput.datasets[0], download_dir: "/data/cache" }],
        },
        0.25,
        "local-dataset-download",
        "test-subject",
      ),
    ).rejects.toThrow("dataset download path");
    await expect(
      service.submitConfig(
        {
          ...directInput,
          datasets: [{ ...directInput.datasets[0], registry_path: "/data/registry" }],
        },
        0.25,
        "local-dataset-registry",
        "test-subject",
      ),
    ).rejects.toThrow("dataset registry path");
    await expect(
      service.submitConfig(
        {
          ...directInput,
          extra_instruction_paths: ["/proc/self/environ"],
        },
        0.25,
        "local-instruction",
        "test-subject",
      ),
    ).rejects.toThrow("extra_instruction_paths");
    for (const [field, value] of [
      ["skills", ["/proc/self"]],
      ["load_trajectory", "/proc/self/environ"],
    ] as const) {
      await expect(
        service.submitConfig(
          {
            ...directInput,
            agents: [{ ...directInput.agents[0], [field]: value }],
          },
          0.25,
          `local-agent-${field}`,
          "test-subject",
        ),
      ).rejects.toThrow(field);
    }
    const direct = await service.submitConfig(
      directInput,
      0.25,
      "direct",
      "test-subject",
    );
    expect(direct.run.role).toBe("diagnostic");
    expect(direct.run.submission.model).toEqual({
      id: "openai/gpt-oss-20b",
      provider: "together",
      reasoning_effort: "default",
    });
    expect(direct.run.harbor_job_config).toMatchObject({
      agents: [
        {
          model_name: "huggingface/openai/gpt-oss-20b:together",
          env: { HF_TOKEN: "$" + "{HF_INFERENCE_TOKEN}" },
          kwargs: { version: "0.84.2", max_tokens: 1_000 },
        },
      ],
      environment: {
        import_path: "harbor_hf_agents.hf_sandbox:LabeledHFSandboxEnvironment",
      },
    });
  });
});

describe("status and projection", () => {
  it("reads cached timing in one query and scopes detail to its indexed run", async () => {
    const first = await submit("bounded-first");
    const second = await submit("bounded-second");
    await putJson(
      store,
      `runs/${second.run.run_id}/job/task/result.json`,
      trial(0.01, 1),
    );
    await service.refresh();
    const db = new Database(join(root, "projection.sqlite"));
    // If reads ever parse native trial JSON again, even listRuns will fail.
    db.prepare("UPDATE trials SET result_body = 'not-json'").run();
    const prepare = vi.spyOn(Database.prototype, "prepare");
    try {
      expect(projection.listRuns()).toHaveLength(2);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(prepare.mock.calls[0]?.[0]).not.toContain("FROM trials");
      prepare.mockClear();
      db.prepare("UPDATE runs SET record_body = 'not-json' WHERE run_id = ?").run(
        second.run.run_id,
      );
      prepare.mockClear();
      expect(projection.run(first.run.run_id)?.record.run_id).toBe(first.run.run_id);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(prepare.mock.calls[0]?.[0]).toContain("WHERE run_id = ?");
      expect(projection.run("missing")).toBeNull();
    } finally {
      prepare.mockRestore();
      db.close();
    }
  });

  it("rolls up only current rows across rebuild/resume and excludes archived retries", async () => {
    const { run } = await submit("measured-agent-time");
    const second = await submit("measured-agent-time-second");
    const path = `runs/${run.run_id}/job/task/result.json`;
    const phase = {
      started_at: "2026-09-09T00:00:00Z",
      finished_at: "2026-09-09T00:01:26Z",
    };
    const native = { ...trial(0.01, 1), agent_execution: phase };
    const job = { finished_at: "2026-09-09T00:02:00Z", n_total_trials: 1 };
    await putJson(store, `runs/${run.run_id}/job/result.json`, job);
    await putJson(store, path, native);
    await putJson(store, `runs/${run.run_id}/job/retries/old/result.json`, native);
    await service.refresh();
    for (let i = 0; i < 2; i++) {
      await service.refresh();
      expect(projection.run(run.run_id)?.agent_timing).toEqual({
        duration_ms: 86000,
        complete_trials: 1,
        partial_trials: 0,
        unavailable_trials: 0,
      });
    }
    const reopened = await Projection.open(join(root, "projection.sqlite"));
    expect(reopened.run(run.run_id)?.agent_timing?.duration_ms).toBe(86000);
    reopened.close();
    // A duplicate native name fails inside the transaction, after DELETEs.
    // Both rows and cached measurements must roll back together.
    const duplicate = `runs/${run.run_id}/job/duplicate/result.json`;
    await putJson(store, duplicate, native);
    await expect(projection.rebuild(store, [])).rejects.toThrow("UNIQUE constraint");
    expect(projection.run(run.run_id)?.agent_timing?.duration_ms).toBe(86000);
    expect(projection.trials(run.run_id)).toHaveLength(1);
    await rm(join(store.root, duplicate));
    expect(projection.run(run.run_id)?.result).toEqual(job);
    expect(projection.run(second.run.run_id)?.agent_timing?.duration_ms).toBeNull();
    await putJson(store, path, {
      ...native,
      agent_execution: { started_at: phase.started_at, finished_at: phase.started_at },
    });
    await service.refresh();
    expect(projection.run(run.run_id)?.agent_timing?.duration_ms).toBe(0);
    await rm(join(store.root, path));
    await service.refresh();
    expect(projection.run(run.run_id)?.agent_timing).toEqual({
      duration_ms: null,
      complete_trials: 0,
      partial_trials: 0,
      unavailable_trials: 0,
    });
    await rm(join(store.root, `runs/${run.run_id}/run.json`));
    await service.refresh();
    expect(projection.run(run.run_id)).toBeNull();
    expect(projection.listRuns().map((view) => view.record.run_id)).toEqual([
      second.run.run_id,
    ]);
  });
  it("applies the status precedence", () => {
    const record = {
      schema_version: "v1",
      run_id: "run-0123456789abcdef01234567",
      created_at: "2026-09-04T00:00:00Z",
      submitted_by: "test",
      role: "final",
      harbor_revision: "d".repeat(40),
      submission: input,
      harbor_job_config: {},
    } satisfies RunRecordV1;
    const state = {
      schema_version: "v1",
      run_id: record.run_id,
      revision: 0,
      updated_at: record.created_at,
      desired_state: "run",
      actor: "test",
      parent_jobs: [],
    } satisfies RunStateV1;
    const summary = summarizeTrial(record.run_id, "task", trial(0.5));
    const cheap = summarizeTrial(record.run_id, "task", trial(0.2));
    expect(costLimitReached(record, { n_total_trials: 1 }, [summary])).toBe(true);
    expect(costLimitReached(record, { n_total_trials: 1 }, [cheap], [0.2])).toBe(false);
    expect(costLimitReached(record, { n_total_trials: 1 }, [cheap], [0.2, 0.2])).toBe(
      true,
    );
    expect(costLimitReached(record, { n_total_trials: 1 }, [cheap], [null])).toBe(
      false,
    );
    expect(costLimitReached(record, { n_total_trials: 1 }, [cheap], [null, 0.01])).toBe(
      true,
    );
    expect(statusFor(record, state, null, [], [])).toBe("queued");
    expect(
      statusFor(
        record,
        state,
        null,
        [],
        [
          {
            id: "parent",
            run_id: record.run_id,
            role: "parent",
            stage: "running",
            created_at: record.created_at,
            started_at: record.created_at,
            finished_at: null,
          },
        ],
      ),
    ).toBe("running");
    expect(statusFor(record, state, { n_total_trials: 1 }, [summary], [])).toBe(
      "cost_stopped",
    );
    expect(
      statusFor(
        record,
        state,
        { finished_at: record.created_at, n_total_trials: 1 },
        [summary],
        [],
      ),
    ).toBe("cost_stopped");
    expect(statusFor(record, state, { finished_at: record.created_at }, [], [])).toBe(
      "finished",
    );
    expect(
      statusFor(
        record,
        state,
        { finished_at: record.created_at, n_total_trials: 1 },
        [cheap],
        [],
        [null],
      ),
    ).toBe("finished");
    expect(
      statusFor(
        record,
        { ...state, desired_state: "paused" },
        { finished_at: record.created_at },
        [],
        [],
      ),
    ).toBe("paused");
  });

  it("rebuilds all three tables and filters the leaderboard", async () => {
    const { run } = await submit("leaderboard");
    await putJson(store, `runs/${run.run_id}/job/result.json`, {
      finished_at: "2026-09-04T00:10:00Z",
      n_total_trials: 1,
    });
    await putJson(store, `runs/${run.run_id}/job/task/result.json`, trial(0.02, 1));
    const stored = (await import("@harbor-hf/contracts")).validateRunRecord(
      await (await import("../src/store.js")).readJson(
        store,
        runRecordPath(run.run_id),
      ),
    );
    stored.submission.benchmark.preset = "all-tasks-5-trials";
    stored.harbor_job_config.n_attempts = 5;
    await rm(join(store.root, runRecordPath(run.run_id)));
    await createJson(store, runRecordPath(run.run_id), stored);
    await service.refresh();
    expect(projection.system()).toEqual({ runs: 1, trials: 1, parent_jobs: 0 });
    expect(leaderboard(projection, presets)).toEqual([
      expect.objectContaining({ n_attempts: 5, n_trials: 1, pass_rate: 1 }),
    ]);
  });

  it("projects native trial identity without full agent inputs or result bodies", async () => {
    const { run } = await submit("trial-list-identity");
    const native = {
      ...trial(0.1, 1),
      config: {
        agent: {
          name: "openclaw",
          import_path: null,
          model_name: "openai/example/model:provider",
          kwargs: { instructions: "large input".repeat(10_000) },
        },
      },
      agent_info: { name: "openclaw", version: "2026.7.1-2" },
      agent_result: {
        cost_usd: 0.1,
        metadata: { output: "large output".repeat(10_000) },
      },
    };
    await putJson(store, `runs/${run.run_id}/job/task/result.json`, native);
    await service.refresh();
    const summary = projection.trials(run.run_id, "identity");
    expect(summary[0]?.result).toEqual({
      config: {
        agent: {
          name: "openclaw",
          import_path: null,
          model_name: "openai/example/model:provider",
        },
      },
      agent_info: { version: "2026.7.1-2" },
    });
    expect(JSON.stringify(summary).length).toBeLessThan(1000);
    expect(projection.trials(run.run_id)[0]?.result).toEqual(native);
  });

  it("retains failed retry cost in the rebuilt projection", async () => {
    const { run } = await submit("retry-cost");
    const previousId = "22222222-2222-4222-8222-222222222222";
    const currentId = "33333333-3333-4333-8333-333333333333";
    await putJson(store, `runs/${run.run_id}/job/result.json`, {
      finished_at: "2026-09-04T00:10:00Z",
      n_total_trials: 1,
    });
    await putJson(
      store,
      `runs/${run.run_id}/job/task/result.json`,
      trial(0.2, 1, currentId),
    );
    await putJson(store, `runs/${run.run_id}/attempt-costs/${previousId}.json`, {
      schema_version: "v1",
      attempt_id: previousId,
      trial_name: "task__trial",
      cost_usd: 0.2,
    });

    await service.refresh();

    expect(projection.run(run.run_id)?.status).toBe("cost_stopped");
  });

  it("keeps a finalized over-limit run cost-stopped after rebuild", async () => {
    const { run } = await submit("final-cost-stop");
    const attemptId = "66666666-6666-4666-8666-666666666666";
    const finishedAt = "2026-09-04T00:10:00Z";
    await putJson(store, `runs/${run.run_id}/job/result.json`, {
      finished_at: finishedAt,
      n_total_trials: 1,
    });
    await putJson(
      store,
      `runs/${run.run_id}/job/task/result.json`,
      trial(0.5, 1, attemptId),
    );
    await putJson(store, `runs/${run.run_id}/attempt-costs/${attemptId}.json`, {
      schema_version: "v1",
      attempt_id: attemptId,
      trial_name: "task__trial",
      cost_usd: 0.5,
    });

    await service.refresh();

    expect(projection.run(run.run_id)).toMatchObject({
      status: "cost_stopped",
      result: { finished_at: finishedAt },
    });
    expect(projection.trials(run.run_id)).toMatchObject([
      {
        trial_name: "task__trial",
        reward: 1,
        cost_usd: 0.5,
        status: "completed",
      },
    ]);
  });

  it("accepts a zero receipt when agent execution did not start", async () => {
    const { run } = await submit("pre-agent-zero");
    const attemptId = "44444444-4444-4444-8444-444444444444";
    await putJson(store, `runs/${run.run_id}/job/result.json`, {
      finished_at: "2026-09-04T00:10:00Z",
      n_total_trials: 1,
    });
    await putJson(store, `runs/${run.run_id}/job/task/result.json`, {
      id: attemptId,
      trial_name: "task__trial",
      agent_result: null,
      agent_execution: null,
      step_results: null,
      exception_info: { exception_type: "RuntimeError" },
    });
    await putJson(store, `runs/${run.run_id}/attempt-costs/${attemptId}.json`, {
      schema_version: "v1",
      attempt_id: attemptId,
      trial_name: "task__trial",
      cost_usd: 0,
    });

    await service.refresh();

    expect(projection.run(run.run_id)?.status).toBe("finished");
    expect(projection.trials(run.run_id)).toMatchObject([
      { cost_usd: null, status: "error" },
    ]);
  });

  it("rejects a zero receipt when agent execution started without cost", async () => {
    const { run } = await submit("post-agent-zero");
    const attemptId = "44444444-4444-4444-8444-444444444444";
    await putJson(store, `runs/${run.run_id}/job/result.json`, {
      n_total_trials: 1,
    });
    await putJson(store, `runs/${run.run_id}/job/task/result.json`, {
      id: attemptId,
      trial_name: "task__trial",
      agent_result: {},
      agent_execution: null,
      step_results: null,
      exception_info: { exception_type: "RuntimeError" },
    });
    await putJson(store, `runs/${run.run_id}/attempt-costs/${attemptId}.json`, {
      schema_version: "v1",
      attempt_id: attemptId,
      trial_name: "task__trial",
      cost_usd: 0,
    });

    await expect(service.refresh()).rejects.toThrow(
      "attempt cost receipt conflicts with Harbor result",
    );
  });

  it("rejects a cost receipt that conflicts with a Harbor result", async () => {
    const { run } = await submit("cost-conflict");
    const attemptId = "44444444-4444-4444-8444-444444444444";
    await putJson(store, `runs/${run.run_id}/job/result.json`, {
      n_total_trials: 1,
    });
    await putJson(
      store,
      `runs/${run.run_id}/job/task/result.json`,
      trial(0.2, 1, attemptId),
    );
    await putJson(store, `runs/${run.run_id}/attempt-costs/${attemptId}.json`, {
      schema_version: "v1",
      attempt_id: attemptId,
      trial_name: "task__trial",
      cost_usd: 0.1,
    });

    await expect(service.refresh()).rejects.toThrow(
      "attempt cost receipt conflicts with Harbor result",
    );
  });
});

describe("reconciliation", () => {
  it("starts one parent, adopts it, and respects capacity", async () => {
    const first = await submit("first");
    await submit("second");
    await service.reconcile();
    expect(jobs.starts).toBe(1);
    expect(projection.run(first.run.run_id)?.state.parent_jobs).toHaveLength(1);
    await service.reconcile();
    expect(jobs.starts).toBe(1);
  });

  it("keeps a just-started parent in capacity during listing lag", async () => {
    await submit("lag-first");
    await submit("lag-second");
    const originalList = jobs.list.bind(jobs);
    jobs.list = async () => (jobs.starts === 0 ? originalList() : []);

    await service.reconcile();

    expect(jobs.starts).toBe(1);
  });

  it("cancels the parent and child on pause, then resumes Harbor", async () => {
    const { run } = await submit("pause");
    await service.reconcile();
    jobs.values.push({
      id: "child",
      run_id: run.run_id,
      role: "trial",
      stage: "running",
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      finished_at: null,
    });
    await service.setDesiredState(run.run_id, "paused", "test-subject");
    expect(jobs.cancelled).toEqual(["parent-1"]);
    expect(jobs.values.find((job) => job.id === "child")?.stage).toBe("running");
    await service.reconcile();
    expect(jobs.cancelled).toEqual(["parent-1", "child"]);
    expect(projection.run(run.run_id)?.status).toBe("paused");
    await service.setDesiredState(run.run_id, "run", "test-subject");
    await service.reconcile();
    expect(jobs.starts).toBe(2);
  });

  it("keeps cancellation permanent when a parent start is in flight", async () => {
    const { run } = await submit("cancel-race");
    const originalStart = jobs.startParent.bind(jobs);
    let releaseStart = (): void => undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let reportStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    jobs.startParent = async (runIdValue: string) => {
      reportStarted();
      await startGate;
      return originalStart(runIdValue);
    };

    const reconciliation = service.reconcile();
    await started;
    const cancellation = service.setDesiredState(
      run.run_id,
      "cancelled",
      "test-subject",
    );
    releaseStart();
    await reconciliation;
    const state = await cancellation;

    expect(state.desired_state).toBe("cancelled");
    expect(state.parent_jobs).toHaveLength(1);
    expect(jobs.cancelled).toContain("parent-1");
    await service.reconcile();
    expect(jobs.starts).toBe(1);
    expect(projection.run(run.run_id)?.status).toBe("cancelled");
  });

  it("cleans an orphan before it starts a replacement parent", async () => {
    const { run } = await submit("orphan");
    jobs.values.push({
      id: "orphan",
      run_id: run.run_id,
      role: "trial",
      stage: "running",
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      finished_at: null,
    });
    await service.reconcile();
    expect(jobs.cancelled).toContain("orphan");
    expect(jobs.starts).toBe(1);
  });

  it("does not restart a cost-stopped run", async () => {
    const { run } = await submit("cost");
    await putJson(store, `runs/${run.run_id}/job/result.json`, { n_total_trials: 1 });
    await putJson(store, `runs/${run.run_id}/job/task/result.json`, trial(0.5));
    await service.reconcile();
    expect(jobs.starts).toBe(0);
    expect(projection.run(run.run_id)?.status).toBe("cost_stopped");
    expect(
      await (await import("../src/store.js")).readJson(store, runStatePath(run.run_id)),
    ).toMatchObject({
      desired_state: "run",
    });
  });

  it("keeps a completed cost-stopped parent alive until Harbor finalizes", async () => {
    const { run } = await submit("finalizing-cost");
    await service.reconcile();
    const result = {
      finished_at: null,
      n_total_trials: 1,
      stats: {
        n_completed_trials: 1,
        n_running_trials: 0,
        n_pending_trials: 0,
      },
    };
    await putJson(store, `runs/${run.run_id}/job/result.json`, result);
    await putJson(store, `runs/${run.run_id}/job/task/result.json`, trial(0.5));

    await service.reconcile();

    expect(projection.run(run.run_id)?.status).toBe("cost_stopped");
    expect(jobs.cancelled).not.toContain("parent-1");
    expect(jobs.starts).toBe(1);

    await putJson(store, `runs/${run.run_id}/job/result.json`, {
      ...result,
      finished_at: "2026-09-07T12:00:00Z",
    });
    await service.reconcile();

    expect(jobs.cancelled).toContain("parent-1");
    expect(jobs.starts).toBe(1);
  });

  it("cancels a cost-stopped parent when native progress is incomplete", async () => {
    const { run } = await submit("incomplete-cost");
    await service.reconcile();
    await putJson(store, `runs/${run.run_id}/job/result.json`, {
      finished_at: null,
      n_total_trials: 1,
      stats: {
        n_completed_trials: 0,
        n_running_trials: 0,
        n_pending_trials: 1,
      },
    });
    await putJson(store, `runs/${run.run_id}/job/task/result.json`, trial(0.5));

    await service.reconcile();

    expect(jobs.cancelled).toContain("parent-1");
    expect(jobs.starts).toBe(1);
  });

  it("cancels a complete cost-stopped parent when retries are enabled", async () => {
    const { run } = await submit("retry-cost");
    await putJson(store, runRecordPath(run.run_id), {
      ...run,
      harbor_job_config: {
        ...run.harbor_job_config,
        retry: { max_retries: 1 },
      },
    });
    await service.reconcile();
    await putJson(store, `runs/${run.run_id}/job/result.json`, {
      finished_at: null,
      n_total_trials: 1,
      stats: {
        n_completed_trials: 1,
        n_running_trials: 0,
        n_pending_trials: 0,
      },
    });
    await putJson(store, `runs/${run.run_id}/job/task/result.json`, trial(0.5));

    await service.reconcile();

    expect(jobs.cancelled).toContain("parent-1");
    expect(jobs.starts).toBe(1);
  });

  it("restarts a run after a null-cost attempt", async () => {
    const { run } = await submit("unknown-cost");
    const attemptId = "44444444-4444-4444-8444-444444444444";
    await putJson(store, `runs/${run.run_id}/job/result.json`, { n_total_trials: 2 });
    await putJson(store, `runs/${run.run_id}/attempt-costs/${attemptId}.json`, {
      schema_version: "v1",
      attempt_id: attemptId,
      trial_name: "task__trial",
      cost_usd: null,
    });

    await service.reconcile();

    expect(jobs.starts).toBe(1);
    expect(projection.run(run.run_id)?.status).toBe("running");
  });

  it("rechecks cost receipts after it acquires the run lock", async () => {
    const { run } = await submit("fresh-cost");
    const attemptId = "55555555-5555-4555-8555-555555555555";
    const originalList = store.list.bind(store);
    let runListings = 0;
    store.list = async (prefix) => {
      if (prefix === "runs" && ++runListings === 2)
        await putJson(store, `runs/${run.run_id}/attempt-costs/${attemptId}.json`, {
          schema_version: "v1",
          attempt_id: attemptId,
          trial_name: "task__trial",
          cost_usd: 0.5,
        });
      return originalList(prefix);
    };

    await service.reconcile();

    expect(runListings).toBeGreaterThanOrEqual(2);
    expect(jobs.starts).toBe(0);
    expect(projection.run(run.run_id)?.status).toBe("cost_stopped");
  });
});

it("retains parent and child observations separately from completion and the parent Jobs view", async () => {
  const observed: JobObservation = {
    id: "child-test",
    run_id: `run-${"a".repeat(24)}`,
    role: "trial",
    stage: "queued",
    created_at: "2026-09-08T12:00:00Z",
    started_at: null,
    finished_at: null,
  };
  expect(projection.jobObservations().jobs).toEqual([]);
  await projection.rebuild(store, [observed]);
  expect(projection.jobObservations().jobs).toEqual([observed]);
  expect(projection.jobObservations().observed_at).not.toBeNull();
  expect(projection.jobs()).toEqual([]);
  expect(projection.system().trials).toBe(0);
  await projection.rebuild(store, []);
  expect(projection.jobObservations().jobs).toEqual([]);
});

describe("shared run presentation", () => {
  it("defaults without fabricated audit fields, persists and restores across independent projections", async () => {
    const { run } = await submit();
    const id = run.run_id;
    expect(projection.run(id)?.presentation).toBeNull();
    const before = await store.list("runs");
    const state = projection.run(id)?.state;
    const board = leaderboard(projection, presets);
    const puts = vi.spyOn(store, "put");
    expect(await service.setPresentation(id, false, 0, "fixture-subject")).toBeNull();
    expect(puts).not.toHaveBeenCalled();
    const first = await service.setPresentation(id, true, 0, "fixture-subject");
    expect(first).toMatchObject({
      archived: true,
      revision: 1,
      actor: "fixture-subject",
    });
    expect(await service.setPresentation(id, true, 1, "another-fixture")).toEqual(
      first,
    );
    expect(puts).toHaveBeenCalledTimes(1);
    await expect(
      service.setPresentation(id, true, 0, "fixture-subject"),
    ).rejects.toThrow("revision changed");
    const other = await Projection.open(join(root, "other.sqlite"));
    try {
      const second = new ControlService(store, other, presets, jobs, service.options);
      await second.initialize();
      expect(other.run(id)?.presentation).toEqual(first);
      await second.setPresentation(id, false, 1, "another-fixture");
      await service.refresh();
      expect(projection.run(id)?.presentation).toMatchObject({
        archived: false,
        revision: 2,
      });
      expect(projection.run(id)?.state).toEqual(state);
      expect(leaderboard(projection, presets)).toEqual(board);
      expect(jobs.starts).toBe(0);
      expect(jobs.cancelled).toEqual([]);
      const after = await store.list("runs");
      expect(after.filter((item) => !item.key.endsWith("presentation.json"))).toEqual(
        before,
      );
      const reads = vi.spyOn(store, "read");
      const lists = vi.spyOn(store, "list");
      reads.mockClear();
      lists.mockClear();
      expect(projection.listRuns()).toHaveLength(1);
      expect(projection.run(id)?.presentation?.revision).toBe(2);
      expect(reads).not.toHaveBeenCalled();
      expect(lists).not.toHaveBeenCalled();
    } finally {
      other.close();
    }
  });

  it("serializes concurrent expected revisions; stale intent cannot resurrect a restore", async () => {
    const { run } = await submit();
    const results = await Promise.allSettled([
      service.setPresentation(run.run_id, true, 0, "fixture-subject"),
      service.setPresentation(run.run_id, true, 0, "fixture-subject"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await service.setPresentation(run.run_id, false, 1, "fixture-subject");
    await expect(
      service.setPresentation(run.run_id, true, 0, "fixture-subject"),
    ).rejects.toThrow("revision changed");
    expect(projection.run(run.run_id)?.presentation?.archived).toBe(false);
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    "an older in-flight rebuild cannot clobber a newer revision (existing=%s, invalid=%s)",
    async (existing, invalid) => {
      const { run } = await submit();
      if (existing)
        await service.setPresentation(run.run_id, true, 0, "fixture-subject");
      let release = () => {};
      let ready = () => {};
      const reached = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Pause after the archive snapshot was taken, before the transaction commits.
      await putJson(store, `runs/${run.run_id}/job/result.json`, { n_total_trials: 1 });
      const read = store.read.bind(store);
      let blocked = false;
      vi.spyOn(store, "read").mockImplementation(async (key) => {
        const bytes = await read(key);
        if (!blocked && key.endsWith("job/result.json")) {
          blocked = true;
          ready();
          await gate;
        }
        return bytes;
      });
      if (invalid) await putJson(store, `runs/${run.run_id}/presentation.json`, {});
      const rebuild = service.refresh();
      await reached;
      if (invalid) {
        const last = projection.run(run.run_id)?.presentation;
        if (last) await putJson(store, `runs/${run.run_id}/presentation.json`, last);
        else await rm(join(store.root, `runs/${run.run_id}/presentation.json`));
      }
      const next = await service.setPresentation(
        run.run_id,
        !existing,
        existing ? 1 : 0,
        "fixture-subject",
      );
      release();
      await rebuild;
      expect(projection.run(run.run_id)?.presentation).toEqual(next);
      expect(projection.run(run.run_id)?.presentation_available).toBe(true);
    },
  );

  it.each(
    [false, true].flatMap((existing) =>
      [false, true].flatMap((available) =>
        ["direct", "rebuild"].map((writer) => ({ existing, available, writer })),
      ),
    ),
  )(
    "orders equal-revision/null availability: existing=$existing available=$available writer=$writer",
    async ({ existing, available, writer }) => {
      const { run } = await submit();
      const id = run.run_id;
      if (existing) await service.setPresentation(id, true, 0, "fixture-subject");
      const presentation = projection.run(id)?.presentation ?? null;
      const key = `runs/${id}/presentation.json`;
      const restore = async () => {
        if (presentation) await putJson(store, key, presentation);
        else await rm(join(store.root, key), { force: true });
      };
      if (available) {
        await putJson(store, key, {});
        projection.markPresentationUnavailable(id);
      }
      await putJson(store, `runs/${id}/job/result.json`, { n_total_trials: 1 });
      let release = () => {};
      let ready = () => {};
      const reached = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const read = store.read.bind(store);
      let blocked = false;
      vi.spyOn(store, "read").mockImplementation(async (path) => {
        const bytes = await read(path);
        if (!blocked && path.endsWith("job/result.json")) {
          blocked = true;
          ready();
          await gate;
        }
        return bytes;
      });
      const older = projection.rebuild(store, []);
      await reached;
      if (available) await restore();
      else await putJson(store, key, {});
      const put = vi.spyOn(store, "put");
      if (writer === "rebuild") await projection.rebuild(store, []);
      else if (available)
        await service.setPresentation(
          id,
          existing,
          existing ? 1 : 0,
          "fixture-subject",
        );
      else
        await expect(
          service.setPresentation(id, !existing, existing ? 1 : 0, "fixture-subject"),
        ).rejects.toThrow("refetch");
      expect(put).not.toHaveBeenCalled();
      expect(projection.run(id)).toMatchObject({
        presentation,
        presentation_available: available,
      });
      release();
      await older;
      expect(projection.run(id)).toMatchObject({
        presentation,
        presentation_available: available,
      });
      // A subsequent validated rebuild must recover without a revision increase.
      await restore();
      await projection.rebuild(store, []);
      expect(projection.run(id)).toMatchObject({
        presentation,
        presentation_available: true,
      });
    },
  );

  it.each([null, {}, { schema_version: "v1", archived: false }])(
    "rejects malformed authoritative metadata without unarchiving: %j",
    async (invalid) => {
      const { run } = await submit();
      await service.setPresentation(run.run_id, true, 0, "fixture-subject");
      await putJson(store, `runs/${run.run_id}/presentation.json`, invalid);
      await expect(service.refresh()).resolves.toBeUndefined();
      expect(projection.run(run.run_id)?.presentation_available).toBe(false);
      expect(projection.run(run.run_id)?.presentation?.archived).toBe(true);
      await expect(
        service.setPresentation(run.run_id, false, 1, "fixture-subject"),
      ).rejects.toThrow("refetch");
    },
  );

  it("reports a persisted write with a failed projection honestly and requires a fresh revision", async () => {
    const { run } = await submit();
    vi.spyOn(projection, "updatePresentation").mockImplementationOnce(() => {
      throw new Error("fixture failure");
    });
    await expect(
      service.setPresentation(run.run_id, true, 0, "fixture-subject"),
    ).rejects.toThrow("refetch");
    expect(projection.run(run.run_id)?.presentation).toBeNull();
    expect(projection.run(run.run_id)?.presentation_available).toBe(false);
    await expect(
      service.setPresentation(run.run_id, true, 0, "fixture-subject"),
    ).rejects.toThrow("revision changed");
    expect(projection.run(run.run_id)?.presentation?.revision).toBe(1);
    expect(projection.run(run.run_id)?.presentation_available).toBe(true);
    await service.setPresentation(run.run_id, false, 1, "fixture-subject");
    expect(projection.run(run.run_id)?.presentation?.revision).toBe(2);
  });

  it.each(["parse", "schema", "identity", "read"])(
    "isolates %s presentation failures from all cancellation and orphan safety",
    async (failure) => {
      const bad = (await submit("bad-display")).run;
      const cancelled = (await submit("cancel-valid")).run;
      const orphan = (await submit("orphan-valid")).run;
      const state = projection.run(cancelled.run_id)?.state;
      await putJson(store, runStatePath(cancelled.run_id), {
        ...state,
        desired_state: "cancelled",
      });
      await putJson(store, `runs/${bad.run_id}/job/task__trial/result.json`, trial());
      await service.refresh();
      const costs = projection.trials(bad.run_id);
      const path = `runs/${bad.run_id}/presentation.json`;
      if (failure === "parse") await store.put(path, new TextEncoder().encode("{"));
      else if (failure === "identity")
        await putJson(store, path, {
          schema_version: "v1",
          run_id: orphan.run_id,
          archived: true,
          revision: 1,
          updated_at: "2026-01-01T00:00:00Z",
          actor: "fixture-subject",
        });
      else await putJson(store, path, {});
      if (failure === "read") {
        const read = store.read.bind(store);
        vi.spyOn(store, "read").mockImplementation(async (key) => {
          if (key === path) throw new Error("fixture read unavailable");
          return read(key);
        });
      }
      const job = {
        stage: "running",
        created_at: "2026-01-01T00:00:00Z",
        started_at: "2026-01-01T00:00:00Z",
        finished_at: null,
      } as const;
      jobs.values.push(
        { ...job, id: "cancel-parent", run_id: cancelled.run_id, role: "parent" },
        { ...job, id: "orphan-trial", run_id: orphan.run_id, role: "trial" },
      );
      await expect(service.reconcile()).resolves.toBeUndefined();
      expect(jobs.cancelled).toEqual(
        expect.arrayContaining(["cancel-parent", "orphan-trial"]),
      );
      expect(projection.listRuns()).toHaveLength(3);
      expect(projection.run(bad.run_id)).toMatchObject({
        presentation: null,
        presentation_available: false,
      });
      expect(projection.run(cancelled.run_id)?.presentation_available).toBe(true);
      expect(projection.trials(bad.run_id)).toEqual(costs);
      const put = vi.spyOn(store, "put");
      await expect(
        service.setPresentation(bad.run_id, true, 0, "fixture-subject"),
      ).rejects.toThrow("refetch");
      expect(put).not.toHaveBeenCalled();
    },
  );

  it("keeps a failed conflict synchronization unavailable until a validated resync", async () => {
    const { run } = await submit();
    const update = vi.spyOn(projection, "updatePresentation").mockImplementation(() => {
      throw new Error("fixture projection failure");
    });
    await expect(
      service.setPresentation(run.run_id, true, 0, "fixture-subject"),
    ).rejects.toThrow("refetch");
    await expect(
      service.setPresentation(run.run_id, true, 0, "fixture-subject"),
    ).rejects.toThrow("refetch");
    expect(projection.run(run.run_id)).toMatchObject({
      presentation: null,
      presentation_available: false,
    });
    update.mockRestore();
    await expect(
      service.setPresentation(run.run_id, true, 0, "fixture-subject"),
    ).rejects.toThrow("revision changed");
    expect(projection.run(run.run_id)).toMatchObject({
      presentation: { revision: 1 },
      presentation_available: true,
    });
    // A delayed updater must not clear a later restore or its availability.
    const archived = projection.run(run.run_id)?.presentation ?? null;
    await service.setPresentation(run.run_id, false, 1, "fixture-subject");
    projection.updatePresentation(run.run_id, archived);
    expect(projection.run(run.run_id)).toMatchObject({
      presentation: { revision: 2, archived: false },
      presentation_available: true,
    });
  });

  it("adds nullable metadata to old SQLite without inventing audit history", async () => {
    const path = join(root, "old-archive.sqlite");
    const db = new Database(path);
    db.exec(
      "CREATE TABLE runs (run_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, record_body TEXT NOT NULL, state_body TEXT NOT NULL, status TEXT NOT NULL, result_body TEXT)",
    );
    const { run } = await submit();
    const view = projection.run(run.run_id);
    db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)").run(
      run.run_id,
      run.created_at,
      JSON.stringify(run),
      JSON.stringify(view?.state),
      "queued",
      null,
    );
    db.close();
    const old = await Projection.open(path);
    try {
      expect(old.run(run.run_id)?.presentation).toBeNull();
      await old.rebuild(store, []);
      expect(old.run(run.run_id)?.presentation).toBeNull();
    } finally {
      old.close();
    }
  });
});

it("archiving retains eligible leaderboard rewards, costs and native artifacts", async () => {
  const { run } = await service.submitPreset(
    {
      ...input,
      role: "final",
      benchmark: { ...input.benchmark, preset: "all-tasks-5-trials" },
    },
    "archive-final",
    "fixture-subject",
  );
  await putJson(store, `runs/${run.run_id}/job/result.json`, {
    finished_at: "2026-01-01T01:00:00Z",
    n_total_trials: 1,
  });
  await putJson(store, `runs/${run.run_id}/job/task__trial/result.json`, trial());
  await service.refresh();
  const before = projection.run(run.run_id);
  const board = leaderboard(projection, presets);
  expect(board).toHaveLength(1);
  const artifacts = await store.list("runs");
  await service.setPresentation(run.run_id, true, 0, "fixture-subject");
  expect(projection.listRuns()).toHaveLength(1);
  expect(leaderboard(projection, presets)).toEqual(board);
  expect(projection.run(run.run_id)).toEqual({
    ...before,
    presentation: expect.objectContaining({ archived: true }),
  });
  expect(
    (await store.list("runs")).filter(
      (item) => !item.key.endsWith("presentation.json"),
    ),
  ).toEqual(artifacts);
  expect(jobs.starts).toBe(0);
  expect(jobs.cancelled).toEqual([]);
});

describe("immutable launch pricing and shared SQL estimates", () => {
  const pricing = {
    currency: "USD",
    input_usd_per_million: 2,
    cached_usd_per_million: 0.5,
    output_usd_per_million: 8,
  } as const;
  const stats = {
    n_input_tokens: 1_000_000,
    n_cache_tokens: 250_000,
    n_output_tokens: 100_000,
    cost_usd: 77,
  };
  it("validates core metadata, conflicts on changed rates and never changes native agent configuration", async () => {
    const preview = compileAgentWorkbenchRecipe(fastAgentWorkbenchStarter);
    const launch = (metadata: Parameters<typeof service.submitWorkbench>[4]) =>
      service.submitWorkbench(
        input,
        preview.harbor_agent,
        "rates",
        "test-subject",
        metadata,
      );
    const first = await launch({ pricing });
    expect(await launch({ pricing: { ...pricing } })).toEqual({
      created: false,
      run: first.run,
    });
    await expect(
      launch({ pricing: { ...pricing, cached_usd_per_million: 0 } }),
    ).rejects.toThrow("different run");
    await expect(launch({})).rejects.toThrow("different run");
    await expect(
      launch({ pricing: { ...pricing, output_usd_per_million: Infinity } }),
    ).rejects.toThrow();
    // Deliberately bypass the static boundary to exercise runtime validation.
    await expect(
      launch({ unknown: true } as Parameters<typeof launch>[0]),
    ).rejects.toThrow("metadata");
    const legacy = await service.submitWorkbench(
      input,
      preview.harbor_agent,
      "legacy-pricing",
      "test-subject",
    );
    expect(legacy.run).not.toHaveProperty("pricing");
    expect(first.run.harbor_job_config.agents).toEqual(
      legacy.run.harbor_job_config.agents,
    );
    expect(first.run.submission).toEqual(legacy.run.submission);
    expect(preview).toEqual(compileAgentWorkbenchRecipe(fastAgentWorkbenchStarter));
    await putJson(store, `runs/${first.run.run_id}/job/result.json`, { stats });
    await service.refresh();
    const reads = vi.spyOn(store, "read");
    expect(projection.run(first.run.run_id)?.shared_estimate).toMatchObject({
      cost_usd: 2.425,
    });
    expect(
      projection.listRuns().find((view) => view.record.run_id === first.run.run_id)
        ?.result,
    ).toEqual({ stats });
    expect(reads).not.toHaveBeenCalled();
    expect(jobs.starts).toBe(0);
  });
  it("sums each eligible run's own estimate, preserving partial, missing, zero and overflow independently of native costs", async () => {
    const preview = compileAgentWorkbenchRecipe(fastAgentWorkbenchStarter);
    const eligible = {
      ...input,
      role: "final" as const,
      benchmark: { ...input.benchmark, preset: "all-tasks-5-trials" },
    };
    for (const [index, rates] of [
      pricing,
      { ...pricing, input_usd_per_million: 4 },
      undefined,
    ].entries()) {
      const { run } = await service.submitWorkbench(
        eligible,
        preview.harbor_agent,
        `group-${index}`,
        "test-subject",
        rates ? { pricing: rates } : {},
      );
      await putJson(store, `runs/${run.run_id}/job/result.json`, {
        finished_at: "2026-01-01T00:10:00Z",
        n_total_trials: 1,
        stats: { ...stats, cost_usd: 0.02 },
      });
      await putJson(store, `runs/${run.run_id}/job/task/result.json`, trial(0.02, 1));
    }
    await service.refresh();
    const [row] = leaderboard(projection, presets);
    expect(row).toMatchObject({
      n_trials: 3,
      pass_rate: 1,
      cost_usd: 0.06,
      shared_estimate: { cost_usd: 6.35, estimated_runs: 2, total_runs: 3 },
    });
    const views = projection.listRuns();
    for (const [cost, expected, count] of [
      [null, null, 0],
      [0, 0, 3],
      [Number.MAX_VALUE, null, 3],
    ] as const) {
      const spy = vi.spyOn(projection, "listRuns").mockReturnValue(
        views.map((view) => ({
          ...view,
          shared_estimate: {
            basis: "launch_rates_reported_usage",
            cost_usd: cost,
            unavailable_reason: cost === null ? "usage_unavailable" : null,
          },
        })),
      );
      expect(leaderboard(projection, presets)[0]).toMatchObject({
        cost_usd: row?.cost_usd,
        n_trials: 3,
        shared_estimate: { cost_usd: expected, estimated_runs: count, total_runs: 3 },
      });
      spy.mockRestore();
    }
  });
});
