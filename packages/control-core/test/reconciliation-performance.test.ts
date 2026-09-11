import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type RunRecordV1, type RunStateV1, runId } from "@harbor-hf/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JobObservation, JobsPort } from "../src/jobs.js";
import { PresetCatalog } from "../src/presets.js";
import { Projection } from "../src/projection.js";
import { ControlService } from "../src/service.js";
import { FilesystemObjectStore, type ObjectStore, putJson } from "../src/store.js";

let root: string;
let projection: Projection;
let service: ControlService;
let template: RunRecordV1;
let objects: Map<string, Uint8Array>;
let jobs: JobObservation[];
let counts: { lists: number; entries: number; reads: number; jobs: number };
let store: ObjectStore;
let port: JobsPort;
const now = "2026-09-01T00:00:00.000Z";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "reconcile-perf-"));
  projection = await Projection.open(join(root, "projection.sqlite"));
  objects = new Map();
  jobs = [];
  counts = { lists: 0, entries: 0, reads: 0, jobs: 0 };
  // Deterministic serial I/O latency model, not wall-clock benchmark claims.
  const delay = (ms: number) => vi.setSystemTime(Date.now() + ms);
  store = new FilesystemObjectStore(join(root, "unused"));
  vi.spyOn(store, "list").mockImplementation(async (prefix) => {
    counts.lists++;
    delay(7);
    const entries = [...objects]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, bytes]) => ({ key, size: bytes.length, source_identity: key }));
    counts.entries += entries.length;
    return entries;
  });
  vi.spyOn(store, "read").mockImplementation(async (key) => {
    counts.reads++;
    delay(3);
    const bytes = objects.get(key);
    if (!bytes) throw Object.assign(new Error("missing fixture"), { code: "ENOENT" });
    return bytes;
  });
  vi.spyOn(store, "put").mockImplementation(async (key, bytes) => {
    objects.set(key, bytes);
    return { digest: "fixture" };
  });
  port = {
    list: vi.fn(async () => {
      counts.jobs++;
      delay(11);
      return structuredClone(jobs);
    }),
    inspect: vi.fn(async (id) => {
      const job = jobs.find((item) => item.id === id);
      if (!job) throw new Error("inspection unavailable");
      return structuredClone(job);
    }),
    cancel: vi.fn(async (id) => {
      const job = jobs.find((item) => item.id === id);
      if (job) job.stage = "stopped";
    }),
    startParent: vi.fn(async (id) => {
      const job = observation(id, `parent-${jobs.length}`);
      jobs.push(job);
      return structuredClone(job);
    }),
  };
  const presets = await PresetCatalog.load(resolve("presets"));
  const submission = {
    benchmark: { name: "terminal-bench-2-1", preset: "one-task-1-trial" },
    model: { id: "openai/gpt-oss-20b", provider: "together", reasoning_effort: "off" },
    harness: { agent: "pi", version: "0.84.4" },
    cost_ceiling_usd: 1,
  };
  const id = runId("template");
  template = {
    schema_version: "v1",
    run_id: id,
    created_at: now,
    submitted_by: "synthetic-operator",
    role: "diagnostic",
    harbor_revision: "d".repeat(40),
    submission,
    harbor_job_config: presets.buildJobConfig(id, submission, "/data"),
  };
  service = new ControlService(store, projection, presets, port, {
    harborRevision: template.harbor_revision,
    mountRoot: "/data",
    maxActiveJobs: 1,
    restartDelayMs: 0,
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
});

afterEach(async () => {
  vi.useRealTimers();
  projection.close();
  await rm(root, { recursive: true, force: true });
});

