# Schemator Simplification Patch Plan

Source: /home/onur/repos/harbor-hf/schemas/campaign-plan-v1alpha1.schema.json

This is a source-editing plan, not an auto-applied patch. Apply these changes to the schema source, then rerun `schemator run`.

## CampaignPlan.recovery_policy.max_active_waves

- Decision: move
- Final path: recovery_policy.max_active_waves
- Confidence: high
- Rationale: This is a controller-wide concurrency bound, not recovery behavior. It governs normal scheduling as well as retries, so controller_policy is its durable owner.

## CampaignPlan.recovery_policy.spend_cap_microusd

- Decision: move
- Final path: recovery_policy.spend_cap_microusd
- Confidence: high
- Rationale: A campaign-wide spend cap is a durable safety bound for all physical executions, not a recovery-specific retry setting. Keeping it at the plan root makes its scope explicit while retaining the established monetary name and integer micro-USD representation.

## CampaignPlan.runs[].deployment

- Decision: rename
- Final path: runs[].deployment_path
- Confidence: medium
- Rationale: This string is the deployment file identity; `deployment` alone is ambiguous between a provider resource, its configuration, and its path. The paired digest authenticates content, while `deployment_path` makes the separately validated relative-path role clear.

Suggested rename:

- From: `deployment`
- To: `deployment_path`

## CampaignPlan.runs[].provider

- Decision: derive
- Final path: runs[].provider
- Confidence: medium
- Rationale: A single Harbor HF controller has no independent per-run provider choice. The deployment reference and its digest should resolve the provider through the Harbor adapter; storing it again risks contradictory execution identity.

## CampaignPlan.runs[].run_digest

- Decision: derive
- Final path: runs[].run_digest
- Confidence: high
- Rationale: A run's immutable semantics are already present in its agent, deployment identity, provider/model settings, concurrency, and shard contents. Store those inputs and deterministically derive the canonical content digest; a stored digest duplicates them and can drift.

## CampaignPlan.schema_version

- Decision: remove
- Final path: schema_version
- Confidence: high
- Rationale: CampaignPlan is validated as part of the existing v1alpha1 campaign format, so an optional free-form per-plan version is redundant and cannot safely select a contract. Keeping it creates a second, potentially conflicting version authority without a current use case.
