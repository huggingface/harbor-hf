/* Generated from JSON Schema. Do not edit. */

export type HarborHFControlRecordV1 = (ProfileObject | ProfilePromotion | OperatorAcl | CampaignRequest | CampaignLock | PreparedTrial | PreparedJob | ActionIntent | ActionDispatch | ActionReceipt | ActionAdvanced | AttemptReceipt | TerminalSelection | BudgetEvent | EndpointResource | PublicationReceipt | MigrationRecord)
export type ProfileObject = (BenchmarkProfileObject | ModelProfileObject | HarnessProfileObject | DeploymentProfileObject | LaunchPolicyProfileObject)
export type BenchmarkProfileObject = (Base & {
schema_version: "v1"
kind: "profile.object"
record_id: Id
created_at: Timestamp
actor: Actor
profile_kind: "benchmark"
name: Id
spec: BenchmarkProfileSpec
})
export type Id = string
export type Timestamp = string
export type Digest = string
export type ModelProfileObject = (Base & {
schema_version: "v1"
kind: "profile.object"
record_id: Id
created_at: Timestamp
actor: Actor
profile_kind: "model"
name: Id
spec: ModelProfileSpec
})
export type HarnessProfileObject = (Base & {
schema_version: "v1"
kind: "profile.object"
record_id: Id
created_at: Timestamp
actor: Actor
profile_kind: "harness"
name: Id
spec: HarnessProfileSpec
})
export type DeploymentProfileObject = (Base & {
schema_version: "v1"
kind: "profile.object"
record_id: Id
created_at: Timestamp
actor: Actor
profile_kind: "deployment"
name: Id
spec: DeploymentProfileSpec
})
export type DeploymentProfileSpec = (HFJobDeploymentProfileSpec | ImportedDeploymentProfileSpec)
export type HFJobDeploymentProfileSpec = ({
[k: string]: unknown
} & {
route: "hf_job"
/**
 * @minItems 1
 * @maxItems 256
 */
models: [Id, ...(Id)[]]
/**
 * @minItems 1
 * @maxItems 256
 */
harnesses: [Id, ...(Id)[]]
job_image: string
/**
 * @minItems 1
 * @maxItems 128
 */
job_command: [string, ...(string)[]]
hardware: string
timeout_seconds: number
trusted_worker: boolean
inference_token?: ("forbidden" | "required")
inference_max_requests?: number
inference_max_concurrency?: number
inference_timeout_seconds?: number
inference_max_output_tokens?: number
sandbox?: SandboxPolicy
inference_provider?: string
input_price_microusd_per_million_tokens?: number
output_price_microusd_per_million_tokens?: number
harbor_version?: string
worker_revision?: string
worker_concurrency?: number
worker_max_tasks_per_job?: number
context_window?: number
preparation?: ("forbidden" | "required")
/**
 * @minItems 1
 * @maxItems 128
 */
preparation_job_command?: [string, ...(string)[]]
preparation_timeout_seconds?: number
sandbox_template?: SandboxTemplate
})
export type SandboxPolicy = ({
[k: string]: unknown
} & {
image: string
hardware: string
timeout_seconds: number
idle_timeout_seconds: number
inference_token?: ("forbidden" | "required")
inference_upstream?: string
inference_model?: string
inference_api?: ("chat-completions" | "responses")
inference_max_requests?: number
inference_max_concurrency?: number
inference_timeout_seconds?: number
inference_max_output_tokens?: number
/**
 * @minItems 1
 * @maxItems 128
 */
root_bootstrap_command?: [string, ...(string)[]]
reservation_microusd: number
active_hourly_cost_microusd: number
max_sandboxes: number
max_commands: number
max_command_seconds: number
max_transfer_bytes: number
/**
 * @minItems 1
 * @maxItems 32
 */
allowed_roots: [string, ...(string)[]]
})
export type SandboxTemplate = ({
[k: string]: unknown
} & {
/**
 * @minItems 1
 * @maxItems 32
 */
flavors: [SandboxFlavor, ...(SandboxFlavor)[]]
max_sandboxes: number
max_commands: number
max_command_seconds: number
max_transfer_bytes: number
/**
 * @minItems 1
 * @maxItems 32
 */
allowed_roots: [string, ...(string)[]]
inference_token?: ("forbidden" | "required")
inference_upstream?: string
inference_model?: string
inference_api?: ("chat-completions" | "responses")
inference_max_requests?: number
inference_max_concurrency?: number
inference_timeout_seconds?: number
inference_max_output_tokens?: number
/**
 * @minItems 1
 * @maxItems 128
 */
root_bootstrap_command?: [string, ...(string)[]]
default_cpus: number
default_memory_mb: number
default_storage_mb: number
default_gpus: number
max_timeout_seconds: number
lifetime_overhead_seconds: number
idle_timeout_overhead_seconds: number
})
export type LaunchPolicyProfileObject = (Base & {
schema_version: "v1"
kind: "profile.object"
record_id: Id
created_at: Timestamp
actor: Actor
profile_kind: "launch_policy"
name: Id
spec: LaunchPolicySpec
})
export type ProfilePromotion = (Base & {
schema_version: "v1"
kind: "profile.promotion"
record_id: Id
created_at: Timestamp
actor: Actor
profile_kind: ("benchmark" | "model" | "harness" | "deployment" | "launch_policy")
alias: Id
profile_id: Digest
reason: string
/**
 * @maxItems 64
 */
evidence: Digest[]
promotion_state: ("candidate" | "recommended" | "approved")
})
export type OperatorAcl = (Base & {
schema_version: "v1"
kind: "operator.acl"
record_id: Id
created_at: Timestamp
actor: Actor
/**
 * @maxItems 64
 */
operators: string[]
/**
 * @maxItems 512
 */
readers: string[]
})
export type CampaignRequest = (Base & {
schema_version: "v1"
kind: "campaign.request"
record_id: Id
created_at: Timestamp
actor: Actor
campaign_id: Id
idempotency_key_digest: Digest
/**
 * @minItems 4
 * @maxItems 5
 */
profiles: [ProfileRef, ProfileRef, ProfileRef, ProfileRef]|[ProfileRef, ProfileRef, ProfileRef, ProfileRef, ProfileRef]
ceiling_microusd: number
})
export type CampaignLock = (Base & {
schema_version: "v1"
kind: "campaign.lock"
record_id: Id
created_at: Timestamp
actor: Actor
campaign_id: Id
/**
 * @minItems 4
 * @maxItems 5
 */
profiles: [ResolvedProfile, ResolvedProfile, ResolvedProfile, ResolvedProfile]|[ResolvedProfile, ResolvedProfile, ResolvedProfile, ResolvedProfile, ResolvedProfile]
/**
 * @minItems 1
 * @maxItems 100000
 */
tasks: [TaskLock, ...(TaskLock)[]]
ceiling_microusd: number
source_revision: Digest
})
export type ResolvedProfile = (ResolvedBenchmarkProfile | ResolvedModelProfile | ResolvedHarnessProfile | ResolvedDeploymentProfile | ResolvedLaunchPolicyProfile)
export type PreparedTrial = (Base & {
schema_version: "v1"
kind: "prepared.trial"
record_id: Id
created_at: Timestamp
actor: Actor
campaign_id: Id
preparation_id: Id
campaign_lock_digest: Digest
task_id: Id
source_task_id: Id
trial_index: number
input_digest: Digest
trial_lock: {
[k: string]: unknown
}
trial_lock_digest: Digest
image: string
cpus: number
memory_mb: number
storage_mb: number
gpus: number
agent_timeout_seconds: number
verifier_timeout_seconds: number
environment_build_timeout_seconds: number
agent_setup_timeout_seconds: number
})
export type PreparedJob = (Base & {
schema_version: "v1"
kind: "prepared.job"
record_id: Id
created_at: Timestamp
actor: Actor
campaign_id: Id
preparation_id: Id
campaign_lock_digest: Digest
harbor_version: string
job_config: {
[k: string]: unknown
}
job_lock_header: {
[k: string]: unknown
}
/**
 * @minItems 1
 * @maxItems 100000
 */
trials: [PreparedTrialRef, ...(PreparedTrialRef)[]]
harbor_lock_digest: Digest
})
export type ActionIntent = (Base & {
schema_version: "v1"
kind: "action.intent"
record_id: Id
created_at: Timestamp
actor: Actor
action_id: Id
campaign_id: Id
action_kind: ("campaign.admit" | "job.launch" | "job.observe" | "job.cancel" | "endpoint.resume" | "endpoint.pause" | "sandbox.create" | "sandbox.observe" | "sandbox.exec" | "sandbox.write" | "sandbox.read" | "sandbox.close" | "publication.publish" | "campaign.cancel")
generation: number
target: string
payload: ActionPayload
})
export type ActionDispatch = (Base & {
schema_version: "v1"
kind: "action.dispatch"
record_id: Id
created_at: Timestamp
actor: Actor
action_id: Id
campaign_id: Id
operation: ("create" | "observe" | "execute" | "write" | "read" | "close")
adoption_not_before: Timestamp
})
export type ActionReceipt = (Base & {
schema_version: "v1"
kind: "action.receipt"
record_id: Id
created_at: Timestamp
actor: Actor
action_id: Id
campaign_id: Id
outcome: ("adopted" | "created" | "completed" | "failed")
observed_state: string
error_code?: (string | null)
resource_id?: (string | null)
ready_replicas?: (number | null)
active_hourly_cost_microusd?: (number | null)
cost_microusd?: (number | null)
})
export type ActionAdvanced = (Base & {
schema_version: "v1"
kind: "action.advanced"
record_id: Id
created_at: Timestamp
actor: Actor
action_id: Id
campaign_id: Id
})
export type AttemptReceipt = (Base & {
schema_version: "v1"
kind: "attempt.receipt"
record_id: Id
created_at: Timestamp
actor: Actor
campaign_id: Id
task_id: Id
attempt_id: Id
outcome: ("complete" | "invalid" | "infrastructure" | "semantic" | "refusal" | "verifier" | "agent" | "benchmark_timeout" | "cancelled" | "policy")
evidence_digest: Digest
evidence_path: string
cost_microusd: number
replacement_eligible: boolean
metrics: {
[k: string]: number
}
action_id: Id
})
export type TerminalSelection = (Base & {
schema_version: "v1"
kind: "terminal.selection"
record_id: Id
created_at: Timestamp
actor: Actor
campaign_id: Id
task_id: Id
attempt_id: Id
outcome: ("complete" | "invalid" | "infrastructure" | "semantic" | "refusal" | "verifier" | "agent" | "benchmark_timeout" | "cancelled" | "policy")
reason: string
})
export type BudgetEvent = (Base & {
schema_version: "v1"
kind: "budget.event"
record_id: Id
created_at: Timestamp
actor: Actor
campaign_id: Id
event_kind: ("ceiling" | "reserve" | "reconcile" | "release")
amount_microusd: number
})
export type EndpointResource = (Base & {
schema_version: "v1"
kind: "endpoint.resource"
record_id: Id
created_at: Timestamp
actor: Actor
campaign_id: Id
action_id: Id
endpoint_id: string
desired_state: ("running" | "paused" | "deleted")
observed_state: string
ready_replicas: number
cleanup_verified: boolean
active_hourly_cost_microusd: number
})
export type PublicationReceipt = (Base & {
schema_version: "v1"
kind: "publication.receipt"
record_id: Id
created_at: Timestamp
actor: Actor
campaign_id: Id
publication_id: Id
/**
 * @maxItems 32
 */
object_digests: Digest[]
catalog_digest: (Digest | null)
error_code?: (string | null)
publication_state: ("published" | "failed")
})
export type MigrationRecord = (Base & {
schema_version: "v1"
kind: "migration.record"
record_id: Id
created_at: Timestamp
actor: Actor
new_writes_enabled: boolean
source_revisions: {
[k: string]: string
}
import_digest: Digest
source_writes_disabled: boolean
})

