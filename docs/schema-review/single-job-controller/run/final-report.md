# Schemator Data Model Review

Source: `/home/user/repos/harbor-hf/schemas/campaign-plan-v1alpha1.schema.json`

## Summary

- Stable: no
- Iterations: 4
- Initial fields: 51
- Final fields: 28
- Applied changes: 26
- Skipped proposals: 0
- Manual structural proposals: 4
- Consistency warnings: 0

## Applied Changes

| Iteration | Model | Field | Decision | Final path |
| ---: | --- | --- | --- | --- |
| 1 | `CampaignPlan` | `component_kind` | remove | `component_kind` |
| 1 | `CampaignPlan` | `evaluation_id` | defer | `evaluation_id` |
| 1 | `CampaignPlan` | `experiment` | remove | `experiment` |
| 1 | `CampaignPlan` | `initial_waves[].deployment_digest` | derive | `initial_waves[].deployment_digest` |
| 1 | `CampaignPlan` | `initial_waves[].effective_concurrency` | derive | `initial_waves[].effective_concurrency` |
| 1 | `CampaignPlan` | `initial_waves[].trial_count` | derive | `initial_waves[].trial_count` |
| 1 | `CampaignPlan` | `initial_waves[].wave_index` | derive | `initial_waves[].wave_index` |
| 1 | `CampaignPlan` | `max_shards_per_wave` | remove | `max_shards_per_wave` |
| 1 | `CampaignPlan` | `publication_role` | remove | `publication_role` |
| 1 | `CampaignPlan` | `run_count` | derive | `run_count` |
| 1 | `CampaignPlan` | `runs[].shards[].trials[].logical_attempt` | remove | `runs[].shards[].trials[].logical_attempt` |
| 1 | `CampaignPlan` | `runs[].spend_cap_microusd` | remove | `runs[].spend_cap_microusd` |
| 1 | `CampaignPlan` | `shard_count` | derive | `shard_count` |
| 1 | `CampaignPlan` | `trial_count` | derive | `trial_count` |
| 1 | `CampaignPlan` | `controller_policy.max_attempts` | rename | `controller_policy.max_controller_attempts` |
| 1 | `CampaignPlan` | `runs[].cell_digest` | rename | `runs[].run_digest` |
| 2 | `CampaignPlan` | `controller_policy.planning_trial_seconds` | remove | `controller_policy.planning_trial_seconds` |
| 2 | `CampaignPlan` | `initial_waves[].planned_duration_seconds` | derive | `initial_waves[].planned_duration_seconds` |
| 2 | `CampaignPlan` | `plan_digest` | derive | `plan_digest` |
| 2 | `CampaignPlan` | `planned_campaign_duration_seconds` | derive | `planned_campaign_duration_seconds` |
| 3 | `CampaignPlan` | `runs[].provider` | derive | `runs[].provider` |
| 3 | `CampaignPlan` | `runs[].run_digest` | derive | `runs[].run_digest` |
| 3 | `CampaignPlan` | `schema_version` | remove | `schema_version` |
| 3 | `CampaignPlan` | `runs[].deployment` | rename | `runs[].deployment_path` |
| 4 | `CampaignPlan` | `runs[].estimated_wave_cost_microusd` | remove | `runs[].estimated_wave_cost_microusd` |
| 4 | `CampaignPlan` | `runs[].shards[].shard_digest` | derive | `runs[].shards[].shard_digest` |

## Manual Structural Proposals

| Iteration | Model | Field | Decision | Proposed final path | Rationale |
| ---: | --- | --- | --- | --- | --- |
| 1 | `CampaignPlan` | `runs[].estimated_wave_cost_microusd` | move | `runs[].estimated_wave_cost_microusd` | A run can span multiple waves, so a run-level wave cost is ambiguous. Attach the non-negative integer estimate to each concrete initial wave, whose shard set, duration, and concurrency define what is being estimated. |
| 2 | `CampaignPlan` | `recovery_policy.max_active_waves` | move | `controller_policy.max_active_waves` | This is a controller scheduling limit that applies to both initial execution and recovery; it is not itself a recovery rule. |
| 3 | `CampaignPlan` | `recovery_policy.max_active_waves` | move | `recovery_policy.max_active_waves` | This is a controller-wide concurrency bound, not recovery behavior. It governs normal scheduling as well as retries, so controller_policy is its durable owner. |
| 3 | `CampaignPlan` | `recovery_policy.spend_cap_microusd` | move | `recovery_policy.spend_cap_microusd` | A campaign-wide spend cap is a durable safety bound for all physical executions, not a recovery-specific retry setting. Keeping it at the plan root makes its scope explicit while retaining the established monetary name and integer micro-USD representation. |

## Skipped Proposals

