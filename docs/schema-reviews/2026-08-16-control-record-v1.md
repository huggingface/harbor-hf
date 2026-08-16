# Control record v1 schema review

## Scope

This review covers [`control-record-v1.schema.json`](../../packages/contracts/schemas/control-record-v1.schema.json) after completion of the TypeScript control service and its historical-import and recovery paths.

## Schemator result

A fresh bounded Schemator review covered all 122 fields after adding Job
cancellation and removing worker access to the long-lived Hub token and
canonical Bucket mount. It found no consistency warnings. Its first iteration
suggested five renames and two structural changes. The review did not converge
within that bounded iteration, so no generated change was applied directly.
The final extraction contains 124 fields after the later addition of the two
explicit action-dispatch fence fields.

## Manual decisions

The final product-semantics pass retained the following deliberate boundaries:

- Closed record and profile objects remain authoritative, as do action and attempt objects. The same applies to endpoint and publication objects, plus migration records.
- Imported deployment profiles describe historical work and cannot authorize a new launch or retry.
- Real task IDs may begin with digits, and two-character harness names such as `pi` are valid.
- Worker attempts remain bound to the exact durable action that authorized the physical work.
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
