# Schemator Field Review

You are reviewing exactly one data-model field. Be skeptical. Prefer the smallest Lindy schema: boring names, durable concepts, no metaphors, no generic bags, and no fields without a current use case. Aim for a data model that can remain the same for the next ten or a hundred years.

Return only valid JSON matching `schemas/field-review.schema.json`.

## Project And Task Context

# Single-job campaign controller schema context

Harbor HF uses strict Pydantic models and generated JSON Schemas. These fields replace the provider execution contract inside the existing `v1alpha1` campaign formats. Unknown fields remain errors.

The stable product concepts are:

- one logical campaign with one active physical controller Job;
- immutable provider controller policy and duration bounds;
- deterministic initial wave plans in the plan and concrete shard IDs in the campaign lock;
- a content-addressed three-file controller input package;
- exclusive renewable ownership tied to campaign, plan, physical Job, and attempt;
- immutable physical-attempt reservations and started, ended, and recovery receipts;
- mutable latest status whose repository history preserves older revisions.

Names such as campaign, run, shard, trial, execution, wave, plan digest, physical Job, heartbeat, lease, provider, and controller are existing domain vocabulary and should remain consistent. Duration fields use explicit `_seconds` suffixes. Monetary values use integer `_microusd`. Digests state their algorithm when the value is a raw hex digest and use the existing `sha256:` content-digest form elsewhere.

The model must preserve exact decimal arithmetic for `headroom_factor`, reject unsafe path identities and non-UTC times, and keep provider model revisions `not_observed` when they cannot be proven. Do not add compatibility aliases, defaults for production controller policy, target reporting dates, child wave Job identities, or a second provider execution mode.

## Field Under Review

- Model: `CampaignPlan`
- Field path: `initial_waves[].effective_concurrency`
- Field name: `effective_concurrency`
- Type: `integer`
- Required: no
- Object-like: no

## Model Fields

- `component_kind`: `unknown`
- `controller_policy`: `unknown` (optional)
- `controller_policy.controller_reserve_seconds`: `integer` (optional)
- `controller_policy.headroom_factor`: `unknown` (optional)
- `controller_policy.heartbeat_seconds`: `integer` (optional)
- `controller_policy.max_attempts`: `integer` (optional)
- `controller_policy.planning_trial_seconds`: `integer` (optional)
- `controller_policy.stale_after_seconds`: `integer` (optional)
- `controller_policy.wave_reserve_seconds`: `integer` (optional)
- `evaluation_id`: `string`
- `experiment`: `string`
- `initial_waves`: `array` (optional)
- `initial_waves[].deployment_digest`: `string` (optional)
- `initial_waves[].effective_concurrency`: `integer` (optional)
- `initial_waves[].planned_duration_seconds`: `integer` (optional)
- `initial_waves[].shard_digests`: `array` (optional)
- `initial_waves[].trial_count`: `integer` (optional)
- `initial_waves[].wave_index`: `integer` (optional)
- `manifest_digest`: `string`
- `max_shards_per_wave`: `integer`
- `plan_digest`: `string`
- `planned_campaign_duration_seconds`: `unknown` (optional)
- `publication_role`: `string`
- `recovery_policy`: `#/$defs/CampaignRecoveryPolicy`
- `recovery_policy.cancellation_grace_seconds`: `integer` (optional)
- `recovery_policy.max_active_waves`: `integer` (optional)
- `recovery_policy.max_physical_executions_per_trial`: `integer` (optional)
- `recovery_policy.retry_base_seconds`: `integer` (optional)
- `recovery_policy.retry_max_seconds`: `integer` (optional)
- `recovery_policy.spend_cap_microusd`: `unknown` (optional)
- `run_count`: `integer`
- `runs`: `array`
- `runs[].agent`: `string`
- `runs[].cell_digest`: `string`
- `runs[].deployment`: `string`
- `runs[].deployment_digest`: `string`
- `runs[].estimated_wave_cost_microusd`: `unknown` (optional)
- `runs[].max_concurrent_requests`: `unknown` (optional)
- `runs[].model`: `string`
- `runs[].provider`: `unknown` (optional)
- `runs[].shards`: `array`
- `runs[].shards[].shard_digest`: `string`
- `runs[].shards[].trials`: `array`
- `runs[].shards[].trials[].logical_attempt`: `integer`
- `runs[].shards[].trials[].task_digest`: `string`
- `runs[].shards[].trials[].task_name`: `string`
- `runs[].shards[].trials[].trial_digest`: `string`
- `runs[].spend_cap_microusd`: `unknown` (optional)
- `schema_version`: `string` (optional)
- `shard_count`: `integer`
- `trial_count`: `integer`

