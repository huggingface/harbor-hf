/* Generated from JSON Schema. Do not edit. */

export type RunRecordSlug = string

export interface RunRecordV1 {
schema_version: "v1"
run_id: string
created_at: string
submitted_by: string
role: ("final" | "diagnostic")
harbor_revision: string
submission: {
benchmark: {
name: RunRecordSlug
preset: RunRecordSlug
}
model: {
id: string
provider: RunRecordSlug
reasoning_effort: string
}
harness: {
agent: RunRecordSlug
version: string
}
cost_ceiling_usd_per_trial: number
}
harbor_job_config: {
[k: string]: unknown
}
}
