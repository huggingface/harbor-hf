# Schemator Simplification Patch Plan

Source: /home/user/repos/harbor-hf/schemas/campaign-plan-v1alpha1.schema.json

This is a source-editing plan, not an auto-applied patch. Apply these changes to the schema source, then rerun `schemator run`.

## CampaignPlan.runs[].estimated_wave_cost_microusd

- Decision: remove
- Final path: runs[].estimated_wave_cost_microusd
- Confidence: high
- Rationale: A per-run cost estimate is not an execution contract: the controller can enforce the campaign spend cap from immutable reservations and actual receipts. An estimate is provider-price- and timing-dependent, and no current controller decision requires preserving it in the plan.

## CampaignPlan.runs[].shards[].shard_digest

- Decision: derive
- Final path: runs[].shards[].shard_digest
- Confidence: high
- Rationale: A shard digest is a content address, not independent campaign input. Derive it deterministically from the canonical ordered shard trial contents; initial_waves can refer to that derived value without storing a redundant, mismatch-prone copy.
