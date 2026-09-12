/* Generated from JSON Schema. Do not edit. */

export interface RunStateV1 {
schema_version: "v1"
run_id: string
revision: number
updated_at: string
desired_state: ("run" | "paused" | "cancelled")
actor: string
/**
 * Owned parent error IDs explicitly acknowledged by operator resume; not Job status or retry state.
 */
acknowledged_parent_failures?: string[]
parent_jobs: {
id: string
started_at: string
}[]
}
