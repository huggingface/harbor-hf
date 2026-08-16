/* Generated from JSON Schema. Do not edit. */

export interface CampaignActionV1 {
action: ("cancel" | "retry_infrastructure" | "publish" | "pause_endpoint")
task_id?: (string | null)
reason?: (string | null)
confirmed: boolean
}
