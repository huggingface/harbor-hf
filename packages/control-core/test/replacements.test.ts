import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalJson,
  runId,
  sha256,
  validateRunRecord,
  type RunRecordV1,
} from "@harbor-hf/contracts";
import {
  ControlService,
  FilesystemObjectStore,
  Projection,
  PresetCatalog,
  putJson,
  leaderboard,
  ReplacementEvidence,
  Replacements,
  replacementInput,
  reviewFingerprint,
  type ReplacementNativePort,
  type SourceBundle,
  type JobObservation,
  type ObjectStore,
} from "../src/index.js";

const revision = "d".repeat(40);
const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const third = "33333333-3333-4333-8333-333333333333";
const request = { trial_ids: [first], cost_ceiling_usd: 10 };
let root: string;
let store: FilesystemObjectStore;
let projection: Projection;
let service: ControlService;
let presets: PresetCatalog;
let source: RunRecordV1;
let jobs: JobObservation[];
let native: ReplacementNativePort;

function trial(id: string, cost: number | null = 1) {
  return {
    id,
    trial_name: `task-${id}`,
    agent_result: { cost_usd: cost },
    exception_info: { exception_type: "RuntimeError" },
    verifier_result: { rewards: { reward: 0 } },
  };
}
async function artifacts(
  record: RunRecordV1,
  trials = [trial(first), trial(second)],
  finished = true,
) {
  const prefix = `runs/${record.run_id}/job/`;
  await putJson(store, `${prefix}config.json`, record.harbor_job_config);
  await putJson(store, `${prefix}lock.json`, {});
  await putJson(store, `${prefix}result.json`, {
    id: record.run_id,
    n_total_trials: trials.length,
    finished_at: finished ? "2026-01-01T00:00:00Z" : null,
    stats: { cost_usd: 2 },
    trial_results: trials,
  });
  for (const result of trials)
    await putJson(store, `${prefix}${result.trial_name}/result.json`, result);
}
async function receipt(record: RunRecordV1, id: string, cost: number | null) {
  await putJson(store, `runs/${record.run_id}/attempt-costs/${id}.json`, {
    schema_version: "v1",
    attempt_id: id,
    trial_name: `task-${id}`,
    cost_usd: cost,
  });
}
function fingerprint(original: SourceBundle, trial_ids: string[]) {
  return `sha256:${sha256(canonicalJson({ original, trial_ids }))}`;
}
async function child(key = "replacement", input = request) {
  const validation = await service.validateReplacement(
    source.run_id,
    input,
    "operator",
  );
  return service.submitReplacement(
    source.run_id,
    { ...input, fingerprint: validation.fingerprint },
    key,
    "operator",
  );
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "replacement-test-"));
  store = new FilesystemObjectStore(join(root, "store"));
  projection = await Projection.open(join(root, "projection.sqlite"));
  presets = await PresetCatalog.load(resolve("presets"));
  vi.spyOn(presets, "leaderboardEligible").mockReturnValue(true);
  jobs = [];
  native = {
    replacementReview: vi.fn(async ({ original, trial_ids, run_id }) => ({
      harbor_revision: revision,
      tasks: trial_ids.length,
      agents: 1,
      trials: trial_ids.length,
      warnings: [],
      not_performed: ["Model inference"],
      credentials_available: true,
      fingerprint: fingerprint(original, trial_ids),
      effective_config: {
        ...original.config,
        job_name: run_id,
        n_attempts: 1,
        datasets: [],
        tasks: trial_ids.map((id) => ({ path: `tasks/${id}` })),
      },
    })),
    replacementAggregate: vi.fn(async ({ original }) => ({ result: original.result })),
  };
  service = new ControlService(
    store,
    projection,
    presets,
    {
      list: async () => jobs,
      inspect: async (id) => {
        const found = jobs.find((job) => job.id === id);
        if (!found) throw new Error("Unknown parent");
        return found;
      },
      cancel: async () => {
        throw new Error("No remote controls permitted");
      },
      startParent: async () => {
        throw new Error("No remote controls permitted");
      },
    },
    {
      replacements: native,
      harborRevision: revision,
      mountRoot: "/data",
      maxActiveJobs: 1,
      restartDelayMs: 0,
    },
  );
  source = (
    await service.submitPreset(
      {
        benchmark: { name: "terminal-bench-2-1", preset: "one-task-1-trial" },
        model: { id: "example/model", provider: "provider", reasoning_effort: "off" },
        harness: { agent: "pi", version: "0.84.4" },
        cost_ceiling_usd: 100,
      },
      "original",
      "operator",
    )
  ).run;
  await artifacts(source);
  await service.refresh();
});
afterEach(async () => {
  projection.close();
  await rm(root, { recursive: true, force: true });
});