function observation(
  id: string,
  jobId = "late-parent",
  role: "parent" | "trial" = "parent",
): JobObservation {
  return {
    id: jobId,
    run_id: id,
    role,
    stage: "running",
    created_at: now,
    started_at: now,
    finished_at: null,
  };
}
async function seed(index: number, desired: RunStateV1["desired_state"] = "paused") {
  const id = runId(`synthetic-${index}`);
  await putJson(store, `runs/${id}/run.json`, {
    ...template,
    run_id: id,
    created_at: new Date(Date.parse(now) + index).toISOString(),
  });
  await putJson(store, `runs/${id}/state.json`, {
    schema_version: "v1",
    run_id: id,
    revision: 0,
    updated_at: now,
    desired_state: desired,
    actor: "synthetic-operator",
    parent_jobs: [],
  });
  if (desired === "paused")
    await putJson(store, `runs/${id}/job/result.json`, {
      finished_at: now,
      n_total_trials: 1,
    });
  return id;
}

it.each([4, 16, 64])("bounds projection I/O for %i historical runs", async (size) => {
  for (let index = 0; index < size; index++) await seed(index);
  const phases: number[] = [];
  const rebuild = projection.rebuild.bind(projection);
  vi.spyOn(projection, "rebuild").mockImplementation(
    async (bucket, observations, scope) => {
      const started = Date.now();
      await rebuild(bucket, observations, scope);
      phases.push(Date.now() - started);
    },
  );
  const start = Date.now();
  await service.reconcile();
  expect(phases).toEqual([12 * size + 7, 12 * size + 7]);
  expect(counts).toEqual({
    lists: 2,
    entries: 6 * size,
    reads: 9 * size,
    jobs: 2,
  });
  expect(Date.now() - start).toBe(36 + 27 * size);
  expect(port.startParent).not.toHaveBeenCalled();
  expect(port.inspect).not.toHaveBeenCalled();
  expect(projection.listRuns()).toHaveLength(size);
});

it("defers late Jobs on skipped history to the next pass, parent before child", async () => {
  await seed(0, "run");
  const terminal = await seed(1);
  const start = vi.mocked(port.startParent).getMockImplementation();
  if (!start) throw new Error("missing start fixture");
  vi.spyOn(port, "startParent").mockImplementation(async (id) => {
    const parent = await start(id);
    jobs.push(observation(terminal), observation(terminal, "late-child", "trial"));
    return parent;
  });
  await service.reconcile();
  expect(port.cancel).not.toHaveBeenCalled();
  expect(projection.jobs().some((job) => job.id === "late-parent")).toBe(true);
  await service.reconcile();
  expect(port.cancel).toHaveBeenCalledWith("late-parent");
  expect(port.cancel).not.toHaveBeenCalledWith("late-child");
  await service.reconcile();
  expect(port.cancel).toHaveBeenCalledWith("late-child");
});

it("does not erase another run created while a scoped refresh is reading", async () => {
  const id = await seed(0);
  await service.refresh();
  const originalRead = vi.mocked(store.read).getMockImplementation();
  if (!originalRead) throw new Error("missing read fixture");
  let created: string | undefined;
  vi.spyOn(store, "read").mockImplementation(async (key, options) => {
    if (key === `runs/${id}/state.json` && !created) {
      created = await seed(1);
      await service.refresh();
    }
    return originalRead(key, options);
  });
  const snapshot = projection.jobObservations();
  await projection.rebuild(store, [], id);
  expect(created).toBeDefined();
  expect(projection.listRuns()).toHaveLength(2);
  // Scoped reads cannot claim a new global observation epoch.
  const afterFullRefresh = projection.jobObservations();
  await projection.rebuild(store, [], id);
  expect(projection.jobObservations()).toEqual(afterFullRefresh);
  expect(afterFullRefresh.observed_at).not.toBe(snapshot.observed_at);
});

it("fails closed when a fresh Jobs listing rejects after an initial complete list", async () => {
  await seed(0, "run");
  vi.mocked(port.list)
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new Error("later page unavailable"));
  await expect(service.reconcile()).rejects.toThrow("later page unavailable");
  expect(port.startParent).not.toHaveBeenCalled();
  expect(port.cancel).not.toHaveBeenCalled();
});

