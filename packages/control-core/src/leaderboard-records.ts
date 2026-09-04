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
  ImmutableConflictError,
  type ImmutableObjectStore,
} from "./store.js";

export const SUBMISSION_PREFIX = "results/schema=v1/leaderboard/submissions/";
export const DECISION_PREFIX = "results/schema=v1/leaderboard/decisions/";
export const recordDigest = (value: unknown): string => sha256(canonicalJson(value));
export function submissionId(run: string, publication: string, digest: string): string {
  return deterministicId("leaderboard-submission", run, publication, digest);
}
export async function submissions(
  store: ImmutableObjectStore,
): Promise<LeaderboardSubmissionRecord[]> {
  const records: LeaderboardSubmissionRecord[] = [];
  for (const object of await store.list(SUBMISSION_PREFIX)) {
    const record = validateLeaderboardSubmission<LeaderboardSubmissionRecord>(
      JSON.parse(new TextDecoder().decode(await store.read(object.key))),
    );
    if (
      record.record_id !==
        submissionId(record.run_id, record.publication_id, record.catalog_digest) ||
      object.key !== `${SUBMISSION_PREFIX}${record.record_id}.json`
    )
      throw new Error("leaderboard submission integrity failure");
    records.push(record);
  }
  return records;
}
export async function decisions(
  store: ImmutableObjectStore,
): Promise<LeaderboardDecisionRecord[]> {
  const records: LeaderboardDecisionRecord[] = [];
  for (const object of await store.list(DECISION_PREFIX)) {
    const record = validateLeaderboardDecision<LeaderboardDecisionRecord>(
      JSON.parse(new TextDecoder().decode(await store.read(object.key))),
    );
    if (
      object.key !== `${DECISION_PREFIX}${record.submission_id}.json` ||
      record.record_id !== deterministicId("leaderboard-decision", record.submission_id)
    )
      throw new Error("leaderboard decision integrity failure");
    records.push(record);
  }
  return records;
}
export function decisionMatches(
  submission: LeaderboardSubmissionRecord,
  decision: LeaderboardDecisionRecord,
): boolean {
  return (
    decision.submission_id === submission.record_id &&
    decision.submission_digest === recordDigest(submission) &&
    decision.catalog_digest === submission.catalog_digest &&
    decision.public_row_digest === submission.public_row_digest
  );
}

/** Existing snapshots are not grandfathered: every displayed row needs exact consent. */
export async function approvedSubmissions(
  store: ImmutableObjectStore,
): Promise<LeaderboardSubmissionRecord[]> {
  const pending = new Map(
    (await submissions(store)).map((record) => [record.record_id, record]),
  );
  const approved: LeaderboardSubmissionRecord[] = [];
  for (const decision of await decisions(store)) {
    const submission = pending.get(decision.submission_id);
    if (!submission || !decisionMatches(submission, decision))
      throw new Error("leaderboard decision binding failure");
    if (decision.decision !== "approved") continue;
    if (sha256(await store.read(submission.catalog_key)) !== submission.catalog_digest)
      throw new Error("leaderboard approved catalog digest mismatch");
    approved.push(submission);
  }
  return approved;
}

export async function approvedRowDigests(
  store: ImmutableObjectStore,
): Promise<Set<string>> {
  return new Set(
    (await approvedSubmissions(store)).map((item) => item.public_row_digest),
  );
}

/** The immutable key is the concurrency fence; a lost response adopts the winner. */
export async function createOrAdopt<T>(
  store: ImmutableObjectStore,
  key: string,
  record: T,
  read: () => Promise<T | undefined>,
  matches: (existing: T) => boolean,
): Promise<T> {
  try {
    await createJson(store, key, record);
    return record;
  } catch (error) {
    if (!(error instanceof ImmutableConflictError)) throw error;
    const existing = await read();
    if (existing && matches(existing)) return existing;
    throw error;
  }
}
