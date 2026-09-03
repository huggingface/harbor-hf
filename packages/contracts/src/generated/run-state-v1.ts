/* Generated from JSON Schema. Do not edit. */

export interface RunStateV1 {
schema_version: "v1"
run_id: string
revision: number
updated_at: string
desired_state: ("run" | "paused" | "cancelled")
actor: string
parent_jobs: {
id: string
started_at: string
}[]
}