export interface Base {
schema_version: "v1"
kind: string
record_id: Id
created_at: Timestamp
actor: Actor
[k: string]: unknown
}
export interface Actor {
subject: string
role: ("operator" | "reader" | "service" | "migration")
}
export interface BenchmarkProfileSpec {
benchmark: Id
revision: string
/**
 * @minItems 1
 * @maxItems 100000
 */
task_ids: [Id, ...(Id)[]]
/**
 * @minItems 1
 * @maxItems 100000
 */
task_digests: [Digest, ...(Digest)[]]
/**
 * @minItems 1
 * @maxItems 100000
 */
source_task_ids?: [Id, ...(Id)[]]
/**
 * @minItems 1
 * @maxItems 100000
 */
trial_indices?: [number, ...(number)[]]
harbor_job?: {
[k: string]: unknown
}
}
export interface ModelProfileSpec {
model_id: string
revision: string
harbor_model_name?: string
}
export interface HarnessProfileSpec {
agent: Id
revision: string
/**
 * @maxItems 64
 */
required_evidence: Id[]
reasoning_effort?: ("off" | "minimal" | "low" | "medium" | "high" | "xhigh")
harbor_agent?: {
[k: string]: unknown
}
}
export interface SandboxFlavor {
hardware: string
cpus: number
memory_mb: number
storage_mb: number
gpus: number
active_hourly_cost_microusd: number
}
export interface ImportedDeploymentProfileSpec {
route: "imported"
/**
 * @minItems 1
 * @maxItems 256
 */
models: [Id, ...(Id)[]]
/**
 * @minItems 1
 * @maxItems 256
 */
harnesses: [Id, ...(Id)[]]
/**
 * @minItems 1
 * @maxItems 256
 */
source_campaign_ids: [string, ...(string)[]]
/**
 * @minItems 1
 * @maxItems 256
 */
source_revisions: [string, ...(string)[]]
}
export interface LaunchPolicySpec {
max_infrastructure_attempts: number
reservation_microusd: number
success_without_worker_receipt: boolean
publication_role: ("final" | "component" | "diagnostic")
preparation_reservation_microusd?: number
max_preparation_attempts?: number
}
export interface ProfileRef {
kind: ("benchmark" | "model" | "harness" | "deployment" | "launch_policy")
alias: Id
}
export interface ResolvedBenchmarkProfile {
kind: "benchmark"
profile_id: Digest
name: Id
spec: BenchmarkProfileSpec
}
export interface ResolvedModelProfile {
kind: "model"
profile_id: Digest
name: Id
spec: ModelProfileSpec
}
export interface ResolvedHarnessProfile {
kind: "harness"
profile_id: Digest
name: Id
spec: HarnessProfileSpec
}
export interface ResolvedDeploymentProfile {
kind: "deployment"
profile_id: Digest
name: Id
spec: DeploymentProfileSpec
}
export interface ResolvedLaunchPolicyProfile {
kind: "launch_policy"
profile_id: Digest
name: Id
spec: LaunchPolicySpec
}
export interface TaskLock {
task_id: Id
input_digest: Digest
source_task_id?: Id
trial_index?: number
}
export interface PreparedTrialRef {
task_id: Id
record_id: Id
record_digest: Digest
}
export interface ActionPayload {
/**
 * @maxItems 100000
 */
task_ids?: Id[]
task_id?: (Id | null)
reason?: (string | null)
job_image?: string
/**
 * @minItems 1
 * @maxItems 128
 */
job_command?: [string, ...(string)[]]
hardware?: string
timeout_seconds?: number
success_without_worker_receipt?: boolean
max_infrastructure_attempts?: number
reservation_microusd?: number
trusted_worker?: boolean
inference_token?: ("forbidden" | "required")
inference_max_requests?: number
inference_max_concurrency?: number
inference_timeout_seconds?: number
inference_max_output_tokens?: number
resource_id?: string
launch_action_id?: Id
not_before?: Timestamp
worker_receipt_deadline?: Timestamp
prior_attempt_id?: Id
endpoint_id?: string
watchdog_verified?: boolean
sandbox?: SandboxPolicy
campaign_lock_digest?: Digest
sandbox_create_action_id?: Id
/**
 * @minItems 1
 * @maxItems 128
 */
command?: [string, ...(string)[]]
cwd?: string
path?: string
content_digest?: Digest
content_size?: number
mode?: string
worker_role?: ("preparation" | "execution")
prepared_job_digest?: Digest
sandbox_authorized?: boolean
sandbox_timeout_seconds?: number
preparation_attempt?: number
worker_revision?: string
}
