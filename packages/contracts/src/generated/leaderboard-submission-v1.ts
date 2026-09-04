/* Generated from JSON Schema. Do not edit. */

export interface LeaderboardSubmissionRecord {
schema_version: "v1"
record_id: string
created_at: string
actor: {
subject: string
role: ("operator" | "submitter")
}
kind: "leaderboard.submission"
run_id: string
publication_id: string
catalog_key: string
catalog_digest: string
lock_digest: string
public_row_digest: string
confirmed: true
}
