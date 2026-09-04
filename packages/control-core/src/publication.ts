import type {
  Actor,
  AttemptReceipt,
  HarborHFResultCatalogV1,
  PublicationReceipt,
  RunLock,
} from "@harbor-hf/contracts";
import { canonicalJson, deterministicId, sha256 } from "@harbor-hf/contracts";
import { type BasicType, parquetWriteBuffer } from "hyparquet-writer";
import {
  attemptAdmissibility,
  requiredPositiveMetrics,
} from "./attempt-admissibility.js";
import { refreshLeaderboardSnapshot } from "./leaderboard.js";
import type { Projection } from "./projection.js";
import type { ControlService } from "./service.js";
import type { ImmutableObjectStore } from "./store.js";

interface Column {
  name: string;
  data: Array<string | number | bigint | boolean | null>;
  type: BasicType;
}

function parquet(columns: readonly Column[]): Uint8Array {
  const buffer = parquetWriteBuffer({ columnData: [...columns] });
  return new Uint8Array(buffer);
}

async function writeParquet(
  store: ImmutableObjectStore,
  section: string,
  columns: readonly Column[],
): Promise<{ key: string; digest: string }> {
  const bytes = parquet(columns);
  const digest = sha256(bytes);
  const key = `results/schema=v1/rows/${section}/${digest.slice("sha256:".length)}.parquet`;
  await store.create(key, bytes);
  return { key, digest };
}

function serviceActor(): Actor {
  return { subject: "harbor-hf-control", role: "service" };
}

type PublicationRole = HarborHFResultCatalogV1["entries"][number]["publication_role"];

function publicationRole(lock: RunLock): PublicationRole {
  const policy = lock.profiles.find((profile) => profile.kind === "launch_policy");
  const role = policy
    ? (policy.spec as unknown as Record<string, unknown>).publication_role
    : null;
  if (role !== "final" && role !== "component" && role !== "diagnostic")
    throw new Error("run launch policy has no publication role");
  return role;
}

export class ResultPublisher {
  constructor(
    private readonly store: ImmutableObjectStore,
    private readonly projection: Projection,
    private readonly service: ControlService,
  ) {}

