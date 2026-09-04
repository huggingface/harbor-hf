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
  harness: { agent: "pi", version: "0.84.4" },
  cost_ceiling_usd_per_trial: 0.25,
} as const;

async function submit(key = "test-key") {
  const { runId } = await import("@harbor-hf/contracts");
  const id = runId(key);
  const run: RunRecordV1 = {
    schema_version: "v1",
    run_id: id,
    created_at: "2026-01-01T00:00:00Z",
    submitted_by: "test-subject",
    role: "final",
    harbor_revision: "d".repeat(40),
    submission: input,
    harbor_job_config: presets.buildJobConfig(id, input, "/data"),
  };
  await createJson(store, runRecordPath(id), run);
  await putJson(store, runStatePath(id), {
    schema_version: "v1",
    run_id: id,
    revision: 0,
    updated_at: run.created_at,
    desired_state: "run",
    actor: run.submitted_by,
    parent_jobs: [],
  });
  return { run };
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

describe("disabled execution service", () => {
  it("rejects every direct mutation without persistence or Job calls", async () => {
    await expect(service.submitPreset(input, "key", "actor")).rejects.toThrow(
      "Execution is disabled",
    );
    await expect(service.submitWorkbench(input, {}, "key", "actor")).rejects.toThrow(
      "Execution is disabled",
    );
    await expect(service.submitConfig({}, 1, "key", "actor")).rejects.toThrow(
      "Execution is disabled",
    );
    for (const desired of ["run", "paused", "cancelled"] as const)
      await expect(
        service.setDesiredState("invalid", desired, "actor"),
      ).rejects.toThrow("Execution is disabled");
    await expect(service.reconcile()).rejects.toThrow("Execution is disabled");
    expect(await store.list("runs/")).toEqual([]);
    expect(jobs.starts).toBe(0);
    expect(jobs.cancelled).toEqual([]);
  });
});
