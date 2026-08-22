/* Generated from JSON Schema. Do not edit. */

export interface CampaignActionV1 {
action: ("cancel" | "retry_infrastructure" | "publish" | "pause_endpoint" | "pause" | "resume" | "supersede")
task_id?: (string | null)
reason?: (string | null)
confirmed: boolean
task_limit?: (number | null)
publication_id?: (string | null)
}
