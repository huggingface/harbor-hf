import {
  type Actor,
  deterministicId,
  type LeaderboardDecisionRecord,
  type LeaderboardSubmissionRecord,
  validateLeaderboardDecision,
  validateLeaderboardSubmission,
} from "@harbor-hf/contracts";
import {
  type LeaderboardCandidate,
  leaderboardCandidates,
  refreshLeaderboardSnapshot,
} from "./leaderboard.js";
import {
  createOrAdopt,
  DECISION_PREFIX,
  decisionMatches,
  decisions,
  recordDigest,
  SUBMISSION_PREFIX,
  submissionId,
  submissions,
} from "./leaderboard-records.js";
import type { Projection } from "./projection.js";
import { type Clock, systemClock } from "./service.js";
import { ImmutableConflictError, type ImmutableObjectStore } from "./store.js";

export class LeaderboardSubmissionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const missing = () =>
  new LeaderboardSubmissionError(
    404,
    "not_found",
    "submission or hosted result not found",
  );
const conflict = () =>
  new LeaderboardSubmissionError(
    409,
    "review_conflict",
    "the submission already has a different decision",
  );

function submissionSummary(
  item: LeaderboardSubmissionRecord,
  review?: LeaderboardDecisionRecord,
) {
  if (review && !decisionMatches(item, review))
    throw new Error("leaderboard decision binding failure");
  return {
    id: item.record_id,
    run_id: item.run_id,
    publication_id: item.publication_id,
    catalog_digest: item.catalog_digest,
    created_at: item.created_at,
    status: review?.decision ?? "pending",
  };
}

export class LeaderboardSubmissions {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly store: ImmutableObjectStore,
    private readonly projection: Projection,
    private readonly clock: Clock = systemClock,
  ) {}

  async candidates(actor: Actor): Promise<LeaderboardCandidate[]> {
    return leaderboardCandidates(this.store, this.projection, actor);
  }

  async list(actor: Actor) {
    const reviews = new Map(
      (await decisions(this.store)).map((item) => [item.submission_id, item]),
    );
    return (await submissions(this.store))
      .filter(
        (item) => actor.role === "operator" || item.actor.subject === actor.subject,
      )
      .map((item) => submissionSummary(item, reviews.get(item.record_id)));
  }

  async summary(record: LeaderboardSubmissionRecord) {
    const review = (await decisions(this.store)).find(
      (item) => item.submission_id === record.record_id,
    );
    return submissionSummary(record, review);
  }

  async submit(
    actor: Actor,
    runId: string,
    expectedCatalogDigest?: string,
  ): Promise<LeaderboardSubmissionRecord> {
    if (actor.role !== "operator" && actor.role !== "submitter")
      throw new LeaderboardSubmissionError(
        403,
        "access_denied",
        "submission access is required",
      );
    // Ownership is checked before exposing eligibility, publication, or existence.
    const lock = await this.projection.runLock(runId);
    const request = await this.projection.runRequest(runId);
    if (
      !lock ||
      (actor.role !== "operator" &&
        (request?.actor ?? lock.actor).subject !== actor.subject)
    )
      throw missing();
    const candidate = (await this.candidates(actor))
      .filter((item) => item.row.run_id === runId)
      .sort(
        (a, b) =>
          b.row.published_at.localeCompare(a.row.published_at) ||
          b.catalog_digest.localeCompare(a.catalog_digest),
      )[0];
    if (!candidate)
      throw new LeaderboardSubmissionError(
        422,
        "ineligible_result",
        "the hosted result is not eligible for the public leaderboard",
      );
    if (expectedCatalogDigest && candidate.catalog_digest !== expectedCatalogDigest)
      throw new LeaderboardSubmissionError(
        409,
        "result_changed",
        "the result changed; reload and confirm the exact public fields again",
      );
    const id = submissionId(
      runId,
      candidate.row.publication_id,
      candidate.catalog_digest,
    );
    const record = validateLeaderboardSubmission<LeaderboardSubmissionRecord>({
      schema_version: "v1",
      kind: "leaderboard.submission",
      record_id: id,
      created_at: this.clock.now().toISOString(),
      actor: { subject: actor.subject, role: actor.role },
      run_id: runId,
      publication_id: candidate.row.publication_id,
      catalog_key: candidate.catalog_key,
      catalog_digest: candidate.catalog_digest,
      lock_digest: candidate.lock_digest,
      public_row_digest: recordDigest(candidate.row),
      confirmed: true,
    });
    return createOrAdopt(
      this.store,
      `${SUBMISSION_PREFIX}${id}.json`,
      record,
      async () => (await submissions(this.store)).find((item) => item.record_id === id),
      (existing) =>
        existing.catalog_digest === record.catalog_digest &&
        existing.lock_digest === record.lock_digest &&
        existing.public_row_digest === record.public_row_digest,
    );
  }

  review(
    actor: Actor,
    id: string,
    decision: "approved" | "rejected",
    publicMetadataConfirmed: boolean,
  ): Promise<LeaderboardDecisionRecord> {
    const operation = this.queue.then(() =>
      this.reviewOnce(actor, id, decision, publicMetadataConfirmed),
    );
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async reviewOnce(
    actor: Actor,
    id: string,
    decision: "approved" | "rejected",
    publicMetadataConfirmed: boolean,
  ): Promise<LeaderboardDecisionRecord> {
    if (actor.role !== "operator")
      throw new LeaderboardSubmissionError(
        403,
        "operator_required",
        "operator access is required",
      );
    if (decision === "approved" && !publicMetadataConfirmed)
      throw new LeaderboardSubmissionError(
        400,
        "public_metadata_confirmation_required",
        "confirm privacy and consent for the exact public metadata before approval",
      );
    const submission = (await submissions(this.store)).find(
      (item) => item.record_id === id,
    );
    if (!submission) throw missing();
    if (decision === "approved") {
      const candidate = (await this.candidates(actor)).find(
        (item) =>
          item.catalog_key === submission.catalog_key &&
          item.catalog_digest === submission.catalog_digest &&
          item.row.run_id === submission.run_id &&
          item.row.publication_id === submission.publication_id,
      );
      if (
        !candidate ||
        candidate.lock_digest !== submission.lock_digest ||
        recordDigest(candidate.row) !== submission.public_row_digest
      )
        throw new LeaderboardSubmissionError(
          409,
          "evidence_changed",
          "the exact submitted evidence is no longer eligible",
        );
    }
    const record = validateLeaderboardDecision<LeaderboardDecisionRecord>({
      schema_version: "v1",
      kind: "leaderboard.decision",
      record_id: deterministicId("leaderboard-decision", id),
      created_at: this.clock.now().toISOString(),
      actor: { subject: actor.subject, role: "operator" },
      submission_id: id,
      submission_digest: recordDigest(submission),
      catalog_digest: submission.catalog_digest,
      public_row_digest: submission.public_row_digest,
      decision,
      public_metadata_confirmed: publicMetadataConfirmed,
    });
    let stored: LeaderboardDecisionRecord;
    try {
      stored = await createOrAdopt(
        this.store,
        `${DECISION_PREFIX}${id}.json`,
        record,
        async () =>
          (await decisions(this.store)).find((item) => item.submission_id === id),
        (existing) =>
          decisionMatches(submission, existing) && existing.decision === decision,
      );
    } catch (error) {
      if (error instanceof ImmutableConflictError) throw conflict();
      throw error;
    }
    // A repeated approval also repairs a snapshot write interrupted after the decision.
    if (stored.decision === "approved")
      await refreshLeaderboardSnapshot(this.store, this.projection);
    return stored;
  }
}
