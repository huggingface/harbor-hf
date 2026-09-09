import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FilesystemObjectStore,
  putJson,
  type JobObservation,
} from "@harbor-hf/control-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrialProgressReader } from "../src/trial-progress-reader.js";

let root: string;
let store: FilesystemObjectStore;
const runId = `run-${"a".repeat(24)}`;
const base = `runs/${runId}/job/`;
const task = { name: "task-a", digest: `sha256:${"d".repeat(64)}` };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "native-progress-"));
  store = new FilesystemObjectStore(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("native artifact reader", () => {
  it("returns only allowlisted native fields, preserving repetitions and incomplete trials", async () => {
    const sentinel = "private-value-must-not-be-returned";
    await putJson(store, `${base}lock.json`, {
      trials: Array.from({ length: 5 }, () => ({
        task,
        agent: { env: { TEST_SECRET: sentinel } },
      })),
    });
    await putJson(store, `${base}trial-a/config.json`, {
      trial_name: "trial-a",
      agent: { env: { TEST_SECRET: sentinel } },
    });
    await putJson(store, `${base}trial-a/lock.json`, { task });
    await putJson(store, `${base}trial-b/lock.json`, { task });
    await putJson(store, `${base}trial-b/result.json`, {
      trial_name: "trial-b",
      task_name: "task-a",
      task_checksum: "different-legacy-dirhash",
      finished_at: "2026-09-08T12:00:00Z",
      exception_info: null,
      verifier_result: { rewards: { reward: 0 } },
      agent_result: { cost_usd: 0.12 },
      config: { agent: { env: { TEST_SECRET: sentinel } } },
    });
    await putJson(store, `${base}trial-a/agent/trajectory.json`, { private: sentinel });
    const job: JobObservation = {
      id: "child-test",
      run_id: runId,
      role: "trial",
      stage: "queued",
      created_at: "2026-09-08T12:00:00Z",
      started_at: null,
      finished_at: null,
    };
    const value = await new TrialProgressReader(store, { ttlMs: 0 }).snapshot(
      runId,
      [job, { ...job, id: "other", run_id: "run-other" }],
      null,
    );
    expect(value.lock?.trials).toHaveLength(5);
    expect(value.trials.map((trial) => trial.trial_name)).toEqual([
      "trial-a",
      "trial-b",
    ]);
    expect(value.trials[0]?.result).toBeNull();
    expect(value.trials[1]?.lock?.task.digest).toBe(task.digest);
    expect(value.trials[1]?.reward).toBe(0);
    expect(value.trials[1]?.cost_usd).toBe(0.12);
    expect(value.jobs).toEqual([job]);
    expect(JSON.stringify(value)).not.toContain(sentinel);
  });
  it("invalidates cached content identities and does not retain removed observations", async () => {
    await putJson(store, `${base}trial-a/config.json`, { trial_name: "trial-a" });
    const reader = new TrialProgressReader(store, { ttlMs: 0 });
    const read = vi.spyOn(store, "read");
    await reader.snapshot(runId, [], null);
    await reader.snapshot(runId, [], null);
    expect(read).toHaveBeenCalledTimes(1);
    await putJson(store, `${base}trial-a/result.json`, {
      finished_at: "2026-09-08T12:00:00Z",
      verifier_result: { rewards: { reward: 1 } },
    });
    expect((await reader.snapshot(runId, [], null)).trials[0]?.reward).toBe(1);
    await rm(join(root, base, "trial-a"), { recursive: true });
    expect((await reader.snapshot(runId, [], null)).trials).toEqual([]);
  });
  it("handles missing preparation and rejects malformed or unsafe observations", async () => {
    const reader = new TrialProgressReader(store, { ttlMs: 0 });
    expect((await reader.snapshot(runId, [], null)).lock).toBeNull();
    await expect(reader.snapshot("../escape", [], null)).rejects.toThrow();
    await putJson(store, `${base}lock.json`, { trials: "malformed" });
    await expect(reader.snapshot(runId, [], null)).rejects.toThrow();
  });
  it("bounds simultaneous artifact reads on larger runs", async () => {
    for (let index = 0; index < 15; index++)
      await putJson(store, `${base}trial-${index}/config.json`, {});
    const original = store.read.bind(store);
    let active = 0;
    let peak = 0;
    vi.spyOn(store, "read").mockImplementation(async (key) => {
      active++;
      peak = Math.max(peak, active);
      try {
        return await original(key);
      } finally {
        active--;
      }
    });
    expect(
      (await new TrialProgressReader(store, { ttlMs: 0 }).snapshot(runId, [], null))
        .trials,
    ).toHaveLength(15);
    expect(peak).toBeLessThanOrEqual(6);
  });
});

it("observes nine distinct trial folders without treating cost receipts as results", async () => {
  const tasks = ["task-a", "task-b", "task-c"].map((name) => ({ ...task, name }));
  await putJson(store, `${base}lock.json`, {
    trials: tasks.flatMap((task) => Array.from({ length: 3 }, () => ({ task }))),
  });
  for (const task of tasks) {
    for (let repeat = 0; repeat < 3; repeat++) {
      const name = `${task.name}__native${repeat}`;
      await putJson(store, `${base}${name}/config.json`, { trial_name: name });
      await putJson(store, `${base}${name}/lock.json`, { task });
      await putJson(store, `runs/${runId}/attempt-costs/${name}.json`, {
        trial_name: name,
        cost_usd: 1,
      });
    }
  }
  const value = await new TrialProgressReader(store, { ttlMs: 0 }).snapshot(
    runId,
    [],
    null,
  );
  expect(value.lock?.trials).toHaveLength(9);
  expect(value.trials).toHaveLength(9);
  expect(new Set(value.trials.map((trial) => trial.trial_name)).size).toBe(9);
  expect(
    value.trials.every(
      (trial) =>
        trial.result === null && trial.reward === null && trial.cost_usd === null,
    ),
  ).toBe(true);
});

it("rejects mismatched native identities instead of associating another trial result", async () => {
  await putJson(store, `${base}trial-a/result.json`, { trial_name: "trial-b" });
  await expect(
    new TrialProgressReader(store, { ttlMs: 0 }).snapshot(runId, [], null),
  ).rejects.toThrow("identity");
});

it("rejects malformed finish timestamps rather than displaying completion", async () => {
  await putJson(store, `${base}trial-a/result.json`, { finished_at: "not-a-time" });
  await expect(
    new TrialProgressReader(store, { ttlMs: 0 }).snapshot(runId, [], null),
  ).rejects.toThrow("schema validation");
});

it("coalesces snapshots across callers, expires them, and keeps provider observations separate", async () => {
  let now = Date.parse("2026-09-09T00:00:00Z");
  const reader = new TrialProgressReader(store, { now: () => now });
  const list = vi.spyOn(store, "list");
  const [first, second] = await Promise.all([
    reader.snapshot(runId, [], null),
    reader.snapshot(runId, [], "2026-09-09T00:00:01Z"),
  ]);
  expect(list).toHaveBeenCalledTimes(1);
  expect(first.jobs_observed_at).toBeNull();
  expect(second.jobs_observed_at).toBe("2026-09-09T00:00:01Z");
  now += 9_999;
  expect((await reader.snapshot(runId, [], null)).observed_at).toBe(first.observed_at);
  expect(list).toHaveBeenCalledTimes(1);
  now++;
  await putJson(store, `${base}trial-a/config.json`, { trial_name: "trial-a" });
  expect((await reader.snapshot(runId, [], null)).trials).toHaveLength(1);
  expect(list).toHaveBeenCalledTimes(2);
  now += 10_000;
  await rm(join(root, base, "trial-a"), { recursive: true });
  expect((await reader.snapshot(runId, [], null)).trials).toHaveLength(0);
});

it("invalidates failed refreshes instead of serving stale success, then recovers immediately", async () => {
  let now = 0;
  const reader = new TrialProgressReader(store, { now: () => now });
  await reader.snapshot(runId, [], null);
  now = 10_000;
  const list = vi
    .spyOn(store, "list")
    .mockRejectedValueOnce(new Error("fresh failure"));
  await expect(reader.snapshot(runId, [], null)).rejects.toThrow("fresh failure");
  await putJson(store, `${base}lock.json`, { trials: "invalid" });
  await expect(reader.snapshot(runId, [], null)).rejects.toThrow("schema validation");
  await putJson(store, `${base}lock.json`, { trials: [] });
  expect((await reader.snapshot(runId, [], null)).lock?.trials).toEqual([]);
  expect(list).toHaveBeenCalledTimes(3);
});

it("bounds shared snapshots and pending requests without evicting in-flight work", async () => {
  const reader = new TrialProgressReader(store, { maxSnapshots: 1 });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = store.list.bind(store);
  const list = vi.spyOn(store, "list").mockImplementation(async (prefix) => {
    await gate;
    return original(prefix);
  });
  const pending = reader.snapshot(runId, [], null);
  const coalesced = reader.snapshot(runId, [], null);
  const other = `run-${"b".repeat(24)}`;
  await expect(reader.snapshot(other, [], null)).rejects.toThrow("capacity");
  expect(list).toHaveBeenCalledTimes(1);
  release();
  await Promise.all([pending, coalesced]);
  await reader.snapshot(other, [], null);
  await reader.snapshot(runId, [], null);
  expect(list).toHaveBeenCalledTimes(3);
});
