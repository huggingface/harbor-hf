/* Generated from JSON Schema. Do not edit. */

export interface AttemptSubmissionV1 {
outcome: ("complete" | "invalid" | "infrastructure" | "semantic" | "refusal" | "verifier" | "agent" | "benchmark_timeout" | "cancelled" | "policy")
replacement_eligible: boolean
evidence_digest: string
evidence_path: string
cost_microusd: number
completed_at: string
confirmed: true
metrics: {
[k: string]: number
}
action_id: string
}
