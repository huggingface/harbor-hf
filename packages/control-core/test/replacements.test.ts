import { randomUUID } from "node:crypto";
import { fixture, image } from "./inference-fixture.js";
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
  InferenceRegistry,
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
let listJobs: () => Promise<JobObservation[]>;
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
  listJobs = vi.fn(async () => jobs);
  service = new ControlService(
    store,
    projection,
    presets,
    {
      list: listJobs,
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
    await service.refresh();
    // A refreshed complete projection still requires native provenance validation.
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
    await service.refresh();
    await service.replacements(source.run_id);
    expect(native.replacementAggregate).toHaveBeenCalledTimes(2);
    const rebuilt = new Replacements(store, projection, native);
    expect((await rebuilt.view(source.run_id)).children).toEqual(view.children);
    await rm(join(store.root, `runs/${replacement.run_id}/job/lock.json`));
    await service.refresh();
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
    await expect(service.refresh()).rejects.toThrow();
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
    await service.refresh();
    const view = new Replacements(store, projection, native);
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
      await putJson(
        store,
        `runs/${record.run_id}/state.json`,
        projection.run(source.run_id)!.state,
      );
      await putJson(
        store,
        `runs/${part.run_id}/state.json`,
        projection.run(replacement.run_id)!.state,
      );
      await service.refresh();
      expect((await view.view(record.run_id)).assembly.availability).toBe("available");
    }
    await view.view(runId("cache-root-0"));
    expect(native.replacementAggregate).toHaveBeenCalledTimes(12);
  });
  it("marks duplicate descendant receipt IDs as unknown and cyclic relationships fail closed", async () => {
    const replacement = (await child()).run;
    await receipt(source, first, 1);
    await receipt(replacement, first, 1);
    await service.refresh();
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
    await service.refresh();
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
    await service.refresh();
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
  const list = vi.spyOn(store, "listDirectory");
  const bundle = await new ReplacementEvidence(store).bundle(source.run_id);
  expect(list.mock.calls).toEqual([[`runs/${source.run_id}/job/`, []]]);
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

it("reviews real compiled inference scope for a new image before normal replacement validation and submission", async () => {
  const currentImage = image.replace(/a{64}$/, "b".repeat(64));
  const previous = new InferenceRegistry(
    store,
    image,
    () => true,
    () => new Date(),
    randomUUID,
  );
  const registration = await previous.register(
    {
      expected_revision: 0,
      source_env: "MY_SECRET_KEY",
      label: "Example",
      reason: "Register",
    },
    "operator",
  );
  const ref = registration.bindings[0]!.ref;
  const recipe = fixture().recipe;
  recipe.environment[0]!.credential_ref = ref;
  const grant = await previous.review(
    ref,
    {
      expected_revision: 1,
      recipe,
      model_name: "example:native",
      base_url: null,
      allowed_hosts: [],
    },
    "operator",
  );
  await previous.approve(
    ref,
    {
      expected_revision: 1,
      review_id: grant.review_id,
      reviewed_confirmation: true,
      reason: "Approve",
    },
    "operator",
  );
  const agent = (await previous.policy()).compile(
    recipe,
    "operator",
    image,
    "example:native",
    () => true,
  );
  source.harbor_job_config.agents = [agent];
  source.workbench_recipe = { name: recipe.name };
  await putJson(store, `runs/${source.run_id}/run.json`, source);
  await artifacts(source);
  const registry = new InferenceRegistry(
    store,
    currentImage,
    () => true,
    () => new Date(),
    randomUUID,
  );
  const start = vi.fn(async () => {
    throw new Error("Execution not permitted");
  });
  service = new ControlService(
    store,
    projection,
    presets,
    { list: async () => [], inspect: start, cancel: start, startParent: start },
    {
      replacements: native,
      harborRevision: revision,
      mountRoot: "/data",
      maxActiveJobs: 1,
      restartDelayMs: 0,
      inference: {
        policy: () => registry.policy(),
        sequence: (op) => registry.sequence(op),
        image: currentImage,
        present: () => true,
        start,
      },
    },
  );
  await expect(child()).rejects.toThrow("not reviewed");
  const reviewed = await registry.reviewRun(source.run_id, "operator", revision);
  if (reviewed.binding !== "named") throw new Error("Expected named review");
  await registry.approve(
    ref,
    {
      expected_revision: reviewed.revision,
      review_id: reviewed.review_id,
      reviewed_confirmation: true,
      reason: "Reviewed current image",
    },
    "operator",
  );
  const replacement = await child();
  expect(replacement.run.harbor_job_config.agents).toEqual([agent]);
  expect(replacement.run.workbench_recipe).toEqual(source.workbench_recipe);
  expect((await child()).created).toBe(false);
  expect(start).not.toHaveBeenCalled();
});

it("uses the real service display path without provider calls or trial downloads and warms without Bucket I/O", async () => {
  const replacement = (await child()).run;
  await artifacts(replacement, [trial(third)]);
  await receipt(source, first, 1);
  await receipt(source, "44444444-4444-4444-8444-444444444444", null);
  await service.refresh();
  vi.mocked(listJobs)
    .mockClear()
    .mockRejectedValue(new Error("Display must not fetch Jobs"));
  const read = vi.spyOn(store, "read");
  const list = vi.spyOn(store, "listDirectory");
  const view = await service.replacements(source.run_id);
  expect(view.assembly.availability).toBe("available");
  expect(view.incurred).toMatchObject({ total_attempts: 4, unknown_attempts: 1 });
  expect(read.mock.calls.every(([key]) => /\/(config|lock)\.json$/.test(key))).toBe(
    true,
  );
  expect(list.mock.calls.every(([key]) => !key.includes("/task-"))).toBe(true);
  read.mockClear();
  list.mockClear();
  expect(await service.replacements(source.run_id)).toEqual(view);
  expect(read).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
  expect(native.replacementAggregate).toHaveBeenCalledTimes(1);
  expect(listJobs).not.toHaveBeenCalled();
  vi.mocked(listJobs).mockImplementation(async () => jobs);
  await putJson(
    store,
    `runs/${replacement.run_id}/job/task-${third}/result.json`,
    trial(third, 3),
  );
  await service.refresh();
  expect((await service.replacements(source.run_id)).incurred?.cost_usd).toBe(5);
  expect(native.replacementAggregate).toHaveBeenCalledTimes(2);
});

it("coalesces in-flight evidence, isolates consumers, and retains failures only for that inspection", async () => {
  const read = vi.spyOn(store, "read");
  const reader = new ReplacementEvidence(store);
  const key = `runs/${source.run_id}/job/lock.json`;
  const [a, b] = await Promise.all([reader.read(key), reader.read(key)]);
  a.changed = true;
  expect(b.changed).toBeUndefined();
  expect((await reader.read(key)).changed).toBeUndefined();
  expect(read).toHaveBeenCalledTimes(1);
  const missing = `runs/${source.run_id}/missing.json`;
  await expect(reader.read(missing)).rejects.toThrow();
  await putJson(store, missing, {});
  await expect(reader.read(missing)).rejects.toThrow();
  await expect(new ReplacementEvidence(store).read(missing)).resolves.toEqual({});
});

it("bounds nested evidence I/O across reads and listings and releases slots on rejection", async () => {
  let active = 0;
  let peak = 0;
  const read = store.read.bind(store);
  vi.spyOn(store, "read").mockImplementation(async (key) => {
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return await read(key);
    } finally {
      active--;
    }
  });
  const reader = new ReplacementEvidence(store);
  const results = await Promise.allSettled(
    Array.from({ length: 24 }, (_, i) =>
      reader.read(`runs/${source.run_id}/missing-${i}.json`),
    ),
  );
  expect(results.every((result) => result.status === "rejected")).toBe(true);
  expect(peak).toBe(8);
  await expect(reader.read(`runs/${source.run_id}/job/lock.json`)).resolves.toEqual({});
});

it("lists job roots only and shares one inspection across overlapping view requests", async () => {
  const replacement = (await child()).run;
  await artifacts(replacement, [trial(third)]);
  await service.refresh();
  const read = vi.spyOn(store, "read");
  const list = vi.spyOn(store, "listDirectory");
  const views = new Replacements(store, projection, native);
  const [a, b, c] = await Promise.all(
    Array.from({ length: 3 }, () => views.view(source.run_id)),
  );
  expect(a!.assembly.availability).toBe("available");
  expect(b).toEqual(a);
  expect(c).toEqual(a);

  expect(list.mock.calls).toHaveLength(2);
  expect(list.mock.calls.every(([key]) => !key.includes("/task-"))).toBe(true);
  const path = `runs/${source.run_id}/job/task-${first}/result.json`;
  expect(read.mock.calls.filter(([key]) => key === path)).toHaveLength(0);
  a!.children.length = 0;
  a!.assembly.result!.changed = true;
  expect(b!.children).toHaveLength(1);
  expect(b!.assembly.result!.changed).toBeUndefined();
  await views.view(source.run_id);
  expect(read.mock.calls.filter(([key]) => key === path)).toHaveLength(0);
});

it("does not retain failed metadata inspections or share inspections across different run IDs", async () => {
  const replacement = (await child()).run;
  await artifacts(replacement, [trial(third)]);
  await service.refresh();
  const views = new Replacements(store, projection, native);
  const list = vi
    .spyOn(store, "listDirectory")
    .mockRejectedValue(new Error("temporary listing failure"));
  const failed = await Promise.all([
    views.view(source.run_id),
    views.view(source.run_id),
  ]);
  expect(failed.map((value) => value.assembly.availability)).toEqual([
    "unavailable",
    "unavailable",
  ]);
  expect(list).toHaveBeenCalledTimes(1);
  list.mockRestore();
  const [valid, absent] = await Promise.allSettled([
    views.view(source.run_id),
    views.view(runId("absent")),
  ]);
  expect(valid.status).toBe("fulfilled");
  expect(absent.status).toBe("rejected");
  expect((await views.view(source.run_id)).assembly.availability).toBe("available");
});

it("direct trial reads distinguish absent artifacts from storage and malformed-data failures", async () => {
  const directory = `runs/${source.run_id}/job/task-${first}/`;
  const path = `${directory}result.json`;
  await rm(join(store.root, path));
  const reader = new ReplacementEvidence(store);
  expect(await reader.trialResult(directory)).toBeNull();
  await expect(reader.bundle(source.run_id)).rejects.toThrow("unfinished");
  await service.refresh();
  const views = new Replacements(store, projection, native);
  expect((await views.view(source.run_id)).incurred?.total_attempts).toBe(1);
  await artifacts(source);
  expect(await new ReplacementEvidence(store).trialResult(directory)).toEqual(
    trial(first),
  );
  const read = store.read.bind(store);
  vi.spyOn(store, "read").mockImplementation(async (key) => {
    if (key === path) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return read(key);
  });
  await expect(new ReplacementEvidence(store).trialResult(directory)).rejects.toThrow(
    "denied",
  );
  await expect(service.refresh()).rejects.toThrow();
  expect((await views.view(source.run_id)).incurred).toBeNull();
  vi.mocked(store.read).mockRestore();
  await store.put(path, new TextEncoder().encode("{invalid"));
  await expect(new ReplacementEvidence(store).trialResult(directory)).rejects.toThrow();
  await expect(service.refresh()).rejects.toThrow();
  expect((await views.view(source.run_id)).incurred).toBeNull();
});

it("rediscovers descendants before sharing an in-flight inspection of an older graph", async () => {
  const replacement = (await child()).run;
  await artifacts(replacement, [trial(third)]);
  let release = () => {};
  let signal = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    signal = resolve;
  });
  await service.refresh();
  vi.mocked(native.replacementAggregate).mockImplementationOnce(
    async ({ original }) => {
      signal();
      await held;
      return { result: original.result };
    },
  );
  const views = new Replacements(store, projection, native);
  const older = views.view(source.run_id);
  await entered;
  try {
    const descendant: RunRecordV1 = {
      ...replacement,
      run_id: runId("new-descendant"),
      operator_selection: {
        ...replacement.operator_selection!,
        original_run_id: replacement.run_id,
        trial_ids: [third],
      },
    };
    await putJson(store, `runs/${descendant.run_id}/run.json`, descendant);
    await artifacts(descendant, [trial("44444444-4444-4444-8444-444444444444")]);
    await putJson(
      store,
      `runs/${descendant.run_id}/state.json`,
      projection.run(replacement.run_id)!.state,
    );
    await service.refresh();
    const fresh = await views.view(source.run_id);
    expect(fresh.assembly.availability).toBe("available");
    expect(
      vi.mocked(native.replacementAggregate).mock.lastCall?.[0].parts[0]?.parts[0]
        ?.evidence.record.run_id,
    ).toBe(descendant.run_id);
  } finally {
    release();
    await expect(older).rejects.toThrow("changed during inspection");
  }
});

