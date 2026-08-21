import type {
  Actor,
  AttemptReceipt,
  HarborHFResultCatalogV1,
  PublicationReceipt,
} from "@harbor-hf/contracts";
import { canonicalJson, deterministicId, sha256 } from "@harbor-hf/contracts";
import { type BasicType, parquetWriteBuffer } from "hyparquet-writer";
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

export class ResultPublisher {
  constructor(
    private readonly store: ImmutableObjectStore,
    private readonly projection: Projection,
    private readonly service: ControlService,
  ) {}

  async publish(campaignId: string): Promise<PublicationReceipt> {
    const existing = await this.projection.campaignPublication(campaignId);
    if (existing?.status === "published")
      return JSON.parse(existing.body) as PublicationReceipt;
    const campaign = await this.projection.campaign(campaignId);
    if (
      !campaign ||
      campaign.terminal_tasks !== campaign.total_tasks ||
      campaign.total_tasks === 0
    ) {
      throw new Error("campaign is not ready for publication");
    }
    const tasks = await this.projection.tasks(campaignId);
    const attempts = await this.projection.campaignAttempts(campaignId);
    const attemptsById = new Map(
      attempts.map((attempt) => [
        attempt.attempt_id,
        JSON.parse(attempt.body) as AttemptReceipt,
      ]),
    );
    const selectedAttempts = tasks
      .map((task) =>
        task.selected_attempt_id
          ? attemptsById.get(task.selected_attempt_id)
          : undefined,
      )
      .filter((attempt): attempt is AttemptReceipt => Boolean(attempt));
    const metricRows = selectedAttempts.flatMap((attempt) =>
      Object.entries(attempt.metrics).map(([name, value]) => ({
        owner_type: "task",
        owner_id: attempt.task_id,
        name,
        value,
      })),
    );
    metricRows.push({
      owner_type: "campaign",
      owner_id: campaignId,
      name: "observed_microusd",
      value: campaign.observed_microusd,
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
        { name: "campaign_id", data: [campaignId], type: "STRING" },
        { name: "status", data: [campaign.status], type: "STRING" },
        { name: "created_at", data: [campaign.created_at], type: "STRING" },
        { name: "total_tasks", data: [campaign.total_tasks], type: "INT32" },
        { name: "terminal_tasks", data: [campaign.terminal_tasks], type: "INT32" },
        {
          name: "ceiling_microusd",
          data: [BigInt(campaign.ceiling_microusd)],
          type: "INT64",
        },
        {
          name: "observed_microusd",
          data: [BigInt(campaign.observed_microusd)],
          type: "INT64",
        },
      ]),
      writeParquet(this.store, "trials", [
        { name: "campaign_id", data: tasks.map(() => campaignId), type: "STRING" },
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
        { name: "campaign_id", data: attempts.map(() => campaignId), type: "STRING" },
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
          name: "campaign_id",
          data: metricRows.map(() => campaignId),
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
        { name: "campaign_id", data: attempts.map(() => campaignId), type: "STRING" },
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
    const publicationId = deterministicId("publication", campaignId);
    const lock = await this.projection.campaignLock(campaignId);
    if (!lock) throw new Error("campaign lock is missing during publication");
    const resolvedProfile = (kind: string) =>
      lock.profiles.find((profile) => profile.kind === kind);
    const profileValue = (kind: string, key: string): string | null => {
      const profile = resolvedProfile(kind);
      if (!profile) return null;
      const value = (profile.spec as unknown as Record<string, unknown>)[key];
      return typeof value === "string" ? value : profile.name;
    };
    const policy = resolvedProfile("launch_policy");
    const publicationRole = policy
      ? (policy.spec as unknown as Record<string, unknown>).publication_role
      : null;
    if (
      publicationRole !== "final" &&
      publicationRole !== "component" &&
      publicationRole !== "diagnostic"
    )
      throw new Error("campaign launch policy has no publication role");
    const createdAt =
      selectedAttempts
        .map((attempt) => attempt.created_at)
        .sort((left, right) => left.localeCompare(right))
        .at(-1) ?? campaign.created_at;
    const sourceDigest = sha256(
      canonicalJson({
        campaign_id: campaignId,
        campaign_lock_id: lock.record_id,
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
          campaign_id: campaignId,
          run_id: null,
          published_at: createdAt,
          benchmark: profileValue("benchmark", "benchmark"),
          model: profileValue("model", "model_id"),
          harness: profileValue("harness", "agent"),
          inference_provider: profileValue("deployment", "inference_provider"),
          run_outcome: runOutcome,
          quality: tasks.every((task) => task.terminal_outcome === "complete")
            ? "clean"
            : "degraded",
          publication_role: publicationRole,
          task_count: campaign.total_tasks,
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
    await this.store.create(
      `results/schema=v1/catalog/records/${catalog.record_id}.json`,
      catalogBytes,
    );
    const receipt: PublicationReceipt = {
      schema_version: "v1",
      kind: "publication.receipt",
      record_id: deterministicId("publication-receipt", publicationId),
      created_at: createdAt,
      actor: serviceActor(),
      campaign_id: campaignId,
      publication_id: publicationId,
      publication_state: "published",
      object_digests: objects.map((item) => item.digest),
      catalog_digest: catalogDigest,
      error_code: null,
    };
    const receiptBytes = new TextEncoder().encode(canonicalJson(receipt));
    await this.store.create(
      `results/schema=v1/publications/${publicationId}/receipt.json`,
      receiptBytes,
    );
    await refreshLeaderboardSnapshot(this.store, this.projection);
    await this.service.writePublication(receipt);
    return receipt;
  }
}
