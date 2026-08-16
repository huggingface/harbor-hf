# Schemator Simplification Patch Plan

Source: /home/user/repos/harbor-hf/schemas/campaign-plan-v1alpha1.schema.json

This is a source-editing plan, not an auto-applied patch. Apply these changes to the schema source, then rerun `schemator run`.

## CampaignPlan.controller_policy.planning_trial_seconds

- Decision: remove
- Final path: controller_policy.planning_trial_seconds
- Confidence: high
- Rationale: Initial-wave planned durations are already concrete plan outputs. A uniform per-trial planning estimate has no separate controller-time use that warrants persisting it in the immutable policy.

## CampaignPlan.initial_waves[].planned_duration_seconds

- Decision: derive
- Final path: initial_waves[].planned_duration_seconds
- Confidence: high
- Rationale: A wave’s planned duration is deterministically computable from its shard contents, run concurrency, and immutable controller timing policy. Storing it duplicates planning state and risks divergence.

## CampaignPlan.plan_digest

- Decision: derive
- Final path: plan_digest
- Confidence: high
- Rationale: A plan's content digest is its externally computed identity. Embedding it in the plan creates a self-referential hashing rule or a special exclusion convention, neither of which belongs in the durable payload schema. Derive it from canonical plan bytes and store or reference it in the controller input-package metadata or lock where needed.

## CampaignPlan.planned_campaign_duration_seconds

- Decision: derive
- Final path: planned_campaign_duration_seconds
- Confidence: medium
- Rationale: It duplicates a deterministic duration bound obtainable from the immutable controller policy and deterministic initial-wave plan. Persisting the aggregate permits internal inconsistency without adding information.

## CampaignPlan.recovery_policy.max_active_waves

- Decision: move
- Final path: controller_policy.max_active_waves
- Confidence: high
- Rationale: This is a controller scheduling limit that applies to both initial execution and recovery; it is not itself a recovery rule.
