/* Generated from JSON Schema. Do not edit. */

export type HarborHFControlRecordV1 = (ProfileObject | LegacyProfileObject | ProfilePromotion | OperatorAcl | RunRequest | RunLock | PreparedTrial | PreparedJob | ActionIntent | ActionDispatch | JobAdmissionGrant | JobCapacityRelease | ActionReceipt | ActionAdvanced | AttemptReceipt | TerminalSelection | TaskExhaustion | TaskCancellation | BudgetEvent | EndpointResource | PublicationReceipt | PublicationSupersession | MigrationRecord)
export type ProfileObject = (BenchmarkProfileObject | ModelProfileObject | HarnessProfileObject | DeploymentProfileObject | LaunchPolicyProfileObject | CapacityProfileObject)
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
contract_version: "v1"
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
active_hourly_cost_microusd?: number
timeout_seconds: number
trusted_worker: boolean
inference_token?: ("forbidden" | "required")
inference_upstream?: string
inference_api?: ("chat-completions" | "responses")
inference_max_requests?: number
inference_max_concurrency?: number
inference_timeout_seconds?: number
inference_max_output_tokens?: number
inference_provider?: string
input_price_microusd_per_million_tokens?: number
output_price_microusd_per_million_tokens?: number
cache_read_price_microusd_per_million_tokens?: number
cache_write_price_microusd_per_million_tokens?: number
harbor_version?: string
worker_revision?: string
context_window?: number
preparation?: ("forbidden" | "required")
/**
 * @minItems 1
 * @maxItems 128
 */