_None._

## Consistency Warnings

_None._

# Schemator Graph Diff

- Initial models: 1
- Final models: 1
- Initial fields: 51
- Final fields: 28
- Removed or renamed from initial graph: 25
- Added or renamed into final graph: 2
- Changed in place: 0

## Removed Or Renamed From Initial Graph

| Model | Field | Type |
| --- | --- | --- |
| `CampaignPlan` | `component_kind` | `unknown` |
| `CampaignPlan` | `controller_policy.max_attempts` | `integer` |
| `CampaignPlan` | `controller_policy.planning_trial_seconds` | `integer` |
| `CampaignPlan` | `evaluation_id` | `string` |
| `CampaignPlan` | `experiment` | `string` |
| `CampaignPlan` | `initial_waves[].deployment_digest` | `string` |
| `CampaignPlan` | `initial_waves[].effective_concurrency` | `integer` |
| `CampaignPlan` | `initial_waves[].planned_duration_seconds` | `integer` |
| `CampaignPlan` | `initial_waves[].trial_count` | `integer` |
| `CampaignPlan` | `initial_waves[].wave_index` | `integer` |
| `CampaignPlan` | `max_shards_per_wave` | `integer` |
| `CampaignPlan` | `plan_digest` | `string` |
| `CampaignPlan` | `planned_campaign_duration_seconds` | `unknown` |
| `CampaignPlan` | `publication_role` | `string` |
| `CampaignPlan` | `run_count` | `integer` |
| `CampaignPlan` | `runs[].cell_digest` | `string` |
| `CampaignPlan` | `runs[].deployment` | `string` |
| `CampaignPlan` | `runs[].estimated_wave_cost_microusd` | `unknown` |
| `CampaignPlan` | `runs[].provider` | `unknown` |
| `CampaignPlan` | `runs[].shards[].shard_digest` | `string` |
| `CampaignPlan` | `runs[].shards[].trials[].logical_attempt` | `integer` |
| `CampaignPlan` | `runs[].spend_cap_microusd` | `unknown` |
| `CampaignPlan` | `schema_version` | `string` |
| `CampaignPlan` | `shard_count` | `integer` |
| `CampaignPlan` | `trial_count` | `integer` |

## Added Or Renamed Into Final Graph

| Model | Field | Type |
| --- | --- | --- |
| `CampaignPlan` | `controller_policy.max_controller_attempts` | `integer` |
| `CampaignPlan` | `runs[].deployment_path` | `string` |

## Changed In Place

_None._

## Final Simplified Graph

### CampaignPlan

| Field | Type | Required | Object-like |
| --- | --- | --- | --- |
| `controller_policy` | `unknown` | no | yes |
| `controller_policy.controller_reserve_seconds` | `integer` | no | no |
| `controller_policy.headroom_factor` | `unknown` | no | no |
| `controller_policy.heartbeat_seconds` | `integer` | no | no |
| `controller_policy.max_controller_attempts` | `integer` | no | no |
| `controller_policy.stale_after_seconds` | `integer` | no | no |
| `controller_policy.wave_reserve_seconds` | `integer` | no | no |
| `initial_waves` | `array` | no | yes |
| `initial_waves[].shard_digests` | `array` | no | no |
| `manifest_digest` | `string` | yes | no |
| `recovery_policy` | `#/$defs/CampaignRecoveryPolicy` | yes | yes |
| `recovery_policy.cancellation_grace_seconds` | `integer` | no | no |
| `recovery_policy.max_active_waves` | `integer` | no | no |
| `recovery_policy.max_physical_executions_per_trial` | `integer` | no | no |
| `recovery_policy.retry_base_seconds` | `integer` | no | no |
| `recovery_policy.retry_max_seconds` | `integer` | no | no |
| `recovery_policy.spend_cap_microusd` | `unknown` | no | no |
| `runs` | `array` | yes | yes |
| `runs[].agent` | `string` | yes | no |
| `runs[].deployment_path` | `string` | yes | no |
| `runs[].deployment_digest` | `string` | yes | no |
| `runs[].max_concurrent_requests` | `unknown` | no | no |
| `runs[].model` | `string` | yes | no |
| `runs[].shards` | `array` | yes | yes |
| `runs[].shards[].trials` | `array` | yes | yes |
| `runs[].shards[].trials[].task_digest` | `string` | yes | no |
| `runs[].shards[].trials[].task_name` | `string` | yes | no |
| `runs[].shards[].trials[].trial_digest` | `string` | yes | no |

## Lindy Schema Notes

Schemator favors small, boring, durable field names that describe stable data facts. It challenges metaphorical, vague, redundant, or temporary implementation names while preserving intentional domain and declarative configuration vocabulary.
