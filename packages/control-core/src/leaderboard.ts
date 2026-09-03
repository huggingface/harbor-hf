import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HarborHFLeaderboardSnapshotV1,
  HarborHFResultCatalogV1,
  PublicationReceipt,
  ResolvedProfile,
  RunLock,
} from "@harbor-hf/contracts";
import {
  canonicalJson,
  deterministicId,
  sha256,
  validateControlRecord,
  validateLeaderboardSnapshot,
  validateResultCatalog,
} from "@harbor-hf/contracts";
import Database from "better-sqlite3";
import type { Projection } from "./projection.js";
import type { ImmutableObjectStore } from "./store.js";

export const LEADERBOARD_SNAPSHOT_PREFIX = "results/schema=v1/leaderboard/snapshots/";
export const LEADERBOARD_RECEIPT_PREFIX = "results/schema=v1/leaderboard/receipts/";
const CATALOG_PREFIX = "results/schema=v1/catalog/records/";

export interface ConfigurationDigestFields {
  benchmark: string;
  benchmark_revision: string;
  task_digests: string[];
  model_id: string;
  model_revision: string;
  harness_agent: string;
  harness_revision: string;
  reasoning_effort: string;
  inference_provider: string;
  harbor_version: string;
  trial_count: number;
  trial_indices: number[];
}

export interface LeaderboardRow {
  configuration_digest: string;
  run_id: string;
  publication_id: string;
  published_at: string;
  benchmark: string;
  model: string;
  harness: string;
  inference_provider: string;
  reasoning_effort: string;
  harbor_version: string;
  trial_count: number;
  task_count: number;
  scored_task_count: number;
  primary_metric_name: string;
  primary_metric_value: number;
  primary_metric_unit: string;
  observed_microusd: number;
}

type CatalogEntry = HarborHFResultCatalogV1["entries"][number];

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`configuration digest requires ${field}`);
  return value;
}

function requiredProfile<K extends ResolvedProfile["kind"]>(
  lock: RunLock,
  kind: K,
): Extract<ResolvedProfile, { kind: K }> {
  const profile = lock.profiles.find(
    (item): item is Extract<ResolvedProfile, { kind: K }> => item.kind === kind,
  );
  if (!profile) throw new Error(`configuration digest requires a ${kind} profile`);
  return profile;
}

/**
 * Extract the fields that identify one leaderboard configuration from a lock.
 *
 * Trial count, reasoning, provider, and Harbor version are in on purpose.
 * Worker revision, Job IDs, and cost are out on purpose.
 */
export function configurationDigestFields(lock: RunLock): ConfigurationDigestFields {
  const benchmark = requiredProfile(lock, "benchmark").spec;
  const model = requiredProfile(lock, "model").spec;
  const harness = requiredProfile(lock, "harness").spec;
  const deployment = requiredProfile(lock, "deployment").spec;
  if (deployment.route !== "hf_job")
    throw new Error("configuration digest requires an hf_job deployment");
  if (!Array.isArray(benchmark.trial_indices) || benchmark.trial_indices.length === 0)
    throw new Error("configuration digest requires trial_indices");
  const trialIndices = [...new Set(benchmark.trial_indices)].sort(
    (left, right) => left - right,
  );
  return {
    benchmark: requiredString(benchmark.benchmark, "benchmark"),
    benchmark_revision: requiredString(benchmark.revision, "benchmark_revision"),
    task_digests: [...benchmark.task_digests],
    model_id: requiredString(model.model_id, "model_id"),
    model_revision: requiredString(model.revision, "model_revision"),
    harness_agent: requiredString(harness.agent, "harness_agent"),
    harness_revision: requiredString(harness.revision, "harness_revision"),
    reasoning_effort: requiredString(harness.reasoning_effort, "reasoning_effort"),
    inference_provider: requiredString(
      deployment.inference_provider,
      "inference_provider",
    ),
    harbor_version: requiredString(deployment.harbor_version, "harbor_version"),
    trial_count: trialIndices.length,
    trial_indices: trialIndices,
  };
}

