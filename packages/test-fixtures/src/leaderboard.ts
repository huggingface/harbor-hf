import {
  canonicalJson,
  deterministicId,
  type LeaderboardDecisionRecord,
  type LeaderboardSubmissionRecord,
  sha256,
  validateLeaderboardDecision,
  validateLeaderboardSubmission,
} from "@harbor-hf/contracts";
import {
  createJson,
  type ImmutableObjectStore,
  type LeaderboardRow,
} from "@harbor-hf/control-core";

/** Explicit consent records for synthetic snapshot-reader fixtures (not execution fixtures). */
export async function approveSnapshotFixture(
  store: ImmutableObjectStore,
  row: LeaderboardRow,
): Promise<void> {
  const catalogKey = `results/schema=v1/catalog/records/${row.publication_id}.json`;
  const catalog = {
    schema_version: "v1",
    kind: "result.catalog",
    record_id: row.publication_id,
    created_at: row.published_at,
    source_digest: sha256("fixture"),
    entries: [
      {
        publication_id: row.publication_id,
        run_id: row.run_id,
        published_at: row.published_at,
        benchmark: row.benchmark,
        model: row.model,
        harness: row.harness,
        inference_provider: row.inference_provider,
        run_outcome: "complete",
        quality: "clean",
        publication_role: "final",
        task_count: row.task_count,
        scored_task_count: row.scored_task_count,
        strict_pass_count: 0,
        primary_metric: {
          name: row.primary_metric_name,
          value: row.primary_metric_value,
          unit: row.primary_metric_unit,
        },
        result_path: `results/${row.publication_id}.json`,
      },
    ],
  };
  const catalogDigest = sha256(canonicalJson(catalog));
  await createJson(store, catalogKey, catalog);
  const id = deterministicId(
    "leaderboard-submission",
    row.run_id,
    row.publication_id,
    catalogDigest,
  );
  const submission = validateLeaderboardSubmission<LeaderboardSubmissionRecord>({
    schema_version: "v1",
    kind: "leaderboard.submission",
    record_id: id,
    created_at: row.published_at,
    actor: { subject: "fixture-operator", role: "operator" },
    run_id: row.run_id,
    publication_id: row.publication_id,
    catalog_key: catalogKey,
    catalog_digest: catalogDigest,
    lock_digest: sha256("fixture-lock"),
    public_row_digest: sha256(canonicalJson(row)),
    confirmed: true,
  });
  await createJson(
    store,
    `results/schema=v1/leaderboard/submissions/${id}.json`,
    submission,
  );
  const decision = validateLeaderboardDecision<LeaderboardDecisionRecord>({
    schema_version: "v1",
    kind: "leaderboard.decision",
    record_id: deterministicId("leaderboard-decision", id),
    created_at: row.published_at,
    actor: { subject: "fixture-operator", role: "operator" },
    submission_id: id,
    submission_digest: sha256(canonicalJson(submission)),
    catalog_digest: catalogDigest,
    public_row_digest: submission.public_row_digest,
    decision: "approved",
    public_metadata_confirmed: true,
  });
  await createJson(
    store,
    `results/schema=v1/leaderboard/decisions/${id}.json`,
    decision,
  );
}