describe("projection observation display contract", () => {
  async function completed() {
    const replacement = (await child()).run;
    await artifacts(replacement, [trial(third)]);
    await service.refresh();
    return replacement;
  }
  it("keeps full native bundles identical to the fresh mutation reader", async () => {
    const replacement = await completed();
    await service.replacements(source.run_id);
    const input = vi.mocked(native.replacementAggregate).mock.lastCall![0];
    expect(input.original).toEqual(
      await new ReplacementEvidence(store).bundle(source.run_id),
    );
    expect(input.parts[0]!.evidence).toEqual(
      await new ReplacementEvidence(store).bundle(replacement.run_id),
    );
  });
  it("retains a content-stable aggregate across full rebuilds but does not renew the observation on HTTP reads", async () => {
    await completed();
    const before = await service.replacements(source.run_id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const warm = await service.replacements(source.run_id);
    expect(warm.observed_at).toBe(before.observed_at);
    await service.refresh();
    const after = await service.replacements(source.run_id);
    expect(after.observed_at).not.toBe(before.observed_at);
    expect(after.assembly).toEqual(before.assembly);
    expect(native.replacementAggregate).toHaveBeenCalledTimes(1);
  });
  it("does not claim an observation after reopening SQLite until a full rebuild", async () => {
    await completed();
    await service.replacements(source.run_id);
    projection.close();
    projection = await Projection.open(join(root, "projection.sqlite"));
    const views = new Replacements(store, projection, native);
    expect(await views.view(source.run_id)).toMatchObject({
      observed_at: null,
      incurred: null,
      assembly: { availability: "unavailable" },
    });
    await projection.rebuild(store, jobs);
    expect((await views.view(source.run_id)).assembly.availability).toBe("available");
  });
  it("withholds a cached view after a failed refresh and recovers after a successful full rebuild", async () => {
    await completed();
    const before = await service.replacements(source.run_id);
    const list = vi
      .spyOn(store, "list")
      .mockRejectedValueOnce(new Error("Unavailable"));
    await expect(service.refresh()).rejects.toThrow("Unavailable");
    expect(await service.replacements(source.run_id)).toMatchObject({
      observed_at: null,
      incurred: null,
      assembly: { availability: "unavailable" },
    });
    list.mockRestore();
    await service.refresh();
    expect((await service.replacements(source.run_id)).assembly).toEqual(
      before.assembly,
    );
  });
  it("retains other source metadata on scoped rebuilds without advancing global observation age", async () => {
    const replacement = await completed();
    await receipt(source, first, 1);
    await service.refresh();
    const beforeReceipts = projection.replacementReceipts(source.run_id);
    expect(beforeReceipts).toHaveLength(1);
    const before = projection.replacementObjects(source.run_id);
    const time = projection.jobObservations().observed_at;
    await putJson(store, `runs/${replacement.run_id}/job/lock.json`, { changed: true });
    await projection.rebuild(store, jobs, replacement.run_id);
    expect(projection.replacementObjects(source.run_id)).toEqual(before);
    expect(projection.replacementReceipts(source.run_id)).toEqual(beforeReceipts);
    expect(projection.jobObservations().observed_at).toBe(time);
    expect((await service.replacements(source.run_id)).assembly.availability).toBe(
      "available",
    );
  });
  it.each(["config.json", "lock.json"])(
    "fences changed %s bytes against the projected provider identity",
    async (file) => {
      const replacement = await completed();
      await putJson(store, `runs/${replacement.run_id}/job/${file}`, {
        unexpected: "new bytes",
      });
      expect((await service.replacements(source.run_id)).assembly.availability).toBe(
        "unavailable",
      );
      expect(native.replacementAggregate).not.toHaveBeenCalled();
      await service.refresh();
      expect((await service.replacements(source.run_id)).assembly.availability).toBe(
        "available",
      );
    },
  );
  it("invalidates observed live Jobs while mutation checks still see newer provider Jobs immediately", async () => {
    await completed();
    expect((await service.replacements(source.run_id)).assembly.availability).toBe(
      "available",
    );
    jobs.push({
      id: "owned-trial",
      run_id: source.run_id,
      role: "trial",
      stage: "running",
      created_at: "2026-01-01T00:00:00Z",
      started_at: null,
      finished_at: null,
    });
    // Historical display is explicitly labeled; it never authorizes execution.
    expect((await service.replacements(source.run_id)).assembly.availability).toBe(
      "available",
    );
    await expect(
      service.validateReplacement(
        source.run_id,
        { ...request, trial_ids: [second] },
        "operator",
      ),
    ).rejects.toThrow("complete");
    await service.refresh();
    expect((await service.replacements(source.run_id)).assembly.availability).toBe(
      "pending",
    );
  });
  it("does not cache native provenance failures and invalidates observed receipts", async () => {
    await completed();
    await receipt(source, first, 1);
    await service.refresh();
    vi.mocked(native.replacementAggregate).mockRejectedValueOnce(
      new Error("Native identity mismatch"),
    );
    expect((await service.replacements(source.run_id)).assembly.availability).toBe(
      "unavailable",
    );
    expect((await service.replacements(source.run_id)).assembly.availability).toBe(
      "available",
    );
    await receipt(source, first, 2);
    const fresh = new Replacements(store, projection, native);
    // New remote bytes are not a new observation; failed refresh invalidates it.
    expect((await fresh.view(source.run_id)).incurred?.cost_usd).toBe(3);
    await expect(service.refresh()).rejects.toThrow();
    expect((await fresh.view(source.run_id)).incurred).toBeNull();
    await receipt(source, first, 1);
    await service.refresh();
    expect((await fresh.view(source.run_id)).incurred?.cost_usd).toBe(3);
  });
  it("invalidates changed native result rows and passes deletion to Harbor without an original fallback", async () => {
    const replacement = await completed();
    await service.replacements(source.run_id);
    await rm(
      join(store.root, `runs/${replacement.run_id}/job/task-${third}/result.json`),
    );
    await service.refresh();
    vi.mocked(native.replacementAggregate).mockImplementationOnce(async ({ parts }) => {
      expect(parts[0]!.evidence.trials).toEqual([]);
      throw new Error("Incomplete native membership");
    });
    expect((await service.replacements(source.run_id)).assembly).toEqual({
      availability: "unavailable",
      result: null,
    });
  });
  it("requires a new full observation when a rebuild fails during native aggregation", async () => {
    await completed();
    vi.mocked(native.replacementAggregate).mockImplementationOnce(
      async ({ original }) => {
        const list = vi
          .spyOn(store, "list")
          .mockRejectedValueOnce(new Error("Unavailable"));
        await expect(service.refresh()).rejects.toThrow("Unavailable");
        list.mockRestore();
        return { result: original.result };
      },
    );
    await expect(service.replacements(source.run_id)).rejects.toThrow(
      "changed during inspection",
    );
  });
});

it("keeps cold display I/O independent of native trial and receipt cohort size", async () => {
  const trials = [
    trial(first, 0.01),
    ...Array.from({ length: 511 }, () => trial(randomUUID(), 0.01)),
  ];
  await rm(join(store.root, `runs/${source.run_id}/job/task-${second}`), {
    recursive: true,
  });
  await artifacts(source, trials);
  for (const item of trials) await receipt(source, item.id, 0.01);
  const replacement = (await child()).run;
  await artifacts(replacement, [trial(third)]);
  await receipt(replacement, third, 1);
  await service.refresh();
  vi.mocked(listJobs)
    .mockClear()
    .mockRejectedValue(new Error("No provider I/O allowed"));
  const read = vi.spyOn(store, "read");
  const directory = vi.spyOn(store, "listDirectory");
  const listing = vi.spyOn(store, "list");
  const cold = await service.replacements(source.run_id);
  expect(cold.assembly.availability).toBe("available");
  expect(cold.incurred?.total_attempts).toBe(513);
  expect(read).toHaveBeenCalledTimes(4);
  expect(directory).toHaveBeenCalledTimes(2);
  expect(listing).not.toHaveBeenCalled();
  expect(listJobs).not.toHaveBeenCalled();
  read.mockClear();
  directory.mockClear();
  const warm = await service.replacements(source.run_id);
  expect(warm).toEqual(cold);
  expect(read).not.toHaveBeenCalled();
  expect(directory).not.toHaveBeenCalled();
  expect(listing).not.toHaveBeenCalled();
  expect(listJobs).not.toHaveBeenCalled();
  expect(native.replacementAggregate).toHaveBeenCalledTimes(1);
});

it("passes projected ancestor bundles to Harbor when browsing a replaced subset", async () => {
  const replacement = (await child()).run;
  await artifacts(replacement, [trial(third)]);
  const input = { ...request, trial_ids: [third] };
  const reviewed = await service.validateReplacement(
    replacement.run_id,
    input,
    "operator",
  );
  const descendant = (
    await service.submitReplacement(
      replacement.run_id,
      { ...input, fingerprint: reviewed.fingerprint },
      "nested-display",
      "operator",
    )
  ).run;
  await artifacts(descendant, [trial("44444444-4444-4444-8444-444444444444")]);
  await service.refresh();
  expect((await service.replacements(replacement.run_id)).assembly.availability).toBe(
    "available",
  );
  expect(
    vi.mocked(native.replacementAggregate).mock.lastCall![0].original_ancestors,
  ).toEqual([await new ReplacementEvidence(store).bundle(source.run_id)]);
});

it("bounds complete projected evidence before calling the native bridge", async () => {
  const row = projection.run(source.run_id)!;
  vi.spyOn(projection, "listRuns").mockReturnValue([
    { ...row, result: { padding: "x".repeat(33 * 1024 * 1024) } },
  ]);
  await expect(service.replacements(source.run_id)).rejects.toThrow(
    "exceeds its bound",
  );
  expect(native.replacementAggregate).not.toHaveBeenCalled();
});