/** SHA-256 over the canonical configuration digest fields. */
export function configurationDigest(lock: RunLock): string {
  return sha256(
    canonicalJson({
      schema_version: "harbor-hf/configuration-digest/v1",
      ...configurationDigestFields(lock),
    }),
  );
}

/**
 * Mechanical gate for the leaderboard queue and snapshot.
 *
 * Diagnostic, cancelled, mixed, and policy-failed catalogs stay private.
 */
export function leaderboardEligible(entry: CatalogEntry): boolean {
  return (
    entry.publication_role === "final" &&
    entry.quality === "clean" &&
    entry.run_outcome === "complete" &&
    entry.task_count > 0 &&
    entry.scored_task_count === entry.task_count &&
    entry.primary_metric !== null &&
    entry.benchmark !== null &&
    entry.model !== null &&
    entry.harness !== null &&
    entry.inference_provider !== null
  );
}

function catalogString(value: string | null, field: string): string {
  if (value === null || value.length === 0)
    throw new Error(`leaderboard row requires ${field}`);
  return value;
}

async function requirePublishedReceipt(
  store: ImmutableObjectStore,
  entry: CatalogEntry,
  catalogBytes: Uint8Array,
): Promise<void> {
  const receipt = validateControlRecord<PublicationReceipt>(
    JSON.parse(new TextDecoder().decode(await store.read(entry.result_path))),
  );
  if (
    receipt.kind !== "publication.receipt" ||
    receipt.publication_state !== "published" ||
    receipt.publication_id !== entry.publication_id ||
    receipt.run_id !== entry.run_id ||
    receipt.catalog_digest !== sha256(catalogBytes)
  ) {
    throw new Error(
      `leaderboard catalog ${entry.publication_id} has no matching published receipt`,
    );
  }
}

