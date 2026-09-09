/* Generated from JSON Schema. Do not edit. */

export type RunRecordV1 = ({
[k: string]: unknown
} & {
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
model?: {
id: string
provider: RunRecordSlug
reasoning_effort: string
}
harness?: {
agent: RunRecordSlug
version: string
}
cost_ceiling_usd_per_trial: number
}
/**
 * Immutable Workbench display provenance. Recipe revision is submission.harness.version; execution remains in harbor_job_config.
 */
workbench_recipe?: {
name: string
}
harbor_job_config: {
[k: string]: unknown
}
})
export type RunRecordSlug = string
