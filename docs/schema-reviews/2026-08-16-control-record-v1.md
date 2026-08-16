# Control record v1 schema review

## Scope

This review covers [`control-record-v1.schema.json`](../../packages/contracts/schemas/control-record-v1.schema.json) after completion of the TypeScript control service and its historical-import and recovery paths.

## Schemator result

The bounded Schemator review covered the control schema after Job cancellation
was added and worker access to the long-lived Hub token and canonical Bucket
mount was removed. It found no consistency warnings. Its first iteration
suggested five renames and two structural changes. The review did not converge
within that bounded iteration, so no generated change was applied directly.

Later recovery and evidence work added manually reviewed fields and record kinds,
including action-dispatch fences, action-advanced markers, worker evidence
references, and a worker-receipt grace deadline. Generated TypeScript and API
types, canonical-byte tests, replay tests, and JSON Schema validation cover the
current schema. The earlier field count and convergence statement no longer
describe the current revision and are intentionally not carried forward.

## Manual decisions

The final product-semantics pass retained the following deliberate boundaries:

- Closed record and profile objects remain authoritative, as do action and attempt objects. The same applies to endpoint and publication objects, plus migration records.
- Imported deployment profiles describe historical work and cannot authorize a new launch or retry.
- Real task IDs may begin with digits, and two-character harness names such as `pi` are valid.
- Worker attempts remain bound to the exact durable action that authorized the physical work.
- `worker_receipt_deadline` records the bounded grace period after a terminal Job observation so a late immutable worker receipt is checked before a fallback attempt is selected.
- Action receipts have a separate action-advanced marker so a restart can recover a crash between the remote receipt and its deterministic domain transition.
- Job launches have a pre-create action-dispatch fence so a lost response or process exit can only trigger delayed label adoption, never a second create request for the same action.
- Evidence, actor, digest, source revision, cost, terminal selection, endpoint cleanup, and publication provenance remain explicit.
- Profiles embedded in campaign locks remain exact even if promoted aliases later change.
- `ceiling_microusd` remains the established campaign-wide hard cap; it is not a generic cost estimate.
- Deployment `route` remains the established closed selector used by both live and imported profiles.
- `watchdog_verified` continues to name the independently verified cleanup watchdog required before endpoint resume.
- `new_writes_enabled` continues to record whether writes were enabled after a historical migration cutover.
- Benchmark task IDs and digests remain parallel closed arrays because immutable profile validation enforces equal non-zero length and campaign locks bind each pair into a task object.
- Workers receive an expiring action-scoped capability. Deployment profiles and actions no longer contain fields that forward `HF_TOKEN` or mount the canonical Bucket.

The only schema reduction in this pass removed those two unsafe worker-access
fields. The other proposals would rename established public concepts or cause a
large contract rewrite without reducing ambiguity.
