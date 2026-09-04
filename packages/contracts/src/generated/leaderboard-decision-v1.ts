/* Generated from JSON Schema. Do not edit. */

export type LeaderboardDecisionRecord = ({
[k: string]: unknown
} & {
schema_version: "v1"
record_id: string
created_at: string
actor: {
subject: string
role: "operator"
}
kind: "leaderboard.decision"
submission_id: string
submission_digest: string
catalog_digest: string
public_row_digest: string
decision: ("approved" | "rejected")
public_metadata_confirmed: boolean
})
