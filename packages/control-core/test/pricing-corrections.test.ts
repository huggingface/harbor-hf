import { mkdtemp, rm } from "node:fs/promises";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { validateRunPricingCorrections, type RunRecordV1 } from "@harbor-hf/contracts";
import {
  ControlService,
  FilesystemObjectStore,
  Projection,
  type PresetCatalog,
  putJson,
  pricingCorrectionsPath,
  PricingConflictError,
  PricingUpdateError,
  leaderboard,
} from "../src/index.js";

const id = "run-0123456789abcdef01234567";
const rates = {
  currency: "USD",
  input_usd_per_million: 2,
  output_usd_per_million: 8,
  cached_usd_per_million: 0.5,
} as const;
const record: RunRecordV1 = {
  schema_version: "v1",
  run_id: id,
  created_at: "2026-01-01T00:00:00Z",
  submitted_by: "fixture-actor",
  role: "final",
  harbor_revision: "d".repeat(40),
  pricing: { ...rates, output_usd_per_million: 0.5, cached_usd_per_million: 8 },
  submission: {
    benchmark: { name: "fixture-benchmark", preset: "fixture-preset" },
    model: { id: "publisher/model", provider: "provider", reasoning_effort: "off" },
    harness: { agent: "fixture-agent", version: "1" },
    cost_ceiling_usd: 100,
  },
  harbor_job_config: { n_attempts: 1 },
};
let root: string;
let store: FilesystemObjectStore;
let projection: Projection;
let service: ControlService;
const jobs = { list: vi.fn(async () => []), startParent: vi.fn(), cancel: vi.fn() };
const presets = { leaderboardEligible: () => true } as unknown as PresetCatalog;
const request = (expected_revision = 0) => ({
  expected_revision,
  pricing: rates,
  reason: "Correct output/cache transposition",
});
const view = () => {
  const value = projection.run(id);
  if (!value) throw new Error("missing fixture run");
  return value;
};
beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), "pricing-corrections-"));
  store = new FilesystemObjectStore(join(root, "bucket"));
  projection = await Projection.open(join(root, "projection.sqlite"));
  service = new ControlService(store, projection, presets, jobs, {
    harborRevision: "d".repeat(40),
    mountRoot: "/data",
    maxActiveJobs: 1,
    restartDelayMs: 0,
  });
  await putJson(store, `runs/${id}/run.json`, record);
  await putJson(store, `runs/${id}/state.json`, {
    schema_version: "v1",
    run_id: id,
    revision: 0,
    updated_at: record.created_at,
    actor: "fixture-actor",
    desired_state: "run",
    parent_jobs: [],
  });
  await putJson(store, `runs/${id}/job/result.json`, {
    finished_at: record.created_at,
    n_total_trials: 1,
    stats: {
      n_input_tokens: 1000000,
      n_output_tokens: 100000,
      n_cache_tokens: 250000,
      cost_usd: 77,
    },
  });
  await putJson(store, `runs/${id}/job/example/result.json`, {
    trial_name: "example",
    agent_result: { cost_usd: 77 },
    verifier_result: { rewards: { reward: 1 } },
  });
  await service.initialize();
  jobs.list.mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  projection.close();
  await rm(root, { recursive: true, force: true });
});

it("corrects shared list/detail/board, preserves all launch/native/control bytes and replays after cache loss", async () => {
  const before = await store.list("runs");
  const original = view();
  const history = await service.correctPricing(id, request(), "fixture-editor");
  expect(history.revisions[0]).toMatchObject({
    revision: 1,
    actor: "fixture-editor",
    reason: request().reason,
    pricing: rates,
  });
  expect(Number.isFinite(Date.parse(history.revisions[0]?.updated_at ?? ""))).toBe(
    true,
  );
  expect(view()).toMatchObject({
    record: original.record,
    state: original.state,
    result: original.result,
    status: original.status,
    shared_estimate: { basis: "corrected_rates_reported_usage", cost_usd: 2.425 },
  });
  const reads = vi.spyOn(store, "read");
  expect(projection.listRuns()[0]?.shared_estimate).toEqual(view().shared_estimate);
  expect(leaderboard(projection, presets)[0]).toMatchObject({
    cost_usd: 77,
    pass_rate: 1,
    shared_estimate: { basis: "effective_rates_reported_usage", cost_usd: 2.425 },
  });
  expect(reads).not.toHaveBeenCalled();
  reads.mockRestore();
  expect(
    (await store.list("runs")).filter(
      (entry) => entry.key !== pricingCorrectionsPath(id),
    ),
  ).toEqual(before);
  expect(jobs.list).not.toHaveBeenCalled();
  expect(jobs.startParent).not.toHaveBeenCalled();
  expect(jobs.cancel).not.toHaveBeenCalled();
  const replay = await Projection.open(join(root, "replay.sqlite"));
  try {
    await replay.rebuild(store, []);
    expect(replay.run(id)).toEqual(view());
  } finally {
    replay.close();
  }
});

