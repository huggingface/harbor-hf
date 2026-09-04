/* Generated from JSON Schema. Do not edit. */

export type BenchmarkPresetSlug = string

export interface BenchmarkPresetV1 {
schema_version: "v1"
benchmark: BenchmarkPresetSlug
preset: BenchmarkPresetSlug
leaderboard_eligible: boolean
job: {
/**
 * @minItems 1
 */
datasets: [{
repo: string
path: string
/**
 * @minItems 1
 */
task_names?: [string, ...(string)[]]
/**
 * @minItems 1
 */
exclude_task_names?: [string, ...(string)[]]
n_tasks?: number
}, ...({
repo: string
path: string
/**
 * @minItems 1
 */
task_names?: [string, ...(string)[]]
/**
 * @minItems 1
 */
exclude_task_names?: [string, ...(string)[]]
n_tasks?: number
})[]]
n_attempts: number
n_concurrent_trials: number
environment: {
type: "hf-sandbox"
kwargs: {
flavor: ("cpu-basic" | "cpu-upgrade")
job_timeout: "30m"
}
}
timeout_multiplier?: number
agent_timeout_multiplier?: number
verifier_timeout_multiplier?: number
agent_setup_timeout_multiplier?: number
environment_build_timeout_multiplier?: number
retry?: {
max_retries?: number
include_exceptions?: string[]
exclude_exceptions?: string[]
wait_multiplier?: number
min_wait_sec?: number
max_wait_sec?: number
}
artifacts?: (string | {
source: string
destination: string
})[]
}
}
