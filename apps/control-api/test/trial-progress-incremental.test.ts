import { sha256 } from "@harbor-hf/contracts";
import type { DirectoryListing, ObjectStore } from "@harbor-hf/control-core";
import { describe, expect, it, vi } from "vitest";
import { TrialProgressReader } from "../src/trial-progress-reader.js";

const runId = `run-${"a".repeat(24)}`;
const base = `runs/${runId}/job/`;
const finished = { finished_at: "2026-09-09T00:00:00Z", agent_result: { cost_usd: 0 } };

function fixture(options: { maxTrials?: number; maxSnapshots?: number } = {}) {
  let now = 0;
  const objects = new Map<string, Uint8Array>();
  const put = (key: string, value: unknown) =>
    objects.set(`${base}${key}`, new TextEncoder().encode(JSON.stringify(value)));
  const listDirectory = vi.fn(
    async (
      prefix: string,
      filenames?: readonly string[],
    ): Promise<DirectoryListing> => {
      const directories = new Set<string>();
      const files = [];
      for (const [key, bytes] of objects) {
        if (!key.startsWith(prefix)) continue;
        const tail = key.slice(prefix.length);
        const slash = tail.indexOf("/");
        if (slash >= 0) directories.add(`${prefix}${tail.slice(0, slash)}/`);
        else if (!filenames || filenames.includes(tail))
          files.push({ key, size: bytes.byteLength, source_identity: sha256(bytes) });
      }
      return { files, directories: [...directories] };
    },
  );
  const store: ObjectStore = {
    listDirectory,
    list: vi.fn(async () => {
      throw new Error("recursive listing forbidden");
    }),
    read: vi.fn(async (key: string) => {
      const bytes = objects.get(key);
      if (!bytes) throw new Error("missing artifact");
      return bytes;
    }),
    create: vi.fn(),
    put: vi.fn(),
  };
  const reader = new TrialProgressReader(store, { now: () => now, ...options });
  return {
    store,
    put,
    objects,
    reader,
    listDirectory,
    advance: (ms = 30_000) => {
      now += ms;
    },
    snapshot: () => reader.snapshot(runId, [], null),
    clear: () => {
      listDirectory.mockClear();
      vi.mocked(store.read).mockClear();
    },
  };
}

