import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { RunRecordV1, RunStateV1 } from "@harbor-hf/contracts";
import { runRecordPath, runStatePath } from "@harbor-hf/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ControlService,
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
  harness: { agent: "pi", version: "0.84.2" },
  cost_ceiling_usd_per_trial: 0.25,
} as const;

async function submit(key = "test-key") {
  return service.submitPreset(input, key, "test-subject");
}

function trial(cost = 0.01, reward = 1): Record<string, unknown> {
  return {
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
          model_name: "openai/openai/gpt-oss-20b:together",
          env: {
            OPENAI_BASE_URL: "https://router.huggingface.co/v1",
            OPENAI_API_KEY: "$" + "{HF_INFERENCE_TOKEN}",
          },
          kwargs: { version: "0.84.2", thinking: "off" },
        },
      ],
    });
    expect(projection.run(result.run.run_id)?.status).toBe("queued");
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
          kwargs: { version: "0.84.2" },
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
    const direct = await service.submitConfig(
      directInput,
      0.25,
      "direct",
      "test-subject",
    );
    expect(direct.run.role).toBe("diagnostic");
    expect(direct.run.harbor_job_config.environment).toMatchObject({
      import_path: "harbor_hf_agents.hf_sandbox:LabeledHFSandboxEnvironment",
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
    expect(costLimitReached(record, { n_total_trials: 1 }, [summary])).toBe(true);
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
    await service.reconcile();
    expect(jobs.cancelled.sort()).toEqual(["child", "parent-1"]);
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
});