  async publish(runId: string): Promise<PublicationReceipt> {
    const lock = await this.projection.runLock(runId);
    if (!lock) throw new Error("run lock is missing for publication");
    const role = publicationRole(lock);
    const existing = await this.projection.runPublication(runId);
    if (existing?.status === "published") {
      const receipt = JSON.parse(existing.body) as PublicationReceipt;
      if (role === "final")
        await refreshLeaderboardSnapshot(this.store, this.projection);
      return receipt;
    }
    const run = await this.projection.run(runId);
    if (
      !run ||
      run.terminal_tasks !== run.total_tasks ||
      run.admissible_tasks !== run.total_tasks ||
      run.exhausted_tasks > 0 ||
      run.total_tasks === 0 ||
      run.pending_actions > 1 ||
      run.cleanup_pending
    ) {
      throw new Error("run is not ready for publication");
    }
    const tasks = await this.projection.tasks(runId);
    const attempts = await this.projection.runAttempts(runId);
    const attemptsById = new Map(
      attempts.map((attempt) => [
        attempt.attempt_id,
        JSON.parse(attempt.body) as AttemptReceipt,
      ]),
    );
    const required = requiredPositiveMetrics(lock);
    const selectedAttempts = tasks.map((task) => {
      if (!task.selected_attempt_id)
        throw new Error(`task has no selected attempt: ${task.task_id}`);
      const attempt = attemptsById.get(task.selected_attempt_id);
      if (!attempt || attempt.run_id !== runId || attempt.task_id !== task.task_id)
        throw new Error(`selected attempt does not match task: ${task.task_id}`);
      const validity = attemptAdmissibility(attempt, required);
      if (!validity.admissible)
        throw new Error(`selected attempt is not admissible: ${task.task_id}`);
      return attempt;
    });
    if (selectedAttempts.length !== run.total_tasks)
      throw new Error("publication selection coverage is incomplete");
    const metricRows = selectedAttempts.flatMap((attempt) =>
      Object.entries(attempt.metrics).map(([name, value]) => ({
        owner_type: "task",
        owner_id: attempt.task_id,
        name,
        value,
      })),
    );
    metricRows.push({
      owner_type: "run",
      owner_id: runId,
      name: "observed_microusd",
      value: run.observed_microusd,
    });
    const rewardValues = selectedAttempts.flatMap((attempt) =>
      typeof attempt.metrics.reward === "number" ? [attempt.metrics.reward] : [],
    );
    const strictValues = selectedAttempts.flatMap((attempt) =>
      typeof attempt.metrics.strict_reward === "number"
        ? [attempt.metrics.strict_reward]
        : [],
    );
    const objects = await Promise.all([
      writeParquet(this.store, "runs", [
        { name: "run_id", data: [runId], type: "STRING" },
        { name: "status", data: [run.status], type: "STRING" },
        { name: "created_at", data: [run.created_at], type: "STRING" },
        { name: "total_tasks", data: [run.total_tasks], type: "INT32" },
        { name: "terminal_tasks", data: [run.terminal_tasks], type: "INT32" },
        {
          name: "ceiling_microusd",
          data: [BigInt(run.ceiling_microusd)],
          type: "INT64",
        },
        {
          name: "observed_microusd",
          data: [BigInt(run.observed_microusd)],
          type: "INT64",
        },
      ]),
      writeParquet(this.store, "trials", [
        { name: "run_id", data: tasks.map(() => runId), type: "STRING" },
        { name: "task_id", data: tasks.map((task) => task.task_id), type: "STRING" },
        {
          name: "input_digest",
          data: tasks.map((task) => task.input_digest),
          type: "STRING",
        },
        {
          name: "outcome",
          data: tasks.map((task) => task.terminal_outcome ?? "unknown"),
          type: "STRING",
        },
        {
          name: "selected_attempt_id",
          data: tasks.map((task) => task.selected_attempt_id ?? ""),
          type: "STRING",
        },
      ]),
      writeParquet(this.store, "executions", [
        { name: "run_id", data: attempts.map(() => runId), type: "STRING" },
        {
          name: "task_id",
          data: attempts.map((attempt) => attempt.task_id),
          type: "STRING",
        },
        {
          name: "attempt_id",
          data: attempts.map((attempt) => attempt.attempt_id),
          type: "STRING",
        },
        {
          name: "action_id",
          data: attempts.map((attempt) => attempt.action_id),
          type: "STRING",
        },
        {
          name: "outcome",
          data: attempts.map((attempt) => attempt.outcome),
          type: "STRING",
        },
        {
          name: "replacement_eligible",
          data: attempts.map((attempt) => Boolean(attempt.replacement_eligible)),
          type: "BOOLEAN",
        },
        {
          name: "cost_microusd",
          data: attempts.map((attempt) => BigInt(attempt.cost_microusd)),
          type: "INT64",
        },
      ]),
      writeParquet(this.store, "metrics", [
        {
          name: "run_id",
          data: metricRows.map(() => runId),
          type: "STRING",
        },
        {
          name: "owner_type",
          data: metricRows.map((row) => row.owner_type),
          type: "STRING",
        },
        {
          name: "owner_id",
          data: metricRows.map((row) => row.owner_id),
          type: "STRING",
        },
        {
          name: "metric",
          data: metricRows.map((row) => row.name),
          type: "STRING",
        },
        {
          name: "value",
          data: metricRows.map((row) => row.value),
          type: "DOUBLE",
        },
      ]),
      writeParquet(this.store, "artifacts", [
        { name: "run_id", data: attempts.map(() => runId), type: "STRING" },
        {
          name: "attempt_id",
          data: attempts.map((attempt) => attempt.attempt_id),
          type: "STRING",
        },
        {
          name: "evidence_path",
          data: attempts.map((attempt) => attempt.evidence_path),
          type: "STRING",
        },
        {
          name: "evidence_digest",
          data: attempts.map((attempt) => attempt.evidence_digest),
          type: "STRING",
        },
      ]),
    ]);
    const publicationId = deterministicId("publication", runId);
    const resolvedProfile = (kind: string) =>
      lock.profiles.find((profile) => profile.kind === kind);
    const profileValue = (kind: string, key: string): string | null => {
      const profile = resolvedProfile(kind);
      if (!profile) return null;
      const value = (profile.spec as unknown as Record<string, unknown>)[key];
      return typeof value === "string" ? value : profile.name;
    };
    const createdAt =
      selectedAttempts
        .map((attempt) => attempt.created_at)
        .sort((left, right) => left.localeCompare(right))
        .at(-1) ?? run.created_at;
    const sourceDigest = sha256(
      canonicalJson({
        run_id: runId,
        run_lock_id: lock.record_id,
        object_digests: objects.map((item) => item.digest),
      }),
    );
    const terminalOutcomes = tasks.map((task) => task.terminal_outcome);
    if (terminalOutcomes.some((outcome) => outcome === null))
      throw new Error("publication contains a nonterminal task");
    const uniqueOutcomes = new Set(terminalOutcomes as string[]);
    const runOutcome =
      uniqueOutcomes.size === 1 ? ([...uniqueOutcomes][0] ?? "unknown") : "mixed";
    const catalog: HarborHFResultCatalogV1 = {
      schema_version: "v1",
      kind: "result.catalog",
      record_id: deterministicId("catalog", publicationId),
      created_at: createdAt,
      source_digest: sourceDigest,
      entries: [
        {
          publication_id: publicationId,
          run_id: runId,
          published_at: createdAt,
          observed_microusd: run.observed_microusd,
          benchmark: profileValue("benchmark", "benchmark"),
          model: profileValue("model", "model_id"),
          harness: profileValue("harness", "agent"),
          inference_provider: profileValue("deployment", "inference_provider"),
          run_outcome: runOutcome,
          quality: tasks.every((task) => task.terminal_outcome === "complete")
            ? "clean"
            : "degraded",
          publication_role: role,
          task_count: run.total_tasks,
          scored_task_count: rewardValues.length,
          strict_pass_count: strictValues.length
            ? strictValues.filter((value) => value === 1).length
            : null,
          primary_metric: rewardValues.length
            ? {
                name: "mean_reward",
                value:
                  rewardValues.reduce((sum, value) => sum + value, 0) /
                  rewardValues.length,
                unit: "score",
              }
            : null,
          result_path: `results/schema=v1/publications/${publicationId}/receipt.json`,
        },
      ],
    };
    const catalogBytes = new TextEncoder().encode(canonicalJson(catalog));
    const catalogDigest = sha256(catalogBytes);
    const receipt: PublicationReceipt = {
      schema_version: "v1",
      kind: "publication.receipt",
      record_id: deterministicId("publication-receipt", publicationId),
      created_at: createdAt,
      actor: serviceActor(),
      run_id: runId,
      publication_id: publicationId,
      publication_state: "published",
      object_digests: objects.map((item) => item.digest),
      catalog_digest: catalogDigest,
      error_code: null,
    };
    const receiptBytes = new TextEncoder().encode(canonicalJson(receipt));
    const receiptPath = `results/schema=v1/publications/${publicationId}/receipt.json`;
    await this.store.create(receiptPath, receiptBytes);
    for (const object of objects) {
      const stored = await this.store.read(object.key);
      if (sha256(stored) !== object.digest)
        throw new Error(`published object readback failed: ${object.key}`);
    }
    if (sha256(await this.store.read(receiptPath)) !== sha256(receiptBytes))
      throw new Error("publication receipt readback failed");
    const catalogPath = `results/schema=v1/catalog/records/${catalog.record_id}.json`;
    await this.store.create(catalogPath, catalogBytes);
    if (sha256(await this.store.read(catalogPath)) !== catalogDigest)
      throw new Error("publication catalog readback failed");
    await this.service.writePublication(receipt);
    if (role === "final") await refreshLeaderboardSnapshot(this.store, this.projection);
    return receipt;
  }
}