describe("incremental native trial observations", () => {
  it("does not relist/reread completed contents, discovers new trials and observes active completion", async () => {
    const f = fixture();
    f.put("done/result.json", finished);
    f.put("active/config.json", { trial_name: "active" });
    f.put("done/agent/trajectory.json", { hidden: true });
    const first = await f.snapshot();
    f.clear();
    f.advance();
    f.put("new/config.json", { trial_name: "new" });
    f.put("active/result.json", finished);
    const next = await f.snapshot();
    expect(next.trials.map((trial) => trial.trial_name)).toEqual([
      "active",
      "done",
      "new",
    ]);
    expect(next.trials[0]?.result?.finished_at).toBe(finished.finished_at);
    expect(next.trials[0]?.cost_usd).toBe(0);
    expect(next.trials[2]?.cost_usd).toBeNull();
    expect(next.observed_at).toBe(new Date(30_000).toISOString());
    expect(next.trials[1]?.observed_at).toBe(first.trials[1]?.observed_at);
    expect(next.trials[0]?.observed_at).toBe(next.observed_at);
    expect(f.listDirectory.mock.calls.map(([path]) => path)).not.toContain(
      `${base}done/`,
    );
    expect(
      vi
        .mocked(f.store.read)
        .mock.calls.every(([key]) => !key.startsWith(`${base}done/`)),
    ).toBe(true);
    f.clear();
    f.advance();
    await f.snapshot();
    expect(f.listDirectory.mock.calls.map(([path]) => path)).toEqual([
      base,
      `${base}new/`,
    ]);
    expect(f.store.read).not.toHaveBeenCalled();
    expect(f.store.list).not.toHaveBeenCalled();
  });

  it("keeps discovery and active checks fresh while completed evidence stays old", async () => {
    const f = fixture();
    f.put("done/result.json", finished);
    f.put("active/config.json", { trial_name: "active" });
    const first = await f.snapshot();
    f.clear();
    f.advance(90_000);
    const next = await f.snapshot();
    expect(next.observed_at).toBe(new Date(90_000).toISOString());
    expect(next.trials[0]?.observed_at).toBe(next.observed_at);
    expect(next.trials[1]?.observed_at).toBe(first.trials[1]?.observed_at);
    expect(f.store.read).not.toHaveBeenCalled();
    f.advance(1_000);
    expect((await f.snapshot()).observed_at).toBe(next.observed_at);
    expect((await f.snapshot()).trials).toEqual(next.trials);
  });

  it("reconciles corrections, missing results, and same-name replacements without renewing old evidence", async () => {
    const f = fixture();
    f.put("done/result.json", finished);
    f.put("done/config.json", { trial_name: "done" });
    const first = await f.snapshot();
    f.put("done/result.json", { ...finished, agent_result: { cost_usd: 0.5 } });
    f.advance();
    const retained = await f.snapshot();
    expect(retained.observed_at).toBe(new Date(30_000).toISOString());
    expect(retained.trials[0]?.observed_at).toBe(first.trials[0]?.observed_at);
    f.advance(270_000);
    expect((await f.snapshot()).trials[0]?.cost_usd).toBe(0.5);
    f.objects.delete(`${base}done/result.json`);
    f.advance(300_000);
    const missing = await f.snapshot();
    expect(missing.trials[0]?.result).toBeNull();
    expect(missing.trials[0]?.cost_usd).toBeNull();
    expect(missing.observed_at).toBe(new Date(600_000).toISOString());
    f.put("done/result.json", {
      ...finished,
      id: "replacement",
      verifier_result: { rewards: { reward: 1 } },
    });
    f.advance();
    expect((await f.snapshot()).trials[0]?.reward).toBe(1);
  });

  it("reconfirms unchanged completed hashes periodically without downloading them", async () => {
    const f = fixture();
    f.put("done/result.json", finished);
    await f.snapshot();
    f.clear();
    f.advance(300_000);
    const reconciled = await f.snapshot();
    expect(reconciled.observed_at).toBe(new Date(300_000).toISOString());
    expect(reconciled.trials[0]?.observed_at).toBe(reconciled.observed_at);
    expect(f.listDirectory.mock.calls.map(([path]) => path)).toEqual([
      base,
      `${base}done/`,
    ]);
    expect(f.store.read).not.toHaveBeenCalled();
  });

  it("removes disappeared directories immediately and does not resurrect their cached identity", async () => {
    const f = fixture();
    f.put("done/result.json", finished);
    await f.snapshot();
    f.objects.clear();
    f.advance();
    expect((await f.snapshot()).trials).toEqual([]);
    f.put("done/config.json", { trial_name: "done" });
    f.advance();
    expect((await f.snapshot()).trials[0]?.result).toBeNull();
  });

  it("rejects failed reconciliation and recovers cold, including all finished records", async () => {
    const f = fixture();
    f.put("done/result.json", finished);
    await f.snapshot();
    f.advance(300_000);
    vi.mocked(f.store.read).mockRejectedValueOnce(new Error("download failed"));
    f.put("done/result.json", { ...finished, task_name: "changed" });
    await expect(f.snapshot()).rejects.toThrow("download failed");
    f.clear();
    expect((await f.snapshot()).trials).toHaveLength(1);
    expect(f.store.read).toHaveBeenCalledWith(`${base}done/result.json`, {
      fresh: true,
    });
  });

  it("rejects same-length hash races and metadata changes rather than caching mismatched bytes", async () => {
    const f = fixture();
    f.put("active/config.json", { trial_name: "active" });
    vi.mocked(f.store.read).mockResolvedValueOnce(
      new TextEncoder().encode('{"trial_name":"broken"}'),
    );
    await expect(f.snapshot()).rejects.toThrow("Artifact changed");
    const original = f.store.read;
    vi.mocked(f.store.read).mockImplementationOnce(async (key) => {
      const bytes = f.objects.get(key);
      f.put("active/result.json", finished);
      if (!bytes) throw new Error("missing");
      return bytes;
    });
    await expect(f.snapshot()).rejects.toThrow("Artifact changed");
    expect(original).toHaveBeenCalled();
    expect((await f.snapshot()).trials[0]?.result?.finished_at).toBe(
      finished.finished_at,
    );
  });

  it.each(["lock.json", "active/config.json"])(
    "fences same-length Xet replacements of %s with a second metadata observation",
    async (path) => {
      const f = fixture();
      const json = JSON.stringify(
        path === "lock.json" ? { trials: [] } : { trial_name: "active" },
      );
      f.objects.set(`${base}${path}`, new TextEncoder().encode(`${json} `));
      const list = f.listDirectory.getMockImplementation();
      if (!list) throw new Error("Missing listing fixture");
      f.listDirectory.mockImplementation(async (...args) => {
        const value = await list(...args);
        return {
          ...value,
          files: value.files.map((file) => ({
            ...file,
            source_identity: `xet:${file.source_identity}`,
          })),
        };
      });
      vi.mocked(f.store.read).mockImplementationOnce(async (key) => {
        const before = f.objects.get(key);
        if (!before) throw new Error("Missing fixture artifact");
        f.objects.set(key, new TextEncoder().encode(` ${json}`));
        return before;
      });
      await expect(f.snapshot()).rejects.toThrow("Artifact changed");
      await expect(f.snapshot()).resolves.toBeDefined();
    },
  );

  it("bounds retained trial records without dropping response rows, and rebuilds after run eviction", async () => {
    const f = fixture({ maxTrials: 1, maxSnapshots: 1 });
    f.put("a/result.json", finished);
    f.put("b/result.json", finished);
    await f.snapshot();
    f.clear();
    f.advance();
    expect((await f.snapshot()).trials).toHaveLength(2);
    expect(f.listDirectory.mock.calls.map(([path]) => path)).not.toContain(`${base}a/`);
    expect(f.store.read).toHaveBeenCalledWith(`${base}b/result.json`, { fresh: true });
    await f.reader.snapshot(`run-${"b".repeat(24)}`, [], null);
    f.clear();
    await f.snapshot();
    expect(f.store.read).toHaveBeenCalledTimes(2);
  });

  it("timestamps slow reads at observation start, not response completion", async () => {
    const f = fixture();
    f.put("done/result.json", finished);
    vi.mocked(f.store.read).mockImplementationOnce(async (key) => {
      f.advance(90_000);
      return f.objects.get(key) ?? new Uint8Array();
    });
    const value = await f.snapshot();
    expect(value.observed_at).toBe(new Date(0).toISOString());
    expect(value.trials[0]?.observed_at).toBe(new Date(0).toISOString());
  });
});
