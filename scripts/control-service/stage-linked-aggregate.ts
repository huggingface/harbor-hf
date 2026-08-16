import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HarborHFControlRecordV1, ResolvedProfile } from "@harbor-hf/contracts";
import {
  canonicalJson,
  controlRecordPath,
  deterministicId,
  sha256,
  validateControlRecord,
} from "@harbor-hf/contracts";

interface Arguments {
  aggregate: string;
  taskDigests: string | null;
  output: string;
  createdAt: string;
  sourceRevision: string;
  harnessRevision: string;
}

interface NormalizedOutcome {
  taskId: string;
  inputDigest: string;
  sourceCampaignId: string;
  sourceRole: string;
  trialId: string;
  executionId: string;
  evidenceDigest: string;
  partialScore: number;
  strictReward: number;
  rawPartialScore: number | null;
  nullBaseline: number | null;
}

type JsonObject = Record<string, unknown>;

function argument(name: string, required = true): string | null {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value) return value;
  if (required) throw new Error(`--${name} is required`);
  return null;
}

function parseArguments(): Arguments {
  return {
    aggregate: argument("aggregate") as string,
    taskDigests: argument("task-digests", false),
    output: argument("output") as string,
    createdAt: argument("created-at") as string,
    sourceRevision: argument("source-revision") as string,
    harnessRevision: argument("harness-revision") as string,
  };
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} is missing`);
  return value;
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function prefixedDigest(value: unknown, label: string): string {
  const candidate = text(value, label);
  const digest = candidate.startsWith("sha256:") ? candidate : `sha256:${candidate}`;
  if (!/^sha256:[a-f0-9]{64}$/.test(digest))
    throw new Error(`${label} is not a SHA-256 digest`);
  return digest;
}

function rows(value: JsonObject): JsonObject[] {
  const selected = Array.isArray(value.outcomes)
    ? value.outcomes
    : Array.isArray(value.entries)
      ? value.entries
      : null;
  if (!selected) throw new Error("aggregate has no outcomes or entries array");
  return selected.map((item, index) => object(item, `outcome ${index}`));
}

function taskDigestMap(value: JsonObject): Map<string, string> {
  const output = new Map<string, string>();
  for (const row of rows(value)) {
    const taskId = typeof row.task === "string" ? row.task : row.task_name;
    if (typeof taskId !== "string" || row.task_digest === undefined) continue;
    output.set(taskId, prefixedDigest(row.task_digest, `${taskId} input digest`));
  }
  return output;
}

function sourceCampaigns(value: JsonObject): string[] {
  const output = new Set<string>();
  const scalarKeys = ["parent_campaign_id", "replacement_campaign_id"];
  for (const key of scalarKeys) {
    if (typeof value[key] === "string") output.add(value[key] as string);
  }
  const objectKeys = ["parent_campaign", "replacement_campaign"];
  for (const key of objectKeys) {
    const candidate = value[key];
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const campaignId = (candidate as JsonObject).campaign_id;
      if (typeof campaignId === "string") output.add(campaignId);
    }
  }
  for (const row of rows(value)) {
    const campaignId = row.source_campaign_id ?? row.campaign_id;
    if (typeof campaignId === "string") output.add(campaignId);
  }
  return [...output].sort();
}

function normalize(
  aggregate: JsonObject,
  digests: Map<string, string>,
): NormalizedOutcome[] {
  const parent =
    typeof aggregate.parent_campaign_id === "string"
      ? aggregate.parent_campaign_id
      : typeof aggregate.parent_campaign === "object" && aggregate.parent_campaign
        ? (aggregate.parent_campaign as JsonObject).campaign_id
        : null;
  return rows(aggregate)
    .map((row, index) => {
      const taskId = text(row.task ?? row.task_name, `outcome ${index} task`);
      const sourceCampaignId = text(
        row.source_campaign_id ?? row.campaign_id,
        `${taskId} source campaign`,
      );
      const inputDigest =
        row.task_digest === undefined
          ? digests.get(taskId)
          : prefixedDigest(row.task_digest, `${taskId} input digest`);
      if (!inputDigest) throw new Error(`${taskId} has no attested input digest`);
      return {
        taskId,
        inputDigest,
        sourceCampaignId,
        sourceRole:
          typeof row.source_role === "string"
            ? row.source_role
            : sourceCampaignId === parent
              ? "parent"
              : "replacement",
        trialId: text(row.trial_id, `${taskId} trial ID`),
        executionId: text(row.execution_id, `${taskId} execution ID`),
        evidenceDigest: prefixedDigest(
          row.evidence_manifest_sha256,
          `${taskId} evidence digest`,
        ),
        partialScore: finite(row.partial_score),
        strictReward: finite(row.strict_reward),
        rawPartialScore:
          typeof row.raw_partial_score === "number" ? row.raw_partial_score : null,
        nullBaseline: typeof row.null_baseline === "number" ? row.null_baseline : null,
      };
    })
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
}

function resolvedProfile(
  kind: ResolvedProfile["kind"],
  name: string,
  spec: ResolvedProfile["spec"],
): ResolvedProfile {
  return {
    kind,
    name,
    profile_id: sha256(canonicalJson(spec)),
    spec,
  } as ResolvedProfile;
}

function records(
  aggregate: JsonObject,
  outcomes: NormalizedOutcome[],
  args: Arguments,
): HarborHFControlRecordV1[] {
  if (outcomes.length === 0) throw new Error("aggregate has no outcomes");
  const aggregateDigest = sha256(canonicalJson(aggregate));
  const campaignId = deterministicId("imported-campaign", aggregateDigest);
  const actor = { subject: "legacy-migration", role: "migration" as const };
  const model = text(aggregate.model, "aggregate model");
  const modelRevision = text(aggregate.model_revision, "aggregate model revision");
  const campaigns = sourceCampaigns(aggregate);
  const benchmarkName = "shellbench-structured";
  const modelName = "imported-model";
  const harnessName = "pi";
  const deploymentName = "imported-history";
  const policyName = "imported-history";
  const benchmarkSpec = {
    benchmark: benchmarkName,
    revision: args.sourceRevision,
    task_ids: outcomes.map((item) => item.taskId),
    task_digests: outcomes.map((item) => item.inputDigest),
  };
  const profiles = [
    resolvedProfile("benchmark", benchmarkName, benchmarkSpec),
    resolvedProfile("model", modelName, { model_id: model, revision: modelRevision }),
    resolvedProfile("harness", harnessName, {
      agent: harnessName,
      revision: args.harnessRevision,
      required_evidence: [
        "input-attestation",
        "workspace",
        "trajectory",
        "verification",
      ],
    }),
    resolvedProfile("deployment", deploymentName, {
      route: "imported",
      models: [modelName],
      harnesses: [harnessName],
      source_campaign_ids: campaigns,
      source_revisions: [args.sourceRevision],
    }),
    resolvedProfile("launch_policy", policyName, {
      max_infrastructure_attempts: 2,
      reservation_microusd: 0,
      success_without_worker_receipt: false,
      publication_role: "final",
    }),
  ];
  const result: HarborHFControlRecordV1[] = [
    validateControlRecord({
      schema_version: "v1",
      kind: "campaign.request",
      record_id: deterministicId("request", campaignId),
      created_at: args.createdAt,
      actor,
      campaign_id: campaignId,
      idempotency_key_digest: aggregateDigest,
      profiles: profiles.map((profile) => ({
        kind: profile.kind,
        alias: profile.name,
      })),
      ceiling_microusd: 0,
    }),
    validateControlRecord({
      schema_version: "v1",
      kind: "campaign.lock",
      record_id: deterministicId("lock", campaignId),
      created_at: args.createdAt,
      actor,
      campaign_id: campaignId,
      profiles,
      tasks: outcomes.map((item) => ({
        task_id: item.taskId,
        input_digest: item.inputDigest,
      })),
      ceiling_microusd: 0,
      source_revision: sha256(args.sourceRevision),
    }),
  ];
  const actionIds = new Map<string, string>();
  for (const sourceCampaignId of campaigns) {
    const actionId = deterministicId("imported-action", campaignId, sourceCampaignId);
    actionIds.set(sourceCampaignId, actionId);
    const taskIds = outcomes
      .filter((item) => item.sourceCampaignId === sourceCampaignId)
      .map((item) => item.taskId);
    result.push(
      validateControlRecord({
        schema_version: "v1",
        kind: "action.intent",
        record_id: deterministicId("action-intent", actionId),
        created_at: args.createdAt,
        actor,
        action_id: actionId,
        campaign_id: campaignId,
        action_kind: "job.launch",
        generation: 0,
        target: sourceCampaignId,
        payload: { task_ids: taskIds, reason: "legacy aggregate import" },
      }),
      validateControlRecord({
        schema_version: "v1",
        kind: "action.receipt",
        record_id: deterministicId("action-receipt", actionId),
        created_at: args.createdAt,
        actor,
        action_id: actionId,
        campaign_id: campaignId,
        outcome: "completed",
        observed_state: "imported",
        resource_id: sourceCampaignId,
        cost_microusd: null,
      }),
    );
  }
  for (const item of outcomes) {
    const actionId = actionIds.get(item.sourceCampaignId);
    if (!actionId) throw new Error(`${item.taskId} has no authorizing source action`);
    const attemptId = deterministicId(
      "imported-attempt",
      item.sourceCampaignId,
      item.trialId,
      item.executionId,
    );
    result.push(
      validateControlRecord({
        schema_version: "v1",
        kind: "attempt.receipt",
        record_id: deterministicId("attempt-receipt", attemptId),
        created_at: args.createdAt,
        actor,
        campaign_id: campaignId,
        task_id: item.taskId,
        attempt_id: attemptId,
        action_id: actionId,
        outcome: "complete",
        replacement_eligible: false,
        evidence_digest: item.evidenceDigest,
        evidence_path: `legacy/${item.sourceCampaignId}/${item.trialId}/${item.executionId}`,
        cost_microusd: 0,
        metrics: {
          reward: item.partialScore,
          strict_reward: item.strictReward,
          ...(item.rawPartialScore === null
            ? {}
            : { raw_partial_score: item.rawPartialScore }),
          ...(item.nullBaseline === null ? {} : { null_baseline: item.nullBaseline }),
        },
      }),
      validateControlRecord({
        schema_version: "v1",
        kind: "terminal.selection",
        record_id: deterministicId("terminal", campaignId, item.taskId, attemptId),
        created_at: args.createdAt,
        actor,
        campaign_id: campaignId,
        task_id: item.taskId,
        attempt_id: attemptId,
        outcome: "complete",
        reason: `imported ${item.sourceRole} outcome from checksum-attested aggregate`,
      }),
    );
  }
  return result;
}

async function loadJson(path: string): Promise<JsonObject> {
  return object(JSON.parse(await readFile(path, "utf8")), path);
}

async function main(): Promise<void> {
  const args = parseArguments();
  const aggregate = await loadJson(args.aggregate);
  const digestSource = args.taskDigests ? await loadJson(args.taskDigests) : aggregate;
  const outcomes = normalize(aggregate, taskDigestMap(digestSource));
  const staged = records(aggregate, outcomes, args);
  for (const record of staged) {
    const relative = controlRecordPath(record);
    const path = join(args.output, "canonical", relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, canonicalJson(record), { flag: "wx", mode: 0o600 });
  }
  const summary = {
    schema_version: "harbor-hf/linked-aggregate-staging/v1",
    aggregate_digest: sha256(canonicalJson(aggregate)),
    record_count: staged.length,
    task_count: outcomes.length,
    source_campaign_count: sourceCampaigns(aggregate).length,
    campaign_id: (staged[0] as { campaign_id: string }).campaign_id,
  };
  await writeFile(join(args.output, "staging-summary.json"), canonicalJson(summary), {
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(canonicalJson(summary));
}

await main();
