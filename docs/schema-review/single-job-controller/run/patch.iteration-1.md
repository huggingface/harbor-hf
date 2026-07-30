# Schemator Simplification Patch Plan

Source: /home/onur/repos/harbor-hf/schemas/campaign-plan-v1alpha1.schema.json

This is a source-editing plan, not an auto-applied patch. Apply these changes to the schema source, then rerun `schemator run`.

## CampaignPlan.component_kind

- Decision: remove
- Final path: component_kind
- Confidence: high
- Rationale: CampaignPlan is already a typed, named artifact. No current use case establishes a second in-band discriminator, and the generic term "component" is not stable domain vocabulary. The package file identity and strict schema validation should identify a plan.

## CampaignPlan.controller_policy.max_attempts

- Decision: rename
- Final path: controller_policy.max_controller_attempts
- Confidence: high
- Rationale: The retry bound is a durable controller concept, but `max_attempts` is ambiguous beside trial logical attempts and per-trial physical-execution limits. Naming the controlled subject keeps the independent bounds clear.

Suggested rename:

- From: `max_attempts`
- To: `max_controller_attempts`

## CampaignPlan.evaluation_id

- Decision: defer
- Final path: evaluation_id
- Confidence: medium
- Rationale: No stated consumer distinguishes this required identifier from experiment or the immutable manifest_digest. Its purpose and source of truth are not established in the graph.

## CampaignPlan.experiment

- Decision: remove
- Final path: experiment
- Confidence: high
- Rationale: `experiment` is a vague, unscoped label with no distinct use case shown. `evaluation_id` already identifies the evaluated workload, while the campaign and plan identify the execution unit. Retaining a required generic string creates an extra identity that can drift without adding durable meaning.

## CampaignPlan.initial_waves[].deployment_digest

- Decision: derive
- Final path: initial_waves[].deployment_digest
- Confidence: high
- Rationale: A wave’s deployment is derivable from its shard_digests by resolving each shard in runs[].shards[] to its run’s deployment_digest. Keeping it duplicates immutable plan data and risks disagreement; require all shards in a wave to resolve to the same deployment digest instead.

## CampaignPlan.initial_waves[].effective_concurrency

- Decision: derive
- Final path: initial_waves[].effective_concurrency
- Confidence: high
- Rationale: “Effective” marks this as a computed result, not an independent plan fact. Keeping it alongside immutable deployment content, shard membership, and request-limit inputs creates conflicting sources of truth. Derive it when constructing the controller input from the wave’s shards and the immutable deployment/run concurrency limits.

## CampaignPlan.initial_waves[].trial_count

- Decision: derive
- Final path: initial_waves[].trial_count
- Confidence: high
- Rationale: Each wave's trial count is a summary of its referenced shards' trials. Persisting it duplicates authoritative plan data and can drift.

## CampaignPlan.initial_waves[].wave_index

- Decision: derive
- Final path: initial_waves[].wave_index
- Confidence: high
- Rationale: An immutable, ordered initial-wave plan already defines each wave's ordinal. Storing it duplicates array position and permits inconsistent plans.

## CampaignPlan.max_shards_per_wave

- Decision: remove
- Final path: max_shards_per_wave
- Confidence: high
- Rationale: Initial waves already record the authoritative shard assignments. A planning-time cap is not needed by the controller after those assignments are materialized, and the observed largest wave would not preserve the cap's distinct intended meaning.

## CampaignPlan.publication_role

- Decision: remove
- Final path: publication_role
- Confidence: high
- Rationale: The name does not identify a durable execution or planning concept, and no current consumer or closed set of values is shown. Publication is a downstream concern, not intrinsic to an immutable campaign plan.

## CampaignPlan.run_count

- Decision: derive
- Final path: run_count
- Confidence: high
- Rationale: `run_count` duplicates the cardinality of the required `runs` array. Storing both creates an avoidable consistency invariant in an otherwise strict, immutable plan.

## CampaignPlan.runs[].cell_digest

- Decision: rename
- Final path: runs[].run_digest
- Confidence: medium
- Rationale: "Cell" is unexplained matrix jargon, while the enclosing object is already the durable domain concept: a run. Keep the content identity, rename it to run_digest, and validate it as the established sha256: content-digest form.

Suggested rename:

- From: `cell_digest`
- To: `run_digest`

## CampaignPlan.runs[].estimated_wave_cost_microusd

- Decision: move
- Final path: runs[].estimated_wave_cost_microusd
- Confidence: high
- Rationale: A run can span multiple waves, so a run-level wave cost is ambiguous. Attach the non-negative integer estimate to each concrete initial wave, whose shard set, duration, and concurrency define what is being estimated.

## CampaignPlan.runs[].shards[].trials[].logical_attempt

- Decision: remove
- Final path: runs[].shards[].trials[].logical_attempt
- Confidence: medium
- Rationale: Each entry in trials already represents one planned logical trial and is identified by trial_digest. Attempt counts belong to runtime physical-execution and recovery records, where retries occur; keeping one in the immutable plan duplicates or prematurely encodes that state.

## CampaignPlan.runs[].spend_cap_microusd

- Decision: remove
- Final path: runs[].spend_cap_microusd
- Confidence: high
- Rationale: The campaign already has a single controller and a campaign-wide spend cap at recovery_policy.spend_cap_microusd. A run-level cap introduces a second, unspecified budget authority and enforcement rule without a stated use case.

## CampaignPlan.shard_count

- Decision: derive
- Final path: shard_count
- Confidence: high
- Rationale: It duplicates the total number of concrete shard entries already represented by runs[].shards and can be derived deterministically.

## CampaignPlan.trial_count

- Decision: derive
- Final path: trial_count
- Confidence: high
- Rationale: It duplicates the canonical nested trial records in runs[].shards[].trials and can drift from them. Derive the total from those records.

