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
/**
 * Maximum reported trial-attempt cost for the complete campaign. Enforcement occurs after each terminal trial attempt and can overshoot through concurrent work.
 */
cost_ceiling_usd?: number
/**
 * Legacy per-trial ceiling retained only so immutable existing runs remain readable.
 */
cost_ceiling_usd_per_trial?: number
}
/**
 * Immutable Workbench display provenance. Recipe revision is submission.harness.version; execution remains in harbor_job_config.
 */
workbench_recipe?: {
name: string
}
pricing?: LaunchPricingV1
harbor_job_config: {
[k: string]: unknown
}
operator_selection?: {
original_run_id: string
/**
 * @minItems 1
 */
trial_ids: [string, ...(string)[]]
/**
 * Native source evidence fingerprint (sha256-prefixed), not the public budget-bound review hash.
 */
source_fingerprint: string
}
})
export type RunRecordSlug = string

export interface LaunchPricingV1 {
currency: "USD"
input_usd_per_million: number
output_usd_per_million: number
cached_usd_per_million: number
}
