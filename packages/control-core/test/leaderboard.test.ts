import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarborHFResultCatalogV1, RunLock } from "@harbor-hf/contracts";
import {
  canonicalJson,
  deterministicId,
  sha256,
  validateLeaderboardSnapshot,
} from "@harbor-hf/contracts";
import { NoopActions } from "@harbor-hf/hf-adapters";
import {
  approveSnapshotFixture,
  createTestControl,
  profile,
  smokeProfiles,
  type TestControl,
} from "@harbor-hf/test-fixtures";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configurationDigest,
  configurationDigestFields,
  encodeLeaderboardSqlite,
  LEADERBOARD_RECEIPT_PREFIX,
  LEADERBOARD_SNAPSHOT_PREFIX,
  type LeaderboardRow,
  leaderboardEligible,
  loadLatestLeaderboard,
  paretoFrontier,
  rankLeaderboardRows,
  refreshLeaderboardSnapshot,
} from "../src/leaderboard.js";
import { LeaderboardSubmissions } from "../src/leaderboard-submissions.js";
import type { LoadedProfile } from "../src/profiles.js";
import { Projection } from "../src/projection.js";
import { ResultPublisher } from "../src/publication.js";
import { Reconciler } from "../src/reconciler.js";
import { ControlService } from "../src/service.js";
import { createJson, FilesystemObjectStore } from "../src/store.js";

const controls: TestControl[] = [];
afterEach(async () =>
  Promise.all(controls.splice(0).map((control) => control.close())),
);

const digest = `sha256:${"a".repeat(64)}`;

function sampleLock(input: {
  reasoning_effort?: "off" | "high";
  inference_provider?: string;
  harbor_version?: string;
  trial_indices?: number[];
  worker_revision?: string;
  omit_harbor_version?: boolean;
}): RunLock {
  return {
    schema_version: "v1",
    kind: "run.lock",
    record_id: "lock-leaderboard",
    created_at: "2026-08-21T00:00:00.000Z",
    actor: { subject: "test", role: "service" },
    run_id: "run-leaderboard",
    profiles: [
      {
        kind: "benchmark",
        profile_id: digest,
        name: "control-smoke",
        spec: {
          benchmark: "control-smoke",
          revision: digest,
          task_ids: ["task-001"],
          task_digests: [digest],
          trial_indices: input.trial_indices ?? [1],
        },
      },
      {
        kind: "model",
        profile_id: digest,
        name: "control-smoke",
        spec: { model_id: "control-smoke", revision: digest },
      },
      {
        kind: "harness",
        profile_id: digest,
        name: "control-smoke",
        spec: {
          agent: "control-smoke",
          revision: digest,
          required_evidence: ["job-status"],
          reasoning_effort: input.reasoning_effort ?? "off",
        },
      },
      {
        kind: "deployment",
        profile_id: digest,
        name: "hf-cpu-smoke",
        spec: {
          route: "hf_job",
          models: ["control-smoke"],
          harnesses: ["control-smoke"],
          job_image: `example.invalid/worker@${digest}`,
          job_command: ["true"],
          hardware: "cpu-basic",
          timeout_seconds: 300,
          trusted_worker: true,
          inference_provider: input.inference_provider ?? "hf-cpu-smoke",
          ...(input.omit_harbor_version
            ? {}
            : { harbor_version: input.harbor_version ?? "0.21.0" }),
          worker_revision: input.worker_revision ?? "abcdef0",
        },
      },
      {
        kind: "launch_policy",
        profile_id: digest,
        name: "control-smoke",
        spec: {
          max_infrastructure_attempts: 1,
          reservation_microusd: 0,
          success_without_worker_receipt: true,
          publication_role: "final",
        },
      },
    ],
    tasks: [{ task_id: "task-001", input_digest: digest }],
    ceiling_microusd: 0,
    source_revision: digest,
  };
}