it("counts a newly observed unrelated parent before admitting a queued run", async () => {
  await seed(0, "run");
  vi.mocked(port.list)
    .mockResolvedValueOnce([])
    .mockResolvedValue([observation(runId("external"))]);
  await service.reconcile();
  expect(port.startParent).not.toHaveBeenCalled();
});

it("honors another run's pause while the preceding run is being refreshed", async () => {
  const first = await seed(0);
  const second = await seed(1, "run");
  // Force the preceding paused run down the live-Job safety path.
  jobs.push(observation(first));
  let paused = false;
  const rebuild = projection.rebuild.bind(projection);
  vi.spyOn(projection, "rebuild").mockImplementation(
    async (bucket, observations, scope) => {
      if (scope === first && !paused) {
        paused = true;
        await service.setDesiredState(second, "paused", "synthetic-operator");
      }
      return rebuild(bucket, observations, scope);
    },
  );
  await service.reconcile();
  expect(paused).toBe(true);
  expect(port.startParent).not.toHaveBeenCalled();
  expect(projection.run(second)?.state.desired_state).toBe("paused");
});

it("scopes SQL replacement as well as reads and preserves unrelated trials and parents", async () => {
  const first = await seed(0);
  const second = await seed(1);
  for (const id of [first, second]) {
    await putJson(store, `runs/${id}/job/task/result.json`, {
      id: "attempt",
      trial_name: "task",
      agent_result: { cost_usd: 0.1 },
    });
    jobs.push(observation(id, id));
  }
  await service.refresh();
  const secondBefore = projection.run(second);
  const snapshot = projection.jobObservations();
  objects.delete(`runs/${first}/job/task/result.json`);
  await projection.rebuild(store, [], first);
  expect(projection.trials(first)).toHaveLength(0);
  expect(projection.trials(second)).toHaveLength(1);
  expect(projection.run(second)).toEqual(secondBefore);
  expect(projection.jobObservations()).toEqual(snapshot);
  expect(projection.jobs().filter((job) => job.run_id === second)).toHaveLength(1);
  expect(projection.jobs().filter((job) => job.run_id === first)).toHaveLength(0);
});

it("rejects invalid scoped paths before reading or changing the projection", async () => {
  await expect(projection.rebuild(store, [], "../runs")).rejects.toThrow(
    "invalid projection run scope",
  );
  expect(counts.lists).toBe(0);
});

it.each([4, 16, 64])(
  "uses only three complete Jobs listings for %i inactive histories plus a queued run",
  async (size) => {
    for (let index = 0; index < size; index++) {
      const id = await seed(index);
      const desired = (["paused", "cancelled", "run", "run"] as const)[index % 4];
      await putJson(store, `runs/${id}/state.json`, {
        schema_version: "v1",
        run_id: id,
        revision: 1,
        updated_at: now,
        desired_state: desired,
        actor: "synthetic-operator",
        parent_jobs: [],
      });
      if (index % 4 === 3) {
        await putJson(store, `runs/${id}/job/result.json`, { n_total_trials: 1 });
        await putJson(store, `runs/${id}/job/task/result.json`, {
          id: "attempt",
          trial_name: "task",
          agent_result: { cost_usd: 2 },
        });
      }
    }
    const queued = await seed(size, "run");
    await service.reconcile();
    expect(counts.jobs).toBe(3);
    expect(counts.lists).toBe(3);
    expect(port.startParent).toHaveBeenCalledExactlyOnceWith(queued);
    expect(port.cancel).not.toHaveBeenCalled();
    expect(projection.listRuns()).toHaveLength(size + 1);
    expect(new Set(projection.listRuns().map((view) => view.status))).toEqual(
      new Set(["paused", "cancelled", "finished", "cost_stopped", "running"]),
    );
    expect(projection.run(queued)?.state.parent_jobs).toHaveLength(1);
  },
);

