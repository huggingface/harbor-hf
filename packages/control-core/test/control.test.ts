import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { RunRecordV1, RunStateV1 } from "@harbor-hf/contracts";
import { runRecordPath, runStatePath } from "@harbor-hf/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compileAgentWorkbenchRecipe,
  ControlService,
  fastAgentWorkbenchStarter,
  FilesystemObjectStore,
  type JobObservation,
  type JobsPort,
  PresetCatalog,
  Projection,
  costLimitReached,
  createJson,
  leaderboard,
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
    });
    expect(projection.run(result.run.run_id)?.status).toBe("queued");
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
          model_name: "openai/openai/gpt-oss-20b:together",
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
    ).rejects.toThrow("cannot set agent env");
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
    expect(costLimitReached(record, { n_total_trials: 1 }, [cheap], [null])).toBe(true);
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