describe("operator-reviewed replacement submission", () => {
  it("persists the native selection/config and no full-source pricing estimate", async () => {
    const before = await store.read(`runs/${source.run_id}/job/result.json`);
    const result = await child();
    expect(result.run.operator_selection).toEqual({
      original_run_id: source.run_id,
      trial_ids: [first],
      source_fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(result.run.harbor_job_config.tasks).toEqual([{ path: `tasks/${first}` }]);
    expect(result.run.pricing).toBeUndefined();
    expect(result.run.submission).toEqual({
      ...source.submission,
      cost_ceiling_usd: 10,
    });
    expect(await store.read(`runs/${source.run_id}/job/result.json`)).toEqual(before);
  });
  it("binds budget and fresh evidence, not only selected IDs", async () => {
    const validation = await service.validateReplacement(
      source.run_id,
      request,
      "operator",
    );
    await expect(
      service.submitReplacement(
        source.run_id,
        { ...request, cost_ceiling_usd: 11, fingerprint: validation.fingerprint },
        "changed-budget",
        "operator",
      ),
    ).rejects.toThrow("review again");
    await putJson(store, `runs/${source.run_id}/job/lock.json`, { changed: true });
    await expect(
      service.submitReplacement(
        source.run_id,
        { ...request, fingerprint: validation.fingerprint },
        "changed-source",
        "operator",
      ),
    ).rejects.toThrow("review again");
  });
  it("serializes overlapping batches while accepting disjoint selections", async () => {
    const validation = await service.validateReplacement(
      source.run_id,
      request,
      "operator",
    );
    const results = await Promise.allSettled(
      ["one", "two"].map((key) =>
        service.submitReplacement(
          source.run_id,
          { ...request, fingerprint: validation.fingerprint },
          key,
          "operator",
        ),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await child("disjoint", { ...request, trial_ids: [second] })).created).toBe(
      true,
    );
  });
  it("returns exact concurrent retries and repairs absent state before overlap/source checks", async () => {
    const validation = await service.validateReplacement(
      source.run_id,
      request,
      "operator",
    );
    const submit = () =>
      service.submitReplacement(
        source.run_id,
        { ...request, fingerprint: validation.fingerprint },
        "same",
        "operator",
      );
    const results = await Promise.all([submit(), submit()]);
    expect(results.map((result) => result.created)).toEqual([true, false]);
    await rm(join(store.root, `runs/${results[0]!.run.run_id}/state.json`));
    await putJson(store, `runs/${source.run_id}/job/lock.json`, { changed: true });
    expect((await submit()).created).toBe(false);
    expect(await store.read(`runs/${runId("same")}/state.json`)).toBeTruthy();
    await expect(
      service.submitReplacement(
        source.run_id,
        { ...request, fingerprint: validation.fingerprint },
        "same",
        "other-operator",
      ),
    ).rejects.toThrow("different request");
  });
  it("rejects reused source identity and non-native/duplicate selections", async () => {
    await expect(
      service.submitReplacement(
        source.run_id,
        { ...request, fingerprint: "a".repeat(64) },
        "original",
        "operator",
      ),
    ).rejects.toThrow("distinct");
    for (const trial_ids of [[], [first, first], ["task-name"]])
      await expect(
        service.validateReplacement(
          source.run_id,
          { ...request, trial_ids },
          "operator",
        ),
      ).rejects.toThrow("UUID");
    expect(
      replacementInput({ ...request, trial_ids: [second, first] }).trial_ids,
    ).toEqual([first, second]);
    expect(() =>
      replacementInput({ ...request, cost_ceiling_usd: Number.NaN }),
    ).toThrow();
  });
  it("refuses live child Jobs, incomplete native results and cost stops", async () => {
    jobs.push({
      id: "owned-trial",
      run_id: source.run_id,
      role: "trial",
      stage: "running",
      created_at: "2026-01-01T00:00:00Z",
      started_at: null,
      finished_at: null,
    });
    await expect(child()).rejects.toThrow("complete");
    jobs = [];
    await artifacts(source, [trial(first), trial(second)], false);
    await expect(child()).rejects.toThrow("complete");
    await artifacts(source, [trial(first, 101)]);
    await expect(child()).rejects.toThrow("complete");
  });
  it("passes the immutable ancestor chain to native review without recompiling", async () => {
    const replacement = (await child()).run;
    await artifacts(replacement, [trial(third)]);
    const validate = await service.validateReplacement(
      replacement.run_id,
      { ...request, trial_ids: [third] },
      "operator",
    );
    expect(validate.trials).toBe(1);
    expect(
      vi
        .mocked(native.replacementReview)
        .mock.lastCall?.[0].original_ancestors.map((item) => item.record.run_id),
    ).toEqual([source.run_id]);
    expect(
      vi.mocked(native.replacementReview).mock.lastCall?.[0].original.record,
    ).toEqual(replacement);
  });
  it("preserves Workbench display provenance and exact native execution configuration", async () => {
    source = { ...source, workbench_recipe: { name: "reviewed-recipe" } };
    await putJson(store, `runs/${source.run_id}/run.json`, source);
    const result = await child();
    expect(result.run.workbench_recipe).toEqual(source.workbench_recipe);
    expect(result.run.harbor_job_config.agents).toEqual(
      source.harbor_job_config.agents,
    );
  });
  it("keeps immutable selection strict while accepting old records", () => {
    expect(validateRunRecord(source)).toEqual(source);
    const selection = {
      original_run_id: source.run_id,
      trial_ids: [first],
      source_fingerprint: `sha256:${"a".repeat(64)}`,
    };
    expect(
      validateRunRecord({ ...source, operator_selection: selection })
        .operator_selection,
    ).toEqual(selection);
    for (const bad of [
      { ...selection, extra: true },
      { ...selection, trial_ids: [first, first] },
      { ...selection, trial_ids: ["not-a-uuid"] },
      { ...selection, source_fingerprint: "bad" },
      { ...selection, source_fingerprint: "a".repeat(64) },
    ])
      expect(() => validateRunRecord({ ...source, operator_selection: bad })).toThrow();
  });
});

describe("ephemeral native assembly", () => {
  it("exposes native UUIDs in the existing identity-only summary", () => {
    const identity = projection.trials(source.run_id, "identity")[0]!;
    expect(identity.result.id).toBe(first);
    expect(identity.result.exception_info).toEqual({ exception_type: "RuntimeError" });
    expect(identity.result.agent_result).toBeUndefined();
  });
  it("reports no assembly without children", async () => {
    const view = await service.replacements(source.run_id);
    expect(view.assembly).toEqual({ availability: "none", result: null });
    expect(view.incurred).toMatchObject({ cost_usd: 2, total_attempts: 2 });
  });
  it("withholds pending or invalid replacement membership from leaderboard", async () => {
    const replacement = (await child()).run;
    expect(leaderboard(projection, presets)).toEqual([]);
    expect((await service.replacements(source.run_id)).assembly.availability).toBe(
      "pending",
    );
    await artifacts(replacement, [trial(third)]);
    // A stale queued projection must not relabel rejected complete native evidence as pending.
    vi.mocked(native.replacementAggregate).mockRejectedValue(
      new Error("Native provenance rejected"),
    );
    const view = await service.replacements(source.run_id);
    expect(view.assembly.availability).toBe("unavailable");
    expect(leaderboard(projection, presets, new Map([[source.run_id, view]]))).toEqual(
      [],
    );
  });
  it("caches only native complete results, invalidates fresh evidence, rebuilds relations without cache", async () => {
    const replacement = (await child()).run;
    await artifacts(replacement, [trial(third)]);
    await service.refresh();
    const view = await service.replacements(source.run_id);
    expect(view.assembly.availability).toBe("available");
    await service.replacements(source.run_id);
    expect(native.replacementAggregate).toHaveBeenCalledTimes(1);
    await putJson(store, `runs/${replacement.run_id}/job/lock.json`, { updated: true });
    await service.replacements(source.run_id);
    expect(native.replacementAggregate).toHaveBeenCalledTimes(2);
    const rebuilt = new Replacements(store, projection, native, async () => {});
    expect((await rebuilt.view(source.run_id)).children).toEqual(view.children);
    await rm(join(store.root, `runs/${replacement.run_id}/job/lock.json`));
    expect((await service.replacements(source.run_id)).assembly.availability).toBe(
      "unavailable",
    );
  });
  it("keeps failed chosen outcomes, passes recursion to native, and counts receipts only once", async () => {
    const replacement = (await child()).run;
    await artifacts(replacement, [trial(third, null)]);
    await receipt(source, first, 1);
    const retry = "44444444-4444-4444-8444-444444444444";
    await receipt(source, retry, null);
    const validation = await service.validateReplacement(
      replacement.run_id,
      { ...request, trial_ids: [third] },
      "operator",
    );
    const descendant = (
      await service.submitReplacement(
        replacement.run_id,
        { ...request, trial_ids: [third], fingerprint: validation.fingerprint },
        "descendant",
        "operator",
      )
    ).run;
    const last = trial("55555555-5555-4555-8555-555555555555", 3);
    await artifacts(descendant, [last]);
    await service.refresh();
    vi.mocked(native.replacementAggregate).mockResolvedValue({
      result: {
        stats: { cost_usd: 4, evals: { native: { metrics: [{ mean: 0 }] } } },
        n_total_trials: 2,
        trial_results: [trial(second), last],
      },
    });
    const view = await service.replacements(source.run_id);
    expect(view.incurred).toEqual({
      cost_usd: 5,
      reported_attempts: 3,
      unknown_attempts: 2,
      total_attempts: 5,
    });
    expect(view.selected_cost_usd).toBe(4);
    expect(
      vi.mocked(native.replacementAggregate).mock.lastCall?.[0].parts[0]?.parts[0]
        ?.evidence.record.run_id,
    ).toBe(descendant.run_id);
    const rows = leaderboard(projection, presets, new Map([[source.run_id, view]]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      n_trials: 2,
      pass_rate: 0,
      cost_usd: 4,
      n_attempts: source.harbor_job_config.n_attempts ?? 1,
    });
    expect(projection.run(source.run_id)?.result?.stats).toEqual({ cost_usd: 2 });
  });
  it("reports unknown coverage on inconsistent receipts rather than a zero charge", async () => {
    await receipt(source, first, 99);
    expect((await service.replacements(source.run_id)).incurred).toBeNull();
  });
  it("rejects missing membership, mismatched paths, cycles and foreign records", async () => {
    const reader = new ReplacementEvidence(store);
    await putJson(store, `runs/${source.run_id}/job/unfinished/config.json`, {});
    await expect(reader.bundle(source.run_id)).rejects.toThrow("unfinished");
    await rm(join(store.root, `runs/${source.run_id}/job/unfinished`), {
      recursive: true,
    });
    await putJson(store, `runs/${source.run_id}/job/task-${first}/result.json`, {
      ...trial(first),
      trial_name: "foreign",
    });
    await expect(new ReplacementEvidence(store).bundle(source.run_id)).rejects.toThrow(
      "identity",
    );
    await artifacts(source);
    const bundle = await new ReplacementEvidence(store).bundle(source.run_id);
    bundle.record.operator_selection = {
      original_run_id: source.run_id,
      trial_ids: [first],
      source_fingerprint: `sha256:${"a".repeat(64)}`,
    };
    await expect(new ReplacementEvidence(store).ancestors(bundle)).rejects.toThrow(
      "Cyclic",
    );
    await expect(new ReplacementEvidence(store).bundle("invalid")).rejects.toThrow(
      "identity",
    );
    await putJson(store, `runs/${source.run_id}/run.json`, {
      ...source,
      run_id: runId("foreign"),
    });
    await expect(new ReplacementEvidence(store).records()).rejects.toThrow("identity");
  });
  it("uses a canonical budget fingerprint", () => {
    expect(reviewFingerprint("a", { ...request, trial_ids: [first, second] })).toBe(
      reviewFingerprint("a", { ...request, trial_ids: [second, first] }),
    );
    expect(reviewFingerprint("a", request)).not.toBe(reviewFingerprint("b", request));
  });
});

describe("bounded evidence and failure coverage", () => {
  it("rejects oversized or non-object native JSON and unknown runs", async () => {
    await putJson(store, "oversized.json", { data: "x".repeat(33 * 1024 * 1024) });
    await expect(new ReplacementEvidence(store).read("oversized.json")).rejects.toThrow(
      "limit",
    );
    await putJson(store, "array.json", []);
    await expect(new ReplacementEvidence(store).read("array.json")).rejects.toThrow(
      "unavailable",
    );
    await expect(service.replacements(runId("absent"))).rejects.toThrow("not found");
  });
  it("refuses an unknown recorded parent even when the listing is empty", async () => {
    const state = projection.run(source.run_id)!.state;
    await putJson(store, `runs/${source.run_id}/state.json`, {
      ...state,
      parent_jobs: [{ id: "unobserved-parent", started_at: state.updated_at }],
    });
    await expect(child()).rejects.toThrow("Unknown parent");
  });
  it("refuses native review failure, revision mismatch and unavailable credentials", async () => {
    const review = native.replacementReview;
    vi.mocked(native.replacementReview).mockRejectedValueOnce(
      new Error("Native coverage rejected"),
    );
    await expect(child()).rejects.toThrow("coverage");
    const normal = await review({
      original: await new ReplacementEvidence(store).bundle(source.run_id),
      original_ancestors: [],
      trial_ids: [first],
      run_id: runId("replacement"),
      local_root: "/data",
    });
    vi.mocked(native.replacementReview).mockResolvedValueOnce({
      ...normal,
      harbor_revision: "e".repeat(40),
    });
    await expect(child()).rejects.toThrow("revision");
    vi.mocked(native.replacementReview).mockResolvedValue({
      ...normal,
      credentials_available: false,
    });
    await expect(child()).rejects.toThrow("credentials");
  });
  it("bounds the assembly cache by bytes and does not cache oversized output", async () => {
    const replacement = (await child()).run;
    await artifacts(replacement, [trial(third)]);
    const view = new Replacements(store, projection, native, async () => {});
    vi.mocked(native.replacementAggregate).mockResolvedValue({
      result: {
        stats: { cost_usd: null },
        trial_results: [],
        padding: "x".repeat(33 * 1024 * 1024),
      },
    });
    expect((await view.view(source.run_id)).selected_cost_usd).toBeNull();
    await view.view(source.run_id);
    expect(native.replacementAggregate).toHaveBeenCalledTimes(2);
    vi.mocked(native.replacementAggregate).mockResolvedValue({
      result: { stats: { cost_usd: null }, trial_results: [] },
    });
    for (let index = 0; index < 9; index++) {
      const record = { ...source, run_id: runId(`cache-root-${index}`) };
      const part = {
        ...replacement,
        run_id: runId(`cache-part-${index}`),
        operator_selection: {
          ...replacement.operator_selection!,
          original_run_id: record.run_id,
        },
      };
      await putJson(store, `runs/${record.run_id}/run.json`, record);
      await putJson(store, `runs/${part.run_id}/run.json`, part);
      await artifacts(record);
      await artifacts(part, [trial(third)]);
      expect((await view.view(record.run_id)).assembly.availability).toBe("available");
    }
    await view.view(runId("cache-root-0"));
    expect(native.replacementAggregate).toHaveBeenCalledTimes(12);
  });
  it("marks duplicate descendant receipt IDs as unknown and cyclic relationships fail closed", async () => {
    const replacement = (await child()).run;
    await receipt(source, first, 1);
    await receipt(replacement, first, 1);
    expect((await service.replacements(source.run_id)).incurred).toBeNull();
    const cyclic = {
      ...source,
      operator_selection: {
        original_run_id: replacement.run_id,
        trial_ids: [third],
        source_fingerprint: `sha256:${"a".repeat(64)}`,
      },
    };
    await putJson(store, `runs/${source.run_id}/run.json`, cyclic);
    await expect(service.replacements(source.run_id)).rejects.toThrow("Cyclic");
  });
});

describe("native leaderboard metric authority", () => {
  it("retains a failed chosen outcome in Harbor's native mean denominator", async () => {
    const replacement = (await child()).run;
    await artifacts(replacement, [trial(third)]);
    await service.refresh();
    const selected = [
      { ...trial(second), verifier_result: { rewards: { reward: 1 } } },
      { ...trial(third), verifier_result: null },
    ];
    vi.mocked(native.replacementAggregate).mockResolvedValue({
      result: {
        n_total_trials: 2,
        trial_results: selected,
        stats: { cost_usd: null, evals: { native: { metrics: [{ mean: 0.5 }] } } },
      },
    });
    const view = await service.replacements(source.run_id);
    const rows = leaderboard(projection, presets, new Map([[source.run_id, view]]));
    expect(rows[0]).toMatchObject({ n_trials: 2, pass_rate: 0.5, cost_usd: null });
    // Native multi-metric results remain available, but the old scalar public
    // leaderboard cannot reinterpret an arbitrary metric as a pass rate.
    view.assembly.result = {
      ...view.assembly.result,
      stats: { evals: { native: { metrics: [{ custom_score: 7 }] } } },
    };
    expect(leaderboard(projection, presets, new Map([[source.run_id, view]]))).toEqual(
      [],
    );
  });
  it("accepts only a single finite scalar mean, including real native metric output", async () => {
    const metrics = JSON.parse(
      await readFile(new URL("./fixtures/native-mean.json", import.meta.url), "utf8"),
    );
    expect(metrics.multi_reward).toEqual({ mean: 0.9, accuracy: 0.1 });
    const replacement = (await child()).run;
    await artifacts(replacement, [trial(third)]);
    await service.refresh();
    const selected = [trial(second), { ...trial(third), verifier_result: null }];
    vi.mocked(native.replacementAggregate).mockResolvedValue({
      result: {
        n_total_trials: 2,
        trial_results: selected,
        stats: { evals: { native: { metrics: [metrics.single] } } },
      },
    });
    const view = await service.replacements(source.run_id);
    const views = new Map([[source.run_id, view]]);
    expect(leaderboard(projection, presets, views)[0]).toMatchObject({
      pass_rate: 0.5,
      n_trials: 2,
    });
    for (const evals of [
      { native: { metrics: [metrics.multi_reward] } },
      { native: { metrics: [{ mean: 0.9 }, { accuracy: 0.1 }] } },
      { native: { metrics: [{ mean: 0.9 }, { mean: 0.1 }] } },
      { native: { metrics: [{ mean: 0.9 }, {}] } },
      { native: { metrics: [{ custom_score: 7 }] } },
      { native: { metrics: [{ mean: 0.9, custom: "extra" }] } },
      { native: { metrics: [{ mean: Number.NaN }] } },
      { native: { metrics: [{ mean: Number.POSITIVE_INFINITY }] } },
      { native: { metrics: [{ mean: "0.9" }] } },
      { native: { metrics: [] } },
      { native: { metrics: [null] } },
      { native: { metrics: [{ mean: 0.9 }] }, other: { metrics: [{ mean: 0.1 }] } },
    ]) {
      view.assembly.result = {
        n_total_trials: 2,
        trial_results: selected,
        stats: { evals },
      };
      expect(leaderboard(projection, presets, views)).toEqual([]);
      // Withholding the scalar row never discards selected failed evidence.
      expect(view.assembly.result.trial_results).toBe(selected);
    }
  });
  it("withholds relationships from fresh records even before projection repair", async () => {
    const records = await new ReplacementEvidence(store).records();
    records.push({
      ...source,
      run_id: runId("unprojected-subset"),
      operator_selection: {
        original_run_id: source.run_id,
        trial_ids: [first],
        source_fingerprint: `sha256:${"a".repeat(64)}`,
      },
    });
    expect(leaderboard(projection, presets, new Map(), records)).toEqual([]);
  });
});

describe("incurred identity integrity", () => {
  it("does not count a reused native trial ID twice across runs", async () => {
    const replacement = (await child()).run;
    await artifacts(replacement, [trial(first)]);
    expect((await service.replacements(source.run_id)).incurred).toBeNull();
  });
});

it("loads a large native result cohort with bounded fresh JSON reads only", async () => {
  await rm(join(store.root, `runs/${source.run_id}/job`), { recursive: true });
  const trials = Array.from({ length: 445 }, (_, index) => ({
    ...trial(`${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`),
    exception_info: {
      exception_type: "RuntimeError",
      exception_traceback: "x".repeat(11_000),
    },
  }));
  await artifacts(source, trials);
  await putJson(
    store,
    `runs/${source.run_id}/job/${trials[0]!.trial_name}/irrelevant.json`,
    { ignored: true },
  );
  const read = store.read.bind(store);
  let active = 0;
  let maximum = 0;
  const observed: string[] = [];
  vi.spyOn(store, "read").mockImplementation(async (key) => {
    observed.push(key);
    maximum = Math.max(maximum, ++active);
    try {
      return await read(key);
    } finally {
      active--;
    }
  });
  const bundle = await new ReplacementEvidence(store).bundle(source.run_id);
  expect(bundle.trials).toHaveLength(445);
  expect(maximum).toBeLessThanOrEqual(8);
  expect(observed).toHaveLength(449);
  expect(observed.some((key) => key.includes("irrelevant"))).toBe(false);
});

it("does not authorize a completed source using stale cached state", async () => {
  const path = `runs/${source.run_id}/state.json`;
  const cached = await store.read(path);
  await putJson(store, path, {
    ...projection.run(source.run_id)!.state,
    desired_state: "paused",
  });
  const read = store.read.bind(store);
  vi.spyOn(store as ObjectStore, "read").mockImplementation(async (key, options) =>
    key === path && !options?.fresh ? cached : read(key),
  );
  await expect(child()).rejects.toThrow("complete");
});
