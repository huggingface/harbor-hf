/* Generated from JSON Schema. Do not edit. */

export type HarborHFControlRecordV1 = (ProfileObject | ProfilePromotion | OperatorAcl | CampaignRequest | CampaignLock | ActionIntent | ActionReceipt | ActionAdvanced | AttemptReceipt | TerminalSelection | BudgetEvent | EndpointResource | PublicationReceipt | MigrationRecord)
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
export type ActionIntent = (Base & {
schema_version: "v1"
kind: "action.intent"
record_id: Id
created_at: Timestamp
actor: Actor
action_id: Id
campaign_id: Id
action_kind: ("campaign.admit" | "job.launch" | "job.observe" | "endpoint.resume" | "endpoint.pause" | "publication.publish" | "campaign.cancel")
generation: number
target: string
payload: ActionPayload
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
[k: string]: any
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
}
export interface ModelProfileSpec {
model_id: string
revision: string
}
export interface HarnessProfileSpec {
agent: Id
revision: string
/**
 * @maxItems 64
 */
required_evidence: Id[]
}
export interface HFJobDeploymentProfileSpec {
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
requires_hf_token?: boolean
trusted_worker?: boolean
mount_bucket?: boolean
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
requires_hf_token?: boolean
trusted_worker?: boolean
mount_bucket?: boolean
resource_id?: string
launch_action_id?: Id
not_before?: Timestamp
prior_attempt_id?: Id
endpoint_id?: string
watchdog_verified?: boolean
}