function catalogEntry(
  overrides: Partial<HarborHFResultCatalogV1["entries"][number]> = {},
): HarborHFResultCatalogV1["entries"][number] {
  return {
    publication_id: "publication-test",
    run_id: "run-test",
    published_at: "2026-08-16T00:00:00.000Z",
    observed_microusd: 0,
    benchmark: "benchmark-test",
    model: "model-test",
    harness: "harness-test",
    inference_provider: "provider-test",
    run_outcome: "complete",
    quality: "clean",
    publication_role: "final",
    task_count: 1,
    scored_task_count: 1,
    strict_pass_count: 1,
    primary_metric: { name: "mean_reward", value: 1, unit: "score" },
    result_path: "results/test.json",
    ...overrides,
  };
}

const operator = { subject: "operator-1", role: "operator" as const };
const submission = {
  benchmark: "control-smoke",
  model: "control-smoke",
  harness: "control-smoke",
  deployment: "hf-cpu-smoke",
  launch_policy: "control-smoke",
  ceiling_microusd: 0,
  confirmed: true,
} as const;

async function settle(reconciler: Reconciler, rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await reconciler.tick();
}

async function createControl(profiles: LoadedProfile[]): Promise<TestControl> {
  const root = await mkdtemp(join(tmpdir(), "harbor-hf-control-test-"));
  const bucket = join(root, "bucket");
  await mkdir(bucket, { recursive: true });
  const store = new FilesystemObjectStore(bucket);
  const projection = await Projection.open(join(root, "projection.sqlite"));
  const service = new ControlService("test", store, projection, profiles);
  await projection.rebuild(store);
  await service.initialize(profiles);
  return {
    root,
    bucket,
    store,
    projection,
    service,
    profiles,
    async close() {
      await projection.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function leaderboardProfiles() {
  const base = smokeProfiles();
  const specs = Object.fromEntries(
    base.map((item) => [item.profile.profile_kind, item.profile.spec]),
  );
  return [
    profile("benchmark", "control-smoke", {
      ...specs.benchmark,
      source_task_ids: ["task-001"],
      trial_indices: [1],
    }),
    profile("model", "control-smoke", specs.model),
    profile("harness", "control-smoke", {
      ...specs.harness,
      reasoning_effort: "off",
    }),
    profile("deployment", "hf-cpu-smoke", {
      ...specs.deployment,
      inference_provider: "hf-cpu-smoke",
      harbor_version: "0.21.0",
      worker_revision: "abcdef0",
    }),
    profile("launch_policy", "control-smoke", {
      ...specs.launch_policy,
      publication_role: "final",
    }),
  ];
}

describe("leaderboard configuration digest", () => {
  it("includes trial count, reasoning, provider, and Harbor version", () => {
    const fields = configurationDigestFields(sampleLock({}));
    expect(fields).toMatchObject({
      trial_count: 1,
      trial_indices: [1],
      reasoning_effort: "off",
      inference_provider: "hf-cpu-smoke",
      harbor_version: "0.21.0",
    });
    expect(configurationDigest(sampleLock({}))).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes when trial count, reasoning, provider, or Harbor version change", () => {
    const baseline = configurationDigest(sampleLock({}));
    expect(configurationDigest(sampleLock({ trial_indices: [1, 2] }))).not.toBe(
      baseline,
    );
    expect(configurationDigest(sampleLock({ reasoning_effort: "high" }))).not.toBe(
      baseline,
    );
    expect(
      configurationDigest(sampleLock({ inference_provider: "other-provider" })),
    ).not.toBe(baseline);
    expect(configurationDigest(sampleLock({ harbor_version: "0.22.0" }))).not.toBe(
      baseline,
    );
  });

  it("excludes worker revision", () => {
    expect(configurationDigest(sampleLock({ worker_revision: "abcdef0" }))).toBe(
      configurationDigest(sampleLock({ worker_revision: "zzzzzzz" })),
    );
  });

  it("fails closed when Harbor version is missing", () => {
    expect(() =>
      configurationDigest(sampleLock({ omit_harbor_version: true })),
    ).toThrow("configuration digest requires harbor_version");
  });
});

describe("leaderboard eligibility", () => {
  it("admits only final, clean, fully scored runs", () => {
    expect(leaderboardEligible(catalogEntry())).toBe(true);
  });

  it("rejects diagnostic, mixed, degraded, cancelled, and unscored catalogs", () => {
    expect(leaderboardEligible(catalogEntry({ publication_role: "diagnostic" }))).toBe(
      false,
    );
    expect(leaderboardEligible(catalogEntry({ run_outcome: "mixed" }))).toBe(false);
    expect(leaderboardEligible(catalogEntry({ quality: "degraded" }))).toBe(false);
    expect(leaderboardEligible(catalogEntry({ run_outcome: "cancelled" }))).toBe(false);
    expect(
      leaderboardEligible(catalogEntry({ scored_task_count: 0, primary_metric: null })),
    ).toBe(false);
  });
});

describe("leaderboard sqlite snapshot", () => {
  it("encodes shown rows into a sqlite database", async () => {
    const bytes = await encodeLeaderboardSqlite([
      {
        configuration_digest: digest,
        run_id: "run-one",
        publication_id: "publication-one",
        published_at: "2026-08-21T00:00:00.000Z",
        benchmark: "control-smoke",
        model: "control-smoke",
        harness: "control-smoke",
        inference_provider: "hf-cpu-smoke",
        reasoning_effort: "off",
        harbor_version: "0.21.0",
        trial_count: 1,
        task_count: 1,
        scored_task_count: 1,
        primary_metric_name: "mean_reward",
        primary_metric_value: 1,
        primary_metric_unit: "score",
        observed_microusd: 0,
      },
    ]);
    const directory = await mkdtemp(join(tmpdir(), "harbor-hf-leaderboard-read-"));
    const path = join(directory, "leaderboard.sqlite");
    await writeFile(path, bytes);
    const database = new Database(path, { readonly: true });
    expect(database.prepare("SELECT entry_count FROM snapshot").get()).toEqual({
      entry_count: 1,
    });
    expect(
      database.prepare("SELECT run_id, harbor_version, trial_count FROM entries").get(),
    ).toEqual({
      run_id: "run-one",
      harbor_version: "0.21.0",
      trial_count: 1,
    });
    database.close();
  });

  it("does not write a snapshot for diagnostic catalogs", async () => {
    const control = await createTestControl();
    controls.push(control);
    const submitted = await control.service.submit(submission, "diag-key", operator);
    const publisher = new ResultPublisher(
      control.store,
      control.projection,
      control.service,
    );
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      new NoopActions(),
      publisher,
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    await settle(reconciler);
    expect(await control.projection.run(submitted.run_id)).toMatchObject({
      publication_status: "published",
    });
    expect(await control.store.list(LEADERBOARD_SNAPSHOT_PREFIX)).toEqual([]);
  });

  it("refreshes the snapshot after a final publication", async () => {
    const control = await createControl(leaderboardProfiles());
    controls.push(control);
    const submitted = await control.service.submit(
      submission,
      "final-publication-key",
      operator,
    );
    const reconciler = new Reconciler(
      control.service,
      control.projection,
      new NoopActions(),
      new ResultPublisher(control.store, control.projection, control.service),
      { interval_ms: 100, observation_interval_ms: 0, batch_size: 16 },
    );
    const list = control.store.list.bind(control.store);
    const catalogReads = vi
      .spyOn(control.store, "list")
      .mockImplementation((prefix) => list(prefix));

    await settle(reconciler);

    expect(await control.projection.run(submitted.run_id)).toMatchObject({
      publication_status: "published",
      pending_actions: 0,
    });
    expect(catalogReads).toHaveBeenCalledWith("results/schema=v1/catalog/records/");
  });

  it("writes a bucket sqlite snapshot for a final clean scored run", async () => {
    const control = await createControl(leaderboardProfiles());
    controls.push(control);
    const submitted = await control.service.submit(submission, "final-key", operator);
    const catalog = {
      schema_version: "v1" as const,
      kind: "result.catalog" as const,
      record_id: "catalog-leaderboard-test",
      created_at: "2026-08-21T00:00:00.000Z",
      source_digest: digest,
      entries: [
        catalogEntry({
          run_id: submitted.run_id,
          publication_id: "publication-leaderboard-test",
          inference_provider: "hf-cpu-smoke",
          benchmark: "control-smoke",
          model: "control-smoke",
          harness: "control-smoke",
        }),
      ],
    };
    await control.store.create(
      "results/schema=v1/catalog/records/catalog-leaderboard-test.json",
      new TextEncoder().encode(canonicalJson(catalog)),
    );
    await expect(
      refreshLeaderboardSnapshot(control.store, control.projection),
    ).rejects.toThrow();
    await control.store.create(
      "results/test.json",
      new TextEncoder().encode(
        canonicalJson({
          schema_version: "v1",
          kind: "publication.receipt",
          record_id: "publication-receipt-leaderboard-test",
          created_at: "2026-08-21T00:00:00.000Z",
          actor: { subject: "harbor-hf-control", role: "service" },
          run_id: submitted.run_id,
          publication_id: "publication-leaderboard-test",
          publication_state: "published",
          object_digests: [],
          catalog_digest: sha256(canonicalJson(catalog)),
          error_code: null,
        }),
      ),
    );
    expect(
      await refreshLeaderboardSnapshot(control.store, control.projection),
    ).toBeNull();
    const reviews = new LeaderboardSubmissions(control.store, control.projection);
    const pending = await reviews.submit(operator, submitted.run_id);
    await reviews.review(operator, pending.record_id, "approved", true);
    const snapshot = await refreshLeaderboardSnapshot(
      control.store,
      control.projection,
    );
    expect(snapshot).toMatchObject({ entry_count: 1, kind: "leaderboard.snapshot" });
    const snapshots = await control.store.list(LEADERBOARD_SNAPSHOT_PREFIX);
    expect(snapshots).toHaveLength(1);
    const directory = await mkdtemp(join(tmpdir(), "harbor-hf-leaderboard-pub-"));
    const path = join(directory, "leaderboard.sqlite");
    await writeFile(path, await control.store.read(snapshots[0]?.key as string));
    const database = new Database(path, { readonly: true });
    expect(
      database.prepare("SELECT run_id, trial_count, harbor_version FROM entries").get(),
    ).toEqual({
      run_id: submitted.run_id,
      trial_count: 1,
      harbor_version: "0.21.0",
    });
    database.close();
  });
});

function sampleRow(
  overrides: Partial<LeaderboardRow> & Pick<LeaderboardRow, "configuration_digest">,
): LeaderboardRow {
  return {
    run_id: "run-one",
    publication_id: "publication-one",
    published_at: "2026-08-21T00:00:00.000Z",
    benchmark: "control-smoke",
    model: "model-a",
    harness: "harness-a",
    inference_provider: "together",
    reasoning_effort: "off",
    harbor_version: "0.21.0",
    trial_count: 1,
    task_count: 2,
    scored_task_count: 2,
    primary_metric_name: "mean_reward",
    primary_metric_value: 0.5,
    primary_metric_unit: "score",
    observed_microusd: 100_000,
    ...overrides,
  };
}

describe("leaderboard ranking and Pareto frontier", () => {
  it("keeps cheaper equal scores and higher scores at the same cost", () => {
    const cheap = sampleRow({
      configuration_digest: "sha256:cheap",
      observed_microusd: 50_000,
      primary_metric_value: 0.4,
    });
    const mid = sampleRow({
      configuration_digest: "sha256:mid",
      observed_microusd: 100_000,
      primary_metric_value: 0.8,
    });
    const expensive = sampleRow({
      configuration_digest: "sha256:expensive",
      observed_microusd: 200_000,
      primary_metric_value: 0.8,
    });
    const dominated = sampleRow({
      configuration_digest: "sha256:dominated",
      observed_microusd: 150_000,
      primary_metric_value: 0.3,
    });
    expect([...paretoFrontier([cheap, mid, expensive, dominated])].sort()).toEqual([
      "sha256:cheap",
      "sha256:mid",
    ]);
    expect(rankLeaderboardRows([cheap, mid, expensive, dominated])).toEqual([
      { ...mid, rank: 1, pareto: true },
      { ...expensive, rank: 2, pareto: false },
      { ...cheap, rank: 3, pareto: true },
      { ...dominated, rank: 4, pareto: false },
    ]);
  });

  it("reads the latest snapshot receipt and ranks its sqlite rows", async () => {
    const control = await createTestControl();
    controls.push(control);
    const older = sampleRow({
      configuration_digest: digest,
      run_id: "run-old",
      publication_id: "publication-old",
      primary_metric_value: 0.2,
      observed_microusd: 10_000,
    });
    const newer = sampleRow({
      configuration_digest: digest,
      run_id: "run-new",
      publication_id: "publication-new",
      primary_metric_value: 0.9,
      observed_microusd: 20_000,
    });
    await approveSnapshotFixture(control.store, older);
    await approveSnapshotFixture(control.store, newer);
    const first = await refreshFromRows(control, [older], "2026-08-21T00:00:00.000Z");
    const second = await refreshFromRows(control, [newer], "2026-08-21T01:00:00.000Z");
    expect(first.entry_count).toBe(1);
    const loaded = await loadLatestLeaderboard(control.store);
    expect(loaded.snapshot?.record_id).toBe(second.record_id);
    expect(loaded.rows).toEqual([{ ...newer, rank: 1, pareto: true }]);
  });

  it("rejects a snapshot whose sqlite bytes do not match the receipt digest", async () => {
    const control = await createTestControl();
    controls.push(control);
    const sqliteDigest = sha256(new Uint8Array([9, 9, 9]));
    const sqliteKey = `${LEADERBOARD_SNAPSHOT_PREFIX}${sqliteDigest.slice("sha256:".length)}/leaderboard.sqlite`;
    await control.store.create(sqliteKey, new Uint8Array([1, 2, 3]));
    const receipt = validateLeaderboardSnapshot({
      schema_version: "v1",
      kind: "leaderboard.snapshot",
      record_id: deterministicId("leaderboard-snapshot", sqliteDigest),
      created_at: "2026-08-21T00:00:00.000Z",
      actor: { subject: "harbor-hf-control", role: "service" },
      sqlite_key: sqliteKey,
      sqlite_digest: sqliteDigest,
      source_digest: sha256(canonicalJson(["run-one"])),
      entry_count: 1,
    });
    await control.store.create(
      `${LEADERBOARD_RECEIPT_PREFIX}${receipt.record_id}.json`,
      new TextEncoder().encode(canonicalJson(receipt)),
    );
    await expect(loadLatestLeaderboard(control.store)).rejects.toThrow(
      "leaderboard snapshot digest mismatch",
    );
  });
});

async function refreshFromRows(
  control: TestControl,
  rows: LeaderboardRow[],
  createdAt: string,
) {
  const bytes = await encodeLeaderboardSqlite(rows);
  const sqliteDigest = sha256(bytes);
  const sqliteKey = `${LEADERBOARD_SNAPSHOT_PREFIX}${sqliteDigest.slice("sha256:".length)}/leaderboard.sqlite`;
  await control.store.create(sqliteKey, bytes);
  const receipt = validateLeaderboardSnapshot({
    schema_version: "v1",
    kind: "leaderboard.snapshot",
    record_id: deterministicId("leaderboard-snapshot", sqliteDigest, createdAt),
    created_at: createdAt,
    actor: { subject: "harbor-hf-control", role: "service" },
    sqlite_key: sqliteKey,
    sqlite_digest: sqliteDigest,
    source_digest: sha256(canonicalJson(rows.map((row) => row.run_id))),
    entry_count: rows.length,
  });
  await control.store.create(
    `${LEADERBOARD_RECEIPT_PREFIX}${receipt.record_id}.json`,
    new TextEncoder().encode(canonicalJson(receipt)),
  );
  return receipt;
}

async function submissionFixture() {
  const control = await createControl(leaderboardProfiles());
  controls.push(control);
  const submitted = await control.service.submit(
    submission,
    "review-fixture",
    operator,
  );
  const entry = catalogEntry({
    run_id: submitted.run_id,
    publication_id: "publication-review",
    result_path: "results/review-receipt.json",
  });
  const catalog = {
    schema_version: "v1",
    kind: "result.catalog",
    record_id: "catalog-review",
    created_at: entry.published_at,
    source_digest: digest,
    entries: [entry],
  };
  await createJson(
    control.store,
    "results/schema=v1/catalog/records/catalog-review.json",
    catalog,
  );
  await createJson(control.store, entry.result_path, {
    schema_version: "v1",
    kind: "publication.receipt",
    record_id: "receipt-review",
    created_at: entry.published_at,
    actor: { subject: "test", role: "service" },
    run_id: entry.run_id,
    publication_id: entry.publication_id,
    publication_state: "published",
    object_digests: [],
    catalog_digest: sha256(canonicalJson(catalog)),
    error_code: null,
  });
  return {
    control,
    runId: submitted.run_id,
    reviews: new LeaderboardSubmissions(control.store, control.projection),
  };
}

describe("hosted leaderboard submissions", () => {
  it("keeps consent and recovery stable when live spend changes", async () => {
    const { control, reviews, runId } = await submissionFixture();
    const before = (await reviews.candidates(operator))[0];
    if (!before) throw new Error("missing fixture candidate");
    const pending = await reviews.submit(operator, runId, before.catalog_digest);
    const original = control.projection.run.bind(control.projection);
    vi.spyOn(control.projection, "run").mockImplementation(async (id) => {
      const row = await original(id);
      return row ? { ...row, observed_microusd: 999999 } : row;
    });
    expect((await reviews.candidates(operator))[0]?.row).toEqual(before.row);
    expect(await reviews.submit(operator, runId, before.catalog_digest)).toEqual(
      pending,
    );
    await reviews.review(operator, pending.record_id, "approved", true);
    await reviews.review(operator, pending.record_id, "approved", true);
    expect(
      (await loadLatestLeaderboard(control.store)).rows[0]?.observed_microusd,
    ).toBe(0);
  });
  it("does not offer legacy catalogs without frozen cost", async () => {
    const { control, reviews } = await submissionFixture();
    const original = control.store.read.bind(control.store);
    vi.spyOn(control.store, "read").mockImplementation(async (key) => {
      const bytes = await original(key);
      if (!key.startsWith("results/schema=v1/catalog/records/")) return bytes;
      const value = JSON.parse(new TextDecoder().decode(bytes));
      delete value.entries[0].observed_microusd;
      return new TextEncoder().encode(canonicalJson(value));
    });
    expect(await reviews.candidates(operator)).toEqual([]);
  });
  it("rejects a stale preview digest before persisting consent", async () => {
    const { reviews, runId } = await submissionFixture();
    await expect(
      reviews.submit(operator, runId, `sha256:${"0".repeat(64)}`),
    ).rejects.toMatchObject({ status: 409, code: "result_changed" });
    expect(await reviews.list(operator)).toEqual([]);
  });
  it("limits candidates and submission by original owner, not current operator role", async () => {
    const { control, reviews, runId } = await submissionFixture();
    const owner = { subject: operator.subject, role: "submitter" as const };
    const other = { subject: "other-user", role: "submitter" as const };
    expect(await reviews.candidates(other)).toEqual([]);
    await expect(reviews.submit(other, runId)).rejects.toMatchObject({ status: 404 });
    await expect(reviews.submit(other, "missing-run")).rejects.toMatchObject({
      status: 404,
    });
    expect(
      await refreshLeaderboardSnapshot(control.store, control.projection),
    ).toBeNull();
    const [first, second] = await Promise.all([
      reviews.submit(owner, runId),
      reviews.submit(owner, runId),
    ]);
    expect(second).toEqual(first);
    expect(await reviews.summary(first)).toMatchObject({
      id: first.record_id,
      status: "pending",
    });
    expect(await reviews.summary(first)).not.toHaveProperty("actor");
    expect(await reviews.list(other)).toEqual([]);
    expect(await reviews.list(owner)).toMatchObject([
      { status: "pending", id: first.record_id },
    ]);
    expect(await reviews.list(operator)).toHaveLength(1);
    expect(await loadLatestLeaderboard(control.store)).toEqual({
      snapshot: null,
      rows: [],
    });
    await expect(
      reviews.review(owner, first.record_id, "approved", true),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      reviews.review(operator, first.record_id, "approved", false),
    ).rejects.toMatchObject({ status: 400 });
    const approved = await reviews.review(operator, first.record_id, "approved", true);
    expect(await reviews.review(operator, first.record_id, "approved", true)).toEqual(
      approved,
    );
    const loaded = await loadLatestLeaderboard(control.store);
    expect(loaded.rows).toHaveLength(1);
    expect(JSON.stringify(loaded.rows)).not.toContain(operator.subject);
    expect(JSON.stringify(loaded.rows)).not.toContain("actor");
    await control.projection.rebuild(control.store);
    expect(
      await new LeaderboardSubmissions(control.store, control.projection).list(owner),
    ).toMatchObject([{ status: "approved" }]);
    await expect(
      reviews.review(operator, first.record_id, "rejected", false),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("stores a single immutable winner for competing decisions", async () => {
    const { control, reviews, runId } = await submissionFixture();
    const pending = await reviews.submit(operator, runId);
    const other = new LeaderboardSubmissions(control.store, control.projection);
    const settled = await Promise.allSettled([
      reviews.review(operator, pending.record_id, "rejected", false),
      other.review(operator, pending.record_id, "approved", true),
    ]);
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect(
      await control.store.list("results/schema=v1/leaderboard/decisions/"),
    ).toHaveLength(1);
  });

  it("rejection is idempotent and never publishes", async () => {
    const { control, reviews, runId } = await submissionFixture();
    const pending = await reviews.submit(operator, runId);
    const first = await reviews.review(operator, pending.record_id, "rejected", false);
    expect(
      await reviews.review(operator, pending.record_id, "rejected", false),
    ).toEqual(first);
    expect((await loadLatestLeaderboard(control.store)).rows).toEqual([]);
  });

  it("requires the exact submitted catalog and public row, not just a run id", async () => {
    const { control, reviews, runId } = await submissionFixture();
    const pending = await reviews.submit(operator, runId);
    const read = control.store.read.bind(control.store);
    vi.spyOn(control.store, "read").mockImplementation(async (key) => {
      const bytes = await read(key);
      if (key !== pending.catalog_key) return bytes;
      const catalog = JSON.parse(new TextDecoder().decode(bytes));
      catalog.entries[0].primary_metric.value = 0.25;
      return new TextEncoder().encode(canonicalJson(catalog));
    });
    await expect(
      reviews.review(operator, pending.record_id, "approved", true),
    ).rejects.toThrow();
    expect(
      await control.store.list("results/schema=v1/leaderboard/decisions/"),
    ).toEqual([]);
  });

  it("does not grandfather snapshots without approval", async () => {
    const control = await createTestControl();
    controls.push(control);
    await refreshFromRows(
      control,
      [sampleRow({ configuration_digest: digest })],
      "2026-08-21T00:00:00Z",
    );
    expect(await loadLatestLeaderboard(control.store)).toEqual({
      snapshot: null,
      rows: [],
    });
  });
});

describe("leaderboard approval recovery", () => {
  it("repairs interrupted snapshot writes by repeating the same approval", async () => {
    const { control, reviews, runId } = await submissionFixture();
    const pending = await reviews.submit(operator, runId);
    const create = control.store.create.bind(control.store);
    const fault = vi
      .spyOn(control.store, "create")
      .mockImplementation(async (key, bytes) => {
        if (key.startsWith(LEADERBOARD_SNAPSHOT_PREFIX))
          throw new Error("interrupted snapshot");
        return create(key, bytes);
      });
    await expect(
      reviews.review(operator, pending.record_id, "approved", true),
    ).rejects.toThrow("interrupted snapshot");
    expect(await reviews.list(operator)).toMatchObject([{ status: "approved" }]);
    fault.mockRestore();
    await reviews.review(operator, pending.record_id, "approved", true);
    expect((await loadLatestLeaderboard(control.store)).rows).toHaveLength(1);
  });

  it("rejects altered approved catalog bytes at the public read boundary", async () => {
    const { control, reviews, runId } = await submissionFixture();
    const pending = await reviews.submit(operator, runId);
    await reviews.review(operator, pending.record_id, "approved", true);
    const read = control.store.read.bind(control.store);
    vi.spyOn(control.store, "read").mockImplementation((key) =>
      key === pending.catalog_key
        ? Promise.resolve(new TextEncoder().encode("{}"))
        : read(key),
    );
    await expect(loadLatestLeaderboard(control.store)).rejects.toThrow(
      "approved catalog digest mismatch",
    );
  });
});

describe("leaderboard submission fail-closed admission", () => {
  it("rejects readers, unknown reviews, and owned results without eligible catalogs", async () => {
    const { control, reviews, runId } = await submissionFixture();
    await expect(
      reviews.submit({ subject: operator.subject, role: "reader" }, runId),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      reviews.review(operator, "missing", "rejected", false),
    ).rejects.toMatchObject({ status: 404 });
    vi.spyOn(reviews, "candidates").mockResolvedValue([]);
    await expect(reviews.submit(operator, runId)).rejects.toMatchObject({
      status: 422,
    });
    expect(
      await control.store.list("results/schema=v1/leaderboard/submissions/"),
    ).toEqual([]);
  });

  it("rejects decision proof drift in both private lists and public reads", async () => {
    const { control, reviews, runId } = await submissionFixture();
    const pending = await reviews.submit(operator, runId);
    await reviews.review(operator, pending.record_id, "approved", true);
    const read = control.store.read.bind(control.store);
    vi.spyOn(control.store, "read").mockImplementation(async (key) => {
      const bytes = await read(key);
      if (!key.startsWith("results/schema=v1/leaderboard/decisions/")) return bytes;
      const decision = JSON.parse(new TextDecoder().decode(bytes));
      decision.submission_digest = sha256("other-submission");
      return new TextEncoder().encode(canonicalJson(decision));
    });
    await expect(reviews.list(operator)).rejects.toThrow("decision binding failure");
    await expect(loadLatestLeaderboard(control.store)).rejects.toThrow(
      "decision binding failure",
    );
  });

  it("rejects public metadata drift after submission even when the catalog is unchanged", async () => {
    const { control, reviews, runId } = await submissionFixture();
    const pending = await reviews.submit(operator, runId);
    const candidates = await reviews.candidates(operator);
    vi.spyOn(reviews, "candidates").mockResolvedValue(
      candidates.map((candidate) => ({
        ...candidate,
        row: { ...candidate.row, observed_microusd: 123 },
      })),
    );
    await expect(
      reviews.review(operator, pending.record_id, "approved", true),
    ).rejects.toMatchObject({ code: "evidence_changed" });
    expect(
      await control.store.list("results/schema=v1/leaderboard/decisions/"),
    ).toEqual([]);
  });
});

describe("concurrent approval snapshots", () => {
  it("does not lose approved rows when snapshots contain disjoint approved sets", async () => {
    const control = await createTestControl();
    controls.push(control);
    const first = sampleRow({
      configuration_digest: digest,
      run_id: "run-first",
      publication_id: "publication-first",
    });
    const second = sampleRow({
      configuration_digest: sha256("other-config"),
      run_id: "run-second",
      publication_id: "publication-second",
    });
    await approveSnapshotFixture(control.store, first);
    await approveSnapshotFixture(control.store, second);
    await refreshFromRows(control, [first], "2026-08-21T00:00:00Z");
    await refreshFromRows(control, [second], "2026-08-21T00:01:00Z");
    const loaded = await loadLatestLeaderboard(control.store);
    expect(loaded.rows).toHaveLength(2);
    expect(loaded.snapshot).toBeNull();
  });
});