## Full Graph Context

- `CampaignPlan`:
  - `component_kind`: `unknown`
  - `controller_policy`: `unknown` (optional)
  - `controller_policy.controller_reserve_seconds`: `integer` (optional)
  - `controller_policy.headroom_factor`: `unknown` (optional)
  - `controller_policy.heartbeat_seconds`: `integer` (optional)
  - `controller_policy.max_attempts`: `integer` (optional)
  - `controller_policy.planning_trial_seconds`: `integer` (optional)
  - `controller_policy.stale_after_seconds`: `integer` (optional)
  - `controller_policy.wave_reserve_seconds`: `integer` (optional)
  - `evaluation_id`: `string`
  - `experiment`: `string`
  - `initial_waves`: `array` (optional)
  - `initial_waves[].deployment_digest`: `string` (optional)
  - `initial_waves[].effective_concurrency`: `integer` (optional)
  - `initial_waves[].planned_duration_seconds`: `integer` (optional)
  - `initial_waves[].shard_digests`: `array` (optional)
  - `initial_waves[].trial_count`: `integer` (optional)
  - `initial_waves[].wave_index`: `integer` (optional)
  - `manifest_digest`: `string`
  - `max_shards_per_wave`: `integer`
  - `plan_digest`: `string`
  - `planned_campaign_duration_seconds`: `unknown` (optional)
  - `publication_role`: `string`
  - `recovery_policy`: `#/$defs/CampaignRecoveryPolicy`
  - `recovery_policy.cancellation_grace_seconds`: `integer` (optional)
  - `recovery_policy.max_active_waves`: `integer` (optional)
  - `recovery_policy.max_physical_executions_per_trial`: `integer` (optional)
  - `recovery_policy.retry_base_seconds`: `integer` (optional)
  - `recovery_policy.retry_max_seconds`: `integer` (optional)
  - `recovery_policy.spend_cap_microusd`: `unknown` (optional)
  - `run_count`: `integer`
  - `runs`: `array`
  - `runs[].agent`: `string`
  - `runs[].cell_digest`: `string`
  - `runs[].deployment`: `string`
  - `runs[].deployment_digest`: `string`
  - `runs[].estimated_wave_cost_microusd`: `unknown` (optional)
  - `runs[].max_concurrent_requests`: `unknown` (optional)
  - `runs[].model`: `string`
  - `runs[].provider`: `unknown` (optional)
  - `runs[].shards`: `array`
  - `runs[].shards[].shard_digest`: `string`
  - `runs[].shards[].trials`: `array`
  - `runs[].shards[].trials[].logical_attempt`: `integer`
  - `runs[].shards[].trials[].task_digest`: `string`
  - `runs[].shards[].trials[].task_name`: `string`
  - `runs[].shards[].trials[].trial_digest`: `string`
  - `runs[].spend_cap_microusd`: `unknown` (optional)
  - `schema_version`: `string` (optional)
  - `shard_count`: `integer`
  - `trial_count`: `integer`

## Decision Rules

- Use `keep` only when the field has earned its place.
- Use `rename` when the concept is valid but the name is not durable.
- When a metaphorical or vague name clearly represents a closed selector, preset, variant, or reference, prefer a durable selector/reference name over `defer`.
- Use `remove`, `derive`, `merge`, or `defer` when that produces a smaller viable model.
- Use `opaque` only with a clear owner boundary.
- Challenge names that are metaphorical, vague, redundant, or tied to a temporary implementation detail.
- Prefer the shortest clear name. Do not rename a field to a longer or more explicit name unless the current name is genuinely ambiguous, misleading, or missing an important distinction.
- Do not add suffixes like `Id`, `Mode`, `Policy`, `Preset`, `Default`, or `Config` just to make a name more explicit. Add them only when the suffix changes the meaning or prevents a real ambiguity in the surrounding schema.
- Preserve established declarative configuration vocabulary when the project context says that vocabulary is intentional.