export async function encodeLeaderboardSqlite(
  rows: readonly LeaderboardRow[],
): Promise<Uint8Array> {
  const directory = await mkdtemp(join(tmpdir(), "harbor-hf-leaderboard-"));
  const path = join(directory, "leaderboard.sqlite");
  try {
    const database = new Database(path);
    database.exec(`
      CREATE TABLE snapshot (
        schema_version TEXT NOT NULL,
        entry_count INTEGER NOT NULL
      );
      CREATE TABLE entries (
        configuration_digest TEXT NOT NULL PRIMARY KEY,
        run_id TEXT NOT NULL,
        publication_id TEXT NOT NULL,
        published_at TEXT NOT NULL,
        benchmark TEXT NOT NULL,
        model TEXT NOT NULL,
        harness TEXT NOT NULL,
        inference_provider TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        harbor_version TEXT NOT NULL,
        trial_count INTEGER NOT NULL,
        task_count INTEGER NOT NULL,
        scored_task_count INTEGER NOT NULL,
        primary_metric_name TEXT NOT NULL,
        primary_metric_value REAL NOT NULL,
        primary_metric_unit TEXT NOT NULL,
        observed_microusd INTEGER NOT NULL
      );
    `);
    database
      .prepare("INSERT INTO snapshot (schema_version, entry_count) VALUES (?, ?)")
      .run("v1", rows.length);
    const insert = database.prepare(`
      INSERT INTO entries (
        configuration_digest, run_id, publication_id, published_at,
        benchmark, model, harness, inference_provider, reasoning_effort,
        harbor_version, trial_count, task_count, scored_task_count,
        primary_metric_name, primary_metric_value, primary_metric_unit,
        observed_microusd
      ) VALUES (
        @configuration_digest, @run_id, @publication_id, @published_at,
        @benchmark, @model, @harness, @inference_provider, @reasoning_effort,
        @harbor_version, @trial_count, @task_count, @scored_task_count,
        @primary_metric_name, @primary_metric_value, @primary_metric_unit,
        @observed_microusd
      )
    `);
    const write = database.transaction((items: readonly LeaderboardRow[]) => {
      for (const item of items) insert.run(item);
    });
    write(rows);
    database.close();
    const bytes = await readFile(path);
    return new Uint8Array(bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function selectLeaderboardRows(rows: LeaderboardRow[]): LeaderboardRow[] {
  const selected = new Map<string, LeaderboardRow>();
  const ordered = [...rows].sort((left, right) => {
    const published = right.published_at.localeCompare(left.published_at);
    if (published !== 0) return published;
    return left.run_id.localeCompare(right.run_id);
  });
  for (const row of ordered) {
    if (!selected.has(row.configuration_digest))
      selected.set(row.configuration_digest, row);
  }
  return [...selected.values()].sort((left, right) =>
    left.configuration_digest.localeCompare(right.configuration_digest),
  );
}

async function catalogRows(
  store: ImmutableObjectStore,
  projection: Projection,
): Promise<LeaderboardRow[]> {
  const objects = await store.list(CATALOG_PREFIX);
  const rows: LeaderboardRow[] = [];
  for (const object of objects) {
    const catalogBytes = await store.read(object.key);
    const catalog = validateResultCatalog<HarborHFResultCatalogV1>(
      JSON.parse(new TextDecoder().decode(catalogBytes)),
    );
    for (const entry of catalog.entries) {
      if (!leaderboardEligible(entry)) continue;
      await requirePublishedReceipt(store, entry, catalogBytes);
      const lock = await projection.runLock(entry.run_id);
      if (!lock) throw new Error(`leaderboard catalog ${entry.run_id} has no run lock`);
      const run = await projection.run(entry.run_id);
      if (!run) throw new Error(`leaderboard catalog ${entry.run_id} has no run`);
      const fields = configurationDigestFields(lock);
      const metric = entry.primary_metric;
      if (metric === null)
        throw new Error("eligible catalog is missing a primary metric");
      rows.push({
        configuration_digest: configurationDigest(lock),
        run_id: entry.run_id,
        publication_id: entry.publication_id,
        published_at: entry.published_at,
        benchmark: catalogString(entry.benchmark, "benchmark"),
        model: catalogString(entry.model, "model"),
        harness: catalogString(entry.harness, "harness"),
        inference_provider: catalogString(
          entry.inference_provider,
          "inference_provider",
        ),
        reasoning_effort: fields.reasoning_effort,
        harbor_version: fields.harbor_version,
        trial_count: fields.trial_count,
        task_count: entry.task_count,
        scored_task_count: entry.scored_task_count,
        primary_metric_name: metric.name,
        primary_metric_value: metric.value,
        primary_metric_unit: metric.unit,
        observed_microusd: run.observed_microusd,
      });
    }
  }
  return selectLeaderboardRows(rows);
}

/**
 * Rebuild the shown leaderboard SQLite object from eligible catalogs.
 *
 * Writes the database first, then the snapshot receipt. Identical bytes reuse
 * the same content-addressed key.
 */
export async function refreshLeaderboardSnapshot(
  store: ImmutableObjectStore,
  projection: Projection,
): Promise<HarborHFLeaderboardSnapshotV1 | null> {
  const rows = await catalogRows(store, projection);
  if (rows.length === 0) return null;
  const bytes = await encodeLeaderboardSqlite(rows);
  const sqliteDigest = sha256(bytes);
  const sqliteKey = `${LEADERBOARD_SNAPSHOT_PREFIX}${sqliteDigest.slice("sha256:".length)}/leaderboard.sqlite`;
  await store.create(sqliteKey, bytes);
  const sourceDigest = sha256(
    canonicalJson(
      rows.map((row) => ({
        configuration_digest: row.configuration_digest,
        run_id: row.run_id,
        publication_id: row.publication_id,
      })),
    ),
  );
  const createdAt = rows
    .map((row) => row.published_at)
    .sort((left, right) => left.localeCompare(right))
    .at(-1);
  if (!createdAt) throw new Error("leaderboard snapshot has no published_at");
  const receipt = validateLeaderboardSnapshot<HarborHFLeaderboardSnapshotV1>({
    schema_version: "v1",
    kind: "leaderboard.snapshot",
    record_id: deterministicId("leaderboard-snapshot", sqliteDigest),
    created_at: createdAt,
    actor: { subject: "harbor-hf-control", role: "service" },
    sqlite_key: sqliteKey,
    sqlite_digest: sqliteDigest,
    source_digest: sourceDigest,
    entry_count: rows.length,
  });
  await store.create(
    `${LEADERBOARD_RECEIPT_PREFIX}${receipt.record_id}.json`,
    new TextEncoder().encode(canonicalJson(receipt)),
  );
  return receipt;
}

export interface RankedLeaderboardRow extends LeaderboardRow {
  rank: number;
  pareto: boolean;
}

export interface LoadedLeaderboard {
  snapshot: HarborHFLeaderboardSnapshotV1 | null;
  rows: RankedLeaderboardRow[];
}

/**
 * Read shown leaderboard rows from a content-addressed SQLite snapshot.
 */
export async function decodeLeaderboardSqlite(
  bytes: Uint8Array,
): Promise<LeaderboardRow[]> {
  const directory = await mkdtemp(join(tmpdir(), "harbor-hf-leaderboard-read-"));
  const path = join(directory, "leaderboard.sqlite");
  try {
    await writeFile(path, bytes);
    const database = new Database(path, { readonly: true });
    const rows = database
      .prepare(
        `SELECT
          configuration_digest, run_id, publication_id, published_at,
          benchmark, model, harness, inference_provider, reasoning_effort,
          harbor_version, trial_count, task_count, scored_task_count,
          primary_metric_name, primary_metric_value, primary_metric_unit,
          observed_microusd
        FROM entries
        ORDER BY configuration_digest`,
      )
      .all() as LeaderboardRow[];
    database.close();
    return rows;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Points that no other row beats on both cost and score.
 *
 * Lower observed cost is better. Higher primary metric is better.
 */
export function paretoFrontier(rows: readonly LeaderboardRow[]): ReadonlySet<string> {
  const frontier = new Set<string>();
  for (const row of rows) {
    const dominated = rows.some(
      (other) =>
        other.configuration_digest !== row.configuration_digest &&
        other.observed_microusd <= row.observed_microusd &&
        other.primary_metric_value >= row.primary_metric_value &&
        (other.observed_microusd < row.observed_microusd ||
          other.primary_metric_value > row.primary_metric_value),
    );
    if (!dominated) frontier.add(row.configuration_digest);
  }
  return frontier;
}

/** Rank by score descending, then cost ascending. Mark the Pareto frontier. */
export function rankLeaderboardRows(
  rows: readonly LeaderboardRow[],
): RankedLeaderboardRow[] {
  const frontier = paretoFrontier(rows);
  const ordered = [...rows].sort((left, right) => {
    const score = right.primary_metric_value - left.primary_metric_value;
    if (score !== 0) return score;
    const cost = left.observed_microusd - right.observed_microusd;
    if (cost !== 0) return cost;
    return left.configuration_digest.localeCompare(right.configuration_digest);
  });
  return ordered.map((row, index) => ({
    ...row,
    rank: index + 1,
    pareto: frontier.has(row.configuration_digest),
  }));
}

/**
 * Load the latest Bucket snapshot receipt and its SQLite rows.
 *
 * Rank is computed here. Identical later receipts win by created_at, then id.
 */
export async function loadLatestLeaderboard(
  store: ImmutableObjectStore,
): Promise<LoadedLeaderboard> {
  const receipts: HarborHFLeaderboardSnapshotV1[] = [];
  for (const object of await store.list(LEADERBOARD_RECEIPT_PREFIX)) {
    receipts.push(
      validateLeaderboardSnapshot<HarborHFLeaderboardSnapshotV1>(
        JSON.parse(new TextDecoder().decode(await store.read(object.key))),
      ),
    );
  }
  if (receipts.length === 0) return { snapshot: null, rows: [] };
  receipts.sort((left, right) => {
    const created = right.created_at.localeCompare(left.created_at);
    if (created !== 0) return created;
    return right.record_id.localeCompare(left.record_id);
  });
  const snapshot = receipts[0];
  if (!snapshot) throw new Error("leaderboard receipt list is empty");
  const bytes = await store.read(snapshot.sqlite_key);
  if (sha256(bytes) !== snapshot.sqlite_digest)
    throw new Error("leaderboard snapshot digest mismatch");
  return {
    snapshot,
    rows: rankLeaderboardRows(await decodeLeaderboardSqlite(bytes)),
  };
}
