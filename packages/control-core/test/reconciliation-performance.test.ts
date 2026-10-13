import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type RunRecordV1, type RunStateV1, runId } from "@harbor-hf/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isLiveJob, type JobObservation, type JobsPort } from "../src/jobs.js";
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
let counts: {
  walks: number;
  lists: number;
  entries: number;
  reads: number;
  jobs: number;
};
let store: ObjectStore;
let port: JobsPort;
const now = "2026-09-01T00:00:00.000Z";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "reconcile-perf-"));
  projection = await Projection.open(join(root, "projection.sqlite"));
  objects = new Map();
  jobs = [];
  counts = { walks: 0, lists: 0, entries: 0, reads: 0, jobs: 0 };
  // Deterministic serial I/O latency model, not wall-clock benchmark claims.
  const delay = (ms: number) => vi.setSystemTime(Date.now() + ms);
  store = new FilesystemObjectStore(join(root, "unused"));
  vi.spyOn(store, "list").mockImplementation(async (prefix) => {
    counts.walks++;
    delay(7);
    const entries = [...objects]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, bytes]) => ({
        key,
        size: bytes.length,
        source_identity: digest(bytes),
      }));
    counts.entries += entries.length;
    return entries;
  });
  vi.spyOn(store, "listDirectory").mockImplementation(async (prefix, filenames) => {
    counts.lists++;
    delay(7);
    const directories = new Set<string>();
    const files = [];
    for (const [key, bytes] of objects) {
      if (!key.startsWith(prefix)) continue;
      const [child, ...rest] = key.slice(prefix.length).split("/");
      if (!child) continue;
      if (rest.length > 0) directories.add(`${prefix}${child}/`);
      else if (!filenames || filenames.includes(child))
        files.push({ key, size: bytes.length, source_identity: digest(bytes) });
    }
    counts.entries += files.length + directories.size;
    return { files, directories: [...directories].sort() };
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
      return structuredClone(jobs.filter(isLiveJob));
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

it.each([4, 16, 64])(
  "lists only the files that a full refresh reads for %i historical runs",
  async (size) => {
    const ids = [];
    for (let index = 0; index < size; index++) {
      const id = await seed(index);
      await putJson(store, `runs/${id}/job/task/result.json`, {
        id: "attempt",
        trial_name: "task",
        agent_result: { cost_usd: 0.1 },
      });
      // Harbor's artifacts are most of a run's objects; a refresh never lists or reads them.
      for (const artifact of [
        "agent/trajectory.json",
        "verifier/reward.txt",
        "workspace/a.txt",
      ])
        objects.set(`runs/${id}/job/task/${artifact}`, new TextEncoder().encode("{}"));
      ids.push(id);
    }
    const read = vi.mocked(store.read);
    await service.refresh();
    expect(counts.walks).toBe(0);
    // runs/, then each run folder and its job/ folder.
    expect(counts.lists).toBe(1 + 2 * size);
    // run.json, state.json, the job result, the trial result and the pricing history.
    expect(counts.reads).toBe(5 * size);
    expect(
      read.mock.calls.some(([key]) => /\/(agent|verifier|workspace)\//.test(key)),
    ).toBe(false);
    expect(projection.listRuns()).toHaveLength(size);
    for (const id of ids) expect(projection.trials(id)).toHaveLength(1);
  },
);

it.each([4, 16, 64])(
  "a pass over %i settled runs rebuilds no history",
  async (size) => {
    for (let index = 0; index < size; index++) await seed(index);
    await service.refresh();
    counts = { walks: 0, lists: 0, entries: 0, reads: 0, jobs: 0 };
    const rebuild = vi.spyOn(projection, "rebuild");
    const before = projection.jobObservations().observed_at;
    vi.setSystemTime(Date.now() + 1_000);
    await service.reconcile();
    expect(rebuild).not.toHaveBeenCalled();
    // The first pass is a safety pass: one discovery listing, each run's state
    // under its lock, and one Jobs listing.
    expect(counts).toEqual({ walks: 0, lists: 1, entries: size, reads: size, jobs: 1 });
    expect(projection.jobObservations().observed_at).not.toBe(before);
    expect(port.startParent).not.toHaveBeenCalled();
    expect(port.inspect).not.toHaveBeenCalled();
    expect(projection.listRuns()).toHaveLength(size);
    // With nothing to watch, later passes send no request until the next safety pass.
    counts = { walks: 0, lists: 0, entries: 0, reads: 0, jobs: 0 };
    vi.setSystemTime(Date.now() + 9 * 60_000);
    await service.reconcile();
    expect(counts).toEqual({ walks: 0, lists: 0, entries: 0, reads: 0, jobs: 0 });
    vi.setSystemTime(Date.now() + 2 * 60_000);
    await service.reconcile();
    expect(counts).toEqual({ walks: 0, lists: 1, entries: size, reads: size, jobs: 1 });
    expect(rebuild).not.toHaveBeenCalled();
  },
);

it.each([4, 64])(
  "a steady pass over an active run with %i finished trials reads no trial result",
  async (size) => {
    const id = await seed(0, "run");
    await putJson(store, `runs/${id}/state.json`, {
      schema_version: "v1",
      run_id: id,
      revision: 1,
      updated_at: now,
      desired_state: "run",
      actor: "synthetic-operator",
      parent_jobs: [{ id: "late-parent", started_at: now }],
    });
    const finished = (index: number) => ({
      id: `attempt-${index}`,
      trial_name: `task-${index}`,
      finished_at: now,
      agent_result: { cost_usd: 0.001 },
    });
    for (let index = 0; index < size; index++)
      await putJson(store, `runs/${id}/job/task-${index}/result.json`, finished(index));
    await putJson(store, `runs/${id}/job/task-${size}/config.json`, {});
    await putJson(store, `runs/${id}/job/result.json`, { n_completed_trials: size });
    jobs.push(observation(id));
    await service.refresh();
    await service.reconcile();
    const read = vi.mocked(store.read);
    const trialReads = () =>
      read.mock.calls.filter(([key]) => /\/job\/task-\d+\/result\.json$/.test(key));
    read.mockClear();
    counts = { walks: 0, lists: 0, entries: 0, reads: 0, jobs: 0 };
    await service.reconcile();
    expect(trialReads()).toEqual([]);
    expect(counts.jobs).toBe(1);
    expect(counts.walks).toBe(0);
    // The run folder, job/ and nothing else, before the loop and at its close.
    expect(counts.lists).toBeLessThanOrEqual(5);
    expect(port.inspect).not.toHaveBeenCalled();
    // A newly finished trial changes Harbor's job metadata: one trial read, not size + 1.
    read.mockClear();
    await putJson(store, `runs/${id}/job/task-${size}/result.json`, finished(size));
    await putJson(store, `runs/${id}/job/result.json`, {
      n_completed_trials: size + 1,
    });
    await service.reconcile();
    expect(trialReads().map(([key]) => key)).toEqual([
      `runs/${id}/job/task-${size}/result.json`,
    ]);
    expect(projection.trials(id)).toHaveLength(size + 1);
  },
);

it("reads every result again when Harbor's completed count drops below the finished rows", async () => {
  const id = await seed(0, "run");
  const finished = { id: "attempt", trial_name: "task", finished_at: now };
  await putJson(store, `runs/${id}/job/task/config.json`, { trial_name: "task" });
  await putJson(store, `runs/${id}/job/task/result.json`, finished);
  await putJson(store, `runs/${id}/job/result.json`, {
    stats: { n_completed_trials: 1 },
  });
  jobs.push(observation(id));
  await service.refresh();
  await service.reconcile();
  expect(projection.trials(id)).toHaveLength(1);
  // Harbor runs the trial again under the same name: the parent removes its old
  // result and uploads job metadata with the lower count.
  objects.delete(`runs/${id}/job/task/result.json`);
  await putJson(store, `runs/${id}/job/result.json`, {
    stats: { n_completed_trials: 0 },
  });
  await service.reconcile();
  expect(projection.trials(id)).toEqual([]);
});

it("refreshes a settled run once more after its last live Job stops", async () => {
  const id = await seed(0, "cancelled");
  const parent = observation(id);
  jobs.push(parent);
  // The cancelled parent is still stopping when the first pass closes.
  vi.mocked(port.cancel).mockImplementation(async () => {});
  await service.refresh();
  await service.reconcile();
  expect(port.cancel).toHaveBeenCalledExactlyOnceWith(parent.id);
  // It uploads one more trial result, then stops before the next pass.
  await putJson(store, `runs/${id}/job/task/result.json`, {
    id: "attempt",
    trial_name: "task",
    agent_result: { cost_usd: 0.1 },
  });
  parent.stage = "stopped";
  expect(projection.trials(id)).toHaveLength(0);
  await service.reconcile();
  expect(projection.trials(id)).toHaveLength(1);
  const rebuild = vi.spyOn(projection, "rebuild");
  // When the run leaves the settling window, the pass reads it once more in full.
  vi.setSystemTime(Date.now() + 11 * 60_000);
  await service.reconcile();
  expect(rebuild).toHaveBeenCalledExactlyOnceWith(store, expect.anything(), id, {
    verify: true,
  });
  rebuild.mockClear();
  vi.setSystemTime(Date.now() + 1_000);
  await service.reconcile();
  expect(rebuild).not.toHaveBeenCalled();
});

it("keeps refreshing a run for ten minutes after its Job was last live", async () => {
  const id = await seed(0, "cancelled");
  jobs.push(observation(id));
  await service.refresh();
  // The pass cancels the live parent, so the closing listing no longer has it.
  await service.reconcile();
  expect(port.cancel).toHaveBeenCalledOnce();
  const rebuild = vi.spyOn(projection, "rebuild");
  vi.setSystemTime(Date.parse(now) + 9 * 60_000);
  await service.reconcile();
  expect(rebuild).toHaveBeenCalledExactlyOnceWith(store, expect.anything(), id);
  rebuild.mockClear();
  vi.setSystemTime(Date.parse(now) + 11 * 60_000);
  await service.reconcile();
  expect(rebuild).toHaveBeenCalledExactlyOnceWith(store, expect.anything(), id, {
    verify: true,
  });
  rebuild.mockClear();
  vi.setSystemTime(Date.parse(now) + 12 * 60_000);
  await service.reconcile();
  expect(rebuild).not.toHaveBeenCalled();
});

it("drops a Job that leaves the live listing before a run acts", async () => {
  const id = await seed(0, "paused");
  const parent = observation(id, "stopping-parent");
  jobs.push(parent);
  // The parent stops after the first listing of the pass.
  vi.mocked(port.list).mockImplementationOnce(async () => {
    const listed = structuredClone(jobs.filter(isLiveJob));
    parent.stage = "stopped";
    return listed;
  });
  await service.reconcile();
  expect(port.list).toHaveBeenCalledTimes(2);
  expect(port.cancel).not.toHaveBeenCalled();
});

it("keeps a steady run on the pass listing and restarts it on the next pass", async () => {
  const id = await seed(0, "run");
  await putJson(store, `runs/${id}/state.json`, {
    schema_version: "v1",
    run_id: id,
    revision: 1,
    updated_at: now,
    desired_state: "run",
    actor: "synthetic-operator",
    parent_jobs: [{ id: "stopping-parent", started_at: now }],
  });
  const parent = observation(id, "stopping-parent");
  jobs.push(parent);
  // The parent stops after the first listing of the pass.
  vi.mocked(port.list).mockImplementationOnce(async () => {
    const listed = structuredClone(jobs.filter(isLiveJob));
    parent.stage = "stopped";
    return listed;
  });
  await service.reconcile();
  expect(port.list).toHaveBeenCalledOnce();
  expect(port.startParent).not.toHaveBeenCalled();
  await service.reconcile();
  expect(port.inspect).toHaveBeenCalledWith("stopping-parent");
  expect(port.startParent).toHaveBeenCalledExactlyOnceWith(id);
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
  // The pass does not list again at its close; the next pass finds the late Jobs.
  expect(projection.jobs().some((job) => job.id === "late-parent")).toBe(false);
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
  expect(counts.lists + counts.walks).toBe(0);
});

it.each([4, 16, 64])(
  "uses only two complete Jobs listings for %i inactive histories plus a queued run",
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
    await service.refresh();
    const queued = await seed(size, "run");
    counts = { walks: 0, lists: 0, entries: 0, reads: 0, jobs: 0 };
    await service.reconcile();
    // The pass listing, and a fresh one before the queued run starts its parent.
    expect(counts.jobs).toBe(2);
    // Discovery, then the queued run's folder before, inside and after the loop.
    expect(counts.walks).toBe(0);
    expect(counts.lists).toBe(4);
    expect(port.startParent).toHaveBeenCalledExactlyOnceWith(queued);
    expect(port.cancel).not.toHaveBeenCalled();
    expect(projection.listRuns()).toHaveLength(size + 1);
    expect(new Set(projection.listRuns().map((view) => view.status))).toEqual(
      new Set(["paused", "cancelled", "finished", "cost_stopped", "running"]),
    );
    expect(projection.run(queued)?.state.parent_jobs).toHaveLength(1);
  },
);

it("does not restart a parent when a finished native result appears after stale listings", async () => {
  const id = await seed(0, "run");
  const resultKey = `runs/${id}/job/result.json`;
  await putJson(store, resultKey, { finished_at: now, n_total_trials: 1 });
  const list = vi.mocked(store.listDirectory).getMockImplementation();
  if (!list) throw new Error("missing list fixture");
  let calls = 0;
  vi.spyOn(store, "listDirectory").mockImplementation(async (prefix, filenames) => {
    const listing = await list(prefix, filenames);
    if (prefix !== `runs/${id}/job/`) return listing;
    // The direct object is already readable, but the listings before and inside
    // the loop started before its upload became visible in the Bucket listing.
    return ++calls <= 2
      ? { ...listing, files: listing.files.filter((entry) => entry.key !== resultKey) }
      : listing;
  });

  await service.reconcile();

  expect(port.startParent).not.toHaveBeenCalled();
  expect(store.read).toHaveBeenCalledWith(resultKey, { fresh: true });
  expect(projection.run(id)?.status).toBe("finished");
});

it("bypasses cached unfinished results before starting a replacement parent", async () => {
  const id = await seed(0, "run");
  const resultKey = `runs/${id}/job/result.json`;
  await putJson(store, resultKey, { finished_at: now, n_total_trials: 1 });
  const read = vi.mocked(store.read).getMockImplementation();
  if (!read) throw new Error("missing read fixture");
  vi.spyOn(store, "read").mockImplementation((key, options) =>
    key === resultKey && !options?.fresh
      ? Promise.resolve(new TextEncoder().encode(JSON.stringify({ finished_at: null })))
      : read(key, options),
  );

  await service.reconcile();

  expect(port.startParent).not.toHaveBeenCalled();
  expect(store.read).toHaveBeenCalledWith(resultKey, { fresh: true });
  expect(projection.run(id)?.status).toBe("queued");
});

it("does not skip terminal live Jobs present in the initial complete snapshot", async () => {
  const terminal = await seed(0);
  jobs.push(observation(terminal), observation(terminal, "child", "trial"));
  await service.reconcile();
  expect(counts.jobs).toBe(2);
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
  expect(counts.jobs).toBe(1);
  // No closing listing. Nothing is watched, so the late parent and its run's new
  // files wait for the next safety pass.
  expect(projection.jobs().some((job) => job.id === "late-parent")).toBe(false);
  expect(port.cancel).not.toHaveBeenCalled();
  await service.reconcile();
  expect(port.cancel).not.toHaveBeenCalled();
  vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
  await service.reconcile();
  expect(projection.run(id)?.result?.n_total_trials).toBe(2);
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
  expect(counts.lists + counts.walks).toBe(0);
  expect(port.startParent).not.toHaveBeenCalled();
  expect(port.cancel).not.toHaveBeenCalled();
});