it("does not skip terminal live Jobs present in the initial complete snapshot", async () => {
  const terminal = await seed(0);
  jobs.push(observation(terminal), observation(terminal, "child", "trial"));
  await service.reconcile();
  expect(counts.jobs).toBe(3);
  expect(port.cancel).toHaveBeenCalledExactlyOnceWith("late-parent");
  await service.reconcile();
  expect(port.cancel).toHaveBeenCalledWith("child");
  expect(port.startParent).not.toHaveBeenCalled();
});

it("invalidates idle snapshot eligibility when resumed before acquiring the lock", async () => {
  const id = await seed(0);
  objects.delete(`runs/${id}/job/result.json`);
  const rebuild = projection.rebuild.bind(projection);
  let resumed = false;
  vi.spyOn(projection, "rebuild").mockImplementation(async (...args) => {
    await rebuild(...args);
    if (!resumed) {
      resumed = true;
      // Preserve the initial snapshot returned by listRuns while the actual
      // operator mutation changes both durable state and the shared projection.
      const snapshot = projection.listRuns();
      await service.setDesiredState(id, "run", "synthetic-operator");
      vi.spyOn(projection, "listRuns").mockReturnValueOnce(snapshot);
    }
  });
  await service.reconcile();
  expect(resumed).toBe(true);
  expect(port.startParent).toHaveBeenCalledExactlyOnceWith(id);
  expect(projection.run(id)?.state.desired_state).toBe("run");
});

it("refreshes skipped history at pass close without authorizing mutations", async () => {
  const id = await seed(0);
  const read = vi.mocked(store.read).getMockImplementation();
  if (!read) throw new Error("missing read fixture");
  let stateReads = 0;
  vi.spyOn(store, "read").mockImplementation(async (key, options) => {
    const bytes = await read(key, options);
    if (key === `runs/${id}/state.json` && ++stateReads === 2) {
      await putJson(store, `runs/${id}/job/result.json`, {
        finished_at: "2026-09-02T00:00:00Z",
        n_total_trials: 2,
      });
      jobs.push(observation(id));
    }
    return bytes;
  });
  await service.reconcile();
  expect(counts.jobs).toBe(2);
  expect(projection.run(id)?.result?.n_total_trials).toBe(2);
  expect(projection.jobs().some((job) => job.id === "late-parent")).toBe(true);
  expect(port.cancel).not.toHaveBeenCalled();
  await service.reconcile();
  expect(port.cancel).toHaveBeenCalledExactlyOnceWith("late-parent");
});

it("retains initial live-history eligibility after a later listing reports it stopped", async () => {
  await seed(0, "run");
  const terminal = await seed(1);
  const parent = observation(terminal);
  jobs.push(parent);
  await putJson(store, `runs/${terminal}/state.json`, {
    schema_version: "v1",
    run_id: terminal,
    revision: 1,
    updated_at: now,
    desired_state: "paused",
    actor: "synthetic-operator",
    parent_jobs: [{ id: parent.id, started_at: now }],
  });
  vi.mocked(port.list)
    .mockResolvedValueOnce([parent])
    .mockResolvedValueOnce([{ ...parent, stage: "stopped" }])
    .mockResolvedValue([
      { ...parent, stage: "stopped" },
      observation(terminal, "late-child", "trial"),
    ]);
  await service.reconcile();
  // Initial liveness forbids the idle shortcut even after the preceding run's
  // list overwrites it. Recorded-parent inspection must still authorize cleanup.
  expect(port.inspect).toHaveBeenCalledWith(parent.id);
  expect(port.cancel).toHaveBeenCalledExactlyOnceWith(parent.id);
});

it("fails closed on an incomplete initial snapshot even with many inactive histories", async () => {
  for (let index = 0; index < 16; index++) await seed(index);
  await seed(16, "run");
  vi.mocked(port.list).mockRejectedValue(new Error("later page unavailable"));
  await expect(service.reconcile()).rejects.toThrow("later page unavailable");
  expect(counts.lists).toBe(0);
  expect(port.startParent).not.toHaveBeenCalled();
  expect(port.cancel).not.toHaveBeenCalled();
});
