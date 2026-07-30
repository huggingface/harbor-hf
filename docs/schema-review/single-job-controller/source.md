# Proposed controller field model

## Manifest execution.controller

- planning_trial_seconds: required positive integer
- headroom_factor: required decimal string at least 1.0
- wave_reserve_seconds: required positive integer
- controller_reserve_seconds: required integer at least 600
- heartbeat_seconds: required integer from 30 through 300
- stale_after_seconds: required integer at least three heartbeat periods
- max_attempts: required integer from 1 through 10

## Campaign plan

- controller_policy: required controller object for provider campaigns
- planned_campaign_duration_seconds: required positive integer for provider campaigns
- initial_waves: ordered planned wave records

Each planned wave contains wave_index, deployment_digest, shard_digests, trial_count, effective_concurrency, and planned_duration_seconds.

## Campaign lock

The campaign lock stores controller_policy, planned_campaign_duration_seconds, and ordered initial_waves. Each locked wave contains wave_index, deployment_digest, shard_ids, trial_count, effective_concurrency, and planned_duration_seconds.

## Campaign input manifest

- schema_version
- campaign_id
- plan_digest
- files: exactly campaign.lock.json and manifest.yaml, each with bytes and sha256
- input_digest: content digest over the canonical files map

The mounted folder contains exactly campaign.lock.json, input-manifest.json, and manifest.yaml.

## Controller claim

- schema_version
- campaign_id
- job_id
- plan_digest
- attempt
- acquired_at
- heartbeat_at
- expires_at

## Controller status

- schema_version
- campaign_id
- plan_digest
- job_id
- attempt
- state
- heartbeat_at
- lease_expires_at
- physical_deadline
- remaining_seconds
- projection: logical_trials, terminal_trials, active_trials, physical_executions
- current_action
- current_wave
- spend_reserved_microusd
- block_reason
- event_revision
- evidence_revision

States are starting, running, waiting-retry, finalizing, completed, paused-capacity, paused-policy, failed-infrastructure, and failed-deterministic.

## Immutable controller records

Attempt reservation: campaign_id, plan_digest, input_digest, input_uri, output_uri, worker_revision, attempt, and reserved_at.

Started receipt: campaign_id, plan_digest, input_digest, worker_revision, job_id, attempt, and started_at.

Ended receipt: campaign_id, plan_digest, job_id, attempt, state, ended_at, and optional message.

Recovery decision: campaign_id, plan_digest, prior_job_id, prior_attempt, replacement_attempt, checkpoint_revision, infrastructure category, and decided_at.
