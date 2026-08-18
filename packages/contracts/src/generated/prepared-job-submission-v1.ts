/* Generated from JSON Schema. Do not edit. */

export type PreparedJobSubmissionV1 = ({
phase: "trial"
task_id: string
source_task_id: string
trial_index: number
input_digest: string
trial_lock: {
[k: string]: unknown
}
image: string
cpus: number
memory_mb: number
storage_mb: number
gpus: number
agent_timeout_seconds: number
verifier_timeout_seconds: number
environment_build_timeout_seconds: number
agent_setup_timeout_seconds: number
} | {
phase: "finalize"
harbor_version: string
job_config: {
[k: string]: unknown
}
job_lock_header: {
[k: string]: unknown
}
})