it("allows explicitly added historical rates without inventing launch metadata", async () => {
  const { pricing: _, ...unpriced } = record;
  await putJson(store, `runs/${id}/run.json`, unpriced);
  await service.refresh();
  expect(view().shared_estimate?.unavailable_reason).toBe("pricing_unset");
  await service.correctPricing(id, request(), "fixture-editor");
  expect(view().record).not.toHaveProperty("pricing");
  expect(view().shared_estimate?.cost_usd).toBe(2.425);
});

it("serializes concurrent edits; stale and ambiguous retries synchronize without appending twice", async () => {
  const outcomes = await Promise.allSettled([
    service.correctPricing(id, request(), "fixture-a"),
    service.correctPricing(id, request(), "fixture-b"),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  expect(view().pricing_corrections?.revisions).toHaveLength(1);
  await expect(
    service.correctPricing(id, request(), "fixture-a"),
  ).rejects.toBeInstanceOf(PricingConflictError);
  await service.correctPricing(id, request(1), "fixture-b");
  expect(view().pricing_corrections?.revisions).toHaveLength(2);
});

it.each(["write-before", "write-after", "projection-after"])(
  "fails closed on %s crash and recovers durable state on manual retry",
  async (failure) => {
    const put = store.put.bind(store);
    if (failure.startsWith("write"))
      vi.spyOn(store, "put").mockImplementationOnce(async (key, bytes) => {
        if (failure === "write-after") await put(key, bytes);
        throw new Error("private-error");
      });
    else {
      const update = projection.pricing.update.bind(projection.pricing);
      vi.spyOn(projection.pricing, "update")
        .mockImplementationOnce(update)
        .mockImplementationOnce(() => {
          throw new Error("private-error");
        });
    }
    await expect(
      service.correctPricing(id, request(), "fixture-editor"),
    ).rejects.toBeInstanceOf(PricingUpdateError);
    expect(view().shared_estimate).toMatchObject({
      cost_usd: null,
      unavailable_reason: "correction_history_unavailable",
    });
    if (failure === "write-before")
      await service.correctPricing(id, request(), "fixture-editor");
    else
      await expect(
        service.correctPricing(id, request(), "fixture-editor"),
      ).rejects.toBeInstanceOf(PricingConflictError);
    expect(view().pricing_corrections?.revisions).toHaveLength(1);
    expect(view().pricing_corrections_available).toBe(true);
  },
);

it.each(["json", "identity", "sequence", "read", "deleted", "rewritten"])(
  "isolates %s invalid history from execution, never falls back or overwrites it",
  async (failure) => {
    const history = await service.correctPricing(id, request(), "fixture-editor");
    if (failure === "json")
      await store.put(pricingCorrectionsPath(id), new TextEncoder().encode("{"));
    if (failure === "identity")
      await putJson(store, pricingCorrectionsPath(id), {
        ...history,
        run_id: `run-${"a".repeat(24)}`,
      });
    if (failure === "sequence")
      await putJson(store, pricingCorrectionsPath(id), {
        ...history,
        revisions: [{ ...history.revisions[0], revision: 2 }],
      });
    if (failure === "deleted") await rm(join(store.root, pricingCorrectionsPath(id)));
    if (failure === "rewritten")
      await putJson(store, pricingCorrectionsPath(id), {
        ...history,
        revisions: [{ ...history.revisions[0], reason: "rewritten" }],
      });
    if (failure === "read") {
      const read = store.read.bind(store);
      vi.spyOn(store, "read").mockImplementation(async (key) => {
        if (key === pricingCorrectionsPath(id)) throw new Error("unreadable");
        return read(key);
      });
    }
    await service.refresh();
    expect(view().status).toBe("finished");
    expect(view().shared_estimate?.unavailable_reason).toBe(
      "correction_history_unavailable",
    );
    expect(leaderboard(projection, presets)[0]?.shared_estimate?.cost_usd).toBeNull();
    const writes = vi.spyOn(store, "put");
    await expect(
      service.correctPricing(id, request(1), "fixture-editor"),
    ).rejects.toBeInstanceOf(PricingUpdateError);
    expect(writes).not.toHaveBeenCalled();
  },
);

it("fences an old rebuild across the first durable correction and unavailable cache transitions", async () => {
  const load = projection.pricing.load.bind(projection.pricing);
  let release!: () => void;
  let captured!: () => void;
  const ready = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(projection.pricing, "load").mockImplementationOnce(async (...args) => {
    const value = await load(...args);
    captured();
    await barrier;
    return value;
  });
  const rebuild = projection.rebuild(store, []);
  await ready;
  await service.correctPricing(id, request(), "fixture-editor");
  projection.pricing.unavailable(id);
  release();
  await rebuild;
  expect(view().pricing_corrections?.revisions).toHaveLength(1);
  expect(view().pricing_corrections_available).toBe(false);
  await service.refresh();
  expect(view().pricing_corrections_available).toBe(true);
});

it.each([
  { reason: " " },
  { actor: "client-forgery" },
  { updated_at: "2026-01-01" },
  { expected_revision: -1 },
  { expected_revision: 0.5 },
  { pricing: { ...rates, output_usd_per_million: -1 } },
  { pricing: { ...rates, cached_usd_per_million: null } },
  { pricing: { ...rates, input_usd_per_million: Infinity } },
])("rejects untrusted correction request %j before writes", async (override) => {
  const put = vi.spyOn(store, "put");
  await expect(
    service.correctPricing(id, { ...request(), ...override }, "fixture-editor"),
  ).rejects.toThrow();
  expect(put).not.toHaveBeenCalled();
});

it("bounds append history and rejects missing sequence entries", () => {
  expect(() =>
    validateRunPricingCorrections({ schema_version: "v1", run_id: id, revisions: [] }),
  ).toThrow();
  expect(() =>
    validateRunPricingCorrections({
      schema_version: "v1",
      run_id: id,
      revisions: Array.from({ length: 1001 }, (_, index) => ({
        revision: index + 1,
        actor: "fixture-editor",
        updated_at: record.created_at,
        reason: "correct",
        pricing: rates,
      })),
    }),
  ).toThrow();
});

it("conflict synchronization failure remains unavailable until a valid refresh, never loses the durable revision", async () => {
  await service.correctPricing(id, request(), "fixture-editor");
  const persisted = await store.read(pricingCorrectionsPath(id));
  vi.spyOn(projection.pricing, "update").mockImplementationOnce(() => {
    throw new Error("failed synchronization");
  });
  await expect(
    service.correctPricing(id, request(), "fixture-editor"),
  ).rejects.toBeInstanceOf(PricingUpdateError);
  expect(view().pricing_corrections_available).toBe(false);
  expect(await store.read(pricingCorrectionsPath(id))).toEqual(persisted);
  await service.refresh();
  expect(view().pricing_corrections?.revisions).toHaveLength(1);
  expect(view().pricing_corrections_available).toBe(true);
});

it("a later rebuild fences an older failed read, including null history at equal revision", async () => {
  let release!: () => void;
  let captured!: () => void;
  const ready = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(projection.pricing, "load").mockImplementationOnce(async () => {
    captured();
    await barrier;
    return { pricing_corrections: null, pricing_corrections_available: false };
  });
  const old = service.refresh();
  await ready;
  await service.refresh();
  release();
  await old;
  expect(view().pricing_corrections).toBeNull();
  expect(view().pricing_corrections_available).toBe(true);
});

it("a failed projection rebuild transaction cannot erase a saved correction", async () => {
  await service.correctPricing(id, request(), "fixture-editor");
  const saved = view();
  vi.spyOn(projection.pricing, "write").mockImplementationOnce(() => {
    throw new Error("crash in rebuild transaction");
  });
  await expect(service.refresh()).rejects.toThrow("crash");
  expect(view()).toEqual(saved);
  await service.refresh();
  expect(view()).toEqual(saved);
});

it("fails closed even when every SQL correction write including the unavailable marker fails", async () => {
  const update = projection.pricing.update.bind(projection.pricing);
  const write = vi.spyOn(projection.pricing, "write");
  vi.spyOn(projection.pricing, "update")
    .mockImplementationOnce(update)
    .mockImplementationOnce(() => {
      write.mockImplementation(() => {
        throw new Error("SQL writes unavailable");
      });
      throw new Error("SQL writes unavailable");
    });
  await expect(
    service.correctPricing(id, request(), "fixture-editor"),
  ).rejects.toBeInstanceOf(PricingUpdateError);
  expect(view().pricing_corrections_available).toBe(false);
  expect(view().shared_estimate?.cost_usd).toBeNull();
  await expect(
    service.correctPricing(id, request(), "fixture-editor"),
  ).rejects.toBeInstanceOf(PricingUpdateError);
  expect(view().shared_estimate?.cost_usd).toBeNull();
  write.mockRestore();
  await service.refresh();
  expect(view().pricing_corrections?.revisions).toHaveLength(1);
  expect(view().shared_estimate?.cost_usd).toBe(2.425);
});

it.each([
  ["invalid", "later-read"],
  ["unreadable", "later-read"],
  ["invalid", "transaction"],
  ["unreadable", "transaction"],
])(
  "fences %s canonical history even when rebuild fails at %s",
  async (historyFailure, rebuildFailure) => {
    const history = await service.correctPricing(id, request(), "fixture-editor");
    const other = `run-${"f".repeat(24)}`;
    await putJson(store, `runs/${other}/run.json`, { ...record, run_id: other });
    await putJson(
      store,
      `runs/${other}/state.json`,
      JSON.parse(new TextDecoder().decode(await store.read(`runs/${id}/state.json`))),
    );
    if (historyFailure === "invalid")
      await store.put(pricingCorrectionsPath(id), new TextEncoder().encode("{"));
    const read = store.read.bind(store);
    const reads = vi.spyOn(store, "read").mockImplementation(async (key, options) => {
      if (historyFailure === "unreadable" && key === pricingCorrectionsPath(id))
        throw new Error("unreadable history");
      if (rebuildFailure === "later-read" && key === `runs/${other}/run.json`)
        throw new Error("later run read failed");
      return read(key, options);
    });
    // Also fail the best-effort unavailable SQL write: the external fence alone
    // must mask old available SQL after the transaction rolls back.
    const writes = vi.spyOn(projection.pricing, "write").mockImplementation(() => {
      throw new Error("transaction write failed");
    });
    await expect(service.refresh()).rejects.toThrow(
      rebuildFailure === "later-read"
        ? "later run read failed"
        : "transaction write failed",
    );
    expect(view().pricing_corrections).toEqual(history);
    expect(view().shared_estimate).toMatchObject({
      cost_usd: null,
      unavailable_reason: "correction_history_unavailable",
    });
    expect(leaderboard(projection, presets)[0]?.shared_estimate?.cost_usd).toBeNull();
    expect(view().status).toBe("finished");
    reads.mockRestore();
    writes.mockRestore();
    await putJson(store, pricingCorrectionsPath(id), history);
    await service.refresh();
    expect(view().shared_estimate?.cost_usd).toBe(2.425);
  },
);

it.each(["sync", "rebuild"])(
  "an older actual failed canonical read cannot invalidate a newer valid %s",
  async (newer) => {
    let release!: () => void;
    let captured!: () => void;
    const ready = new Promise<void>((resolve) => {
      captured = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = store.read.bind(store);
    let blocked = false;
    vi.spyOn(store, "read").mockImplementation(async (key, options) => {
      if (key === pricingCorrectionsPath(id) && !blocked) {
        blocked = true;
        captured();
        await barrier;
        throw new Error("older read failed");
      }
      return read(key, options);
    });
    const old = service.refresh();
    await ready;
    if (newer === "sync") await service.correctPricing(id, request(), "fixture-editor");
    else await service.refresh();
    const saved = view();
    release();
    await old;
    expect(view()).toEqual(saved);
    expect(view().pricing_corrections_available).toBe(true);
  },
);

it.each(["malformed", "empty", "schema", "sequence", "identity"])(
  "isolates %s disposable pricing corruption and repairs through native reconciliation",
  async (corruption) => {
    const history = await service.correctPricing(id, request(), "fixture-editor");
    const original = view();
    const bodies: Record<string, string> = {
      malformed: "{",
      empty: "",
      schema: JSON.stringify({ ...history, revisions: [] }),
      sequence: JSON.stringify({
        ...history,
        revisions: [{ ...history.revisions[0], revision: 2 }],
      }),
      identity: JSON.stringify({ ...history, run_id: `run-${"a".repeat(24)}` }),
    };
    const db = new Database(join(root, "projection.sqlite"));
    try {
      db.prepare(
        "UPDATE runs SET pricing_corrections_body = ?, pricing_corrections_available = 1 WHERE run_id = ?",
      ).run(bodies[corruption], id);
    } finally {
      db.close();
    }
    expect(view()).toMatchObject({
      record: original.record,
      state: original.state,
      result: original.result,
      status: original.status,
      pricing_corrections: null,
      pricing_corrections_available: false,
      shared_estimate: {
        cost_usd: null,
        unavailable_reason: "correction_history_unavailable",
      },
    });
    expect(projection.pricing.read(id)).toEqual({
      pricing_corrections: null,
      pricing_corrections_available: false,
    });
    expect(projection.listRuns()).toHaveLength(1);
    expect(leaderboard(projection, presets)[0]?.shared_estimate?.cost_usd).toBeNull();
    await service.reconcile();
    expect(view()).toEqual(original);
    await service.setDesiredState(id, "paused", "fixture-actor");
    expect(view().state.desired_state).toBe("paused");
    expect(view().pricing_corrections).toEqual(history);
    expect(view().shared_estimate?.cost_usd).toBe(2.425);
    expect(jobs.startParent).not.toHaveBeenCalled();
  },
);