preparation_job_command?: [string, ...(string)[]]
preparation_timeout_seconds?: number
trial_job_template?: TrialJobTemplate
})
export type TrialJobTemplate = ({
[k: string]: unknown
} & {
/**
 * @minItems 1
 * @maxItems 32
 */
flavors: [TrialJobFlavor, ...(TrialJobFlavor)[]]
inference_token?: ("forbidden" | "required")
inference_upstream?: string
inference_api?: ("chat-completions" | "responses")
inference_max_requests?: number
inference_max_concurrency?: number
/**
 * Maximum provider request units reserved across active trial Jobs in one Run.
 */
inference_max_total_concurrency?: number
inference_timeout_seconds?: number
inference_max_output_tokens?: number
/**
 * @minItems 1
 * @maxItems 128
 */
root_bootstrap_command: [string, ...(string)[]]
default_cpus: number
default_memory_mb: number
default_storage_mb: number
default_gpus: number
max_timeout_seconds: number
lifetime_overhead_seconds: number
max_image_bytes: number
max_image_entries: number
max_jobs: number
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
export type CapacityProfileObject = (Base & {
schema_version: "v1"
kind: "profile.object"
record_id: Id
created_at: Timestamp
actor: Actor
profile_kind: "capacity"
name: Id
spec: CapacityProfileSpec
})
export type LegacyProfileObject = (LegacyModelProfileObject | LegacyHarnessProfileObject | LegacyDeploymentProfileObject)
export type LegacyModelProfileObject = (Base & {
schema_version: "v1"
kind: "profile.object"
record_id: Id
created_at: Timestamp
actor: Actor
profile_kind: "model"
name: Id
spec: LegacyModelProfileSpec
})
export type LegacyHarnessProfileObject = (Base & {
schema_version: "v1"
kind: "profile.object"
record_id: Id
created_at: Timestamp
actor: Actor
profile_kind: "harness"
name: Id
spec: LegacyHarnessProfileSpec
})
export type LegacyDeploymentProfileObject = (Base & {
schema_version: "v1"
kind: "profile.object"
record_id: Id
created_at: Timestamp
actor: Actor
profile_kind: "deployment"
name: Id
spec: LegacyDeploymentProfileSpec
})
export type ProfilePromotion = (Base & {
schema_version: "v1"
kind: "profile.promotion"
record_id: Id
created_at: Timestamp
actor: Actor
profile_kind: ("benchmark" | "model" | "harness" | "deployment" | "launch_policy" | "capacity")
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
export type RunRequest = (Base & {
schema_version: "v1"
kind: "run.request"
record_id: Id
created_at: Timestamp
actor: Actor
run_id: Id
idempotency_key_digest: Digest
/**
 * @minItems 4
 * @maxItems 5
 */
profiles: [ProfileRef, ProfileRef, ProfileRef, ProfileRef]|[ProfileRef, ProfileRef, ProfileRef, ProfileRef, ProfileRef]
ceiling_microusd: number
start_paused?: boolean
})
export type RunLock = (CurrentRunLock | LegacyRunLock)
export type CurrentRunLock = (Base & {
schema_version: "v1"
kind: "run.lock"
record_id: Id
created_at: Timestamp
actor: Actor
run_id: Id
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
execution: ResolvedExecutionContract
start_paused?: boolean
})
export type ResolvedProfile = (ResolvedBenchmarkProfile | ResolvedModelProfile | ResolvedHarnessProfile | ResolvedDeploymentProfile | ResolvedLaunchPolicyProfile)
export type LegacyRunLock = (Base & {
schema_version: "v1"
kind: "run.lock"
record_id: Id
created_at: Timestamp
actor: Actor
run_id: Id
/**
 * @minItems 4
 * @maxItems 5
 */
profiles: [LegacyResolvedProfile, LegacyResolvedProfile, LegacyResolvedProfile, LegacyResolvedProfile]|[LegacyResolvedProfile, LegacyResolvedProfile, LegacyResolvedProfile, LegacyResolvedProfile, LegacyResolvedProfile]
/**
 * @minItems 1
 * @maxItems 100000
 */
tasks: [TaskLock, ...(TaskLock)[]]
ceiling_microusd: number
source_revision: Digest
start_paused?: boolean
})
export type LegacyResolvedProfile = (ResolvedBenchmarkProfile | LegacyResolvedModelProfile | LegacyResolvedHarnessProfile | LegacyResolvedDeploymentProfile | ResolvedLaunchPolicyProfile)
export type PreparedTrial = (Base & {
schema_version: "v1"
kind: "prepared.trial"
record_id: Id
created_at: Timestamp
actor: Actor
run_id: Id
preparation_id: Id
run_lock_digest: Digest
task_id: Id
source_task_id: Id
trial_index: number
input_digest: Digest
trial_lock: {
[k: string]: unknown
}
trial_lock_digest: Digest
declared_image: string
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
run_id: Id
preparation_id: Id
run_lock_digest: Digest
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
run_id: Id
action_kind: ("run.admit" | "job.launch" | "job.observe" | "job.cancel" | "endpoint.resume" | "endpoint.pause" | "publication.publish" | "run.cancel" | "run.pause" | "run.resume" | "run.retry-infrastructure" | "publication.supersede")
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
run_id: Id
operation: "create"
adoption_not_before: Timestamp
})
export type JobAdmissionGrant = (Base & {
schema_version: "v1"
kind: "job.admission"
record_id: Id
created_at: Timestamp
actor: Actor
action_id: Id
run_id: Id
namespace: string
capacity_profile_id: Digest
hardware: string
reserved_provider_requests: number
tokens_remaining: number
refill_cursor_at: Timestamp
previous_grant_id: (Id | null)
})
export type JobCapacityRelease = (Base & {
schema_version: "v1"
kind: "job.capacity-release"
record_id: Id
created_at: Timestamp
actor: Actor
action_id: Id
run_id: Id
grant_id: Id
release_reason: ("launch_failed" | "launch_suppressed" | "job_terminal")
evidence_record_id: Id
})
export type ActionReceipt = (Base & {
schema_version: "v1"
kind: "action.receipt"
record_id: Id
created_at: Timestamp
actor: Actor
action_id: Id
run_id: Id
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
run_id: Id
})
export type AttemptReceipt = (Base & {
schema_version: "v1"
kind: "attempt.receipt"
record_id: Id
created_at: Timestamp
actor: Actor
run_id: Id
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
run_id: Id
task_id: Id
attempt_id: Id
outcome: ("complete" | "invalid" | "infrastructure" | "semantic" | "refusal" | "verifier" | "agent" | "benchmark_timeout" | "cancelled" | "policy")
reason: string
})
export type TaskExhaustion = (Base & {
schema_version: "v1"
kind: "task.exhaustion"
record_id: Id
created_at: Timestamp
actor: Actor
run_id: Id
task_id: Id
source_action_id: Id
last_attempt_id: (Id | null)
attempt_count: number
reason: string
})
export type TaskCancellation = (Base & {
schema_version: "v1"
kind: "task.cancellation"
record_id: Id
created_at: Timestamp
actor: Actor
run_id: Id
task_id: Id
source_action_id: Id
reason: string
})
export type BudgetEvent = (Base & {
schema_version: "v1"
kind: "budget.event"
record_id: Id
created_at: Timestamp
actor: Actor
run_id: Id
event_kind: ("ceiling" | "reserve" | "reconcile" | "release")
amount_microusd: number
})
export type EndpointResource = (Base & {
schema_version: "v1"
kind: "endpoint.resource"
record_id: Id
created_at: Timestamp
actor: Actor
run_id: Id
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
run_id: Id
publication_id: Id
/**
 * @maxItems 32
 */
object_digests: Digest[]
catalog_digest: (Digest | null)
error_code?: (string | null)
publication_state: ("published" | "failed")
})
export type PublicationSupersession = (Base & {
schema_version: "v1"
kind: "publication.supersession"
record_id: Id
created_at: Timestamp
actor: Actor
run_id: Id
publication_id: Id
superseded_run_id: Id
superseded_publication_id: Id
reason: string
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
launch_policy_constraints_required?: boolean
}
export interface ModelProfileSpec {
contract_version: "v1"
model_id: string
revision: string
harbor_model_name: string
compatibility: ModelCompatibility
/**
 * @maxItems 32
 */
aliases?: Id[]
}
export interface ModelCompatibility {
reasoning: boolean
/**
 * @maxItems 2
 */
inference_apis?: []|[("chat-completions" | "responses")]|[("chat-completions" | "responses"), ("chat-completions" | "responses")]
reasoning_format?: "deepseek"
}
export interface HarnessProfileSpec {
contract_version: "v1"
agent: Id
revision: string
/**
 * @maxItems 64
 */
required_evidence: Id[]
reasoning_effort?: ("off" | "minimal" | "low" | "medium" | "high" | "xhigh")
capabilities: HarnessCapabilities
/**
 * @maxItems 32
 */
aliases?: Id[]
harbor_agent?: HarborAgentTemplate
}
export interface HarnessCapabilities {
/**
 * @maxItems 2
 */
inference_apis: []|[("chat-completions" | "responses")]|[("chat-completions" | "responses"), ("chat-completions" | "responses")]
requires_reasoning?: boolean
/**
 * @maxItems 8
 */
reasoning_formats?: []|["deepseek"]|["deepseek", "deepseek"]|["deepseek", "deepseek", "deepseek"]|["deepseek", "deepseek", "deepseek", "deepseek"]|["deepseek", "deepseek", "deepseek", "deepseek", "deepseek"]|["deepseek", "deepseek", "deepseek", "deepseek", "deepseek", "deepseek"]|["deepseek", "deepseek", "deepseek", "deepseek", "deepseek", "deepseek", "deepseek"]|["deepseek", "deepseek", "deepseek", "deepseek", "deepseek", "deepseek", "deepseek", "deepseek"]
provider_runtime?: boolean
model_registry?: "pi"
litellm_model_registry?: boolean
litellm_model_info?: boolean
reasoning_format_runtime?: "dsh"
provider_max_attempts?: number
}
export interface HarborAgentTemplate {
import_path: string
kwargs: {
model_name?: never
models_json?: never
model_runtime?: never
provider_runtime?: never
thinking_format?: never
inference_model?: never
context_window?: never
input_price_microusd_per_million_tokens?: never
output_price_microusd_per_million_tokens?: never
[k: string]: unknown
}
override_setup_timeout_sec?: number
}
export interface TrialJobFlavor {
hardware: string
cpus: number
memory_mb: number
storage_mb: number
gpus: number
active_hourly_cost_microusd: number
}
export interface ImportedDeploymentProfileSpec {
contract_version: "v1"
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
source_run_ids: [string, ...(string)[]]
/**
 * @minItems 1
 * @maxItems 256
 */
source_revisions: [string, ...(string)[]]
}
export interface LaunchPolicySpec {
max_infrastructure_attempts: number
reservation_microusd: number
max_run_ceiling_microusd?: number
success_without_worker_receipt: boolean
publication_role: ("final" | "component" | "diagnostic")
preparation_reservation_microusd?: number
max_preparation_attempts?: number
/**
 * @maxItems 64
 */
required_positive_metrics?: string[]
profile_constraints?: ProfileConstraints
}
export interface ProfileConstraints {
/**
 * @minItems 1
 * @maxItems 256
 */
benchmarks: [Id, ...(Id)[]]
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
deployments: [Id, ...(Id)[]]
}
export interface CapacityProfileSpec {
namespace: string
/**
 * @maxItems 32
 */
hardware_limits: {
hardware: string
max_active_jobs: number
}[]
start_burst: number
start_refill_tokens: number
start_refill_period_seconds: number
max_active_jobs: number
}
export interface LegacyModelProfileSpec {
contract_version?: never
model_id: unknown
revision: unknown
[k: string]: unknown
}
export interface LegacyHarnessProfileSpec {
contract_version?: never
agent: unknown
revision: unknown
required_evidence: unknown
[k: string]: unknown
}
export interface LegacyDeploymentProfileSpec {
contract_version?: never
route: unknown
models: unknown
harnesses: unknown
[k: string]: unknown
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
export interface ResolvedExecutionContract {
contract_version: "v1"
source_profiles: ExecutionSourceProfiles
model: ModelProfileSpec
harness: HarnessProfileSpec
deployment: HFJobDeploymentProfileSpec
harbor_agent?: HarborAgentConfig
inference?: ResolvedInferenceContract
}
export interface ExecutionSourceProfiles {
model: ExecutionSourceProfile
harness: ExecutionSourceProfile
deployment: ExecutionSourceProfile
}
export interface ExecutionSourceProfile {
name: Id
profile_id: Digest
}
export interface HarborAgentConfig {
import_path: string
model_name: string
kwargs?: {
[k: string]: unknown
}
override_setup_timeout_sec?: number
}
export interface ResolvedInferenceContract {
harbor_provider: "openai"
provider: Id
upstream: string
agent_model: string
bridge_model: string
api: ("chat-completions" | "responses")
max_requests: number
max_concurrency: number
max_total_concurrency?: number
timeout_seconds: number
max_output_tokens: number
context_window: number
input_price_microusd_per_million_tokens: number
output_price_microusd_per_million_tokens: number
cache_read_price_microusd_per_million_tokens: number
cache_write_price_microusd_per_million_tokens: number
}
export interface LegacyResolvedModelProfile {
kind: "model"
profile_id: Digest
name: Id
spec: LegacyModelProfileSpec
}
export interface LegacyResolvedHarnessProfile {
kind: "harness"
profile_id: Digest
name: Id
spec: LegacyHarnessProfileSpec
}
export interface LegacyResolvedDeploymentProfile {
kind: "deployment"
profile_id: Digest
name: Id
spec: LegacyDeploymentProfileSpec
}
export interface PreparedTrialRef {
task_id: Id
record_id: Id
record_digest: Digest
}
export interface ActionPayload {
idempotency_key_digest?: Digest
idempotency_payload_digest?: Digest
/**
 * @maxItems 100000
 */
task_ids?: Id[]
/**
 * @minItems 1
 * @maxItems 100000
 */
selected_task_ids?: [Id, ...(Id)[]]
task_id?: (Id | null)
/**
 * @minItems 1
 * @maxItems 100000
 */
prior_attempt_ids?: [Id, ...(Id)[]]
reason?: (string | null)
job_image?: string
task_image?: string
/**
 * @minItems 1
 * @maxItems 128
 */
job_command?: [string, ...(string)[]]
hardware?: string
timeout_seconds?: number
max_image_bytes?: number
max_image_entries?: number
success_without_worker_receipt?: boolean
max_infrastructure_attempts?: number
reservation_microusd?: number
active_hourly_cost_microusd?: number
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
run_lock_digest?: Digest
worker_role?: ("preparation" | "execution")
prepared_job_digest?: Digest
preparation_attempt?: number
worker_revision?: string
task_limit?: number
publication_id?: Id
/**
 * @maxItems 64
 */
required_positive_metrics?: string[]
max_jobs?: number
inference_upstream?: string
inference_model?: string
inference_api?: ("chat-completions" | "responses")
/**
 * Maximum provider request units reserved across active trial Jobs in one Run.
 */
inference_max_total_concurrency?: number
}
